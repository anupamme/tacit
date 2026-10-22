#!/usr/bin/env node
// Pay-to-stealth bridge (dapp/confidential-bridge-mint.js stealthDestFor + bridgeStealthMint, dapp/bridge-burn-broadcast.js
// `stealthDest`): a Bitcoin burn that names a stealth lock for someone else. Round trip in JS, no network: the burn is built and
// signed with deterministic test keys, broadcast through an injected recorder, read back with the guest's parser mirror, folded
// through the reflection scan mirror, and minted as OP_BRIDGE_STEALTH_MINT. Then the two ends: the recipient opens the memo and
// signs the claim with the one-time key, and the burner finds the lock from its key alone and can refund it.
//
// Run: node tests/bridge-stealth-recipient.test.mjs
// DUMP_OP=<file> also writes the completed mint op (with the memo hash the relay adds) as the guest harness reads it
// (contracts/sp1/confidential/harnesses/exec-bridgestealthmint.rs OP_FILE), to run it through the real guest ELF.

import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { G as bpG } from '../dapp/bulletproofs-plus.js';
import { bppRangeVerify } from '../dapp/bulletproofs-plus.js';
import { signSchnorr, verifySchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';
import { makeConfidentialAirdrop } from '../dapp/confidential-airdrop.js';
import { makeConfidentialBridgeMint, txidInternal } from '../dapp/confidential-bridge-mint.js';
import { makeBridgeBurnBroadcaster } from '../dapp/bridge-burn-broadcast.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { makeBurnDepositKit, classifyConfidentialTx, extractInputs } from '../dapp/burn-deposit-bitcoin.js';
import { stdinFor } from '../dapp/sp1-stdin.js';
import { computeTxid, computeMerkleRoot, mineHeader, makeCoinbaseForEnvTx } from './btc-mini.mjs';
import { secp as vsecp, hmac, sha256 as vsha256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

if (!vsecp.etc.hmacSha256Sync) vsecp.etc.hmacSha256Sync = (k, ...m) => hmac(vsha256, k, concatBytes(...m));

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const ct = makeConfidentialTransfer({ keccak256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer: ct });
const airdrop = makeConfidentialAirdrop({ stealth, secp, sha256, keccak256, curveOrder: SECP_N, pool, transfer: ct });
const bm = makeConfidentialBridgeMint({ pool, ct, stealth, airdrop });

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const hex32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const ZERO32 = '0x' + '00'.repeat(32);

const ASSET = '0x' + 'a5'.repeat(32);
const CHAIN_BINDING = '0x' + '7c'.repeat(32);
const WALLET_PRIV = new Uint8Array(32).fill(0x11);
const LOCKER_SCAN_PRIV = hx(WALLET_PRIV);           // identity(walletPriv).priv, as the sent-lock scan reads it
const NOTE_TXID = '5e'.repeat(31) + '01';
const NOTE_VOUT = 1;
const NOTE_VALUE = 1_500_000n, NOTE_BLINDING = 0x9a9a9a9an;
const RECIPIENT_PRIV = hex32(0x7e57c0ffee1234567n);
const RECIPIENT_PUB = hx(secp.getPublicKey(BigInt(RECIPIENT_PRIV), true));
const DEADLINE = bm.stealthDeadline(1_760_000_000);

function testWallet() {
  const sent = [];
  const box = {};
  const w = makeBtcWallet({
    priv: WALLET_PRIV, hrp: 'bc',
    fetchUtxos: async () => box.default,
    broadcastTx: async (hex) => { sent.push(hex); return 'ok'; },
    fetchFeeRate: async () => 5,
  });
  const spk = w.prims.bytesToHex(w.prims.p2wpkhScript(w.wallet.pub));
  box.default = [{ txid: '6f'.repeat(32), vout: 0, value: 50_000, scriptpubkey: spk, status: { confirmed: true } }];
  return { prims: w.prims, sent, spk };
}

function reflectedIndexer() {
  const idx = makeScanReflectionIndexer({ secp, keccak256, sha256, burnDepositKit: makeBurnDepositKit({ secp, keccak256, sha256 }) });
  const { cx, cy } = pool.commitXY(NOTE_VALUE, NOTE_BLINDING);
  const leaf = pool.btcNoteLeaf(ASSET, cx, cy, ZERO32);
  const key = pool.outpointKey(txidInternal(NOTE_TXID), NOTE_VOUT);
  const otherKey = pool.outpointKey(txidInternal('77'.repeat(32)), 0);
  idx.load({
    noteLeaves: ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32), leaf],
    liveTriples: [[key, pool.commitmentHash(cx, cy), ASSET, ZERO32, 0], [otherKey, '0x' + '0e'.repeat(32), ASSET, '0x' + '0f'.repeat(32), 0]].sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)),
    coords: [[key.toLowerCase(), { cx, cy }]],
    height: 100,
  });
  return { idx, leaf };
}

