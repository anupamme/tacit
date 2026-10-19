#!/usr/bin/env node
// A FULL-SCAN reflection input whose TAC burn-deposit descends from the etch through HOPS conserving transfers in a
// row (the fixed-supply path of gen-reflection-burn-deposit.mjs, one transfer per block): what a two-step bridge of a
// note with a long history hands the guest. Native-execute it to see the guest fold it and what the history costs:
//
//   HOPS=256 node tests/gen-reflection-burn-deposit-chain.mjs > /tmp/burndep-256.json
//   REFLECT_ELF=contracts/sp1/confidential/elf/reflection-prover reflect-execute /tmp/burndep-256.json
//
// HOPS defaults to 1; the guest takes at most 256 transfers in one provenance (cxfer-core ProvenanceBlob::parse).

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialProver } from '../dapp/evm-confidential.js';
import { bppRangeProve } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeBurnDepositAssembler } from '../dapp/burn-deposit-assembler.js';
import { makeBurnDepositKit } from '../dapp/burn-deposit-bitcoin.js';
import { computeTxid, computeMerkleRoot, bitsToTarget, dsha256, varint, cat } from './btc-mini.mjs';

const HOPS = Number(process.env.HOPS || 1);
if (!(Number.isInteger(HOPS) && HOPS >= 1)) throw new Error('HOPS must be a positive integer');

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const prover = makeConfidentialProver({ secp, keccak256: keccak_256, sha256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const G = secp.ProjectivePoint.BASE;
const N = secp.CURVE.n;
const bytesToBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const compress = (P) => P.toRawBytes(true);
const hexp = (b) => '0x' + Buffer.from(b).toString('hex');
const xyHex = (P) => { const a = P.toAffine(); return { cx: '0x' + a.x.toString(16).padStart(64, '0'), cy: '0x' + a.y.toString(16).padStart(64, '0') }; };
function taggedHash(tag, msg) { const th = sha256(new TextEncoder().encode(tag)); return sha256(_cat([th, th, msg])); }
function bip340Sign(msg, dIn) {
  let d = dIn % N; if (d === 0n) throw new Error('zero key');
  if (G.multiply(d).toAffine().y & 1n) d = N - d;
  const Px = be(G.multiply(d).toAffine().x);
  let k = bytesToBig(sha256(_cat([be(d), msg]))) % N; if (k === 0n) k = 1n;
  if (G.multiply(k).toAffine().y & 1n) k = N - k;
  const Rx = be(G.multiply(k).toAffine().x);
  const e = bytesToBig(taggedHash('BIP0340/challenge', _cat([Rx, Px, msg]))) % N;
  return { sig: _cat([Rx, be((k + e * d) % N)]), px: Px };
}
function revealTx(payload, prevTxid, prevVout) {
  const tapscript = cat([
    [0x20], Buffer.alloc(32), [0xac], [0x00, 0x63],
    [0x05], Buffer.from('TACIT'), [0x01, 0x01],
    [0x4d], Buffer.from([payload.length & 0xff, (payload.length >> 8) & 0xff]), payload,
    [0x68],
  ]);
  const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
  return cat([
    [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
    [0x01], Buffer.from(prevTxid), u32le(prevVout), [0x00], [0xfd, 0xff, 0xff, 0xff],
    [0x01], Buffer.alloc(8), [0x00],
    wit0,
    Buffer.alloc(4),
  ]);
}
function mineLinked(merkleRoot, prev, bits = 0x1f00ffff) {
  const target = bitsToTarget(bits);
  const h = Buffer.alloc(80);
  h.writeUInt32LE(0x20000000, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(merkleRoot).copy(h, 36);
  h.writeUInt32LE(1700000000, 68);
  h.writeUInt32LE(bits, 72);
  for (let nonce = 0; nonce < 0xffffffff; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (Buffer.compare(Buffer.from(dsha256(h)).reverse(), target) <= 0) return h;
  }
  throw new Error('no nonce');
}
// Each block is [coinbase, tx]; the coinbase's witness commitment binds the two-leaf wtxid tree. `tag` keeps every
// block's coinbase distinct.
function witnessBlock(tx, tag) {
  const reserved = Buffer.alloc(32); reserved.writeUInt32LE(tag >>> 0, 0);
  const wtxid = dsha256(tx);
  const witnessRoot = dsha256(cat([Buffer.alloc(32), wtxid]));
  const commitment = dsha256(cat([witnessRoot, reserved]));
  const coinbase = cat([
    [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
    [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
    [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], commitment,
    [0x01], [0x20], reserved, Buffer.alloc(4),
  ]);
  const txid = computeTxid(tx), coinbaseTxid = computeTxid(coinbase);
  return { coinbase: hexp(coinbase), txids: [coinbaseTxid, txid], wtxids: [Buffer.alloc(32), wtxid], root: computeMerkleRoot([coinbaseTxid, txid]) };
}

const ANCHOR_HEIGHT = 308800;
const S = 1000n, r0 = 0x5151n;
const C0 = prover.commit(S, r0), C0c = compress(C0);
const { proof: c0Range } = bppRangeProve([S], [r0]);
const cetch = cat([[0x21], [0x03], Buffer.from('TAC'), [0x08], C0c, Buffer.alloc(8), u16le(c0Range.length), c0Range, Buffer.alloc(32), [0x00, 0x00]]);
const etchTx = revealTx(cetch, Buffer.alloc(32), 0);
const etchTxid = computeTxid(etchTx);
const assetId = sha256(cat([etchTxid, u32le(0)]));
const assetHex = hexp(assetId);
const etchBlock = witnessBlock(etchTx, 1);
const etchHdr = mineLinked(etchBlock.root, Buffer.alloc(32));

// The chain: hop k spends hop k−1's output 0 (hop 1 spends C_0) into a fresh blinding, value unchanged.
const provHdrs = [etchHdr];
const cxfers = [];
let prev = { txid: etchTxid, C: C0, Cc: C0c, r: r0 };
for (let k = 1; k <= HOPS; k++) {
  const r = 0x6262n + BigInt(k);
  const out = prover.commit(S, r), outC = compress(out);
  const { proof: range } = bppRangeProve([S], [r]);
  const excess = ((prev.r - r) % N + N) % N;
  const kmsg = sha256(_cat([
    new TextEncoder().encode('tacit-kernel-v1'), assetId, new Uint8Array([1]), prev.txid, u32le(0), new Uint8Array([1]), outC, u64le(0n),
  ].map((x) => Uint8Array.from(x))));
  const { sig, px } = bip340Sign(kmsg, excess);
  if (Buffer.compare(Buffer.from(compress(prev.C.add(out.negate())).slice(1)), Buffer.from(px)) !== 0) throw new Error(`hop ${k} not conserving`);
  const env = cat([[0x22], assetId, sig, [0x01], outC, Buffer.alloc(8), u16le(range.length), range]);
  const tx = revealTx(env, prev.txid, 0), txid = computeTxid(tx);
  const block = witnessBlock(tx, 100 + k);
  provHdrs.push(mineLinked(block.root, dsha256(provHdrs[provHdrs.length - 1])));
  cxfers.push({
    tx: hexp(tx), txid: hexp(txid), inputs: [{ prevTxid: hexp(prev.txid), prevVout: 0, commitment: hexp(prev.Cc) }],
    outputs: [{ commitment: hexp(outC), vout: 0 }], burnedAmount: 0, inputSkip: 0,
    rangeProof: hexp(range), kernelSig: hexp(sig), blockTxids: block.txids, blockWtxids: block.wtxids, coinbase: block.coinbase, index: 1,
  });
  prev = { txid, C: out, Cc: outC, r };
}
const lastProvHdr = provHdrs[provHdrs.length - 1];
const burnedTxidHex = hexp(prev.txid);
const { cx: burnedCx, cy: burnedCy } = xyHex(prev.C);

const burnedOwner = pool.outpointKey(burnedTxidHex, 0);
const burnedNoteLeaf = pool.leaf(assetHex, burnedCx, burnedCy, burnedOwner);
const envNu = pool.nullifier(burnedNoteLeaf);
const envDest = '0x' + 'dd'.repeat(32), envTarget = '0x' + '7c'.repeat(32);
const burnEnv = cat([[0x2b], assetId, Buffer.alloc(32), Buffer.from(envNu.slice(2), 'hex'), Buffer.from(envDest.slice(2), 'hex'), Buffer.from(envTarget.slice(2), 'hex')]);
const bdAssembler = makeBurnDepositAssembler({ dsha256, cat, bytesToHex: hexp });
const provStatic = bdAssembler.buildBurnDepositStatic({
  etch: { tx: hexp(etchTx), blockTxids: etchBlock.txids, blockWtxids: etchBlock.wtxids, coinbase: etchBlock.coinbase, index: 1 },
  provHeaders: provHdrs.map((h) => hexp(h)), cxfers, cmints: [],
});
const provBlob = bdAssembler.serializeProvenanceBlob(provStatic);
const burnTx = revealTx(burnEnv, prev.txid, 0);
const burnBlock = witnessBlock(burnTx, 4);
const burnWit = bdAssembler.witnessPath({ blockTxids: burnBlock.txids, blockWtxids: burnBlock.wtxids, coinbase: burnBlock.coinbase, index: 1 }, 'burn');
const burnHdr = mineLinked(burnBlock.root, dsha256(lastProvHdr));

// The JS mirror the API runs before a fold must agree the history is admissible.
const kit = makeBurnDepositKit({ secp, keccak256: keccak_256, sha256 });
const admitStarted = Date.now();
const verdict = kit.admitBurnDeposit({
  burnTxHex: hexp(burnTx), envAsset: assetHex, envNu, blobHex: hexp(provBlob), provHeaders: [...provHdrs, burnHdr].map((h) => hexp(h)),
  burnedCx, burnedCy, batchPrevHash: hexp(dsha256(burnHdr)),
});
const admitMs = Date.now() - admitStarted;

const state = pool.makeScanReflectionState();
state.setHeight(ANCHOR_HEIGHT - 1);
const c0 = state.counts();
const prior = {
  poolRoot: state.poolRoot(), noteCount: c0.note, spentRoot: state.spentRoot(), spentCount: c0.spent, live: [], liveCount: 0,
  burnRoot: state.burnRoot(), burnCount: c0.burn, height: c0.height, cbtcLocks: [], cbtcBackingSats: 0,
};
const burnDeposit = bdAssembler.assembleBurnDeposit({
  burnWtxidSiblings: burnWit.wtxidSiblings, burnCbTxidSiblings: burnWit.coinbaseTxidSiblings,
  burned: { cx: burnedCx, cy: burnedCy }, burnedTxid: burnedTxidHex, burnedVout: 0, burnedNoteLeaf,
  nu: envNu, dest: envDest, target: envTarget, scanState: state, provHeaders: provHdrs.map((h) => hexp(h)), blob: hexp(provBlob),
});
burnDeposit.pendingInsert = pool.makeScanReflectionState().foldPendingDeposit({
  burnedTxid: burnedTxidHex, burnedVout: 0, asset: assetHex, nu: envNu, dest: envDest, target: envTarget,
});
state.setHeight(ANCHOR_HEIGHT);
const fixture = {
  note: `TAC burn-deposit through ${HOPS} transfer(s): C_0 → ${HOPS} conserving cxfers → burned note → 0x2B burn.`,
  prior, anchorHeight: ANCHOR_HEIGHT, headers: [hexp(burnHdr)],
  blocks: [{ txs: [
    { txData: burnBlock.coinbase, openings: [], spentInserts: [], outputs: [], burnDeposit: null },
    { txData: hexp(burnTx), openings: [], spentInserts: [], outputs: [], burnDeposit },
  ] }],
  newDigest: state.digest(),
};
console.error(`hops=${HOPS} blob=${(provBlob.length / 1024).toFixed(0)} KiB mirror=${verdict.admitted ? 'admitted' : 'refused: ' + verdict.reason} in ${admitMs} ms newDigest=${fixture.newDigest}`);
console.log(JSON.stringify(fixture));
