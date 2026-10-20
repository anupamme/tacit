// When the settle loop runs its fee-income -> gas -> PROVE top-up (replenish.js). It used to run only on an idle pass
// (a cycle that found no job), so a steady stream of jobs, which is when the prover credit drains fastest, starved it:
// the PROVE waiting in the sink was never deposited while the account ran dry. It now runs between jobs as well, still
// serialised with settles (the loop awaits one, then the other) and still at most once per interval.
//
// A credit under its urgent line does not wait out the interval: the proofs the bridge's attests need stop while it is short, so a pass
// is due again after `urgentEveryMin` (a swap and its deposit take a few minutes to land, so not sooner). `credit` is the figure the
// settle loop last read, with any PROVE already waiting in the sink counted; null (unread) is never urgent.
//
//   replenishDue({ enabled, now, lastAt, intervalMin, pendingDrain, credit, urgentBelow, urgentEveryMin }) → boolean
export function replenishDue({ enabled, now, lastAt, intervalMin, pendingDrain = false, credit = null, urgentBelow = 0n, urgentEveryMin = 0 }) {
  if (pendingDrain) return true;                                  // the one-off key consolidation, ahead of everything
  if (!enabled) return false;
  const since = now - lastAt;
  if (since >= Math.max(0, intervalMin) * 60_000) return true;
  return credit != null && BigInt(urgentBelow) > 0n && BigInt(credit) < BigInt(urgentBelow) && urgentEveryMin > 0 && since >= urgentEveryMin * 60_000;
}
