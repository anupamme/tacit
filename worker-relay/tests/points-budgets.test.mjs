// Reserved budgets (src/lib/points-budgets.js): the schedule, how a day is shared by group, and that with no group in force the day is split exactly as before.
//   node worker-relay/tests/points-budgets.test.mjs

import assert from 'node:assert/strict';
import { parseBudgets, budgetsForDay, nextBudgets, allocateDay, groupTerms, groupResult, settledBudgets, checkSettledBudgets } from '../src/lib/points-budgets.js';
import { countedRows } from '../src/lib/points-engagement.js';
import { splitDayBudget, dayPot, dayBoard, dayHistory } from '../src/lib/points-day-board.js';

const TAC = 10n ** 18n;
const budget = 1111n * TAC;
const ceiling = 3n * TAC / 100n;                                     // 0.03 TAC per point
const A = (c) => '0x' + c.repeat(40);
const row = (address, by) => ({ address, by, dayPoints: Object.values(by).reduce((s, v) => s + v, 0) });
const sum = (m) => [...m.values()].reduce((s, v) => s + v, 0n);

// ── the schedule ──
{
  const logs = [];
  const s = parseBudgets('20747:retention=holding+cbtchold@0.25/0.02,use=zswapeth+cusdmint@0.15/0.01;20790:off;bad;20800:x=zzz@2/0.01;20801:a=wrap@0.6/0.01,b=holding@0.6/0.01;20802:a=wrap+holding@0.1/0.01,b=holding@0.1/0.01;20803:open=wrap@0.1/0.01;20804:a=wrap@0.5/0;20805:a=wrap@0.5;20806:a=cbtc_hold@0.5/0.01;20807:a=wrap@0.0000004/0.01', (m) => logs.push(m));
  assert.deepEqual(s.map((e) => e.fromDay), [20747, 20790], 'the well-formed entries stand, in day order');
  assert.equal(s[1].groups.length, 0, 'off ends the groups');
  const [ret, use] = s[0].groups;
  assert.deepEqual([ret.name, ret.activities, ret.sharePpm, ret.maxWeiPerPoint], ['retention', ['holding', 'cbtchold'], 250000, 2n * TAC / 100n]);
  assert.deepEqual([use.name, use.activities, use.sharePpm, use.maxWeiPerPoint], ['use', ['zswapeth', 'cusdmint'], 150000, TAC / 100n]);
  assert.equal(logs.length, 9, 'each malformed entry is reported: ' + logs.join(' | '));
  const all = logs.join('|');
  assert.match(all, /expected <day>/);
  assert.match(all, /zzz is not an activity the program scores/, 'an activity the program does not score (a typo would be a group that never fills) is refused');
  assert.match(all, /add up to more than 1/);
  assert.match(all, /in two groups/);
  assert.match(all, /usable group name/);
  assert.match(all, /ceiling of a must be positive/);
  assert.match(all, /needs a ceiling on TAC per point/, 'a group with no ceiling would pay its whole share for any points at all');
  assert.match(all, /cbtc_hold is not an activity/);
  assert.match(all, /above 0\.000001/, 'a share that rounds to nothing is refused');
  assert.deepEqual(parseBudgets(''), []);
  assert.deepEqual(budgetsForDay(s, 20746), [], 'before the first entry nothing is shared');
  assert.equal(budgetsForDay(s, 20747).length, 2);
  assert.equal(budgetsForDay(s, 20789).length, 2);
  assert.equal(budgetsForDay(s, 20790).length, 0, 'and after off');
  assert.equal(nextBudgets(s, 20700).fromDay, 20747);
  assert.equal(nextBudgets(s, 20747).fromDay, 20790);
  assert.equal(nextBudgets(s, 20790), null);
  assert.deepEqual(groupTerms(ret), { name: 'retention', activities: ['holding', 'cbtchold'], share: 0.25, maxWeiPerPoint: '20000000000000000' });
  console.log('ok - the schedule is read, ordered, and a malformed entry (no ceiling, an unknown activity, a share of nothing) is reported and skipped');
}

