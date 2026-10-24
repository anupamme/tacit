// Reserved budgets: how a UTC day's pot is shared out between kinds of activity, instead of one pro-rata race.
//
// Without budgets the day's pot is split by points alone, so whoever scores the most points takes almost all of it: a few
// addresses that repeat one cheap action all day can hold 99% of the points and leave everyone else cents. A budget names a
// group of activities and gives it a share of the day's budget that the rest cannot dilute:
//
//   POINTS_BUDGETS="20747:retention=holding+cbtchold@0.25/0.02,use=zswapeth+cusdmint+cbtcmint+weiname+pmbet+pmcreate@0.15/0.01;20790:off"
//
// From each UTC day an entry is in force, a group is `name=activity+activity@share/ceiling[+topup]`: `share` is the part of the day's
// budget reserved for it (above 0, all groups together at most 1) and `ceiling` the most TAC one of its points can earn (decimal
// TAC, never above the day's own TAC-per-point ceiling; required, since a reservation with no limit on a point's worth would pay
// its whole share for a handful of points). Activities are the program's own (KIND_OF). Everything not named belongs to the open
// group, which has no reservation and takes what is left. A later entry replaces an earlier one, and "off" ends them.
// An entry whose day has settled must not be edited or removed (settlement refuses to go on if it is: checkSettledBudgets), only added to.
//
// A category share cap (lib/points-engagement.js) holds inside a group: it is a share of the points of the group its activity is in.
//
// How a day is shared:
//   1. Each named group is paid what its points would earn at its ceiling, up to its reserved share. A reservation nobody
//      uses is not lost: it goes back to the others.
//   2. What is left is shared by points between every group that could still use more (each limited to what its points
//      would earn at its ceiling), with the open group taking the rest. So a group that fills its reservation competes for the
//      remainder like anyone else; a reservation is a floor, never a ceiling on the group.
//   2b. A group written `…@0.25/0.03+0.04` also has a top-up: if anything is still left once every group has been paid as in 1 and 2,
//      the groups with a top-up share it by points, each up to what its points would earn at its top-up (itself held to the day's own
//      TAC-per-point ceiling). It only ever adds: no group is paid less because another has a top-up, which raising a ceiling in 2 cannot promise.
//   3. Inside a group, each address is paid its share of the group's points.
// With no groups in force the day is split exactly as before (splitDayBudget), to the wei.
//
// The schedule only applies from a given day forward, so a settled day is never re-priced. Pure functions, BigInt for TAC.
import { parseUnits } from 'viem';
import { POINTS_SCALE } from './points-rate-cap.js';
import { KIND_OF } from './points-engagement.js';

const PPM = 1_000_000;
const NAME = /^[a-z][a-z0-9_]{0,23}$/, ACTIVITY = /^[a-z][a-z0-9_]{0,31}$/;
export const OPEN_GROUP = 'open';

// A group's share is kept in parts per million, so no float is ever multiplied into a wei amount.
function parseGroup(item) {
  const m = item.match(/^([a-z][a-z0-9_]*)=([a-z0-9_+]+)@([0-9]*\.?[0-9]+)(!?)(?:\/([0-9]*\.?[0-9]+)(?:\+([0-9]*\.?[0-9]+))?)?$/);
  if (!m) throw new Error(`"${item}" is not <name>=<activity>+<activity>@<share>[!]/<TAC per point>[+<top-up>]`);
  const [, name, acts, shareText, bang, ceilingText, topText] = m;
  if (!NAME.test(name) || name === OPEN_GROUP) throw new Error(`"${name}" is not a usable group name`);
  const activities = acts.split('+').filter(Boolean);
  if (!activities.length || activities.some((a) => !ACTIVITY.test(a)) || new Set(activities).size !== activities.length) throw new Error(`"${acts}" is not a list of distinct activities`);
  const unknown = activities.filter((a) => !(a in KIND_OF));
  if (unknown.length) throw new Error(`${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not an activity the program scores (${Object.keys(KIND_OF).join(', ')})`);
  const share = Number(shareText), sharePpm = Math.round(share * PPM);
  if (!(share > 0 && share <= 1) || sharePpm < 1) throw new Error(`the share of ${name} must be above 0.000001 and at most 1`);
  if (ceilingText === undefined) throw new Error(`${name} needs a ceiling on TAC per point (…@${shareText}/0.01): a reservation with none would pay its whole share for any points at all`);
  const maxWeiPerPoint = parseUnits(ceilingText, 18);
  if (maxWeiPerPoint <= 0n) throw new Error(`the ceiling of ${name} must be positive`);
  // `!` after the share caps the group at it: it is never paid more than its share, and what it leaves is not handed to it from the others' unused shares.
  // `+top` is the top-up ceiling (see 2b above), above the ceiling; a capped group is never handed what is left, so it has none.
  let topWeiPerPoint;
  if (topText !== undefined) {
    topWeiPerPoint = parseUnits(topText, 18);
    if (topWeiPerPoint <= maxWeiPerPoint) throw new Error(`the top-up of ${name} must be above its ceiling`);
    if (bang) throw new Error(`${name} is capped at its share, so it cannot have a top-up`);
  }
  return { name, activities, sharePpm, maxWeiPerPoint, ...(bang ? { capped: true } : {}), ...(topWeiPerPoint ? { topWeiPerPoint } : {}) };
}

