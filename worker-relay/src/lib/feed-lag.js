// How far a keeper's history feed (/evm-pool/keeper/events, what a new device reads first) is behind its chain, in time.
// A feed that stops advancing leaves every new device to read the gap from public nodes, which on a busy chain rate-limit
// or cap the range (Base, 2026-10: four days behind, and a first sync failed). A feed legitimately trails by the keeper's
// confirmations and one history pass, well under the warning level.
export const FEED_LAG_WARN_SEC = 3600;
export const FEED_LAG_CRIT_SEC = 6 * 3600;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// Seconds per block from two block timestamps `blocks` apart; null when they do not give a positive figure.
export function blockSecOf(newerTs, olderTs, blocks) {
  const s = (Number(newerTs) - Number(olderTs)) / Number(blocks);
  return finite(s) && s > 0 ? s : null;
}

// Seconds the feed is behind: blocks past `through`, at `blockSec` each. null when any figure is missing.
export function feedLagSec({ through, head, blockSec }) {
  if (![through, head, blockSec].every(finite) || blockSec <= 0) return null;
  return Math.max(0, head - through) * blockSec;
}

// 'critical' / 'warning' for a lag at or over the limits, 'ok' under them, null when the lag is unknown.
export function feedLagLevel(lagSec, { warn = FEED_LAG_WARN_SEC, crit = FEED_LAG_CRIT_SEC } = {}) {
  if (!finite(lagSec)) return null;
  if (lagSec >= crit) return 'critical';
  if (lagSec >= warn) return 'warning';
  return 'ok';
}
