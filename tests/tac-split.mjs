#!/usr/bin/env node
// The split route in dapp/evm-trade-venues.js (quoteSplit / buildSplit / plan), against synthetic venues.
//
// Both venues are constant-product curves with different depth, so the best split has a closed-form answer to compare with
// (brute force at 0.01% steps). The transactions it builds are compared byte for byte with the same bundle encoded by
// `cast calldata` (foundry), nested the way the chain will read it: zRouter.multicall([guard snwap, snwap(Multicall3,
// aggregate3[Value](legs))]). tests/tac-split-fork.mjs runs the same bundles against mainnet state.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  ZERO_ADDR, TAC_ERC20, TAC_POOL_ASSET_ID, CETH_POOL_ASSET_ID, ZROUTER, PRECISION_ROUTE, PRECISION_LENS, PRECISION_POLICY, PRECISION_GUARD,
  PRECISION_POOL, TACIT_AMM, TACIT_AMM_UNIT_SCALE, MULTICALL3, SAFE_EXECUTOR, makeEvmTradeVenues,
} from '../dapp/evm-trade-venues.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const cast = (...args) => execFileSync('cast', args, { encoding: 'utf8' }).trim();
const A1 = '0x1111111111111111111111111111111111111111';
const E18 = 10n ** 18n;

// ── the synthetic market: Precision is deeper, the AMM a little cheaper per TAC ──
const CURVES = { precision: { eth: 3n * E18, tac: 39000n * E18 }, tacit: { eth: 1n * E18, tac: 11000n * E18 } };
const cp = (rIn, rOut, amtIn) => (amtIn * 997n * rOut) / (rIn * 1000n + amtIn * 997n);
const outOf = (v, dir, amt) => (dir === 'ETH_TO_TAC' ? cp(CURVES[v].eth, CURVES[v].tac, amt) : cp(CURVES[v].tac, CURVES[v].eth, amt));
const align = (a) => a - (a % TACIT_AMM_UNIT_SCALE);

