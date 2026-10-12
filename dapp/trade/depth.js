// An order book as a depth chart, for the TAC trade page: resting orders by price on one axis and what they add up to on the other,
// asks climbing to the right of the middle and bids to the left, with the part an amount would fill drawn heavier. SVG only (the page's
// CSP allows no library). Both order books use it: the Bitcoin book's listings and zSwap's boards on Ethereum.
//
// update({ asks, bids, take, priceFmt, sizeFmt, label }):
//   asks / bids: [{ price, size, ...anything }] one entry per order or per level, `size` in TAC (a number), `price` in whatever unit the axis is in
//   take: { side: 'ask' | 'bid', size } the amount an order would fill, highlighted from the best price outward
//   onPick(level, side) is called with the order a click lands on.

import { niceTicks } from '/trade/chart.js?cb=e9d552bb';
import { cumulative } from '/trade/book.js?cb=01035c6e';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, kids = []) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
};

export function mountDepth(host, { onPick = null } = {}) {
  let opts = null, size = { w: 0, h: 0 }, tip = null;
  host.classList.add('depth-chart');
  const draw = () => {
    if (!opts || !size.w) return;
    const { asks = [], bids = [], take = null, priceFmt = String, sizeFmt = String, label = 'Order book', empty = 'No orders.' } = opts;
    host.replaceChildren();
    const A = cumulative(asks, 'ask'), B = cumulative(bids, 'bid');
    if (!A.length && !B.length) { host.append(Object.assign(document.createElement('p'), { className: 'chart-empty', textContent: empty })); return; }
    const W = size.w, H = size.h, m = { l: 8, r: 8, t: 10, b: 24 };
    const prices = [...A.map((s) => s.price), ...B.map((s) => s.price)];
    const bestAsk = A[0]?.price ?? null, bestBid = B[0]?.price ?? null;
    const mid = bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : (bestAsk ?? bestBid);
    // A side with nothing on it still has room beside the middle, so a lone side does not stretch to the whole width.
    let lo = Math.min(...prices), hi = Math.max(...prices);
    if (!B.length) lo = Math.min(lo, mid * 0.9); if (!A.length) hi = Math.max(hi, mid * 1.1);
    // One order far above the rest would flatten the others: the axis stops at three times the best price, and says so.
    const capped = A.length && A[A.length - 1].price > (bestAsk * 3) ? bestAsk * 3 : null;
    if (capped) hi = Math.max(capped, bestBid ?? 0);
    const span = (hi - lo) || hi * 0.2, pad = span * 0.04; lo -= pad; hi += pad;
    const maxCum = Math.max(1e-9, ...[...A, ...B].filter((s) => s.price <= hi).map((s) => s.cum));
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const X = (p) => m.l + ((Math.min(Math.max(p, lo), hi) - lo) / (hi - lo)) * pw, Y = (c) => m.t + (1 - Math.min(c, maxCum * 1.05) / (maxCum * 1.05)) * ph;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label, class: 'chart-svg' });
    for (const v of niceTicks(lo, hi, Math.max(2, Math.round(pw / 120)))) {
      svg.append(el('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, class: 'grid v' }), el('text', { x: X(v), y: H - 6, class: 'axis mid' }, priceFmt(v)));
    }
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'grid' }));
    // each side's staircase as a filled path from the middle outward; the part an amount fills is a second, heavier path over it
    const stairs = (steps, side, upto) => {
      const pts = [];
      let prev = 0;
      for (const s of steps) {
        if (upto != null && prev >= upto) break;
        const c = upto != null ? Math.min(s.cum, upto) : s.cum;
        pts.push([s.price, prev], [s.price, c]);
        prev = c;
        if (upto != null && c >= upto) break;
      }
      if (!pts.length) return null;
      const first = pts[0], last = pts[pts.length - 1];
      const d = `M${X(first[0])},${Y(0)} ` + pts.map(([p, c]) => `L${X(p)},${Y(c)}`).join(' ') + ` L${X(last[0])},${Y(0)} Z`;
      return el('path', { d, class: `dep-${side}${upto != null ? ' take' : ''}` });
    };
    if (A.length) svg.append(stairs(A, 'ask', null));
    if (B.length) svg.append(stairs(B, 'bid', null));
    if (take?.size > 0) { const st = take.side === 'bid' ? B : A, f = stairs(st, take.side, take.size); if (f) svg.append(f); }
    if (mid != null) svg.append(el('line', { x1: X(mid), x2: X(mid), y1: m.t, y2: H - m.b, class: 'dep-mid' }));
    if (capped) svg.append(el('text', { x: W - m.r, y: m.t + 10, class: 'axis', 'text-anchor': 'end' }, `to ${priceFmt(capped)}; dearer listings are not drawn`));
    // hover and click: the order nearest the pointer on the side it is on
    const hit = el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent', style: 'cursor:pointer' });
    const cross = el('line', { y1: m.t, y2: H - m.b, class: 'cv', visibility: 'hidden', style: 'stroke:var(--mute);stroke-dasharray:3 3' });
    svg.append(cross, hit);
    host.append(svg, tip ||= Object.assign(document.createElement('div'), { className: 'chart-tip', hidden: true }));
    const nearest = (e) => {
      const r = svg.getBoundingClientRect(), p = lo + ((e.clientX - r.left - m.l) / pw) * (hi - lo);
      const side = mid != null && p < mid && B.length ? 'bid' : (A.length ? 'ask' : 'bid'), steps = side === 'ask' ? A : B;
      let best = null;
      for (const s of steps) if (!best || Math.abs(s.price - p) < Math.abs(best.price - p)) best = s;
      return best && { side, step: best };
    };
    hit.addEventListener('pointermove', (e) => {
      const n = nearest(e);
      if (!n) return;
      cross.setAttribute('x1', X(n.step.price)); cross.setAttribute('x2', X(n.step.price)); cross.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = `<b>${n.side === 'ask' ? 'Sell' : 'Buy'} ${sizeFmt(n.step.size)}</b> at ${priceFmt(n.step.price)}<br><i>${sizeFmt(n.step.cum)} in all up to here${n.step.orders.length > 1 ? ` · ${n.step.orders.length} orders` : ''}</i>`;
      const tw = tip.offsetWidth || 180;
      tip.style.left = `${Math.max(4, Math.min(W - tw - 4, X(n.step.price) + 10))}px`; tip.style.top = `${m.t + 6}px`;
    });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    hit.addEventListener('click', (e) => { const n = nearest(e); if (n && onPick) onPick(n.step.orders[0], n.side, n.step); });
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { const r = host.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height); if (w !== size.w || h !== size.h) { size = { w, h }; draw(); } }) : null;
  ro?.observe(host);
  const r0 = host.getBoundingClientRect(); size = { w: Math.round(r0.width), h: Math.round(r0.height) };
  return { update(next) { opts = next; draw(); }, destroy() { ro?.disconnect(); host.replaceChildren(); } };
}
