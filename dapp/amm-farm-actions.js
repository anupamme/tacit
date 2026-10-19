
import {
  encodeFarmInit, encodeLpBond, encodeLpUnbond,
  encodeLpHarvest, encodeFarmRefund,
  buildFarmInitMsg, buildLpBondMsg, buildLpUnbondMsg, ammFundingHash,
  buildLpHarvestMsg, buildFarmRefundMsg,
  deriveFarmId, deriveLpAssetIdFromPoolId,
  FARM_NO_CHANGE_SENTINEL, FARM_ACC_FIXED_POINT_SHIFT,
  farmReceiptLeaf, lpHarvestOwnerMsg, lpUnbondOwnerMsg, deriveFarmOwnerKey,
} from './amm-envelope.js';

import {
  wallet, ensurePrivkey, scanHoldings, invalidateHoldingsCache,
  carveExactAmount, getUtxos, getFeeRate, feeFor,
  broadcast, broadcastWithRetry, DUST, NET,
  encodeEnvelopeScript, tapLeafHash, tweakedOutputKey,
  controlBlock, p2trScript, p2wpkhScript, TAP_NUMS,
  signP2wpkhInput, signTaprootScriptPathInput,
  serializeTx, txid as computeTxid,
  estCommitVb, sortSatsForCommit,
  signSchnorr, pedersenCommit, pointToBytes, SECP_N, modN,
  recordOpening,
} from './tacit.js';

import { lpBondKernelSign } from './amm-kernel.js';

import { concatBytes, hexToBytes, bytesToHex, sha256 } from './vendor/tacit-deps.min.js';

function bigintToBytes32(n) {
  let x = BigInt(n);
  if (x < 0n) x = ((x % SECP_N) + SECP_N) % SECP_N;
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

function randomScalar() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  let n = BigInt('0x' + bytesToHex(b));
  if (n === 0n) n = 1n;
  return modN(n);
}

async function broadcastFarmTx({ payload, envelopeHash, vin1, extraOutputs = [] }) {
  await ensurePrivkey();
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const tapLeaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, tapLeaf);
  const commitSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const feeRate = await getFeeRate();
  const opReturnSpk = concatBytes(new Uint8Array([0x6a, 0x20]), envelopeHash);

  const dustOutBytes = extraOutputs.reduce((s, o) => s + (o.script.length + 9), 0);
  const revealVbBase = 11 + 41 + (vin1 ? 41 : 0) + 34 + dustOutBytes;
  const revealVb = revealVbBase + Math.ceil((1 + 1 + 65 + 3 + 45 + payload.length + 34 + 109) / 4);
  const revealFee = feeFor(revealVb, feeRate);
  const commitValue = Math.max(DUST, revealFee + extraOutputs.reduce((s, o) => s + o.value, 0));

  const allUtxos = await getUtxos(wallet.address(), null, { forSpend: true });
  const assetKey = vin1 ? `${vin1.txid}:${vin1.vout}` : null;
  const sats = sortSatsForCommit(allUtxos.filter(u =>
    u.value > DUST && (!assetKey || `${u.txid}:${u.vout}` !== assetKey)));
  const picked = []; let total = 0; let commitFee = 500;
  for (const u of sats) {
    picked.push(u); total += u.value;
    commitFee = feeFor(estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + DUST) break;
  }
  if (total < commitValue + commitFee) {
    throw new Error(`insufficient sats for farm tx: need ${commitValue + commitFee}, have ${total} (across ${picked.length} confirmed UTXOs)`);
  }
  const changeSats = total - commitValue - commitFee;
  const changeSpk = p2wpkhScript(wallet.pub);

  const commitOutputs = [{ value: commitValue, script: commitSpk }];
  if (changeSats >= DUST) commitOutputs.push({ value: changeSats, script: changeSpk });
  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, picked[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxidHex = computeTxid(commitTx);

  const revealInputs = [
    { txid: commitTxidHex, vout: 0, sequence: 0xfffffffd, witness: [] },
  ];
  const revealPrevouts = [{ value: commitValue, script: commitSpk }];
  if (vin1) {
    revealInputs.push({ txid: vin1.txid, vout: vin1.vout | 0, sequence: 0xfffffffd, witness: [] });
    revealPrevouts.push({ value: DUST, script: p2wpkhScript(wallet.pub) });
  }
  const revealOutputs = [{ value: 0, script: opReturnSpk }, ...extraOutputs];
  const revealTx = {
    version: 2, locktime: 0,
    inputs: revealInputs,
    outputs: revealOutputs,
  };
  revealTx.inputs[0].witness = signTaprootScriptPathInput(
    revealTx, revealPrevouts, envelopeScript, cb,
  );
  if (vin1) revealTx.inputs[1].witness = signP2wpkhInput(revealTx, 1, DUST);
  const revealHex = bytesToHex(serializeTx(revealTx));
  const revealTxidHex = computeTxid(revealTx);

  await broadcast(commitHex);
  await broadcastWithRetry(revealHex);
  return { commitTxid: commitTxidHex, revealTxid: revealTxidHex };
}