const note = { txid: NOTE_TXID, vout: NOTE_VOUT, sats: 330, asset: ASSET, value: NOTE_VALUE, blinding: NOTE_BLINDING };
const destFor = (over = {}) => (nu, v) => bm.stealthDestFor({ asset: ASSET, lockerScanPriv: LOCKER_SCAN_PRIV, nullifier: nu, recipientSpendPub: RECIPIENT_PUB, value: v, deadline: DEADLINE, ...over });

// ── the destination is derived, not drawn ──
{
  const nu = '0x' + '31'.repeat(32), other = '0x' + '32'.repeat(32);
  const a = destFor()(nu, NOTE_VALUE), b = destFor()(nu, NOTE_VALUE), c = destFor()(other, NOTE_VALUE);
  assert.deepStrictEqual({ ...a, value: String(a.value), deadline: String(a.deadline) }, { ...b, value: String(b.value), deadline: String(b.deadline) }, 'the same key and nullifier give the same lock');
  assert.notStrictEqual(a.lockLeaf, c.lockLeaf, 'another burn gets another lock');
  assert.notStrictEqual(a.ephemeralPub, c.ephemeralPub, 'another burn gets another one-time key');
  assert.notStrictEqual(a.lBlinding, c.lBlinding, 'another burn gets another blinding');
  assert.notStrictEqual(a.refundPub, c.refundPub, 'another burn gets another refund key');
  const keyed = destFor({ lockerScanPriv: hx(new Uint8Array(32).fill(0x12)) })(nu, NOTE_VALUE);
  assert.notStrictEqual(keyed.lockLeaf, a.lockLeaf, 'another key gets another lock');
  const rec = stealth.recoverOneTimeKey({ recipientSpendPriv: RECIPIENT_PRIV, ephemeralPub: a.ephemeralPub });
  assert.strictEqual(rec.ownerPub.toLowerCase(), a.ownerPub.toLowerCase(), 'the recipient recovers the one-time key from the ephemeral key');
  assert.strictEqual(a.lockLeaf, stealth.stealthLockLeafBlind(ASSET, a.cx, a.cy, a.ownerPub, DEADLINE, a.refundPub), 'lock leaf = stealth_lock_leaf_blind(asset, L, owner, deadline, refund)');
  // the deadline is a whole UTC day, and a burn found later is matched from the days around its block time
  assert.strictEqual(DEADLINE % 86400, 0, 'deadline is on a UTC day boundary');
  assert.ok(bm.stealthDeadlineCandidates(1_760_000_000).includes(DEADLINE), 'the deadline is among the candidates for its own burn time');
  assert.ok(bm.stealthDeadlineCandidates(1_760_000_000 + 86400).includes(DEADLINE), 'and for a burn a day on');
  assert.throws(() => destFor({ recipientSpendPub: '0x' + '04'.repeat(33) })(nu, NOTE_VALUE), /33-byte compressed/, 'a malformed recipient');
  assert.throws(() => destFor({ deadline: 0 })(nu, NOTE_VALUE), /deadline/, 'no deadline');
  assert.throws(() => destFor()(nu, 0n), /out of range/, 'no value');
  ok('the lock is derived from the key and the nullifier: stable per burn, distinct across burns and keys, recoverable by the recipient');
}

