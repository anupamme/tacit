// Making ETH private from the tETH page, as the front page's Private sheet does it: one wallet transaction pays the deposit and the relay's tip
// together, then the relay proves the note and settles it. The note is built from the Tacit key at the next unused index, so the deposit is
// recoverable from the key and the chain alone: a deposit whose settle did not finish is found again (`pendingOf`) and finished (`finish`).
//
// What the relay can do now is read first (relayState), and watched while it is waited on: a relay that is not proving, or proves but is not
// sending, is said at once, with the way that works, rather than after a wait that runs out.
//
// The pool module (confidential-pool-ux.js) is loaded the first time it is needed. Nothing here holds a key: each step is handed `priv()`.
import { getUx, forgetUx } from '/trade/poolux.js?cb=f6352066';
import { WRAP_TIP, WRAP_WITH_TIP, CETH_ID, POOL } from '/trade/teth/read.js?cb=b443f514';
import { strip, word, rpc, ethCall, api, E10 } from '/trade/util.js?cb=782a003c';

export { getUx, forgetUx };

// The calldata of wrapWithTip(commit, amount, tipTo).
export const wrapCalldata = ({ commit, wei, to }) => WRAP_WITH_TIP + strip(commit).padStart(64, '0') + word(wei) + strip(to).toLowerCase().padStart(64, '0');

// What a wrap may be, from the pool's own rule: whole units of 1e-8 ETH (its notes carry 8 decimals).
export const wrapIssue = (wei) => (wei <= 0n ? 'Enter an amount.' : wei % E10 !== 0n ? 'Up to 8 decimals.' : null);

// ── what the relay can do now ──
// The relay says what it is doing (GET /confidential/relay): 'ok' and 'busy' prove and send, 'held' proves but leaves the settle to a wallet,
// 'paused' is not proving, and 'down' has not been heard from in ten minutes. → { state, proving, settling, board }, read at most every 15 seconds and
// waited on for at most 5, or null when it could not be read: the page then goes on as it always has.
const STATES = ['ok', 'busy', 'held', 'paused', 'down'];
let stateRead = null;
export function relayState() {
  if (stateRead && Date.now() - stateRead.at < 15e3) return stateRead.p;
  const p = Promise.race([api('/confidential/relay'), new Promise((r) => setTimeout(r, 5e3, null))]).then((b) => (b && STATES.includes(b.state)
    ? { state: b.state, proving: typeof b.proving === 'boolean' ? b.proving : !['paused', 'down'].includes(b.state), settling: typeof b.settling === 'boolean' ? b.settling : ['ok', 'busy'].includes(b.state), board: b.board === true }
    : null));
  stateRead = { at: Date.now(), p };
  return p;
}
// A relay that is not proving now, or not heard from.
export const relayStopped = (rs) => rs?.state === 'paused' || rs?.state === 'down';

// Why a wait on the relay ended early: 'relay_held' when it proves but is not sending settles, 'relay_paused' when it is not proving (`proving` is what
// it says, for one that has stopped sending and still proves). `queued`: the relay's job keeps its place in line.
function halted(rs, queued) {
  const held = rs.state === 'held';
  return Object.assign(new Error(held ? 'The relay can’t send this one right now.' : 'The relay isn’t proving right now.'), { code: held ? 'relay_held' : 'relay_paused', queued, proving: rs.proving, relay: rs });
}
// While the relay is waited on, its state is read every 15 seconds, and once `stops(state)` the wait (`race`) ends early with `halted`. The relay
// client's own wait, handed `sleep`, ends at its next poll; a settle that lands later finds the deposit consumed. `quiet()` stops the reading, as a
// proof in hand is sent. An unreadable state ends nothing.
function watchRelay(stops, queued) {
  let timer = 0, started = false, over = false, why = null, end;
  const ended = new Promise((_, no) => { end = no; });
  ended.catch(() => {});
  const tick = async () => {
    const rs = await relayState();
    if (over) return;
    if (rs && stops(rs)) { why = halted(rs, queued); over = true; end(why); return; }
    timer = setTimeout(tick, 15e3);
  };
  return {
    start() { if (!started) { started = true; tick(); } },
    sleep: (ms) => (why ? Promise.reject(why) : new Promise((r) => setTimeout(r, ms))),
    race: (p) => Promise.race([p, ended]),
    quiet() { over = true; clearTimeout(timer); },
    get why() { return why; },
  };
}

