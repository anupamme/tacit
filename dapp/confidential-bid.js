
const U64_MAX = (1n << 64n) - 1n;
const ZERO32 = '0x' + '00'.repeat(32);
const BID_BUYER_TAG = 'tacit-bid-buyer-v1';
const BID_SELLER_TAG = 'tacit-bid-seller-v1';

export function makeConfidentialBid({ keccak256, pool }) {
  const { leaf, commitXY, openingSigma, verifyOpeningSigma, deriveOpeningNonce, intentContext, deriveNote, deriveBidSecret, nativeNu } = pool;
  const { hx } = pool._internal;

  const nonceDomain = (label) => hx(keccak256(new TextEncoder().encode(label)));
  const ND_FUND = nonceDomain('tacit-bid-fund-nonce-v1');
  const ND_RECVA = nonceDomain('tacit-bid-recva-nonce-v1');
  const ND_REFUND = nonceDomain('tacit-bid-refund-nonce-v1');
  const REST_FUND = nonceDomain('tacit-bid-rest-fund-note-v1');
  const REST_RECV = nonceDomain('tacit-bid-rest-recv-note-v1');
  const ND_REST_FUND_AS_FUND = nonceDomain('tacit-bid-rest-fund-as-funding-nonce-v1');
  const ND_REST_FUND_AS_REF = nonceDomain('tacit-bid-rest-fund-as-refund-nonce-v1');
  const ND_REST_RECV = nonceDomain('tacit-bid-rest-recv-nonce-v1');
  function deriveBidNonces(bidSecret, chosenF) {
    const f = Number(chosenF);
    return {
      fund: deriveNote(bidSecret, ND_FUND, f).blinding,
      recvA: deriveNote(bidSecret, ND_RECVA, f).blinding,
      refund: deriveNote(bidSecret, ND_REFUND, f).blinding,
    };
  }

  function buildBid({ assetA, assetB, minFill, maxFill, price, increment, chainBinding, spendRoot,
                      buyerOwner, nk, fundRSecp, fundLeafIndex, fundPath, bidSecret }) {
    if (nk == null) throw new Error('bid: nk (the funding note\'s own secret nullifier key) is required');
    minFill = BigInt(minFill); maxFill = BigInt(maxFill); price = BigInt(price); increment = BigInt(increment);
    if (!(minFill > 0n && price > 0n && increment > 0n)) throw new Error('bid: zero term');
    if (maxFill < minFill) throw new Error('bid: max < min');
    if ((maxFill - minFill) % increment !== 0n) throw new Error('bid: grid not increment-aligned');
    if (assetA === assetB) throw new Error('bid: same asset');
    const vFund = maxFill * price;
    if (vFund > U64_MAX) throw new Error('bid: V_fund over u64');
    const fundC = commitXY(vFund, fundRSecp);
    return {
      assetA, assetB, minFill, maxFill, price, increment, chainBinding, spendRoot, buyerOwner, vFund, bidSecret,
      fund: { cx: fundC.cx, cy: fundC.cy, leafIndex: fundLeafIndex, path: fundPath, nk, _r: BigInt(fundRSecp) },
    };
  }

  function fillBid(bid, { chosenF, sellerOwner, sellerNk, sellerInAmount, sellerInRSecp, sellerInLeafIndex,
                          sellerInPath, sellerRecvRSecp, sellerChangeRSecp, nonces, fee = 0n }) {
    if (sellerNk == null) throw new Error('bid: sellerNk (the seller input note\'s own secret nullifier key) is required');
    chosenF = BigInt(chosenF); sellerInAmount = BigInt(sellerInAmount);
    const { assetA, assetB, minFill, maxFill, price, increment, vFund, bidSecret, buyerOwner } = bid;
    if (!(chosenF >= minFill && chosenF <= maxFill)) throw new Error('bid: fill out of range');
    if ((chosenF - minFill) % increment !== 0n) throw new Error('bid: fill off grid');
    if (sellerInAmount < chosenF) throw new Error('bid: seller input below fill');
    const pay = chosenF * price, refund = vFund - pay;
    fee = BigInt(fee);
    if (!(fee < pay)) throw new Error('bid: fee >= seller payment');

    const raR = deriveNote(bidSecret, assetA, Number(chosenF)).blinding;
    const raC = commitXY(chosenF, raR);
    const buyerRecvA = { cx: raC.cx, cy: raC.cy, amount: chosenF, _r: raR };
    let refundNote = null;
    if (chosenF < maxFill) {
      const rfR = deriveNote(bidSecret, assetB, Number(chosenF)).blinding;
      const rfC = commitXY(refund, rfR);
      refundNote = { cx: rfC.cx, cy: rfC.cy, amount: refund, _r: rfR };
    }

    const sInC = commitXY(sellerInAmount, sellerInRSecp);
    const payC = commitXY(pay - fee, sellerRecvRSecp);
    const sellerIn = { cx: sInC.cx, cy: sInC.cy, amount: sellerInAmount, owner: sellerOwner, nk: sellerNk,
                       leafIndex: sellerInLeafIndex, path: sellerInPath, _r: BigInt(sellerInRSecp) };
    const sellerRecvB = { cx: payC.cx, cy: payC.cy, amount: pay - fee, _r: BigInt(sellerRecvRSecp) };
    let sellerChange = null;
    const changeAmt = sellerInAmount - chosenF;
    if (changeAmt > 0n) {
      if (sellerChangeRSecp == null) throw new Error('bid: sellerChangeRSecp required when input exceeds fill');
      const scC = commitXY(changeAmt, sellerChangeRSecp);
      sellerChange = { cx: scC.cx, cy: scC.cy, amount: changeAmt, _r: BigInt(sellerChangeRSecp) };
    } else if (sellerChangeRSecp != null) throw new Error('bid: sellerChangeRSecp given but input equals fill');

    const bNotes = [[bid.fund.cx, bid.fund.cy, buyerOwner], [buyerRecvA.cx, buyerRecvA.cy, buyerOwner]];
    if (refundNote) bNotes.push([refundNote.cx, refundNote.cy, buyerOwner]);
    const buyerCtx = intentContext(BID_BUYER_TAG, bid.chainBinding, assetA, assetB, bNotes, [minFill, maxFill, price, increment, chosenF, BigInt(bid.deadline ?? 0)]);
    const buyerNonces = [nonces.fund, nonces.recvA].concat(refundNote ? [nonces.refund] : []).map((x) => BigInt(x));
    if (buyerNonces.some((x) => x === 0n) || new Set(buyerNonces.map(String)).size !== buyerNonces.length) {
      throw new Error('bid: buyer sigma nonces must be distinct + non-zero (reuse leaks the blinding)');
    }
    bid.fund.sig = openingSigma(vFund, bid.fund._r, buyerCtx, nonces.fund);
    buyerRecvA.sig = openingSigma(chosenF, buyerRecvA._r, buyerCtx, nonces.recvA);
    if (refundNote) refundNote.sig = openingSigma(refund, refundNote._r, buyerCtx, nonces.refund);

    const sNotes = [[sellerIn.cx, sellerIn.cy, sellerOwner], [sellerRecvB.cx, sellerRecvB.cy, sellerOwner]];
    if (sellerChange) sNotes.push([sellerChange.cx, sellerChange.cy, sellerOwner]);
    const sellerCtx = intentContext(BID_SELLER_TAG, bid.chainBinding, assetA, assetB, sNotes, [chosenF, price, fee]);
    sellerIn.sig = openingSigma(sellerInAmount, sellerIn._r, sellerCtx, deriveOpeningNonce(sellerIn._r, sellerCtx, 'bid-seller-in'));
    sellerRecvB.sig = openingSigma(pay - fee, sellerRecvB._r, sellerCtx, deriveOpeningNonce(sellerRecvB._r, sellerCtx, 'bid-seller-recv'));
    if (sellerChange) sellerChange.sig = openingSigma(changeAmt, sellerChange._r, sellerCtx, deriveOpeningNonce(sellerChange._r, sellerCtx, 'bid-seller-change'));

    return { ...bid, chosenF, pay, refund, fee, buyerRecvA, refundNote, sellerOwner, sellerIn, sellerRecvB, sellerChange };
  }

  function verifyBid(filled, { merkleRootFrom }) {
    const fail = (m) => { throw new Error('bid: ' + m); };
    const { assetA, assetB, chainBinding, spendRoot, buyerOwner, fund,
            buyerRecvA, refundNote, sellerOwner, sellerIn, sellerRecvB, sellerChange } = filled;
    const minFill = BigInt(filled.minFill), maxFill = BigInt(filled.maxFill), price = BigInt(filled.price), increment = BigInt(filled.increment);
    const chosenF = BigInt(filled.chosenF);
    if (!(minFill > 0n && price > 0n && increment > 0n)) fail('zero term');
    if (maxFill < minFill) fail('max < min');
    if ((maxFill - minFill) % increment !== 0n) fail('grid not increment-aligned');
    if (assetA === assetB) fail('same asset');
    if (spendRoot === ZERO32 || !spendRoot) fail('membership requires a non-zero spend root');
    if (!(chosenF >= minFill && chosenF <= maxFill)) fail('fill out of range');
    if ((chosenF - minFill) % increment !== 0n) fail('fill off grid');
    const vFund = maxFill * price;
    const pay = chosenF * price;
    const refund = vFund - pay;
    const fee = BigInt(filled.fee ?? 0n);
    if (!(fee < pay)) fail('fee >= seller payment');
    if (vFund > U64_MAX) fail('V_fund over u64');

    if (merkleRootFrom(leaf(assetB, fund.cx, fund.cy, buyerOwner), fund.leafIndex, fund.path) !== spendRoot) fail('funding membership');
    if (merkleRootFrom(leaf(assetA, sellerIn.cx, sellerIn.cy, sellerOwner), sellerIn.leafIndex, sellerIn.path) !== spendRoot) fail('seller membership');

    const sameHex = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    if (fund.nk == null || !sameHex(pool.nkToOwner(fund.nk), buyerOwner)) fail('funding nk does not commit to buyer owner');
    if (sellerIn.nk == null || !sameHex(pool.nkToOwner(sellerIn.nk), sellerOwner)) fail('seller nk does not commit to seller owner');

    if (chosenF < maxFill) { if (!refundNote || refund <= 0n) fail('partial fill must refund'); }
    else if (refundNote || refund !== 0n) fail('full fill has no refund');
    const changeAmt = sellerChange ? sellerChange.amount : 0n;
    if (sellerChange) { if (!(sellerIn.amount > chosenF)) fail('seller change requires input > fill'); }
    else if (sellerIn.amount !== chosenF) fail('seller exact input required without change');

    const bNotes = [[fund.cx, fund.cy, buyerOwner], [buyerRecvA.cx, buyerRecvA.cy, buyerOwner]];
    if (refundNote) bNotes.push([refundNote.cx, refundNote.cy, buyerOwner]);
    const buyerCtx = intentContext(BID_BUYER_TAG, chainBinding, assetA, assetB, bNotes, [minFill, maxFill, price, increment, chosenF, BigInt(filled.deadline ?? 0)]);
    if (!verifyOpeningSigma(fund.cx, fund.cy, vFund, fund.sig.R, fund.sig.z, buyerCtx)) fail('funding opening');
    if (!verifyOpeningSigma(buyerRecvA.cx, buyerRecvA.cy, chosenF, buyerRecvA.sig.R, buyerRecvA.sig.z, buyerCtx)) fail('buyer-recv-a opening');
    if (refundNote && !verifyOpeningSigma(refundNote.cx, refundNote.cy, refund, refundNote.sig.R, refundNote.sig.z, buyerCtx)) fail('buyer-refund opening');

    const sNotes = [[sellerIn.cx, sellerIn.cy, sellerOwner], [sellerRecvB.cx, sellerRecvB.cy, sellerOwner]];
    if (sellerChange) sNotes.push([sellerChange.cx, sellerChange.cy, sellerOwner]);
    const sellerCtx = intentContext(BID_SELLER_TAG, chainBinding, assetA, assetB, sNotes, [chosenF, price, fee]);
    if (!verifyOpeningSigma(sellerIn.cx, sellerIn.cy, sellerIn.amount, sellerIn.sig.R, sellerIn.sig.z, sellerCtx)) fail('seller-in opening');
    if (!verifyOpeningSigma(sellerRecvB.cx, sellerRecvB.cy, pay - fee, sellerRecvB.sig.R, sellerRecvB.sig.z, sellerCtx)) fail('seller-recv opening (net of relay fee)');
    if (sellerChange && !verifyOpeningSigma(sellerChange.cx, sellerChange.cy, changeAmt, sellerChange.sig.R, sellerChange.sig.z, sellerCtx)) fail('seller-change opening');

    if (vFund !== pay + refund) fail('asset_b conservation');
    if (sellerIn.amount !== chosenF + changeAmt) fail('asset_a conservation');
    if (vFund > U64_MAX || pay > U64_MAX) fail('amount over u64');

    const nullifiers = [
      nativeNu(buyerOwner, fund.nk, leaf(assetB, fund.cx, fund.cy, buyerOwner)),
      nativeNu(sellerOwner, sellerIn.nk, leaf(assetA, sellerIn.cx, sellerIn.cy, sellerOwner)),
    ];
    const leaves = [
      leaf(assetA, buyerRecvA.cx, buyerRecvA.cy, buyerOwner),
      leaf(assetB, sellerRecvB.cx, sellerRecvB.cy, sellerOwner),
    ];
    if (refundNote) leaves.push(leaf(assetB, refundNote.cx, refundNote.cy, buyerOwner));
    if (sellerChange) leaves.push(leaf(assetA, sellerChange.cx, sellerChange.cy, sellerOwner));
    const fees = fee > 0n ? [{ assetId: assetB, value: fee }] : [];
    return { nullifiers, leaves, fees };
  }

  function toWireOp(filled) {
    const { assetA, assetB, minFill, maxFill, price, increment, chainBinding, spendRoot, buyerOwner,
            fund, chosenF, buyerRecvA, refundNote, sellerOwner, sellerIn, sellerRecvB, sellerChange } = filled;
    const fee = BigInt(filled.fee ?? 0n);
    if (fund.nk == null) throw new Error('bid: fund has no nk — cannot submit for settlement (see buildBid)');
    if (sellerIn.nk == null) throw new Error('bid: sellerIn has no nk — cannot submit for settlement (see fillBid/fillRestingLot)');
    if (!fund.sig || !buyerRecvA.sig || !sellerIn.sig || !sellerRecvB.sig) throw new Error('bid: unsigned — call fillBid/fillRestingLot first');
    const note = (n) => ({ cx: n.cx, cy: n.cy, sigR: n.sig.R, sigZ: n.sig.z });
    const wire = {
      chainBinding, spendRoot, assetA, assetB,
      minFill: Number(minFill), maxFill: Number(maxFill), price: Number(price), increment: Number(increment),
      buyerOwner,
      fund: { cx: fund.cx, cy: fund.cy, leafIndex: Number(fund.leafIndex), path: fund.path, nk: fund.nk, sigR: fund.sig.R, sigZ: fund.sig.z },
      chosenF: Number(chosenF),
      buyerRecvA: note(buyerRecvA),
      sellerIn: { cx: sellerIn.cx, cy: sellerIn.cy, leafIndex: Number(sellerIn.leafIndex), path: sellerIn.path, nk: sellerIn.nk, amount: Number(sellerIn.amount), sigR: sellerIn.sig.R, sigZ: sellerIn.sig.z },
      sellerOwner,
      sellerHasChange: sellerChange ? 1 : 0,
      sellerRecvB: note(sellerRecvB),
      deadline: Number(filled.deadline ?? 0),
      fee: Number(fee),
    };
    if (refundNote) {
      if (!refundNote.sig) throw new Error('bid: refund note is unsigned');
      wire.refund = note(refundNote);
    }
    if (sellerChange) {
      if (!sellerChange.sig) throw new Error('bid: seller change is unsigned');
      wire.sellerChange = note(sellerChange);
    }
    return wire;
  }

  function recoverBidOutputs({ seed, bid, leafSet }) {
    const { assetA, assetB, buyerOwner } = bid;
    const minFill = BigInt(bid.minFill), maxFill = BigInt(bid.maxFill);
    const price = BigInt(bid.price), increment = BigInt(bid.increment);
    const bidSecret = deriveBidSecret(seed, bid.fund.cx, bid.fund.cy);
    const get = (lf) => { const e = leafSet.get(String(lf).toLowerCase()); return e ? e.leafIndex : null; };
    const out = [];
    for (let f = minFill; f <= maxFill; f += increment) {
      const raR = deriveNote(bidSecret, assetA, Number(f)).blinding;
      const raC = commitXY(f, raR);
      const raLeaf = leaf(assetA, raC.cx, raC.cy, buyerOwner);
      const raIdx = get(raLeaf);
      if (raIdx == null) continue;
      out.push({ asset: assetA, value: f, blinding: raR, cx: raC.cx, cy: raC.cy, owner: buyerOwner, leaf: raLeaf, leafIndex: raIdx });
      if (f < maxFill) {
        const refund = (maxFill - f) * price;
        const rfR = deriveNote(bidSecret, assetB, Number(f)).blinding;
        const rfC = commitXY(refund, rfR);
        const rfLeaf = leaf(assetB, rfC.cx, rfC.cy, buyerOwner);
        const rfIdx = get(rfLeaf);
        if (rfIdx != null) out.push({ asset: assetB, value: refund, blinding: rfR, cx: rfC.cx, cy: rfC.cy, owner: buyerOwner, leaf: rfLeaf, leafIndex: rfIdx });
      }
      break;
    }
    return out;
  }

  function presignBidGrid(bid) {
    const { assetA, assetB, minFill, maxFill, price, increment, chainBinding, buyerOwner, vFund, bidSecret, fund, deadline } = bid;
    const grid = {};
    for (let f = BigInt(minFill); f <= BigInt(maxFill); f += BigInt(increment)) {
      const nonces = deriveBidNonces(bidSecret, f);
      const raR = deriveNote(bidSecret, assetA, Number(f)).blinding;
      const raC = commitXY(f, raR);
      const buyerRecvA = { cx: raC.cx, cy: raC.cy };
      let refundNote = null;
      const refund = vFund - f * price;
      if (f < BigInt(maxFill)) {
        const rfR = deriveNote(bidSecret, assetB, Number(f)).blinding;
        const rfC = commitXY(refund, rfR);
        refundNote = { cx: rfC.cx, cy: rfC.cy };
      }
      const bNotes = [[fund.cx, fund.cy, buyerOwner], [buyerRecvA.cx, buyerRecvA.cy, buyerOwner]];
      if (refundNote) bNotes.push([refundNote.cx, refundNote.cy, buyerOwner]);
      const ctx = intentContext(BID_BUYER_TAG, chainBinding, assetA, assetB, bNotes, [minFill, maxFill, price, increment, f, BigInt(deadline ?? 0)]);
      const fundSig = openingSigma(vFund, fund._r, ctx, nonces.fund);
      buyerRecvA.sig = openingSigma(f, raR, ctx, nonces.recvA);
      if (refundNote) refundNote.sig = openingSigma(refund, deriveNote(bidSecret, assetB, Number(f)).blinding, ctx, nonces.refund);
      grid[f.toString()] = { fundSig, buyerRecvA, refundNote };
    }
    return { ...bid, grid };
  }

  function toShareableBid(bid) {
    if (!bid.grid) throw new Error('bid: call presignBidGrid before toShareableBid');
    const { assetA, assetB, minFill, maxFill, price, increment, chainBinding, spendRoot, buyerOwner, vFund, deadline, fund, grid } = bid;
    return { assetA, assetB, minFill, maxFill, price, increment, chainBinding, spendRoot, buyerOwner, vFund, deadline,
             fund: { cx: fund.cx, cy: fund.cy, leafIndex: fund.leafIndex, path: fund.path, nk: fund.nk }, grid };
  }

  function fillPresignedBid(shareableBid, { chosenF, sellerOwner, sellerNk, sellerInAmount, sellerInRSecp,
                            sellerInLeafIndex, sellerInPath, sellerRecvRSecp, sellerChangeRSecp, fee = 0n }) {
    if (sellerNk == null) throw new Error('bid: sellerNk (the seller input note\'s own secret nullifier key) is required');
    chosenF = BigInt(chosenF);
    const g = shareableBid.grid[chosenF.toString()];
    if (!g) throw new Error('bid: chosenF is not on the presigned grid');
    const { assetA, assetB, minFill, maxFill, price, increment, chainBinding, spendRoot, buyerOwner, vFund, deadline, fund } = shareableBid;
    sellerInAmount = BigInt(sellerInAmount);
    if (sellerInAmount < chosenF) throw new Error('bid: seller input below fill');
    const pay = chosenF * price, refund = vFund - pay;
    fee = BigInt(fee);
    if (!(fee < pay)) throw new Error('bid: fee >= seller payment');

    const sInC = commitXY(sellerInAmount, sellerInRSecp);
    const payC = commitXY(pay - fee, sellerRecvRSecp);
    const sellerIn = { cx: sInC.cx, cy: sInC.cy, amount: sellerInAmount, owner: sellerOwner, nk: sellerNk,
                       leafIndex: sellerInLeafIndex, path: sellerInPath, _r: BigInt(sellerInRSecp) };
    const sellerRecvB = { cx: payC.cx, cy: payC.cy, amount: pay - fee, _r: BigInt(sellerRecvRSecp) };
    let sellerChange = null;
    const changeAmt = sellerInAmount - chosenF;
    if (changeAmt > 0n) {
      if (sellerChangeRSecp == null) throw new Error('bid: sellerChangeRSecp required when input exceeds fill');
      const scC = commitXY(changeAmt, sellerChangeRSecp);
      sellerChange = { cx: scC.cx, cy: scC.cy, amount: changeAmt, _r: BigInt(sellerChangeRSecp) };
    } else if (sellerChangeRSecp != null) throw new Error('bid: sellerChangeRSecp given but input equals fill');

    const sNotes = [[sellerIn.cx, sellerIn.cy, sellerOwner], [sellerRecvB.cx, sellerRecvB.cy, sellerOwner]];
    if (sellerChange) sNotes.push([sellerChange.cx, sellerChange.cy, sellerOwner]);
    const sellerCtx = intentContext(BID_SELLER_TAG, chainBinding, assetA, assetB, sNotes, [chosenF, price, fee]);
    sellerIn.sig = openingSigma(sellerInAmount, sellerIn._r, sellerCtx, deriveOpeningNonce(sellerIn._r, sellerCtx, 'bid-seller-in'));
    sellerRecvB.sig = openingSigma(pay - fee, sellerRecvB._r, sellerCtx, deriveOpeningNonce(sellerRecvB._r, sellerCtx, 'bid-seller-recv'));
    if (sellerChange) sellerChange.sig = openingSigma(changeAmt, sellerChange._r, sellerCtx, deriveOpeningNonce(sellerChange._r, sellerCtx, 'bid-seller-change'));

    return {
      assetA, assetB, minFill, maxFill, price, increment, chainBinding, spendRoot, buyerOwner, vFund, deadline,
      fund: { cx: fund.cx, cy: fund.cy, leafIndex: fund.leafIndex, path: fund.path, nk: fund.nk, sig: g.fundSig },
      chosenF, pay, refund, fee, buyerRecvA: g.buyerRecvA, refundNote: g.refundNote,
      sellerOwner, sellerIn, sellerRecvB, sellerChange,
    };
  }

  function buildRestingBid({ assetA, assetB, maxFill, price, increment, chainBinding, buyerOwner, nk, fundRSecp, bidSecret, deadline }) {
    if (nk == null) throw new Error('bid: nk (the funding note\'s own secret nullifier key) is required');
    maxFill = BigInt(maxFill); price = BigInt(price); increment = BigInt(increment);
    if (!(price > 0n && increment > 0n)) throw new Error('bid: zero term');
    if (maxFill <= 0n || maxFill % increment !== 0n) throw new Error('bid: maxFill must be a positive multiple of increment');
    if (assetA === assetB) throw new Error('bid: same asset');
    const vFund = maxFill * price;
    if (vFund > U64_MAX) throw new Error('bid: V_fund over u64');
    const minFill = increment;
    const dl = BigInt(deadline ?? 0);

    const fundingR = (C) => (C === 0n ? BigInt(fundRSecp) : deriveNote(bidSecret, REST_FUND, Number(C)).blinding);
    const states = [];
    for (let C = 0n; C < maxFill; C += increment) {
      const remaining = maxFill - C;
      const vFundC = remaining * price;
      const fR = fundingR(C);
      const fC = commitXY(vFundC, fR);
      const rR = deriveNote(bidSecret, REST_RECV, Number(C)).blinding;
      const rC = commitXY(increment, rR);
      const nextRemaining = remaining - increment;
      let refund = null;
      if (nextRemaining > 0n) {
        const fR2 = fundingR(C + increment);
        const c2 = commitXY(nextRemaining * price, fR2);
        refund = { cx: c2.cx, cy: c2.cy, amount: nextRemaining * price, _r: fR2 };
      }
      const bNotes = [[fC.cx, fC.cy, buyerOwner], [rC.cx, rC.cy, buyerOwner]];
      if (refund) bNotes.push([refund.cx, refund.cy, buyerOwner]);
      const ctx = intentContext(BID_BUYER_TAG, chainBinding, assetA, assetB, bNotes, [minFill, remaining, price, increment, increment, dl]);
      const fundNonce = deriveNote(bidSecret, ND_REST_FUND_AS_FUND, Number(C)).blinding;
      const recvNonce = deriveNote(bidSecret, ND_REST_RECV, Number(C)).blinding;
      const fund = { cx: fC.cx, cy: fC.cy, amount: vFundC, nk, _r: fR, sig: openingSigma(vFundC, fR, ctx, fundNonce) };
      const recv = { cx: rC.cx, cy: rC.cy, amount: increment, _r: rR, sig: openingSigma(increment, rR, ctx, recvNonce) };
      if (refund) {
        const refNonce = deriveNote(bidSecret, ND_REST_FUND_AS_REF, Number(C + increment)).blinding;
        refund.sig = openingSigma(refund.amount, refund._r, ctx, refNonce);
      }
      states.push({ C, remaining, fund, recv, refund });
    }
    return { assetA, assetB, minFill, maxFill, price, increment, chainBinding, buyerOwner, vFund, bidSecret, deadline: dl, states };
  }

  function fillRestingLot(restingBid, C, { spendRoot, fundLeafIndex, fundPath, sellerOwner, sellerNk, sellerInAmount,
                          sellerInRSecp, sellerInLeafIndex, sellerInPath, sellerRecvRSecp, sellerChangeRSecp, fee = 0n }) {
    if (sellerNk == null) throw new Error('bid: sellerNk (the seller input note\'s own secret nullifier key) is required');
    C = BigInt(C);
    const state = restingBid.states.find((s) => s.C === C);
    if (!state) throw new Error('bid: no such resting state');
    const { assetA, assetB, price, increment, chainBinding, buyerOwner, minFill, bidSecret, deadline } = restingBid;
    const remaining = state.remaining;
    const chosenF = increment;
    sellerInAmount = BigInt(sellerInAmount);
    if (sellerInAmount < chosenF) throw new Error('bid: seller input below lot');
    const pay = chosenF * price;
    fee = BigInt(fee);
    if (!(fee < pay)) throw new Error('bid: fee >= seller payment');

    const sInC = commitXY(sellerInAmount, sellerInRSecp);
    const payC = commitXY(pay - fee, sellerRecvRSecp);
    const sellerIn = { cx: sInC.cx, cy: sInC.cy, amount: sellerInAmount, owner: sellerOwner, nk: sellerNk,
                       leafIndex: sellerInLeafIndex, path: sellerInPath, _r: BigInt(sellerInRSecp) };
    const sellerRecvB = { cx: payC.cx, cy: payC.cy, amount: pay - fee, _r: BigInt(sellerRecvRSecp) };
    let sellerChange = null;
    const changeAmt = sellerInAmount - chosenF;
    if (changeAmt > 0n) {
      if (sellerChangeRSecp == null) throw new Error('bid: sellerChangeRSecp required when input exceeds lot');
      const scC = commitXY(changeAmt, sellerChangeRSecp);
      sellerChange = { cx: scC.cx, cy: scC.cy, amount: changeAmt, _r: BigInt(sellerChangeRSecp) };
    } else if (sellerChangeRSecp != null) throw new Error('bid: sellerChangeRSecp given but input equals lot');

    const sNotes = [[sellerIn.cx, sellerIn.cy, sellerOwner], [sellerRecvB.cx, sellerRecvB.cy, sellerOwner]];
    if (sellerChange) sNotes.push([sellerChange.cx, sellerChange.cy, sellerOwner]);
    const sellerCtx = intentContext(BID_SELLER_TAG, chainBinding, assetA, assetB, sNotes, [chosenF, price, fee]);
    sellerIn.sig = openingSigma(sellerInAmount, sellerIn._r, sellerCtx, deriveOpeningNonce(sellerIn._r, sellerCtx, 'bid-seller-in'));
    sellerRecvB.sig = openingSigma(pay - fee, sellerRecvB._r, sellerCtx, deriveOpeningNonce(sellerRecvB._r, sellerCtx, 'bid-seller-recv'));
    if (sellerChange) sellerChange.sig = openingSigma(changeAmt, sellerChange._r, sellerCtx, deriveOpeningNonce(sellerChange._r, sellerCtx, 'bid-seller-change'));

    const fund = { ...state.fund, leafIndex: fundLeafIndex, path: fundPath };
    return {
      assetA, assetB, minFill, maxFill: remaining, price, increment, chainBinding, spendRoot, buyerOwner,
      vFund: remaining * price, bidSecret, fund, chosenF, pay, refund: state.refund ? state.refund.amount : 0n, fee,
      buyerRecvA: state.recv, refundNote: state.refund, deadline,
      sellerOwner, sellerIn, sellerRecvB, sellerChange,
    };
  }

  function recoverRestingBidOutputs({ seed, bid, leafSet }) {
    const { assetA, assetB, buyerOwner } = bid;
    const maxFill = BigInt(bid.maxFill), price = BigInt(bid.price), increment = BigInt(bid.increment);
    if (!(increment > 0n) || maxFill <= 0n || maxFill % increment !== 0n) throw new Error('bid: bad resting params');
    const bidSecret = deriveBidSecret(seed, bid.fund.cx, bid.fund.cy);
    const get = (lf) => { const e = leafSet.get(String(lf).toLowerCase()); return e ? e.leafIndex : null; };
    const out = [];
    for (let C = 0n; C < maxFill; C += increment) {
      const rR = deriveNote(bidSecret, REST_RECV, Number(C)).blinding;
      const rC = commitXY(increment, rR);
      const rLeaf = leaf(assetA, rC.cx, rC.cy, buyerOwner);
      const rIdx = get(rLeaf);
      if (rIdx != null) out.push({ asset: assetA, value: increment, blinding: rR, cx: rC.cx, cy: rC.cy, owner: buyerOwner, leaf: rLeaf, leafIndex: rIdx, restingState: C });
      if (C > 0n) {
        const fR = deriveNote(bidSecret, REST_FUND, Number(C)).blinding;
        const vFundC = (maxFill - C) * price;
        const fC = commitXY(vFundC, fR);
        const fLeaf = leaf(assetB, fC.cx, fC.cy, buyerOwner);
        const fIdx = get(fLeaf);
        if (fIdx != null) out.push({ asset: assetB, value: vFundC, blinding: fR, cx: fC.cx, cy: fC.cy, owner: buyerOwner, leaf: fLeaf, leafIndex: fIdx, restingState: C });
      }
    }
    return out;
  }

  function restingFundingNote(restingBid, C) {
    const state = restingBid.states.find((s) => s.C === BigInt(C));
    if (!state) throw new Error('bid: no such resting state');
    return { cx: state.fund.cx, cy: state.fund.cy, amount: state.fund.amount, nk: state.fund.nk, _r: state.fund._r };
  }

  function toShareableRestingBid(restingBid) {
    const pub = (n) => n && { cx: n.cx, cy: n.cy, amount: n.amount, sig: n.sig };
    const { assetA, assetB, minFill, maxFill, price, increment, chainBinding, buyerOwner, vFund, deadline, states } = restingBid;
    return {
      assetA, assetB, minFill, maxFill, price, increment, chainBinding, buyerOwner, vFund, deadline,
      states: states.map((s) => ({ C: s.C, remaining: s.remaining,
        fund: { ...pub(s.fund), nk: s.fund.nk }, recv: pub(s.recv), refund: pub(s.refund) })),
    };
  }

  return { buildBid, fillBid, verifyBid, recoverBidOutputs, recoverRestingBidOutputs, deriveBidNonces,
           presignBidGrid, toShareableBid, fillPresignedBid,
           buildRestingBid, fillRestingLot, restingFundingNote, toShareableRestingBid, toWireOp, BID_BUYER_TAG, BID_SELLER_TAG };
}
