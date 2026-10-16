// The treasury plan (src/lib/treasury-plan.js): fee ETH goes where the runway is shortest, the settle wallet keeps its floor and never
// ends up shorter than what it feeds, and nothing moves under its minimum.
// node --test tests/treasury-plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTreasury, burnFromBooks, runwayDays, daysText } from '../src/lib/treasury-plan.js';

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;   // ETH → wei, to a millionth
const P = (n) => BigInt(Math.round(n * 1e4)) * 10n ** 14n;   // PROVE → wei
const PRICE = P(13000);                                       // one ETH buys 13,000 PROVE
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(b))), `${a} is not near ${b}`);

test('the short runways are raised to one level with the settle wallet, which keeps its floor', () => {
  // The relay's wallets on 2026-10-16: settle 0.0146 ETH burning 0.0105/day (1.4 d); relay 0.00066 burning 0.0047/day (0.14 d); credit 21
  // PROVE burning 86/day (0.24 d). Every one of them is short, so all three end on the same level, under the three-day target.
  const plan = planTreasury({
    settle: { wei: E(0.0146), burnPerDayWei: E(0.0105), floorWei: E(0.003) },
    relay: { wei: E(0.00066), burnPerDayWei: E(0.0047), floorWei: E(0.001) },
    prove: { wei: P(21), burnPerDayWei: P(86), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.ok(plan.toRelayWei > 0n && plan.toProveWei > 0n);
  near(plan.after.settleDays, plan.after.relayDays, 1e-2);
  near(plan.after.settleDays, plan.after.proveDays, 1e-2);
  assert.ok(plan.after.settleDays < 3 && plan.after.settleDays > 0.5, `level ${plan.after.settleDays}`);
  assert.ok(E(0.0146) - plan.toRelayWei - plan.toProveWei >= E(0.003), 'the floor is kept');
  // With only the relay wallet short, it alone is fed, to where the two runways meet: a = (S·rb − R·sb)/(sb+rb).
  const one = planTreasury({
    settle: { wei: E(0.0146), burnPerDayWei: E(0.0105), floorWei: E(0.003) },
    relay: { wei: E(0.00066), burnPerDayWei: E(0.0047), floorWei: E(0.001) },
    prove: { wei: P(1000), burnPerDayWei: P(86), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  const meet = (E(0.0146) * E(0.0047) - E(0.00066) * E(0.0105)) / (E(0.0105) + E(0.0047));
  assert.ok(one.toRelayWei >= meet - 10n ** 12n && one.toRelayWei <= meet + 10n ** 12n, `${one.toRelayWei} vs ${meet}`);
  assert.equal(one.toProveWei, 0n);
  near(one.after.settleDays, one.after.relayDays, 1e-3);
});

test('the relay wallet is never fed past its target, and not at all when it is the longer runway', () => {
  const rich = planTreasury({
    settle: { wei: E(1), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0.001), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(1000), burnPerDayWei: P(10), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  const want = E(0.015) - E(0.001);
  assert.ok(rich.toRelayWei >= want - 10n ** 12n && rich.toRelayWei <= want, 'three days of burn, no more');
  const longer = planTreasury({
    settle: { wei: E(0.01), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0.05), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(1000), burnPerDayWei: P(10), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.equal(longer.toRelayWei, 0n);
  assert.equal(longer.toProveWei, 0n);
});

test('PROVE is bought from what is left after the relay wallet, up to where the runways meet, and capped per pass', () => {
  const plan = planTreasury({
    settle: { wei: E(0.2), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0.02), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(10), burnPerDayWei: P(90), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.equal(plan.toRelayWei, 0n, 'the relay wallet already has four days');
  // three days of PROVE is 270; it holds 10, so 260 PROVE = 0.02 ETH at the price. The settle wallet has far more than three days, so the target binds.
  const want = (P(260) * 10n ** 18n + PRICE - 1n) / PRICE;
  assert.ok(plan.toProveWei >= want - 10n ** 12n && plan.toProveWei <= want, `${plan.toProveWei} vs ${want}`);
  near(plan.after.proveDays, 3, 1e-3);
  const capped = planTreasury({
    settle: { wei: E(0.2), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0.02), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(10), burnPerDayWei: P(90), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE, maxSwapWei: E(0.005),
  });
  assert.equal(capped.toProveWei, E(0.005));
});

test('a thin settle wallet shares its pain: PROVE is bought only up to where the two runways meet', () => {
  // settle 0.02 ETH at 0.01/day = 2 days; credit 10 PROVE at 90/day = 0.11 day; the relay wallet is fine. Equal runways, not three days of PROVE.
  const plan = planTreasury({
    settle: { wei: E(0.02), burnPerDayWei: E(0.01), floorWei: E(0.002) },
    relay: { wei: E(0.05), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(10), burnPerDayWei: P(90), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.ok(plan.toProveWei > 0n);
  near(plan.after.settleDays, plan.after.proveDays, 1e-2);
  assert.ok(plan.after.proveDays < 3);
});

test('nothing moves under the floor, under a minimum, or when PROVE cannot be priced', () => {
  const floor = planTreasury({
    settle: { wei: E(0.002), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(0), burnPerDayWei: P(90), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.equal(floor.toRelayWei, 0n); assert.equal(floor.toProveWei, 0n);
  const tiny = planTreasury({
    settle: { wei: E(0.0031), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(0), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(1000), burnPerDayWei: P(10), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE, minMoveWei: E(0.001),
  });
  assert.equal(tiny.toRelayWei, 0n);
  assert.ok(tiny.notes.some((n) => /minimum move/.test(n)));
  const unpriced = planTreasury({
    settle: { wei: E(1), burnPerDayWei: E(0.01), floorWei: E(0.003) },
    relay: { wei: E(1), burnPerDayWei: E(0.005), floorWei: E(0.001) },
    prove: { wei: P(0), burnPerDayWei: P(90), floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: null,
  });
  assert.equal(unpriced.toProveWei, 0n);
  assert.ok(unpriced.notes.some((n) => /cannot be priced/.test(n)));
});

test('with no burn known, the floors decide: a wallet under its floor is brought to twice it', () => {
  const plan = planTreasury({
    settle: { wei: E(0.05), burnPerDayWei: 0n, floorWei: E(0.003) },
    relay: { wei: E(0.0005), burnPerDayWei: 0n, floorWei: E(0.001) },
    prove: { wei: P(10), burnPerDayWei: 0n, floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.equal(plan.toRelayWei, E(0.002) - E(0.0005));
  const want = (P(50) * 10n ** 18n + PRICE - 1n) / PRICE;
  assert.ok(plan.toProveWei >= want - 10n ** 12n && plan.toProveWei <= want, 'the credit is brought to its floor');
  const fine = planTreasury({
    settle: { wei: E(0.05), burnPerDayWei: 0n, floorWei: E(0.003) },
    relay: { wei: E(0.0015), burnPerDayWei: 0n, floorWei: E(0.001) },
    prove: { wei: P(70), burnPerDayWei: 0n, floorWei: P(60) },
    targetDays: 3, proveWeiPerEth: PRICE,
  });
  assert.equal(fine.toRelayWei, 0n); assert.equal(fine.toProveWei, 0n);
});

test('the books give a burn a day, with today counted as the part of it that has passed', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0); // half of the 16th
  const b = burnFromBooks({
    '2026-10-14': { gasEth: 0.01, proveIn: 80, settled: 60 },
    '2026-10-15': { gasEth: 0.012, proveIn: 100, settled: 70 },
    '2026-10-16': { gasEth: 0.004, proveIn: 30, settled: 20 },
  }, { now });
  near(b.gasEthPerDay, 0.026 / 2.5); near(b.provePerDay, 210 / 2.5); near(b.settlesPerDay, 150 / 2.5); assert.equal(b.days, 3);
  const early = burnFromBooks({ '2026-10-16': { gasEth: 0.001, proveIn: 5, settled: 2 } }, { now: Date.UTC(2026, 9, 16, 0, 10, 0) });
  near(early.gasEthPerDay, 0.004, 1e-6);  // a quarter day at least
  assert.equal(burnFromBooks({}).gasEthPerDay, null);
  assert.equal(burnFromBooks({ junk: { gasEth: 1 } }).days, 0);
});

test('runway helpers', () => {
  assert.equal(runwayDays(10n, 0n), Infinity);
  assert.equal(runwayDays(10n, 4n), 2.5);
  assert.equal(daysText(Infinity), '∞'); assert.equal(daysText(400), '365+'); assert.equal(daysText(12.4), '12'); assert.equal(daysText(1.26), '1.3');
});
