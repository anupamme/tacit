// Slim views of the /stats reading, each built once per reading from its JSON body.
//
// `eth`: the pool's ETH reading alone (its totals, its movements and its latest deposits), for the tETH page, which draws the pool's ETH history and
// reads nothing else of /stats. The whole reading is about 1.6 MB (176 KB compressed), nearly all of it the per-device event series the stats page
// keeps; this is about 6 KB compressed. It is the same `eth` object the whole reading carries, with the reading's time and block beside it.
export function ethStatsBody(body) {
  const j = JSON.parse(body);
  return JSON.stringify({ eth: j.eth ?? null, at: j.at ?? null, block: j.block ?? null });
}
