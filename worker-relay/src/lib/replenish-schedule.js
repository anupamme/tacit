// When the settle loop runs its fee-income -> gas -> PROVE top-up (replenish.js). It used to run only on an idle pass
// (a cycle that found no job), so a steady stream of jobs, which is when the prover credit drains fastest, starved it:
// the PROVE waiting in the sink was never deposited while the account ran dry. It now runs between jobs as well, still
// serialised with settles (the loop awaits one, then the other) and still at most once per interval.
//
//   replenishDue({ enabled, now, lastAt, intervalMin, pendingDrain }) → boolean
export function replenishDue({ enabled, now, lastAt, intervalMin, pendingDrain = false }) {
  if (pendingDrain) return true;                                  // the one-off key consolidation, ahead of everything
  if (!enabled) return false;
  return now - lastAt >= Math.max(0, intervalMin) * 60_000;
}