// "20747:retention=holding+cbtchold@0.25/0.02,use=zswapeth@0.15;20790:off" → [{ fromDay, groups }], by day. A malformed entry is skipped and
// reported, which leaves the schedule as it was before it.
export function parseBudgets(raw, log = () => {}) {
  const out = [];
  for (const part of String(raw || '').split(';').map((s) => s.trim()).filter(Boolean)) {
    try {
      const m = part.match(/^(\d+):(.+)$/);
      if (!m) throw new Error('expected <day>:<group>,<group> or <day>:off');
      const fromDay = Number(m[1]);
      let groups = [];
      if (m[2].trim().toLowerCase() !== 'off') {
        groups = m[2].split(',').map((s) => s.trim()).filter(Boolean).map(parseGroup);
        const names = groups.map((g) => g.name), acts = groups.flatMap((g) => g.activities);
        if (new Set(names).size !== names.length) throw new Error('a group name is used twice');
        if (new Set(acts).size !== acts.length) throw new Error('an activity is in two groups');
        if (groups.reduce((s, g) => s + g.sharePpm, 0) > PPM) throw new Error('the shares add up to more than 1');
      }
      out.push({ fromDay, groups });
    } catch (err) {
      log(`ignoring POINTS_BUDGETS entry "${part}": ${err.message}`);
    }
  }
  return out.sort((a, b) => a.fromDay - b.fromDay);
}

// The groups in force on `day` ([] when none). Of two entries for the same day the later one listed wins (the sort is stable).
export function budgetsForDay(schedule, day) {
  let groups = [];
  for (const e of schedule) if (e.fromDay <= day) groups = e.groups;
  return groups;
}

// The next entry that has not started by `day`, or null: what a client can say is coming.
export function nextBudgets(schedule, day) {
  return schedule.find((e) => e.fromDay > day) ?? null;
}

// What the days that have settled were paid under. Settlement keeps this next to its ledger and refuses to go on if an entry of the schedule that was in force
// for a settled day is edited or removed afterwards: that would pay later days under rules the earlier ones were not paid under, re-price their history and
// their late credits. Entries for days still ahead can be added or changed freely.
const fingerprintOf = (entries) => JSON.stringify(entries.map((e) => [e.fromDay, e.groups.map((g) => [g.name, g.activities, g.sharePpm, g.maxWeiPerPoint === null ? null : g.maxWeiPerPoint.toString(), ...(g.capped ? ['capped'] : []), ...(g.topWeiPerPoint ? ['top', g.topWeiPerPoint.toString()] : [])])]));
export const settledBudgets = (schedule, throughDay) => JSON.stringify({ throughDay, entries: fingerprintOf(schedule.filter((e) => e.fromDay <= throughDay)) });
// → { ok, now } : `previous` is what settledBudgets returned when it was last kept (or null); ok is false when the entries up to the day it covered are not what they were.
export function checkSettledBudgets(previous, schedule) {
  if (!previous) return { ok: true, now: null };
  let prev;
  try { prev = JSON.parse(previous); } catch { return { ok: false, now: null }; }
  const now = fingerprintOf(schedule.filter((e) => e.fromDay <= prev.throughDay));
  return { ok: now === prev.entries, now };
}

const ceilingOf = (groupCeiling, dayCeiling) => (groupCeiling && dayCeiling ? (groupCeiling < dayCeiling ? groupCeiling : dayCeiling) : (groupCeiling ?? dayCeiling));

