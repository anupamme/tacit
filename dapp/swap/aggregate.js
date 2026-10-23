// zQuoter's onchain routes for any token to any token, read the way zSwap reads them: the best single swap or two-hop chain through ETH
// (buildBestSwapViaETHMulticall) and a split of the input across two pools (buildSplitSwap), with every pool's own quote (getQuotes) for the
// summary under the card. (A hybrid split, a direct swap beside a two-hop one, is neither a split nor a chain to the guard, so it is not
// read.) Each answer is held to the terms asked by zrouter-guard (it takes the asked token, pays the asked recipient, spends exactly the
// amount and pays at least its claimed output less the slippage) before it may be offered; the best that passes is the route. All of it is
// views on the chain: nothing here leaves the page.
import { checkZRouterCall, decodeZRouterCall } from '../zrouter-guard.js';
import { ZQUOTER, ZERO, SOURCES } from './route.js';

const SEL = { viaEth: 'e453166e', split: '892af013', quotes: 'e1fd10bc' };
const HEAVY = '0x11E1A300';                                          // 300M gas: a split's scan of every pool is far over a default call
const lc = (s) => String(s || '').toLowerCase();
const strip = (h) => String(h || '').replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');
const at = (h, i) => BigInt('0x' + (h.slice(i * 64, (i + 1) * 64) || '0'));
const quoteAt = (h, i) => ({ source: Number(at(h, i)), feeBps: at(h, i + 1), amountIn: at(h, i + 2), amountOut: at(h, i + 3) });
const bytesAt = (h, w) => { const o = Number(at(h, w)) / 32, len = Number(at(h, o)); return '0x' + h.slice((o + 1) * 64, (o + 1) * 64 + len * 2); };
const nameOf = (q) => `${SOURCES[q.source] || 'a pool'}${q.feeBps ? ` ${Number(q.feeBps) / 100}%` : ''}`;

// The raw calls inside a zRouter multicall (or the one call that is not), so a permit can go before them in one transaction.
export function legsOf(callData) {
  const h = strip(callData);
  if (h.slice(0, 8) !== 'ac9650d8') return ['0x' + h];
  const b = h.slice(8), o = Number(at(b, 0)) / 32, n = Number(at(b, o)), out = [];
  for (let i = 0; i < n; i++) {
    const rel = Number(at(b, o + 1 + i)) / 32, lenAt = o + 1 + rel, len = Number(at(b, lenAt));
    out.push('0x' + b.slice((lenAt + 1) * 64, (lenAt + 1) * 64 + len * 2));
  }
  return out;
}

// One zQuoter answer: null when it reverts (no route of that shape) or cannot be read; `fail` keeps a read that failed, so a quote can say so
// when every read failed rather than that no pool trades the pair.
async function read(ethCall, data, block, fail) {
  try { const r = strip(await ethCall(ZQUOTER, '0x' + data, block, { gas: HEAVY })); return r.length >= 640 ? r : null; }
  catch (e) { if (!(e?.revert || /revert|out of gas|gas required/i.test(e?.message || ''))) fail.push(e); return null; }
}

