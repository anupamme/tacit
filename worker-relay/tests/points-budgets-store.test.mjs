// Reserved budgets through the store: a day's counted rows carry their points by activity when groups share it, the days before are exactly
// as they were, the day is paid through the groups, a late credit goes through them too, and the program states them.
//   node worker-relay/tests/points-budgets-store.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { makeCounted } from '../src/lib/points-counted.js';
import { parseBudgets, budgetsForDay } from '../src/lib/points-budgets.js';
import { parseEngagementSchedule, parseCategoryShareCaps } from '../src/lib/points-engagement.js';
import { splitDayBudget, dayPot } from '../src/lib/points-day-board.js';
import { owedForDay } from '../src/lib/points-late-credit.js';
import { programTerms } from '../src/lib/points-program.js';

const TAC = 10n ** 18n, BUDGET = 1111n * TAC, CEIL = 3n * TAC / 100n, D = 20747, DAY = 86400;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
let n = 0;
const dep = (depositor, day, activity, points, extra = {}) => ({ txHash: '0x' + (++n).toString(16).padStart(64, '0'), blockNumber: n, blockTime: day * DAY + 100 + n, depositor, amountWei: '1000000000000000000', priorDepositCount: 0, points, activity, ...extra });
const by = (rows) => Object.fromEntries(rows.map((r) => [r.address, r]));
const sum = (m) => [...m.values()].reduce((s, v) => s + v, 0n);

