// Making ETH private from the tETH page, as the front page's Private sheet does it: one wallet transaction pays the deposit and the relay's tip
// together, then the relay proves the note and settles it. The note is built from the Tacit key at the next unused index, so the deposit is
// recoverable from the key and the chain alone: a deposit whose settle did not finish is found again (`pendingOf`) and finished (`finish`).
//
// The pool module (confidential-pool-ux.js) is loaded the first time it is needed. Nothing here holds a key: each step is handed `priv()`.
import { secp, sha256, keccak_256 } from '/vendor/tacit-deps.min.js';
import { WRAP_TIP, WRAP_WITH_TIP, CETH_ID } from '/trade/teth/read.js?cb=cb8cb803';
import { strip, word, E10 } from '/trade/util.js?cb=369d2824';

let uxP = null;
export function getUx() {
  return (uxP ||= (async () => {
    const [{ makeConfidentialPoolUx }, dep] = await Promise.all([import('/confidential-pool-ux.js?cb=06532c6a'), import('/confidential-deployments.js')]);
    dep.setActiveNetwork('mainnet');
    return makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet' });
  })().catch((e) => { uxP = null; throw e; }));
}
// Dropped when the key is locked, with the copies of it the pool module keeps.
export async function forgetUx() {
  try { (await import('/confidential-pool-ux.js?cb=06532c6a')).forgetKeys(); } catch { /* the module was never loaded */ }
}

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
export async function settle({ t = null, built, hash = null, say = () => {} }) {
  const ux = t || await getUx();
  say('proving', hash);
  try { await ux.submitWrapSettle({ built, waitOpts: { timeoutMs: 15 * 60e3, intervalMs: 4000 }, depositTx: hash }); } catch (e) { throw Object.assign(e, { deposit: { hash, built, landed: true } }); }
  return { hash, built };
}

// A failure of the relay's half, in the front page's words: a wait that ran out is not a job that failed, and the deposit is never asked for again.
export function relayWords(e) {
  const m = String(e?.message || e || '');
  if (/settle timed out|status polling for job/i.test(m)) return 'The relay is still working on it. It goes through on its own, so there is no need to send the deposit again.';
  if (/prove timed out/i.test(m)) return 'The relay is taking longer than usual to prove it, and this page stopped waiting.';
  if (/relay lost the job/i.test(m)) return 'The relay lost track of the request.';
  if (/free relayed settles for today are used up/i.test(m)) return 'The relay\'s free settles for today are used up. They open again at midnight UTC.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Could not reach the relay.';
  return m.replace(/^Error:\s*/, '').replace(/\brelayer/gi, 'relay').slice(0, 220);
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
export async function finish({ priv, pending, ux = null, say = () => {} }) {
  const t = ux || await getUx();
  let done = 0, err = null;
  for (const p of pending) {
    try {
      const built = t.buildWrap({ walletPriv: priv(), amountWei: p.value * E10, ticker: 'cETH', index: p.index });
      say('proving', p.txHash);
      await t.submitWrapSettle({ built, waitOpts: { timeoutMs: 15 * 60e3, intervalMs: 4000 }, depositTx: p.txHash });
      done++;
    } catch (e) { err ||= e; }
  }
  return { done, err };
}