// ── the days that have settled keep the groups they were paid under ──
{
  const sched = (spec) => parseBudgets(spec);
  const base = sched('20747:a=holding@0.25/0.02');
  assert.deepEqual(checkSettledBudgets(null, base), { ok: true, now: null }, 'nothing kept yet, nothing to compare');
  const kept1 = settledBudgets(base, 20742);                                  // settled through 20742: the entry (from 20747) is not part of history yet
  assert.equal(checkSettledBudgets(kept1, base).ok, true);
  assert.equal(checkSettledBudgets(kept1, sched('20747:a=holding@0.5/0.02')).ok, true, 'an entry for a day ahead can still be changed');
  assert.equal(checkSettledBudgets(kept1, [...base, ...sched('20760:a=holding@0.3/0.02')]).ok, true, 'and one added');
  assert.equal(checkSettledBudgets(kept1, []).ok, true, 'or taken back before it starts');
  const kept2 = settledBudgets(base, 20747);                                  // 20747 settled under it
  assert.equal(checkSettledBudgets(kept2, base).ok, true);
  assert.equal(checkSettledBudgets(kept2, [...base, ...sched('20760:a=holding@0.3/0.02')]).ok, true, 'a later entry changes nothing already paid');
  assert.equal(checkSettledBudgets(kept2, sched('20747:a=holding@0.5/0.02')).ok, false, 'a changed share for a settled day is refused');
  assert.equal(checkSettledBudgets(kept2, sched('20747:a=holding@0.25/0.03')).ok, false, 'so is a changed ceiling');
  assert.equal(checkSettledBudgets(kept2, sched('20747:a=holding+cbtchold@0.25/0.02')).ok, false, 'a changed activity');
  assert.equal(checkSettledBudgets(kept2, []).ok, false, 'and an entry taken away');
  assert.equal(checkSettledBudgets('not json', base).ok, false, 'an unreadable record is not taken for agreement');
  console.log('ok - an entry that a settled day was paid under cannot be edited or removed, while entries ahead can');
}

// ── with no group the day is split exactly as before ──
{
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let t = 0; t < 200; t++) {
    const n = 1 + Math.floor(rnd() * 12);
    const rows = Array.from({ length: n }, (_, i) => { const p = Math.round(rnd() * 5e6) / 1000; return { address: A(i.toString(16).padStart(1, '0')) + '', dayPoints: p, by: { wrap: p } }; });
    rows.forEach((r, i) => { r.address = '0x' + String(i + 1).padStart(40, '0'); });
    const cap = rnd() < 0.5 ? null : BigInt(Math.round(rnd() * 5e15)) + 1n;
    const old = splitDayBudget(rows.map((r) => ({ address: r.address, dayPoints: r.dayPoints })), budget, cap);
    const open = allocateDay({ rows, budgetWei: budget, maxWeiPerPoint: cap, groups: [] });
    assert.deepEqual([...open.paid], [...old], 'open-only sharing is the old split, to the wei');
  }
  console.log('ok - with no group in force the split is the old one to the wei (200 random days)');
}