const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const wordsOf = (hex) => { const h = hex.replace(/^0x/, '').slice(8); return (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64)); };
function decodeAggregate3Call(data) {
  const h = data.replace(/^0x/, '').slice(8), word = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
  const cnt = Number(word(1)), subs = [];
  for (let i = 0; i < cnt; i++) {
    const t = 2 + Number(word(2 + i)) / 32, bo = t + Number(word(t + 2)) / 32, len = Number(word(bo));
    subs.push({ to: '0x' + h.slice(t * 64 + 24, t * 64 + 64), data: '0x' + h.slice((bo + 1) * 64, (bo + 1) * 64 + len * 2) });
  }
  return subs;
}
// (bool success, bytes data)[] as aggregate3 returns it.
function encReturns(rets) {
  const bodies = rets.map((r) => { const d = r ? r.replace(/^0x/, '') : ''; return w(r ? 1 : 0) + w(64) + w(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0'); });
  let off = rets.length * 32, head = '';
  for (const b of bodies) { head += w(off); off += b.length / 2; }
  return '0x' + w(32) + w(rets.length) + head + bodies.join('');
}
const SEL = { quoteBest: '2adaa389', effFee: 'ef66de32', tacitQuote: '3bc1414a' };

function makeEthCall({ failSim = false, tacitDown = false } = {}) {
  const log = { agg3: 0, sims: 0 };
  async function ethCall(to, data, block, opts) {
    if (to.toLowerCase() === ZROUTER.toLowerCase()) { log.sims++; if (failSim) throw new Error('execution reverted: Multicall3: call failed'); return '0x'; }
    if (to.toLowerCase() !== MULTICALL3.toLowerCase()) throw new Error(`unexpected ethCall to ${to}`);
    log.agg3++;
    const rets = decodeAggregate3Call(data).map((c) => {
      const sel = c.data.slice(2, 10), arg = (i) => BigInt('0x' + c.data.slice(10 + i * 64, 10 + (i + 1) * 64));
      if (c.to.toLowerCase() === PRECISION_LENS.toLowerCase() && sel === SEL.quoteBest) {
        const dir = arg(3) === 0n ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
        return '0x' + w(BigInt(PRECISION_POOL)) + w(outOf('precision', dir, arg(4)));
      }
      if (c.to.toLowerCase() === PRECISION_LENS.toLowerCase() && sel === SEL.effFee) return '0x' + w(30);
      if (c.to.toLowerCase() === PRECISION_POLICY.toLowerCase()) return '0x' + w(32) + w(1) + w(1);
      if (c.to.toLowerCase() === TACIT_AMM.toLowerCase() && sel === SEL.tacitQuote) {
        if (tacitDown || arg(2) !== 30n) return null;
        const dir = arg(0) === BigInt(CETH_POOL_ASSET_ID) ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
        return '0x' + w(outOf('tacit', dir, arg(3)));
      }
      return null;
    });
    return encReturns(rets);
  }
  return { ethCall, log };
}

const keccak256 = (bytes) => {
  const hex = cast('keccak', '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
  return Uint8Array.from((hex.replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
};

const snwapCast = (tokenIn, amountIn, recipient, tokenOut, minOut, executor, data) =>
  cast('calldata', 'snwap(address,uint256,address,address,uint256,address,bytes)', tokenIn, String(amountIn), recipient, tokenOut, String(minOut), executor, data);
const bestSingle = (dir, amt) => (outOf('precision', dir, amt) >= outOf('tacit', dir, align(amt)) ? outOf('precision', dir, amt) : outOf('tacit', dir, align(amt)));

// ── quoteSplit: finds the optimum, in both directions, at several sizes ──
for (const dir of ['ETH_TO_TAC', 'TAC_TO_ETH']) {
  const { ethCall } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall, keccak256 });
  for (const amt of dir === 'ETH_TO_TAC' ? [E18 / 2n, E18, 2n * E18] : [2000n * E18, 5000n * E18, 12000n * E18]) {
    const split = await venues.quoteSplit({ dir, amountIn: amt, account: A1 });
    assert.ok(split, `a split should pay more at ${amt}`);
    const [p, t] = split.legs;
    assert.equal(p.amountIn + t.amountIn, amt, 'the legs add up to exactly the order');
    assert.equal(t.amountIn % TACIT_AMM_UNIT_SCALE, 0n, 'the AMM leg is a whole multiple of 1e10');
    assert.equal(split.amountOut, p.amountOut + t.amountOut);
    assert.equal(p.amountOut, outOf('precision', dir, p.amountIn));
    assert.equal(t.amountOut, outOf('tacit', dir, t.amountIn));
    assert.ok(split.gain > 0n && split.amountOut > bestSingle(dir, amt));
    // brute force at 0.01% steps: the two-pass search (5% then 1% steps) must be within 0.005% of the true optimum
    let best = 0n;
    for (let s = 0n; s <= 10000n; s++) { const a2 = align(amt * s / 10000n), tot = outOf('precision', dir, amt - a2) + (a2 ? outOf('tacit', dir, a2) : 0n); if (tot > best) best = tot; }
    assert.ok(split.amountOut * 100000n >= best * 99995n, `search ${split.amountOut} vs optimum ${best}`);
  }
}
ok('quoteSplit finds the best allocation (within 0.005% of brute force) and legs add up, both directions, three sizes each');

{
  const { ethCall, log } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall });
  const s = await venues.quoteSplit({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1 });
  assert.ok(log.agg3 <= 10,`a split quote is a handful of batches, not a call per point (${log.agg3})`);
  assert.equal(await makeEvmTradeVenues({ ethCall: makeEthCall({ tacitDown: true }).ethCall }).quoteSplit({ dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1 }), null);
  assert.equal(await venues.quoteSplit({ dir: 'ETH_TO_TAC', amountIn: 0n, account: A1 }), null);
  assert.ok(s.gainBps > 0);
}
ok('quoteSplit uses a few batched reads, and answers null when a venue is down or nothing is asked');

// ── buildSplit: byte for byte against cast, nested the way the chain reads it ──
const DL = 2000000000n;
{
  const { ethCall } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall, keccak256 });
  const split = await venues.quoteSplit({ dir: 'ETH_TO_TAC', amountIn: E18, account: A1 });
  const tx = venues.buildSplit({ split, account: A1, slippageBps: 50, deadline: DL });
  const [pl, tl] = split.legs, floor = split.amountOut * 9950n / 10000n;
  assert.equal(tx.to, ZROUTER); assert.equal(tx.value, E18); assert.equal(tx.approval, null); assert.equal(tx.minOut, floor);
  const route = cast('calldata', 'route(address[],address,address,uint256,uint256,address)', `[${pl.pool}]`, ZERO_ADDR, TAC_ERC20, String(pl.amountIn), '0', A1);
  const swap = cast('calldata', 'swapPublic(bytes32,bytes32,uint32,uint256,uint256,uint64,address)', CETH_POOL_ASSET_ID, TAC_POOL_ASSET_ID, String(tl.feeBps), String(tl.amountIn), '0', String(DL), A1);
  const agg = cast('calldata', 'aggregate3Value((address,bool,uint256,bytes)[])',
    `[(${SAFE_EXECUTOR},false,${pl.amountIn},${cast('calldata', 'execute(address,bytes)', PRECISION_ROUTE, route)}),(${TACIT_AMM},false,${tl.amountIn},${swap})]`);
  const guard = snwapCast(ZERO_ADDR, 0, A1, ZERO_ADDR, 0, PRECISION_GUARD, cast('calldata', 'deadline(uint256,address)', String(DL), ZROUTER));
  const expected = cast('calldata', 'multicall(bytes[])', `[${guard},${snwapCast(ZERO_ADDR, 0, A1, TAC_ERC20, floor, MULTICALL3, agg)}]`);
  assert.equal(tx.data, expected);
  assert.throws(() => venues.buildSplit({ split, account: A1, deadline: DL, minOut: split.amountOut + 1n }), /minOut/);
  assert.throws(() => venues.buildSplit({ split: { ...split, legs: [pl, { ...tl, amountIn: tl.amountIn + 1n }] }, account: A1, deadline: DL }), /1e10/);
  ok('buildSplit (ETH to TAC) is byte for byte multicall([deadline guard, snwap(Multicall3, aggregate3Value([Precision via SafeExecutor, Tacit AMM]))])');
}
{
  const { ethCall } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall, keccak256 });
  const amt = 5000n * E18, split = await venues.quoteSplit({ dir: 'TAC_TO_ETH', amountIn: amt, account: A1 });
  const tx = venues.buildSplit({ split, account: A1, slippageBps: 50, deadline: DL });
  const [pl, tl] = split.legs, floor = split.amountOut * 9950n / 10000n;
  assert.equal(tx.to, ZROUTER); assert.equal(tx.value, 0n);
  assert.deepEqual(tx.approval, { token: TAC_ERC20, spender: ZROUTER, amount: amt });
  const route = cast('calldata', 'route(address[],address,address,uint256,uint256,address)', `[${pl.pool}]`, TAC_ERC20, ZERO_ADDR, String(pl.amountIn), '0', A1);
  const checkpoint = cast('calldata', 'checkpoint(address,bytes32,address)', TAC_ERC20, cast('keccak', route), A1);
  const sw = cast('calldata', 'swapPublic(bytes32,bytes32,uint32,uint256,uint256,uint64,address)', TAC_POOL_ASSET_ID, CETH_POOL_ASSET_ID, String(tl.feeBps), String(tl.amountIn), '0', String(DL), A1);
  const ex = (d) => cast('calldata', 'execute(address,bytes)', PRECISION_ROUTE, d);
  const agg = cast('calldata', 'aggregate3((address,bool,bytes)[])',
    `[(${SAFE_EXECUTOR},false,${ex(checkpoint)}),(${TAC_ERC20},false,${cast('calldata', 'transfer(address,uint256)', PRECISION_ROUTE, String(pl.amountIn))}),(${SAFE_EXECUTOR},false,${ex(route)}),`
    + `(${TAC_ERC20},false,${cast('calldata', 'approve(address,uint256)', TACIT_AMM, String(tl.amountIn))}),(${TACIT_AMM},false,${sw})]`);
  const guard = snwapCast(ZERO_ADDR, 0, A1, ZERO_ADDR, 0, PRECISION_GUARD, cast('calldata', 'deadline(uint256,address)', String(DL), ZROUTER));
  const swapLeg = snwapCast(TAC_ERC20, amt, A1, ZERO_ADDR, floor, MULTICALL3, agg);
  assert.equal(tx.data, cast('calldata', 'multicall(bytes[])', `[${guard},${swapLeg}]`));
  // with a signed permit the approval is not needed and the permit leads
  const permit = { value: amt, deadline: DL, v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) };
  const withPermit = venues.buildSplit({ split, account: A1, slippageBps: 50, deadline: DL, permit });
  assert.equal(withPermit.approval, null);
  const permitLeg = cast('calldata', 'permit(address,uint256,uint256,uint8,bytes32,bytes32)', TAC_ERC20, String(amt), String(DL), '27', permit.r, permit.s);
  assert.equal(withPermit.data, cast('calldata', 'multicall(bytes[])', `[${permitLeg},${guard},${swapLeg}]`));
  assert.throws(() => makeEvmTradeVenues({ ethCall }).buildSplit({ split, account: A1, deadline: DL }), /keccak256/);
  ok('buildSplit (TAC to ETH) is byte for byte [permit?, guard, snwap(TAC, Multicall3, aggregate3([checkpoint, transfer, route, approve, Tacit swap]))]');
}

