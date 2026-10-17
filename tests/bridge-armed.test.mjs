// worker/src/bridge-armed.js: a mint the holder built at burn time is kept (only the holder's half, nothing secret), completed once its burn
// is recorded on the root the pool holds, and queued as an ordinary job; a mint on a root the pool has moved past is renewed.
//   node --test tests/bridge-armed.test.mjs
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
import { makeArmedMints, readArmedOp, readArmedMemos, MAX_ARMED } from '../worker/src/bridge-armed.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const bm = makeConfidentialBridgeMint({ pool, ct });
const ASSET = '0x' + 'a5'.repeat(32), CB = '0x' + '7c'.repeat(32), AUTH = '0x' + '00'.repeat(31) + 'b7';
const DEST_OWNER = pool.nkToOwner('0x' + 'c5'.repeat(32)), TX = txidInternal('33'.repeat(31) + '44');

function burn(vout) {
  const burned = { value: 1_000_000n, blinding: randomScalar(), owner: AUTH };
  const dest = { value: destValueFor({ burnValue: burned.value }), blinding: randomScalar(), owner: DEST_OWNER };
  const args = { chainBinding: CB, asset: ASSET, spentTxid: TX, spentVout: vout, sourceClass: 2, burned, dest };
  return { parts: bm.bridgeMintParts(args), memos: ['0x' + 'ab'.repeat(40)] };
}
function memKv() {
  const m = new Map(), ttl = [];
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v, o) => { m.set(k, String(v)); ttl.push([k, o && o.expirationTtl]); }, delete: async (k) => { m.delete(k); }, _m: m, _ttl: ttl };
}
const locks = new Map();
const lock = async (key, fn) => { const prev = locks.get(key) || Promise.resolve(); const run = prev.then(fn, fn); locks.set(key, run.catch(() => {})); return run; };

// The world: the burns the reflection has recorded, the root the pool holds, what has minted, and what the door answers.
function world({ burns = [] } = {}) {
  const w = { burns: [...burns], chainRoot: null, ahead: false, minted: new Set(), submits: [], door: () => ({ status: 200, body: { ok: true, jobId: '0x' + 'e1'.repeat(32) } }) };
  w.state = () => {
    const acc = pool.makeUtxoAccumulator();
    for (const b of w.burns) acc.insert(b.parts.burnId, b.parts.destLeaf);
    const noteLeaves = ['0x' + '01'.repeat(32), ...w.burns.map((b) => b.parts.srcLeaf)];
    return { snapshot: { noteLeaves, burnNodes: acc.nodes() }, root: acc.root() };
  };
  w.sync = () => { w.chainRoot = w.state().root; };
  w.sync();
  return w;
}
function build(w, kv = memKv()) {
  const a = makeArmedMints({
    kv, lock, bm,
    reflection: async () => { const s = w.state(); const prepared = bm.prepareReflection(s.snapshot); return { prepared, burnRoot: s.root, height: 1 }; },
    chainBurnRoot: async () => (w.ahead ? '0x' + 'ff'.repeat(32) : w.chainRoot),
    isMinted: async (id) => w.minted.has(id),
    submit: async (x) => { w.submits.push(x); return w.door(x); },
  });
  return { a, kv };
}

test('the shape of a mint op and of its memos is checked, and only the holder\'s fields are kept', () => {
  const b = burn(1);
  const ok = readArmedOp({ ...b.parts.op, extra: 'x'.repeat(10000), burnMembership: { next: 'junk' } });
  assert.ok(ok.op, JSON.stringify(ok));
  assert.equal(ok.op.extra, undefined);
  assert.equal(ok.op.burnMembership, undefined, 'a public half sent along is not kept');
  for (const bad of [null, {}, { ...b.parts.op, sourceClass: 7 }, { ...b.parts.op, spentVout: -1 }, { ...b.parts.op, fee: 'x' }, { ...b.parts.op, kernel: { R: '0x04', z: '0x01' } }, { ...b.parts.op, rangeProof: '0x12' }]) {
    assert.ok(readArmedOp(bad).error, `refused: ${JSON.stringify(bad).slice(0, 60)}`);
  }
  assert.ok(readArmedMemos(['0xabcd']).memos);
  for (const bad of [[], 'x', ['zz'], ['0x' + 'ab'.repeat(3000)], new Array(5).fill('0xab')]) assert.ok(readArmedMemos(bad).error);
});

test('arming keeps only the holder\'s half, until the burn is recorded', async () => {
  const w = world(), { a, kv } = build(w), b = burn(1);
  const r = await a.arm({ op: b.parts.op, memos: b.memos });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'armed');
  assert.equal(r.dest, b.parts.destLeaf);
  const rec = JSON.parse(kv._m.get(`cps:armed:${b.parts.destLeaf}`));
  assert.equal(rec.op.bitcoinBurnRoot, undefined, 'no public half is stored');
  assert.equal(rec.op.burnMembership, undefined);
  assert.ok(kv._ttl.every(([, t]) => t === 14 * 86400), 'every write expires in two weeks');
  assert.deepEqual(w.submits, [], 'nothing is queued while the burn is not recorded');
  assert.equal((await a.arm({ op: b.parts.op, memos: b.memos })).status, 'armed', 'arming the same mint again is the same record');
  assert.deepEqual(JSON.parse(kv._m.get('cps:armed:index')), [b.parts.destLeaf], 'and one entry in the index');
  assert.deepEqual(await a.sweep(), { armed: 1, queued: 0, minted: 0, failed: 0, dropped: 0 });
  assert.equal((await a.status(b.parts.destLeaf)).status, 'armed');
  assert.equal(await a.status('0x' + '00'.repeat(32)), null);
  assert.equal(await a.status('junk'), null);
});

