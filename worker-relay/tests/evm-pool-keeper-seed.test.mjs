// Seeding a fresh keeper store from another keeper's feed (src/lib/evm-pool-keeper-seed.js): the leaves are checked against the pool's
// root and count at the feed's last block, a feed that does not match seeds nothing, and a store with anything in it is left alone.
// node --test tests/evm-pool-keeper-seed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedFromFeed } from '../src/lib/evm-pool-keeper-seed.js';
import { openKeeperStore } from '../src/lib/evm-pool-keeper-store.js';
import { loadZk } from '../src/lib/evm-pool-keeper-prover.js';

const zk = await loadZk();
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
const leaves = [11n, 22n, 33n, 44n, 55n, 66n];
const tx = (i, block) => ({ kind: 'transact', block, tx: null, firstIndex: i * 2, nf0: '1', nf1: '2', outLeaf0: String(leaves[i * 2]), outLeaf1: String(leaves[i * 2 + 1]), memo0: '0x', memo1: '0x' });
const pages = [
  { chainId: 8453, pool: POOL, from: 100, through: 150, events: [tx(0, 120), { kind: 'received', block: 121, box: '0xabc', n: '1', index: 0, value: '5', rho: '7', fee: '1' }, tx(1, 140)] },
  { chainId: 8453, pool: POOL, from: 151, through: 200, events: [tx(2, 180)] },
  { chainId: 8453, pool: POOL, from: 201, through: 230, events: [] },
];
const feed = (ps = pages) => async (url) => {
  const from = Number(new URL(url).searchParams.get('from'));
  const p = ps.find((x) => x.from === from) || { chainId: 8453, pool: POOL, from, through: from - 1, events: [] };
  return { ok: true, json: async () => p };
};
const rootOf = (ls) => { const t = zk.incTree(); t.append(ls); return { root: t.root, nextIndex: t.size }; };
const chain = (state) => ({ chainId: 8453, pool: POOL, poolState: async (block) => { assert.equal(block, 230n, 'the pool is read at the feed\'s last block'); return state; } });

test('a feed whose leaves match the pool seeds the store through the feed\'s last block, events in order', async () => {
  const store = openKeeperStore(':memory:');
  const r = await seedFromFeed({ store, chain: chain(rootOf(leaves)), zk, feedUrl: 'https://old/evm-pool/keeper/', startBlock: 100n, fetchImpl: feed() });
  assert.deepEqual(r, { seeded: true, leaves: 6, events: 4, through: 230 });
  assert.equal(store.leafCount(), 6); assert.equal(store.syncedBlock(), 230);
  assert.deepEqual(store.leaves().map(String), leaves.map(String));
  const ev = store.eventsBetween(0, 1000);
  assert.deepEqual(ev.map((e) => [e.block, e.logIndex, e.ev.kind]), [[120, 0, 'transact'], [121, 0, 'received'], [140, 0, 'transact'], [180, 0, 'transact']]);
  const again = await seedFromFeed({ store, chain: chain(rootOf(leaves)), zk, feedUrl: 'https://old', fetchImpl: feed() });
  assert.equal(again.seeded, false, 'a store with leaves is left alone');
  // a part-replayed store is emptied and seeded only when asked
  const partial = openKeeperStore(':memory:');
  partial.appendLeaves([{ leaf: 11n, block: 120n }, { leaf: 22n, block: 120n }], 125, []);
  const kept = await seedFromFeed({ store: partial, chain: chain(rootOf(leaves)), zk, feedUrl: 'https://old', startBlock: 100n, fetchImpl: feed() });
  assert.equal(kept.seeded, false); assert.equal(partial.leafCount(), 2);
  const reset = await seedFromFeed({ store: partial, chain: chain(rootOf(leaves)), zk, feedUrl: 'https://old', startBlock: 100n, reset: true, fetchImpl: feed() });
  assert.equal(reset.seeded, true); assert.equal(partial.leafCount(), 6); assert.equal(partial.syncedBlock(), 230);
});

test('a feed that does not match the pool seeds nothing', async () => {
  const store = openKeeperStore(':memory:');
  await assert.rejects(seedFromFeed({ store, chain: chain(rootOf([11n, 22n, 33n, 44n])), zk, feedUrl: 'https://old', startBlock: 100n, fetchImpl: feed() }), /the pool holds 4/);
  assert.equal(store.leafCount(), 0); assert.equal(store.syncedBlock(), null);
  const other = { ...pages[0], chainId: 1 };
  await assert.rejects(seedFromFeed({ store, chain: chain(rootOf(leaves)), zk, feedUrl: 'https://old', startBlock: 100n, fetchImpl: feed([other]) }), /for chain 1/);
  const gap = [{ ...pages[0], events: [tx(0, 120), tx(2, 140)] }, pages[2]];
  await assert.rejects(seedFromFeed({ store, chain: chain(rootOf(leaves)), zk, feedUrl: 'https://old', startBlock: 100n, fetchImpl: feed(gap) }), /Transact at index 4, expected 2/);
  assert.equal(store.leafCount(), 0);
});

test('an empty feed seeds nothing and says so', async () => {
  const store = openKeeperStore(':memory:');
  const r = await seedFromFeed({ store, chain: chain(rootOf([])), zk, feedUrl: 'https://old', startBlock: 100n, fetchImpl: feed([]) });
  assert.equal(r.seeded, false);
});
