
import { solveClearing } from './confidential-swap.js';
import { pedersenBJJ, packPoint, N_BJJ, P_FR, mod as modField } from './amm-bjj.js';
import { proveXCurveDeterministic } from './amm-sigma.js';
import { SECP_N, modN, pedersenCommit, pointToBytes, G, H, ZERO } from './bulletproofs.js';
import { bppRangeProve } from './bulletproofs-plus.js';
import { sha256, keccak_256 } from './vendor/tacit-deps.min.js';

const N_MAX = 16;
const SWAP_DIR_A_TO_B = 0;
const SWAP_DIR_B_TO_A = 1;
const SWAP_BLIND_INTENT_TAG = 'tacit-swap-blind-intent-v1';
const SWAP_BLIND_KERNEL_DOMAIN = new TextEncoder().encode('tacit-swap-blind-kernel-v1');

const hexToBytes = (h) => { h = String(h || '').replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const be32 = (n) => { const o = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
const be32hex = (n) => bytesToHex(be32(n));

const catBytes = (parts) => { const t = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(t); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };

function aggregateKernelChallenge(chainBinding, poolId, assetXIsA, X, R) {
  const msg = catBytes([SWAP_BLIND_KERNEL_DOMAIN, hexToBytes(chainBinding), hexToBytes(poolId), Uint8Array.of(assetXIsA ? 0 : 1), X.toRawBytes(true), R.toRawBytes(true)]);
  return modN(BigInt(bytesToHex(keccak_256(msg))));
}

function aggregatePoint({ intents, receipts, assetXIsA, deltaSign, deltaMag, tipCSecp }) {
  const pt = (v) => G.constructor.fromHex(typeof v === 'string' ? v.replace(/^0x/, '') : v);
  let sum = ZERO;
  intents.forEach((it, i) => {
    const isInput = (assetXIsA && it.direction === SWAP_DIR_A_TO_B) || (!assetXIsA && it.direction === SWAP_DIR_B_TO_A);
    const isOutput = (assetXIsA && it.direction === SWAP_DIR_B_TO_A) || (!assetXIsA && it.direction === SWAP_DIR_A_TO_B);
    if (isInput) sum = sum.add(pt(it.cInSecp));
    else if (isOutput) sum = sum.add(pt(receipts[i].cOutSecp).negate());
  });
  sum = sum.add(pt(tipCSecp).negate());
  const mag = BigInt(deltaMag);
  if (mag !== 0n) sum = deltaSign === 0 ? sum.add(H.multiply(mag).negate()) : sum.add(H.multiply(mag));
  return sum;
}

export function signAggregateKernel({ excess, chainBinding, poolId, assetXIsA }) {
  const x = modN(BigInt(excess));
  if (x === 0n) throw new Error('swap-blind: zero blinding excess (resample a blinding)');
  const X = G.multiply(x);
  const k = randScalar(SECP_N);
  const R = G.multiply(k);
  const e = aggregateKernelChallenge(chainBinding, poolId, assetXIsA, X, R);
  return { R: bytesToHex(R.toRawBytes(true)), z: be32hex(modN(k + e * x)) };
}

export function verifyAggregateKernel({ intents, receipts, assetXIsA, deltaSign, deltaMag, tipCSecp, chainBinding, poolId, kernel }) {
  let X, R;
  try { X = aggregatePoint({ intents, receipts, assetXIsA, deltaSign, deltaMag, tipCSecp }); R = G.constructor.fromHex(String(kernel.R).replace(/^0x/, '')); } catch { return false; }
  if (X.equals(ZERO)) return false;
  const z = BigInt(kernel.z);
  if (z >= SECP_N) return false;
  const e = aggregateKernelChallenge(chainBinding, poolId, assetXIsA, X, R);
  const lhs = z === 0n ? ZERO : G.multiply(z);
  return lhs.equals(R.add(e === 0n ? ZERO : X.multiply(e)));
}

function randScalar(mod) {
  while (true) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    let n = 0n; for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < mod) return n;
  }
}

export { aggregatePoint as aggregateKernelPoint };

export function kernelNonceCommit() {
  const k = randScalar(SECP_N);
  return { k, R: bytesToHex(G.multiply(k).toRawBytes(true)) };
}