// ── the day's example: a few addresses repeating one action all day, and a few others ──
{
  const groups = parseBudgets('1:retention=holding+cbtchold@0.25/0.02,use=zswapeth+cusdmint+cbtcmint+weiname@0.15/0.01')[0].groups;
  const rows = [
    row(A('a'), { wrap: 1_500_000, evmpooldeposit: 1_500_000 }), row(A('b'), { wrap: 800_000 }), row(A('c'), { evmpooldeposit: 700_000 }),   // loops: 4.5M points
    row(A('d'), { holding: 2000, cbtchold: 1000 }),                                                                                           // staying: 3,000 points
    row(A('e'), { zswapeth: 4000 }), row(A('f'), { zswapeth: 1000, cusdmint: 20 }),                                                         // using: 5,020 points
  ];
  const r = allocateDay({ rows, budgetWei: budget, maxWeiPerPoint: ceiling, groups });
  const g = Object.fromEntries(r.groups.map((x) => [x.name, x]));
  assert.equal(g.retention.paidWei, 3000n * 2n * TAC / 100n, 'staying is paid its points at its ceiling (60 TAC), far under its reservation');
  assert.equal(g.use.paidWei, 5020n * TAC / 100n, 'using likewise (50.2 TAC at 0.01)');
  assert.equal(g.retention.reservedWei, 277_750_000_000_000_000_000n, 'a quarter of the day is reserved for staying');
  assert.equal(g.open.paidWei, budget - g.retention.paidWei - g.use.paidWei, 'the open group takes everything the others did not claim, so nothing is wasted');
  assert.equal(r.pot, budget);
  assert.ok(sum(r.paid) <= budget && budget - sum(r.paid) < 10n, 'only dust is left');
  // one address in a group is paid its points at the ceiling, and a looper is paid its share of the rest
  assert.equal(r.paid.get(A('e')), 4000n * TAC / 100n);
  const loops = r.paid.get(A('a')) + r.paid.get(A('b')) + r.paid.get(A('c'));
  assert.ok(loops < g.open.paidWei + 3n && loops > g.open.paidWei - 3n);
  assert.equal(r.paid.get(A('a')), (g.open.paidWei * 3_000_000n) / 4_500_000n, 'by points inside the open group');
  assert.deepEqual(groupResult(r.groups[0]).reservedWei, '277750000000000000000');
  console.log('ok - a reservation pays staying and using at their ceilings and the open group takes the rest');

  // the same day under today's single split, for comparison: the loops would have taken nearly everything
  const flat = splitDayBudget(rows, budget, ceiling);
  const flatOthers = [A('d'), A('e'), A('f')].reduce((s, a) => s + (flat.get(a) ?? 0n), 0n);
  const sharedOthers = [A('d'), A('e'), A('f')].reduce((s, a) => s + (r.paid.get(a) ?? 0n), 0n);
  assert.ok(sharedOthers > flatOthers * 50n, `the others are paid over 50x more per point (${sharedOthers} vs ${flatOthers})`);
  console.log('ok - the others are paid over 50x more than in one pro-rata race');
}

// ── a reservation is a floor, not a ceiling: a group that fills it competes for the rest by points ──
{
  const groups = parseBudgets('1:stay=holding@0.2/0.05')[0].groups;
  const rows = [row(A('1'), { holding: 100_000 }), row(A('2'), { wrap: 300_000 })];
  const r = allocateDay({ rows, budgetWei: 1000n * TAC, maxWeiPerPoint: null, groups });
  const g = Object.fromEntries(r.groups.map((x) => [x.name, x]));
  // demand 5,000 TAC at its ceiling, reserved 200; the remaining 800 is shared by points: 100k : 300k -> 200 and 600
  assert.equal(g.stay.paidWei, 400n * TAC, 'the group gets its 200 and a quarter of the remaining 800');
  assert.equal(g.open.paidWei, 600n * TAC);
  console.log('ok - past its reservation a group shares the remainder by points');

  // the ceiling stops a group taking more than its points are worth, and what it leaves goes on to the others
  const tight = parseBudgets('1:stay=holding@0.2/0.001')[0].groups;
  const r2 = allocateDay({ rows, budgetWei: 1000n * TAC, maxWeiPerPoint: null, groups: tight });
  const t = Object.fromEntries(r2.groups.map((x) => [x.name, x]));
  assert.equal(t.stay.paidWei, 100n * TAC, '100,000 points at 0.001 TAC is the most it can be paid, under its reservation');
  assert.equal(t.open.paidWei, 900n * TAC);
  console.log('ok - a group is never paid more than its points are worth at its ceiling');

  // the day's own ceiling binds the open group, so the pot is less than the budget
  const r3 = allocateDay({ rows, budgetWei: 1000n * TAC, maxWeiPerPoint: TAC / 1000n, groups: tight });
  const u = Object.fromEntries(r3.groups.map((x) => [x.name, x]));
  assert.equal(u.stay.paidWei, 100n * TAC);
  assert.equal(u.open.paidWei, 300n * TAC, '300,000 points at the day\'s 0.001 ceiling');
  assert.equal(r3.pot, 400n * TAC);
  console.log('ok - the day\'s own ceiling still trims what the open group is paid');

  // a group's ceiling never exceeds the day's
  const loose = parseBudgets('1:stay=holding@0.5/9')[0].groups;
  const r4 = allocateDay({ rows, budgetWei: 1000n * TAC, maxWeiPerPoint: TAC / 1000n, groups: loose });
  assert.equal(r4.groups[0].paidWei, 100n * TAC, 'the group is held to the day\'s ceiling, not its own larger one');
  assert.equal(r4.groups[0].maxWeiPerPoint, TAC / 1000n);
  console.log('ok - a group\'s ceiling is never above the day\'s');
}

