// A share cap on one activity (src/lib/points-engagement.js countedRows, points-counted.js): its points together can take at
// most that share of a day's counted points, however much of it there is and however many addresses do it, so loops of one
// kind keep earning but cannot take the pot from everyone else. Nothing is limited per address.
//   node worker-relay/tests/points-share-cap.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { makeCounted } from '../src/lib/points-counted.js';
import { parseCategoryShareCaps, categoryShareCapsForDay, countedRows } from '../src/lib/points-engagement.js';
import { programTerms } from '../src/lib/points-program.js';
import { splitDayBudget } from '../src/lib/points-day-board.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const by = (rows) => Object.fromEntries(rows.map((r) => [r.address, r]));
const sum = (rows, f = () => true) => rows.filter(f).reduce((s, r) => s + r.dayPoints, 0);

{
  const s = parseCategoryShareCaps('20741:evmpooldeposit=0.5;20800:evmpooldeposit=0.4,wrap=0.9;20900:off');
  assert.deepEqual(s.map((e) => e.fromDay), [20741, 20800, 20900]);
  assert.deepEqual(categoryShareCapsForDay(s, 20740), {});
  assert.deepEqual(categoryShareCapsForDay(s, 20741), { evmpooldeposit: 0.5 });
  assert.deepEqual(categoryShareCapsForDay(s, 20850), { evmpooldeposit: 0.4, wrap: 0.9 }, 'a later entry replaces the earlier one');
  assert.deepEqual(categoryShareCapsForDay(s, 20900), {}, '"off" ends them');
  const bad = [];
  assert.deepEqual(parseCategoryShareCaps('x;20741:evmpooldeposit=1;20741:evmpooldeposit=0;20741:evmpooldeposit=half;20741:Bad-Name=0.5', (m) => bad.push(m)), []);
  assert.equal(bad.length, 5, 'every malformed entry is ignored with a reason');
  console.log('ok - the schedule parses, applies from its day, is replaced or ended, and refuses nonsense');
}

{
  // Three ordinary addresses with 600 points between them; two loopers with 20,000 of the capped activity.
  const honest = [['h1', 100], ['h2', 200], ['h3', 300]].map(([a, p]) => ({ address: a, activity: 'wrap', points: p }));
  const loops = [['l1', 5000], ['l2', 15000]].map(([a, p]) => ({ address: a, activity: 'evmpooldeposit', points: p }));
  const rows = [...honest, ...loops];
  const plain = by(countedRows({ dayRows: rows }));
  assert.equal(sum(Object.values(plain), (r) => r.address.startsWith('l')) / sum(Object.values(plain)), 20000 / 20600, 'without a cap the loops take 97% of the day');

  const cap = by(countedRows({ dayRows: rows, shareCaps: { evmpooldeposit: 0.5 } }));
  const all = Object.values(cap);
  close(sum(all, (r) => r.address.startsWith('l')) / sum(all), 0.5);
  assert.deepEqual(['h1', 'h2', 'h3'].map((a) => cap[a].dayPoints), [100, 200, 300], 'everyone else counts as before');
  close(cap.l1.dayPoints / cap.l2.dayPoints, 5000 / 15000);
  assert.equal(cap.l2.rawPoints, 15000, 'the points scored are what they were');
  // More loops earn more of the loops' share; nothing is limited per address.
  const more = by(countedRows({ dayRows: [...rows, { address: 'l1', activity: 'evmpooldeposit', points: 100000 }], shareCaps: { evmpooldeposit: 0.5 } }));
  close(sum(Object.values(more), (r) => r.address.startsWith('l')) / sum(Object.values(more)), 0.5);
  assert.ok(more.l1.dayPoints > cap.l1.dayPoints && more.l2.dayPoints < cap.l2.dayPoints, 'doing more takes more of the loops\' share');
  console.log('ok - the capped activity cannot take more than its share however much of it there is, and the rest is split as before');
}

{
  // Under the cap nothing changes; with nothing else counted there is nothing to share with.
  const small = [{ address: 'a', activity: 'wrap', points: 600 }, { address: 'l', activity: 'evmpooldeposit', points: 100 }];
  assert.deepEqual(countedRows({ dayRows: small, shareCaps: { evmpooldeposit: 0.5 } }).map((r) => r.dayPoints), [600, 100], 'a share under the cap is untouched');
  const only = [{ address: 'l1', activity: 'evmpooldeposit', points: 100 }, { address: 'l2', activity: 'evmpooldeposit', points: 900 }];
  assert.deepEqual(countedRows({ dayRows: only, shareCaps: { evmpooldeposit: 0.5 } }).map((r) => r.dayPoints), [100, 900], 'with nothing else counted the loops stand');
  // An address with both: only its capped activity is scaled.
  const both = by(countedRows({ dayRows: [{ address: 'm', activity: 'wrap', points: 1000 }, { address: 'm', activity: 'evmpooldeposit', points: 9000 }], shareCaps: { evmpooldeposit: 0.5 } }));
  close(both.m.dayPoints, 2000, 1e-9);
  console.log('ok - under the cap, or with nothing else counted, days are untouched; an address with both loses only the capped part');
}

