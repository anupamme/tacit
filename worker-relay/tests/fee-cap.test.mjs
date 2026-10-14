// The settle fee cap and the ETH headroom it asks: the full cap for a funded wallet, a lower one for a short wallet, and a floor.
// node --test tests/fee-cap.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { capAt, fundsNeed, feeCapFor, toMult } from '../src/lib/fee-cap.js';

const G = 1_000_000_000n;                 // 1 gwei
const base = 700_000_000n, tip = 520_000_000n, gas = 600_000n;   // today: 0.7 gwei base, 0.52 gwei tip, a 600k-gas settle

test('multipliers are thousandths', () => {
  assert.equal(toMult(3), 3000n); assert.equal(toMult('1.5'), 1500n); assert.equal(toMult(1.25), 1250n);
});

test('a cap is that many base fees plus the tip', () => {
  assert.equal(capAt(base, tip, 3000n), 2_620_000_000n);
  assert.equal(capAt(base, tip, 1500n), 1_570_000_000n);
  assert.equal(capAt(0n, tip, 3000n), tip, 'no base fee, no multiplier to apply');
});

test('the headroom asked of the wallet is the gas at the lowest cap', () => {
  assert.equal(fundsNeed({ gas: 720_000n, base, tip, minMult: 3000n }), 720_000n * 2_620_000_000n, 'the old three-fold rule');
  const now = fundsNeed({ gas: 720_000n, base, tip, minMult: 1500n });
  assert.equal(now, 720_000n * 1_570_000_000n);
  assert.ok(now < 720_000n * 2_620_000_000n * 7n / 10n, 'at least a third lower than the three-fold rule');
});

test('a funded wallet sends at the full cap', () => {
  const r = feeCapFor({ balance: 2_000_000_000_000_000n, gas, base, tip, maxMult: 3000n, minMult: 1500n });
  assert.equal(r.maxFee, capAt(base, tip, 3000n)); assert.equal(r.mult, 3); assert.equal(r.ok, true);
});

test('a short wallet sends at the highest cap it can stand behind, never under the floor', () => {
  // 0.0012 ETH on a 600k gas limit stands behind 2.0 gwei per gas: (2.0 - 0.52) / 0.7 = 2.114 base fees
  const r = feeCapFor({ balance: 1_200_000_000_000_000n, gas, base, tip, maxMult: 3000n, minMult: 1500n });
  assert.equal(r.mult, 2.114); assert.equal(r.ok, true);
  assert.ok(gas * r.maxFee <= 1_200_000_000_000_000n, 'and the node will take it');
  // 0.00095 ETH stands behind 1.583 gwei: 1.52 base fees, just over the floor
  const low = feeCapFor({ balance: 950_000_000_000_000n, gas, base, tip, maxMult: 3000n, minMult: 1500n });
  assert.ok(low.mult >= 1.5 && low.mult < 1.6 && low.ok, `mult ${low.mult}`);
});

test('below the floor it still names the floor, and says it is not enough', () => {
  const r = feeCapFor({ balance: 600_000_000_000_000n, gas, base, tip, maxMult: 3000n, minMult: 1500n });   // 0.0006 ETH, today's wallet before it was funded
  assert.equal(r.mult, 1.5); assert.equal(r.ok, false);
  assert.equal(r.maxFee, capAt(base, tip, 1500n));
});

test('the wallet that was idle yesterday settles now: 0.0012 ETH against the old and the new headroom', () => {
  const have = 1_172_273_037_257_768n;        // what it held after its first settle, 2026-10-14
  assert.ok(have < fundsNeed({ gas: 720_000n, base, tip, minMult: 3000n }), 'the old rule held it back');
  assert.ok(have >= fundsNeed({ gas: 720_000n, base, tip, minMult: 1500n }), 'the new one lets it send');
});

test('a base fee of zero or a tip over the budget does not break the arithmetic', () => {
  assert.equal(feeCapFor({ balance: 1_000n, gas, base: 0n, tip: 5n, maxMult: 3000n, minMult: 1500n }).maxFee, 5n);
  const r = feeCapFor({ balance: 1_000_000n, gas, base, tip: 9_000_000_000n, maxMult: 3000n, minMult: 1500n });
  assert.equal(r.mult, 1.5); assert.equal(r.ok, false);
});