test('a mint that does not verify, or is not a mint, is refused and keeps no room', async () => {
  const w = world(), { a, kv } = build(w), b = burn(1), other = burn(2);
  assert.equal((await a.arm({ op: { ...b.parts.op, rangeProof: other.parts.op.rangeProof }, memos: b.memos })).code, 'bad_proof');
  assert.equal((await a.arm({ op: { ...b.parts.op, fee: '300' }, memos: b.memos })).code, 'bad_proof', 'a fee the kernel was not signed for');
  assert.equal((await a.arm({ op: {}, memos: b.memos })).code, 'bad_op');
  assert.equal((await a.arm({ op: b.parts.op, memos: [] })).code, 'bad_memos');
  assert.equal(kv._m.size, 0);
});

test('once its burn is recorded on the root the pool holds, the mint is completed and queued as an ordinary job', async () => {
  const b = burn(1), w = world(), { a } = build(w);
  await a.arm({ op: b.parts.op, memos: b.memos });
  w.burns.push(b); w.sync();                                                    // the reflection records it and the pool takes the root
  const out = await a.sweep();
  assert.equal(out.queued, 1);
  assert.equal(w.submits.length, 1);
  const sent = w.submits[0];
  assert.deepEqual(sent.memos, b.memos);
  const adm = admitBridgeMint({ pool, op: sent.op, knownRoot: w.chainRoot });
  assert.equal(adm.ok, true, JSON.stringify(adm));
  assert.equal(adm.burnId, b.parts.burnId);
  assert.equal((await a.status(b.parts.destLeaf)).status, 'queued');
  assert.equal((await a.status(b.parts.destLeaf)).jobId, '0x' + 'e1'.repeat(32));
  await a.sweep();
  assert.equal(w.submits.length, 1, 'it is not queued twice');
  w.minted.add(b.parts.burnId);
  assert.equal((await a.sweep()).minted, 1);
  assert.equal((await a.status(b.parts.destLeaf)).status, 'minted');
});

test('a reflection that is ahead of the chain waits, and one behind it does too', async () => {
  const b = burn(1), w = world({ burns: [] }), { a } = build(w);
  await a.arm({ op: b.parts.op, memos: b.memos });
  w.burns.push(b);                                                              // recorded in the saved state; the pool has not taken the root
  assert.equal(w.chainRoot === w.state().root, false);
  await a.sweep();
  assert.deepEqual(w.submits, [], 'the root it would carry is not the pool\'s yet');
  w.sync();
  await a.sweep();
  assert.equal(w.submits.length, 1);
});

test('a burn already recorded when the mint is armed is queued at once', async () => {
  const b = burn(1), w = world({ burns: [burn(9)] });
  w.burns.push(b); w.sync();
  const { a } = build(w);
  const r = await a.arm({ op: b.parts.op, memos: b.memos });
  assert.equal(r.status, 'queued');
  assert.equal(w.submits.length, 1);
});

test('a burn that has already minted is not armed', async () => {
  const b = burn(1), w = world();
  w.minted.add(b.parts.burnId);
  const { a, kv } = build(w);
  assert.equal((await a.arm({ op: b.parts.op, memos: b.memos })).status, 'minted');
  assert.equal(kv._m.size, 0);
});

test('a refusal that is only "not now" keeps the mint armed; one that is final fails it after a few tries', async () => {
  const b = burn(1), w = world({ burns: [] }), { a } = build(w);
  w.burns.push(b); w.sync();
  w.door = () => ({ status: 429, body: { ok: false, code: 'free_budget' } });
  assert.equal((await a.arm({ op: b.parts.op, memos: b.memos })).status, 'armed');
  for (let i = 0; i < 8; i++) await a.sweep();
  assert.equal((await a.status(b.parts.destLeaf)).status, 'armed', 'today\'s allowance used up is not a reason to give up');
  w.door = () => ({ status: 200, body: { ok: true, jobId: '0x' + 'e2'.repeat(32) } });
  await a.sweep();
  assert.equal((await a.status(b.parts.destLeaf)).status, 'queued');
  const c = burn(2); w.burns.push(c); w.sync();
  w.door = () => ({ status: 400, body: { ok: false, code: 'not_a_burn', error: 'no' } });
  await a.arm({ op: c.parts.op, memos: c.memos });
  for (let i = 0; i < 8; i++) await a.sweep();
  assert.equal((await a.status(c.parts.destLeaf)).status, 'failed');
});

test('a full house refuses another', async () => {
  const w = world(), { a, kv } = build(w), b = burn(1);
  await kv.put('cps:armed:index', JSON.stringify(Array.from({ length: MAX_ARMED }, (_, i) => '0x' + i.toString(16).padStart(64, '0'))));
  assert.equal((await a.arm({ op: b.parts.op, memos: b.memos })).code, 'armed_full');
});

test('a mint on a root the pool has moved past is renewed, when the reflection is the pool\'s', async () => {
  const b = burn(1), later = burn(2), w = world({ burns: [b] });
  const old = bm.completeBridgeMintOp(b.parts.op, w.state().snapshot).op;
  const { a } = build(w);
  w.burns.push(later); w.sync();
  assert.equal(admitBridgeMint({ pool, op: old, knownRoot: w.chainRoot }).code, 'stale_root');
  const r = await a.renew(old);
  assert.equal(r.ok, true);
  assert.equal(admitBridgeMint({ pool, op: r.op, knownRoot: w.chainRoot }).ok, true);
  w.ahead = true;
  assert.equal((await a.renew(old)).code, 'reflection_not_current');
  w.ahead = false;
  assert.equal((await a.renew({ ...old, sourceClass: 9 })).code, 'bad_op');
});