{
  // The share is of what the pot is split by: counted points times the week's multiplier, and after weights.
  const spec = { kindStep: 0.25, returnStep: 0.25, maxKinds: 2, minPoints: 25 };
  const dayRows = [
    { address: 'h', activity: 'wrap', points: 400 }, { address: 'h', activity: 'zswapeth', points: 100 },
    { address: 'l', activity: 'evmpooldeposit', points: 50000 },
  ];
  const weekRows = [
    { address: 'h', day: 5, activity: 'wrap', points: 400 }, { address: 'h', day: 5, activity: 'zswapeth', points: 100 }, { address: 'h', day: 4, activity: 'wrap', points: 50 },
    { address: 'l', day: 5, activity: 'evmpooldeposit', points: 50000 },
  ];
  const r = countedRows({ dayRows, weekRows, spec, shareCaps: { evmpooldeposit: 0.5 } });
  close(sum(r, (x) => x.address === 'l') / sum(r), 0.5);
  assert.equal(by(r).h.factor, 1.5, 'the week\'s multiplier is as before (two kinds, two days)');
  const w = countedRows({ dayRows, weights: { evmpooldeposit: 0.5 }, shareCaps: { evmpooldeposit: 0.5 } });
  close(sum(w, (x) => x.address === 'l') / sum(w), 0.5, 1e-9);
  const lowWeight = countedRows({ dayRows: [{ address: 'h', activity: 'wrap', points: 1000 }, { address: 'l', activity: 'evmpooldeposit', points: 1000 }], weights: { evmpooldeposit: 0.1 }, shareCaps: { evmpooldeposit: 0.5 } });
  assert.deepEqual(lowWeight.map((x) => x.dayPoints), [1000, 100], 'a weight that already keeps it under its share is left as it is');
  console.log('ok - the share is of counted points, after weights and times the week\'s multiplier');
}

{
  // With the TAC-per-point ceiling in force a share of the pot is a budget of points, so the activity pays at most that share
  // of the pot however few points the others hold (a share of points would pay it far less when the ceiling trims the pot).
  const TAC = 10n ** 18n, budget = 1111n * TAC, ceil = 3n * 10n ** 16n, share = 0.5;
  const X = (share * Number(budget)) / Number(ceil);
  close(X, 18516.67, 1e-4);
  const run = (others, loops, caps) => {
    const rows = [];
    others.forEach((p, i) => rows.push({ address: 'h' + i, activity: 'wrap', points: p }));
    loops.forEach((p, i) => rows.push({ address: 'l' + i, activity: 'evmpooldeposit', points: p }));
    const paid = splitDayBudget(countedRows({ dayRows: rows, ...caps }), budget, ceil);
    const sumTac = (pre) => [...paid].filter(([a]) => a.startsWith(pre)).reduce((t, [, w]) => t + w, 0n);
    return { loop: sumTac('l'), other: sumTac('h') };
  };
  for (const [others, loops] of [[[1200, 2400], [5e6, 8e6, 3e6]], [[3000, 6000], [2e6]], [[10000, 8000, 4000], [5e5]], [[1e5, 2e5], [5e6]], [[1e6], [1e7, 1e7]], [[500], [100]]]) {
    const before = run(others, loops, {}), after = run(others, loops, { shareCaps: { evmpooldeposit: share }, pointCaps: { evmpooldeposit: X } });
    assert.ok(after.loop <= (budget * 5n) / 10n + 10n ** 12n, `the loops are paid at most half the pot (${after.loop})`);
    if (loops.reduce((a, b) => a + b, 0) > 1e5) assert.ok(after.loop >= (budget * 4n) / 10n, `and, with that many points, at least about half of it (${after.loop})`);
    assert.ok(after.other >= before.other, 'everyone else is paid at least what they were');
    const t = (x) => Number(x / 10n ** 16n) / 100;
    console.log(`   others ${others.reduce((a, b) => a + b, 0)} pts, loops ${loops.reduce((a, b) => a + b, 0).toExponential(1)} pts: loops ${t(before.loop)} -> ${t(after.loop)} TAC, others ${t(before.other)} -> ${t(after.other)} TAC`);
  }
  // A small loop under its budget is untouched, and loops alone are held to the same budget.
  assert.deepEqual(run([1000], [100], { shareCaps: { evmpooldeposit: share }, pointCaps: { evmpooldeposit: X } }), run([1000], [100], {}));
  console.log('ok - with the ceiling, the capped activity is paid half the pot on a quiet day and on a busy one, never more, and the others are never paid less');
}

