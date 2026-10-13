// The holding reward's daily round for one key (see holding-claim.js): ask the points service which days are open, and for
// each open day and chain where this key's pool wallet held a note at the snapshot, prove it and send the claim. A claim is
// done once the service has answered it, and is not proven again; a day and chain is done once every claim it owed was.
//
// What it reads from the service is public and the same for every caller; what it sends is a proof that names only the
// payout address. The service is not trusted for anything the chain can say: the snapshot's note-tree root must be one the
// pool had, with the leaf count stated, before any of its leaves is used (a service that served a different tree to different
// callers could learn which leaf is whose from which of them the wallet answers). Does nothing while the service has the
// reward off.
//
//   api: the points service's base URL. wallets: { [chainId]: pool wallet (evm-pool-wallet.js) }. claimAddress: where the
//   points go, an address that can send its own transactions (the distributor pays only the account that claims); keys, when
//   no address is given, name a key-derived one instead.
//   build(args) → claims (default: holdingClaims here; the page runs it in a worker, since it hashes every leaf of a pool).
//   prove(input) → { proof, publicSignals }. checkRoot({ chainId, root, size }) → boolean, from the chain.
//   kv: { get, set } (localStorage-like), for what is done and a short log of what was sent, which holdingLog reads back.

import { holdingClaims, holdingClaimKey } from './holding-claim.js';

const plain = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const doneKey = (address, chainId, epoch) => `tacit-holding-done:${String(address).toLowerCase()}:${chainId}:${epoch}`;
const tagKey = (address, chainId, epoch, tag) => `tacit-holding-tag:${String(address).toLowerCase()}:${chainId}:${epoch}:${tag}`;
const logKey = (address) => `tacit-holding-log:${String(address).toLowerCase()}`;
const LOG_KEEP = 60, MAX_BODY = 64 * 1024 * 1024, MAX_EPOCHS = 6, MAX_CHAINS = 8, MAX_BUCKETS = 16, MAX_ERROR = 120;

const int = (x, lo, hi) => { const n = typeof x === 'number' ? x : typeof x === 'string' && /^\d{1,16}$/.test(x) ? Number(x) : NaN; return Number.isSafeInteger(n) && n >= lo && n <= hi ? n : null; };
const dec = (x) => (typeof x === 'string' && /^\d{1,80}$/.test(x) ? x : null);

// The service's /holding body, kept only where it is well-formed and small: at most a few days and chains, whole numbers
// for what is a number, decimal strings for what is a field element or an amount, sizes in ascending order. null when the
// reward is off or the body is not one.
export function cleanStatus(st) {
  if (!st || typeof st !== 'object' || st.enabled !== true) return null;
  const buckets = (Array.isArray(st.buckets) ? st.buckets : []).map(dec).filter(Boolean).map(BigInt).filter((b) => b > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_BUCKETS);
  const assets = {};
  for (const [k, v] of Object.entries(st.assets && typeof st.assets === 'object' ? st.assets : {}).slice(0, MAX_CHAINS)) { const id = int(k, 1, 1e9), a = dec(v); if (id != null && a) assets[id] = a; }
  const epochs = (Array.isArray(st.epochs) ? st.epochs : []).slice(0, MAX_EPOCHS).map((e) => {
    const epoch = int(e?.epoch, 1, 1e7);
    if (epoch == null) return null;
    const chains = (Array.isArray(e.chains) ? e.chains : []).slice(0, MAX_CHAINS).map((c) => {
      const chainId = int(c?.chainId, 1, 1e9), leaves = int(c?.leaves, 0, 2 ** 32), root = dec(c?.root), nfRoot = dec(c?.nfRoot);
      return chainId != null && leaves != null && root && nfRoot ? { chainId, leaves, root, nfRoot } : null;
    }).filter(Boolean);
    return { epoch, chains };
  }).filter(Boolean);
  const rate = typeof st.rate === 'number' && Number.isFinite(st.rate) && st.rate >= 0 && st.rate < 1e12 ? st.rate : 0;
  const vkSha256 = typeof st.vkSha256 === 'string' && /^[0-9a-f]{64}$/i.test(st.vkSha256) ? st.vkSha256.toLowerCase() : null;
  return { enabled: true, rate, buckets, assets, epochs, vkSha256 };
}

