// The swap page asks zQuoter (a scan of every pool) for the same quote several times as it loads: with `reuse`, an ask for the same recipient, tokens, amount and
// slippage and deadline within ten seconds shares the one in flight or just done; the deadline of such a quote is rounded up to the minute, so the asks the page makes
// a second apart are the same ask and each answer still passes the guard's check of its own deadline; what a transaction is built from is asked fresh. No network.
//   node tests/swap-route-reuse.test.mjs
import assert from 'node:assert';
import { _internal, WETH, ZROUTER } from '../dapp/swap/route.js';

import { quoteTokenToTacit, CUSD } from '../dapp/swap/route.js';
const { zqSwap } = _internal;
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
// buildBestSwap's answer: source, feeBps, amountIn, amountOut, the call data (by offset), amountLimit, msgValue.
const answer = (amountOut) => '0x' + word(3) + word(500) + word(1000) + word(amountOut) + word(224) + word(900) + word(0) + word(2) + 'cafe'.padEnd(64, '0');
let n = 0; const ok = (m) => { n++; console.log('ok  -', m); };
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', P = { to: ZROUTER, tokenIn: USDC, tokenOut: WETH, amount: 1000n, exactOut: false, slippageBps: 50n };
const counter = (make) => { const c = { n: 0, fn: async () => { c.n++; return make(c.n); } }; return c; };

{ // concurrent asks
  const c = counter(() => answer(777));
  const [a, b] = await Promise.all([zqSwap({ ...P, ethCall: c.fn, deadline: 1800n, reuse: true }), zqSwap({ ...P, ethCall: c.fn, deadline: 1800n, reuse: true })]);
  assert.equal(c.n, 1); assert.equal(a.amountOut, 777n); assert.strictEqual(a, b);
  ok('two asks at once are one scan');
  await zqSwap({ ...P, ethCall: c.fn, deadline: 1860n, reuse: true });
  assert.equal(c.n, 2);
  ok('an ask with another deadline is another scan (the call data carries its deadline)');
}
{ // no reuse: every ask is its own scan
  const c = counter(() => answer(5));
  await zqSwap({ ...P, ethCall: c.fn, deadline: 1n }); await zqSwap({ ...P, ethCall: c.fn, deadline: 1n });
  assert.equal(c.n, 2);
  ok('without reuse every ask is a scan (what a transaction is built from)');
}
{ // another amount, recipient or token is another scan
  const c = counter(() => answer(5));
  const base = { ...P, ethCall: c.fn, deadline: 1n, reuse: true, amount: 4321n };
  await zqSwap(base); await zqSwap({ ...base, amount: 4322n }); await zqSwap({ ...base, to: '0x' + 'ab'.repeat(20) }); await zqSwap({ ...base, tokenIn: WETH, tokenOut: USDC }); await zqSwap({ ...base, exactOut: true }); await zqSwap({ ...base, slippageBps: 100n });
  assert.equal(c.n, 6);
  ok('a different amount, recipient, token, kind or slippage is another scan');
}
{ // ten seconds
  const c = counter(() => answer(9)); const now = Date.now; let t = now();
  Date.now = () => t;
  try {
    const base = { ...P, ethCall: c.fn, deadline: 1n, reuse: true, amount: 8888n };
    await zqSwap(base); t += 9_000; await zqSwap(base); assert.equal(c.n, 1);
    t += 2_000; await zqSwap(base); assert.equal(c.n, 2);
  } finally { Date.now = now; }
  ok('an answer is shared for ten seconds, then asked again');
}
{ // a failure is not kept
  const c = counter((i) => { if (i === 1) throw new Error('node down'); return answer(11); });
  const base = { ...P, ethCall: c.fn, deadline: 1n, reuse: true, amount: 7777n };
  await assert.rejects(zqSwap(base), /node down/);
  const q = await zqSwap(base);
  assert.equal(c.n, 2); assert.equal(q.amountOut, 11n);
  ok('a failed scan is not kept: the next ask tries again');
}
{ // no route is shared too (an answer of null is still an answer)
  const c = counter(() => { const e = new Error('execution reverted'); e.revert = true; throw e; });
  const base = { ...P, ethCall: c.fn, deadline: 1n, reuse: true, amount: 6666n };
  assert.equal(await zqSwap(base), null); assert.equal(await zqSwap(base), null); assert.equal(c.n, 1);
  ok('"no route" is shared like any other answer');
}
{ // the buy quote asked twice a few seconds apart, as the page does as it loads: both are answered, and each passes the guard's check of its own deadline
  const ZQ = '0x000000bd2db80567c23e353ca95a251c573cbf9b', AMM = '0x00000000e36c7ec997cc59dcda9e03673b448119', SWAP_V3 = 'afeae12b', PRICE = 2455n;       // USDC per ETH
  const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
  let scans = 0;
  const ethCall = async (to, data) => {
    if (String(to).toLowerCase() === AMM) return '0x' + word(73_000_000_000_000_000_000n);
    assert.equal(String(to).toLowerCase(), ZQ);
    scans++;
    const w = (i) => BigInt('0x' + data.slice(10 + i * 64, 10 + (i + 1) * 64)), [recipient, exactOut, tokenIn, tokenOut, amount, slip, deadline] = [0, 1, 2, 3, 4, 5, 6].map((i) => (i === 0 || i === 2 || i === 3 ? '0x' + data.slice(10 + i * 64 + 24, 10 + (i + 1) * 64) : w(i)));
    const out = exactOut === 1n ? amount : (amount * 10n ** 12n) / PRICE, inn = exactOut === 1n ? (amount * PRICE) / 10n ** 12n + 1n : amount;
    const limit = exactOut === 1n ? (inn * (10000n + slip)) / 10000n : slip === 0n ? 0n : (out * (10000n - slip)) / 10000n;
    const callData = '0x' + SWAP_V3 + pad(recipient) + word(exactOut) + word(500) + pad(tokenIn) + pad(tokenOut) + word(amount) + word(limit) + word(deadline);
    const bytes = callData.slice(2), padded = bytes + '0'.repeat((64 - (bytes.length % 64)) % 64);
    return '0x' + word(3) + word(500) + word(inn) + word(out) + word(224) + word(limit) + word(0) + word(bytes.length / 2) + padded;
  };
  const ask = (deadline, reuse) => quoteTokenToTacit({ ethCall, token: USDC, tokenOut: CUSD, amountIn: 100_000_000n, account: '0x0000000000000000000000000000000000000001', slippageBps: 50, deadline, reuse });
  const t = 1_800_000_030n;
  const a = await ask(t, true), b = await ask(t + 3n, true);
  assert.ok(a && b, 'both reuse quotes are answered (the second used to fail the guard: it carried the first one\'s deadline)');
  assert.equal(a.out, b.out);
  assert.equal(scans, 2, 'and the second is the same two scans, not four');
  scans = 0;
  const c = await ask(t, false), d = await ask(t + 3n, false);
  assert.ok(c && d && scans === 4, 'without reuse each ask is its own two scans, with its own deadline');
  ok('the buy quote asked twice a few seconds apart is answered both times, and shares its scans with reuse');
}
console.log(`${n} checks`);
