// How far the API's Bitcoin block scan trails the chain. Wallets credit an output whose validity rests on a record that
// scan writes (a fair-launch mint against its cap, a drop claim, an AMM or farm output, a cross-out mint) only once the
// scan has passed its block, so a scan that stops leaves those outputs pending everywhere.
//
// → { level: 'ok' | 'warning' | 'critical' | 'unknown', lag, why }

export function scanLagVerdict(scanned, tip, { warn = 6, critical = 36 } = {}) {
  if (!Number.isInteger(scanned) || !Number.isInteger(tip)) return { level: 'unknown', lag: null, why: 'the scan height or the chain tip could not be read' };
  const lag = Math.max(0, tip - scanned);
  const why = `the API's Bitcoin scan is at ${scanned}, ${lag} block${lag === 1 ? '' : 's'} behind the tip ${tip}`;
  return { level: lag >= critical ? 'critical' : lag >= warn ? 'warning' : 'ok', lag, why };
}