// ── plan: the split is taken only when it is worth its gas, and only when it runs ──
{
  const { ethCall, log } = makeEthCall();
  const venues = makeEvmTradeVenues({ ethCall, keccak256 });
  const base = { dir: 'ETH_TO_TAC', amountIn: 2n * E18, account: A1, deadline: DL };
  const noEstimate = await venues.plan(base);
  assert.equal(noEstimate.kind, 'split', 'without a gas estimate a split paying well over 0.3% is taken');
  assert.ok(noEstimate.split.gainBps > 30 && noEstimate.tx.to === ZROUTER);
  const cheap = await venues.plan({ ...base, estimateGas: async (tx) => (tx.data.length > 4000 ? 420000n : 300000n), gasPrice: async () => 2n * 10n ** 9n });
  assert.equal(cheap.kind, 'split'); assert.equal(cheap.gas.split - cheap.gas.single, 120000n);
  const dear = await venues.plan({ ...base, estimateGas: async (tx) => (tx.data.length > 4000 ? 300000n + 10n ** 9n : 300000n), gasPrice: async () => 10n ** 9n * 10n ** 9n });
  assert.equal(dear.kind, 'single', 'a split whose extra gas costs more than it earns is not taken');
  assert.ok(dear.split && dear.quote && dear.tx, 'the split stays on offer, and the single route is ready');
  const tiny = await venues.plan({ ...base, amountIn: 10n ** 12n });
  assert.equal(tiny.kind, 'single', 'a dust order gains less than 0.3% from splitting');
  const verified = await venues.plan({ ...base, verify: true });
  assert.equal(verified.kind, 'split'); assert.ok(log.sims >= 1, 'the chosen split was simulated first');
  const broken = makeEthCall({ failSim: true });
  const fell = await makeEvmTradeVenues({ ethCall: broken.ethCall, keccak256 }).plan({ ...base, verify: true });
  assert.equal(fell.kind, 'single', 'a split that reverts in simulation falls back to the best single venue');
  assert.match(String(fell.splitError), /Multicall3: call failed/);
  ok('plan() takes a split only when it pays enough over its extra gas, simulates it first on request, and falls back to the single venue on a revert');
}

console.log(`\n${n} tac-split checks passed`);
