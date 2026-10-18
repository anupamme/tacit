// The Bitcoin side of the borrow page (/vault/#btc): cUSD borrowed against cBTC. The loan itself is taken on the front page (its Borrow sheet), so
// this side only shows the steps and three figures, all from the collateral engine in one Multicall3 call: the cUSD lent now, the collateral a loan
// needs and the line it is liquidated below. It imports nothing: the page hands it its own batch reader, so nothing more is fetched to show it.
export const ENGINE = '0x000000003f608BDdF0ca45934003ffb9DbDF70DB';                 // the collateral engine: prices bitcoin, holds the bonds, lends cUSD
const SEL = { cdpRatioBps: '0x4827ecb3', liqRatioBps: '0x1432d93f', outstandingCusd: '0xa42542c0' };
const CUSD_DP = 8;

export const engineCalls = () => [{ to: ENGINE, data: SEL.cdpRatioBps }, { to: ENGINE, data: SEL.liqRatioBps }, { to: ENGINE, data: SEL.outstandingCusd }];
const word = (h) => (h == null || !/^0x[0-9a-f]{64}/i.test(h) ? null : BigInt(h.slice(0, 66)));
// The ratios in percent, the cUSD out in its smallest unit; null where a read failed.
export function parseEngine(res) {
  const [r, l, o] = (res || []).map(word);
  return { ratio: r == null ? null : Number(r) / 100, liq: l == null ? null : Number(l) / 100, out: o };
}
const pct = (x) => (x == null ? '—' : `${x.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`);
const cusd = (v) => (v == null ? '—' : `${(Number(v) / 10 ** CUSD_DP).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} cUSD`);
// The rows the board shows, in order: [id, text].
export const figures = (e) => [['out', cusd(e.out)], ['ratio', pct(e.ratio)], ['liq', pct(e.liq)]];

// Fills the board's rows (they are in the page already, so nothing moves when the figures arrive). A failed read leaves a dash and says so in the eyebrow.
export async function loadBtc(root, { batch }) {
  let e;
  try { e = parseEngine(await batch(engineCalls())); } catch { e = parseEngine([]); }
  for (const [k, t] of figures(e)) { const b = root.querySelector(`[data-bf="${k}"]`); if (b) b.textContent = t; }
  const who = root.querySelector('[data-bf-who]');
  if (who) who.textContent = e.out == null && e.ratio == null && e.liq == null ? 'could not be read' : '';
  return e;
}
