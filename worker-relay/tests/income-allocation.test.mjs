// The buyback share and the splitter trigger (lib/income-allocation.js), to the wei.
// node --test tests/income-allocation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { planBuyback, splitterDue } from '../src/lib/income-allocation.js';

const E = 10n ** 18n;
const base = { ethUsd: 2000, bps: 1000, keepWei: E / 500n, minSendWei: E / 5000n, owedCapWei: E / 20n };   // keep 0.002, min send 0.0002, cap 0.05

test('10% of the fee income, in ETH at today\'s price, is the share', () => {
  const p = planBuyback({ ...base, baseUsd: 20, balanceWei: E });                    // $20 at $2000 = 0.01 ETH earned; 10% = 0.001
  assert.equal(p.earnedWei, E / 100n);
  assert.equal(p.dueWei, E / 1000n);
  assert.equal(p.payWei, E / 1000n);
  assert.equal(p.owedAfterWei, 0n);
  assert.equal(p.reason, 'pay');
});

test('the wallet keeps what it needs for the next settles: only the spare is sent, the rest is owed', () => {
  const p = planBuyback({ ...base, baseUsd: 200, balanceWei: E / 100n + E / 500n });   // due 0.01, balance 0.012, keep 0.002: spare 0.01 -> all
  assert.equal(p.payWei, E / 100n);
  const q = planBuyback({ ...base, baseUsd: 200, balanceWei: E / 250n });             // balance 0.004, keep 0.002: spare 0.002 of 0.01 due
  assert.equal(q.payWei, E / 500n);
  assert.equal(q.owedAfterWei, E / 100n - E / 500n);
  assert.equal(q.reason, 'pay');
});

test('a wallet at or under its keep sends nothing and carries the whole share', () => {
  for (const bal of [0n, E / 1000n, E / 500n]) {
    const p = planBuyback({ ...base, baseUsd: 20, balanceWei: bal });
    assert.equal(p.payWei, 0n);
    assert.equal(p.owedAfterWei, E / 1000n);
    assert.equal(p.reason, 'carried');
  }
});

test('a payment too small to be worth its gas is carried, not sent', () => {
  const p = planBuyback({ ...base, baseUsd: 2, balanceWei: E });                      // due 0.0001 < min send 0.0002
  assert.equal(p.payWei, 0n);
  assert.equal(p.owedAfterWei, E / 10000n);
  assert.equal(p.reason, 'carried');
});

test('what was owed is paid first the pass the wallet can spare it, together with the new share', () => {
  const p = planBuyback({ ...base, baseUsd: 20, owedWei: E / 200n, balanceWei: E });
  assert.equal(p.dueWei, E / 200n + E / 1000n);
  assert.equal(p.payWei, p.dueWei);
  assert.equal(p.owedAfterWei, 0n);
});

test('what is owed has a ceiling, so a long dry spell is not an unbounded debt', () => {
  const p = planBuyback({ ...base, baseUsd: 20000, owedWei: E / 20n, balanceWei: 0n });  // due 0.1 + 0.05, nothing to send
  assert.equal(p.owedAfterWei, E / 20n);
});

test('it is off at zero basis points and never above 100%', () => {
  const off = planBuyback({ ...base, bps: 0, baseUsd: 100, owedWei: 5n, balanceWei: E });
  assert.equal(off.payWei, 0n);
  assert.equal(off.owedAfterWei, 5n);
  const all = planBuyback({ ...base, bps: 50_000, baseUsd: 20, balanceWei: E });
  assert.equal(all.payWei, E / 100n, 'a share over 100% is read as 100%');
});

test('no income, no owed: nothing due; a bad price or base is read as no income', () => {
  assert.equal(planBuyback({ ...base, baseUsd: 0, balanceWei: E }).reason, 'nothing due');
  for (const ethUsd of [0, -1, NaN, undefined]) {
    const p = planBuyback({ ...base, ethUsd, baseUsd: 100, balanceWei: E });
    assert.equal(p.earnedWei, 0n);
    assert.equal(p.payWei, 0n);
  }
  assert.equal(planBuyback({ ...base, baseUsd: NaN, balanceWei: E }).earnedWei, 0n);
});

test('over many passes the buyback is the share of what was earned, whatever the wallet could spare when', () => {
  let owed = 0n, paid = 0n, earned = 0n, bal = E / 1000n;
  for (let i = 0; i < 200; i++) {
    const usd = (i % 7) * 3, p = planBuyback({ ...base, baseUsd: usd, owedWei: owed, balanceWei: bal });
    earned += p.earnedWei; owed = p.owedAfterWei; paid += p.payWei; bal = bal - p.payWei + (i % 5 === 0 ? E / 50n : 0n);
  }
  const due = (earned * 1000n) / 10000n;
  assert.ok(paid + owed <= due + 200n && paid + owed >= due - 200n, `paid ${paid} + owed ${owed} vs due ${due}`);
});

test('a splitter is sent on once it holds the minimum', () => {
  assert.equal(splitterDue(0n, 0n), false);
  assert.equal(splitterDue(E / 10000n, E / 2000n), false);
  assert.equal(splitterDue(E / 2000n, E / 2000n), true);
  assert.equal(splitterDue(E, E / 2000n), true);
});
