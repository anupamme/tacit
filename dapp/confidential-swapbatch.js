
import { unpackPoint, P_FR, mod } from './amm-bjj.js';
import { verifyXCurve } from './amm-sigma.js';
import { sha256 } from './vendor/tacit-deps.min.js';
import { verifySchnorr, bpRangeVerify, bpClassicProofLen } from './bulletproofs.js';
import { bppRangeVerify, bytesToPoint as bppPoint } from './bulletproofs-plus.js';

const N_MAX = 16;
const AMM_INTENT_DOM = new TextEncoder().encode('tacit-amm-intent-v1');
const u16leB = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, Number(n) & 0xffff, true); return b; };
const u32leB = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64leB = (n) => { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, Number(BigInt(n) & 0xffffffffn), true); v.setUint32(4, Number((BigInt(n) >> 32n) & 0xffffffffn), true); return b; };
const catB = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
const spkB = (spk) => (!spk ? new Uint8Array(0) : (typeof spk === 'string' ? hu8(spk) : spk));
export function swapBatchIntentMsg(a) {
  return sha256(catB([
    AMM_INTENT_DOM, hu8(a.poolId), Uint8Array.of(a.direction & 0xff), Uint8Array.of(a.inputOutpoints.length & 0xff),
    ...a.inputOutpoints.flatMap(([txid, vout]) => [hu8(txid), u32leB(vout)]),
    hu8(a.cInSecp), hu8(a.cInBjj), hu8(a.inXcurveSigma), u16leB(spkB(a.receiveSpk).length), spkB(a.receiveSpk),
    u64leB(a.minOut), u64leB(a.tipAmount), Uint8Array.of(a.tipAsset & 0xff), u32leB(a.expiryHeight),
    hu8(a.traderPubkey), u16leB(spkB(a.refundSpk).length), spkB(a.refundSpk),
  ]));
}
export function assertBatchAnonymitySet({ nIntents, acknowledgeSingleIntent = false } = {}) {
  const n = Number(nIntents);
  if (!Number.isInteger(n) || n < 1 || n > N_MAX) throw new Error(`swap batch: n_intents must be 1..${N_MAX}`);
  if (n === 1 && !acknowledgeSingleIntent) {
    throw new Error('swap batch: a single-intent batch is not confidential — the envelope\'s cleartext net '
      + 'reserve deltas are that trader\'s exact amount in and amount out. Batch it with other intents, or '
      + 'pass acknowledgeSingleIntent to trade transparently on purpose.');
  }
  return n;
}

