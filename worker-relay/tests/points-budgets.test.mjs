// Reserved budgets (src/lib/points-budgets.js): the schedule, how a day is shared by group, and that with no group in force the day is split exactly as before.
//   node worker-relay/tests/points-budgets.test.mjs

import assert from 'node:assert/strict';
import { parseBudgets, budgetsForDay, nextBudgets, allocateDay, groupTerms, groupResult } from '../src/lib/points-budgets.js';
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
  const s = parseBudgets('20747:retention=holding+cbtchold@0.25/0.02,use=zswapeth+cusdmint@0.15;20790:off;bad;20800:x=a@2;20801:a=x@0.6,b=y@0.6;20802:a=x+y@0.1,b=y@0.1;20803:open=x@0.1;20804:a=x@0.5/0', (m) => logs.push(m));
  assert.deepEqual(s.map((e) => e.fromDay), [20747, 20790], 'the well-formed entries stand, in day order');
  assert.equal(s[1].groups.length, 0, 'off ends the groups');
  const [ret, use] = s[0].groups;
  assert.deepEqual([ret.name, ret.activities, ret.sharePpm, ret.maxWeiPerPoint], ['retention', ['holding', 'cbtchold'], 250000, 2n * TAC / 100n]);
  assert.deepEqual([use.name, use.activities, use.sharePpm, use.maxWeiPerPoint], ['use', ['zswapeth', 'cusdmint'], 150000, null], 'a group without a ceiling has none of its own');
  assert.equal(logs.length, 6, 'each malformed entry is reported: ' + logs.join(' | '));
  assert.match(logs.join('|'), /not <day>|expected/);
  assert.match(logs.join('|'), /add up to more than 1/);
  assert.match(logs.join('|'), /in two groups/);
  assert.match(logs.join('|'), /usable group name/);
  assert.match(logs.join('|'), /must be positive/);
  assert.deepEqual(parseBudgets(''), []);
  assert.deepEqual(budgetsForDay(s, 20746), [], 'before the first entry nothing is shared');
  assert.equal(budgetsForDay(s, 20747).length, 2);
  assert.equal(budgetsForDay(s, 20789).length, 2);
  assert.equal(budgetsForDay(s, 20790).length, 0, 'and after off');
  assert.equal(nextBudgets(s, 20700).fromDay, 20747);
  assert.equal(nextBudgets(s, 20747).fromDay, 20790);
  assert.equal(nextBudgets(s, 20790), null);
  assert.deepEqual(groupTerms(ret), { name: 'retention', activities: ['holding', 'cbtchold'], share: 0.25, maxWeiPerPoint: '20000000000000000' });
  console.log('ok - the schedule is read, ordered, and a malformed entry is reported and skipped');
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
  const groups = parseBudgets('1:a=ga@0.1/0.01,b=gb@0.1/0.0215')[0].groups;
  // a: 30,000 points -> worth 300 at its ceiling, reserved 100; b: 20,000 points -> worth 430, reserved 100; the open group has 100 points
  const rows = [row(A('1'), { ga: 30_000 }), row(A('2'), { gb: 20_000 }), row(A('3'), { wrap: 100 })];
  const r = allocateDay({ rows, budgetWei: 1000n * TAC, maxWeiPerPoint: null, groups });
  const g = Object.fromEntries(r.groups.map((x) => [x.name, x]));
  // the 800 left after the two reservations is shared by points: a is worth 200 more (it takes them, leaving the rest), then b is worth 330 more
  assert.equal(g.a.paidWei, 300n * TAC, 'a is paid everything its points are worth');
  assert.equal(g.b.paidWei, 430n * TAC, 'b is too, though it only fills up once a has left the sharing');
  assert.equal(g.open.paidWei, 270n * TAC, 'the open group takes the rest');
  assert.equal(r.pot, 1000n * TAC);
  console.log('ok - groups that fill up one after another are paid exactly what their points are worth');

  // with many open points, the others share the remainder by points (a floor, not a claim on the rest)
  const crowded = allocateDay({ rows: [row(A('1'), { ga: 30_000 }), row(A('2'), { gb: 20_000 }), row(A('3'), { wrap: 1_000_000 })], budgetWei: 1000n * TAC, maxWeiPerPoint: null, groups });
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
    const spec = `1:g1=holding+cbtchold@${(0.05 + rnd() * 0.4).toFixed(2)}${rnd() < 0.7 ? '/' + (0.001 + rnd() * 0.05).toFixed(4) : ''},g2=zswapeth+cusdmint+weiname@${(0.05 + rnd() * 0.4).toFixed(2)}${rnd() < 0.7 ? '/' + (0.001 + rnd() * 0.05).toFixed(4) : ''}`;
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
