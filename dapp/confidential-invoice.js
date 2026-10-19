
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export function makeConfidentialInvoice({ ux }) {
  if (!ux || !ux.pool || !ux.buildWrap) throw new Error('makeConfidentialInvoice: a confidential-pool-ux instance is required');
  const pool = ux.pool;
  const lc = (h) => String(h).toLowerCase();

  function createInvoice({ recipientPriv, ticker = 'cETH', amountWei, index = 0 }) {
    const meta = ux.assetByTicker[ticker];
    if (!meta) throw new Error(`unknown asset ${ticker}`);
    const w = ux.buildWrap({ walletPriv: recipientPriv, amountWei, ticker, index });
    const invoice = {
      v: 1,
      chainBinding: w.wrapOp.chainBinding,
      assetId: w.wrapOp.asset,
      underlying: meta.underlying,
      ticker,
      amount: w.amount,
      value: w.wrapOp.value,
      cx: w.wrapOp.cx,
      cy: w.wrapOp.cy,
      owner: w.wrapOp.owner,
      commit: w.commit,
      depositId: w.depositId,
      leaf: w.leaf,
      memo: w.memo,
      witness: w.wrapOp,
    };
    return { invoice, claim: { index } };
  }

  function verifyInvoice(invoice) {
    try {
      if (!invoice || invoice.v !== 1 || !invoice.witness) return false;
      const value = BigInt(invoice.value);
      if (lc(pool.depositCommit(invoice.cx, invoice.cy, invoice.owner)) !== lc(invoice.commit)) return false;
      if (lc(pool.leaf(invoice.assetId, invoice.cx, invoice.cy, invoice.owner)) !== lc(invoice.leaf)) return false;
      if (lc(pool.depositId(invoice.assetId, value, invoice.cx, invoice.cy, invoice.owner)) !== lc(invoice.depositId)) return false;
      const ctx = pool.intentContext(
        'tacit-wrap-intent-v1', invoice.chainBinding, invoice.assetId, invoice.depositId,
        [[invoice.cx, invoice.cy, invoice.owner]], [value]
      );
      return pool.verifyOpeningSigma(invoice.cx, invoice.cy, value, invoice.witness.sigR, invoice.witness.sigZ, ctx);
    } catch {
      return false;
    }
  }

  function payArgs(invoice) {
    if (!verifyInvoice(invoice)) throw new Error('invoice failed verification (malformed / not claimable)');
    return {
      token: invoice.underlying,
      amount: invoice.amount,
      commit: invoice.commit,
      assetId: invoice.assetId,
      native: lc(invoice.underlying) === ZERO_ADDR,
    };
  }

  function settleInputs(invoice) {
    if (!verifyInvoice(invoice)) throw new Error('invoice failed verification (malformed / not claimable)');
    return {
      depositsConsumed: [invoice.depositId],
      leaves: [invoice.leaf],
      memos: [invoice.memo],
      witness: invoice.witness,
    };
  }

  function isPaid(invoice, wrapEvents) {
    return (wrapEvents || []).some((e) => lc(e.depositId) === lc(invoice.depositId));
  }

  function recoverNote({ recipientPriv, invoice, index, root, leafIndex, path }) {
    const w = ux.buildWrap({ walletPriv: recipientPriv, amountWei: invoice.amount, ticker: invoice.ticker, index });
    if (lc(w.depositId) !== lc(invoice.depositId)) throw new Error('recoverNote: wrong seed/index for this invoice');
    return {
      asset: invoice.assetId,
      value: w.note.value,
      cx: w.note.cx,
      cy: w.note.cy,
      owner: w.note.owner,
      blinding: w.note.blinding,
      secret: w.note.secret,
      root,
      leafIndex,
      path,
    };
  }

  return { createInvoice, verifyInvoice, payArgs, settleInputs, isPaid, recoverNote };
}
