// A mint op has a holder's half (commitments, range proof, kernel: needs the openings) and a public half (the burn set's path under the burn
// root, the note tree's path): the public half is read off the reflected state by anyone, so a mint built before its burn was recorded, or on a
// root the pool has moved past, is the same holder's half with a fresh public half. dapp/confidential-bridge-mint.js
//   node --test tests/bridge-mint-complete.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialBridgeMint, destValueFor, txidInternal } from '../dapp/confidential-bridge-mint.js';
import { admitBridgeMint } from '../worker/src/bridgemint-admit.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const bm = makeConfidentialBridgeMint({ pool, ct });
const completer = makeConfidentialBridgeMint({ pool });                    // no ct: it can complete and nothing else
const ASSET = '0x' + 'a5'.repeat(32), CB = '0x' + '7c'.repeat(32), AUTH = '0x' + '00'.repeat(31) + 'b7';
const DEST_OWNER = pool.nkToOwner('0x' + 'c5'.repeat(32)), TX = txidInternal('33'.repeat(31) + '44');

// One burn: the openings, and the state it makes when recorded (the note tree holds the burned note, the burn set holds its burn).
function burn({ vout = 1, cls = 2, value = 1_000_000n, fee = 0n, tx = TX } = {}) {
  const burned = { value, blinding: randomScalar(), owner: cls === 0 ? pool.outpointKey(tx, vout) : AUTH };
  const dest = { value: destValueFor({ burnValue: value, fee }), blinding: randomScalar(), owner: DEST_OWNER };
  const { cx, cy } = pool.commitXY(burned.value, burned.blinding);
  const srcLeaf = bm.sourceLeaf({ sourceClass: cls, asset: ASSET, cx, cy, owner: burned.owner, spentTxid: tx, spentVout: vout, chainBinding: CB });
  const d = pool.commitXY(dest.value, dest.blinding);
  const destLeaf = pool.leaf(ASSET, d.cx, d.cy, DEST_OWNER);
  const burnId = pool.bridgeBurnId(cls === 0 ? 2 : 1, tx, vout, srcLeaf, CB);
  const args = { chainBinding: CB, asset: ASSET, spentTxid: tx, spentVout: vout, sourceClass: cls, burned, dest };
  return { args, srcLeaf, destLeaf, burnId };
}
// The reflected state holding some of these burns (and `extra` filler notes).
function state(burns, { extra = 1 } = {}) {
  const acc = pool.makeUtxoAccumulator();
  for (const b of burns) acc.insert(b.burnId, b.destLeaf);
  const noteLeaves = [...Array.from({ length: extra }, (_, i) => '0x' + (i + 1).toString(16).padStart(64, '0')), ...burns.map((b) => b.srcLeaf)];
  return { snapshot: { noteLeaves, burnNodes: acc.nodes() }, root: acc.root() };
}

test('the holder\'s half names no root and no path, and stands alone', () => {
  const b = burn();
  const parts = bm.bridgeMintParts(b.args);
  for (const k of ['bitcoinBurnRoot', 'poolRoot', 'burnMembership']) assert.equal(parts.op[k], undefined, `${k} is the public half`);
  assert.equal(parts.op.input.path, undefined);
  assert.equal(parts.destLeaf, b.destLeaf);
  assert.equal(parts.burnId, b.burnId);
  assert.deepEqual(bm.verifyBridgeMintParts(parts.op), { ok: true });
});

test('a half-built mint that has been tampered with does not verify', () => {
  const parts = bm.bridgeMintParts(burn({ fee: 100n }).args).op;
  assert.equal(bm.verifyBridgeMintParts({ ...parts, fee: '200' }).ok, false, 'a different fee');
  assert.equal(bm.verifyBridgeMintParts({ ...parts, kernel: { ...parts.kernel, z: '0x' + '01'.padStart(64, '0') } }).ok, false, 'a different kernel');
  const other = bm.bridgeMintParts(burn().args).op;
  assert.equal(bm.verifyBridgeMintParts({ ...parts, rangeProof: other.rangeProof }).ok, false, 'another mint\'s range proof');
  assert.equal(bm.verifyBridgeMintParts({ ...parts, output: other.output }).ok, false, 'another destination');
  assert.equal(bm.verifyBridgeMintParts({}).ok, false, 'nothing');
  assert.equal(bm.verifyBridgeMintParts({ ...parts, fee: '12345' }).ok, false, 'a fee off the ladder');
});

