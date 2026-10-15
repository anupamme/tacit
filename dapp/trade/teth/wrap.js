// Making ETH private from the tETH page, as the front page's Private sheet does it: one wallet transaction pays the deposit and the relay's tip
// together, then the relay proves the note and settles it. The note is built from the Tacit key at the next unused index, so the deposit is
// recoverable from the key and the chain alone: a deposit whose settle did not finish is found again (`pendingOf`) and finished (`finish`).
//
// The pool module (confidential-pool-ux.js) is loaded the first time it is needed. Nothing here holds a key: each step is handed `priv()`.
import { getUx, forgetUx } from '/trade/poolux.js?cb=0c532ca8';
import { WRAP_TIP, WRAP_WITH_TIP, CETH_ID, POOL } from '/trade/teth/read.js?cb=b748d14e';
import { strip, word, rpc, ethCall, E10 } from '/trade/util.js?cb=9f8675a8';

export { getUx, forgetUx };

// The calldata of wrapWithTip(commit, amount, tipTo).
export const wrapCalldata = ({ commit, wei, to }) => WRAP_WITH_TIP + strip(commit).padStart(64, '0') + word(wei) + strip(to).toLowerCase().padStart(64, '0');

// What a wrap may be, from the pool's own rule: whole units of 1e-8 ETH (its notes carry 8 decimals).
export const wrapIssue = (wei) => (wei <= 0n ? 'Enter an amount.' : wei % E10 !== 0n ? 'Up to 8 decimals.' : null);

// Everything from the press to a settled note. `say(step, detail)` reports where it is: 'prepare', 'confirm', 'sent' (hash), 'proving'.
// A deposit that landed and then could not be settled throws an error carrying `deposit: { hash, built }` so the caller can try the settle again
// (`settle`) or leave it to Finish. A deposit that never went out throws a plain error, and nothing is owed.
export async function wrapEth({ priv, wei, tip, to, from, wallet, say = () => {}, ux = null }) {
  const t = ux || await getUx();
  say('prepare');
  const index = await t.nextWrapIndex({ walletPriv: priv(), ticker: 'cETH' });
  const built = t.buildWrap({ walletPriv: priv(), amountWei: wei, ticker: 'cETH', index });
  say('confirm');
  const hash = await wallet.sendTx({ to: WRAP_TIP, data: wrapCalldata({ commit: built.commit, wei, to }), value: wei + tip, from });
  say('sent', hash);
  let rc;
  try { rc = await wallet.receipt(hash); } catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: false } }); }
  if (rc.status !== '0x1') throw Object.assign(new Error('The deposit failed on chain. Nothing was lost but its network fee.'), { reverted: true });
  return settle({ t, built, hash, say });
}
// The relay's half: prove the note and settle it. Safe to run again for the same `built`: the deposit's id is the note it becomes.
// A failure carries the relay's job (`deposit.jobId`), so finishing it from the wallet picks up the same proof rather than asking for another.
export async function settle({ t = null, built, hash = null, say = () => {} }) {
  const ux = t || await getUx();
  say('proving', hash);
  let jobId = null;
  try { await ux.submitWrapSettle({ built, waitOpts: { timeoutMs: 15 * 60e3, intervalMs: 4000, onJob: (id) => { jobId = id; } }, depositTx: hash }); }
  catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: true, jobId: jobId || e.open?.jobId || null } }); }
  return { hash, built };
}

// A failure of the relay's half, in the front page's words: a wait that ran out is not a job that failed, and the deposit is never asked for again.
// The relay's own code comes first (confidential-relay.js keeps it on the error), then its words, for a relay that answers without one.
export function relayWords(e) {
  const m = String(e?.message || e || ''), code = e?.code;
  if (code === 'open' || e?.open || /settle held|waiting for a sender/i.test(m)) return 'Your note is proved and waiting to be sent. Anyone can send it, and it goes through on its own once a relay does.';
  if (code === 'prove_budget') return 'The relay has made as many proofs as it can for today; try again after midnight UTC. Your deposit is safe and waits to be finished.';
  if (code === 'relay_held' || /can.t take this one/i.test(m)) return 'The relay is catching up on settles and did not take this one just now. Your deposit is safe and waits to be finished.';
  if (code === 'free_budget' || /free relayed settles for today are used up/i.test(m)) return 'The relay\'s free settles for today are used up. They open again at midnight UTC.';
  if (/settle timed out|status polling for job/i.test(m)) return 'The relay is still working on it. It goes through on its own, so there is no need to send the deposit again.';
  if (/prove timed out/i.test(m)) return 'The relay is taking longer than usual to prove it, and this page stopped waiting.';
  if (/relay lost the job/i.test(m)) return 'The relay lost track of the request.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Could not reach the relay.';
  return m.replace(/^Error:\s*/, '').replace(/\brelayer/gi, 'relay').slice(0, 220);
}

