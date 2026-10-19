
import { buildCbtcLockEnvelope } from './cbtc-envelope.js';

export function makeCbtcLock(deps) {
  const {
    privkey,
    asset,
    commitXY,
    deriveCbtcNoteBlinding,
    anchorBytes,
    selectLockFunding,
    ownLockScriptPubKey,
    broadcastCbtcLockTx,
    postHint,
    lockVout = 1,
  } = deps;

  if (!(privkey instanceof Uint8Array) || privkey.length !== 32) throw new Error('cbtc-lock: privkey must be 32 bytes');
  if (typeof commitXY !== 'function') throw new Error('cbtc-lock: inject commitXY');
  if (typeof broadcastCbtcLockTx !== 'function') throw new Error('cbtc-lock: inject broadcastCbtcLockTx');

  async function buildAndBroadcastCbtcLock({ amountSats, feePadSats = 0n, waitOpts } = {}) {
    const vBtc = BigInt(amountSats);
    if (vBtc <= 0n) throw new Error('cbtc-lock: amount must be positive');

    const sel = await selectLockFunding({ amountSats: vBtc + BigInt(feePadSats) });
    if (!sel || !sel.fundingPrevout) throw new Error('cbtc-lock: no funding available for the lock');
    const { fundingPrevout } = sel;

    const anchorOutpoint = anchorBytes(fundingPrevout.txid, fundingPrevout.vout);
    const blinding = deriveCbtcNoteBlinding({ privkey, anchorOutpoint, outputIndex: 0 });

    const { cx, cy } = commitXY(vBtc, blinding);
    const envelopeHex = buildCbtcLockEnvelope({ asset, lockVout, cx, cy });

    const lockSpk = ownLockScriptPubKey();
    const res = await broadcastCbtcLockTx({ fundingPrevout, vBtc, lockVout, lockSpk, envelopeHex, waitOpts });
    if (!res || !res.lockTxid) throw new Error('cbtc-lock: broadcast returned no lock txid');

    if (postHint) { try { await postHint(res.lockTxid, res.lockVout ?? lockVout); } catch { } }

    return {
      lockTxid: res.lockTxid,
      lockVout: res.lockVout ?? lockVout,
      vBtc: String(vBtc),
      blinding,
      anchor: fundingPrevout,
    };
  }

  return { buildAndBroadcastCbtcLock };
}
