// The program's own terms as the service holds them, so a client shows them instead of restating them: the dates, the
// day's pot, the per-point ceiling, what each kind of activity earns, the early bonus and the holder tiers. Plain JSON;
// wei are decimal strings. A kind of activity the service is not scoring is left out of `rates`, and `holder` is null
// when the boost is off.
//
// cfg: the service's config. dayBudgetWei(i): the budget of the i-th day of the program. rateCapSchedule: the parsed
// ceiling entries. tiers: parseBoostTiers' output for the TAC holder boost, or []. weights and engagement: the parsed
// category-weight, week-multiplier and address-cap schedules (lib/points-engagement.js) and budgets (lib/points-budgets.js), each from a UTC day forward.

import { KIND_OF } from './points-engagement.js';
import { groupTerms } from './points-budgets.js';

const BLOCK_SECS = 12;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

export function programTerms({ cfg, dayBudgetWei, rateCapSchedule = [], tiers = [], weights = [], engagement = [], addressDayCaps = [], categoryShareCaps = [], budgets = [] }) {
  const startDay = Math.floor(cfg.pointsProgramStartSec / 86400);
  const rates = {
    wrap: round6(cfg.pointsBasePerEth * cfg.tethWrapBoostMultiplier),
    zswapeth: cfg.pointsBasePerZswapEth,
    cbtcmint: cfg.pointsBasePerCbtc,
    cusdmint: round6(cfg.pointsBasePerCusd * cfg.cusdMintBonusMultiplier),
    pmbet: cfg.pointsBasePerPmBet,
    pmcreate: cfg.pointsPerPmCreate,
  };
  if (Object.values(cfg.evmPoolPointsStartBlocks || {}).some(Boolean)) rates.evmpooldeposit = cfg.pointsBasePerEvmPoolEth;
  if (cfg.weinameEnabled) rates.weiname = cfg.pointsBasePerWeiname;
  if (cfg.btcPoolPointsStartHeight) rates.btcpool = cfg.pointsBasePerBtcPoolTac;
  if (cfg.pointsCbtcHoldRate > 0 && cfg.pointsCbtcHoldFromDay) rates.cbtchold = cfg.pointsCbtcHoldRate;
  if (cfg.holdingEnabled && cfg.holdingRate > 0) rates.holding = cfg.holdingRate;                  // per ETH of a proven note, for each day it is held
  return {
    startDay,
    days: cfg.pointsProgramDays,
    lastDay: startDay + cfg.pointsProgramDays - 1,
    totalWei: cfg.pointsProgramTotalWei.toString(),
    dayBudgetWei: dayBudgetWei(0).toString(),
    rateCap: rateCapSchedule.map((e) => ({ fromDay: e.fromDay, maxWeiPerPoint: e.maxWeiPerPoint === null ? null : e.maxWeiPerPoint.toString() })),
    settleGraceSecs: cfg.pointsSettleGraceSecs,
    earlyBonus: { max: round6(1 + cfg.pointsBonusScale), halfLife: cfg.pointsBonusHalfLife },
    tethWrapBoost: cfg.tethWrapBoostMultiplier,
    holder: tiers.length
      ? { tiers: tiers.map((t) => ({ tac: Number(t.minWei / 10n ** 18n), multiplier: t.multiplier })), windowHours: round6(cfg.tacBoostWindowBlocks * BLOCK_SECS / 3600) }
      : null,
    rates,
    weights: weights.map((e) => ({ fromDay: e.fromDay, weights: e.weights })),
    // The ETH of an activity an address can count in a day, as decimal ETH strings, from each day forward.
    addressDayCaps: addressDayCaps.map((e) => ({ fromDay: e.fromDay, caps: Object.fromEntries(Object.entries(e.caps).map(([a, w]) => [a, `${w / 10n ** 18n}${w % 10n ** 18n ? '.' + String(w % 10n ** 18n).padStart(18, '0').replace(/0+$/, '') : ''}`])) })),
    // The largest share of a day's pot an activity's points can take together, from each day forward.
    categoryShareCaps: categoryShareCaps.map((e) => ({ fromDay: e.fromDay, caps: { ...e.caps } })),
    engagement: engagement.map((e) => (e.spec ? { fromDay: e.fromDay, ...e.spec } : { fromDay: e.fromDay, off: true })),
    // The groups a day's pot is shared by, from each day forward (lib/points-budgets.js): each a reserved share of the budget, paid at its own TAC-per-point ceiling; what is not named is the open group.
    budgets: budgets.map((e) => (e.groups.length ? { fromDay: e.fromDay, groups: e.groups.map(groupTerms) } : { fromDay: e.fromDay, off: true })),
    bondHoldFromDay: cfg.pointsBondHoldFromDay || null,
    cbtcHoldFromDay: cfg.pointsCbtcHoldRate > 0 ? cfg.pointsCbtcHoldFromDay || null : null,
    kinds: KIND_OF,
  };
}
