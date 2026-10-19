
const U64_MAX = (1n << 64n) - 1n;
const ZERO32 = '0x' + '00'.repeat(32);
const OTC_TAG = 'tacit-otc-intent-v1';

export function makeConfidentialOtc({ keccak256, pool }) {
  const { leaf, commitXY, openingSigma, verifyOpeningSigma, deriveOpeningNonce, intentContext, nkToOwner, nativeNu } = pool;

  function otcCtx(assetA, assetB, chainBinding, vA, vB, m, t, deadline, feeA = 0n, feeB = 0n) {
    const notes = [[m.in.cx, m.in.cy, m.owner]];
    if (m.change) notes.push([m.change.cx, m.change.cy, m.owner]);
    notes.push([m.recv.cx, m.recv.cy, m.owner]);
    notes.push([t.in.cx, t.in.cy, t.owner]);
    if (t.change) notes.push([t.change.cx, t.change.cy, t.owner]);
    notes.push([t.recv.cx, t.recv.cy, t.owner]);
    return intentContext(OTC_TAG, chainBinding, assetA, assetB, notes, [BigInt(vA), BigInt(vB), BigInt(deadline ?? 0), BigInt(feeA), BigInt(feeB)]);
  }

  function buildLeg({ owner, nk, inAmount, inR, inLeafIndex, inPath, give, recvValue, recvR, changeR }) {
    if (nk == null) throw new Error('otc: nk (the spent note\'s own secret nullifier key) is required');
    inAmount = BigInt(inAmount); give = BigInt(give); recvValue = BigInt(recvValue);
    if (inAmount < give) throw new Error('otc: input below give amount');
    const inC = commitXY(inAmount, inR);
    const recvC = commitXY(recvValue, recvR);
    const changeAmount = inAmount - give;
    let change = null;
    if (changeAmount > 0n) {
      if (changeR == null) throw new Error('otc: changeR required when input exceeds give');
      const c = commitXY(changeAmount, changeR);
      change = { cx: c.cx, cy: c.cy, amount: changeAmount, _r: BigInt(changeR) };
    } else if (changeR != null) {
      throw new Error('otc: changeR given but input equals give (use no change)');
    }
    return {
      owner, nk,
      in: { cx: inC.cx, cy: inC.cy, amount: inAmount, leafIndex: inLeafIndex, path: inPath, _r: BigInt(inR) },
      recv: { cx: recvC.cx, cy: recvC.cy, amount: recvValue, _r: BigInt(recvR) },
      change,
    };
  }

  function legToWire(leg) {
    if (leg.nk == null) throw new Error('otc: leg has no nk — cannot submit for settlement (see buildLeg)');
    if (!leg.in?.sig || !leg.recv?.sig) throw new Error('otc: leg is unsigned — call signLegs/buildOtc first');
    const wire = {
      inCx: leg.in.cx, inCy: leg.in.cy, inLeafIndex: Number(leg.in.leafIndex), inPath: leg.in.path,
      nk: leg.nk, inAmount: Number(leg.in.amount), inSigR: leg.in.sig.R, inSigZ: leg.in.sig.z,
      hasChange: leg.change ? 1 : 0,
      recvCx: leg.recv.cx, recvCy: leg.recv.cy, recvSigR: leg.recv.sig.R, recvSigZ: leg.recv.sig.z,
    };
    if (leg.change) {
      if (!leg.change.sig) throw new Error('otc: change leg is unsigned');
      Object.assign(wire, {
        changeCx: leg.change.cx, changeCy: leg.change.cy,
        changeSigR: leg.change.sig.R, changeSigZ: leg.change.sig.z,
      });
    }
    return wire;
  }

  function toWireOp(otc) {
    return {
      chainBinding: otc.chainBinding, spendRoot: otc.spendRoot,
      assetA: otc.assetA, assetB: otc.assetB,
      vA: Number(otc.vA), vB: Number(otc.vB),
      makerOwner: otc.maker.owner, takerOwner: otc.taker.owner,
      maker: legToWire(otc.maker), taker: legToWire(otc.taker),
      deadline: Number(otc.deadline ?? 0),
      feeA: Number(otc.feeA ?? 0n), feeB: Number(otc.feeB ?? 0n),
    };
  }

  function buildOtc({ assetA, assetB, vA, vB, chainBinding, spendRoot, maker, taker, deadline, feeA = 0n, feeB = 0n }) {
    vA = BigInt(vA); vB = BigInt(vB);
    feeA = BigInt(feeA); feeB = BigInt(feeB);
    if (!(feeA < vA)) throw new Error('otc: feeA >= taker receipt');
    if (!(feeB < vB)) throw new Error('otc: feeB >= maker receipt');
    deadline = BigInt(deadline ?? 0);
    const m = buildLeg({ ...maker, give: vA, recvValue: vB - feeB });
    const t = buildLeg({ ...taker, give: vB, recvValue: vA - feeA });
    const ctx = otcCtx(assetA, assetB, chainBinding, vA, vB, m, t, deadline, feeA, feeB);

    m.in.sig = openingSigma(m.in.amount, m.in._r, ctx, deriveOpeningNonce(m.in._r, ctx, 'otc-maker-in'));
    m.recv.sig = openingSigma(m.recv.amount, m.recv._r, ctx, deriveOpeningNonce(m.recv._r, ctx, 'otc-maker-recv'));
    if (m.change) m.change.sig = openingSigma(m.change.amount, m.change._r, ctx, deriveOpeningNonce(m.change._r, ctx, 'otc-maker-change'));
    t.in.sig = openingSigma(t.in.amount, t.in._r, ctx, deriveOpeningNonce(t.in._r, ctx, 'otc-taker-in'));
    t.recv.sig = openingSigma(t.recv.amount, t.recv._r, ctx, deriveOpeningNonce(t.recv._r, ctx, 'otc-taker-recv'));
    if (t.change) t.change.sig = openingSigma(t.change.amount, t.change._r, ctx, deriveOpeningNonce(t.change._r, ctx, 'otc-taker-change'));

    return { assetA, assetB, vA, vB, chainBinding, spendRoot, maker: m, taker: t, deadline, feeA, feeB };
  }

  function verifyOtc(otc, { merkleRootFrom }) {
    const fail = (msg) => { throw new Error('otc: ' + msg); };
    const { assetA, assetB, chainBinding, spendRoot, maker: m, taker: t } = otc;
    const vA = BigInt(otc.vA), vB = BigInt(otc.vB), deadline = BigInt(otc.deadline ?? 0);
    const feeA = BigInt(otc.feeA ?? 0n), feeB = BigInt(otc.feeB ?? 0n);
    if (!(vA > 0n && vB > 0n)) fail('zero amount');
    if (!(feeA < vA)) fail('feeA >= taker receipt');
    if (!(feeB < vB)) fail('feeB >= maker receipt');
    if (assetA === assetB) fail('same asset');
    if (spendRoot === ZERO32 || !spendRoot) fail('membership requires a non-zero spend root');

    const mInLf = leaf(assetA, m.in.cx, m.in.cy, m.owner);
    if (merkleRootFrom(mInLf, m.in.leafIndex, m.in.path) !== spendRoot) fail('maker membership');
    const tInLf = leaf(assetB, t.in.cx, t.in.cy, t.owner);
    if (merkleRootFrom(tInLf, t.in.leafIndex, t.in.path) !== spendRoot) fail('taker membership');

    const sameHex = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    if (m.nk == null || !sameHex(nkToOwner(m.nk), m.owner)) fail('maker nk does not commit to maker owner');
    if (t.nk == null || !sameHex(nkToOwner(t.nk), t.owner)) fail('taker nk does not commit to taker owner');

    const ctx = otcCtx(assetA, assetB, chainBinding, vA, vB, m, t, deadline, feeA, feeB);
    if (!verifyOpeningSigma(m.in.cx, m.in.cy, m.in.amount, m.in.sig.R, m.in.sig.z, ctx)) fail('maker-in opening');
    if (!verifyOpeningSigma(t.in.cx, t.in.cy, t.in.amount, t.in.sig.R, t.in.sig.z, ctx)) fail('taker-in opening');
    if (!verifyOpeningSigma(m.recv.cx, m.recv.cy, vB - feeB, m.recv.sig.R, m.recv.sig.z, ctx)) fail('maker-recv opening (net of relay fee)');
    if (!verifyOpeningSigma(t.recv.cx, t.recv.cy, vA - feeA, t.recv.sig.R, t.recv.sig.z, ctx)) fail('taker-recv opening (net of relay fee)');

    const changeA = m.change ? m.change.amount : 0n;
    const changeB = t.change ? t.change.amount : 0n;
    if (m.change) {
      if (!(m.in.amount > vA)) fail('maker change requires input > give');
      if (!verifyOpeningSigma(m.change.cx, m.change.cy, changeA, m.change.sig.R, m.change.sig.z, ctx)) fail('maker-change opening');
    } else if (m.in.amount !== vA) fail('maker exact input required without change');
    if (t.change) {
      if (!(t.in.amount > vB)) fail('taker change requires input > give');
      if (!verifyOpeningSigma(t.change.cx, t.change.cy, changeB, t.change.sig.R, t.change.sig.z, ctx)) fail('taker-change opening');
    } else if (t.in.amount !== vB) fail('taker exact input required without change');
    if (m.in.amount !== vA + changeA) fail('asset_a conservation');
    if (t.in.amount !== vB + changeB) fail('asset_b conservation');
    if (vA + changeA > U64_MAX || vB + changeB > U64_MAX) fail('amount over u64');

    const nullifiers = [
      nativeNu(m.owner, m.nk, mInLf),
      nativeNu(t.owner, t.nk, tInLf),
    ];
    const leaves = [
      leaf(assetA, t.recv.cx, t.recv.cy, t.owner),
      leaf(assetB, m.recv.cx, m.recv.cy, m.owner),
    ];
    if (m.change) leaves.push(leaf(assetA, m.change.cx, m.change.cy, m.owner));
    if (t.change) leaves.push(leaf(assetB, t.change.cx, t.change.cy, t.owner));
    const fees = [];
    if (feeA > 0n) fees.push({ assetId: assetA, value: feeA });
    if (feeB > 0n) fees.push({ assetId: assetB, value: feeB });
    return { nullifiers, leaves, fees };
  }

  function composeCtx({ assetA, assetB, chainBinding, vA, vB, maker, taker, deadline = 0, feeA = 0n, feeB = 0n }) {
    return otcCtx(assetA, assetB, chainBinding, vA, vB, maker, taker, deadline, feeA, feeB);
  }
  function signLegs(leg, ctx, role) {
    const tag = role === 'maker' ? 'otc-maker' : 'otc-taker';
    leg.in.sig = openingSigma(leg.in.amount, leg.in._r, ctx, deriveOpeningNonce(leg.in._r, ctx, `${tag}-in`));
    leg.recv.sig = openingSigma(leg.recv.amount, leg.recv._r, ctx, deriveOpeningNonce(leg.recv._r, ctx, `${tag}-recv`));
    if (leg.change) leg.change.sig = openingSigma(leg.change.amount, leg.change._r, ctx, deriveOpeningNonce(leg.change._r, ctx, `${tag}-change`));
    return leg;
  }
  function assertOtcConservation(otc) {
    const fail = (m) => { throw new Error('otc: ' + m); };
    const vA = BigInt(otc.vA), vB = BigInt(otc.vB);
    const feeA = BigInt(otc.feeA ?? 0n), feeB = BigInt(otc.feeB ?? 0n);
    if (!(vA > 0n && vB > 0n)) fail('zero amount');
    if (!(feeA < vA)) fail('feeA >= taker receipt');
    if (!(feeB < vB)) fail('feeB >= maker receipt');
    if (otc.assetA === otc.assetB) fail('same asset');
    const m = otc.maker, t = otc.taker;
    const changeA = m.change ? BigInt(m.change.amount) : 0n;
    const changeB = t.change ? BigInt(t.change.amount) : 0n;
    if (m.change) { if (!(BigInt(m.in.amount) > vA)) fail('maker change requires input > give'); }
    else if (BigInt(m.in.amount) !== vA) fail('maker exact input required without change');
    if (t.change) { if (!(BigInt(t.in.amount) > vB)) fail('taker change requires input > give'); }
    else if (BigInt(t.in.amount) !== vB) fail('taker exact input required without change');
    if (BigInt(m.in.amount) !== vA + changeA) fail('asset_a conservation');
    if (BigInt(t.in.amount) !== vB + changeB) fail('asset_b conservation');
    if (vA + changeA > U64_MAX || vB + changeB > U64_MAX) fail('amount over u64');
  }

  function assembleOtc({ assetA, assetB, vA, vB, chainBinding, spendRoot, maker, taker, deadline = 0, feeA = 0n, feeB = 0n }) {
    const out = { assetA, assetB, vA: BigInt(vA), vB: BigInt(vB), chainBinding, spendRoot, maker, taker, deadline: BigInt(deadline), feeA: BigInt(feeA), feeB: BigInt(feeB) };
    assertOtcConservation(out);
    return out;
  }

  return { buildLeg, buildOtc, verifyOtc, composeCtx, signLegs, assembleOtc, legToWire, toWireOp, OTC_TAG };
}