export async function buildAndBroadcastFarmInit({
  poolIdHex, rewardAssetIdHex, rewardTotal, rewardPerBlock,
  startHeight,
}) {
  await ensurePrivkey();
  const rewardTotalBig = BigInt(rewardTotal);
  const rewardPerBlockBig = BigInt(rewardPerBlock);
  if (rewardPerBlockBig === 0n) throw new Error('reward_per_block must be > 0');
  if (rewardTotalBig % rewardPerBlockBig !== 0n) {
    throw new Error('reward_total must be divisible by reward_per_block');
  }
  const windowBig = rewardTotalBig / rewardPerBlockBig;
  if (rewardPerBlockBig > 0xffffffffn) throw new Error('reward_per_block exceeds cap');
  if (windowBig > 0xffffffffn) throw new Error('farm window exceeds cap');
  if (rewardTotalBig >= (1n << 63n)) throw new Error('reward_total exceeds schedule width cap');
  const endHeight = startHeight + Number(windowBig);

  const farmNonce = new Uint8Array(32);
  globalThis.crypto.getRandomValues(farmNonce);
  const farmIdBytes = deriveFarmId({
    poolId: hexToBytes(poolIdHex),
    launcherPubkey: wallet.pub,
    rewardAssetId: hexToBytes(rewardAssetIdHex),
    farmNonce,
  });

  const carved = await carveExactAmount({ assetIdHex: rewardAssetIdHex, amount: rewardTotalBig });
  if (!carved || !carved.utxo) throw new Error('failed to carve reward UTXO');
  const inputBlind = BigInt(carved.blinding);
  const cChangeOrSentinel = FARM_NO_CHANGE_SENTINEL;
  const rangeProof = new Uint8Array([0x01]);

  const kernelExcess = modN(-inputBlind);
  const KERNEL_DOMAIN = new TextEncoder().encode('tacit-kernel-v1');
  const txidBE = new Uint8Array(32);
  const txidLE = hexToBytes(carved.utxo.txid);
  for (let i = 0; i < 32; i++) txidBE[i] = txidLE[31 - i];
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, carved.utxo.vout | 0, true);
  const burnedLE = new Uint8Array(8);
  const burnedView = new DataView(burnedLE.buffer);
  burnedView.setUint32(0, Number(rewardTotalBig & 0xffffffffn), true);
  burnedView.setUint32(4, Number((rewardTotalBig >> 32n) & 0xffffffffn), true);
  const kernelMsg = sha256(concatBytes(
    KERNEL_DOMAIN,
    hexToBytes(rewardAssetIdHex),
    new Uint8Array([1]),
    txidBE, voutLE,
    new Uint8Array([1]),
    cChangeOrSentinel,
    burnedLE,
  ));
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(kernelExcess));

  const initFundingHash = ammFundingHash({
    outpoints: [{ txid: carved.utxo.txid, vout: carved.utxo.vout }],
    kernelSig,
  });
  const refundDestXonly = wallet.pub.slice(1);
  const refundBlinding = bigintToBytes32(randomScalar());
  const refundExpiry = endHeight;
  const initMsg = buildFarmInitMsg({
    farmId: farmIdBytes, launcherPubkey: wallet.pub,
    rewardTotal: rewardTotalBig, rewardPerBlock: rewardPerBlockBig,
    startHeight, endHeight, fundingHash: initFundingHash,
    refundExpiry, refundDestXonly, refundBlinding,
  });
  const launcherSig = signSchnorr(initMsg, wallet.priv);

  const payload = encodeFarmInit({
    poolId: hexToBytes(poolIdHex), farmNonce,
    launcherPubkey: wallet.pub,
    rewardAssetId: hexToBytes(rewardAssetIdHex),
    rewardTotal: rewardTotalBig, rewardPerBlock: rewardPerBlockBig,
    startHeight, endHeight,
    cChangeOrSentinel, rangeProof,
    kernelSig, launcherSig,
    refundExpiry, refundDestXonly, refundBlinding,
  });
  const envelopeHash = sha256(payload);

  const res = await broadcastFarmTx({
    payload, envelopeHash,
    vin1: { txid: carved.utxo.txid, vout: carved.utxo.vout },
    extraOutputs: [{ value: DUST, script: p2trScript(refundDestXonly) }],
  });
  return {
    farmIdHex: bytesToHex(farmIdBytes),
    revealTxid: res.revealTxid,
    commitTxid: res.commitTxid,
    startHeight, endHeight,
    refund: { destXonlyHex: bytesToHex(refundDestXonly), blindingHex: bytesToHex(refundBlinding), expiry: refundExpiry },
  };
}