// → { out, min, callData, value, name, kind, legs, quotes } for the best route that passes the guard, or null when none does.
//   `to` is paid; `refundTo` gets what a two-hop chain leaves (the payer); `slippageBps` is each leg's own bound, a split's too, so every
//   route's floor is its output less the same slippage and the best output is also the best floor.
export async function bestRoute({ ethCall, to, refundTo = to, tokenIn, tokenOut, amountIn, slippageBps = 50, deadline, block = 'latest' }) {
  const slip = BigInt(slippageBps);
  const amt = BigInt(amountIn), dl = BigInt(deadline), ethIn = lc(tokenIn) === ZERO;
  const terms = (s) => [addr(to), addr(tokenIn), addr(tokenOut), word(amt), word(s), word(dl)].join('');
  const fail = [];
  const [v, sp, qs] = await Promise.all([
    read(ethCall, SEL.viaEth + addr(to) + addr(refundTo) + word(0) + addr(tokenIn) + addr(tokenOut) + word(amt) + word(slip) + word(dl), block, fail),
    read(ethCall, SEL.split + terms(slip), block, fail),
    read(ethCall, SEL.quotes + word(0) + addr(tokenIn) + addr(tokenOut) + word(amt), block, []),
  ]);
  if (!v && !sp && fail.length >= 2) throw fail[0];
  const cands = [];
  if (v) {
    const a = quoteAt(v, 0), b = quoteAt(v, 4), two = b.amountOut > 0n;
    cands.push({ kind: two ? 'twohop' : 'single', out: two ? b.amountOut : a.amountOut, callData: bytesAt(v, 9), value: at(v, 10), slip, name: two ? `${nameOf(a)} → ${nameOf(b)}` : nameOf(a), legs: [a, ...(two ? [b] : [])] });
  }
  if (sp) {
    const l0 = quoteAt(sp, 0), l1 = quoteAt(sp, 4), both = l0.amountOut > 0n && l1.amountOut > 0n;
    const legs = [l0, l1].filter((l) => l.amountOut > 0n), share = (l) => Number((l.amountIn * 100n) / amt);
    cands.push({ kind: both ? 'split' : 'single', out: l0.amountOut + l1.amountOut, callData: bytesAt(sp, 8), value: at(sp, 9), slip, legs,
      name: both ? legs.map((l) => `${nameOf(l)} ${share(l)}%`).join(' + ') : nameOf(legs[0] || l0) });
  }
  // held to the terms: the asked tokens and recipient, exactly the amount, sent exactly the ETH it spends, and paying at least what it claims less its slippage
  const ok = cands.filter((c) => {
    if (c.out <= 0n || c.value !== (ethIn ? amt : 0n)) return false;
    let legs;
    try { legs = decodeZRouterCall(c.callData); } catch { return false; }
    const single = legs.length === 1 || legs.every((l) => lc(l.tokenIn) === lc(tokenIn));
    c.min = single ? legs.reduce((s, l) => s + l.limit, 0n) : legs[legs.length - 1].limit;
    const floor = (c.out * (10000n - c.slip - 1n)) / 10000n;
    return checkZRouterCall(c.callData, { to, tokenIn, tokenOut, exactOut: false, amount: amt, maxIn: amt, minOut: floor, deadline: dl }) === null;
  });
  if (!ok.length) return null;
  const best = ok.reduce((x, y) => (y.out > x.out ? y : x));
  const quotes = [];
  if (qs) {
    const o = Number(at(qs, 4)) / 32, n = Math.min(Number(at(qs, o)), 24);
    for (let i = 0; i < n; i++) { const q = quoteAt(qs, o + 1 + i * 4); if (q.amountOut > 0n) quotes.push({ name: nameOf(q), out: q.amountOut }); }
    quotes.sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : 0));
  }
  return { out: best.out, min: best.min, callData: best.callData, value: best.value, name: best.name, kind: best.kind, legs: best.legs, quotes, tokenIn, tokenOut, amountIn: amt, to, deadline: dl };
}

// What KyberSwap's public router says it would pay for the same trade: a reference beside the onchain route, never a way the page swaps.
// → the amount out, or null when it does not answer within the time (or has no route).
const KS = 'https://aggregator-api.kyberswap.com/ethereum/api/v1/routes', KS_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export async function kyberOut({ tokenIn, tokenOut, amountIn, ms = 3000, get = globalThis.fetch }) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms), tok = (a) => (lc(a) === ZERO ? KS_ETH : a);
  try {
    const r = await get(`${KS}?${new URLSearchParams({ tokenIn: tok(tokenIn), tokenOut: tok(tokenOut), amountIn: String(amountIn) })}`, { signal: ac.signal });
    if (!r.ok) return null;
    const out = (await r.json())?.data?.routeSummary?.amountOut;
    return /^\d+$/.test(String(out ?? '')) && BigInt(out) > 0n ? BigInt(out) : null;
  } catch { return null; } finally { clearTimeout(t); }
}
