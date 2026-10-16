// A small SVG price chart for the TAC trade page: candles or lines on a shared time axis, volume under them, price tags at the
// right edge, a crosshair with a tooltip. No library (the page's CSP allows only its own scripts). Colours come from the page's
// CSS variables so light and dark are the page's own.
import { zone, grp } from '/trade/fmt.js?cb=43646c2e';


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
// The reader's own clock: an axis in UTC would put a day's tick at someone's mid-afternoon. The zone is named where a time is read out.
const zoneName = zone;
export const fmtLocalTime = (t, withDay) => { const d = new Date(t * 1000); return withDay ? `${d.getDate()} ${MON[d.getMonth()]}` : `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
export const fmtLocalStamp = (t) => { const d = new Date(t * 1000); return `${d.getDate()} ${MON[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())} ${zoneName(d)}`.trim(); };
export const fmtStamp = (t) => { const d = new Date(t * 1000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`; };

// The bar whose middle is nearest `t`, in bars sorted by time.
function nearestBar(bars, t, period) {
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].t + period / 2 < t) lo = mid + 1; else hi = mid; }
  const a = bars[lo], b = bars[lo - 1];
  return b && Math.abs(b.t + period / 2 - t) <= Math.abs(a.t + period / 2 - t) ? b : a;
}