export async function buildAndBroadcastLpBond({
  farmIdHex, poolIdHex, bondAmount,
  entryAccPerShare, bondViewHeight,
}) {
  await ensurePrivkey();
  const bondAmountBig = BigInt(bondAmount);
  const lpAssetIdBytes = deriveLpAssetIdFromPoolId(hexToBytes(poolIdHex));
  const lpAssetIdHex = bytesToHex(lpAssetIdBytes);

  const receiptNonce = new Uint8Array(32);
  globalThis.crypto.getRandomValues(receiptNonce);
  const ownerKey = deriveFarmOwnerKey({ walletPriv: wallet.priv, farmId: hexToBytes(farmIdHex), nonce: receiptNonce });

  const carved = await carveExactAmount({ assetIdHex: lpAssetIdHex, amount: bondAmountBig });
  if (!carved || !carved.utxo) throw new Error(`failed to carve ${bondAmountBig} of LP shares`);
  const inputValue = BigInt(carved.amount);
  const inputBlind = BigInt(carved.blinding);
  const changeValue = inputValue - bondAmountBig;

  let cChangeOrSentinel, rangeProof, kernelExcess;
  if (changeValue === 0n) {
    cChangeOrSentinel = FARM_NO_CHANGE_SENTINEL;
    rangeProof = new Uint8Array([0x01]);
    kernelExcess = modN(-inputBlind);
  } else {
    const changeBlind = randomScalar();
    const cChange = pedersenCommit(changeValue, changeBlind);
    cChangeOrSentinel = pointToBytes(cChange);
    throw new Error('LP_BOND with non-zero change is not yet wired in this dapp build; ' +
                    'carveExactAmount should produce an exact-amount UTXO. Try unbond/re-bond.');
  }

  void kernelExcess;
  const lpInputs = [{ txid: carved.utxo.txid, vout: carved.utxo.vout }];
  const lpInputCommitments = [pedersenCommit(inputValue, inputBlind)];
  const kernelSig = lpBondKernelSign({
    farmId: hexToBytes(farmIdHex), lpAsset: lpAssetIdBytes,
    bondAmount: bondAmountBig,
    lpInputs, lpInputCommitments,
    excessLP: inputBlind,
  });

  const bondFundingHash = ammFundingHash({ outpoints: lpInputs, kernelSig });
  const refundDestXonly = wallet.pub.slice(1);
  const refundBlinding = bigintToBytes32(randomScalar());
  const refundExpiry = Number(bondViewHeight || 0) + 200000;
  const bondMsg = buildLpBondMsg({
    farmId: hexToBytes(farmIdHex), bonderPubkey: wallet.pub,
    bondAmount: bondAmountBig,
    entryAccPerShare: BigInt(entryAccPerShare),
    bondViewHeight,
    ownerCommit: ownerKey.ownerXonly, nonce: receiptNonce,
    fundingHash: bondFundingHash,
    refundExpiry, refundDestXonly, refundBlinding,
  });
  const bonderSig = signSchnorr(bondMsg, wallet.priv);

  const payload = encodeLpBond({
    farmId: hexToBytes(farmIdHex), bonderPubkey: wallet.pub,
    bondAmount: bondAmountBig,
    entryAccPerShare: BigInt(entryAccPerShare),
    bondViewHeight,
    ownerCommit: ownerKey.ownerXonly, nonce: receiptNonce,
    cChangeOrSentinel, rangeProof,
    kernelSig, bonderSig,
    refundExpiry, refundDestXonly, refundBlinding,
  });
  const envelopeHash = sha256(payload);

  const bondMarkerSpk = p2trScript(refundDestXonly);
  const res = await broadcastFarmTx({
    payload, envelopeHash,
    vin1: { txid: carved.utxo.txid, vout: carved.utxo.vout },
    extraOutputs: [{ value: DUST, script: bondMarkerSpk }],
  });
  const revealTxidBytes = hexToBytes(res.revealTxid);
  const revealTxidBE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) revealTxidBE[i] = revealTxidBytes[31 - i];
  const bondIdBytes = new Uint8Array(36);
  bondIdBytes.set(revealTxidBE, 0);
  new DataView(bondIdBytes.buffer).setUint32(32, 1, true);
  return {
    bondIdHex: bytesToHex(bondIdBytes),
    revealTxid: res.revealTxid,
    commitTxid: res.commitTxid,
    receipt: { farmIdHex, ownerNonceHex: bytesToHex(receiptNonce), receiptNonceHex: bytesToHex(receiptNonce), ownerHex: bytesToHex(ownerKey.ownerXonly), shares: bondAmountBig.toString() },
  };
}

