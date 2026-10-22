// The farms row on /assets/: where liquidity earns TAC, each with the APR it pays now. The TAC/ETH farm and the private pools' farms are read as the
// rewards page reads them (trade/farm-read.js). TACD's and TACE's pools are the ones the points service's liquidity campaign pays for: they are found by
// their tokens, and paid by the campaign's own rule (worker-relay/src/lib/points-lp.js): the day's pot shared by the weighted dollars held, no dollar paid more than the cap.
import { ethCall, api, $ } from '/trade/util.js?cb=509d6618';
import { aprText, readPrecision, privateFarms } from '/trade/farm-read.js?cb=112a01b9';
import { DEPLOYMENTS } from '/vault/deployments.js?cb=4af96594';

const POINTS = 'https://tacit-points.onrender.com';
const WAD = 10n ** 18n, BPS = 10000n;
const TOKEN0 = '0x0dfe1681', TOKEN1 = '0xd21220a7';

// TAC a day that one dollar of liquidity earns, at a pool's weight of 1, from the campaign's reading (the points service's /lp), and the pools it pays for.
// Null when the campaign is off, has not started, or has ended.
export function campaignRate(lp, nowSec = Date.now() / 1000) {
  const t = lp?.enabled && nowSec < (Number(lp.endSec) || Infinity) ? lp.terms : null;
  if (t?.dailyWei == null || t.capWeiPerUsdDay == null) return null;
  const pools = (lp.pools || []).map((p) => ({ pool: String(p.pool).toLowerCase(), weight: BigInt(p.weightBps), usd: BigInt(p.valueUsdWei || 0) }));
  const total = pools.reduce((s, p) => s + p.usd * p.weight / BPS, 0n), cap = BigInt(t.capWeiPerUsdDay);
  const share = total > 0n ? BigInt(t.dailyWei) * WAD / total : cap;
  return { perUsd: Number(share < cap ? share : cap) / 1e18, pools };
}

// A year of that, at TAC's price, for a dollar held in a pool of the given weight, in percent.
export const campaignApr = (perUsd, weight, tacUsd) => (tacUsd > 0 ? perUsd * Number(weight) / Number(BPS) * tacUsd * 365 * 100 : null);

const tile = (id) => $(`#fr-${id}`);
function put(id, { apr, note, href }) {
  const a = tile(id);
  if (!a) return;
  if (href) a.href = href;
  if (note != null) $('.sub', a).textContent = note;
  $('.apr', a).textContent = apr == null ? '' : aprText(apr);
}

const addrOf = (hex) => `0x${String(hex).slice(-40).toLowerCase()}`;

// Which vault's token a campaign pool trades, by the pool's own two tokens: { usd: [pool, …], eth: […] }.
async function byVault(pools) {
  const synth = Object.fromEntries(DEPLOYMENTS.vaults.map((v) => [v.key, v.hint?.synth?.toLowerCase()]));
  const out = { usd: [], eth: [] };
  await Promise.all(pools.map(async (p) => {
    const [a, b] = await Promise.all([ethCall(p.pool, TOKEN0), ethCall(p.pool, TOKEN1)]).then((r) => r.map(addrOf)).catch(() => []);
    for (const key of Object.keys(out)) if (synth[key] && (a === synth[key] || b === synth[key])) out[key].push(p);
  }));
  return out;
}

// `spot` is a promise of { ethUsd, btcUsd }: the reads below start at once, and each tile is drawn when what it needs has come.
export function showFarms(spot) {
  const call = (c) => ethCall(c.to, c.data);
  const fac = readPrecision(call).catch(() => null);
  const prog = api('/farm/program?network=mainnet');
  const lp = fetch(`${POINTS}/lp`, { signal: AbortSignal.timeout(8e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  fac.then((f) => { if (f) put('pub', f.live ? { apr: f.apr } : { note: 'Between reward periods' }); });

  Promise.all([fac, prog, spot]).then(([f, p, px]) => {
    if (!f || !p) return;
    const list = privateFarms(p, f.tacEth, px || {});
    if (!list.length) return put('prv', { note: 'Between reward periods' });
    const best = list.reduce((m, x) => ((x.apr ?? -1) > (m.apr ?? -1) ? x : m));
    put('prv', { apr: best.apr, note: `${list.length} pools`, href: `/#farm/private-${best.pid}` });
  }).catch(() => {});

  Promise.all([fac, lp, spot]).then(async ([f, j, px]) => {
    const rate = campaignRate(j), tacUsd = (px?.ethUsd || 0) * (f?.tacEth || 0);
    if (!rate) return;
    const pools = await byVault(rate.pools);
    for (const [key, id] of [['usd', 'tacd'], ['eth', 'tace']]) {
      const aprs = pools[key].map((p) => campaignApr(rate.perUsd, p.weight, tacUsd)).filter((x) => x != null);
      if (aprs.length) put(id, { apr: Math.max(...aprs) });
    }
  }).catch(() => {});
}
