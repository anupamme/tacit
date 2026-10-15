// worker/src/bridgemint-admit.js: a relayed bridge mint is admitted only when it is the mint of a recorded burn, to the destination
// that burn pinned, built on the burn set the pool holds. Junk (and a mint built on an older set) is turned back before it costs a settle.
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
const ASSET = '0x' + 'a5'.repeat(32), CHAIN_BINDING = '0x' + '7c'.repeat(32), AUTH_KEY = '0x' + '00'.repeat(31) + 'b7';
const DEST_OWNER = pool.nkToOwner('0x' + 'c5'.repeat(32));
const SPENT_TXID = txidInternal('33'.repeat(31) + '44'), SPENT_VOUT = 1;

function mint(sourceClass, burnValue = 1_000_000n) {
  const burned = { value: burnValue, blinding: randomScalar(), owner: AUTH_KEY };
  const dest = { value: destValueFor({ burnValue }), blinding: randomScalar(), owner: DEST_OWNER };
  const { cx, cy } = pool.commitXY(burned.value, burned.blinding);
  const srcLeaf = bm.sourceLeaf({ sourceClass, asset: ASSET, cx, cy, owner: AUTH_KEY, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, chainBinding: CHAIN_BINDING });
  const d = pool.commitXY(dest.value, dest.blinding);
  const destLeaf = pool.leaf(ASSET, d.cx, d.cy, DEST_OWNER);
  const burnId = pool.bridgeBurnId(sourceClass === 0 ? 2 : 1, SPENT_TXID, SPENT_VOUT, srcLeaf, CHAIN_BINDING);
  const burns = pool.makeUtxoAccumulator();
  burns.insert('0x' + '00'.repeat(31) + '07', '0x' + '00'.repeat(31) + '99');
  burns.insert(burnId, destLeaf);
  const snapshot = { noteLeaves: ['0x' + '01'.repeat(32), srcLeaf, '0x' + '03'.repeat(32)], burnNodes: burns.nodes() };
  const built = bm.buildBridgeMintOp({ chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: SPENT_VOUT, sourceClass, burned, dest, snapshot });
  return { op: JSON.parse(JSON.stringify(built.op)), root: built.op.bitcoinBurnRoot, burnId: built.burnId };
}

for (const cls of [0, 1, 2]) {
  test(`the mint of a recorded burn (source class ${cls}) is admitted, with its burn id`, () => {
    const m = mint(cls);
    const r = admitBridgeMint({ pool, op: m.op, knownRoot: m.root });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.burnId.toLowerCase(), m.burnId.toLowerCase());
  });
}

test('a mint built on an older burn set is turned back as stale, so the client rebuilds it', () => {
  const m = mint(2);
  const r = admitBridgeMint({ pool, op: m.op, knownRoot: '0x' + 'ab'.repeat(32) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'stale_root');
  assert.equal(r.status, 409);
});

test('a mint whose destination is not the one the burn pinned is refused', () => {
  const m = mint(2);
  m.op.output.owner = '0x' + 'dd'.repeat(32);
  const r = admitBridgeMint({ pool, op: m.op, knownRoot: m.root });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_a_burn');
});

test('a mint of a burn that is not recorded (another outpoint) is refused', () => {
  const m = mint(1);
  m.op.spentVout = 7;
  assert.equal(admitBridgeMint({ pool, op: m.op, knownRoot: m.root }).ok, false);
});

test('a self-consistent forgery under a root the pool does not hold is refused', () => {
  const real = mint(2), fake = mint(2);
  fake.op.input.cx = real.op.input.cx;                 // a copied public note, with another mint's path
  assert.equal(admitBridgeMint({ pool, op: fake.op, knownRoot: real.root }).ok, false);
});

test('junk of any shape is refused without throwing', () => {
  for (const op of [null, {}, { sourceClass: 2 }, { ...mint(2).op, burnMembership: { next: '0x00', index: 0, path: [] } }, { ...mint(2).op, asset: 'nope' }]) {
    const r = admitBridgeMint({ pool, op, knownRoot: '0x' + 'ab'.repeat(32) });
    assert.equal(r.ok, false);
  }
});

test('when the pool\'s root could not be read nothing is held back (a failed read never blocks a mint)', () => {
  const m = mint(2);
  assert.equal(admitBridgeMint({ pool, op: m.op, knownRoot: null }).ok, true);
  m.op.output.owner = '0x' + 'dd'.repeat(32);
  assert.equal(admitBridgeMint({ pool, op: m.op, knownRoot: null }).ok, true, 'the burn is not checked at all without the pool\'s own root');
});