export function kernelChallenge({ chainBinding, poolId, assetXIsA, X, partialRs }) {
  let R = ZERO;
  for (const r of partialRs) R = R.add(G.constructor.fromHex(String(r).replace(/^0x/, '')));
  const e = aggregateKernelChallenge(chainBinding, poolId, assetXIsA, X, R);
  return { R: bytesToHex(R.toRawBytes(true)), e: be32hex(e) };
}

export function kernelPartialResponse({ k, share, e }) {
  return be32hex(modN(BigInt(k) + modN(BigInt(e)) * modN(BigInt(share))));
}

export function combineKernelResponses({ R, partialZs }) {
  let z = 0n;
  for (const pz of partialZs) z = modN(z + BigInt(pz));
  return { R, z: be32hex(z) };
}

function fillTrader(direction, amountIn, P_clear_num, P_clear_den) {
  const [mult, div] = direction === SWAP_DIR_A_TO_B
    ? [BigInt(P_clear_den), BigInt(P_clear_num)]
    : [BigInt(P_clear_num), BigInt(P_clear_den)];
  const num = BigInt(amountIn) * mult;
  const amountOut = num / div;
  return { amountOut, rem: num - amountOut * div };
}

export function buildSwapInput({ poolIdFr, R_A, R_B, fee_bps, traders }) {
  const X = traders.filter(t => t.direction === SWAP_DIR_A_TO_B).reduce((s, t) => s + BigInt(t.amountIn), 0n);
  const Y = traders.filter(t => t.direction === SWAP_DIR_B_TO_A).reduce((s, t) => s + BigInt(t.amountIn), 0n);
  const solve = solveClearing(X, Y, BigInt(R_A), BigInt(R_B), BigInt(fee_bps));

  const direction   = new Array(N_MAX).fill('0');
  const min_out     = new Array(N_MAX).fill('0');
  const tip_amount  = new Array(N_MAX).fill('0');
  const amount_in_swap     = new Array(N_MAX).fill('0');
  const tip_amount_witness = new Array(N_MAX).fill('0');
  const r_in_BJJ    = new Array(N_MAX).fill('0');
  const amount_out  = new Array(N_MAX).fill('0');
  const rem         = new Array(N_MAX).fill('0');
  const r_out_BJJ   = new Array(N_MAX).fill('0');
  const C_in_BJJ_u  = new Array(N_MAX).fill('0');
  const C_in_BJJ_v  = new Array(N_MAX).fill('1');
  const C_out_BJJ_u = new Array(N_MAX).fill('0');
  const C_out_BJJ_v = new Array(N_MAX).fill('1');

  const filled = [];
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i];
    const { amountOut, rem: r } = fillTrader(t.direction, t.amountIn, solve.P_clear_num, solve.P_clear_den);
    const tip = BigInt(t.tip ?? 0);
    const inTotal = BigInt(t.amountIn) + tip;
    const rInBJJ = t.rInBJJ != null ? modField(BigInt(t.rInBJJ), N_BJJ) : randScalar(N_BJJ);
    const rOutBJJ = t.rOutBJJ != null ? modField(BigInt(t.rOutBJJ), N_BJJ) : randScalar(N_BJJ);
    const Cin = pedersenBJJ(inTotal, rInBJJ);
    const Cout = pedersenBJJ(amountOut, rOutBJJ);

    direction[i]          = String(t.direction);
    min_out[i]            = BigInt(t.minOut).toString();
    amount_in_swap[i]     = BigInt(t.amountIn).toString();
    tip_amount[i]         = tip.toString();
    tip_amount_witness[i] = tip.toString();
    r_in_BJJ[i]           = rInBJJ.toString();
    amount_out[i]         = amountOut.toString();
    rem[i]                = r.toString();
    r_out_BJJ[i]          = rOutBJJ.toString();
    C_in_BJJ_u[i]         = Cin[0].toString();
    C_in_BJJ_v[i]         = Cin[1].toString();
    C_out_BJJ_u[i]        = Cout[0].toString();
    C_out_BJJ_v[i]        = Cout[1].toString();

    filled.push({ ...t, tip, inTotal, amountOut, rem: r, rInBJJ, rOutBJJ, cInBjj: packPoint(Cin), cOutBjj: packPoint(Cout) });
  }

  let netA = 0n, netB = 0n;
  for (const t of filled) {
    if (t.direction === SWAP_DIR_A_TO_B) { netA += BigInt(t.amountIn); netB -= t.amountOut; }
    else                                 { netB += BigInt(t.amountIn); netA -= t.amountOut; }
  }
  const deltaA_sign = netA < 0n ? 1 : 0, deltaA_mag = netA < 0n ? -netA : netA;
  const deltaB_sign = netB < 0n ? 1 : 0, deltaB_mag = netB < 0n ? -netB : netB;

  const input = {
    pool_id_fr           : String(poolIdFr),
    R_A_pre              : BigInt(R_A).toString(),
    R_B_pre              : BigInt(R_B).toString(),
    delta_A_net_sign     : String(deltaA_sign),
    delta_A_net_magnitude: deltaA_mag.toString(),
    delta_B_net_sign     : String(deltaB_sign),
    delta_B_net_magnitude: deltaB_mag.toString(),
    tip_A_amount         : filled.filter(t => t.direction === SWAP_DIR_A_TO_B).reduce((s, t) => s + t.tip, 0n).toString(),
    tip_B_amount         : filled.filter(t => t.direction === SWAP_DIR_B_TO_A).reduce((s, t) => s + t.tip, 0n).toString(),
    fee_bps              : String(fee_bps),
    n_intents            : String(traders.length),
    direction, C_in_BJJ_u, C_in_BJJ_v, min_out, tip_amount,
    C_out_BJJ_u, C_out_BJJ_v,
    amount_in_swap, tip_amount_witness, r_in_BJJ,
    amount_out, rem, r_out_BJJ,
  };
  const deltas = {
    deltaANetSign: deltaA_sign, deltaANetMag: deltaA_mag,
    deltaBNetSign: deltaB_sign, deltaBNetMag: deltaB_mag,
  };
  return { input, filled, deltas };
}

