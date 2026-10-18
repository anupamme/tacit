// The liquidity campaign's rules (src/lib/points-lp.js): the schedule, the pools, what a pool and a share in it are worth, and
// how a day's amount is shared out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAD, parseLpSchedule, lpTermsForDay, nextLpTerms, parseLpPools, poolPrice, poolValueUsd, shareValueUsd, allocateLpDay,
  openId, dayId, dayOf, dayIsDone, holdReason, MAX_DAILY_WEI, CREDIT_PREFIX,
} from '../src/lib/points-lp.js';

const tac = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const usdc = (n) => BigInt(Math.round(n * 1e6));
const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
const POOL = '0xAaaa000000000000000000000000000000000001', POOL2 = '0xBbbb000000000000000000000000000000000002';

test('the schedule reads what each day pays, and a later entry replaces an earlier one', () => {
  const s = parseLpSchedule('20750:daily=50,create=150,cap=0.02;20780:daily=200,create=150,cap=0.02;20810:off');
  assert.equal(s.length, 3);
  assert.equal(lpTermsForDay(s, 20749), null, 'nothing before it starts');
  assert.deepEqual(
    { ...lpTermsForDay(s, 20750) },
    { fromDay: 20750, dailyWei: tac(50), createWei: tac(150), capWeiPerUsdDay: tac(0.02) },
  );
  assert.equal(lpTermsForDay(s, 20779).dailyWei, tac(50), 'the first entry holds until the next');
  assert.equal(lpTermsForDay(s, 20780).dailyWei, tac(200), 'then the next replaces it');
  assert.equal(lpTermsForDay(s, 20810), null, 'off ends it');
  assert.equal(lpTermsForDay(s, 99999), null);
  assert.equal(nextLpTerms(s, 20750).fromDay, 20780);
  assert.equal(nextLpTerms(s, 20810), null);
});

test('a malformed entry is skipped and reported, and pays nothing', () => {
  const said = [];
  const s = parseLpSchedule([
    '20750:daily=50,cap=0.02',          // kept (create defaults to nothing)
    'nonsense',
    '20751:daily=50',                   // no cap
    '20752:daily=50,cap=0',             // a cap of zero
    '20753:daily=99999,cap=0.02',       // over the daily limit
    '20754:daily=50,cap=0.02,create=9999', // over the create limit
    '20755:daily=1e3,cap=0.02',         // not an amount
    '20756:daily=50,daily=60,cap=0.02', // twice
    '0:daily=50,cap=0.02',              // no such day
  ].join(';'), (m) => said.push(m));
  assert.deepEqual(s.map((e) => e.fromDay), [20750]);
  assert.equal(s[0].createWei, 0n);
  assert.equal(said.length, 8, said.join('\n'));
  assert.ok(said.every((m) => m.startsWith('ignoring POINTS_LP_SCHEDULE entry')));
  assert.deepEqual(parseLpSchedule(''), []);
  assert.deepEqual(parseLpSchedule(undefined), []);
  assert.ok(parseLpSchedule(`20750:daily=5000,cap=0.02`)[0].dailyWei === MAX_DAILY_WEI, 'the limit itself is allowed');
});

test('the pools are read with their weights, and a bad one is skipped', () => {
  const said = [];
  const p = parseLpPools(`${POOL}, ${POOL2}=0.5, 0xnope=1, ${POOL}=2, ${POOL2.toLowerCase()}, 0x3333333333333333333333333333333333333333=21`, (m) => said.push(m));
  assert.deepEqual(p, [{ pool: POOL.toLowerCase(), weightBps: 10_000n }, { pool: POOL2.toLowerCase(), weightBps: 5_000n }]);
  assert.equal(said.length, 4, said.join('\n'));
  assert.deepEqual(parseLpPools(''), []);
});