// opts: {
//   series: [{ id, name, color, kind: 'candles' | 'line', area, bars: [{ t, open, high, low, close, vol }], fmt: (price) => string, unit }],
//           a line with `area` is drawn as the market page's is: shaded under it, its volume beneath, a dot on its last price
//           tickFmt: (step) => (price) => string, the price axis's labels for ticks `step` apart (default: fmt)
//   period: seconds a bar spans (sets candle width),
//   tags:   [{ y, label, color }]   price marks at the right edge (the same unit as the first series' prices)
//   label:  the chart's accessible name
//   empty:  what is said when there is nothing to draw (default: no trades yet)
//   minSpan: the least the price axis spans, as a share of the price (a price that barely moves is drawn flat, not as a cliff)
//   readout: the page reads the bar under the pointer itself (`onHover` gets each series' bar there), so no box is drawn over the chart
// }
export function mountChart(host, onHover = null) {
  let opts = null, size = { w: 0, h: 0 }, tip = null;
  host.classList.add('chart');
  const draw = () => {
    if (!opts || !size.w) return;
    const { series = [], period = 3600, tags = [], label = 'Price chart', log = false, minSpan = 0, readout = false } = opts, all = series.flatMap((s) => s.bars);
    host.replaceChildren();
    const W = size.w, H = size.h, m = { l: 8, r: 64, t: 10, b: 24 };
    if (!all.length) { host.append(Object.assign(document.createElement('p'), { className: 'chart-empty', textContent: opts.empty || 'No trades to draw yet.' })); return; }
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
    if (minSpan > 0 && hi - lo < ((hi + lo) / 2) * minSpan) { const c = (hi + lo) / 2, h = (c * minSpan) / 2; lo = Math.max(0, c - h); hi = c + h; }
    if (log && lo > 0) { const k = (hi / lo) ** 0.04; lo /= k; hi *= k; } else { const pad = (hi - lo || hi * 0.1) * 0.06; lo = Math.max(0, lo - pad); hi += pad; }
    const pw = W - m.l - m.r, ph = H - m.t - m.b, volH = ph * 0.16;
    const useLog = log && lo > 0, lg = useLog ? Math.log : (x) => x;
    const X = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * pw, Y = (v) => m.t + (1 - (lg(Math.max(v, lo * 1e-9)) - lg(lo)) / (lg(hi) - lg(lo) || 1)) * (ph - volH * 0.4);
    const first = series[0], f = first?.fmt || String;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${label}. The arrow keys read each bar.`, class: 'chart-svg' });
    svg.append(el('defs', {}, el('clipPath', { id: 'chart-clip' }, el('rect', { x: m.l, y: m.t, width: pw, height: H - m.t }))));
    const plot = el('g', { 'clip-path': 'url(#chart-clip)' }), marks = [];
    // grid and the price axis
    const ticks0 = useLog ? logTicks(lo, hi) : niceTicks(lo, hi, Math.max(3, Math.round(ph / 56))), ticks = ticks0.length > 1 ? ticks0 : niceTicks(lo, hi, 4);
    const pstep = ticks.length > 1 ? ticks[1] - ticks[0] : 0, even = !useLog && pstep > 0;
    const tickF = even && first?.tickFmt ? first.tickFmt(pstep) : f;                                  // even steps are labelled to the places the step needs
    const pointF = (s) => (even && s.tickFmt ? s.tickFmt(pstep / 10) : s.fmt || f);                   // a price read off the axis: a place finer than its labels
    for (const v of ticks) {
      svg.append(el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }));
      if (!tags.some((tg) => Math.abs(Y(tg.y) - Y(v)) < 15)) svg.append(el('text', { x: W - m.r + 6, y: Y(v) + 4, class: 'axis' }, tickF(v)));         // a price tag covers a label this close to it
    }
    // the time axis: about one label per 110px
    const days = (t1 - t0) > 2 * 86400, step = Math.max(1, Math.ceil((t1 - t0) / (pw / 110)));
    const tick = (t, label) => svg.append(el('line', { x1: X(t), x2: X(t), y1: m.t, y2: H - m.b, class: 'grid v' }), el('text', { x: X(t), y: H - 6, class: 'axis mid' }, label));
    if (days) {                                                                                       // a tick on each local midnight, every few days when they would crowd
      const each = Math.max(1, Math.ceil(step / 86400));
      for (const d = new Date(t0 * 1000); ; d.setDate(d.getDate() + each)) {
        d.setHours(0, 0, 0, 0);
        const t = d.getTime() / 1000;
        if (t >= t1) break;
        if (t >= t0) tick(t, fmtLocalTime(t, true));
      }
    } else {
      const unit = step < 3600 ? 1800 : 3600, every = Math.max(unit, Math.ceil(step / unit) * unit), off = -new Date(t0 * 1000).getTimezoneOffset() * 60;
      for (let t = Math.ceil((t0 + off) / every) * every - off; t < t1; t += every) if (t >= t0) tick(t, fmtLocalTime(t, false));
    }
    // volume under the first series
    const vmax = Math.max(...series.flatMap((s) => (s.kind === 'candles' || s.area ? s.bars : [])).map((b) => b.vol || 0), 0), bw = Math.max(1, Math.min(18, (period / (t1 - t0 || 1)) * pw * 0.7));
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
        if (s.area) {
          const half = (period / (t1 - t0 || 1)) * pw / 2, base = H - m.b;
          if (vmax > 0) for (const b of s.bars) if (b.vol > 0) { const vh = Math.max(1, (b.vol / vmax) * volH); plot.append(el('rect', { x: X(b.t) + half - bw / 2, y: base - vh, width: bw, height: vh, class: 'vol line-vol' })); }
          plot.append(el('polygon', { points: `${pts[0].split(',')[0]},${base} ${pts.join(' ')} ${pts.at(-1).split(',')[0]},${base}`, class: 'area', style: `fill:${s.color}` }));
        }
        plot.append(el('polyline', { points: pts.join(' '), class: 'line', style: `stroke:${s.color}` }));
        if (s.area) {
          const [lx, ly] = pts.at(-1).split(',');
          marks.push(el('circle', { cx: lx, cy: ly, r: 8, class: 'halo', style: `fill:${s.color}` }), el('circle', { cx: lx, cy: ly, r: 3.5, class: 'lastdot', style: `fill:${s.color}` }));       // outside the plot's clip, so the halo is whole at the edge
          // the highest and lowest close drawn, named at their points (a line of closes, so a dust trade's wick never sets them), when they read differently
          if (s.bars.length > 8) {
            let iHi = 0, iLo = 0;
            s.bars.forEach((b, i) => { if (b.close > s.bars[iHi].close) iHi = i; if (b.close < s.bars[iLo].close) iLo = i; });
            for (const [i, kind] of [[iHi, 'hi'], [iLo, 'lo']]) {
              if (iHi === iLo || s.fmt(s.bars[iHi].close) === s.fmt(s.bars[iLo].close)) break;
              const [px, py] = pts[i].split(',').map(Number), left = px < W * 0.22, right = px > W - m.r - 70, up = kind === 'hi';
              marks.push(el('circle', { cx: px, cy: py, r: 2.5, class: 'markdot', style: `stroke:${s.color}` }),
                el('text', { x: left ? px + 6 : right ? px - 6 : px, y: up ? Math.max(m.t + 10, py - 8) : Math.min(H - m.b - volH - 4, py + 15), class: `mark ${kind}`, 'text-anchor': left ? 'start' : right ? 'end' : 'middle' }, s.fmt(s.bars[i].close)));
            }
          }
        }
        else if (s.bars.length < 60) for (const p of pts) plot.append(el('circle', { cx: p.split(',')[0], cy: p.split(',')[1], r: 2, style: `fill:${s.color}`, class: 'dot' }));
      }
    }
    svg.append(plot, ...marks);
    // price tags at the right edge, each box as wide as its label
    const boxW = (text) => Math.max(m.r - 4, String(text).length * 6 + 8);
    for (const tg of tags) {
      const w = boxW(tg.label);
      svg.append(el('line', { x1: m.l, x2: W - m.r, y1: Y(tg.y), y2: Y(tg.y), class: 'tagline', style: `stroke:${tg.color}` }),
        el('rect', { x: W - w - 2, y: Y(tg.y) - 8, width: w, height: 16, class: 'tagbox', style: `fill:${tg.color}` }),
        el('text', { x: W - w + 2, y: Y(tg.y) + 4, class: 'tagtext' }, tg.label));
    }
    // the crosshair: its lines, a dot on each line it crosses, and its price and time on the axes
    const half = (period / (t1 - t0 || 1)) * pw / 2;
    const Yv = (y) => { const k = 1 - (y - m.t) / (ph - volH * 0.4), L = lg(lo) + k * (lg(hi) - lg(lo)); return Math.max(0, useLog ? Math.exp(L) : L); };
    const dots = series.map(() => el('circle', { class: 'cd', r: 4.5, visibility: 'hidden' }));
    const yl = el('rect', { class: 'clab', height: 16 }), yt = el('text', { class: 'clabt' }), xl = el('rect', { class: 'clab', height: 17 }), xt = el('text', { class: 'clabt', 'text-anchor': 'middle' });
    const cross = el('g', { class: 'cross', visibility: 'hidden' }, [el('line', { class: 'cv', y1: m.t, y2: H - m.b }), el('line', { class: 'ch', x1: m.l, x2: W - m.r }), ...dots, yl, yt, xl, xt]);
    svg.append(cross);
    const hit = el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent', style: 'cursor:crosshair; touch-action: pan-y' });
    svg.append(hit);
    host.append(svg, tip ||= Object.assign(document.createElement('div'), { className: 'chart-tip', hidden: true }));
    let cur = null;
    const move = (e) => {
      const r = svg.getBoundingClientRect(), x = e.clientX - r.left, t = t0 + ((x - m.l) / pw) * (t1 - t0);
      const rows = series.map((s) => (s.bars.length ? { s, b: nearestBar(s.bars, t, period) } : null)).filter(Boolean);
      show([...rows].sort((a, b) => Math.abs(a.b.t - t) - Math.abs(b.b.t - t))[0], rows, e.clientY - r.top);
    };
    // `py`: where the pointer is. Over candles the level line follows it (a price can be read anywhere); over a line it sits on the bar's price.
    function show(near, rows = null, py = null) {
      if (!near) return;
      cur = near;
      rows ||= series.map((s) => (s === near.s ? near : s.bars.length ? { s, b: nearestBar(s.bars, near.b.t + period / 2, period) } : null)).filter(Boolean);
      const cx = X(near.b.t) + half, candle = near.s.kind === 'candles';
      cross.setAttribute('visibility', 'visible');
      cross.querySelector('.cv').setAttribute('x1', cx); cross.querySelector('.cv').setAttribute('x2', cx);
      const cy = candle && py != null ? Math.max(m.t, Math.min(H - m.b, py)) : Y(near.b.close);
      cross.querySelector('.ch').setAttribute('y1', cy); cross.querySelector('.ch').setAttribute('y2', cy);
      const ytxt = pointF(near.s)(candle && py != null ? Yv(cy) : near.b.close), yw = boxW(ytxt);
      yl.setAttribute('x', W - yw - 2); yl.setAttribute('y', cy - 8); yl.setAttribute('width', yw); yt.setAttribute('x', W - yw + 2); yt.setAttribute('y', cy + 4); yt.textContent = ytxt;
      const d = new Date(near.b.t * 1000), xtxt = period >= 86400 ? fmtLocalTime(near.b.t, true) : `${d.getDate()} ${MON[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`, xw = xtxt.length * 6 + 12;
      const xx = Math.max(m.l, Math.min(W - m.r - xw, cx - xw / 2));
      xl.setAttribute('x', xx); xl.setAttribute('y', H - m.b + 3); xl.setAttribute('width', xw); xt.setAttribute('x', xx + xw / 2); xt.setAttribute('y', H - 7); xt.textContent = xtxt;
      const quiet = onHover && (readout || (series.length === 1 && near.s.area));
      series.forEach((s, i) => {
        const row = quiet && s.kind !== 'candles' ? rows.find((x) => x.s === s) : null;
        dots[i].setAttribute('visibility', row ? 'visible' : 'hidden');
        if (row) { dots[i].setAttribute('cx', X(row.b.t) + half); dots[i].setAttribute('cy', Y(row.b.close)); dots[i].style.stroke = s.color; }
      });
      if (quiet) { onHover(near, rows); tip.hidden = true; return; }
      tip.hidden = false;
      tip.replaceChildren(...rows.filter((x) => Math.abs(x.b.t - near.b.t) <= period * 6).map(({ s, b }) => {
        const d = document.createElement('div');
        d.innerHTML = s.kind === 'candles'
          ? `<b>${s.name}</b> <i>${fmtLocalStamp(b.t)}</i><br>O ${s.fmt(b.open)} · H ${s.fmt(b.high)} · L ${s.fmt(b.low)} · C ${s.fmt(b.close)}${b.vol ? `<br>${s.volFmt ? s.volFmt(b.vol) : grp(b.vol, 2)}` : ''}${b.n ? ` · ${b.n} trade${b.n === 1 ? '' : 's'}` : ''}`
          : `<b>${s.name}</b> <i>${fmtLocalStamp(b.t)}</i><br>${s.fmt(b.close)}`;
        return d;
      }));
      const tw = tip.offsetWidth || 180;
      tip.style.left = `${Math.max(4, Math.min(W - tw - 4, cx + 12))}px`; tip.style.top = `${m.t + 6}px`;
      onHover?.(near, rows);
    }
    const leave = () => { cur = null; cross.setAttribute('visibility', 'hidden'); for (const d of dots) d.setAttribute('visibility', 'hidden'); tip.hidden = true; onHover?.(null); };   // each dot too: one set visible would stay visible inside the hidden group
    hit.addEventListener('pointermove', move); hit.addEventListener('pointerleave', leave); hit.addEventListener('pointerdown', move);
    // The arrow keys read the bars one at a time (Home and End, the first and the last); Escape lets go.
    svg.setAttribute('tabindex', '0');
    svg.addEventListener('keydown', (e) => {
      const s = (cur?.s || series[0]), bars = s?.bars || [];
      if (!bars.length) return;
      const i = cur ? bars.indexOf(cur.b) : bars.length;
      const to = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? bars.length - 1 : null;
      if (e.key === 'Escape') { leave(); return; }
      if (to == null) return;
      e.preventDefault();
      show({ s, b: bars[Math.max(0, Math.min(bars.length - 1, to))] });
    });
    svg.addEventListener('blur', leave);
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { const r = host.getBoundingClientRect(); const w = Math.round(r.width), h = Math.round(r.height); if (w !== size.w || h !== size.h) { size = { w, h }; draw(); } }) : null;
  ro?.observe(host);
  const r0 = host.getBoundingClientRect(); size = { w: Math.round(r0.width), h: Math.round(r0.height) };
  // The page repaints on every read; a chart whose bars, tags and settings are as drawn is left alone, so its tooltip stays open.
  let sig = '';
  return { update(next) { const s = JSON.stringify([next, next.series?.map((x) => x.fmt?.(1))]); if (s === sig && opts) return; sig = s; opts = next; draw(); }, destroy() { ro?.disconnect(); host.replaceChildren(); } };
}