// ── burn → fold → mint ──
const { idx, leaf } = reflectedIndexer();
const snapshot = idx.snapshot();
const w = testWallet();
const burner = makeBridgeBurnBroadcaster({ pool, bridgeMint: bm, prims: w.prims });
const r = await burner.broadcastBridgeBurn({
  note: { ...note, script: w.spk }, notePriv: WALLET_PRIV, chainBinding: CHAIN_BINDING, fee: 0n, snapshot,
  stealthDest: destFor(), isSpendable: (u) => !(u.txid === NOTE_TXID && u.vout === NOTE_VOUT),
});
const sd = r.mintArgs.stealthDest;
const nu = pool.nullifier(leaf);
{
  assert.ok(sd && !r.mintArgs.dest, 'the mint args carry the stealth destination and no note destination');
  assert.strictEqual(r.nullifier, nu);
  const dec = classifyConfidentialTx(r.revealHex);
  assert.ok(dec && dec.type === 'burn', 'the reveal classifies as a bridge burn');
  assert.strictEqual(dec.nullifier, nu, 'envelope ν is the note leaf\'s nullifier');
  assert.strictEqual(dec.dest, sd.lockLeaf, 'the envelope pins the stealth lock leaf');
  assert.strictEqual(r.destLeaf, sd.lockLeaf);
  assert.strictEqual(r.dest.owner.toLowerCase(), sd.ownerPub.toLowerCase(), 'the plan\'s destination owner is the one-time key');
  assert.strictEqual(r.dest.value, NOTE_VALUE, 'no fee: the lock holds the whole burned value');
  assert.strictEqual(sd.lockLeaf, destFor()(nu, NOTE_VALUE).lockLeaf, 'the burn built the lock from its own nullifier');
  assert.strictEqual(w.sent.length, 2, 'commit and reveal broadcast');
  ok('the burn envelope pins the stealth lock leaf derived from its own nullifier');
}

const revealBytes = Buffer.from(r.revealHex, 'hex');
const revealTxid = computeTxid(revealBytes);
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(revealBytes);
const header = mineHeader(computeMerkleRoot([cbTxid, revealTxid]));
const dec = classifyConfidentialTx(r.revealHex);
const ins = extractInputs(r.revealHex);
await idx.assembleBlocks([{
  txs: [
    { txidDisplay: Buffer.from(cbTxid).reverse().toString('hex'), rawHex: coinbaseSpec.txData.slice(2), vins: [], decode: null },
    { txidDisplay: r.revealTxid, rawHex: r.revealHex, vins: ins.map((i) => ({ prevTxidDisplay: i.prevTxid.replace(/^0x/, '').match(/../g).reverse().join(''), vout: i.prevVout })), decode: dec },
  ],
}], { headers: ['0x' + Buffer.from(header).toString('hex')], anchorHeight: 101, chainBinding: CHAIN_BINDING });
const folded = idx.snapshot();
const foldedSnap = { noteLeaves: folded.noteLeaves, burnNodes: folded.burnNodes };
{
  assert.ok(idx.state().burnContains(r.burnId), 'the burn set holds the burnId');
  ok('the reflection mirror folds the burn: note nullified, burnId recorded');
}