// The day's rows shared out by group.
//   rows: [{ address, dayPoints, by }] where by is { activity: points } (the points the row's activities count for, which add up to dayPoints).
//   budgetWei, maxWeiPerPoint: the day's budget and its TAC-per-point ceiling (null: none).  groups: budgetsForDay's result.
// → { paid: Map<address, wei>, pot (what the groups are paid together), totalPoints, groups: [{ name, activities, sharePpm, maxWeiPerPoint, points, reservedWei, demandWei, paidWei }] },
// the open group last. Nothing is paid beyond budgetWei, and a group is never paid beyond its ceiling.
export function allocateDay({ rows, budgetWei, maxWeiPerPoint = null, groups = [] }) {
  const k = groups.length, open = k;
  const groupOf = new Map();
  groups.forEach((g, i) => g.activities.forEach((a) => groupOf.set(a, i)));
  const names = [...groups.map((g) => g.name), OPEN_GROUP];
  // Each address's points in each group, scaled as splitDayBudget scales them.
  const per = new Map();
  const floatPoints = new Array(k + 1).fill(0);
  for (const r of rows) {
    if (!(r.dayPoints > 0)) continue;
    if (!r.by) throw new Error('sharing a day by group needs each row\'s points by activity');
    const mine = new Array(k + 1).fill(0);
    for (const [activity, pts] of Object.entries(r.by)) if (pts > 0) mine[groupOf.get(activity) ?? open] += pts;
    const scaled = mine.map((p) => BigInt(Math.round(p * POINTS_SCALE)));
    mine.forEach((p, i) => { floatPoints[i] += p; });
    per.set(r.address, scaled);
  }
  const T = new Array(k + 1).fill(0n);
  for (const scaled of per.values()) scaled.forEach((s, i) => { T[i] += s; });
  const SCALE = BigInt(POINTS_SCALE);
  const ceil = names.map((_, i) => (i === open ? maxWeiPerPoint : ceilingOf(groups[i].maxWeiPerPoint, maxWeiPerPoint)));
  const demand = T.map((t, i) => (ceil[i] ? (ceil[i] * t) / SCALE : null));                     // null: no ceiling, so no limit
  const reserved = names.map((_, i) => (i === open ? 0n : (budgetWei * BigInt(groups[i].sharePpm)) / BigInt(PPM)));
  // 1. what each named group is owed up to its reservation
  // (A named group with no ceiling at all, which parseBudgets does not produce, has no floor: its points are not worth anything in particular, so it competes by points.)
  const pay = names.map((_, i) => (T[i] <= 0n || i === open || demand[i] === null ? 0n : (demand[i] > reserved[i] ? reserved[i] : demand[i])));
  // 2. the rest, shared by points between whoever could still use more, each at most to its ceiling
  let rem = budgetWei - pay.reduce((s, v) => s + v, 0n);
  // Shares `rem` by points between `active`, each at most to its `limit` (null: no limit), whoever fills first leaving the rest to the others.
  const fill = (active, limit) => {
    while (active.length && rem > 0n) {
      const sumT = active.reduce((s, i) => s + T[i], 0n);
      const full = active.filter((i) => limit[i] !== null && (limit[i] - pay[i]) * sumT <= rem * T[i]);
      if (!full.length) {
        for (const i of active) pay[i] += (rem * T[i]) / sumT;
        rem = 0n;
        break;
      }
      for (const i of full) { const more = limit[i] - pay[i]; pay[i] += more; rem -= more; }
      active = active.filter((i) => !full.includes(i));
    }
  };
  fill(names.map((_, i) => i).filter((i) => T[i] > 0n && !(i < k && groups[i].capped) && (demand[i] === null || demand[i] > pay[i])), demand);
  // 2b. what is still left goes to the groups with a top-up, up to the top-up
  if (rem > 0n) {
    const top = names.map((_, i) => (i < k && groups[i].topWeiPerPoint && !groups[i].capped && T[i] > 0n ? (ceilingOf(groups[i].topWeiPerPoint, maxWeiPerPoint) * T[i]) / SCALE : null));
    fill(top.map((v, i) => i).filter((i) => top[i] !== null && top[i] > pay[i]), top);
  }
  // 3. inside a group, by points
  const paid = new Map();
  for (const [address, scaled] of per) {
    let wei = 0n;
    for (let i = 0; i <= k; i++) if (scaled[i] > 0n && T[i] > 0n) wei += (pay[i] * scaled[i]) / T[i];
    if (wei > 0n) paid.set(address, wei);
  }
  // A guard against a broken sharing, not a policy: a day is never paid beyond its budget, and the day is held (the caller's error) rather than overpaid.
  let total = 0n;
  for (const v of paid.values()) total += v;
  if (total > budgetWei || pay.some((v) => v < 0n)) throw new Error(`sharing the day by group paid ${total} wei of a ${budgetWei} wei budget`);
  return {
    paid,
    pot: pay.reduce((s, v) => s + v, 0n),
    totalPoints: floatPoints.reduce((s, v) => s + v, 0),
    groups: names.map((name, i) => ({
      name, activities: i === open ? null : groups[i].activities, sharePpm: i === open ? null : groups[i].sharePpm,
      maxWeiPerPoint: ceil[i], points: floatPoints[i], reservedWei: reserved[i], demandWei: demand[i], paidWei: pay[i], capped: i < k && !!groups[i].capped,
      ...(i < k && groups[i].topWeiPerPoint ? { topWeiPerPoint: groups[i].topWeiPerPoint } : {}),
    })),
  };
}

// A group as a client reads it: plain JSON, wei as decimal strings, the share as a fraction.
export const groupTerms = (g) => ({ name: g.name, activities: g.activities, share: g.sharePpm / PPM, maxWeiPerPoint: g.maxWeiPerPoint === null ? null : g.maxWeiPerPoint.toString(), ...(g.capped ? { capped: true } : {}), ...(g.topWeiPerPoint ? { topWeiPerPoint: g.topWeiPerPoint.toString() } : {}) });
// What a day's sharing came to, for a board: the same, with each group's points and what it was paid.
export const groupResult = (g) => ({
  name: g.name, activities: g.activities, share: g.sharePpm === null ? null : g.sharePpm / PPM,
  maxWeiPerPoint: g.maxWeiPerPoint === null ? null : g.maxWeiPerPoint.toString(), points: g.points,
  reservedWei: g.reservedWei.toString(), paidWei: g.paidWei.toString(), ...(g.capped ? { capped: true } : {}),
  ...(g.topWeiPerPoint ? { topWeiPerPoint: g.topWeiPerPoint.toString() } : {}),
});
