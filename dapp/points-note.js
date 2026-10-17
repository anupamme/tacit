// What the points program pays for ETH swapped into TAC through the Precision pool: per ETH, and at least (its early bonus and the
// TAC-holder tiers only add to it). From the points service's terms (`/leaderboard?day=today`, its `program`), read once in ten minutes
// and never waited for: `perEth()` is what has been read, 0 until then, when the terms cannot be read, or when the day's weight for it
// is none. `read()` returns the service's answer or null. Used by the swap page and the trade page's ticket.
export function makePointsNote({ read, now = () => Date.now() }) {
  let at = 0, rate = 0;
  const take = (p, day) => {
    const w = Number([...(p?.weights || [])].reverse().find((e) => e.fromDay <= day)?.weights?.zswapeth ?? 1), r = Number(p?.rates?.zswapeth);
    return Number.isFinite(r) && r > 0 && Number.isFinite(w) && w > 0 ? r * w : 0;
  };
  async function load() {
    if (now() - at < 600e3) return rate;
    at = now();
    try {
      const j = await read();
      if (j?.program) rate = take(j.program, Math.floor(now() / 86400e3));
      else at = now() - 540e3;                                                // unread: asked again in a minute, the last reading stands
    } catch { at = now() - 540e3; }
    return rate;
  }
  // "285+ points" for `wei` of ETH put into the Precision pool, or '' where that is under one point or the program is not read.
  const floor = (wei) => { const n = rate ? Math.floor(Number(wei) / 1e18 * rate) : 0; return n >= 1 ? `${n.toLocaleString('en-US')}+ points` : ''; };
  return { load, perEth: () => rate, floor };
}
