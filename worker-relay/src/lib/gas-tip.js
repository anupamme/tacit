// What one of our transactions offers a builder, read from what recent blocks actually paid rather than set as a
// fixed rate. A rate fixed when gas was dear is a large overpayment once it is cheap: at a 0.06 gwei base fee a
// 0.1 gwei floor is five times what the median included transaction pays, and on a sponsored path (settles, attests,
// headers) that premium is ours, not the user's.
//
// Two things decide the offer:
//   the market — the median across recent blocks of what an ordinary included transaction paid per gas. Taking the
//     median of per-block percentiles, rather than a mean, keeps one odd block from moving it; when blocks fill and
//     tips rise this follows them up on its own, which is the whole point of reading it.
//   a floor on the TOTAL, not on the rate — a builder weighs what a transaction pays, and a rate that is reasonable
//     for a 3.5M-gas header batch is dust on a 350k-gas settle. Flooring `tip × gas` instead of `tip` keeps a small
//     transaction worth including without making a large one pay for it.
// A cap bounds a spike, and a history that cannot be read falls back to the caller's fixed rate — never to zero.

export const TIP_HISTORY_BLOCKS = 20;
export const TIP_PERCENTILE = 50;      // what an ordinary included transaction paid, not the cheapest or the dearest

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v ?? 0));

// The median of a block's worth of per-block rewards. Entries a node did not answer for are left out; an empty
// history has no median and is reported as null, which the caller reads as "no market reading".
export function medianReward(rewards) {
  const xs = (Array.isArray(rewards) ? rewards : [])
    .map((r) => (Array.isArray(r) ? r[0] : r))
    .filter((v) => v != null)
    .map(big)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!xs.length) return null;
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2n;
}

// A floor on the total that tunes itself. The right floor is the least that still gets a transaction into the next blocks, and that
// depends on the builders reached and the day, so it is learned: it starts at `startWei`, falls a few percent each time a
// transaction lands in its first round, and doubles each time one misses its first round and needs a higher offer. It stays within
// [minWei, maxWei]; a restart begins again at `startWei`. A fall is slow and a rise is fast, so it settles where a miss is rare.
export function makeTipFloor({ startWei, minWei, maxWei = startWei, fall = 0.97, rise = 2 } = {}) {
  const lo = big(minWei), hi = big(maxWei);
  let v = big(startWei);
  const clamp = () => { if (v < lo) v = lo; if (v > hi) v = hi; };
  clamp();
  const per = 1_000_000n;
  return {
    value: () => v,
    // `first`: the transaction landed in the first round (at whatever offer); false: it needed a later one.
    record(first) {
      v = first ? (v * BigInt(Math.round(fall * 1e6))) / per : v * BigInt(Math.round(rise * 1e6)) / per;
      clamp();
      return v;
    },
  };
}

// The tip to offer, in wei per gas:
//   rewards      per-block priority fees at one percentile (eth_feeHistory's `reward`), newest last
//   gas          what this transaction is expected to use, so the floor can be a total rather than a rate
//   minTotalWei  the smallest total priority payment worth a builder's attention
//   capWei       the most we will offer however dear the market gets
//   fallbackWei  the rate to use when the history gives no reading at all
export function tipFor({ rewards, gas, minTotalWei = 0n, capWei, fallbackWei = 0n }) {
  const market = medianReward(rewards);
  const g = big(gas);
  // The floor is a total, so it only becomes a rate once we know the gas. Rounded up: a rate rounded down pays
  // less than the floor it is meant to enforce.
  const floor = g > 0n && big(minTotalWei) > 0n ? (big(minTotalWei) + g - 1n) / g : 0n;
  let tip = market == null ? big(fallbackWei) : market;
  if (tip < floor) tip = floor;
  const cap = big(capWei);
  if (cap > 0n && tip > cap) tip = cap;
  return tip;
}

// The same reading taken from a chain client. Every failure is the caller's fallback rate: a fee history we could
// not read must never stop a settle or hold back the headers.
export async function readTip(client, { gas, minTotalWei = 0n, capWei, fallbackWei = 0n, blocks = TIP_HISTORY_BLOCKS, percentile = TIP_PERCENTILE } = {}) {
  let rewards = null;
  try {
    const h = await client.getFeeHistory({ blockCount: blocks, rewardPercentiles: [percentile] });
    rewards = h && Array.isArray(h.reward) ? h.reward : null;
  } catch { rewards = null; }
  return tipFor({ rewards, gas, minTotalWei, capWei, fallbackWei });
}
