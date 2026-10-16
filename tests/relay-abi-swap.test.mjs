// dapp/relay/abi.js: the ETH-to-PROVE swap every page offers. quoteEthToProve holds the checks a quote must pass before it is shown or sent;
// ethForProve works out the ETH for a PROVE amount. zQuoter is stubbed with a constant price and the real call's answer layout (the exact-out
// numbers were read from mainnet on 2026-10-16: 5 PROVE for 0.000395876 ETH, a 0.000399835 maximum, all of which the router spends).
//
// Run: node --test tests/relay-abi-swap.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBestSwapData, decodeBestSwap, quoteEthToProve, ethForProve, ETH, PROVE, ZQUOTER, ZROUTER, SLIPPAGE_BPS } from '../dapp/relay/abi.js';

const TO = '0x2603cde2fc6f9f4c64eabe8e293613efcb92a331';
const E18 = 10n ** 18n;
const word = (v) => BigInt(v).toString(16).padStart(64, '0');

// The answer of zQuoter.buildBestSwap: Quote{source, feeBps, amountIn, amountOut}, the call to zRouter, amountLimit, msgValue.
function answer({ amountIn, amountOut, amountLimit, msgValue, callData }) {
  const bytes = callData.replace(/^0x/, '');
  const pad = bytes + '0'.repeat((64 - (bytes.length % 64)) % 64);
  return '0x' + word(1) + word(30) + word(amountIn) + word(amountOut) + word(7 * 32) + word(amountLimit) + word(msgValue) + word(bytes.length / 2) + pad;
}
const field = (data, i) => BigInt('0x' + data.slice(10 + i * 64, 10 + (i + 1) * 64));

// A quoter at a price of `perEth` PROVE per ETH, with the 1% guard. exact-out: msgValue is the maximum in, amountLimit the same.
function quoter({ perEth = 12_500n, onCall = null } = {}) {
  const calls = [];
  const call = async ({ to, data, gas }) => {
    assert.equal(to, ZQUOTER); assert.ok(gas);
    const exactOut = field(data, 1) === 1n, amount = field(data, 4), slip = field(data, 5);
    const rcpt = '0x' + data.slice(10 + 0 * 64 + 24, 10 + 64);
    calls.push({ exactOut, amount });
    if (onCall) onCall(calls.length);
    const price = onCall && calls.priceFn ? calls.priceFn(calls.length) : perEth;
    const callData = '0x1234abcd' + word(rcpt) + word(amount);
    if (exactOut) {
      const amountIn = (amount + price - 1n) / price, max = amountIn * (10000n + slip) / 10000n;
      return answer({ amountIn, amountOut: amount, amountLimit: max, msgValue: max, callData });
    }
    const out = amount * price;
    return answer({ amountIn: amount, amountOut: out, amountLimit: out * (10000n - slip) / 10000n, msgValue: amount, callData });
  };
  return { call, calls };
}

test('buildBestSwapData keeps its exact-in encoding and sets the exact-out flag only when asked', () => {
  const base = { to: TO, tokenIn: ETH, tokenOut: PROVE, amount: E18, slippageBps: 100n, deadline: 1_800_000_000n };
  const a = buildBestSwapData(base), b = buildBestSwapData({ ...base, exactOut: true });
  assert.equal(field(a, 1), 0n);
  assert.equal(field(b, 1), 1n);
  assert.equal(a.length, b.length);
  assert.equal(a.slice(0, 10), '0xe7798987');
  assert.equal(a.replace(word(0), word(1)), b);                                       // that one word is all that differs
});

test('a quote is shown only when it spends what was asked, pays the recipient and guards a least amount out', async () => {
  const q = quoter();
  const ok = await quoteEthToProve({ call: q.call, to: TO, wei: E18 / 100n });
  assert.equal(ok.wei, E18 / 100n);
  assert.equal(ok.amountOut, 125n * E18);
  assert.equal(ok.amountLimit, 12375n * E18 / 100n);
  assert.equal(ok.router, ZROUTER);
  assert.equal(SLIPPAGE_BPS, 100n);

  const answerOf = (patch) => async () => answer({ amountIn: 1n, amountOut: 100n, amountLimit: 99n, msgValue: E18, callData: '0x12' + word(TO), ...patch });
  const refused = (patch, re) => assert.rejects(quoteEthToProve({ call: answerOf(patch), to: TO, wei: E18 }), re);
  await refused({ msgValue: E18 + 1n }, /did not match/);                              // spends more than asked
  await refused({ callData: '0x12' + word('0x' + 'ab'.repeat(20)) }, /did not match/);   // pays someone else
  await refused({ amountLimit: 0n }, /did not match/);                                 // no least amount out
  await refused({ amountLimit: 101n }, /did not match/);                               // a least amount above what it buys
  await refused({ amountOut: 0n, amountLimit: 0n }, /No route/);
  await assert.rejects(quoteEthToProve({ call: async () => { throw Object.assign(new Error('x'), { revert: true }); }, to: TO, wei: E18, noRoute: 'none today' }), /none today/);
  await assert.rejects(quoteEthToProve({ call: async () => { throw new Error('network'); }, to: TO, wei: E18 }), /Could not read a quote/);
});

test('the ETH for a PROVE amount covers it even at the least the swap may buy, and the swap sent is the ordinary one', async () => {
  for (const want of [E18 / 2n, 5n * E18, 40n * E18 + 7n]) {
    const q = quoter();
    const r = await ethForProve({ call: q.call, to: TO, want });
    assert.ok(r.amountLimit >= want, 'the least it may buy covers the amount');
    assert.ok(r.amountOut <= want * 1030n / 1000n, 'and not by much: the extra is 3% at most');
    assert.equal(r.msgValue, r.wei);                                                   // exact in: no maximum above what is paid
    assert.equal(r.wei % 10n ** 12n, 0n);                                              // a millionth of an ETH
    assert.deepEqual(q.calls.map((c) => c.exactOut), [true, false]);                   // priced out once, quoted in once
    assert.equal(q.calls[0].amount, want);
  }
  await assert.rejects(ethForProve({ call: quoter().call, to: TO, want: 0n }), /Enter how much/);
});

test('a price that moves against the buyer between the two reads is followed, and a price that keeps running is given up on', async () => {
  const q = quoter({ onCall: () => {} });
  q.calls.priceFn = (n) => (n === 1 ? 12_500n : 12_500n * 96n / 100n);                  // 4% worse by the time the ETH is quoted
  const r = await ethForProve({ call: q.call, to: TO, want: 5n * E18 });
  assert.ok(r.amountLimit >= 5n * E18);
  assert.equal(q.calls.length, 3);                                                     // size, short, then covered

  const run = quoter({ onCall: () => {} });
  run.calls.priceFn = (n) => 12_500n / BigInt(n * n * n);                              // falling faster than it can be followed
  await assert.rejects(ethForProve({ call: run.call, to: TO, want: 5n * E18 }), /price moved/);
  assert.ok(run.calls.length <= 4);

  const odd = async () => answer({ amountIn: 1n, amountOut: 4n * E18, amountLimit: 4n * E18, msgValue: 1n, callData: '0x12' + word(TO) });
  await assert.rejects(ethForProve({ call: odd, to: TO, want: 5n * E18 }), /No route/);   // a sizing answer for another amount
});
