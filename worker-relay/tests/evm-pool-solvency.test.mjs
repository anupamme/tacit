// The monitor's judgement of a device pool's totals against its balance (src/lib/evm-pool-solvency.js), and the keeper's /totals.
//   node worker-relay/tests/evm-pool-solvency.test.mjs
import assert from 'node:assert/strict';
import { solvencyVerdict, poolBooks } from '../src/lib/evm-pool-solvency.js';
import { openKeeperStore } from '../src/lib/evm-pool-keeper-store.js';
import { makeLeafSync } from '../src/lib/evm-pool-keeper-leaves.js';
import { loadZk } from '../src/lib/evm-pool-keeper-prover.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const E = 10n ** 18n;
const totals = (o = {}) => ({ deposits: String(5n * E), withdrawals: String(2n * E), fees: String(E / 100n), leaves: 8, events: 4, through: 1000, ...o });
const chain = (o = {}) => ({ balance: String(3n * E - E / 100n), nextIndex: 8, ...o });

await test('a balance equal to the net of the events, with the leaves it reports, is fine', () => {
  const v = solvencyVerdict(totals(), chain());
  assert.equal(v.level, 'ok'); assert.equal(v.surplus, 0n);
});
await test('ETH sent to the pool directly only raises the balance: still fine, and noted', () => {
  const v = solvencyVerdict(totals(), chain({ balance: String(3n * E) }));
  assert.equal(v.level, 'ok'); assert.match(v.why, /sent to it directly/);
});
await test('a balance under the net pages', () => {
  const v = solvencyVerdict(totals(), chain({ balance: String(3n * E - E / 100n - 1n) }));
  assert.equal(v.level, 'critical'); assert.match(v.why, /under the/);
});
await test('withdrawals and fees above deposits page, however much the pool holds', () => {
  const v = solvencyVerdict(totals({ withdrawals: String(6n * E) }), chain({ balance: String(100n * E) }));
  assert.equal(v.level, 'critical'); assert.match(v.why, /exceed deposits/);
});
await test('a leaf count that is not the pool\'s is a warning (the keeper may be behind), not a page', () => {
  assert.equal(solvencyVerdict(totals(), chain({ nextIndex: 10 })).level, 'warning');
});
await test('the amounts are wei strings of any size', () => {
  const big = 123456789012345678901234567890n;
  const v = solvencyVerdict(totals({ deposits: String(big), withdrawals: '0', fees: '0' }), chain({ balance: String(big) }));
  assert.equal(v.level, 'ok');
});

// The keeper's /totals: sums of the stored events' amounts through the block every one has them.
const zk = await loadZk();
const logs = [[101, 3n * E, 0n], [102, -1n * E, 5n], [103, 2n * E, 0n], [104, -1n * E, 7n]].map(([b, ext, fee], i) => ({
  firstIndex: BigInt(i * 2), outLeaf0: BigInt(b) * 7919n, outLeaf1: 0n, blockNumber: BigInt(b), logIndex: 0, tx: '0x' + b.toString(16).padStart(64, '0'),
  nf0: '0x' + '0'.repeat(63) + '1', nf1: '0x' + '0'.repeat(64), memo0: '0x', memo1: '0x', recipient: '0x' + 'ab'.repeat(20), extAmount: ext, relayer: '0x' + 'cd'.repeat(20), fee, blockTimestamp: null,
}));
const feed = () => {
  const c = { block: 106n, leaves: logs.flatMap((l) => [l.outLeaf0, l.outLeaf1]) };
  c.blockNumber = async () => c.block; c.transactLogs = async (a, b) => logs.filter((l) => l.blockNumber >= a && l.blockNumber <= b);
  c.poolState = async (blk) => { const k = logs.filter((l) => l.blockNumber <= BigInt(blk ?? c.block)).length * 2; return { root: zk.tree(c.leaves.slice(0, k)).root, nextIndex: BigInt(k) }; };
  return c;
};
await test('the keeper totals what went in, what went out and the fees, and counts the leaves through the same block', async () => {
  const store = openKeeperStore(':memory:'), sync = makeLeafSync({ store, chain: feed(), zk, startBlock: 101n, confirmations: 2n, logChunk: 3n });
  await sync.sync();
  const t = sync.totals();
  assert.deepEqual(t, { through: 104, events: 4, deposits: String(5n * E), withdrawals: String(2n * E), fees: '12', leaves: 8 });
  assert.equal(solvencyVerdict(t, { balance: String(3n * E - 12n), nextIndex: 8 }).level, 'ok');
});
await test('the keeper gives no totals while a stored event lacks its amount', async () => {
  const store = openKeeperStore(':memory:'), sync = makeLeafSync({ store, chain: feed(), zk, startBlock: 101n, confirmations: 2n, logChunk: 3n });
  assert.equal(sync.totals(), null, 'nothing synced yet');
  await sync.sync();
  store.updateEvents([{ block: 102, logIndex: 0, ev: { ...store.eventsBetween(102, 102)[0].ev, ext: undefined } }]);   // an event written before amounts were kept
  assert.equal(makeLeafSync({ store, chain: feed(), zk, startBlock: 101n, confirmations: 2n }).totals(), null);
});
// poolBooks: the read and the judgement together, with fake answers.
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const rpcOf = (balance, nextIndex) => async (method) => (method === 'eth_getBalance' ? '0x' + BigInt(balance).toString(16) : '0x' + BigInt(nextIndex).toString(16));
await test('a keeper whose totals match what the chain holds at the same block is ok, and the state is read at the totals\' block', async () => {
  const asked = [];
  const v = await poolBooks({ keeper: 'k', pool: '0xpool', fetchImpl: async () => json(200, totals()), rpc: async (m, p) => { asked.push(p[p.length - 1]); return rpcOf(3n * E - E / 100n, 8)(m); } });
  assert.equal(v.level, 'ok'); assert.deepEqual([...new Set(asked)], ['0x3e8'], 'block 1000');
});
await test('a keeper without totals, or one that answers badly, or a node without the block\'s state, is unknown and pages nobody', async () => {
  assert.equal((await poolBooks({ keeper: 'k', pool: 'p', fetchImpl: async () => json(404, {}), rpc: rpcOf(0, 0) })).level, 'unknown');
  assert.equal((await poolBooks({ keeper: 'k', pool: 'p', fetchImpl: async () => json(503, {}), rpc: rpcOf(0, 0) })).level, 'unknown');
  const v = await poolBooks({ keeper: 'k', pool: 'p', fetchImpl: async () => json(200, totals()), rpc: async () => { throw new Error('missing trie node'); } });
  assert.equal(v.level, 'unknown'); assert.match(v.why, /missing trie node/);
});
await test('a critical reading must be read twice: one odd answer does not stand, two do', async () => {
  let calls = 0;
  const odd = await poolBooks({ keeper: 'k', pool: 'p', fetchImpl: async () => json(200, totals()), rpc: async (m) => (++calls <= 2 ? rpcOf(1n * E, 8)(m) : rpcOf(3n * E - E / 100n, 8)(m)) });
  assert.equal(odd.level, 'ok'); assert.match(odd.why, /read again after/);
  const real = await poolBooks({ keeper: 'k', pool: 'p', fetchImpl: async () => json(200, totals()), rpc: rpcOf(1n * E, 8) });
  assert.equal(real.level, 'critical');
});
console.log(`\n${n} checks passed`);