let mint;
{
  mint = bm.buildBridgeStealthMintOp({ ...r.mintArgs, snapshot: foldedSnap });
  assert.strictEqual(mint.destLeaf, sd.lockLeaf);
  assert.strictEqual(mint.burnId, r.burnId, 'the mint names the same burn');
  assert.strictEqual(mint.nullifier, nu);
  assert.strictEqual(mint.fee, 0n);
  const op = mint.op;
  assert.strictEqual(op.ownerPub.toLowerCase(), sd.ownerPub.toLowerCase());
  assert.strictEqual(Number(op.deadline), Number(DEADLINE));
  assert.strictEqual(op.locker.toLowerCase(), sd.refundPub.toLowerCase(), 'the locker is the burner\'s refund key');
  assert.strictEqual(op.lCx.toLowerCase(), sd.cx.toLowerCase());
  assert.strictEqual(op.sourceClass, 1);
  assert.notStrictEqual(op.bitcoinBurnRoot, ZERO32, 'the public half carries the burn root');
  // the guest's stdin writer takes it whole, with the memo hash the relay adds from the memo it is sent
  const lockMemo = bm.sealStealthLockMemo({ lockerScanPriv: LOCKER_SCAN_PRIV, stealthDest: sd });
  const memoHash = hx(keccak256(Uint8Array.from(lockMemo.replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)))));
  const stdin = stdinFor('bridgestealthmint', { ...op, memoHashes: [memoHash] });
  assert.ok(stdin && stdin.length > 0, 'the op serializes to the guest\'s stdin');
  if (process.env.DUMP_OP) writeFileSync(process.env.DUMP_OP, JSON.stringify({ ...op, memoHashes: [memoHash] }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  // conservation and the range of L, as the guest checks them (verify_kernel_with_fee, verify_range)
  const PtT = bpG.constructor;
  const ptHexT = (h) => PtT.fromHex(String(h).replace(/^0x/, ''));
  const C = (v, rr) => ct.commit(BigInt(v), BigInt(rr));
  assert.ok(ct.verifyKernel({ inC: [C(NOTE_VALUE, NOTE_BLINDING)], outC: [C(NOTE_VALUE, sd.lBlinding)], fee: 0n, kernel: { R: ptHexT(op.kernelR), z: BigInt(op.kernelZ) }, outLeaves: [] }), 'kernel conserves v_in = v_L + fee');
  const lRange = Uint8Array.from(String(op.lRange).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
  assert.ok(bppRangeVerify([C(NOTE_VALUE, sd.lBlinding)], lRange), 'L carries a range proof (v_L < 2^64, so the fee cannot exceed the burn)');
  ok('buildBridgeStealthMintOp finds the burn, completes the public half, serializes for the guest, conserves value');
}

// ── refusals: a mint that is not the burn's ──
{
  const wrong = destFor({ recipientSpendPub: hx(secp.getPublicKey(0x1234567n, true)) })(nu, NOTE_VALUE);
  assert.throws(() => bm.buildBridgeStealthMintOp({ ...r.mintArgs, stealthDest: wrong, snapshot: foldedSnap }), /different destination/, 'another recipient is not what the burn pinned');
  assert.throws(() => bm.buildBridgeStealthMintOp({ ...r.mintArgs, stealthDest: destFor({ deadline: DEADLINE + 86400 })(nu, NOTE_VALUE), snapshot: foldedSnap }), /different destination/, 'another deadline is not what the burn pinned');
  assert.throws(() => bm.buildBridgeStealthMintOp({ ...r.mintArgs, snapshot }), /not found in the reflected state yet/, 'an unfolded state has no burn');
  assert.throws(() => bm.buildBridgeStealthMintOp({ ...r.mintArgs, stealthDest: { ...sd, lockLeaf: '0x' + 'ee'.repeat(32) }, snapshot: foldedSnap }), /own lock leaf/, 'a lock that does not hash to its leaf');
  assert.throws(() => bm.buildBridgeStealthMintOp({ ...r.mintArgs, burned: { ...r.mintArgs.burned, value: NOTE_VALUE - 1n }, snapshot: foldedSnap }), /destination value|not found/, 'a different burned value');
  const w2 = testWallet();
  await assert.rejects(() => burner.broadcastBridgeBurn({ note: { ...note, script: w2.spk }, notePriv: WALLET_PRIV, prims: w2.prims, chainBinding: CHAIN_BINDING, fee: 0n, snapshot, stealthDest: 'not a function', isSpendable: () => true }), /dest.owner/, 'a stealth destination that is not a builder');
  await assert.rejects(() => burner.broadcastBridgeBurn({ note: { ...note, script: w2.spk }, notePriv: WALLET_PRIV, prims: w2.prims, chainBinding: CHAIN_BINDING, fee: 0n, snapshot, stealthDest: (nu2, v) => destFor()(nu2, v - 1n), isSpendable: () => true }), /net of the fee/, 'a stealth lock holding a different value than the burn leaves');
  assert.strictEqual(w2.sent.length, 0, 'nothing was broadcast');
  ok('refuses a mint that is not the burn\'s (recipient, deadline, lock, value) and a burn whose lock holds the wrong value');
}

// ── the two ends ──
{
  const memo = bm.sealStealthLockMemo({ lockerScanPriv: LOCKER_SCAN_PRIV, stealthDest: sd });
  const RECIPIENT_PART = 33 + 112;
  assert.strictEqual((String(memo).length - 2) / 2, RECIPIENT_PART + 177, 'recipient half plus sender tail');
  // the recipient
  const opened = airdrop.openStealthMemo({ recipientSpendPriv: RECIPIENT_PRIV, leaf: sd.lockLeaf, memoHex: memo });
  assert.ok(opened, 'the recipient opens the memo');
  assert.strictEqual(BigInt(opened.amount), NOTE_VALUE);
  assert.strictEqual(opened.ownerPub.toLowerCase(), sd.ownerPub.toLowerCase());
  assert.strictEqual(opened.lBlinding.toLowerCase(), hex32(BigInt(sd.lBlinding)).toLowerCase());
  assert.strictEqual(opened.refundPub.toLowerCase(), sd.refundPub.toLowerCase());
  assert.strictEqual(airdrop.openStealthMemo({ recipientSpendPriv: hex32(0x99n), leaf: sd.lockLeaf, memoHex: memo }), null, 'nobody else opens it');
  const { oneTimePriv } = stealth.recoverOneTimeKey({ recipientSpendPriv: RECIPIENT_PRIV, ephemeralPub: opened.ephemeralPub });
  const mOwner = '0x' + '00'.repeat(31) + '09';
  const claim = stealth.buildStealthClaim({
    chainBinding: CHAIN_BINDING, asset: ASSET, lCx: opened.lCx, lCy: opened.lCy, ownerPub: opened.ownerPub, amount: NOTE_VALUE, deadline: opened.deadline, locker: opened.refundPub,
    lBlinding: opened.lBlinding, lockSetRoot: '0x' + '33'.repeat(32), lIndex: 0, lPath: pool.zeros, oneTimePriv, mOwner, fee: 0n, mBlinding: 0xabcdn,
  });
  const claimMsg = stealth.stealthClaimMsgBlind(CHAIN_BINDING, sd.lockLeaf, claim.mCx, claim.mCy, mOwner, 0n);
  const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
  const fromHex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
  assert.strictEqual(verifySchnorr(fromHex(claim.ownerSig), claimMsg, b32(sd.ownerPub)), true, 'the recipient\'s one-time key claims the lock');
  assert.strictEqual(verifySchnorr(fromHex(hx(signSchnorr(claimMsg, b32(RECIPIENT_PRIV)))), claimMsg, b32(sd.ownerPub)), false, 'the recipient\'s base key does not');
  assert.strictEqual(verifySchnorr(fromHex(hx(signSchnorr(claimMsg, WALLET_PRIV))), claimMsg, b32(sd.ownerPub)), false, 'the burner\'s key does not');
  // the burner, from its key alone
  const tail = '0x' + String(memo).slice(2 + RECIPIENT_PART * 2);
  const sent = airdrop.openStealthSenderTail({ senderPriv: LOCKER_SCAN_PRIV, ephemeralPub: sd.ephemeralPub, leaf: sd.lockLeaf, tailHex: tail });
  assert.ok(sent, 'the burner finds its own lock');
  assert.strictEqual(BigInt(sent.amount), NOTE_VALUE);
  assert.strictEqual(sent.refundPub.toLowerCase(), sd.refundPub.toLowerCase());
  assert.strictEqual(sent.recipientPub.toLowerCase(), RECIPIENT_PUB.toLowerCase(), 'and who it paid');
  assert.strictEqual(airdrop.openStealthSenderTail({ senderPriv: hx(new Uint8Array(32).fill(0x55)), ephemeralPub: sd.ephemeralPub, leaf: sd.lockLeaf, tailHex: tail }), null, 'another key does not find it');
  const refund = stealth.buildStealthRefund({
    chainBinding: CHAIN_BINDING, asset: ASSET, lCx: sent.lCx, lCy: sent.lCy, ownerPub: sent.ownerPub, amount: NOTE_VALUE, deadline: sent.deadline, locker: sent.refundPub, lockerPriv: sent.refundPriv,
    refundOwner: '0x' + '00'.repeat(31) + '0a', lockSetRoot: '0x' + '33'.repeat(32), lIndex: 0, lPath: pool.zeros, lBlinding: sent.lBlinding, fee: 0n, oBlinding: 0xdcban,
  });
  const refundMsg = stealth.stealthRefundMsg(CHAIN_BINDING, sd.lockLeaf, refund.oCx, refund.oCy, 0n, refund.refundOwner);
  assert.strictEqual(verifySchnorr(fromHex(refund.lockerSig), refundMsg, b32(sent.refundPub)), true, 'the refund key takes it back');
  ok('the recipient opens the memo and claims with the one-time key (no other key can); the burner finds the lock from its key and can refund it');
}

// ── the submit: type, memo, stale-root retry, self-settle ──
{
  const specs = [];
  let calls = 0;
  const relay = {
    settle: async (spec) => { specs.push(spec); calls++; if (calls === 1) throw Object.assign(new Error('stale'), { code: 'stale_root' }); return { status: 'settled', jobId: '0x' + '12'.repeat(32), txHash: '0x' + '34'.repeat(32) }; },
    prove: async (spec) => { specs.push(spec); return { status: 'proven', jobId: '0x' + '56'.repeat(32), publicValues: '0xaa', proof: '0xbb' }; },
  };
  const bm2 = makeConfidentialBridgeMint({ pool, ct, relay, stealth, airdrop, fetchImpl: async () => ({ ok: true, json: async () => ({ snapshot: { ...foldedSnap, height: 101 }, attestedHeight: 101 }) }) });
  const out = await bm2.bridgeStealthMint({ ...r.mintArgs, lockerScanPriv: LOCKER_SCAN_PRIV, snapshot: foldedSnap, staleDelayMs: 1 });
  assert.strictEqual(specs.length, 2, 'a stale root is rebuilt once');
  assert.strictEqual(specs[1].type, 'bridgestealthmint');
  assert.strictEqual(specs[1].lockMemos.length, 1, 'one memo for the one lock leaf');
  assert.strictEqual(specs[1].lockMemos[0], bm.sealStealthLockMemo({ lockerScanPriv: LOCKER_SCAN_PRIV, stealthDest: sd }));
  assert.strictEqual(out.destLeaf, sd.lockLeaf);
  assert.strictEqual(out.status, 'settled');
  let selfArgs = null;
  const out2 = await bm2.bridgeStealthMint({ ...r.mintArgs, lockerScanPriv: LOCKER_SCAN_PRIV, snapshot: foldedSnap, selfSettle: async (a) => { selfArgs = a; return { txHash: '0x' + '78'.repeat(32) }; } });
  assert.deepStrictEqual(selfArgs.memos, [out.lockMemo], 'a self-settle carries the lock memo');
  assert.strictEqual(out2.txHash, '0x' + '78'.repeat(32));
  await assert.rejects(() => bm2.bridgeStealthMint({ ...r.mintArgs, snapshot: foldedSnap }), /key is needed/, 'no key, no memo');
  const bare = makeConfidentialBridgeMint({ pool, ct });
  assert.throws(() => bare.stealthDestFor({ asset: ASSET, lockerScanPriv: LOCKER_SCAN_PRIV, nullifier: nu, recipientSpendPub: RECIPIENT_PUB, value: 1n, deadline: DEADLINE }), /stealth and airdrop helpers/, 'unwired helpers refuse');
  ok('bridgeStealthMint submits type bridgestealthmint with the one lock memo, rebuilds on a stale root, self-settles with the memo, and refuses without a key');
}

console.log(`\n${n} bridge-stealth-recipient checks passed`);
