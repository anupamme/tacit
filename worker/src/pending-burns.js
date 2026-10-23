// Bridge burns the reflection holds pending that no proof bundle has been registered for.
//
// A burn is recorded pending when its block is folded without a bundle, and it completes in a later batch once a bundle
// is registered. The burn's own page registers one after the burn is mined; a page that never gets there (closed too
// soon, an old tab, another browser) leaves the burn's TAC unmintable until someone registers one. This counts those
// burns, and the height of the oldest, so the wait is visible.
//
//   records     the snapshot's pendingDepositRecords
//   registered  display txids (hex, any case, with or without 0x) that have a bundle registered
//   -> { count, oldestHeight }   oldestHeight is null when none

const norm = (t) => String(t || '').replace(/^0x/, '').toLowerCase();

export function burnsAwaitingBundle(records, registered) {
  const have = new Set([...(registered || [])].map(norm));
  const open = (Array.isArray(records) ? records : []).filter((r) => r && !r.completed && r.burnTxidDisplay && !have.has(norm(r.burnTxidDisplay)));
  const heights = open.map((r) => Number(r.height)).filter(Number.isFinite);
  return { count: open.length, oldestHeight: heights.length ? Math.min(...heights) : null };
}
