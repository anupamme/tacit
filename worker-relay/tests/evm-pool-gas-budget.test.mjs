// A pool's day of gas (src/lib/evm-pool-gas-budget.js): a send is charged its gas limit at the price now, one past the allowance is refused
// before it is signed, and what was spent comes back 24 hours after it was.
// node --test tests/evm-pool-gas-budget.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGasBudget, budgeted } from '../src/lib/evm-pool-gas-budget.js';

test('the allowance is charged, refused past its limit, and returns after a day', () => {
  let t = 0;
  const b = makeGasBudget({ dayWei: 1000n, now: () => t });
  assert.equal(b.take(600n), true); assert.equal(b.left(), 400n);
  assert.equal(b.take(500n), false, 'past the allowance'); assert.equal(b.left(), 400n, 'and nothing was charged');
  t = 86_400_000 - 1; assert.equal(b.take(500n), false);
  t = 86_400_000; assert.equal(b.left(), 1000n, 'a day on, it is all back'); assert.equal(b.take(1000n), true);
});

test('a budgeted chain charges each send its gas at the price now, and refuses one that does not fit before sending', async () => {
  const sent = [];
  const chain = { gasPrice: async () => 10n, send: async (fn, args, opts) => { sent.push([fn, opts.gas]); return `0x${sent.length}`; } };
  budgeted(chain, makeGasBudget({ dayWei: 5000n }), () => Object.assign(new Error('used today'), { status: 503 }), 450n);
  assert.equal(await chain.send('pool.transact', [], { gas: 300n }), '0x1');                     // 3,000
  await assert.rejects(chain.send('pool.transact', [], { gas: 300n }), (e) => e.status === 503);  // 6,000 > 5,000
  await assert.rejects(chain.send('router.sweep', []), (e) => e.status === 503, 'a send with no gas named is charged the fallback (4,500 > 2,000 left)');
  assert.equal(await chain.send('router.sweep', [], { gas: 200n }), '0x2');                      // 2,000 fits exactly
  assert.deepEqual(sent, [['pool.transact', 300n], ['router.sweep', 200n]]);
  assert.equal(chain.gasBudget.left(), 0n);
});