// ── groups that fill up one after another (the second only once the first has left the sharing) ──
{
  const groups = parseBudgets('1:a=weiname@0.1/0.01,b=pmbet@0.1/0.0215')[0].groups;
  // a: 30,000 points -> worth 300 at its ceiling, reserved 100; b: 20,000 points -> worth 430, reserved 100; the open group has 100 points
  const rows = [row(A('1'), { weiname: 30_000 }), row(A('2'), { pmbet: 20_000 }), row(A('3'), { wrap: 100 })];
  const r = allocateDay({ rows, budgetWei: 1000n * TAC, maxWeiPerPoint: null, groups });
  const g = Object.fromEntries(r.groups.map((x) => [x.name, x]));
  // the 800 left after the two reservations is shared by points: a is worth 200 more (it takes them, leaving the rest), then b is worth 330 more
  assert.equal(g.a.paidWei, 300n * TAC, 'a is paid everything its points are worth');
  assert.equal(g.b.paidWei, 430n * TAC, 'b is too, though it only fills up once a has left the sharing');
  assert.equal(g.open.paidWei, 270n * TAC, 'the open group takes the rest');
  assert.equal(r.pot, 1000n * TAC);
  console.log('ok - groups that fill up one after another are paid exactly what their points are worth');

  // with many open points, the others share the remainder by points (a floor, not a claim on the rest)
  const crowded = allocateDay({ rows: [row(A('1'), { weiname: 30_000 }), row(A('2'), { pmbet: 20_000 }), row(A('3'), { wrap: 1_000_000 })], budgetWei: 1000n * TAC, maxWeiPerPoint: null, groups });
  const c = Object.fromEntries(crowded.groups.map((x) => [x.name, x]));
  assert.ok(c.a.paidWei > 100n * TAC && c.a.paidWei < 130n * TAC, `a gets its reservation and a small share of the rest (${c.a.paidWei})`);
  assert.ok(c.open.paidWei > 750n * TAC, 'and the open group most of it');
  console.log('ok - a crowded open group leaves the others their reservation and a share by points of the rest');
}