const dir = mkdtempSync(join(tmpdir(), 'points-budgets-'));
try {
  const store = openStore(join(dir, 'p.db'));
  for (const d of [D - 1, D]) {
    store.recordDeposit(dep(A, d, 'wrap', 900_000));                 // a looper
    store.recordDeposit(dep(A, d, 'evmpooldeposit', 1_800_000));
    store.recordDeposit(dep(B, d, 'holding', 2_000));                // someone who stays
    store.recordDeposit(dep(C, d, 'zswapeth', 1_000));               // someone who uses
  }
  const budgetSchedule = parseBudgets(`${D}:stay=holding+cbtchold@0.25/0.02,use=zswapeth+cusdmint@0.15/0.01`);
  const engagementSchedule = parseEngagementSchedule('20730:0.25,0.25,2,25');
  const shareCapSchedule = parseCategoryShareCaps(`${D - 1}:evmpooldeposit=0.5`);
  const counted = makeCounted({ store, engagementSchedule, shareCapSchedule, budgetSchedule, potFor: () => ({ budgetWei: BUDGET, maxWeiPerPoint: CEIL }) });

  // before the first day of the groups nothing carries activity: the rows are what they were
  const before = counted.rows(D - 1);
  assert.ok(before.every((r) => r.by === undefined), 'a day before the groups has the rows it always had');
  assert.deepEqual(counted.groupsFor(D - 1), []);
  assert.equal(counted.groupsFor(D).length, 2);
  // from it, each row carries its points by activity, and they add up to the row's points
  const rows = counted.rows(D);
  for (const r of rows) {
    const total = Object.values(r.by).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(total - r.dayPoints) < 1e-6, `${r.address}: by activity adds up to the day's points (${total} vs ${r.dayPoints})`);
  }
  const a = by(rows)[A];
  assert.ok(Math.abs(a.by.wrap / a.factor - 900_000) < 1e-6 && Math.abs(a.by.evmpooldeposit / a.factor - 903_000) < 1e-6, 'the by figures are after the multiplier and the share cap: the deposits are scaled down to everything else counted (903,000)');
  assert.deepEqual(Object.keys(by(rows)[B].by), ['holding']);
  // the rows are the same on a day the groups have not reached when asked to carry activity
  const preview = counted.rows(D - 1, { withGroups: true });
  assert.ok(preview.every((r) => r.by), 'a coming schedule can be previewed on the day so far');
  assert.deepEqual(preview.map((r) => [r.address, r.dayPoints]), before.map((r) => [r.address, r.dayPoints]), 'with the same points');
  console.log('ok - counted rows carry their points by activity only where groups share the day, and they add up');

  // the day through the groups
  const groups = counted.groupsFor(D);
  const paid = splitDayBudget(rows, BUDGET, CEIL, groups);
  const flat = splitDayBudget(rows, BUDGET, CEIL);
  const pts = (x) => BigInt(Math.round(by(rows)[x].dayPoints));                     // 2,000 and 1,000 points, each times 1.25 for returning
  assert.equal(pts(B), 2_500n);
  assert.equal(paid.get(B), pts(B) * 2n * TAC / 100n, 'the one who stays is paid at the group\'s 0.02 TAC a point');
  assert.equal(paid.get(C), pts(C) * TAC / 100n, 'the one who uses at 0.01');
  assert.ok(paid.get(B) > flat.get(B) * 30n && paid.get(C) > flat.get(C) * 15n, 'each far more than one pro-rata split paid (here 40x and 20x)');
  assert.ok(sum(paid) <= BUDGET && BUDGET - sum(paid) < 10n && paid.get(A) > flat.get(A) * 94n / 100n && paid.get(A) + paid.get(B) + paid.get(C) <= BUDGET, 'the looper is paid the rest of the pot: only what the other two earn (62.5 TAC of 1,111) is gone');
  assert.equal(dayPot(rows, BUDGET, CEIL, groups).pot, BUDGET);
  console.log('ok - a day is paid through its groups, and the rest of the pot stays with the open group');

  // a late credit is the difference through the same groups
  const onTime = rows.filter((r) => r.address !== C), all = rows;
  const owed = owedForDay({ allRows: all, onTimeRows: onTime, budgetWei: BUDGET, maxWeiPerPoint: CEIL, groups });
  assert.equal(owed.get(C), paid.get(C), 'C, whose row came late, is owed what its row is paid through the groups');
  assert.ok(!owed.has(B), 'and nobody else is owed anything for it');
  console.log('ok - a late credit is worked out through the same groups');

  // the program says them
  const cfg = {
    pointsProgramStartSec: 20719 * 86400, pointsProgramDays: 90, pointsProgramTotalWei: 100_000n * TAC, pointsSettleGraceSecs: 1800,
    pointsBasePerEth: 1000, tethWrapBoostMultiplier: 1.25, pointsBasePerZswapEth: 1000, pointsBasePerCbtc: 1000, pointsBasePerCusd: 1, cusdMintBonusMultiplier: 2,
    pointsBasePerPmBet: 1000, pointsPerPmCreate: 50, pointsBasePerEvmPoolEth: 1000, evmPoolPointsStartBlocks: {}, weinameEnabled: false, btcPoolPointsStartHeight: '',
    pointsBonusScale: 4, pointsBonusHalfLife: 200, tacBoostWindowBlocks: 7200, pointsBondHoldFromDay: 0, pointsCbtcHoldRate: 0, pointsCbtcHoldFromDay: 0,
    holdingEnabled: true, holdingRate: 1000,
  };
  const terms = programTerms({ cfg, dayBudgetWei: () => BUDGET, budgets: [...budgetSchedule, { fromDay: D + 30, groups: [] }] });
  assert.deepEqual(terms.budgets[0], { fromDay: D, groups: [
    { name: 'stay', activities: ['holding', 'cbtchold'], share: 0.25, maxWeiPerPoint: (2n * TAC / 100n).toString() },
    { name: 'use', activities: ['zswapeth', 'cusdmint'], share: 0.15, maxWeiPerPoint: (TAC / 100n).toString() },
  ] });
  assert.deepEqual(terms.budgets[1], { fromDay: D + 30, off: true });
  assert.equal(terms.rates.holding, 1000, 'the holding reward\'s rate is among what the program pays');
  assert.deepEqual(programTerms({ cfg: { ...cfg, holdingEnabled: false }, dayBudgetWei: () => BUDGET }).budgets, [], 'with no groups the terms say none');
  assert.equal(programTerms({ cfg: { ...cfg, holdingEnabled: false }, dayBudgetWei: () => BUDGET }).rates.holding, undefined, 'and a reward that is off is left out');
  assert.deepEqual(budgetsForDay(budgetSchedule, D + 5).map((g) => g.name), ['stay', 'use']);
  console.log('ok - the program states its groups and the holding rate, and says none when there are none');
  store.close?.();
} finally { rmSync(dir, { recursive: true, force: true }); }
