// Bridge mints the API finishes for a holder: one renewed when the pool has moved past its burn root, and one the holder built at burn time
// ("armed") that is completed and queued once its burn is recorded, with the holder's page closed.
//
// A mint op is the holder's half (commitments, range proof, kernel; the openings are needed to make it) and a public half (the burn set's
// path under the burn root, the note tree's path), which anyone can read off the reflected state (dapp/confidential-bridge-mint.js). The
// destination is pinned by the burn itself, so a mint can only ever pay the holder's note, and the half the API holds carries no opening: a
// range proof, a kernel signature, two commitments and the sealed memo. What arming adds is a wait for the burn to be recorded.
//
// The collaborators are injected so the logic is checked without the whole API:
//   kv                  { get, put, delete }
//   lock(key, fn)       runs fn exclusively for that key
//   bm                  makeConfidentialBridgeMint({ pool, ct }) (verification needs ct)
//   reflection()        → { prepared, burnRoot, height } for the reflected state the pool's root was read from, or null
//   chainBurnRoot(fresh) → the burn root the pool holds, or null when it cannot be read
//   isMinted(burnId)    → true / false / null (unread)
//   submit({ op, memos, key }) → { status, body }  the API's own submit door, as an ordinary mint
const lc = (x) => String(x == null ? '' : x).toLowerCase();
const HEX32 = /^0x[0-9a-f]{64}$/;
const POINT = /^0x0[23][0-9a-f]{64}$/;
const KEY = (dest) => `cps:armed:${dest}`;
const INDEX = 'cps:armed:index';
export const ARMED_TTL_S = 14 * 86400;
export const MAX_ARMED = 512;
const MAX_MEMOS = 4, MAX_MEMO_HEX = 4096, MAX_PROOF_HEX = 8192, MAX_TRIES = 6;
// A refusal from the door that is only "not now": the mint stays armed and is offered again on the next sweep.
const TRANSIENT = new Set(['free_budget', 'relay_held', 'relay_paused', 'prove_reserved', 'prove_budget', 'stale_root']);

// The fields of a mint op the holder makes, copied out (nothing else is kept) after checking each one's shape. → { op } | { error }.
export function readArmedOp(raw) {
  const o = raw && typeof raw === 'object' ? raw : null;
  if (!o) return { error: 'a mint op is required' };
  const pick = (v, re, what) => (typeof v === 'string' && re.test(lc(v)) ? lc(v) : null);
  const op = {
    chainBinding: pick(o.chainBinding, HEX32), asset: pick(o.asset, HEX32), spentTxid: pick(o.spentTxid, HEX32),
    spentVout: Number(o.spentVout), sourceClass: Number(o.sourceClass),
    input: o.input && { cx: pick(o.input.cx, HEX32), cy: pick(o.input.cy, HEX32), owner: pick(o.input.owner, HEX32) },
    output: o.output && { cx: pick(o.output.cx, HEX32), cy: pick(o.output.cy, HEX32), owner: pick(o.output.owner, HEX32) },
    rangeProof: typeof o.rangeProof === 'string' && /^0x(?:[0-9a-f]{2}){8,}$/i.test(o.rangeProof) && o.rangeProof.length <= MAX_PROOF_HEX ? lc(o.rangeProof) : null,
    fee: typeof o.fee === 'string' || typeof o.fee === 'number' ? String(o.fee) : null,
    kernel: o.kernel && { R: pick(o.kernel.R, POINT), z: pick(o.kernel.z, HEX32) },
  };
  const bad = [];
  for (const k of ['chainBinding', 'asset', 'spentTxid', 'rangeProof', 'fee']) if (op[k] == null) bad.push(k);
  for (const [k, sub] of [['input', ['cx', 'cy', 'owner']], ['output', ['cx', 'cy', 'owner']], ['kernel', ['R', 'z']]]) {
    if (!op[k]) bad.push(k); else for (const f of sub) if (op[k][f] == null) bad.push(`${k}.${f}`);
  }
  if (![0, 1, 2].includes(op.sourceClass)) bad.push('sourceClass');
  if (!Number.isInteger(op.spentVout) || op.spentVout < 0 || op.spentVout > 0xffffffff) bad.push('spentVout');
  if (op.fee != null && !/^\d{1,20}$/.test(op.fee)) bad.push('fee');
  return bad.length ? { error: `not a mint op: ${bad.join(', ')}` } : { op };
}