// What was sent for an address, newest first: [{ epoch, chainId, tag, bucketWei, points, credited, status, error, at }].
export function holdingLog(kv, address) {
  try { const l = JSON.parse(kv.get(logKey(address)) || '[]'); return Array.isArray(l) ? l.filter((x) => x && typeof x === 'object' && dec(String(x.bucketWei))) : []; } catch { return []; }
}
function remember(kv, address, row) {
  const l = holdingLog(kv, address).filter((x) => !(x.epoch === row.epoch && x.chainId === row.chainId && x.tag === row.tag));
  try { kv.set(logKey(address), JSON.stringify([row, ...l].slice(0, LOG_KEEP))); } catch { /* storage full or blocked: the round still ran */ }
}

export async function runHolding({ api, wallets, keys, claimAddress: to = null, zk, build = null, prove, checkRoot = null, kv, fetchImpl = globalThis.fetch?.bind(globalThis), log = () => {}, onStep = () => {}, now = () => Date.now() }) {
  const get = async (path) => {
    const r = await fetchImpl(`${api}${path}`);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > MAX_BODY) throw new Error(`${path}: too large`);
    return JSON.parse(text);
  };
  const status = cleanStatus(await get('/holding'));
  if (!status) return { enabled: false, sent: [] };
  const smallest = status.buckets[0];
  const claimAddress = to || holdingClaimKey(keys).address;
  const make = build || (async (args) => holdingClaims({ zk, ...args }));
  const sent = [], errors = [];
  for (const { epoch, chains } of status.epochs) {
    for (const snap of chains) {
      const asset = status.assets[snap.chainId];
      const W = Object.hasOwn(wallets, snap.chainId) ? wallets[snap.chainId] : null;
      if (!W || asset === undefined || kv.get(doneKey(claimAddress, snap.chainId, epoch))) continue;
      try {
        // Only fetch the snapshot when one of this wallet's notes could be in it: those it holds, and those it spent in the
        // last days (a note spent after the snapshot was still held at it).
        const notes = typeof W.holdingNotes === 'function' ? W.holdingNotes() : W.notes();
        if (smallest === undefined || !notes.some((n) => Number(n.index) < snap.leaves && BigInt(n.v) >= smallest)) { kv.set(doneKey(claimAddress, snap.chainId, epoch), '1'); continue; }
        const body = await get(`/holding/nullifiers/${snap.chainId}/${epoch}`);
        if (String(body.root) !== snap.root || String(body.nfRoot) !== snap.nfRoot || Number(body.size) !== snap.leaves) throw new Error('the snapshot served is not the one announced');
        if (!Array.isArray(body.leaves) || !Array.isArray(body.nullifiers) || body.leaves.length !== snap.leaves) throw new Error('the snapshot served is incomplete');
        if (checkRoot && !(await checkRoot({ chainId: snap.chainId, root: snap.root, size: snap.leaves }))) throw new Error('that tree was never this pool\'s');
        const claims = await make({ asset: BigInt(asset), chainId: snap.chainId, epoch, snapshot: { root: snap.root, nfRoot: snap.nfRoot, size: snap.leaves }, leaves: body.leaves, nullifiers: body.nullifiers, notes, buckets: status.buckets, claimAddress });
        let answered = 0, pause = false;
        for (const c of claims) {
          const tag = String(c.retNf), bucketWei = String(c.bucketWei);
          if (kv.get(tagKey(claimAddress, snap.chainId, epoch, tag))) { answered += 1; continue; }
          if (pause) break;
          onStep({ epoch, chainId: snap.chainId, bucketWei, step: 'proving' });
          const { proof, publicSignals } = await prove(plain(c.input));
          const r = await fetchImpl(`${api}/holding/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: snap.chainId, epoch, claimAddress, proof, publicSignals }) });
          const out = await r.json().catch(() => ({}));
          sent.push({ chainId: snap.chainId, epoch, bucketWei, status: r.status, ...out });
          if (r.ok || r.status === 422) {                                      // credited, already credited, or refused for good
            answered += 1;
            kv.set(tagKey(claimAddress, snap.chainId, epoch, tag), '1');
            remember(kv, claimAddress, { epoch, chainId: snap.chainId, tag, bucketWei, points: Number(out.points) || 0, credited: !!out.credited, status: r.status, error: r.ok ? null : String(out.error || '').slice(0, MAX_ERROR) || null, at: now() });
          } else { log(`holding claim for day ${epoch} on chain ${snap.chainId}: ${r.status}`); pause = true; }   // busy or down: leave the rest for the next round
        }
        if (answered === claims.length) kv.set(doneKey(claimAddress, snap.chainId, epoch), '1');
      } catch (e) { errors.push({ chainId: snap.chainId, epoch, error: String(e?.message || e).slice(0, MAX_ERROR) }); log(`holding day ${epoch} chain ${snap.chainId}: ${e?.message || e}`); }
    }
  }
  return { enabled: true, claimAddress, sent, errors };
}