test('a pool is valued with its synth marked at the lower of the pool price and the peg', () => {
  // A TACD/USDC pool at the peg: 1,000 TACD and 1,000 USDC is $2,000, whichever way the tokens are ordered.
  const atPeg = { reserveSynth: 1000n * WAD, reserveQuote: usdc(1000), quoteDec: 6, quoteUsdWei: WAD };
  const sqrtPeg1 = 10n ** 24n;                                      // synth is token1: sqrt(1e18/1e6 * 1e36) = 1e24
  const sqrtPeg0 = 10n ** 12n;                                      // synth is token0: sqrt(1e6/1e18 * 1e36) = 1e12
  assert.equal(poolValueUsd({ ...atPeg, sqrtNow: sqrtPeg1, synthIs1: true }), 2000n * WAD);
  assert.equal(poolValueUsd({ ...atPeg, sqrtNow: sqrtPeg0, synthIs1: false }), 2000n * WAD);
  // The pool price is above the peg: the synth is still marked at 1, so pushing the price up earns nothing. With the synth as
  // token1 the price is of quote per synth, so a HIGHER synth price is a LOWER square root.
  const high = poolValueUsd({ ...atPeg, sqrtNow: (sqrtPeg1 * 10n) / 11n, synthIs1: true });
  assert.ok(poolPrice({ sqrtNow: (sqrtPeg1 * 10n) / 11n, synthIs1: true, quoteDec: 6 }) > WAD, 'that root really is a price over the peg');
  assert.equal(high, 2000n * WAD, 'above the peg the mark stops at the peg');
  // The pool price is half the peg: the synth side is worth half, so the pool is $1,500 rather than $2,000.
  const halfSqrt = 1414213562373095048801688n;                      // sqrt(2) x the peg's root: the price of the synth halves
  const low = poolValueUsd({ ...atPeg, sqrtNow: halfSqrt, synthIs1: true });
  assert.ok(low > 1499n * WAD && low <= 1500n * WAD, `about $1,500, not $2,000: ${low}`);
  // The same the other way round, with the synth as token0: a higher root is a higher synth price.
  const low0 = poolValueUsd({ ...atPeg, sqrtNow: (sqrtPeg0 * 7071n) / 10000n, synthIs1: false });
  assert.ok(low0 > 1499n * WAD && low0 <= 1500n * WAD, `about $1,500 with the tokens the other way: ${low0}`);
  assert.equal(poolValueUsd({ ...atPeg, sqrtNow: sqrtPeg0 * 2n, synthIs1: false }), 2000n * WAD, 'and the mark still stops at the peg');
  // A TACE/ETH pool: both sides 18 decimals, the quote worth $2,500.
  const tace = poolValueUsd({ reserveSynth: 2n * WAD, reserveQuote: 2n * WAD, quoteDec: 18, quoteUsdWei: 2500n * WAD, sqrtNow: WAD, synthIs1: true });
  assert.equal(tace, 10_000n * WAD, '2 ETH + 2 TACE at $2,500 is $10,000');
  // Nothing is valued without a price or a quote price.
  assert.equal(poolValueUsd({ ...atPeg, sqrtNow: 0n, synthIs1: true }), null);
  assert.equal(poolValueUsd({ ...atPeg, sqrtNow: sqrtPeg1, synthIs1: true, quoteUsdWei: null }), null);
  assert.equal(poolPrice({ sqrtNow: sqrtPeg1, synthIs1: true, quoteDec: 6 }), WAD);
  assert.equal(poolPrice({ sqrtNow: sqrtPeg0, synthIs1: false, quoteDec: 6 }), WAD);
});

test('a share is worth its part of the pool', () => {
  assert.equal(shareValueUsd(25n, 100n, 2000n * WAD), 500n * WAD);
  assert.equal(shareValueUsd(0n, 100n, 2000n * WAD), 0n);
  assert.equal(shareValueUsd(25n, 0n, 2000n * WAD), 0n);
});

