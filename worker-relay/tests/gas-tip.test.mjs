// The tip our transactions offer (src/lib/gas-tip.js): the market rate read from recent blocks, floored on what a
// transaction pays in total rather than per gas, capped, and never zero when the history cannot be read.
// Offline: node --test worker-relay/tests/gas-tip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { medianReward, tipFor, readTip, makeTipFloor, TIP_HISTORY_BLOCKS, TIP_PERCENTILE } from '../src/lib/gas-tip.js';

const gwei = (n) => BigInt(Math.round(n * 1e9));
const blocks = (...xs) => xs.map((x) => [gwei(x)]);
// What mainnet was paying on 2026-10-11: a 0.065 gwei base fee and a median included transaction at 0.02 gwei.
const QUIET = blocks(0.02, 0.018, 0.022, 0.02, 0.025, 0.015, 0.02, 0.021);
const SETTLE_GAS = 600_000n, HEADER_GAS = 3_550_000n;
const MIN_TOTAL = 20_000_000_000_000n;   // 0.00002 ETH
const CAP = gwei(2);

test('the median is taken across blocks, so one dear block does not move it', () => {
  assert.equal(medianReward(blocks(0.02, 0.02, 5, 0.02, 0.021)), gwei(0.02));
  assert.equal(medianReward(blocks(0.02, 0.04)), gwei(0.03), 'an even count averages the middle pair');
  assert.equal(medianReward([]), null, 'no history is no reading, not zero');
  assert.equal(medianReward([[gwei(0.01)], null, undefined, [gwei(0.03)]]), gwei(0.02), 'blocks a node left out are skipped');
  assert.equal(medianReward([gwei(0.01), gwei(0.03)]), gwei(0.02), 'a flat array reads the same as one percentile per block');
});

test('a small transaction is floored on what it pays in total, not on a rate', () => {
  const tip = tipFor({ rewards: QUIET, gas: SETTLE_GAS, minTotalWei: MIN_TOTAL, capWei: CAP, fallbackWei: gwei(0.1) });
  assert.equal(tip * SETTLE_GAS >= MIN_TOTAL, true, 'it pays at least the floor');
  assert.equal((tip - 1n) * SETTLE_GAS < MIN_TOTAL, true, 'and no more than a wei over it');
  assert.equal(tip < gwei(0.1), true, 'which is well under the fixed rate it replaces');
});

test('a large transaction pays the market rate, since the total floor is already met', () => {
  const tip = tipFor({ rewards: QUIET, gas: HEADER_GAS, minTotalWei: MIN_TOTAL, capWei: CAP, fallbackWei: gwei(0.05) });
  assert.equal(tip, gwei(0.02), 'the market median, not the floor');
  assert.equal(tip * HEADER_GAS > MIN_TOTAL, true);
  assert.equal(tip < gwei(0.05), true, 'cheaper than the fixed rate it replaces');
});

test('a dearer market is followed up, to the cap', () => {
  assert.equal(tipFor({ rewards: blocks(0.5, 0.6, 0.55), gas: SETTLE_GAS, minTotalWei: MIN_TOTAL, capWei: CAP }), gwei(0.55));
  assert.equal(tipFor({ rewards: blocks(9, 11, 10), gas: SETTLE_GAS, minTotalWei: MIN_TOTAL, capWei: CAP }), CAP, 'a spike is capped');
});

test('a history that gives no reading falls back to the fixed rate, never to zero', () => {
  assert.equal(tipFor({ rewards: [], gas: SETTLE_GAS, minTotalWei: MIN_TOTAL, capWei: CAP, fallbackWei: gwei(0.1) }), gwei(0.1));
  assert.equal(tipFor({ rewards: null, gas: SETTLE_GAS, minTotalWei: MIN_TOTAL, capWei: CAP, fallbackWei: gwei(0.1) }), gwei(0.1));
  // Blocks that really did pay nothing still clear the total floor, so nothing is ever offered a zero tip.
  const z = tipFor({ rewards: blocks(0, 0, 0), gas: SETTLE_GAS, minTotalWei: MIN_TOTAL, capWei: CAP, fallbackWei: gwei(0.1) });
  assert.equal(z > 0n, true);
  assert.equal(z * SETTLE_GAS >= MIN_TOTAL, true);
});

test('without a gas figure the floor cannot apply, and the market or the fallback stands', () => {
  assert.equal(tipFor({ rewards: QUIET, gas: 0n, minTotalWei: MIN_TOTAL, capWei: CAP, fallbackWei: gwei(0.1) }), gwei(0.02));
  assert.equal(tipFor({ rewards: [], gas: 0n, minTotalWei: MIN_TOTAL, capWei: CAP, fallbackWei: gwei(0.1) }), gwei(0.1));
});

test('read from a client: one fee-history call, and every failure is the fallback', async () => {
  const calls = [];
  const client = { getFeeHistory: async (a) => { calls.push(a); return { reward: QUIET }; } };
  assert.equal(await readTip(client, { gas: HEADER_GAS, minTotalWei: MIN_TOTAL, capWei: CAP, fallbackWei: gwei(0.05) }), gwei(0.02));
  assert.deepEqual(calls, [{ blockCount: TIP_HISTORY_BLOCKS, rewardPercentiles: [TIP_PERCENTILE] }]);
  const down = { getFeeHistory: async () => { throw new Error('node down'); } };
  assert.equal(await readTip(down, { gas: HEADER_GAS, minTotalWei: MIN_TOTAL, capWei: CAP, fallbackWei: gwei(0.05) }), gwei(0.05));
  const junk = { getFeeHistory: async () => ({}) };
  assert.equal(await readTip(junk, { gas: HEADER_GAS, minTotalWei: MIN_TOTAL, capWei: CAP, fallbackWei: gwei(0.05) }), gwei(0.05));
});

test('a tuned floor falls slowly on first-round landings, doubles on a miss, and stays within its bounds', () => {
  const START = 20_000_000_000_000n, MIN = 4_000_000_000_000n;
  const f = makeTipFloor({ startWei: START, minWei: MIN, maxWei: START });
  assert.equal(f.value(), START, 'it starts at the full floor');
  for (let i = 0; i < 10; i++) f.record(true);
  assert.equal(f.value() < START && f.value() > (START * 70n) / 100n, true, 'ten prompt landings take about a quarter off, not more');
  for (let i = 0; i < 400; i++) f.record(true);
  assert.equal(f.value(), MIN, 'it never falls under its minimum');
  f.record(false);
  assert.equal(f.value(), MIN * 2n, 'a miss doubles it');
  for (let i = 0; i < 10; i++) f.record(false);
  assert.equal(f.value(), START, 'and it never rises over the full floor');
  const t = makeTipFloor({ startWei: 100n, minWei: 50n, maxWei: 100n });
  t.record(true); t.record(true);
  assert.equal(t.value() >= 50n && t.value() <= 100n, true);
  // the floor feeds tipFor as the total: a lower floor lowers the tip only where the floor was what set it
  const dear = tipFor({ rewards: QUIET, gas: SETTLE_GAS, minTotalWei: START, capWei: CAP });
  const cheap = tipFor({ rewards: QUIET, gas: SETTLE_GAS, minTotalWei: MIN, capWei: CAP });
  assert.equal(cheap < dear, true, 'a lower floor offers less');
  assert.equal(cheap, gwei(0.02), 'and a floor under the market leaves the market tip');
});