export async function buildAndBroadcastLpHarvest({
  farmIdHex, lpAssetHex, bondIdHex, exitAccPerShare, exitViewHeight, rewardAmount,
  ownerNonce, nonce, shares,
}) {
  await ensurePrivkey();
  const rewardAmountBig = BigInt(rewardAmount);
  const sharesBig = BigInt(shares);
  const farmIdBytes = hexToBytes(farmIdHex);
  const nonceBytes = hexToBytes(nonce);
  const ownerKey = deriveFarmOwnerKey({ walletPriv: wallet.priv, farmId: farmIdBytes, nonce: hexToBytes(ownerNonce) });
  const rewardR = bigintToBytes32(randomScalar());
  const rewardSpk = p2trScript(wallet.pub.slice(1));
  const harvestDestSpk = rewardAmountBig > 0n ? rewardSpk : new Uint8Array(0);
  const leaf = farmReceiptLeaf({ farmId: farmIdBytes, lpAsset: hexToBytes(String(lpAssetHex).replace(/^0x/, '')), shares: sharesBig, owner: ownerKey.ownerXonly, nonce: nonceBytes });
  const ownerMsg = lpHarvestOwnerMsg({ farmId: farmIdBytes, oldLeaf: leaf, reward: rewardAmountBig, rewardR, destSpk: harvestDestSpk });
  const harvesterSig = signSchnorr(ownerMsg, ownerKey.priv);
  const payload = encodeLpHarvest({
    farmId: farmIdBytes, bondId: hexToBytes(bondIdHex),
    harvesterPubkey: wallet.pub,
    exitAccPerShare: BigInt(exitAccPerShare), exitViewHeight,
    rewardAmount: rewardAmountBig, rewardR,
    ownerCommit: ownerKey.ownerXonly, oldNonce: nonceBytes,
    shares: sharesBig, harvesterSig,
  });
  const envelopeHash = sha256(payload);
  const extraOutputs = rewardAmountBig > 0n
    ? [{ value: DUST, script: rewardSpk }]
    : [];
  const res = await broadcastFarmTx({
    payload, envelopeHash, vin1: null, extraOutputs,
  });
  return { revealTxid: res.revealTxid, commitTxid: res.commitTxid, rewardR: bytesToHex(rewardR),
    receipt: { farmIdHex, ownerNonceHex: bytesToHex(hexToBytes(ownerNonce)), receiptNonceHex: bytesToHex(nonceBytes), ownerHex: bytesToHex(ownerKey.ownerXonly), shares: sharesBig.toString() } };
}

