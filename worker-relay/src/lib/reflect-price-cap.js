// The price cap a reflection request carries (bitcoin_prove's REFLECT_MAX_PRICE_PER_PGU, PROVE wei per prover gas unit).
//
// Reflection fills clear at two prices: most near 0.23 PROVE per billion PGU, many at 0.56-0.65. A request that no prover takes under
// its cap costs nothing (the credit only pays for fulfilled requests) and is asked again on the next cycle, so a cap near the low
// price buys most batches at it. A busy network can keep the high price for a while, though, and every batch it holds back is a
// bridge mint waiting: once capped requests have gone unfilled for `waitSecs`, the next one goes without the cap, and a fill (or that
// uncapped try) starts the window over. The window is kept in memory: the always-on lane (bitcoin-lane.js) carries it from cycle to
// cycle, a restarted lane starts capped.
//
//   cap(now) -> the value for REFLECT_MAX_PRICE_PER_PGU on this request ('0': no cap)
//   settled({ capped, filled }, now) -> after the request

export function makeReflectPriceCap({ capWei = 0, waitSecs = 20 * 60 } = {}) {
  const cap = Number.isSafeInteger(capWei) && capWei > 0 ? capWei : 0;
  let missSince = 0;
  return {
    cap(now = Date.now()) {
      if (!cap) return '0';
      return missSince && now - missSince >= waitSecs * 1000 ? '0' : String(cap);
    },
    settled({ capped, filled }, now = Date.now()) {
      if (filled || !capped) missSince = 0;
      else if (!missSince) missSince = now;
    },
  };
}