// ── properties over random days ──
{
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const acts = ['wrap', 'evmpooldeposit', 'holding', 'cbtchold', 'zswapeth', 'cusdmint', 'weiname', 'pmbet'];
  for (let t = 0; t < 400; t++) {
    const spec = `1:g1=holding+cbtchold@${(0.05 + rnd() * 0.4).toFixed(2)}/${(0.001 + rnd() * 0.05).toFixed(4)},g2=zswapeth+cusdmint+weiname@${(0.05 + rnd() * 0.4).toFixed(2)}/${(0.001 + rnd() * 0.05).toFixed(4)}`;
    const groups = parseBudgets(spec)[0].groups;
    const n = 1 + Math.floor(rnd() * 14);
    const rows = Array.from({ length: n }, (_, i) => {
      const by = {};
      for (const a of acts) if (rnd() < 0.3) by[a] = Math.round(rnd() * (rnd() < 0.2 ? 5e6 : 5e3) * 1000) / 1000;
      if (!Object.keys(by).length) by.wrap = 10;
      return row('0x' + String(i + 1).padStart(40, '0'), by);
    });
    const day = rnd() < 0.5 ? null : BigInt(Math.round(1 + rnd() * 5e16));
    const bud = BigInt(Math.round(100 + rnd() * 2000)) * TAC;
    const r = allocateDay({ rows, budgetWei: bud, maxWeiPerPoint: day, groups });
    const again = allocateDay({ rows: [...rows].reverse(), budgetWei: bud, maxWeiPerPoint: day, groups });
    assert.deepEqual([...r.paid].sort(), [...again.paid].sort(), 'the order of the rows changes nothing');
    assert.ok(sum(r.paid) <= bud, 'nothing is paid beyond the budget');
    assert.ok(sum(r.paid) <= r.pot, 'and no more than the groups were paid');
    for (const g of r.groups) {
      if (g.demandWei !== null) assert.ok(g.paidWei <= g.demandWei, `${g.name} is never paid more than its points are worth at its ceiling`);
      if (g.name !== 'open' && g.points > 0) {
        const floor = g.demandWei === null ? g.reservedWei : (g.demandWei < g.reservedWei ? g.demandWei : g.reservedWei);
        assert.ok(g.paidWei >= floor, `${g.name} is paid at least min(its demand, its reservation)`);
      }
    }
    const open = r.groups.find((g) => g.name === 'open');
    if (open.points > 0 && day === null) assert.ok(bud - r.pot < 10n, 'with no ceiling on the open group the whole budget is paid');
    for (const v of r.paid.values()) assert.ok(v > 0n);
  }
  console.log('ok - 400 random days: never over budget, never over a ceiling, a reservation always honoured, order-independent');
}

// ── what the board, the pot and the history say ──
{
  const groups = parseBudgets('1:stay=holding@0.25/0.02')[0].groups;
  const rows = [row(A('1'), { holding: 1000 }), row(A('2'), { wrap: 9000 })];
  const pot = dayPot(rows, budget, ceiling, groups);
  assert.equal(pot.totalPoints, 10000);
  assert.equal(pot.groups.map((g) => g.name).join(), 'stay,open');
  assert.equal(pot.pot, 290n * TAC, 'the day\'s 0.03 ceiling trims a 10,000-point day: 20 TAC to staying (its own 0.02) and 270 to the open group');
  const b = dayBoard(rows, { budgetWei: budget, maxWeiPerPoint: ceiling, groups });
  assert.equal(b.groups[0].paidWei, (1000n * 2n * TAC / 100n).toString());
  assert.deepEqual(b.rows.map((r) => r.address), [A('2'), A('1')]);
  assert.deepEqual(b.rows.map((r) => r.tacWei), [(270n * TAC).toString(), (20n * TAC).toString()], 'each address on the board carries what the day pays it so far, through the same groups');
  assert.equal(dayBoard(rows, { budgetWei: budget, maxWeiPerPoint: ceiling }).groups, undefined, 'with no group the board has the shape it always had');
  assert.equal(dayPot([], budget, ceiling, groups).pot, budget, 'a day nobody has scored in still has its budget');
  const hist = dayHistory({
    dayRowsFor: () => rows, budgetFor: () => budget, capFor: () => ceiling, groupsFor: () => groups,
    ledgerFor: () => (splitDayBudget(rows, budget, ceiling, groups).get(A('1'))),
  })(A('1'), { fromDay: 5, throughDay: 5, lastSettledDay: 5 });
  assert.equal(hist.reconciled, true, 'a settled day re-splits to the ledger through the same groups');
  assert.equal(hist.days[0].tacWei, (20n * TAC).toString());
  assert.throws(() => allocateDay({ rows: [{ address: A('1'), dayPoints: 5 }], budgetWei: budget, groups }), /by activity/);
  console.log('ok - the pot, board and history read the same sharing settlement pays');
}

// ── a group with no ceiling of its own, on a day with none, is not paid its whole reservation for dust ──
{
  const hand = [{ name: 'ret', activities: ['holding'], sharePpm: 250000, maxWeiPerPoint: null }];       // parseBudgets refuses this; built by hand to check the allocator is safe anyway
  const r = allocateDay({ rows: [row(A('1'), { holding: 0.01 }), row(A('2'), { wrap: 1_000_000 })], budgetWei: budget, maxWeiPerPoint: null, groups: hand });
  assert.ok(r.paid.get(A('1')) < TAC / 1000n, `a hundredth of a point earns next to nothing (${r.paid.get(A('1'))})`);
  assert.equal(r.groups[0].reservedWei, 277_750_000_000_000_000_000n);
  console.log('ok - with no ceiling a reservation is not a payment for dust');
}