// ── finishing from the wallet ──
// settle() on the pool is open to any account, so a deposit the relay has not settled can be settled from the connected wallet, which pays the
// network fee: the relay still proves the note (or has proved it already), and the wallet sends the proof. What the relay was tipped for the
// wrap is not handed back.
const WRAP_SETTLE_GAS = 593_000n;                                                   // a wrap's settle, as the relay counts it (worker-relay OP_GAS.wrap)
const DEPOSIT_STATUS = '0x7da9874f';                                                // depositStatus(bytes32): 0 none, 1 waiting, 2 consumed

// A refusal or a wait the wallet can end: the relay held the job or its free settles are used up, it answered 429 or 5xx, the wait ran out, or the
// job is proved and waiting for a sender (with its proof attached, or without when the relay's memos were not this call's own: a note rebuilt by
// Finish has fresh memos, and the wallet then fetches the job and checks the relay's against the key). Not a relay that has no proofs left today
// (prove_budget): the wallet needs its proof as much as it does.
export function selfable(e) {
  if (!e) return false;
  if (e.open) return true;
  if (e.code === 'prove_budget') return false;
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
export async function selfFinish({ t = null, built, hash = null, jobId = null, open = null, wallet, from, say = () => {} }) {
  const ux = t || await getUx();
  const waitOpts = { timeoutMs: 15 * 60e3, intervalMs: 4000 };
  let mine = null;                                                                  // the settle this wallet sent, once it has landed
  async function send({ jobId: id, publicValues, proof, memos }) {
    const data = ux.settleCalldata({ publicValues, proof, memos });
    say('check');
    try { await rpc('eth_call', [{ from, to: POOL, data }, 'latest']); }
    catch (e) {
      if (await consumed(built)) return { txHash: null, already: true };
      throw new Error(e?.revert ? 'The settle would not go through on chain just now, so nothing was sent. Try again in a moment.' : 'The settle could not be checked just now, so nothing was sent. Try again in a moment.');
    }
    say('confirm');
    const txHash = await wallet.sendTx({ to: POOL, data, from });
    say('sent', txHash);
    const rc = await wallet.receipt(txHash);
    if (rc.status !== '0x1') {
      if (await consumed(built)) return { txHash: null, already: true };
      throw new Error('The settle failed on chain. Nothing was lost but its network fee, and the deposit still waits to be finished.');
    }
    mine = txHash;
    if (id) await ux.relay.landed(id, txHash);
    return { txHash };
  }
  const done = (txHash = mine) => ({ hash, built, txHash, already: !mine });
  if (await consumed(built)) return done();
  let pr = open?.publicValues && open?.proof ? open : null;
  if (!pr && jobId) {
    say('proving');
    try {
      const st = await ux.relay.waitForSettle(jobId, { ...waitOpts, openGraceMs: 0 });
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
  const r = await ux.submitWrapSettle({ built, waitOpts, depositTx: hash, selfSettle: send });
  return done(mine || r?.txHash || null);
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
// With `self` ({ wallet, from }) each is settled from the wallet instead (selfFinish). `left` is what did not finish, each with the relay's job
// and any proof it holds, for a second try from the wallet.
export async function finish({ priv, pending, ux = null, say = () => {}, self = null }) {
  const t = ux || await getUx();
  let done = 0, err = null;
  const left = [];
  for (const p of pending) {
    let jobId = p.jobId || null;
    try {
      const built = t.buildWrap({ walletPriv: priv(), amountWei: p.value * E10, ticker: 'cETH', index: p.index });
      say('proving', p.txHash);
      if (self) await selfFinish({ t, built, hash: p.txHash, jobId, open: p.open || null, ...self, say });
      else await t.submitWrapSettle({ built, waitOpts: { timeoutMs: 15 * 60e3, intervalMs: 4000, onJob: (id) => { jobId = id; } }, depositTx: p.txHash });
      done++;
    } catch (e) { err ||= e; left.push({ ...p, jobId: jobId || e?.open?.jobId || null, open: e?.open || null }); }
  }
  return { done, err, left };
}