test('completing the holder\'s half against the recorded state gives a mint the door and the guest\'s checks take', () => {
  for (const cls of [0, 1, 2]) {
    const b = burn({ cls, vout: 3 + cls });
    const { snapshot, root } = state([b]);
    const parts = bm.bridgeMintParts(b.args);
    const done = completer.completeBridgeMintOp(parts.op, snapshot);          // needs no ct
    assert.equal(done.op.bitcoinBurnRoot, root);
    assert.equal(done.burnId, b.burnId);
    assert.equal(done.destLeaf, b.destLeaf);
    const r = admitBridgeMint({ pool, op: done.op, knownRoot: root });
    assert.equal(r.ok, true, `class ${cls}: ${JSON.stringify(r)}`);
    assert.equal(r.burnId, b.burnId);
    // And it is the op buildBridgeMintOp makes for the same burn, apart from the proofs' fresh randomness.
    // The other membership the guest checks: the burned note's leaf under the note tree's root, by the path the op carries.
    assert.equal(pool.verifyPath(parts.srcLeaf, done.op.input.leafIndex, done.op.input.path, done.op.poolRoot), true, `class ${cls}: the note-tree path verifies under poolRoot`);
    assert.equal(pool.verifyPath(parts.srcLeaf, done.op.input.leafIndex, done.op.input.path, '0x' + '11'.repeat(32)), false, 'and under no other root');
    const built = bm.buildBridgeMintOp({ ...b.args, snapshot });
    for (const k of ['bitcoinBurnRoot', 'poolRoot', 'sourceClass', 'spentTxid', 'spentVout']) assert.deepEqual(done.op[k], built.op[k], k);
    assert.deepEqual(done.op.burnMembership, built.op.burnMembership);
    assert.deepEqual(done.op.input, built.op.input);
  }
});

test('a mint made before its burn was recorded is completed once it is, and refused with a reason until then', () => {
  const b = burn();
  const parts = bm.bridgeMintParts(b.args);                                   // built at burn time: no reflected state exists for it yet
  const before = state([], { extra: 3 });
  assert.throws(() => completer.completeBridgeMintOp(parts.op, before.snapshot), (e) => e.code === 'note_not_in_tree');
  const noted = state([b]); noted.snapshot.burnNodes = state([]).snapshot.burnNodes;   // the note folded, its burn not yet recorded
  assert.throws(() => completer.completeBridgeMintOp(parts.op, noted.snapshot), (e) => e.code === 'burn_not_recorded');
  const after = state([b]);
  assert.equal(admitBridgeMint({ pool, op: completer.completeBridgeMintOp(parts.op, after.snapshot).op, knownRoot: after.root }).ok, true);
});

test('a mint on a root the pool has moved past is renewed, and the holder\'s half is untouched', () => {
  const b = burn({ vout: 1 }), later = burn({ vout: 2 });
  const s1 = state([b]), s2 = state([b, later]);
  assert.notEqual(s1.root, s2.root, 'a second burn moves the root');
  const old = bm.buildBridgeMintOp({ ...b.args, snapshot: s1.snapshot }).op;
  assert.equal(admitBridgeMint({ pool, op: old, knownRoot: s2.root }).code, 'stale_root', 'the pool\'s root moved past it');
  const renewed = completer.completeBridgeMintOp(old, s2.snapshot).op;
  assert.equal(renewed.bitcoinBurnRoot, s2.root);
  assert.equal(admitBridgeMint({ pool, op: renewed, knownRoot: s2.root }).ok, true, 'and it is a mint the pool takes on the new root');
  for (const k of ['rangeProof', 'fee', 'kernel', 'output', 'chainBinding', 'asset', 'spentTxid', 'spentVout', 'sourceClass']) assert.deepEqual(renewed[k], old[k], `${k} is the holder's and is kept`);
  assert.deepEqual(renewed.input.cx, old.input.cx);
  assert.deepEqual(completer.completeBridgeMintOp(renewed, s2.snapshot).op, renewed, 'renewing a renewed mint changes nothing');
  assert.equal(bm.verifyBridgeMintParts(renewed).ok, true, 'the proofs still verify');
});

test('a burn that pinned a different destination is refused, not completed', () => {
  const b = burn(), elsewhere = burn();
  const { snapshot } = state([b]);
  // The same burned note and outpoint, a destination of the holder's own choosing: the burn set holds the other one.
  const forged = bm.bridgeMintParts({ ...b.args, dest: elsewhere.args.dest });
  assert.throws(() => completer.completeBridgeMintOp(forged.op, snapshot), (e) => e.code === 'dest_mismatch');
});

test('a note tree is built once and shared by every mint completed on it', () => {
  const bs = [burn({ vout: 1 }), burn({ vout: 2 }), burn({ vout: 3 })];
  const { snapshot, root } = state(bs);
  const r = completer.prepareReflection(snapshot);
  for (const b of bs) assert.equal(admitBridgeMint({ pool, op: completer.completeBridgeMintOp(bm.bridgeMintParts(b.args).op, r).op, knownRoot: root }).ok, true);
  assert.equal(completer.prepareReflection(r), r, 'a prepared state is taken as it is');
});

test('a completer with no ct cannot build', () => {
  assert.throws(() => completer.bridgeMintParts(burn().args), /ct is required/);
});