const ETH = 10n ** 18n, DAY = 86400, D = 20741;
let n = 0;
const dep = (depositor, day, activity, points, extra = {}) => ({ txHash: '0x' + (++n).toString(16).padStart(64, '0'), blockNumber: n, blockTime: day * DAY + 100 + n, depositor, amountWei: String(ETH), priorDepositCount: 0, points, activity, chainId: 1, ...extra });
const dir = mkdtempSync(join(tmpdir(), 'points-share-'));
try {
  const store = openStore(join(dir, 'p.db'));
  for (const day of [D - 1, D]) {
    for (let i = 0; i < 50; i++) store.recordDeposit(dep('0x' + 'a'.repeat(40), day, 'evmpooldeposit', 2000));
    for (let i = 0; i < 80; i++) store.recordDeposit(dep('0x' + 'b'.repeat(40), day, 'evmpooldeposit', 2000));
    store.recordDeposit(dep('0x' + 'c'.repeat(40), day, 'wrap', 300));
    store.recordDeposit(dep('0x' + 'd'.repeat(40), day, 'zswapeth', 500));
  }
  const counted = makeCounted({ store, shareCapSchedule: parseCategoryShareCaps(`${D}:evmpooldeposit=0.5`) });
  const before = counted.rows(D - 1), legacy = store.dayPointsByAddress((D - 1) * DAY, D * DAY);
  assert.deepEqual(before.map((r) => [r.address, r.dayPoints]), legacy.map((r) => [r.address, r.dayPoints]), 'the day before it starts re-splits to exactly the store\'s sums');
  const on = counted.rows(D), look = by(on);
  close(sum(on, (r) => /^0x[ab]/.test(r.address)) / sum(on), 0.5);
  assert.equal(look['0x' + 'c'.repeat(40)].dayPoints, 300);
  assert.equal(look['0x' + 'd'.repeat(40)].dayPoints, 500);
  assert.equal(look['0x' + 'b'.repeat(40)].rawPoints, 160000, 'raw points are untouched');
  const budgeted = makeCounted({ store, shareCapSchedule: parseCategoryShareCaps(`${D}:evmpooldeposit=0.5`), potFor: () => ({ budgetWei: 1111n * ETH, maxWeiPerPoint: 3n * 10n ** 16n }) });
  const bud = budgeted.rows(D);
  close(sum(bud, (r) => /^0x[ab]/.test(r.address)), 18516.666667, 1e-6);
  assert.equal(budgeted.rows(D - 1).length, legacy.length, 'and the day before the start still re-splits to the store');
  console.log('ok - through the store with the day\'s budget and ceiling known, the capped activity counts as a budget of points');
  const onTime = makeCounted({ store, shareCapSchedule: parseCategoryShareCaps(`${D}:evmpooldeposit=0.5`), onTime: true }).rows(D);
  close(sum(onTime, (r) => /^0x[ab]/.test(r.address)) / sum(onTime), 0.5);
  console.log('ok - through the store: days before the start are untouched and the capped activity takes half of the day');

  const cfg = {
    pointsProgramStartSec: 20719 * 86400 + 5, pointsProgramDays: 90, pointsProgramTotalWei: 100_000n * ETH, pointsSettleGraceSecs: 1800,
    pointsBasePerEth: 1000, tethWrapBoostMultiplier: 1.25, pointsBasePerZswapEth: 1000, pointsBasePerCbtc: 1000, pointsBasePerCusd: 1, cusdMintBonusMultiplier: 2,
    pointsBasePerPmBet: 1000, pointsPerPmCreate: 50, pointsBasePerEvmPoolEth: 1000, evmPoolPointsStartBlocks: { 1: '24000000', 8453: '', 4663: '' },
    weinameEnabled: true, pointsBasePerWeiname: 1000, btcPoolPointsStartHeight: '', pointsBasePerBtcPoolTac: 1,
    pointsBonusScale: 4, pointsBonusHalfLife: 200, tacBoostWindowBlocks: 7200, pointsBondHoldFromDay: 0, pointsCbtcHoldRate: 0, pointsCbtcHoldFromDay: 0,
  };
  const t = programTerms({ cfg, dayBudgetWei: () => 1111n * ETH, categoryShareCaps: parseCategoryShareCaps(`${D}:evmpooldeposit=0.5`) });
  assert.deepEqual(t.categoryShareCaps, [{ fromDay: D, caps: { evmpooldeposit: 0.5 } }]);
  assert.deepEqual(programTerms({ cfg, dayBudgetWei: () => 1111n * ETH }).categoryShareCaps, [], 'none configured states none');
  console.log('ok - the program terms state the share cap');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