// ── a share cap holds inside its group ──
{
  const groups = parseBudgets('1:stay=holding@0.25/0.001')[0].groups;
  const where = new Map(groups.flatMap((g) => g.activities.map((a) => [a, g.name])));
  const dayRows = [{ address: A('1'), activity: 'holding', points: 9000 }, { address: A('2'), activity: 'wrap', points: 1000 }, { address: A('3'), activity: 'evmpooldeposit', points: 100_000 }];
  // the old reading (a share of everything else counted) lets the deposits count 10,000 points because holding's 9,000 are 'the rest', though those pay 0.001 a point
  const loose = countedRows({ dayRows, shareCaps: { evmpooldeposit: 0.5 }, withBy: true });
  const looseShare = Number(splitDayBudget(loose, budget, null, groups).get(A('3')) * 1000n / budget) / 10;
  assert.ok(looseShare > 85, `without the group in the reading the cap leaks (${looseShare}% of the day)`);
  const tight = countedRows({ dayRows, shareCaps: { evmpooldeposit: 0.5 }, withBy: true, groupOf: (a) => where.get(a) ?? 'open' });
  const tightShare = Number(splitDayBudget(tight, budget, null, groups).get(A('3')) * 1000n / budget) / 10;
  assert.ok(tightShare <= 50, `with it, the deposits take at most half of the day (${tightShare}%)`);
  assert.equal(tight.find((r) => r.address === A('3')).dayPoints, 1000, 'they count as many points as the open group\'s others');
  const alone = countedRows({ dayRows: dayRows.filter((r) => r.activity !== 'holding'), shareCaps: { evmpooldeposit: 0.5 }, withBy: true });
  assert.equal(alone.find((r) => r.address === A('3')).dayPoints, 1000, 'and as with no groups at all');
  console.log('ok - a share cap is a share of the capped activity\'s own group, so it holds when other groups are paid less a point');
}

// ── a capped group is held to its share: what the others leave is not handed to it ──
{
  const sched = parseBudgets('20747:stay=holding+cbtchold@0.25/0.02,use=zswapeth@0.15/0.01;20751:stay=holding+cbtchold@0.2/0.03,use=zswapeth+cusdmint@0.1/0.015,loop=wrap+evmpooldeposit+btcpool@0.7!/0.03');
  assert.equal(sched.length, 2);
  const g = budgetsForDay(sched, 20751), loop = g.find((x) => x.name === 'loop');
  assert.equal(loop.capped, true);
  assert.equal(g.find((x) => x.name === 'stay').capped, undefined);
  const rows = [row(A('1'), { holding: 1750 }), row(A('2'), { zswapeth: 1644 }), row(A('3'), { evmpooldeposit: 4_200_000 }), row(A('4'), { wrap: 1_100_000 })];
  const r = allocateDay({ rows, budgetWei: budget, maxWeiPerPoint: ceiling, groups: g });
  const by = Object.fromEntries(r.groups.map((x) => [x.name, x]));
  assert.equal(by.loop.paidWei, budget * 700000n / 1000000n, 'the loops are paid their 70% and no more');
  assert.equal(by.stay.paidWei, 1750n * 3n * TAC / 100n);
  assert.equal(by.use.paidWei, 1644n * 15n * TAC / 1000n);
  assert.ok(r.pot < budget, 'what nobody could use stays unpaid');
  assert.equal(groupTerms(loop).capped, true);
  // uncapped, the same day hands the loops what the others leave
  const open = allocateDay({ rows, budgetWei: budget, maxWeiPerPoint: ceiling, groups: parseBudgets('1:stay=holding+cbtchold@0.2/0.03,use=zswapeth+cusdmint@0.1/0.015,loop=wrap+evmpooldeposit+btcpool@0.7/0.03')[0].groups });
  assert.ok(open.groups.find((x) => x.name === 'loop').paidWei > by.loop.paidWei);
  // the record of what settled days were paid under is unchanged for an entry without the mark
  assert.equal(checkSettledBudgets(settledBudgets(parseBudgets('20747:stay=holding+cbtchold@0.25/0.02,use=zswapeth@0.15/0.01'), 20748), sched).ok, true);
  console.log('ok - a capped group is paid at most its share; the rest of the day stays unpaid rather than going to it');
}

