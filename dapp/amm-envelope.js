
import { concatBytes, hexToBytes, sha256, keccak_256, secp } from './vendor/tacit-deps.min.js';
import { XCURVE_PROOF_LEN } from './amm-sigma.js';

const _SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const _FARM_RECEIPT_DOM = new TextEncoder().encode('tacit-farm-receipt-v3');
const _LP_HARVEST_OWNER_DOM = new TextEncoder().encode('tacit-farm-harvest-owner-v1');
const _LP_UNBOND_OWNER_DOM = new TextEncoder().encode('tacit-farm-unbond-owner-v1');
const _FARM_OWNER_KEY_DOM = new TextEncoder().encode('tacit-farm-owner-key-v1');
function _u128LE(n) { const b = new Uint8Array(16); let x = BigInt(n); for (let i = 0; i < 16; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; }
function _u64BE(n) { const b = new Uint8Array(8); let x = BigInt(n); for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; }
function _u32BE(n) { const b = new Uint8Array(4); let x = BigInt(n); for (let i = 3; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; }
function _spk(s) { return s == null ? new Uint8Array(0) : (s instanceof Uint8Array ? s : hexToBytes(String(s).replace(/^0x/, ''))); }
function _scalar32(d) { const b = new Uint8Array(32); let x = d; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; }

export function farmReceiptLeaf({ farmId, lpAsset, shares, owner, nonce }) {
  return keccak_256(concatBytes(_FARM_RECEIPT_DOM, asBytes(farmId, 32, 'farmId'), asBytes(lpAsset, 32, 'lpAsset'), u64LE(shares), asBytes(owner, 32, 'owner'), asBytes(nonce, 32, 'nonce')));
}
export function lpHarvestOwnerMsg({ farmId, oldLeaf, reward, rewardR, destSpk }) {
  return keccak_256(concatBytes(_LP_HARVEST_OWNER_DOM, asBytes(farmId, 32, 'farmId'), asBytes(oldLeaf, 32, 'oldLeaf'), _u64BE(reward), asBytes(rewardR, 32, 'rewardR'), _spk(destSpk)));
}
export function lpUnbondOwnerMsg({ farmId, oldLeaf, shares, lpReturnR, destSpk }) {
  return keccak_256(concatBytes(_LP_UNBOND_OWNER_DOM, asBytes(farmId, 32, 'farmId'), asBytes(oldLeaf, 32, 'oldLeaf'), _u64BE(shares), asBytes(lpReturnR, 32, 'lpReturnR'), _spk(destSpk)));
}
export function deriveFarmOwnerKey({ walletPriv, farmId, nonce }) {
  const seed = keccak_256(concatBytes(_FARM_OWNER_KEY_DOM, asBytes(walletPriv, 32, 'walletPriv'), asBytes(farmId, 32, 'farmId'), asBytes(nonce, 32, 'nonce')));
  let d = BigInt('0x' + [...seed].map((b) => b.toString(16).padStart(2, '0')).join('')) % _SECP_N;
  if (d === 0n) d = 1n;
  return { priv: _scalar32(d), ownerXonly: secp.ProjectivePoint.BASE.multiply(d).toRawBytes(true).slice(1) };
}

export const OPCODE_T_LP_ADD     = 0x2D;
export const OPCODE_T_LP_REMOVE  = 0x2E;
export const OPCODE_T_PROTOCOL_FEE_CLAIM = 0x31;
export const FEE_BPS_MAX           = 1000;
export const PROTOCOL_FEE_BPS_MAX  = 1000;
export const PROTOCOL_FEE_ADDRESS_ZERO = new Uint8Array(33);

const _PROTOCOL_FEE_CLAIM_DOMAIN = new TextEncoder().encode('tacit-amm-protocol-fee-claim-v1');

function asBytes(x, len, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes`);
  return b;
}
function u16LE(n) {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, n & 0xffff, true);
  return buf;
}
function u64LE(n) {
  const buf = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n || x >= 1n << 64n) throw new Error('u64 overflow');
  for (let i = 0; i < 8; i++) { buf[i] = Number(x & 0xffn); x >>= 8n; }
  return buf;
}
function isZeroAddress(b) {
  if (b.length !== 33) return false;
  for (let i = 0; i < 33; i++) if (b[i] !== 0) return false;
  return true;
}

export function buildProtocolFeeClaimMsg({ poolIdBytes, claimAmount, claimCSecpBytes, claimBlindingBytes, destSpk }) {
  const poolId = asBytes(poolIdBytes, 32, 'poolIdBytes');
  const claimCSecp = asBytes(claimCSecpBytes, 33, 'claimCSecpBytes');
  const claimBlinding = asBytes(claimBlindingBytes, 32, 'claimBlindingBytes');
  return keccak_256(concatBytes(
    _PROTOCOL_FEE_CLAIM_DOMAIN,
    poolId, _u64BE(claimAmount), claimCSecp, claimBlinding, _spk(destSpk),
  ));
}

export function encodeProtocolFeeClaim(args) {
  const poolId = asBytes(args.poolId, 32, 'poolId');
  const claimerPubkey = asBytes(args.claimerPubkey, 33, 'claimerPubkey');
  const feeBps = args.feeBps >>> 0;
  const claimCSecp = asBytes(args.claimCSecp, 33, 'claimCSecp');
  const claimBlinding = asBytes(args.claimBlinding, 32, 'claimBlinding');
  const claimSig = asBytes(args.claimSig, 64, 'claimSig');
  const amt = BigInt(args.claimAmount);
  if (amt <= 0n || amt >= 1n << 64n) throw new Error('claim_amount out of u64+ range');
  return concatBytes(
    new Uint8Array([OPCODE_T_PROTOCOL_FEE_CLAIM]),
    poolId, claimerPubkey, u32LE(feeBps), u64LE(amt), claimCSecp, claimBlinding, claimSig,
  );
}

export function decodeProtocolFeeClaim(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length !== 207) return null;
  if (payload[0] !== OPCODE_T_PROTOCOL_FEE_CLAIM) return null;
  const poolId = payload.slice(1, 33);
  const claimerPubkey = payload.slice(33, 66);
  const feeBps = new DataView(payload.buffer, payload.byteOffset + 66, 4).getUint32(0, true);
  let amt = 0n;
  for (let i = 0; i < 8; i++) amt |= BigInt(payload[70 + i]) << BigInt(i * 8);
  const claimCSecp = payload.slice(78, 111);
  const claimBlinding = payload.slice(111, 143);
  const claimSig = payload.slice(143, 207);
  return { poolId, claimerPubkey, feeBps, claimAmount: amt, claimCSecp, claimBlinding, claimSig };
}

export function encodeLpRemove(args) {
  const parts = [
    new Uint8Array([OPCODE_T_LP_REMOVE]),
    asBytes(args.assetA, 32, 'assetA'),
    asBytes(args.assetB, 32, 'assetB'),
    u64LE(args.shareAmount),
    u64LE(args.deltaA),
    u64LE(args.deltaB),
    asBytes(args.recvACSecp, 33, 'recvACSecp'),
    asBytes(args.recvACBJJ, 32, 'recvACBJJ'),
    asBytes(args.recvAXcurveSigma, XCURVE_PROOF_LEN, 'recvAXcurveSigma'),
    asBytes(args.recvBCSecp, 33, 'recvBCSecp'),
    asBytes(args.recvBCBJJ, 32, 'recvBCBJJ'),
    asBytes(args.recvBXcurveSigma, XCURVE_PROOF_LEN, 'recvBXcurveSigma'),
    asBytes(args.kernelSigLP, 64, 'kernelSigLP'),
    asBytes(args.rRecvA, 32, 'rRecvA'),
    asBytes(args.rRecvB, 32, 'rRecvB'),
  ];
  const proof = args.proof;
  if (!(proof instanceof Uint8Array)) throw new Error('proof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('proof too large');
  parts.push(u16LE(proof.length), proof);
  return concatBytes(...parts);
}

export function encodeLpAdd(args) {
  const variant = args.variant;
  if (variant !== 0 && variant !== 1) throw new Error('variant must be 0 or 1');

  const parts = [
    new Uint8Array([OPCODE_T_LP_ADD, variant]),
    asBytes(args.assetA, 32, 'assetA'),
    asBytes(args.assetB, 32, 'assetB'),
    u64LE(args.deltaA),
    u64LE(args.deltaB),
    u64LE(args.shareAmount),
    asBytes(args.shareCSecp, 33, 'shareCSecp'),
    asBytes(args.shareCBJJ, 32, 'shareCBJJ'),
    asBytes(args.shareXcurveSigma, XCURVE_PROOF_LEN, 'shareXcurveSigma'),
    asBytes(args.kernelSigA, 64, 'kernelSigA'),
    asBytes(args.kernelSigB, 64, 'kernelSigB'),
    asBytes(args.shareR, 32, 'shareR'),
  ];

  if (variant === 1) {
    if (typeof args.feeBps !== 'number' || args.feeBps < 0 || args.feeBps > FEE_BPS_MAX) {
      throw new Error(`feeBps must be 0..${FEE_BPS_MAX}`);
    }
    parts.push(u16LE(args.feeBps));
    const vkBytes = new TextEncoder().encode(args.vkCid);
    if (vkBytes.length < 1 || vkBytes.length > 64) throw new Error('vkCid length 1..64 bytes');
    parts.push(new Uint8Array([vkBytes.length]), vkBytes);
    const cerBytes = new TextEncoder().encode(args.ceremonyCid);
    if (cerBytes.length < 1 || cerBytes.length > 64) throw new Error('ceremonyCid length 1..64 bytes');
    parts.push(new Uint8Array([cerBytes.length]), cerBytes);
    const arb = args.arbiterPubkeys || [];
    if (arb.length > 16) throw new Error('arbiterPubkeys count 0..16');
    const arbM = args.arbiterThresholdM ?? (arb.length > 0 ? 1 : 0);
    if (arb.length === 0 && arbM !== 0) {
      throw new Error('arbiterThresholdM must be 0 when no arbiter pubkeys pinned');
    }
    if (arb.length > 0 && (arbM < 1 || arbM > arb.length)) {
      throw new Error(`arbiterThresholdM must be 1..${arb.length}`);
    }
    parts.push(new Uint8Array([arb.length, arbM]));
    for (const pk of arb) parts.push(asBytes(pk, 33, 'arbiterPubkey'));
    const lsigs = args.launcherSigs || [];
    if (lsigs.length > 2) throw new Error('launcherSigs count 0..2');
    parts.push(new Uint8Array([lsigs.length]));
    for (const sig of lsigs) parts.push(asBytes(sig, 64, 'launcherSig'));
    const protoAddr = args.protocolFeeAddress || PROTOCOL_FEE_ADDRESS_ZERO;
    parts.push(asBytes(protoAddr, 33, 'protocolFeeAddress'));
    const protoBps = args.protocolFeeBps || 0;
    if (typeof protoBps !== 'number' || protoBps < 0 || protoBps > PROTOCOL_FEE_BPS_MAX) {
      throw new Error(`protocolFeeBps must be 0..${PROTOCOL_FEE_BPS_MAX}`);
    }
    if (protoBps > 0 && isZeroAddress(protoAddr)) {
      throw new Error('protocolFeeBps > 0 requires non-zero protocolFeeAddress');
    }
    if (!isZeroAddress(protoAddr) && protoBps === 0) {
      throw new Error('non-zero protocolFeeAddress requires protocolFeeBps > 0');
    }
    parts.push(u16LE(protoBps));
    const metaUri = args.poolMetaUri ?? '';
    const metaBytes = new TextEncoder().encode(metaUri);
    if (metaBytes.length > 255) throw new Error('poolMetaUri length must be 0..255 bytes');
    parts.push(new Uint8Array([metaBytes.length]), metaBytes);
    const capFlags = args.poolCapabilityFlags ?? 0;
    if (capFlags < 0 || capFlags > 0xff) throw new Error('poolCapabilityFlags must be u8');
    if (capFlags !== 0) {
      throw new Error(`poolCapabilityFlags must be 0x00 for V1 pools (the byte is reserved in pool_id derivation for forward extensions)`);
    }
    parts.push(new Uint8Array([capFlags]));
    const initExp = new Uint8Array(4);
    new DataView(initExp.buffer).setUint32(0, (args.expiryHeight >>> 0), true);
    parts.push(initExp);
    parts.push(asBytes(args.refundABlinding, 32, 'refundABlinding'));
    parts.push(asBytes(args.refundBBlinding, 32, 'refundBBlinding'));
  } else {
    const exp = new Uint8Array(4);
    new DataView(exp.buffer).setUint32(0, (args.expiryHeight >>> 0), true);
    parts.push(exp);
    parts.push(asBytes(args.refundABlinding, 32, 'refundABlinding'));
    parts.push(asBytes(args.refundBBlinding, 32, 'refundBBlinding'));
  }

  return concatBytes(...parts);
}

function _readU16LE(b, off) {
  return new DataView(b.buffer, b.byteOffset).getUint16(off, true);
}
function _readU64LE(b, off) {
  const dv = new DataView(b.buffer, b.byteOffset);
  return (BigInt(dv.getUint32(off + 4, true)) << 32n) | BigInt(dv.getUint32(off, true));
}
const _utf8 = new TextDecoder();

export function decodeLpAdd(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length < 2 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + 169 + 64 + 64 + 32 + 2) return null;
  if (payload[0] !== OPCODE_T_LP_ADD) return null;
  const variant = payload[1];
  if (variant !== 0 && variant !== 1) return null;
  let off = 2;
  try {
    const assetA = payload.slice(off, off + 32); off += 32;
    const assetB = payload.slice(off, off + 32); off += 32;
    const deltaA = _readU64LE(payload, off); off += 8;
    const deltaB = _readU64LE(payload, off); off += 8;
    const shareAmount = _readU64LE(payload, off); off += 8;
    const shareCSecp = payload.slice(off, off + 33); off += 33;
    const shareCBJJ = payload.slice(off, off + 32); off += 32;
    const shareXcurveSigma = payload.slice(off, off + XCURVE_PROOF_LEN);
    off += XCURVE_PROOF_LEN + 64 + 64;
    const shareR = payload.slice(off, off + 32); off += 32;
    const result = { variant, assetA, assetB, deltaA, deltaB, shareAmount, shareCSecp, shareCBJJ, shareXcurveSigma, shareR };
    if (variant === 1) {
      if (off + 2 > payload.length) return null;
      result.feeBps = _readU16LE(payload, off); off += 2;
      if (result.feeBps > FEE_BPS_MAX) return null;
      if (off + 1 > payload.length) return null;
      const vkLen = payload[off++];
      if (vkLen < 1 || vkLen > 64) return null;
      if (off + vkLen > payload.length) return null;
      result.vkCid = _utf8.decode(payload.slice(off, off + vkLen)); off += vkLen;
      if (off + 1 > payload.length) return null;
      const cerLen = payload[off++];
      if (cerLen < 1 || cerLen > 64) return null;
      if (off + cerLen > payload.length) return null;
      result.ceremonyCid = _utf8.decode(payload.slice(off, off + cerLen)); off += cerLen;
      if (off + 2 > payload.length) return null;
      const arbCount = payload[off++];
      if (arbCount > 16) return null;
      result.arbiterThresholdM = payload[off++];
      result.arbiterPubkeys = [];
      if (off + arbCount * 33 > payload.length) return null;
      for (let i = 0; i < arbCount; i++) { result.arbiterPubkeys.push(payload.slice(off, off + 33)); off += 33; }
      if (off + 1 > payload.length) return null;
      const lsigCount = payload[off++];
      if (lsigCount > 2) return null;
      if (off + lsigCount * 64 > payload.length) return null;
      result.launcherSigs = [];
      for (let i = 0; i < lsigCount; i++) { result.launcherSigs.push(payload.slice(off, off + 64)); off += 64; }
      if (off + 33 > payload.length) return null;
      result.protocolFeeAddress = payload.slice(off, off + 33); off += 33;
      if (off + 2 > payload.length) return null;
      result.protocolFeeBps = _readU16LE(payload, off); off += 2;
      if (result.protocolFeeBps > PROTOCOL_FEE_BPS_MAX) return null;
      if (off + 1 > payload.length) return null;
      const metaLen = payload[off++];
      if (off + metaLen > payload.length) return null;
      result.poolMetaUri = _utf8.decode(payload.slice(off, off + metaLen)); off += metaLen;
      if (off + 1 > payload.length) return null;
      result.poolCapabilityFlags = payload[off++];
      if (off + 4 + 32 + 32 > payload.length) return null;
      result.expiryHeight = new DataView(payload.buffer, payload.byteOffset).getUint32(off, true); off += 4;
      result.refundABlinding = payload.slice(off, off + 32); off += 32;
      result.refundBBlinding = payload.slice(off, off + 32); off += 32;
    } else {
      if (off + 4 + 32 + 32 > payload.length) return null;
      result.expiryHeight = new DataView(payload.buffer, payload.byteOffset).getUint32(off, true); off += 4;
      result.refundABlinding = payload.slice(off, off + 32); off += 32;
      result.refundBBlinding = payload.slice(off, off + 32); off += 32;
    }
    return result;
  } catch { return null; }
}

export function decodeLpRemove(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  const minLen = 1 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + 169 + 33 + 32 + 169 + 64 + 32 + 32 + 2;
  if (payload.length < minLen) return null;
  if (payload[0] !== OPCODE_T_LP_REMOVE) return null;
  let off = 1;
  try {
    const assetA = payload.slice(off, off + 32); off += 32;
    const assetB = payload.slice(off, off + 32); off += 32;
    const shareAmount = _readU64LE(payload, off); off += 8;
    const deltaA = _readU64LE(payload, off); off += 8;
    const deltaB = _readU64LE(payload, off); off += 8;
    const recvACSecp = payload.slice(off, off + 33); off += 33;
    const recvACBJJ = payload.slice(off, off + 32); off += 32;
    const recvAXcurveSigma = payload.slice(off, off + XCURVE_PROOF_LEN); off += XCURVE_PROOF_LEN;
    const recvBCSecp = payload.slice(off, off + 33); off += 33;
    const recvBCBJJ = payload.slice(off, off + 32); off += 32;
    const recvBXcurveSigma = payload.slice(off, off + XCURVE_PROOF_LEN); off += XCURVE_PROOF_LEN;
    const kernelSigLP = payload.slice(off, off + 64); off += 64;
    const rRecvA = payload.slice(off, off + 32); off += 32;
    const rRecvB = payload.slice(off, off + 32); off += 32;
    const result = {
      assetA, assetB, shareAmount, deltaA, deltaB,
      recvACSecp, recvACBJJ, recvAXcurveSigma,
      recvBCSecp, recvBCBJJ, recvBXcurveSigma,
      kernelSigLP, rRecvA, rRecvB,
    };
    const proofLen = _readU16LE(payload, off); off += 2;
    if (off + proofLen !== payload.length) return null;
    result.proof = payload.slice(off, off + proofLen);
    return result;
  } catch { return null; }
}

export const OPCODE_T_FARM_INIT  = 0x34;
export const OPCODE_T_LP_BOND    = 0x35;
export const OPCODE_T_LP_UNBOND  = 0x36;
export const OPCODE_T_LP_HARVEST = 0x3B;
export const OPCODE_T_FARM_REFUND = 0x3E;
export const FARM_NO_CHANGE_SENTINEL = new Uint8Array(33);

const _FARM_INIT_DOMAIN    = new TextEncoder().encode('tacit-amm-farm-init-v1');
const _FARM_BOND_DOMAIN    = new TextEncoder().encode('tacit-amm-farm-bond-v1');
const _FARM_UNBOND_DOMAIN  = new TextEncoder().encode('tacit-amm-farm-unbond-v1');
const _FARM_HARVEST_DOMAIN = new TextEncoder().encode('tacit-amm-farm-harvest-v1');
const _FARM_REFUND_DOMAIN  = new TextEncoder().encode('tacit-amm-farm-refund-v1');
const _FARM_STATE_DOMAIN   = new TextEncoder().encode('tacit-farm-state-v1');
const _LP_ASSET_DOMAIN     = new TextEncoder().encode('tacit-amm-lp-v1');

function u32LE(n) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n >>> 0, true);
  return buf;
}
function u128LE(n) {
  const buf = new Uint8Array(16);
  let x = BigInt(n);
  if (x < 0n || x >= 1n << 128n) throw new Error('u128 overflow');
  for (let i = 0; i < 16; i++) { buf[i] = Number(x & 0xffn); x >>= 8n; }
  return buf;
}
function _readU128LE(b, off) {
  let n = 0n;
  for (let i = 0; i < 16; i++) n |= BigInt(b[off + i]) << BigInt(i * 8);
  return n;
}
function _readU32LE(b, off) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, true) >>> 0;
}

export function deriveFarmId({ poolId, launcherPubkey, rewardAssetId, farmNonce }) {
  return sha256(concatBytes(
    _FARM_INIT_DOMAIN,
    asBytes(poolId, 32, 'poolId'),
    asBytes(launcherPubkey, 33, 'launcherPubkey'),
    asBytes(rewardAssetId, 32, 'rewardAssetId'),
    asBytes(farmNonce, 32, 'farmNonce'),
  ));
}

export function deriveLpAssetIdFromPoolId(poolId) {
  return sha256(concatBytes(_LP_ASSET_DOMAIN, asBytes(poolId, 32, 'poolId')));
}

function _revBytes(b) { const r = new Uint8Array(b); r.reverse(); return r; }
export function ammFundingHash({ outpoints, kernelSig }) {
  const parts = [];
  for (const op of outpoints) {
    parts.push(_revBytes(asBytes(op.txid, 32, 'op.txid')));
    parts.push(u32LE(op.vout));
  }
  parts.push(sha256(asBytes(kernelSig, 64, 'kernelSig')));
  return sha256(concatBytes(...parts));
}

export function buildFarmInitMsg({ farmId, launcherPubkey, rewardTotal, rewardPerBlock, startHeight, endHeight, fundingHash, refundExpiry, refundDestXonly, refundBlinding }) {
  return sha256(concatBytes(
    _FARM_INIT_DOMAIN,
    asBytes(farmId, 32, 'farmId'),
    asBytes(launcherPubkey, 33, 'launcherPubkey'),
    u64LE(rewardTotal), u64LE(rewardPerBlock),
    u32LE(startHeight), u32LE(endHeight),
    asBytes(fundingHash, 32, 'fundingHash'),
    u32LE(refundExpiry || 0),
    asBytes(refundDestXonly, 32, 'refundDestXonly'),
    asBytes(refundBlinding, 32, 'refundBlinding'),
  ));
}
export function buildLpBondMsg({ farmId, bonderPubkey, bondAmount, entryAccPerShare, bondViewHeight, ownerCommit, nonce, fundingHash, refundExpiry, refundDestXonly, refundBlinding }) {
  return sha256(concatBytes(
    _FARM_BOND_DOMAIN,
    asBytes(farmId, 32, 'farmId'),
    asBytes(bonderPubkey, 33, 'bonderPubkey'),
    u64LE(bondAmount),
    u128LE(entryAccPerShare),
    u32LE(bondViewHeight),
    asBytes(ownerCommit, 32, 'ownerCommit'),
    asBytes(nonce, 32, 'nonce'),
    asBytes(fundingHash, 32, 'fundingHash'),
    u32LE(refundExpiry || 0),
    asBytes(refundDestXonly, 32, 'refundDestXonly'),
    asBytes(refundBlinding, 32, 'refundBlinding'),
  ));
}
export function buildLpUnbondMsg({ farmId, bondId, unbonderPubkey, exitAccPerShare, exitViewHeight, rewardAmount, lpReturnR, rewardR }) {
  return sha256(concatBytes(
    _FARM_UNBOND_DOMAIN,
    asBytes(farmId, 32, 'farmId'),
    asBytes(bondId, 36, 'bondId'),
    asBytes(unbonderPubkey, 33, 'unbonderPubkey'),
    u128LE(exitAccPerShare),
    u32LE(exitViewHeight),
    u64LE(rewardAmount),
    asBytes(lpReturnR, 32, 'lpReturnR'),
    asBytes(rewardR, 32, 'rewardR'),
  ));
}
export function buildLpHarvestMsg({ farmId, bondId, harvesterPubkey, exitAccPerShare, exitViewHeight, rewardAmount, rewardR }) {
  return sha256(concatBytes(
    _FARM_HARVEST_DOMAIN,
    asBytes(farmId, 32, 'farmId'),
    asBytes(bondId, 36, 'bondId'),
    asBytes(harvesterPubkey, 33, 'harvesterPubkey'),
    u128LE(exitAccPerShare),
    u32LE(exitViewHeight),
    u64LE(rewardAmount),
    asBytes(rewardR, 32, 'rewardR'),
  ));
}
export function buildFarmRefundMsg({ farmId, refundAmount, refundViewHeight, refundR, destSpk }) {
  return keccak_256(concatBytes(
    _FARM_REFUND_DOMAIN,
    asBytes(farmId, 32, 'farmId'),
    _u64BE(refundAmount),
    asBytes(refundR, 32, 'refundR'),
    _u32BE(refundViewHeight),
    _spk(destSpk),
  ));
}

export function buildFarmStateHash({ treasuryRemaining, totalBonded, accRewardPerShare }) {
  return sha256(concatBytes(
    _FARM_STATE_DOMAIN,
    u64LE(treasuryRemaining),
    u64LE(totalBonded),
    u128LE(accRewardPerShare),
  ));
}

export function encodeFarmInit(args) {
  const parts = [
    new Uint8Array([OPCODE_T_FARM_INIT]),
    asBytes(args.poolId, 32, 'poolId'),
    asBytes(args.farmNonce, 32, 'farmNonce'),
    asBytes(args.launcherPubkey, 33, 'launcherPubkey'),
    asBytes(args.rewardAssetId, 32, 'rewardAssetId'),
    u64LE(args.rewardTotal),
    u64LE(args.rewardPerBlock),
    u32LE(args.startHeight),
    u32LE(args.endHeight),
    asBytes(args.cChangeOrSentinel, 33, 'cChangeOrSentinel'),
  ];
  const proof = args.rangeProof;
  if (!(proof instanceof Uint8Array)) throw new Error('rangeProof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('rangeProof too large');
  parts.push(u16LE(proof.length), proof);
  parts.push(asBytes(args.kernelSig, 64, 'kernelSig'));
  parts.push(asBytes(args.launcherSig, 64, 'launcherSig'));
  parts.push(u32LE(args.refundExpiry || 0));
  parts.push(asBytes(args.refundDestXonly, 32, 'refundDestXonly'));
  parts.push(asBytes(args.refundBlinding, 32, 'refundBlinding'));
  return concatBytes(...parts);
}

export function encodeLpBond(args) {
  const parts = [
    new Uint8Array([OPCODE_T_LP_BOND]),
    asBytes(args.farmId, 32, 'farmId'),
    asBytes(args.bonderPubkey, 33, 'bonderPubkey'),
    u64LE(args.bondAmount),
    u128LE(args.entryAccPerShare),
    u32LE(args.bondViewHeight),
    asBytes(args.ownerCommit, 32, 'ownerCommit'),
    asBytes(args.nonce, 32, 'nonce'),
    asBytes(args.cChangeOrSentinel, 33, 'cChangeOrSentinel'),
  ];
  const proof = args.rangeProof;
  if (!(proof instanceof Uint8Array)) throw new Error('rangeProof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('rangeProof too large');
  parts.push(u16LE(proof.length), proof);
  parts.push(asBytes(args.kernelSig, 64, 'kernelSig'));
  parts.push(asBytes(args.bonderSig, 64, 'bonderSig'));
  parts.push(u32LE(args.refundExpiry || 0));
  parts.push(asBytes(args.refundDestXonly, 32, 'refundDestXonly'));
  parts.push(asBytes(args.refundBlinding, 32, 'refundBlinding'));
  return concatBytes(...parts);
}

export function encodeLpUnbond(args) {
  return concatBytes(
    new Uint8Array([OPCODE_T_LP_UNBOND]),
    asBytes(args.farmId, 32, 'farmId'),
    asBytes(args.ownerCommit, 32, 'ownerCommit'),
    asBytes(args.nonce, 32, 'nonce'),
    u64LE(args.shares),
    u128LE(args.rpsEntry ?? 0n),
    asBytes(args.lpReturnR, 32, 'lpReturnR'),
    asBytes(args.unbonderSig, 64, 'unbonderSig'),
  );
}

export function encodeLpHarvest(args) {
  return concatBytes(
    new Uint8Array([OPCODE_T_LP_HARVEST]),
    asBytes(args.farmId, 32, 'farmId'),
    asBytes(args.bondId, 36, 'bondId'),
    asBytes(args.harvesterPubkey, 33, 'harvesterPubkey'),
    u128LE(args.exitAccPerShare),
    u32LE(args.exitViewHeight),
    u64LE(args.rewardAmount),
    asBytes(args.rewardR, 32, 'rewardR'),
    asBytes(args.ownerCommit, 32, 'ownerCommit'),
    asBytes(args.oldNonce, 32, 'oldNonce'),
    asBytes(args.newNonce ?? new Uint8Array(32), 32, 'newNonce'),
    u64LE(args.shares),
    u128LE(args.rpsEntry ?? 0n),
    asBytes(args.harvesterSig, 64, 'harvesterSig'),
  );
}

export function encodeFarmRefund(args) {
  return concatBytes(
    new Uint8Array([OPCODE_T_FARM_REFUND]),
    asBytes(args.farmId, 32, 'farmId'),
    asBytes(args.launcherPubkey, 33, 'launcherPubkey'),
    u64LE(args.refundAmount),
    u32LE(args.refundViewHeight),
    asBytes(args.refundR, 32, 'refundR'),
    asBytes(args.launcherSig, 64, 'launcherSig'),
  );
}

export function decodeFarmInit(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length < 315 + 2 + 68) return null;
  let p = 0;
  if (payload[p++] !== OPCODE_T_FARM_INIT) return null;
  try {
    const poolId          = payload.slice(p, p + 32); p += 32;
    const farmNonce       = payload.slice(p, p + 32); p += 32;
    const launcherPubkey  = payload.slice(p, p + 33); p += 33;
    if (launcherPubkey[0] !== 0x02 && launcherPubkey[0] !== 0x03) return null;
    const rewardAssetId   = payload.slice(p, p + 32); p += 32;
    const rewardTotal     = _readU64LE(payload, p); p += 8;
    const rewardPerBlock  = _readU64LE(payload, p); p += 8;
    const startHeight     = _readU32LE(payload, p); p += 4;
    const endHeight       = _readU32LE(payload, p); p += 4;
    const cChangeOrSentinel = payload.slice(p, p + 33); p += 33;
    const rpLen = _readU16LE(payload, p); p += 2;
    if (p + rpLen + 64 + 64 + 68 > payload.length) return null;
    const rangeProof   = payload.slice(p, p + rpLen); p += rpLen;
    const kernelSig    = payload.slice(p, p + 64); p += 64;
    const launcherSig  = payload.slice(p, p + 64); p += 64;
    const refundExpiry     = _readU32LE(payload, p); p += 4;
    const refundDestXonly  = payload.slice(p, p + 32); p += 32;
    const refundBlinding   = payload.slice(p, p + 32); p += 32;
    if (p !== payload.length) return null;
    return {
      poolId, farmNonce, launcherPubkey, rewardAssetId,
      rewardTotal, rewardPerBlock, startHeight, endHeight,
      cChangeOrSentinel, rangeProof, kernelSig, launcherSig,
      refundExpiry, refundDestXonly, refundBlinding,
    };
  } catch { return null; }
}

export function decodeLpBond(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length < 319 + 2 + 68) return null;
  let p = 0;
  if (payload[p++] !== OPCODE_T_LP_BOND) return null;
  try {
    const farmId          = payload.slice(p, p + 32); p += 32;
    const bonderPubkey    = payload.slice(p, p + 33); p += 33;
    if (bonderPubkey[0] !== 0x02 && bonderPubkey[0] !== 0x03) return null;
    const bondAmount      = _readU64LE(payload, p); p += 8;
    const entryAccPerShare = _readU128LE(payload, p); p += 16;
    const bondViewHeight  = _readU32LE(payload, p); p += 4;
    const ownerCommit     = payload.slice(p, p + 32); p += 32;
    const nonce           = payload.slice(p, p + 32); p += 32;
    const cChangeOrSentinel = payload.slice(p, p + 33); p += 33;
    const rpLen = _readU16LE(payload, p); p += 2;
    if (p + rpLen + 64 + 64 + 68 > payload.length) return null;
    const rangeProof = payload.slice(p, p + rpLen); p += rpLen;
    const kernelSig  = payload.slice(p, p + 64); p += 64;
    const bonderSig  = payload.slice(p, p + 64); p += 64;
    const refundExpiry    = _readU32LE(payload, p); p += 4;
    const refundDestXonly = payload.slice(p, p + 32); p += 32;
    const refundBlinding  = payload.slice(p, p + 32); p += 32;
    if (p !== payload.length) return null;
    return {
      farmId, bonderPubkey, bondAmount, entryAccPerShare, bondViewHeight,
      ownerCommit, nonce, cChangeOrSentinel, rangeProof, kernelSig, bonderSig,
      refundExpiry, refundDestXonly, refundBlinding,
    };
  } catch { return null; }
}

export function decodeLpUnbond(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length !== 217) return null;
  let p = 0;
  if (payload[p++] !== OPCODE_T_LP_UNBOND) return null;
  try {
    const farmId      = payload.slice(p, p + 32); p += 32;
    const ownerCommit = payload.slice(p, p + 32); p += 32;
    const nonce       = payload.slice(p, p + 32); p += 32;
    const shares      = _readU64LE(payload, p); p += 8;
    const rpsEntry    = _readU128LE(payload, p); p += 16;
    const lpReturnR   = payload.slice(p, p + 32); p += 32;
    const unbonderSig = payload.slice(p, p + 64); p += 64;
    if (p !== payload.length) return null;
    return { farmId, ownerCommit, nonce, shares, rpsEntry, lpReturnR, unbonderSig };
  } catch { return null; }
}

export function decodeLpHarvest(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length !== 346) return null;
  let p = 0;
  if (payload[p++] !== OPCODE_T_LP_HARVEST) return null;
  try {
    const farmId          = payload.slice(p, p + 32); p += 32;
    const bondId          = payload.slice(p, p + 36); p += 36;
    const harvesterPubkey = payload.slice(p, p + 33); p += 33;
    const exitAccPerShare = _readU128LE(payload, p); p += 16;
    const exitViewHeight  = _readU32LE(payload, p); p += 4;
    const rewardAmount    = _readU64LE(payload, p); p += 8;
    const rewardR         = payload.slice(p, p + 32); p += 32;
    const ownerCommit     = payload.slice(p, p + 32); p += 32;
    const oldNonce        = payload.slice(p, p + 32); p += 32;
    const newNonce        = payload.slice(p, p + 32); p += 32;
    const shares          = _readU64LE(payload, p); p += 8;
    const rpsEntry        = _readU128LE(payload, p); p += 16;
    const harvesterSig    = payload.slice(p, p + 64); p += 64;
    if (p !== payload.length) return null;
    return {
      farmId, bondId, harvesterPubkey, exitAccPerShare, exitViewHeight,
      rewardAmount, rewardR, ownerCommit, oldNonce, newNonce, shares, rpsEntry, harvesterSig,
    };
  } catch { return null; }
}

export function decodeFarmRefund(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length !== 174) return null;
  let p = 0;
  if (payload[p++] !== OPCODE_T_FARM_REFUND) return null;
  try {
    const farmId         = payload.slice(p, p + 32); p += 32;
    const launcherPubkey = payload.slice(p, p + 33); p += 33;
    if (launcherPubkey[0] !== 0x02 && launcherPubkey[0] !== 0x03) return null;
    const refundAmount   = _readU64LE(payload, p); p += 8;
    const refundViewHeight = _readU32LE(payload, p); p += 4;
    const refundR        = payload.slice(p, p + 32); p += 32;
    const launcherSig    = payload.slice(p, p + 64); p += 64;
    if (p !== payload.length) return null;
    return {
      farmId, launcherPubkey, refundAmount, refundViewHeight,
      refundR, launcherSig,
    };
  } catch { return null; }
}

export const FARM_ACC_FIXED_POINT_SHIFT = 96n;
export function crystallizeFarm(farm, currentHeight) {
  const h = currentHeight > farm.end_height ? farm.end_height : currentHeight;
  if (h <= farm.last_update_height) return;
  if (h < farm.start_height) {
    farm.last_update_height = h;
    return;
  }
  const baseline = farm.last_update_height < farm.start_height
    ? farm.start_height
    : farm.last_update_height;
  const elapsed = BigInt(h - baseline);
  const totalBonded = BigInt(farm.total_bonded);
  if (totalBonded > 0n && elapsed > 0n) {
    const rewardUnits = elapsed * BigInt(farm.reward_per_block);
    const accDelta = (rewardUnits << FARM_ACC_FIXED_POINT_SHIFT) / totalBonded;
    farm.acc_reward_per_share = (BigInt(farm.acc_reward_per_share) + accDelta).toString();
  }
  farm.last_update_height = h;
}
