// The rows a UTC day's pot is split by. Settlement, the day so far, the board and an address's history by day all
// read a day through here, so what is shown is what settlement pays.
//
// Before any weight, multiplier or bond check applies to a day, its rows are exactly the store's sums by address, so
// days already settled re-split to the same figures. From the first of those days on, a day counts each activity at
// its weight, times the address's multiplier for the week (lib/points-engagement.js), with a released bond left out and an
// address's ETH of a capped activity counted only up to its limit for the day.
import { categoryWeightsForDay, engagementForDay, addressDayCapsForDay, capFactor, countedRows, WEEK_DAYS } from './points-engagement.js';

// onTime: only the rows a settlement could have seen (not marked late), so a settled day's own split is reproduced.
export function makeCounted({ store, weightSchedule = [], engagementSchedule = [], addressDayCaps = [], bondHoldFromDay = 0, onTime = false }) {
  const opt = { onTime };
  return {
    rows(day) {
      const weights = categoryWeightsForDay(weightSchedule, day), spec = engagementForDay(engagementSchedule, day), caps = addressDayCapsForDay(addressDayCaps, day);
      const start = day * 86400, end = start + 86400;
      if (!Object.keys(weights).length && !spec && !Object.keys(caps).length && !(bondHoldFromDay && day >= bondHoldFromDay)) {
        return store.dayPointsByAddress(start, end, opt).map((r) => ({ ...r, rawPoints: r.dayPoints, factor: 1, kinds: 0, activeDays: 0 }));
      }
      const dayRows = store.dayActivityPoints(start, end, opt);
      for (const [activity, limit] of Object.entries(caps)) {
        const totals = store.dayAmountsByAddress(activity, start, end, opt);
        for (const r of dayRows) if (r.activity === activity) r.capFactor = capFactor(totals.get(r.address) ?? 0n, limit);
      }
      const weekRows = spec ? store.weekActivityPoints((day - WEEK_DAYS + 1) * 86400, end, opt) : [];
      return countedRows({ dayRows, weekRows, weights, spec });
    },
  };
}
