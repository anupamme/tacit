// A small SVG price chart for the TAC trade page: candles or lines on a shared time axis, volume under them, price tags at the
// right edge, a crosshair with a tooltip. No library (the page's CSP allows only its own scripts). Colours come from the page's
// CSS variables so light and dark are the page's own.

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, kids = []) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
};

// 1, 2, 2.5, 5 times a power of ten: about `count` round numbers between lo and hi.
export function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag, out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

// 1, 2 and 5 times each power of ten between lo and hi: a log axis's round numbers.
export function logTicks(lo, hi) {
  if (!(lo > 0 && hi > lo)) return [lo];
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const k of [1, 2, 5]) { const v = k * 10 ** e; if (v >= lo && v <= hi) out.push(Number(v.toPrecision(12))); }
  return out;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
export const fmtTime = (t, withDay) => { const d = new Date(t * 1000); return withDay ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]}` : `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
export const fmtStamp = (t) => { const d = new Date(t * 1000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`; };

// opts: {
//   series: [{ id, name, color, kind: 'candles' | 'line', bars: [{ t, open, high, low, close, vol }], fmt: (price) => string, unit }],
//   period: seconds a bar spans (sets candle width),
//   tags:   [{ y, label, color }]   price marks at the right edge (the same unit as the first series' prices)
//   label:  the chart's accessible name
// }
export function mountChart(host, onHover = null) {
  let opts = null, size = { w: 0, h: 0 }, tip = null;
  host.classList.add('chart');
  const draw = () => {
    if (!opts || !size.w) return;
    const { series = [], period = 3600, tags = [], label = 'Price chart', log = false } = opts, all = series.flatMap((s) => s.bars);
    host.replaceChildren();
    const W = size.w, H = size.h, m = { l: 8, r: 64, t: 10, b: 24 };
    if (!all.length) { host.append(Object.assign(document.createElement('p'), { className: 'chart-empty', textContent: 'No trades to draw yet.' })); return; }
    const t0 = Math.min(...all.map((b) => b.t)), t1 = Math.max(...all.map((b) => b.t)) + period;
    // The axis fits the candles' bodies, with their wicks up to half a body-range beyond: one print far from the rest (the tape's own
    // notes say a small trade can make one) would otherwise squash every other candle. A wick past the axis is clipped; the tooltip
    // still reads its true high or low.
    const ranged = series.flatMap((x) => (x.kind === 'candles' ? x.bars : x.bars.map((b) => ({ open: b.close, close: b.close, low: b.close, high: b.close }))));   // a line is its closes alone
    const bodies = ranged.flatMap((b) => [b.open ?? b.close, b.close]).filter(Number.isFinite);
    let lo = Math.min(...bodies), hi = Math.max(...bodies);
    const room = (hi - lo || hi * 0.1) * 0.5;
    lo = Math.max(Math.min(...ranged.map((b) => b.low ?? b.close)), lo - room); hi = Math.min(Math.max(...ranged.map((b) => b.high ?? b.close)), hi + room);
    for (const tg of tags) { lo = Math.min(lo, tg.y); hi = Math.max(hi, tg.y); }
    if (log && lo > 0) { const k = (hi / lo) ** 0.04; lo /= k; hi *= k; } else { const pad = (hi - lo || hi * 0.1) * 0.06; lo = Math.max(0, lo - pad); hi += pad; }
    const pw = W - m.l - m.r, ph = H - m.t - m.b, volH = ph * 0.16;
    const useLog = log && lo > 0, lg = useLog ? Math.log : (x) => x;
    const X = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * pw, Y = (v) => m.t + (1 - (lg(Math.max(v, lo * 1e-9)) - lg(lo)) / (lg(hi) - lg(lo) || 1)) * (ph - volH * 0.4);
    const first = series[0], f = first?.fmt || String;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label, class: 'chart-svg' });
    svg.append(el('defs', {}, el('clipPath', { id: 'chart-clip' }, el('rect', { x: m.l, y: m.t, width: pw, height: H - m.t }))));
    const plot = el('g', { 'clip-path': 'url(#chart-clip)' });
    // grid and the price axis
    const ticks = useLog ? logTicks(lo, hi) : niceTicks(lo, hi, Math.max(3, Math.round(ph / 56)));
    for (const v of (ticks.length > 1 ? ticks : niceTicks(lo, hi, 4))) {
      svg.append(el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }));
      if (!tags.some((tg) => Math.abs(Y(tg.y) - Y(v)) < 15)) svg.append(el('text', { x: W - m.r + 6, y: Y(v) + 4, class: 'axis' }, f(v)));         // a price tag covers a label this close to it
    }
    // the time axis: about one label per 110px
    const days = (t1 - t0) > 2 * 86400, step = Math.max(1, Math.ceil((t1 - t0) / (pw / 110)));
    const unit = days ? 86400 : step < 3600 ? 1800 : 3600, every = Math.max(unit, Math.ceil(step / unit) * unit);
    for (let t = Math.ceil(t0 / every) * every; t < t1; t += every) {
      svg.append(el('line', { x1: X(t), x2: X(t), y1: m.t, y2: H - m.b, class: 'grid v' }), el('text', { x: X(t), y: H - 6, class: 'axis mid' }, fmtTime(t, days)));
    }
    // volume under the first series
    const vmax = Math.max(...series.flatMap((s) => (s.kind === 'candles' ? s.bars : [])).map((b) => b.vol || 0), 0), bw = Math.max(1, Math.min(18, (period / (t1 - t0 || 1)) * pw * 0.7));
    for (const s of series) {
      if (s.kind === 'candles') {
        for (const b of s.bars) {
          const up = b.close >= b.open, c = up ? 'up' : 'down', x = X(b.t) + (period / (t1 - t0 || 1)) * pw / 2;
          if (vmax > 0 && b.vol > 0) { const vh = Math.max(1, (b.vol / vmax) * volH); plot.append(el('rect', { x: x - bw / 2, y: H - m.b - vh, width: bw, height: vh, class: `vol ${c}` })); }
          plot.append(el('line', { x1: x, x2: x, y1: Y(b.high), y2: Y(b.low), class: `wick ${c}` }),
            el('rect', { x: x - bw / 2, y: Math.min(Y(b.open), Y(b.close)), width: bw, height: Math.max(1.5, Math.abs(Y(b.open) - Y(b.close))), class: `body ${c}` }));
        }
      } else if (s.bars.length) {
        const pts = s.bars.map((b) => `${X(b.t) + (period / (t1 - t0 || 1)) * pw / 2},${Y(b.close)}`);
        plot.append(el('polyline', { points: pts.join(' '), class: 'line', style: `stroke:${s.color}` }));
        if (s.bars.length < 60) for (const p of pts) plot.append(el('circle', { cx: p.split(',')[0], cy: p.split(',')[1], r: 2, style: `fill:${s.color}`, class: 'dot' }));
      }
    }
    svg.append(plot);
    // price tags at the right edge
    for (const tg of tags) {
      svg.append(el('line', { x1: m.l, x2: W - m.r, y1: Y(tg.y), y2: Y(tg.y), class: 'tagline', style: `stroke:${tg.color}` }),
        el('rect', { x: W - m.r + 2, y: Y(tg.y) - 8, width: m.r - 4, height: 16, class: 'tagbox', style: `fill:${tg.color}` }),
        el('text', { x: W - m.r + 6, y: Y(tg.y) + 4, class: 'tagtext' }, tg.label));
    }
    // the crosshair
    const cross = el('g', { class: 'cross', visibility: 'hidden' }, [el('line', { class: 'cv', y1: m.t, y2: H - m.b }), el('line', { class: 'ch', x1: m.l, x2: W - m.r })]);
    svg.append(cross);
    const hit = el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent', style: 'cursor:crosshair; touch-action: pan-y' });
    svg.append(hit);
    host.append(svg, tip ||= Object.assign(document.createElement('div'), { className: 'chart-tip', hidden: true }));
    const move = (e) => {
      const r = svg.getBoundingClientRect(), x = e.clientX - r.left, t = t0 + ((x - m.l) / pw) * (t1 - t0);
      const rows = series.map((s) => { let best = null; for (const b of s.bars) if (!best || Math.abs(b.t + period / 2 - t) < Math.abs(best.t + period / 2 - t)) best = b; return best && { s, b: best }; }).filter(Boolean);
      const near = rows.sort((a, b) => Math.abs(a.b.t - t) - Math.abs(b.b.t - t))[0];
      if (!near) return;
      const cx = X(near.b.t) + (period / (t1 - t0 || 1)) * pw / 2;
      cross.setAttribute('visibility', 'visible');
      cross.querySelector('.cv').setAttribute('x1', cx); cross.querySelector('.cv').setAttribute('x2', cx);
      const cy = Y(near.b.close); cross.querySelector('.ch').setAttribute('y1', cy); cross.querySelector('.ch').setAttribute('y2', cy);
      tip.hidden = false;
      tip.replaceChildren(...rows.filter((x) => Math.abs(x.b.t - near.b.t) <= period * 6).map(({ s, b }) => {
        const d = document.createElement('div');
        d.innerHTML = s.kind === 'candles'
          ? `<b>${s.name}</b> <i>${fmtStamp(b.t)}</i><br>O ${s.fmt(b.open)} · H ${s.fmt(b.high)} · L ${s.fmt(b.low)} · C ${s.fmt(b.close)}${b.vol ? `<br>${s.volFmt ? s.volFmt(b.vol) : b.vol.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : ''}${b.n ? ` · ${b.n} trade${b.n === 1 ? '' : 's'}` : ''}`
          : `<b>${s.name}</b> <i>${fmtStamp(b.t)}</i><br>${s.fmt(b.close)}`;
        return d;
      }));
      const tw = tip.offsetWidth || 180;
      tip.style.left = `${Math.max(4, Math.min(W - tw - 4, cx + 12))}px`; tip.style.top = `${m.t + 6}px`;
      onHover?.(near);
    };
    const leave = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; onHover?.(null); };
    hit.addEventListener('pointermove', move); hit.addEventListener('pointerleave', leave); hit.addEventListener('pointerdown', move);
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { const r = host.getBoundingClientRect(); const w = Math.round(r.width), h = Math.round(r.height); if (w !== size.w || h !== size.h) { size = { w, h }; draw(); } }) : null;
  ro?.observe(host);
  const r0 = host.getBoundingClientRect(); size = { w: Math.round(r0.width), h: Math.round(r0.height) };
  return { update(next) { opts = next; draw(); }, destroy() { ro?.disconnect(); host.replaceChildren(); } };
}