export function readArmedMemos(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_MEMOS) return { error: `memos: one to ${MAX_MEMOS} sealed memos are required` };
  if (!raw.every((m) => typeof m === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(m) && m.length <= MAX_MEMO_HEX)) return { error: 'memos must be hex strings' };
  return { memos: raw.map(lc) };
}

export function makeArmedMints({ kv, lock, bm, reflection, chainBurnRoot, isMinted, submit, now = () => Date.now(), log = () => {} }) {
  const read = async (dest) => { const s = await kv.get(KEY(dest)); if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
  const write = (rec) => kv.put(KEY(rec.dest), JSON.stringify(rec), { expirationTtl: ARMED_TTL_S });
  const indexOf = async () => { const s = await kv.get(INDEX); try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const view = (rec) => ({ status: rec.state, dest: rec.dest, ...(rec.jobId ? { jobId: rec.jobId } : {}), at: rec.at, ...(rec.note ? { note: rec.note } : {}) });

  // The reflected state, only when it is the state the pool's burn root was taken from: a mint completed against a state that is ahead of the
  // chain (a proof saved but not yet landed) would carry a root the pool does not hold yet.
  async function currentReflection() {
    const [ref, chain] = await Promise.all([reflection(), chainBurnRoot(true)]);
    if (!ref) return { code: 'reflection_unavailable' };
    if (!chain) return { code: 'chain_unreadable' };
    if (lc(ref.burnRoot) !== lc(chain)) return { code: 'reflection_not_current' };
    return { ref };
  }

  // A mint on a root the pool has moved past, made current: the holder's half kept, the public half read again.
  async function renew(op) {
    const cur = await currentReflection();
    if (!cur.ref) return { ok: false, code: cur.code };
    try { const done = bm.completeBridgeMintOp(op, cur.ref.prepared); return { ok: true, op: done.op, burnId: done.burnId }; }
    catch (e) { return { ok: false, code: (e && e.code) || 'bad_op', error: e && e.message }; }
  }

  // Take the mint up to the door as an ordinary job. → the record, changed.
  async function advance(rec, ref) {
    let done;
    try { done = bm.completeBridgeMintOp(rec.op, ref.prepared); }
    catch (e) {
      if (e && (e.code === 'note_not_in_tree' || e.code === 'burn_not_recorded')) return rec;      // not yet: the reflection has not recorded it
      return { ...rec, state: 'failed', note: (e && e.message) || 'could not be completed', at: now() };
    }
    const minted = await isMinted(done.burnId).catch(() => null);
    if (minted === true) return { ...rec, state: 'minted', at: now() };
    if (minted === null) return rec;                                                                  // the chain could not be read: look again
    const r = await submit({ op: done.op, memos: rec.memos, key: rec.dest });
    const code = r && r.body && r.body.code;
    if (r && r.status === 200 && r.body && r.body.ok && r.body.jobId) return { ...rec, state: 'queued', jobId: r.body.jobId, note: null, at: now() };
    if (TRANSIENT.has(code)) return { ...rec, note: code, at: rec.at };
    const tries = (rec.tries || 0) + 1;
    return tries >= MAX_TRIES ? { ...rec, tries, state: 'failed', note: (r && r.body && r.body.error) || code || 'refused', at: now() } : { ...rec, tries, note: code || null };
  }

  // A holder arms a mint they built at burn time: { op (the holder's half), memos }. → { ok, status, ... } | { ok: false, code, error }
  async function arm({ op: rawOp, memos: rawMemos }) {
    const o = readArmedOp(rawOp); if (o.error) return { ok: false, code: 'bad_op', error: o.error };
    const m = readArmedMemos(rawMemos); if (m.error) return { ok: false, code: 'bad_memos', error: m.error };
    const proofs = bm.verifyBridgeMintParts(o.op);
    if (!proofs.ok) return { ok: false, code: 'bad_proof', error: proofs.reason };
    let id;
    try { id = bm.bridgeMintIdentity(o.op); } catch (e) { return { ok: false, code: 'bad_op', error: (e && e.message) || 'not a mint op' }; }
    const dest = id.destLeaf;
    if ((await isMinted(id.burnId).catch(() => null)) === true) return { ok: true, status: 'minted', dest };
    const made = await lock(INDEX, async () => {
      const have = await read(dest);
      if (have && have.state !== 'failed') return { rec: have, fresh: false };
      const idx = await indexOf();
      if (!idx.includes(dest) && idx.length >= MAX_ARMED) return { full: true };
      const rec = { v: 1, dest, burnId: id.burnId, op: o.op, memos: m.memos, state: 'armed', tries: 0, at: now(), jobId: null, note: null };
      await write(rec);
      if (!idx.includes(dest)) await kv.put(INDEX, JSON.stringify([...idx, dest]), { expirationTtl: ARMED_TTL_S });
      return { rec, fresh: true };
    });
    if (made.full) return { ok: false, code: 'armed_full', error: 'too many mints are waiting; try again later' };
    // A burn already recorded needs no wait.
    if (made.fresh) {
      const cur = await currentReflection().catch(() => ({}));
      if (cur.ref) {
        const next = await lock(KEY(dest), async () => { const r = await read(dest); if (!r || r.state !== 'armed') return r; const n = await advance(r, cur.ref); if (n !== r) await write(n); return n; });
        if (next) return { ok: true, ...view(next) };
      }
    }
    return { ok: true, ...view(made.rec) };
  }

  async function status(dest) {
    const d = lc(dest);
    if (!HEX32.test(d)) return null;
    const rec = await read(d);
    return rec ? view(rec) : null;
  }

  // One pass over the armed mints. Cheap when nothing is armed. → counts, for the log.
  let sweeping = false;
  async function sweep() {
    if (sweeping) return { skipped: true };
    sweeping = true;
    const out = { armed: 0, queued: 0, minted: 0, failed: 0, dropped: 0 };
    try {
      const idx = await indexOf();
      if (!idx.length) return out;
      let cur = null;
      const keep = [];
      for (const dest of idx) {
        const rec = await read(dest);
        if (!rec) { out.dropped++; continue; }
        keep.push(dest);
        if (rec.state === 'minted' || rec.state === 'failed') { if (now() - rec.at > 3 * 86400e3) { keep.pop(); await kv.delete(KEY(dest)); out.dropped++; } continue; }
        if (rec.state === 'queued') {
          if ((await isMinted(rec.burnId).catch(() => null)) === true) { await lock(KEY(dest), async () => write({ ...rec, state: 'minted', at: now() })); out.minted++; }
          else out.queued++;
          continue;
        }
        cur = cur || (await currentReflection());
        if (!cur.ref) { out.armed++; continue; }
        const next = await lock(KEY(dest), async () => { const r = await read(dest); if (!r || r.state !== 'armed') return r; const n = await advance(r, cur.ref); if (n !== r) await write(n); return n; });
        if (!next) continue;
        out[next.state === 'armed' ? 'armed' : next.state === 'queued' ? 'queued' : next.state === 'minted' ? 'minted' : 'failed']++;
      }
      if (keep.length !== idx.length) await lock(INDEX, async () => kv.put(INDEX, JSON.stringify(keep), { expirationTtl: ARMED_TTL_S }));
      return out;
    } catch (e) { log(`armed sweep: ${(e && e.message) || e}`); return out; } finally { sweeping = false; }
  }

  return { arm, status, sweep, renew, currentReflection };
}