export function solveBatchClearing({ reserveAPre, reserveBPre, feeBps, traders }) {
  const { filled, deltas } = buildSwapInput({
    poolIdFr: 0n, R_A: reserveAPre, R_B: reserveBPre, fee_bps: feeBps,
    traders: traders.map((t) => ({ ...t, minOut: 0, deadline: 0 })),
  });
  return { amountOuts: filled.map((f) => f.amountOut), deltas };
}

export function kernelAggregatePointFromLegs({ legs, assetXIsA, deltaSign, deltaMag, tipCSecp }) {
  const intents = legs.map((l) => ({ direction: l.input.direction, cInSecp: l.input.cInSecp }));
  const receipts = legs.map((l) => ({ cOutSecp: l.output.cOutSecp }));
  return aggregatePoint({ intents, receipts, assetXIsA, deltaSign, deltaMag, tipCSecp });
}

function poolIdFr(poolIdHex) {
  const d = sha256(hexToBytes(poolIdHex));
  let n = 0n; for (const x of d) n = (n << 8n) | BigInt(x);
  return modField(n, P_FR);
}

export function makeConfidentialSwapblind({ pool, proveGroth16, ammDerivePoolIdV1 }) {
  const { commitXY, leaf, nullifier, openingPokBlind, deriveOpeningNonce, intentContext, decompressCommitment, poolIdWithProtocolFee } = pool;

  const applySigned = (reserve, sign, mag) => (Number(sign) === 0 ? BigInt(reserve) + BigInt(mag) : BigInt(reserve) - BigInt(mag));

  async function buildSwapBlindOp({ chainBinding, assetA, assetB, feeBps, reserveAPre, reserveBPre, traders, spendRoot = null }) {
    if (traders.length < 1 || traders.length > N_MAX) throw new Error('swap-blind: 1..16 intents');
    if (!(BigInt(assetA) < BigInt(assetB))) throw new Error('swap-blind: assets must be canonically ordered A<B');

    const circuitPoolId = ammDerivePoolIdV1(assetA, assetB, feeBps);
    const { input, filled, deltas } = buildSwapInput({
      poolIdFr: poolIdFr(circuitPoolId),
      R_A: reserveAPre, R_B: reserveBPre, fee_bps: feeBps, traders,
    });

    const proof = await proveGroth16({ input });
    if (!(proof instanceof Uint8Array) || proof.length !== 256) throw new Error('swap-blind: proof must be 256 bytes');

    const intents = [];
    const receipts = [];
    const fixtureIntents = [];
    for (let i = 0; i < filled.length; i++) {
      const t = filled[i];
      const inAsset = t.direction === SWAP_DIR_A_TO_B ? assetA : assetB;

      const rInSecp = modN(BigInt(t.inNote.rSecp));
      const CinSecp = pedersenCommit(t.inTotal, rInSecp);
      const cInSecpBytes = pointToBytes(CinSecp);
      const inXY = commitXY(t.inTotal, rInSecp);
      const inXcurve = proveXCurveDeterministic({
        a: t.inTotal, r_secp: rInSecp, r_BJJ: BigInt(t.rInBJJ),
        C_secp: CinSecp, C_BJJ: pedersenBJJ(t.inTotal, BigInt(t.rInBJJ)),
        seedKey: hexToBytes(chainBinding),
      }).proof;

      const rOutSecp = modN(BigInt(t.rOutSecp));
      const outXY = commitXY(t.amountOut, rOutSecp);
      const CoutSecp = pedersenCommit(t.amountOut, rOutSecp);
      const cOutSecpBytes = pointToBytes(CoutSecp);
      const outXcurve = proveXCurveDeterministic({
        a: t.amountOut, r_secp: rOutSecp, r_BJJ: BigInt(t.rOutBJJ),
        C_secp: CoutSecp, C_BJJ: pedersenBJJ(t.amountOut, BigInt(t.rOutBJJ)),
        seedKey: hexToBytes(chainBinding),
      }).proof;
      const outRangeProof = bppRangeProve([t.amountOut], [rOutSecp]).proof;

      const ctx = intentContext(
        SWAP_BLIND_INTENT_TAG, chainBinding, assetA, assetB,
        [[inXY.cx, inXY.cy, t.inNote.owner], [outXY.cx, outXY.cy, t.outOwner]],
        [BigInt(t.direction), BigInt(t.minOut), BigInt(t.deadline ?? 0), t.tip],
      );
      const pok = openingPokBlind(
        t.inTotal, rInSecp, ctx,
        deriveOpeningNonce(rInSecp, ctx, `swapblind-${i}-v`),
        deriveOpeningNonce(rInSecp, ctx, `swapblind-${i}-r`),
      );

      intents.push({
        direction: t.direction,
        cInSecp: cInSecpBytes,
        cInBjj: t.cInBjj,
        minOut: BigInt(t.minOut),
        tipAmount: t.tip,
        rInSecp,
      });
      receipts.push({
        cOutSecp: cOutSecpBytes,
        cOutBjj: t.cOutBjj,
        outXcurveSigma: outXcurve,
        rangeProof: outRangeProof,
        rOutSecp,
      });
      fixtureIntents.push({
        direction: t.direction,
        inCx: inXY.cx, inCy: inXY.cy,
        inOwner: t.inNote.owner,
        inNk: t.inNote.nk,
        inLeafIndex: Number(t.inNote.leafIndex),
        inPath: t.inNote.path,
        cInBjj: bytesToHex(t.cInBjj),
        inXcurveSigma: bytesToHex(inXcurve),
        minOut: Number(t.minOut),
        deadline: Number(t.deadline ?? 0),
        tip: Number(t.tip),
        outCx: outXY.cx, outCy: outXY.cy,
        outOwner: t.outOwner,
        cOutBjj: bytesToHex(t.cOutBjj),
        outXcurveSigma: bytesToHex(outXcurve),
        outRangeProof: bytesToHex(outRangeProof),
        pokR: pok.R, pokZv: pok.zV, pokZr: pok.zR,
      });
    }

    const tipAAmount = filled.filter(t => t.direction === SWAP_DIR_A_TO_B).reduce((s, t) => s + t.tip, 0n);
    const tipBAmount = filled.filter(t => t.direction === SWAP_DIR_B_TO_A).reduce((s, t) => s + t.tip, 0n);
    const rTipA = randScalar(SECP_N), rTipB = randScalar(SECP_N);
    const tipACSecp = pointToBytes(pedersenCommit(tipAAmount, rTipA));
    const tipBCSecp = pointToBytes(pedersenCommit(tipBAmount, rTipB));

    const rNetFor = (assetXIsA, rTipX) => {
      let acc = 0n;
      for (let i = 0; i < filled.length; i++) {
        const dir = filled[i].direction;
        const isInput  = (assetXIsA && dir === SWAP_DIR_A_TO_B) || (!assetXIsA && dir === SWAP_DIR_B_TO_A);
        const isOutput = (assetXIsA && dir === SWAP_DIR_B_TO_A) || (!assetXIsA && dir === SWAP_DIR_A_TO_B);
        if (isInput)  acc = modN(acc + intents[i].rInSecp);
        if (isOutput) acc = modN(acc - receipts[i].rOutSecp);
      }
      return modN(acc - rTipX);
    };
    const kernelA = signAggregateKernel({ excess: rNetFor(true, rTipA), chainBinding, poolId: circuitPoolId, assetXIsA: true });
    const kernelB = signAggregateKernel({ excess: rNetFor(false, rTipB), chainBinding, poolId: circuitPoolId, assetXIsA: false });

    const envelope = {
      assetA, assetB, feeBps,
      protocolFeeBps: 0,
      protocolFeeRecipient: '0x' + '00'.repeat(33),
      reserveAPre: BigInt(reserveAPre), reserveBPre: BigInt(reserveBPre),
      ...deltas,
      kernelA, kernelB,
      tipAAmount, tipACSecp: bytesToHex(tipACSecp), rTipA: be32hex(rTipA),
      tipBAmount, tipBCSecp: bytesToHex(tipBCSecp), rTipB: be32hex(rTipB),
      nIntents: filled.length,
      proof: bytesToHex(proof),
      intents, receipts,
    };

    const reserveAPost = applySigned(reserveAPre, deltas.deltaANetSign, deltas.deltaANetMag);
    const reserveBPost = applySigned(reserveBPre, deltas.deltaBNetSign, deltas.deltaBNetMag);
    const evmPoolId = poolIdWithProtocolFee
      ? poolIdWithProtocolFee(assetA, assetB, feeBps, envelope.protocolFeeRecipient, 0)
      : null;

    const fixture = {
      note: 'OP_SWAP_BLIND prover-blind confidential AMM batch. Fields in exec-swapblind.rs read order.',
      chainBinding,
      spendRoot,
      assetA, assetB, feeBps,
      protocolFeeBps: 0,
      protocolFeeRecipient: envelope.protocolFeeRecipient,
      reserveAPre: Number(reserveAPre), reserveBPre: Number(reserveBPre),
      deltaANetSign: deltas.deltaANetSign, deltaANetMag: Number(deltas.deltaANetMag),
      deltaBNetSign: deltas.deltaBNetSign, deltaBNetMag: Number(deltas.deltaBNetMag),
      kernelA: envelope.kernelA, kernelB: envelope.kernelB,
      tipAAmount: Number(tipAAmount), tipACSecp: envelope.tipACSecp, rTipA: envelope.rTipA,
      tipBAmount: Number(tipBAmount), tipBCSecp: envelope.tipBCSecp, rTipB: envelope.rTipB,
      proof: envelope.proof,
      intents: fixtureIntents,
      expected: {
        poolId: evmPoolId,
        reserveAPost: Number(reserveAPost),
        reserveBPost: Number(reserveBPost),
      },
    };

    return { envelope, fixture };
  }

  function prepareInputLeg({ chainBinding, direction, amountIn, tip, inNote }) {
    const rInSecp = modN(BigInt(inNote.rSecp));
    const inTotal = BigInt(amountIn) + BigInt(tip ?? 0);
    const rInBJJ = randScalar(N_BJJ);
    const CinSecp = pedersenCommit(inTotal, rInSecp);
    const inXY = commitXY(inTotal, rInSecp);
    const CinBjj = pedersenBJJ(inTotal, rInBJJ);
    const inXcurve = proveXCurveDeterministic({
      a: inTotal, r_secp: rInSecp, r_BJJ: rInBJJ,
      C_secp: CinSecp, C_BJJ: CinBjj, seedKey: hexToBytes(chainBinding),
    }).proof;
    return {
      direction, amountIn: BigInt(amountIn), tip: BigInt(tip ?? 0), inTotal, rInBJJ,
      cInSecp: bytesToHex(pointToBytes(CinSecp)), cInBjj: bytesToHex(packPoint(CinBjj)),
      inXcurveSigma: bytesToHex(inXcurve),
      inCx: inXY.cx, inCy: inXY.cy, inOwner: inNote.owner, inNk: inNote.nk,
      inLeafIndex: Number(inNote.leafIndex), inPath: inNote.path,
      _rInSecp: rInSecp,
    };
  }

  function prepareOutputLeg({ chainBinding, assetA, assetB, inputLeg, amountOut, minOut, deadline, outOwner, rOutSecp = null }) {
    rOutSecp = rOutSecp != null ? modN(BigInt(rOutSecp)) : randScalar(SECP_N);
    const rOutBJJ = randScalar(N_BJJ);
    const CoutSecp = pedersenCommit(amountOut, rOutSecp);
    const outXY = commitXY(amountOut, rOutSecp);
    const CoutBjj = pedersenBJJ(amountOut, rOutBJJ);
    const outXcurve = proveXCurveDeterministic({
      a: amountOut, r_secp: rOutSecp, r_BJJ: rOutBJJ,
      C_secp: CoutSecp, C_BJJ: CoutBjj, seedKey: hexToBytes(chainBinding),
    }).proof;
    const outRangeProof = bppRangeProve([BigInt(amountOut)], [rOutSecp]).proof;
    const ctx = intentContext(
      SWAP_BLIND_INTENT_TAG, chainBinding, assetA, assetB,
      [[inputLeg.inCx, inputLeg.inCy, inputLeg.inOwner], [outXY.cx, outXY.cy, outOwner]],
      [BigInt(inputLeg.direction), BigInt(minOut), BigInt(deadline ?? 0), inputLeg.tip],
    );
    const pok = openingPokBlind(
      inputLeg.inTotal, inputLeg._rInSecp, ctx,
      deriveOpeningNonce(inputLeg._rInSecp, ctx, 'swapblind-leg-v'),
      deriveOpeningNonce(inputLeg._rInSecp, ctx, 'swapblind-leg-r'),
    );
    return {
      amountOut: BigInt(amountOut), minOut: BigInt(minOut), deadline: BigInt(deadline ?? 0), rOutBJJ,
      cOutSecp: bytesToHex(pointToBytes(CoutSecp)), cOutBjj: bytesToHex(packPoint(CoutBjj)),
      outXcurveSigma: bytesToHex(outXcurve), outRangeProof: bytesToHex(outRangeProof),
      outCx: outXY.cx, outCy: outXY.cy, outOwner,
      pokR: pok.R, pokZv: pok.zV, pokZr: pok.zR,
      _rOutSecp: rOutSecp,
    };
  }

  async function assembleSwapBlindFromLegs({ chainBinding, assetA, assetB, feeBps, reserveAPre, reserveBPre, spendRoot = null, legs, kernelA, kernelB, rTipA, rTipB }) {
    if (legs.length < 1 || legs.length > N_MAX) throw new Error('swap-blind: 1..16 intents');
    if (!(BigInt(assetA) < BigInt(assetB))) throw new Error('swap-blind: assets must be canonically ordered A<B');

    const circuitPoolId = ammDerivePoolIdV1(assetA, assetB, feeBps);
    const traders = legs.map((l) => ({
      direction: l.input.direction, amountIn: l.input.amountIn, tip: l.input.tip,
      minOut: l.output.minOut, deadline: l.output.deadline,
      rInBJJ: l.input.rInBJJ, rOutBJJ: l.output.rOutBJJ,
    }));
    const { input, filled, deltas } = buildSwapInput({
      poolIdFr: poolIdFr(circuitPoolId), R_A: reserveAPre, R_B: reserveBPre, fee_bps: feeBps, traders,
    });
    for (let i = 0; i < filled.length; i++) {
      if (filled[i].amountOut !== BigInt(legs[i].output.amountOut)) {
        throw new Error(`swap-blind: leg ${i} amountOut disagrees with the batch clearing price`);
      }
    }

    const proof = await proveGroth16({ input });
    if (!(proof instanceof Uint8Array) || proof.length !== 256) throw new Error('swap-blind: proof must be 256 bytes');

    const intents = legs.map((l) => ({
      direction: l.input.direction, cInSecp: hexToBytes(l.input.cInSecp), cInBjj: hexToBytes(l.input.cInBjj),
      minOut: BigInt(l.output.minOut), tipAmount: BigInt(l.input.tip),
    }));
    const receipts = legs.map((l) => ({
      cOutSecp: hexToBytes(l.output.cOutSecp), cOutBjj: hexToBytes(l.output.cOutBjj),
      outXcurveSigma: hexToBytes(l.output.outXcurveSigma), rangeProof: hexToBytes(l.output.outRangeProof),
    }));
    const fixtureIntents = legs.map((l) => ({
      direction: l.input.direction,
      inCx: l.input.inCx, inCy: l.input.inCy, inOwner: l.input.inOwner, inNk: l.input.inNk,
      inLeafIndex: l.input.inLeafIndex, inPath: l.input.inPath,
      cInBjj: l.input.cInBjj, inXcurveSigma: l.input.inXcurveSigma,
      minOut: Number(l.output.minOut), deadline: Number(l.output.deadline), tip: Number(l.input.tip),
      outCx: l.output.outCx, outCy: l.output.outCy, outOwner: l.output.outOwner,
      cOutBjj: l.output.cOutBjj, outXcurveSigma: l.output.outXcurveSigma,
      outRangeProof: l.output.outRangeProof,
      pokR: l.output.pokR, pokZv: l.output.pokZv, pokZr: l.output.pokZr,
    }));

    const tipAAmount = legs.filter((l) => l.input.direction === SWAP_DIR_A_TO_B).reduce((s, l) => s + BigInt(l.input.tip), 0n);
    const tipBAmount = legs.filter((l) => l.input.direction === SWAP_DIR_B_TO_A).reduce((s, l) => s + BigInt(l.input.tip), 0n);
    const rTipA_ = modN(BigInt(rTipA)), rTipB_ = modN(BigInt(rTipB));
    const tipACSecp = pointToBytes(pedersenCommit(tipAAmount, rTipA_));
    const tipBCSecp = pointToBytes(pedersenCommit(tipBAmount, rTipB_));

    const envelope = {
      assetA, assetB, feeBps,
      protocolFeeBps: 0,
      protocolFeeRecipient: '0x' + '00'.repeat(33),
      reserveAPre: BigInt(reserveAPre), reserveBPre: BigInt(reserveBPre),
      ...deltas,
      kernelA, kernelB,
      tipAAmount, tipACSecp: bytesToHex(tipACSecp), rTipA: be32hex(rTipA_),
      tipBAmount, tipBCSecp: bytesToHex(tipBCSecp), rTipB: be32hex(rTipB_),
      nIntents: legs.length,
      proof: bytesToHex(proof),
      intents, receipts,
    };
    const reserveAPost = applySigned(reserveAPre, deltas.deltaANetSign, deltas.deltaANetMag);
    const reserveBPost = applySigned(reserveBPre, deltas.deltaBNetSign, deltas.deltaBNetMag);
    const evmPoolId = poolIdWithProtocolFee
      ? poolIdWithProtocolFee(assetA, assetB, feeBps, envelope.protocolFeeRecipient, 0)
      : null;

    const fixture = {
      note: 'OP_SWAP_BLIND prover-blind confidential AMM batch (2-party leg path). Fields in exec-swapblind.rs read order.',
      chainBinding, spendRoot,
      assetA, assetB, feeBps,
      protocolFeeBps: 0,
      protocolFeeRecipient: envelope.protocolFeeRecipient,
      reserveAPre: Number(reserveAPre), reserveBPre: Number(reserveBPre),
      deltaANetSign: deltas.deltaANetSign, deltaANetMag: Number(deltas.deltaANetMag),
      deltaBNetSign: deltas.deltaBNetSign, deltaBNetMag: Number(deltas.deltaBNetMag),
      kernelA: envelope.kernelA, kernelB: envelope.kernelB,
      tipAAmount: Number(tipAAmount), tipACSecp: envelope.tipACSecp, rTipA: envelope.rTipA,
      tipBAmount: Number(tipBAmount), tipBCSecp: envelope.tipBCSecp, rTipB: envelope.rTipB,
      proof: envelope.proof,
      intents: fixtureIntents,
      expected: { poolId: evmPoolId, reserveAPost: Number(reserveAPost), reserveBPost: Number(reserveBPost) },
    };

    return {
      envelope, fixture, deltas, tipAAmount, tipBAmount, circuitPoolId,
      fixtureIntents, evmPoolId, reserveAPost, reserveBPost,
    };
  }

  return {
    buildSwapBlindOp, buildSwapInput,
    prepareInputLeg, prepareOutputLeg, assembleSwapBlindFromLegs,
  };
}