test('a day is shared by the value held, weighted, and no dollar earns more than the cap', () => {
  const cap = tac(0.02), daily = tac(50);
  // $5,000 of liquidity: the whole day's amount goes out, split by value.
  const rows = [
    { address: A, pool: POOL, valueUsdWei: 4000n * WAD, weightBps: 10_000n },
    { address: B, pool: POOL, valueUsdWei: 1000n * WAD, weightBps: 10_000n },
  ];
  const paid = allocateLpDay({ rows, dailyWei: daily, capWeiPerUsdDay: cap });
  assert.deepEqual(paid.map((p) => p.address), [A, B]);
  assert.equal(paid[0].wei + paid[1].wei, daily, 'the day pays exactly its amount');
  assert.equal(paid[0].wei, daily * 4n / 5n);
  // Thin liquidity: the cap binds and the rest stays in the pocket.
  const thin = allocateLpDay({ rows: [{ address: A, pool: POOL, valueUsdWei: 500n * WAD, weightBps: 10_000n }], dailyWei: daily, capWeiPerUsdDay: cap });
  assert.equal(thin[0].wei, cap * 500n, '$500 earns 500 x the cap, not the whole day');
  assert.ok(thin[0].wei < daily);
  // A weight scales both the share and the cap.
  const half = allocateLpDay({ rows: [{ address: A, pool: POOL2, valueUsdWei: 500n * WAD, weightBps: 5_000n }], dailyWei: daily, capWeiPerUsdDay: cap });
  assert.equal(half[0].wei, (cap * 500n) / 2n, 'at half weight a dollar earns half as much');
  // Two pools, one address: paid once, for both.
  const both = allocateLpDay({
    rows: [
      { address: A, pool: POOL, valueUsdWei: 1000n * WAD, weightBps: 10_000n },
      { address: A, pool: POOL2, valueUsdWei: 1000n * WAD, weightBps: 5_000n },
      { address: B, pool: POOL, valueUsdWei: 1000n * WAD, weightBps: 10_000n },
    ],
    dailyWei: daily, capWeiPerUsdDay: tac(1),
  });
  assert.equal(both.length, 2);
  assert.equal(both.find((p) => p.address === A).wei, daily * 15n / 25n, 'weighted $1,500 of the $2,500 counted');
  // Nothing to pay: no rows, no value, no amount.
  assert.deepEqual(allocateLpDay({ rows: [], dailyWei: daily, capWeiPerUsdDay: cap }), []);
  assert.deepEqual(allocateLpDay({ rows: [{ address: A, pool: POOL, valueUsdWei: 0n, weightBps: 10_000n }], dailyWei: daily, capWeiPerUsdDay: cap }), []);
  assert.deepEqual(allocateLpDay({ rows, dailyWei: 0n, capWeiPerUsdDay: cap }), []);
});

test('a day never pays more than its amount, whatever the values are', () => {
  const daily = tac(50), cap = tac(1);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 300; round++) {
    const rows = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, i) => ({
      address: `0x${String(i).padStart(40, '0')}`,
      pool: rnd() < 0.5 ? POOL : POOL2,
      valueUsdWei: BigInt(Math.floor(rnd() * 5_000_000)) * 10n ** 12n,
      weightBps: BigInt(1 + Math.floor(rnd() * 20_000)),
    }));
    const total = allocateLpDay({ rows, dailyWei: daily, capWeiPerUsdDay: cap }).reduce((s, p) => s + p.wei, 0n);
    assert.ok(total <= daily, `round ${round}: paid ${total} of ${daily}`);
  }
});

test('an id names a pool, or an address and a day', () => {
  assert.equal(openId(POOL), `lp:open:${POOL.toLowerCase()}`);
  assert.equal(dayId(20750, A.toUpperCase().replace('0X', '0x')), `lp:day:20750:${A}`);
  assert.ok(openId(POOL).startsWith(CREDIT_PREFIX) && dayId(1, A).startsWith(CREDIT_PREFIX), 'both are found by the prefix the pocket is counted by');
  assert.equal(dayOf(20750 * 86400 + 5), 20750);
  assert.equal(dayIsDone(20750, 20751 * 86400 - 1, 0), false);
  assert.equal(dayIsDone(20750, 20751 * 86400, 0), true);
  assert.equal(dayIsDone(20750, 20751 * 86400 + 1799, 1800), false, 'a day waits out the same grace the pot does');
  assert.equal(dayIsDone(20750, 20751 * 86400 + 1800, 1800), true);
});

test('a credit waits when the campaign has ended, the pocket is spent, or funding would fall short', () => {
  const ok = () => ({ shortfallWei: 0n, daysCovered: 10 });
  const base = { wei: tac(10), creditedWei: 0n, pocketWei: tac(100), nowSec: 1000, endSec: 2000, status: ok, reserveDays: 2 };
  assert.equal(holdReason(base), null);
  assert.equal(holdReason({ ...base, endSec: 0 }), 'ended', 'no end time, no campaign');
  assert.equal(holdReason({ ...base, nowSec: 2001 }), 'ended');
  assert.equal(holdReason({ ...base, creditedWei: tac(95) }), 'pocket', 'what would take it past the pocket waits');
  assert.equal(holdReason({ ...base, creditedWei: tac(90) }), null, 'the pocket exactly is still fine');
  assert.equal(holdReason({ ...base, status: () => ({ shortfallWei: 1n, daysCovered: 10 }) }), 'funding');
  assert.equal(holdReason({ ...base, status: () => ({ shortfallWei: 0n, daysCovered: 1 }) }), 'funding', 'fewer than the reserve days covered');
  assert.equal(holdReason({ ...base, status: () => null }), 'funding unread', 'a failed read never looks funded');
  let asked = null;
  holdReason({ ...base, status: (x) => { asked = x; return ok(); } });
  assert.equal(asked, tac(10), 'funding is asked with the credit counted');
});