// Everything from the press to a settled note. `say(step, detail)` reports where it is: 'prepare', 'confirm', 'sent' (hash), 'proving'.
// A deposit that landed and then could not be settled throws an error carrying `deposit: { hash, built }` so the caller can try the settle again
// (`settle`) or leave it to Finish. A deposit that never went out throws a plain error, and nothing is owed.
// With `own` (a prover from prover.js), the note is proved on the holder's own credit and the wallet sends its settle (`proveOwn`): the deposit
// then carries no tip (`tip` 0). With `self`, for a relay that proves but is not sending, the relay proves it and the wallet sends its settle
// (`proveRelay`).
export async function wrapEth({ priv, wei, tip, to, from, wallet, say = () => {}, ux = null, own = null, self = false }) {
  const t = ux || await getUx();
  say('prepare');
  const index = await t.nextWrapIndex({ walletPriv: priv(), ticker: 'cETH' });
  const built = t.buildWrap({ walletPriv: priv(), amountWei: wei, ticker: 'cETH', index });
  say('confirm');
  const hash = await wallet.sendTx({ to: WRAP_TIP, data: wrapCalldata({ commit: built.commit, wei, to }), value: wei + tip, from });
  say('sent', hash);
  let rc;
  try { rc = await wallet.receipt(hash); } catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: false } }); }
  if (rc.status !== '0x1') throw Object.assign(new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`), { reverted: true });
  return own ? proveOwn({ t, built, hash, wallet, from, prover: own, say }) : self ? proveRelay({ t, built, hash, wallet, from, say }) : settle({ t, built, hash, say });
}
// The relay proves the note and the wallet sends its settle (selfFinish), for a relay that proves but is not sending settles now. The steps reach
// `say` as 'proving' (the deposit's hash), then 'settle-check', 'settle-confirm', 'settle-sent' (hash). A failure carries `deposit` as settle()'s does.
export async function proveRelay({ t = null, built, hash = null, wallet, from, say = () => {} }) {
  const ux = t || await getUx();
  say('proving', hash);
  try { return await selfFinish({ t: ux, built, hash, wallet, from, say: (k, d) => { if (k !== 'proving' && k !== 'stage') say(`settle-${k}`, d); } }); }
  catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: true, jobId: e.open?.jobId || null } }); }
}
// The deposit's note proved on the holder's own prover credit (relay.useProver, for this one proof) and its settle sent from the wallet: the relay
// neither proves nor sends it (its private input passes through Tacit's API to Succinct's prover, unkept). The steps reach `say` as 'input' (the
// private input is being made and sent), 'stage' (the network's: 'requested', 'assigned', 'proved'), then 'settle-check', 'settle-confirm',
// 'settle-sent' (hash). A failure carries `deposit` with `own: true`.
export async function proveOwn({ t = null, built, hash = null, wallet, from, prover, say = () => {} }) {
  const ux = t || await getUx();
  const step = (k, d) => say(k === 'proving' ? 'input' : k === 'stage' ? 'stage' : `settle-${k}`, d);
  ux.relay.useProver(prover.prove);
  try { return await selfFinish({ t: ux, built, hash, wallet, from, say: step }); }
  catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: true, own: true } }); }
  finally { ux.relay.useProver(null); }
}
// The relay's half: prove the note and settle it. Safe to run again for the same `built`: the deposit's id is the note it becomes.
// A failure carries the relay's job (`deposit.jobId`), so finishing it from the wallet picks up the same proof rather than asking for another.
// Once the relay has the job its state is watched: one that stops sending or proving ends the wait early, and the job keeps its place in line.
export async function settle({ t = null, built, hash = null, say = () => {} }) {
  const ux = t || await getUx();
  say('proving', hash);
  let jobId = null;
  const w = watchRelay((rs) => rs.state === 'held' || relayStopped(rs), true);
  try { await w.race(ux.submitWrapSettle({ built, waitOpts: { timeoutMs: 15 * 60e3, intervalMs: 4000, viaRelay: true, sleep: w.sleep, onJob: (id) => { jobId = id; w.start(); } }, depositTx: hash })); }
  catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: true, jobId: jobId || e.open?.jobId || null } }); }
  finally { w.quiet(); }
  return { hash, built };
}

// A failure of the relay's half, in the front page's words: a wait that ran out is not a job that failed, and the deposit is never asked for again.
// The relay's own code comes first (confidential-relay.js keeps it on the error), then its words, for a relay that answers without one.
export function relayWords(e) {
  const m = String(e?.message || e || ''), code = e?.code;
  if (code === 'open' || e?.open || /settle held|waiting for a sender/i.test(m)) return 'Your note is proved and waiting to be sent. Anyone can send it, and it goes through on its own once a relay does.';
  if (code === 'prove_budget') return 'The relay has made as many proofs as it can for today. Try again after midnight UTC. Your deposit is safe and waits to be finished.';
  if (code === 'relay_paused') return `${e.proving ? 'The relay can’t send this one right now.' : 'The relay isn’t proving right now.'} ${e.queued ? 'Your deposit is safe and keeps its place in line: it goes through once the relay is back.' : 'Your deposit is safe and waits to be finished.'}`;
  if (code === 'relay_held' && e.queued) return 'The relay can’t send this one right now. It still proves it, so your wallet can send the settle.';
  if (code === 'relay_held' || /can.t take this one/i.test(m)) return 'The relay can’t take this one right now. Your deposit is safe and waits to be finished.';
  if (code === 'free_budget' || /free relayed settles for today are used up/i.test(m)) return 'The relay’s free settles for today are used up. They open again at midnight UTC.';
  if (/settle timed out|status polling for job/i.test(m)) return 'The relay is still working on it. It goes through on its own, so there is no need to send the deposit again.';
  if (/prove timed out/i.test(m)) return 'The relay is taking longer than usual to prove it, and this page stopped waiting.';
  if (/relay lost the job/i.test(m)) return 'The relay lost track of this request.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Could not reach the relay.';
  return m.replace(/^Error:\s*/, '').replace(/\brelayer/gi, 'relay').slice(0, 220);
}

// A failure of the holder's own proof, in plain words. `prover_credit` and `not_proved` are self-prover.js's codes.
const proveAmt = (wei) => (Number(wei) / 1e18).toFixed(2);
export function ownWords(e) {
  if (e?.code === 'prover_credit') return `Your prover credit is ${proveAmt(e.have ?? 0n)} PROVE, and a proof needs about ${proveAmt(e.need ?? 0n)} PROVE on hand.`;
  if (e?.code === 'not_proved') return 'Succinct’s prover did not take it in time. Nothing was sent. The network kept its base fee (about 0.39 PROVE). Try again, or let the relay prove this one.';
  return relayWords(e);
}
// Where the relay could not prove (no proofs left today, it is not proving now, or its proof failed or ran out of time, a relayed job's too: "settle
// failed: prove failed: …"), proving with the holder's own credit is offered.
export const ownable = (e) => e?.code === 'prove_budget' || e?.code === 'relay_paused' || /prove (failed|timed out)|prove capacity/i.test(String(e?.message || ''));

// ── finishing from the wallet ──
// settle() on the pool is open to any account, so a deposit the relay has not settled can be settled from the connected wallet, which pays the
// network fee: the relay still proves the note (or has proved it already), and the wallet sends the proof. What the relay was tipped for the
// wrap is not handed back.
const WRAP_SETTLE_GAS = 593_000n;                                                   // a wrap's settle, as the relay counts it (worker-relay OP_GAS.wrap)
const DEPOSIT_STATUS = '0x7da9874f';                                                // depositStatus(bytes32): 0 none, 1 waiting, 2 consumed

// A refusal or a wait the wallet can end: the relay held the job or its free settles are used up, it answered 429 or 5xx, the wait ran out, or the
// job is proved and waiting for a sender (with its proof attached, or without when the relay's memos were not this call's own: a note rebuilt by
// Finish has fresh memos, and the wallet then fetches the job and checks the relay's against the key). Not a relay that has no proofs left today
// (prove_budget) or is not proving (relay_paused): the wallet needs its proof as much as it does.
export function selfable(e) {
  if (!e) return false;
  if (e.open) return true;
  if (e.code === 'prove_budget') return false;
  if (e.code === 'relay_paused') return !!e.proving;
  if (['relay_held', 'free_budget', 'open'].includes(e.code) || e.httpStatus === 429 || e.httpStatus >= 500) return true;
  return /settle held|waiting for a sender|can.t take this one|free relayed settles|settle timed out|status polling for job|relay lost the job|settle failed/i.test(String(e.message || e));
}

// What a settle from the wallet costs, about: a wrap's settle gas at the network's price now. null when the price cannot be read.
export async function settleCost() {
  try { return WRAP_SETTLE_GAS * BigInt(await rpc('eth_gasPrice', [])); } catch { return null; }
}

// True once the pool has consumed the deposit: the note is made, whoever sent it.
async function consumed(built) {
  if (!built?.depositId) return false;
  try { const r = await ethCall(POOL, DEPOSIT_STATUS + strip(built.depositId).padStart(64, '0')); return !!r && r !== '0x' && BigInt(r) === 2n; } catch { return false; }
}

// The memos a proof the relay holds may be sent with: the ones sealed here, or ones that open to this note under the key (a deposit finished
// again rebuilds its note with fresh memos, and the relay keeps the first). Null when they are missing or do not open: that proof is not sent.
function memosFor(ux, built, memos) {
  if (!Array.isArray(memos)) return null;
  try { return ux.relay.provenMemos({ memos }, { leaves: [built.leaf], outputs: built.outputs }, built.memos || []); } catch { return null; }
}

// Settles a landed deposit from the wallet. `open` is a proof the relay already holds (a job waiting for a sender); `jobId` the relay's job for it,
// waited on until it is proved; with neither, the relay is asked for a proof only. The settle is tried with eth_call first and sent only if it
// would go through; a deposit already consumed (a relay sent it meanwhile) is done, with nothing sent. `say(step, hash)`: 'proving', 'check',
// 'confirm', 'sent' (hash). → { hash, built, txHash, already }
// While the relay proves it (not the holder's own prover: proveOwn), its state is watched: one that stops proving ends the wait, and a relayed job
// a held relay does not prove (it proves them only for the open board) is not waited on; a proof is asked for at once instead.
export async function selfFinish({ t = null, built, hash = null, jobId = null, open = null, wallet, from, say = () => {} }) {
  const ux = t || await getUx();
  const w = ux.relay.ownProving?.() ? null : watchRelay((rs) => relayStopped(rs) && !rs.proving, false);
  const watched = (p) => { if (!w) return p; w.start(); return w.race(p); };
  // `viaRelay`: this call's proof is the relay's, whatever prover the relay client was given.
  const waitOpts = { timeoutMs: 15 * 60e3, intervalMs: 4000, onUpdate: (st) => { if (st?.stage) say('stage', st.inputPublic ? `${st.stage}:public` : st.stage); }, ...(w ? { sleep: w.sleep, viaRelay: true } : {}) };
  let mine = null;                                                                  // the settle this wallet sent, once it has landed
  async function send({ jobId: id, publicValues, proof, memos }) {
    if (w?.why) throw w.why;                                                        // the page has stopped waiting: the wallet is not asked
    w?.quiet();
    const data = ux.settleCalldata({ publicValues, proof, memos });
    say('check');
    try { await rpc('eth_call', [{ from, to: POOL, data }, 'latest']); }
    catch (e) {
      if (await consumed(built)) return { txHash: null, already: true };
      throw new Error(e?.revert ? 'The settle would not go through, so nothing was sent. Try again in a moment.' : 'The settle could not be checked, so nothing was sent. Try again in a moment.');
    }
    say('confirm');
    const txHash = await wallet.sendTx({ to: POOL, data, from });
    say('sent', txHash);
    const rc = await wallet.receipt(txHash);
    if (rc.status !== '0x1') {
      if (await consumed(built)) return { txHash: null, already: true };
      throw new Error('The settle failed. Nothing was lost but its network fee, and the deposit still waits to be finished.');
    }
    mine = txHash;
    if (id) await ux.relay.landed(id, txHash);
    return { txHash };
  }
  const done = (txHash = mine) => ({ hash, built, txHash, already: !mine });
  try {
    if (await consumed(built)) return done();
    let pr = open?.publicValues && open?.proof ? open : null;
    const rs = !pr && jobId && w ? await relayState() : null;
    if (!pr && jobId && !(rs?.state === 'held' && !rs.board)) {
      say('proving');
      try {
        const st = await watched(ux.relay.waitForSettle(jobId, { ...waitOpts, openGraceMs: 0 }));
        return done(st.txHash || null);                                                         // a relay sent it while this waited
      } catch (e) {
        if (e?.open) pr = e.open;
        else if (!/settle failed|relay lost the job/i.test(String(e?.message || ''))) throw e;  // a job that failed is proved again below
      }
    }
    if (pr) {
      const memos = memosFor(ux, built, pr.memos);
      if (memos) {
        const sent = await send({ ...pr, memos });
        if (sent.txHash) await ux.relay.verifyEmittedMemos({ jobId: pr.jobId, status: 'settled', txHash: sent.txHash }, [built.leaf], memos);
        return done();
      }
    }
    say('proving');
    const r = await watched(ux.submitWrapSettle({ built, waitOpts, depositTx: hash, selfSettle: send }));
    return done(mine || r?.txHash || null);
  } finally { w?.quiet(); }
}

// ── what the key holds, and what is waiting ──
// The key's private tETH (a scan of the pool's events: slow, about ten seconds), its deposits that landed but are not yet notes, and its positions
// in the private farms (read from the same scan, as the front page's Farm sheet reads them).
export async function readHeld({ priv, ux = null }) {
  const t = ux || await getUx();
  const r = await t.balance(priv(), { cbtc: false, bridge: false, positions: true });
  const g = r.byAsset?.[CETH_ID], notes = g?.notes || [];
  const pending = (r.diag?.wrap?.pending || []).filter((d) => String(d.asset).toLowerCase() === CETH_ID).map((d) => ({ index: d.index, value: BigInt(d.value), txHash: d.txHash || null, depositId: d.depositId || null }));
  return { value: g ? BigInt(g.value) : 0n, notes: notes.length, pending, positions: Array.isArray(r.farmPositions) && !r.diag?.errors?.farm ? r.farmPositions : null, partial: Object.keys(r.diag?.errors || {}).length > 0, errors: r.diag?.errors || {} };
}
// Settles each waiting deposit again, rebuilt from the key at its own index and amount: the same note, so a settle already done is not repeated.
// The relay settles each (settle(), which ends the wait early once the relay stops sending or proving); with `self` ({ wallet, from }) each is
// settled from the wallet instead (selfFinish), and with `own` ({ wallet, from, prover }) proved on the holder's own credit too (proveOwn). `left` is
// what did not finish, each with the relay's job and any proof it holds, for a second try from the wallet. With `own` the first failure stops it,
// and the rest are left as they are: a prover not taking requests would keep its base fee for each one asked again.
export async function finish({ priv, pending, ux = null, say = () => {}, self = null, own = null }) {
  const t = ux || await getUx();
  let done = 0, err = null;
  const left = [];
  for (const [i, p] of pending.entries()) {
    const jobId = p.jobId || null;
    try {
      const built = t.buildWrap({ walletPriv: priv(), amountWei: p.value * E10, ticker: 'cETH', index: p.index });
      say('proving', p.txHash);
      if (own) await proveOwn({ t, built, hash: p.txHash, wallet: own.wallet, from: own.from, prover: own.prover, say });
      else if (self) await selfFinish({ t, built, hash: p.txHash, jobId, open: p.open || null, ...self, say });
      else await settle({ t, built, hash: p.txHash });
      done++;
    } catch (e) {
      err ||= e; left.push({ ...p, jobId: e?.deposit?.jobId || jobId || e?.open?.jobId || null, open: e?.open || null });
      if (own) { left.push(...pending.slice(i + 1)); break; }
    }
  }
  return { done, err, left };
}
