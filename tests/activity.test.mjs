// dapp/activity.js, the Activity journal every page reads: what has ended, what is still going (a bridge's burn that settled is still going
// until its Bitcoin step has landed), and a journal that cannot be read is an empty one.
//   node tests/activity.test.mjs
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
const A = await import('../dapp/activity.js');

const put = (items) => mem.set(A.ACT_KEY, JSON.stringify({ items, cleared: 0 }));
const pub = '02' + 'ab'.repeat(32), burn = '0x' + 'cd'.repeat(32);

assert.deepEqual(A.readActivity(), { items: [], cleared: 0 }, 'no journal: nothing in it');
mem.set(A.ACT_KEY, '{not json'); assert.deepEqual(A.readActivity().items, [], 'a journal that cannot be read is empty');

put([
  { id: 'job:1', kind: 'job', status: 'proving' },
  { id: 'job:2', kind: 'job', status: 'settled' },
  { id: 'tx:1:0x1', kind: 'tx', status: 'pending' },
  { id: 'tx:1:0x2', kind: 'tx', status: 'confirmed', in: 'op:9' },                 // a step inside another entry: not listed on its own
  { id: 'btc:3', kind: 'btc', status: 'stale' },
  { id: 'x', kind: 'nonsense', status: 'whatever' },                                 // an unknown kind is dropped on reading
  { kind: 'job', status: 'proving' },                                                // so is one with no id
]);
const items = A.readActivity().items;
assert.equal(items.length, 5, 'entries of a known kind with an id are read');
assert.equal(A.ended(items[0]), false); assert.equal(A.ended(items[1]), true); assert.equal(A.ended(items[4]), true, 'a stale Bitcoin transaction has ended');
assert.deepEqual(A.activityCount(), { total: 4, live: 2 }, 'four shown, two still going');

// a settled burn for a bridge to Bitcoin: going until the bridge journal says minted
put([{ id: 'op:7', kind: 'op', status: 'settled', hash: burn, pub }]);
assert.deepEqual(A.activityCount(), { total: 1, live: 0 }, 'with no bridge row it has ended');
mem.set(`tacit-crossout-bridge-v1:mainnet:${pub}`, JSON.stringify([{ stage: 'covered', settle: { txHash: burn.slice(2).toUpperCase() } }]));
assert.deepEqual(A.activityCount(), { total: 1, live: 1 }, 'its bridge still on its way: going (the hash matched with or without 0x, in any case)');
mem.set(`tacit-crossout-bridge-v1:mainnet:${pub}`, JSON.stringify([{ stage: 'minted', settle: { txHash: burn } }]));
assert.deepEqual(A.activityCount(), { total: 1, live: 0 }, 'minted on Bitcoin: done (the row is read again when it changes)');

assert.ok(Object.values(A.JOB_LABEL).every((x) => typeof x === 'string' && x.length > 0), 'every relay job has a name');
console.log('activity: all checks passed');
