// The settle relay's stale burn-root check for bridge mints (src/lib/bridge-mint-precheck.js).
//   node worker-relay/tests/bridge-mint-precheck.test.mjs

import assert from 'node:assert/strict';
import { bridgeMintBlocker } from '../src/lib/bridge-mint-precheck.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const ROOT_A = '0x' + 'a1'.repeat(32), ROOT_B = '0x' + 'b2'.repeat(32);
const job = (over = {}, type = 'bridgemint') => ({ type, op: { bitcoinBurnRoot: ROOT_A, ...over } });

// A pool whose burn root (storage slot 80) is `held`; `reads` records what was asked of it.
const chain = (held, reads = []) => ({
  getStorageAt: async ({ address, slot }) => {
    reads.push({ address, slot });
    if (held instanceof Error) throw held;
    return held;
  },
});
const check = (j, c) => bridgeMintBlocker(j, { client: c, pool: POOL });

await test('a mint built on the root the pool holds is proved, and the pool is read at slot 80', async () => {
  const reads = [];
  assert.equal(await check(job(), chain(ROOT_A, reads)), null);
  assert.deepEqual(reads, [{ address: POOL, slot: '0x50' }]);
});

await test('the same root in another letter case is the same root', async () => {
  assert.equal(await check(job({ bitcoinBurnRoot: ROOT_A.toUpperCase().replace('0X', '0x') }), chain(ROOT_A)), null);
});

await test('a mint built on an older root is not proved, and the reason says nothing was spent', async () => {
  const why = await check(job(), chain(ROOT_B));
  assert.match(why, /moved on/);
  assert.match(why, /nothing was spent/);
});

await test('a stealth bridge mint is held to the same root', async () => {
  assert.match(await check(job({}, 'bridgestealthmint'), chain(ROOT_B)), /moved on/);
  assert.equal(await check(job({}, 'bridgestealthmint'), chain(ROOT_A)), null);
});

await test('other ops are never looked at, and the chain is not read for them', async () => {
  const reads = [];
  assert.equal(await check(job({}, 'transfer'), chain(ROOT_B, reads)), null);
  assert.equal(await check(job({}, 'cbtcmint'), chain(ROOT_B, reads)), null);
  assert.equal(reads.length, 0);
});

await test('a mint with no readable root of its own is left to the guest and the pool', async () => {
  assert.equal(await check({ type: 'bridgemint', op: {} }, chain(ROOT_B)), null);
  assert.equal(await check({ type: 'bridgemint', op: { bitcoinBurnRoot: '0x12' } }, chain(ROOT_B)), null);
  assert.equal(await check({ type: 'bridgemint' }, chain(ROOT_B)), null);
});

await test('a root that cannot be read, or the pool has not set, holds nothing back', async () => {
  assert.equal(await check(job(), chain(new Error('rpc down'))), null);
  assert.equal(await check(job(), chain('0x')), null);
  assert.equal(await check(job(), chain('0x' + '00'.repeat(32))), null);
  assert.equal(await check(job(), chain(undefined)), null);
});

console.log(`\nall ${n} bridge-mint precheck checks passed`);