export async function buildAndBroadcastLpUnbond({
  farmIdHex, lpAssetHex, ownerNonce, nonce, shares,
}) {
  await ensurePrivkey();
  const sharesBig = BigInt(shares);
  const farmIdBytes = hexToBytes(farmIdHex);
  const nonceBytes = hexToBytes(nonce);
  const ownerKey = deriveFarmOwnerKey({ walletPriv: wallet.priv, farmId: farmIdBytes, nonce: hexToBytes(ownerNonce) });
  const lpReturnR = bigintToBytes32(randomScalar());
  const myAddr = p2trScript(wallet.pub.slice(1));
  const leaf = farmReceiptLeaf({ farmId: farmIdBytes, lpAsset: hexToBytes(String(lpAssetHex).replace(/^0x/, '')), shares: sharesBig, owner: ownerKey.ownerXonly, nonce: nonceBytes });
  const ownerMsg = lpUnbondOwnerMsg({ farmId: farmIdBytes, oldLeaf: leaf, shares: sharesBig, lpReturnR, destSpk: myAddr });
  const unbonderSig = signSchnorr(ownerMsg, ownerKey.priv);
  const payload = encodeLpUnbond({
    farmId: farmIdBytes,
    ownerCommit: ownerKey.ownerXonly, nonce: nonceBytes,
    shares: sharesBig,
    lpReturnR, unbonderSig,
  });
  const envelopeHash = sha256(payload);
  const extraOutputs = [{ value: DUST, script: myAddr }];
  const res = await broadcastFarmTx({
    payload, envelopeHash, vin1: null, extraOutputs,
  });
  return { revealTxid: res.revealTxid, commitTxid: res.commitTxid, lpReturnR: bytesToHex(lpReturnR) };
}

export async function buildAndBroadcastFarmRefund({
  farmIdHex, refundAmount, refundViewHeight,
}) {
  await ensurePrivkey();
  const refundAmountBig = BigInt(refundAmount);
  const refundR = bigintToBytes32(randomScalar());
  const refundSpk = p2trScript(wallet.pub.slice(1));
  const refundMsg = buildFarmRefundMsg({
    farmId: hexToBytes(farmIdHex),
    refundAmount: refundAmountBig,
    refundViewHeight,
    refundR, destSpk: refundSpk,
  });
  const launcherSig = signSchnorr(refundMsg, wallet.priv);
  const payload = encodeFarmRefund({
    farmId: hexToBytes(farmIdHex), launcherPubkey: wallet.pub,
    refundAmount: refundAmountBig,
    refundViewHeight,
    refundR, launcherSig,
  });
  const envelopeHash = sha256(payload);
  const res = await broadcastFarmTx({
    payload, envelopeHash, vin1: null,
    extraOutputs: [{ value: DUST, script: refundSpk }],
  });
  return { revealTxid: res.revealTxid, commitTxid: res.commitTxid, refundR: bytesToHex(refundR) };
}

const WORKER_BASE_RX = /^https?:\/\/[^\s/]+/;
function workerBase() {
  try {
    const v = localStorage.getItem('tacit-worker-base-v1');
    if (v && WORKER_BASE_RX.test(v)) return v;
  } catch {}
  return 'https://api.tacit.finance';
}

export async function fetchFarm(farmIdHex) {
  const r = await fetch(`${workerBase()}/farm/${farmIdHex}?network=${(NET && NET.name) || 'signet'}`);
  if (!r.ok) return null;
  return await r.json();
}

export async function fetchFarmsForPool(poolIdHex) {
  const r = await fetch(`${workerBase()}/farms?pool=${poolIdHex}&network=${(NET && NET.name) || 'signet'}`);
  if (!r.ok) return { farms: [] };
  return await r.json();
}

export async function fetchAllFarms({ cursor = null, limit = 50 } = {}) {
  let url = `${workerBase()}/farms?network=${(NET && NET.name) || 'signet'}&limit=${limit}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const r = await fetch(url);
  if (!r.ok) return { farms: [], cursor: null };
  return await r.json();
}

export async function fetchBondsForBonder(farmIdHex, bonderPubHex) {
  const r = await fetch(
    `${workerBase()}/farm/${farmIdHex}/bonds?bonder=${bonderPubHex}&network=${(NET && NET.name) || 'signet'}`,
  );
  if (!r.ok) return { bonds: [] };
  return await r.json();
}
