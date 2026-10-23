// dapp/swap/aggregate.js bestRoute with zQuoter's real answers at block 26257675, when its best route for 0.00333 ETH → USDC ran through a
// Curve pool the guard does not list (USDC / WETH / INV) and the page said "No route": that route is taken only when the swap, run as it
// stands from an address given the ETH, pays at least its floor; a simulation that pays less, fails, or is not asked for leaves it refused.
//   node --test tests/swap-aggregate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { bestRoute } = await import('../dapp/swap/aggregate.js');
const F = JSON.parse(readFileSync(new URL('./fixtures/aggregate-curve-26257675.json', import.meta.url), 'utf8'));
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ZERO = '0x0000000000000000000000000000000000000000';

// the recorded node: each zQuoter read answered as it was, and the simulation as `sim` says
function node(sim = (r) => r) {
  const seen = [];
  const ethCall = async (to, data, block, o = {}) => {
    const c = F.calls.find((x) => x.sel === data.slice(0, 10) && x.sim === !!o.state);
    seen.push({ sel: data.slice(0, 10), sim: !!o.state, from: o.from, state: o.state });
    if (!c) throw new Error('not recorded');
    if (c.error) throw Object.assign(new Error(c.error), { revert: /revert/i.test(c.error) });
    return o.state ? sim(c.result) : c.result;
  };
  return { ethCall, seen };
}
const ask = (ethCall, over = {}) => bestRoute({ ethCall, to: F.to, tokenIn: ZERO, tokenOut: USDC, amountIn: BigInt(F.amountIn), slippageBps: 50, deadline: BigInt(F.deadline), block: '0x' + F.block.toString(16), ...over });
// the last word of the simulated multicall's return is the swap's amount out
const paying = (v) => (r) => r.slice(0, -64) + BigInt(v).toString(16).padStart(64, '0');

test('the Curve route is offered once the simulation shows it pays at least its floor', async () => {
  const { ethCall, seen } = node();
  const q = await ask(ethCall);
  assert.ok(q, 'a route');
  assert.match(q.name, /Curve/);
  assert.ok(q.out >= q.min && q.min > 0n);
  const sims = seen.filter((s) => s.sim);
  assert.strictEqual(sims.length, 1, 'simulated once, not once for each answer that carries the same route');
  assert.ok(BigInt(sims[0].state[sims[0].from].balance) > BigInt(F.amountIn), 'from a fresh address the node is told holds the ETH');
});

test('a simulation that pays under the floor leaves it refused', async () => {
  const { ethCall } = node();
  const floor = (await ask(ethCall)).min;
  assert.strictEqual(await ask(node(paying(floor - 1n)).ethCall), null);
  assert.ok(await ask(node(paying(floor)).ethCall), 'exactly the floor passes');
});

test('a simulation the node refuses, or one that reverts, leaves it refused', async () => {
  assert.strictEqual(await ask(node(() => { throw new Error('state overrides are not supported'); }).ethCall), null);
  assert.strictEqual(await ask(node(() => { throw Object.assign(new Error('execution reverted'), { revert: true }); }).ethCall), null);
});

test('without the simulation the guard refuses a pool it does not list, as before', async () => {
  const { ethCall } = node(() => '0x');
  assert.strictEqual(await ask(ethCall), null);
});

test('Swap privately\'s swap out takes the same route: written for the real address, it is checked with the Curve pool the simulation let through', async () => {
  const { routeOut } = await import('../dapp/swap/later.js');
  const { ethCall } = node();
  const real = '0x' + '77'.repeat(20);
  // the stand-in is the address the recorded answers were asked for, so the recorded node answers them
  const r = await routeOut({ ethCall, token: USDC, amount: BigInt(F.amountIn), to: real, slippageBps: 50, deadline: BigInt(F.deadline), random: () => Uint8Array.from(Buffer.from(F.to.slice(2), 'hex')) });
  assert.ok(r, 'a route to swap out on');
  assert.ok(r.callData.includes('77'.repeat(20)) && !r.callData.includes(F.to.slice(2)), 'written for the real address');
});