const batchIntentSigOk = (sigHex, msg32, traderPubkeyHex) => {
  const pk = hu8(traderPubkeyHex); if (pk.length !== 33) return false;
  try { return verifySchnorr(hu8(sigHex), msg32, pk.slice(1, 33)); } catch { return false; }
};
const ZERO_ADDR33 = '0x' + '00'.repeat(33);
const ZERO_OWNER = '0x' + '00'.repeat(32);
const U64_MAX = (1n << 64n) - 1n;
const norm = (x) => String(x).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hu8 = (h) => { const s = String(h).replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };
const receiptRangeOk = (cOutSecpHex, rangeProofHex) => {
  const cBytes = hu8(cOutSecpHex);
  const rp = hu8(rangeProofHex);
  try {
    return rp.length === bpClassicProofLen(1)
      ? bpRangeVerify([cBytes], rp)
      : bppRangeVerify([bppPoint(cBytes)], rp);
  } catch { return false; }
};
function applySigned(reserve, sign, mag) {
  if (Number(sign) === 0) { const v = reserve + mag; return v > U64_MAX ? null : v; }
  return reserve < mag ? null : reserve - mag;
}
const bytesToBig = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const hb32 = (h) => { const s = String(h).replace(/^0x/, '').padStart(64, '0'); const o = new Uint8Array(32); for (let i = 0; i < 32; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };

export function swapBatchPublicSignals(env, poolIdHex, reserveA, reserveB) {
  const ni = env.nIntents;
  if (ni < 1 || ni > N_MAX || env.intents.length !== ni || env.receipts.length !== ni) return null;
  const s = [
    mod(bytesToBig(sha256(hb32(poolIdHex))), P_FR),
    BigInt(reserveA), BigInt(reserveB),
    BigInt(env.deltaANetSign), BigInt(env.deltaANetMag),
    BigInt(env.deltaBNetSign), BigInt(env.deltaBNetMag),
    BigInt(env.tipAAmount), BigInt(env.tipBAmount),
    BigInt(env.feeBps), BigInt(ni),
  ];
  const direction = Array(N_MAX).fill(0n);
  const cInU = Array(N_MAX).fill(0n), cInV = Array(N_MAX).fill(1n);
  const minOut = Array(N_MAX).fill(0n), tip = Array(N_MAX).fill(0n);
  const cOutU = Array(N_MAX).fill(0n), cOutV = Array(N_MAX).fill(1n);
  for (let i = 0; i < ni; i++) {
    const it = env.intents[i];
    direction[i] = BigInt(it.direction);
    const cin = unpackPoint(hb32(it.cInBjj)); if (!cin) return null;
    cInU[i] = cin[0]; cInV[i] = cin[1];
    minOut[i] = BigInt(it.minOut); tip[i] = BigInt(it.tipAmount);
    const cout = unpackPoint(hb32(env.receipts[i].cOutBjj)); if (!cout) return null;
    cOutU[i] = cout[0]; cOutV[i] = cout[1];
  }
  for (const arr of [direction, cInU, cInV, minOut, tip, cOutU, cOutV]) for (const x of arr) s.push(x);
  return s.length === 123 ? s : null;
}

const be32dec = (b, o) => { let v = 0n; for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(b[o + i]); return v.toString(); };
const BN254_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const be32big = (b, o) => { let v = 0n; for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(b[o + i]); return v; };
export function parseGroth16Proof256(proofBytes) {
  const b = proofBytes instanceof Uint8Array ? proofBytes : hb32Var(proofBytes);
  if (!(b instanceof Uint8Array) || b.length !== 256) return null;
  for (let o = 0; o < 256; o += 32) if (be32big(b, o) >= BN254_Q) return null;
  const isZero64 = (o) => be32big(b, o) === 0n && be32big(b, o + 32) === 0n;
  if (isZero64(0) || isZero64(192)) return null;
  return {
    pi_a: [be32dec(b, 0), be32dec(b, 32), '1'],
    pi_b: [[be32dec(b, 64), be32dec(b, 96)], [be32dec(b, 128), be32dec(b, 160)], ['1', '0']],
    pi_c: [be32dec(b, 192), be32dec(b, 224), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}
const hb32Var = (h) => { const s = String(h).replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };

const be32enc = (dec) => { let v = BigInt(dec); const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } if (v !== 0n) throw new Error('field element overflows 32 bytes'); return o; };
export function serializeGroth16Proof256(proof) {
  if (!proof || proof.protocol !== 'groth16') throw new Error('not a groth16 proof');
  const out = new Uint8Array(256);
  out.set(be32enc(proof.pi_a[0]), 0);
  out.set(be32enc(proof.pi_a[1]), 32);
  out.set(be32enc(proof.pi_b[0][0]), 64);
  out.set(be32enc(proof.pi_b[0][1]), 96);
  out.set(be32enc(proof.pi_b[1][0]), 128);
  out.set(be32enc(proof.pi_b[1][1]), 160);
  out.set(be32enc(proof.pi_c[0]), 192);
  out.set(be32enc(proof.pi_c[1]), 224);
  return out;
}

export async function swapBatchGroth16Prove(input, wasm, zkey) {
  const sjs = await import('snarkjs');
  const groth16 = sjs.groth16 || (sjs.default && sjs.default.groth16);
  if (!groth16 || typeof groth16.fullProve !== 'function') throw new Error('snarkjs.groth16.fullProve unavailable');
  const { proof, publicSignals } = await groth16.fullProve(input, wasm, zkey);
  return { proofBytes: serializeGroth16Proof256(proof), publicSignals };
}

export async function swapBatchGroth16Verify(vk, publicsBigInt, proofBytes) {
  const proof = parseGroth16Proof256(proofBytes);
  if (!proof || !Array.isArray(publicsBigInt)) return false;
  const publics = publicsBigInt.map((x) => BigInt(x).toString());
  const sjs = await import('snarkjs');
  const groth16 = sjs.groth16 || (sjs.default && sjs.default.groth16);
  if (!groth16 || typeof groth16.verify !== 'function') throw new Error('snarkjs.groth16.verify unavailable');
  return groth16.verify(vk, publics, proof);
}

async function defaultSwapBatchVerify(vk, env, poolIdHex, reserveA, reserveB) {
  const publics = swapBatchPublicSignals(env, poolIdHex, reserveA, reserveB);
  if (!publics) return false;
  return swapBatchGroth16Verify(vk, publics, env.proof);
}
function feeClearingFloorOk(rIn, inAmt, newOut, kPre, feeBps) {
  return newOut * (rIn * 10000n + inAmt * (10000n - BigInt(feeBps))) >= kPre * 10000n;
}
const authZeroBatch = (a) => !a || norm(a) === norm(ZERO_OWNER);

export async function foldSwapBatch(pool, state, env, txidHex, spends, { vk, verify = defaultSwapBatchVerify, receiptSpks = [], refundSpks = [], height = 0n } = {}) {
  const ni = env.nIntents;
  if (env.intents.length !== ni || env.receipts.length !== ni) return null;
  const receiptAuths = receiptSpks.map((s) => pool.p2trXonly(s));
  const refundAuths = refundSpks.map((s) => pool.p2trXonly(s));
  {
    const seen = new Set();
    for (const a of refundAuths) {
      if (!a) continue;
      const k = String(a).replace(/^0x/, '').toLowerCase();
      if (seen.has(k)) throw new Error('swap-batch: two intents share a refund key — both refunds would hash to the same leaf and nullifier, so only one could ever be spent');
      seen.add(k);
    }
  }
  const peekN = () => Array.from({ length: ni }, () => state.notePathPeek());
  const [aLo, aHi] = pool.ammCanonicalPair(env.assetA, env.assetB);
  if (!aLo) return null;
  if (Number(env.feeBps) > 1000) return null;
  const poolId = pool.ammDerivePoolIdFull(aLo, aHi, env.feeBps, 0, ZERO_ADDR33, 0);
  if (!poolId) return null;
  const p = state.pools.get(poolId);
  if (!p || !p.c0Backed) return null;
  if (norm(env.assetA) !== norm(p.assetA) || norm(env.assetB) !== norm(p.assetB)) return null;

  const intentInAssets = [];
  const used = new Array(spends.length).fill(false);
  let anyExpired = false;
  for (let i = 0; i < ni; i++) {
    const it = env.intents[i];
    if (Number(it.direction) > 1) return null;
    const expectedAsset = Number(it.direction) === 0 ? p.assetA : p.assetB;
    let cin; try { cin = pool.decompressCommitment(it.cInSecp); } catch { return null; }
    let matched = -1;
    for (let j = 0; j < spends.length; j++) {
      if (used[j]) continue;
      if (norm(spends[j].asset || ZERO_OWNER) !== norm(expectedAsset)) continue;
      if (norm(spends[j].cx) !== norm(cin.cx) || norm(spends[j].cy) !== norm(cin.cy)) continue;
      const msg = swapBatchIntentMsg({
        poolId, direction: it.direction, inputOutpoints: [spends[j].outpoint], cInSecp: it.cInSecp,
        cInBjj: it.cInBjj, inXcurveSigma: it.inXcurveSigma, receiveSpk: receiptSpks[i], minOut: it.minOut,
        tipAmount: it.tipAmount, tipAsset: it.direction, expiryHeight: it.expiryHeight, traderPubkey: it.traderPubkey,
        refundSpk: refundSpks[i],
      });
      if (batchIntentSigOk(it.intentSig, msg, it.traderPubkey)) { matched = j; break; }
    }
    if (matched < 0) return null;
    used[matched] = true;
    intentInAssets.push(expectedAsset);
    if (!verifyXCurve(hu8(it.inXcurveSigma), hu8(it.cInSecp), hu8(it.cInBjj))) return null;
    if (BigInt(it.expiryHeight || 0) === 0n || BigInt(it.expiryHeight) < BigInt(height)) anyExpired = true;
    if (authZeroBatch(receiptAuths[i])) return null;
    if (authZeroBatch(refundAuths[i])) return null;
  }
  const unclaimedSpend = used.some((u) => !u);

  const onboardRefunds = () => {
    const refundPaths = [];
    for (let i = 0; i < ni; i++) {
      const asset = intentInAssets[i];
      const { cx, cy } = pool.decompressCommitment(env.intents[i].cInSecp);
      const w = state.foldOutput(pool.btcNoteLeaf(asset, cx, cy, refundAuths[i]), pool.outpointKey(txidHex, ni + 1 + i), pool.commitmentHash(cx, cy), asset, refundAuths[i]);
      refundPaths.push(w.notePath);
    }
    return { receiptPaths: peekN(), refundPaths };
  };
  for (let i = 0; i < ni; i++) {
    if (!verifyXCurve(hu8(env.receipts[i].outXcurveSigma), hu8(env.receipts[i].cOutSecp), hu8(env.receipts[i].cOutBjj))) return onboardRefunds();
    if (!receiptRangeOk(env.receipts[i].cOutSecp, env.receipts[i].rangeProof)) return onboardRefunds();
  }
  if (anyExpired || unclaimedSpend) return onboardRefunds();

  const newA = applySigned(BigInt(p.reserveA), env.deltaANetSign, BigInt(env.deltaANetMag));
  const newB = applySigned(BigInt(p.reserveB), env.deltaBNetSign, BigInt(env.deltaBNetMag));
  if (newA === null || newB === null) return onboardRefunds();
  if (newA === 0n || newB === 0n) return onboardRefunds();
  const kPre = BigInt(p.reserveA) * BigInt(p.reserveB);
  if (newA * newB < kPre) return onboardRefunds();
  let oneSided = null;
  if (Number(env.deltaANetSign) === 0 && Number(env.deltaBNetSign) === 1) oneSided = [BigInt(p.reserveA), BigInt(env.deltaANetMag), newB];
  else if (Number(env.deltaBNetSign) === 0 && Number(env.deltaANetSign) === 1) oneSided = [BigInt(p.reserveB), BigInt(env.deltaBNetMag), newA];
  if (oneSided && !feeClearingFloorOk(oneSided[0], oneSided[1], oneSided[2], kPre, env.feeBps)) return onboardRefunds();
  let groth16Ok = false;
  try { groth16Ok = await verify(vk, env, poolId, p.reserveA, p.reserveB); } catch { return onboardRefunds(); }
  if (!groth16Ok) return onboardRefunds();
  let tipsOpen = false;
  try {
    tipsOpen = pool.verifyPedersenOpening(env.tipACSecp, BigInt(env.tipAAmount), env.rTipA)
      && pool.verifyPedersenOpening(env.tipBCSecp, BigInt(env.tipBAmount), env.rTipB);
  } catch { tipsOpen = false; }
  if (!tipsOpen) return onboardRefunds();
  const intentsSecp = env.intents.map((it) => ({ direction: Number(it.direction), cInSecp: it.cInSecp }));
  const receiptsSecp = env.receipts.map((r) => r.cOutSecp);
  if (!pool.swapBatchAggregateIdentity(intentsSecp, receiptsSecp, true, env.deltaANetSign, BigInt(env.deltaANetMag), env.tipACSecp, env.rNetA)) return onboardRefunds();
  if (!pool.swapBatchAggregateIdentity(intentsSecp, receiptsSecp, false, env.deltaBNetSign, BigInt(env.deltaBNetMag), env.tipBCSecp, env.rNetB)) return onboardRefunds();

  const receiptPaths = [];
  for (let i = 0; i < ni; i++) {
    const outAsset = Number(env.intents[i].direction) === 0 ? p.assetB : p.assetA;
    const { cx, cy } = pool.decompressCommitment(env.receipts[i].cOutSecp);
    const w = state.foldOutput(pool.btcNoteLeaf(outAsset, cx, cy, receiptAuths[i]), pool.outpointKey(txidHex, i + 1), pool.commitmentHash(cx, cy), outAsset, receiptAuths[i]);
    receiptPaths.push(w.notePath);
  }
  state.pools.set(poolId, { ...p, reserveA: newA, reserveB: newB });
  return { receiptPaths, refundPaths: peekN() };
}