// ── a top-up ceiling: what is left after everyone is paid goes to the group that has one, and nobody is paid less for it ──
{
  const logs = [];
  const text = (stay) => `20752:stay=holding+cbtchold@0.25/${stay},use=zswapeth+cusdmint+cbtcmint+weiname+pmbet+pmcreate@0.15/0.015,loop=wrap+evmpooldeposit+btcpool@0.6!/0.03`;
  const s = parseBudgets(`${text('0.03+0.04')};20760:a=wrap@0.5/0.02+0.02;20761:a=wrap@0.5!/0.02+0.03;20762:a=wrap@0.5+0.03;20763:b=wrap@0.5/0.02+`, (m) => logs.push(m));
  assert.deepEqual(s.map((e) => e.fromDay), [20752], 'a top-up not above the ceiling, on a capped group, with no ceiling, or empty is refused');
  assert.equal(logs.length, 4, logs.join(' | '));
  const [stay] = s[0].groups;
  assert.deepEqual([stay.maxWeiPerPoint, stay.topWeiPerPoint], [3n * TAC / 100n, 4n * TAC / 100n]);
  assert.equal(groupTerms(stay).topWeiPerPoint, (4n * TAC / 100n).toString());
  assert.equal(groupTerms(s[0].groups[1]).topWeiPerPoint, undefined, 'a group without one says nothing of it');
  // the record of what settled days were paid under is as it was for entries without a top-up, and tells one with a top-up from one without
  const plain = parseBudgets('20747:stay=holding+cbtchold@0.25/0.02,use=zswapeth@0.15/0.01;20750:loop=wrap@0.6!/0.03');
  assert.equal(settledBudgets(plain, 20750), '{"throughDay":20750,"entries":"[[20747,[[\\"stay\\",[\\"holding\\",\\"cbtchold\\"],250000,\\"20000000000000000\\"],[\\"use\\",[\\"zswapeth\\"],150000,\\"10000000000000000\\"]]],[20750,[[\\"loop\\",[\\"wrap\\"],600000,\\"30000000000000000\\",\\"capped\\"]]]]"}', 'unchanged');
  assert.equal(checkSettledBudgets(settledBudgets(s, 20752), parseBudgets(text('0.03'))).ok, false, 'a top-up added to a settled entry is a change of it');

  // a day shaped like a recent one: a few stayers, almost no one in use, a lot of loops (points: 11,853 / 887 / 2.58M)
  const rows = [row(A('1'), { holding: 9160 }), row(A('2'), { holding: 2693 }), row(A('3'), { zswapeth: 887 }), row(A('4'), { wrap: 1_300_000 }), row(A('5'), { evmpooldeposit: 1_278_032 })];
  const pot = 1111n * TAC, withTop = (stayText, cap) => allocateDay({ rows, budgetWei: pot, maxWeiPerPoint: cap, groups: parseBudgets(text(stayText))[0].groups });
  const before = withTop('0.03', 4n * TAC / 100n), after = withTop('0.03+0.04', 4n * TAC / 100n);
  const by = (r) => Object.fromEntries(r.groups.map((x) => [x.name, x.paidWei]));
  assert.equal(by(after).use, by(before).use); assert.equal(by(after).loop, by(before).loop, 'use and loop are paid what they were');
  assert.ok(by(after).stay > by(before).stay);
  assert.equal(by(after).stay - by(before).stay, pot - before.pot, 'the stayers take exactly the part that was unpaid');
  assert.equal(after.pot, pot, 'and the day is paid in full');
  assert.equal(after.pot, by(after).stay + by(after).use + by(after).loop);
  assert.ok(after.pot <= pot && after.pot > before.pot);
  for (const [addr, wei] of before.paid) assert.ok(after.paid.get(addr) >= wei, 'nobody is paid less');
  // held to the day's own ceiling: with the day at 0.03 a top-up of 0.04 changes nothing
  const same = withTop('0.03+0.04', ceiling), none = withTop('0.03', ceiling);
  assert.deepEqual([...same.paid], [...none.paid]); assert.equal(same.pot, none.pot);
  // a top-up equal to the ceiling is no top-up at all
  const g0 = parseBudgets(text('0.03'))[0].groups.map((g) => (g.name === 'stay' ? { ...g, topWeiPerPoint: g.maxWeiPerPoint } : g));
  assert.deepEqual([...allocateDay({ rows, budgetWei: pot, maxWeiPerPoint: 4n * TAC / 100n, groups: g0 }).paid], [...before.paid]);

  // and over many days, whoever is in them: no address and no group is paid less, the budget is never passed, and a capped group stays under its share
  let seed = 4242; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const acts = ['holding', 'cbtchold', 'zswapeth', 'cusdmint', 'weiname', 'pmbet', 'wrap', 'evmpooldeposit', 'btcpool'];
  let more = 0;
  for (let d = 0; d < 400; d++) {
    const rs = []; for (let i = 0, n = 1 + Math.floor(rnd() * 7); i < n; i++) { const by_ = {}; for (let j = 0, m = 1 + Math.floor(rnd() * 3); j < m; j++) by_[acts[Math.floor(rnd() * acts.length)]] = Math.round(Math.exp(rnd() * 14) * 100) / 100; rs.push(row(A(String(i + 1)), by_)); }
    const b = BigInt(Math.round(50 + rnd() * 2000)) * TAC, cap = rnd() < 0.2 ? null : 4n * TAC / 100n;
    const run = (stayText) => allocateDay({ rows: rs, budgetWei: b, maxWeiPerPoint: cap, groups: parseBudgets(text(stayText))[0].groups });
    const lo = run('0.03'), hi = run('0.03+0.04');
    for (const [addr, wei] of lo.paid) assert.ok((hi.paid.get(addr) ?? 0n) >= wei, `day ${d}: ${addr} is paid less`);
    hi.groups.forEach((x, j) => assert.ok(x.paidWei >= lo.groups[j].paidWei, `day ${d}: group ${x.name} is paid less`));
    assert.ok(sum(hi.paid) <= b, `day ${d}: over the budget`);
    assert.ok(hi.groups.find((x) => x.name === 'loop').paidWei <= b * 600000n / 1000000n, `day ${d}: the capped loops are over their share`);
    if (hi.pot > lo.pot) more++;
  }
  assert.ok(more > 20, `some of the days had something to give (${more})`);
  // two groups with a top-up share what is left by points, each up to its own
  {
    const two = (r) => allocateDay({ rows: r, budgetWei: 1000n * TAC, maxWeiPerPoint: 5n * TAC / 100n, groups: parseBudgets('1:a=holding@0.1/0.01+0.05,b=zswapeth@0.1/0.01+0.05,c=wrap@0.5!/0.01')[0].groups });
    const r = two([row(A('1'), { holding: 30000 }), row(A('2'), { zswapeth: 10000 }), row(A('3'), { wrap: 1_000_000 })]);
    const paidOf = (n) => r.groups.find((x) => x.name === n).paidWei;
    // 1: a 100 (its 300 at the ceiling is over its reservation), b 100, c 500 (capped): 700. 2: a takes 200 more, to its ceiling: 900.
    // 2b: the last 100 is shared by points, 30,000 to 10,000: 75 and 25.
    assert.deepEqual([paidOf('a'), paidOf('b'), paidOf('c')], [375n * TAC, 125n * TAC, 500n * TAC]);
    assert.equal(r.pot, 1000n * TAC);
  }
  console.log('ok - a top-up ceiling is paid from what is left, held to the day\'s ceiling, and never takes from anyone');
}
