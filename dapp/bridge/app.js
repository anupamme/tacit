// The bridge page: one tile to pick an asset and a way, the bridges this browser has under way, and the two proofs they wait on.
// Below it, the walk-through of how each way is proven. Nothing here signs or moves a bridge: the front page's bridge does
// (its sheets are linked), and this page reads its journals (track.js) and the chains.
import { ROUTES, readBridges, liveLine, nextOf, fmtAmount, limitLine } from '/bridge/track.js?cb=089731ca';
import { bodyType } from '/rpc-body.js';

const API = 'https://api.tacit.finance';
const ESPLORA = 'https://mempool.space/api';
const RPC = 'https://ethereum-rpc.publicnode.com';
const TAC_ERC20 = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const int = (n) => Number(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const within = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
async function getJson(url, ms = 15e3) {
  const r = await fetch(url, { signal: within(ms) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1e3);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

// ── live: the two proofs, and the TAC that has crossed ──────────────────────────────────────────────────────────────────
const LIVE = { btcAttested: null, btcTip: null, btcConfs: null, ethCovered: null, burns: null, cadence: null, cadenceAt: 0, txs: new Map(), at: 0 };

async function readProofs() {
  // each reading is drawn as it arrives, so a slow one holds up only its own figure
  const read = (url, use) => getJson(url).then((v) => { use(v); paintProofs(); }).catch(() => {});
  await Promise.all([
    read(`${API}/reflection/status?network=mainnet`, (s) => {
      if (Number.isInteger(s.attestedHeight)) LIVE.btcAttested = s.attestedHeight;
      if (Number.isInteger(s.confirmations)) LIVE.btcConfs = s.confirmations;
      if (Number.isInteger(s.bridgeBurns)) LIVE.burns = s.bridgeBurns;
    }),
    read(`${API}/reflection/eth-state/covers?network=mainnet&block=1`, (c) => { if (Number.isInteger(c.bestBlock)) LIVE.ethCovered = c.bestBlock; }),
    // Bitcoin's own tip (the status's tipHeight is the reflection's view of it)
    read(`${ESPLORA}/blocks/tip/height`, (h) => { if (Number.isInteger(h)) LIVE.btcTip = h; }),
    // how often a proof of Bitcoin lands on Ethereum: the median gap between the day's attestations. It moves slowly and the
    // feed is 15 KB, so it is read every ten minutes, not with each minute's figures.
    ...(Date.now() - LIVE.cadenceAt > 10 * 60e3 ? [read(`${API}/flow`, (f) => { LIVE.cadenceAt = Date.now(); const m = medianGapMin(f?.events?.attests); if (m) LIVE.cadence = m; })] : []),
  ]);
  LIVE.at = Date.now();
}

// The median minutes between a list of times (seconds), or null with too few of them.
function medianGapMin(times) {
  const t = (Array.isArray(times) ? times : []).filter(Number.isFinite).sort((a, b) => a - b);
  if (t.length < 4) return null;
  const gaps = t.slice(1).map((v, i) => (v - t[i]) / 60).sort((a, b) => a - b);
  return Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)]));
}

// What the chosen way waits on, and for about how long: 24 Bitcoin blocks, then the next proof; or Ethereum's finality.
function paintWait() {
  const el = $('#bt-wait');
  if (!el) return;
  const confs = LIVE.btcConfs ?? 24, hours = Math.round(confs / 6);
  el.innerHTML = PICK.dir === 'in'
    ? `About ${hours} hours: <span data-live="confs" class="num">${confs}</span> Bitcoin confirmations, then the next proof${LIVE.cadence ? ` (one lands about every ${LIVE.cadence} min)` : ''}`
    : 'About 13 minutes for Ethereum to finalize, then you sign the Bitcoin mint, paid with a little BTC from your address';
}

function paintProofs() {
  const set = (sel, v) => $$(sel).forEach((e) => { e.textContent = v; e.classList.remove('sk'); });
  if (LIVE.btcAttested != null) set('[data-live="btc"]', int(LIVE.btcAttested));
  if (LIVE.ethCovered != null) set('[data-live="eth"]', int(LIVE.ethCovered));
  if (LIVE.btcConfs != null) set('[data-live="confs"]', int(LIVE.btcConfs));
  if (LIVE.burns != null) set('[data-live="burns"]', int(LIVE.burns));
  const lag = LIVE.btcTip != null && LIVE.btcAttested != null ? LIVE.btcTip - LIVE.btcAttested : null;
  const b = $('#pf-btc');
  // the proof sits `confirmations` deep by design, so only a lag well past that depth reads as slow
  if (b) b.dataset.state = LIVE.btcAttested == null ? 'off' : lag != null && lag > (LIVE.btcConfs ?? 24) + 12 ? 'slow' : 'on';
  const e = $('#pf-eth');
  if (e) e.dataset.state = LIVE.ethCovered == null ? 'off' : 'on';
  const lagEl = $('#pf-lag');
  if (lagEl && lag != null) lagEl.textContent = lag <= 0 ? 'at the tip' : `${int(lag)} behind Bitcoin’s tip`;
  paintWait();
}

async function readSupply() {
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': bodyType(RPC) }, signal: within(15e3),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: TAC_ERC20, data: '0x18160ddd' }, 'latest'] }) });
    const j = await r.json();
    const v = BigInt(j.result) / 10n ** 18n;
    if (v > 0n) $$('[data-live="supply"]').forEach((e) => { e.textContent = int(v); e.classList.remove('sk'); });
  } catch { /* the line keeps its placeholder */ }
}

// The Bitcoin transactions of bridges under way, read for their block (a bridge is followed even with no page moving it on).
// One already in a block keeps it, so it is not asked again.
async function readTxs(rows) {
  const want = rows.filter((r) => r.btcTx && !r.done && !r.back && !(LIVE.txs.get(r.btcTx) || {}).confirmed).map((r) => r.btcTx).slice(0, 8);
  await Promise.all(want.map(async (id) => {
    try {
      const s = await getJson(`${ESPLORA}/tx/${id}/status`, 12e3);
      LIVE.txs.set(id, { confirmed: !!s.confirmed, height: s.block_height ?? null });
    } catch { /* unknown stays unknown */ }
  }));
}

// ── the tile: an asset, a way, its steps, and the door to the sheet that does it ────────────────────────────────────────────
const PICK = { asset: 'tac', dir: 'in' };

function readHash() {
  const [a, d] = location.hash.replace(/^#/, '').split('/');
  if (ROUTES[a]) PICK.asset = a;
  PICK.dir = d === 'out' && ROUTES[PICK.asset].out ? 'out' : 'in';
}

function paintTile() {
  const a = ROUTES[PICK.asset], route = a[PICK.dir];
  $$('#bt-assets [data-asset]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.asset === PICK.asset)));
  const t = $('#bt');
  t.dataset.dir = PICK.dir;
  t.dataset.asset = PICK.asset;
  $('#bt-flip').disabled = !a.out;
  $('#bt-flip').title = a.out ? 'Switch direction' : `${a.ticker} enters by a lock`;
  $('#bt-from').textContent = PICK.dir === 'in' ? 'Bitcoin' : 'Ethereum';
  $('#bt-to').textContent = PICK.dir === 'in' ? 'Ethereum' : 'Bitcoin';
  $('#bt-from-ic').setAttribute('href', PICK.dir === 'in' ? '#tk-btc' : '#tk-eth');
  $('#bt-to-ic').setAttribute('href', PICK.dir === 'in' ? '#tk-eth' : '#tk-btc');
  $$('#bt .bt-tk use').forEach((u) => u.setAttribute('href', `#${a.icon}`));
  const steps = $('#bt-steps'), key = `${PICK.asset}/${PICK.dir}`;
  if (steps.dataset.key !== key) {                // drawn again only when the way changes, so its light keeps running
    steps.dataset.key = key;
    steps.innerHTML = route.steps.map((s, i) => `<li style="--i:${i}"><span class="dot" aria-hidden="true"></span>${esc(s)}</li>`).join('');
  }
  const go = $('#bt-go');
  go.href = route.href;
  go.querySelector('span').textContent = route.go;
  paintWait();
  const lim = limitLine(PICK.asset, PICK.dir);
  $('#bt-limit').textContent = lim;
  $('#bt-limit').hidden = !lim;
  const want = `#${PICK.asset}${PICK.dir === 'out' ? '/out' : ''}`;
  if (location.hash !== want && !(want === '#tac' && !location.hash)) history.replaceState(null, '', want);
}

function wireTile() {
  $('#bt-assets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-asset]');
    if (!b) return;
    PICK.asset = b.dataset.asset;
    if (!ROUTES[PICK.asset].out) PICK.dir = 'in';
    paintTile();
  });
  $('#bt-assets').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const keys = Object.keys(ROUTES), i = keys.indexOf(PICK.asset);
    PICK.asset = keys[(i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
    if (!ROUTES[PICK.asset].out) PICK.dir = 'in';
    paintTile();
    $(`#bt-assets [data-asset="${PICK.asset}"]`).focus();
  });
  $('#bt-flip').addEventListener('click', () => {
    if (!ROUTES[PICK.asset].out) return;
    PICK.dir = PICK.dir === 'in' ? 'out' : 'in';
    paintTile();
  });
  addEventListener('hashchange', () => { readHash(); paintTile(); });
}

// ── your bridges: every bridge this browser has under way, from the front page's journals ───────────────────────────────
let ROWS = [];

function rowHtml(r) {
  const a = ROUTES[r.asset] || ROUTES.tac;
  const nx = nextOf(r), live = liveLine(r, LIVE);
  const to = r.dir === 'in' ? 'to Ethereum' : 'to Bitcoin';
  const ticks = r.steps.map((s, i) => `<i class="${i < r.at ? 'y' : i === r.at && !r.done ? 'now' : ''}" title="${esc(s)}"></i>`).join('');
  // the last step it has done (the bar shows the one it is on)
  const where = r.done ? 'Arrived' : r.back ? 'Moved back to your Bitcoin address' : r.held ? 'Waiting for you' : r.at > 0 ? r.steps[r.at - 1] : 'Started';
  const act = nx.due
    ? `<a class="mb-due" href="${r.href}">${esc(nx.due)} <span aria-hidden="true">→</span></a>`
    : r.done || r.back ? '' : nx.self ? '<span class="mb-self">Goes on by itself</span>'
    : `<a class="mb-open" href="${r.href}">Open to move it on <span aria-hidden="true">→</span></a>`;
  const links = [
    r.btcTx ? `<a href="https://mempool.space/tx/${r.btcTx}" target="_blank" rel="noopener">Bitcoin tx</a>` : '',
    r.ethTx ? `<a href="https://etherscan.io/tx/${r.ethTx}" target="_blank" rel="noopener">Ethereum tx</a>` : '',
  ].filter(Boolean).join('');
  return `<li class="mb${r.done ? ' done' : ''}${nx.due ? ' due' : ''}" data-dir="${r.dir}">
    <svg class="tk" aria-hidden="true"><use href="#${a.icon}"/></svg>
    <div class="mb-m">
      <div class="mb-t"><b class="num">${fmtAmount(r.amount, a.dp)} ${a.ticker}</b><span>${to}</span><small>${r.since ? ago(r.since) : ''}</small></div>
      <div class="mb-r" role="img" aria-label="${esc(where)}">${ticks}</div>
      <div class="mb-w"><span>${esc(where)}</span>${live ? `<span class="mb-live">${esc(live)}</span>` : ''}</div>
    </div>
    <div class="mb-a">${act}${links ? `<span class="mb-x">${links}</span>` : ''}</div>
  </li>`;
}

function paintMine() {
  const box = $('#mine');
  box.hidden = ROWS.length === 0;
  if (!ROWS.length) return;
  const due = ROWS.filter((r) => nextOf(r).due).length;
  $('#mine-n').textContent = due ? `${due} need${due === 1 ? 's' : ''} you` : `${ROWS.filter((r) => !r.done && !r.back).length || 'none'} under way`;
  $('#mine-l').innerHTML = ROWS.map(rowHtml).join('');
}

function readMine() {
  let rows = [];
  try { rows = readBridges(localStorage); } catch { rows = []; }
  const sig = JSON.stringify(rows.map((r) => [r.id, r.stage, r.due, r.at]));
  const changed = sig !== readMine.sig;
  readMine.sig = sig;
  ROWS = rows;
  if (changed) paintMine();
  return changed;
}

// ── the walk-through: steppers that play when they are seen, and a press picks a step ───────────────────────────────────
function wireSteppers() {
  for (const fig of $$('[data-stepper]')) {
    // the list of steps sits beside the drawing, in the same section
    const steps = $$(`.st-l[data-for="${fig.dataset.for}"] [data-step]`, fig.closest('section'));
    const n = steps.length;
    let at = 0, timer = null, held = false;
    const show = (i) => {
      at = (i + n) % n;
      fig.dataset.at = String(at);
      steps.forEach((s, j) => s.setAttribute('aria-current', j === at ? 'step' : 'false'));
      $$('[data-on]', fig).forEach((g) => g.classList.toggle('on', g.dataset.on.split(' ').includes(String(at))));
      $$('[data-upto]', fig).forEach((g) => g.classList.toggle('on', Number(g.dataset.upto) <= at));
    };
    const play = () => { if (reduce || held || timer) return; timer = setInterval(() => show(at + 1), 2600); };
    const stop = () => { clearInterval(timer); timer = null; };
    steps.forEach((s, j) => {
      s.addEventListener('click', () => { held = true; stop(); show(j); });
      s.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); held = true; stop(); show(j); } });
    });
    show(0);
    new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? play() : stop())), { threshold: 0.35 }).observe(fig);
  }
}

// The note: one commitment format on both chains; a bridge burns one note and mints a fresh one of the same value.
function wireNote() {
  const fig = $('#note-fig');
  if (!fig) return;
  const set = (side) => {
    fig.dataset.side = side;
    $$('[data-side]', fig).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === side)));
  };
  $$('button[data-side]', fig).forEach((b) => b.addEventListener('click', () => set(b.dataset.side)));
  set('btc');
  if (!reduce) {
    let t = null;
    new IntersectionObserver((es) => es.forEach((e) => {
      clearInterval(t);
      if (e.isIntersecting) t = setInterval(() => { if (!fig.matches(':hover,:focus-within')) set(fig.dataset.side === 'btc' ? 'eth' : 'btc'); }, 3200);
    }), { threshold: 0.4 }).observe(fig);
  }
}

// Burn, prove, mint: one switch turns the drawing and its words to the other way.
function wireMoves() {
  const fig = $('#mv'), caps = $('.mvc');
  if (!fig) return;
  const set = (dir) => {
    fig.dataset.dir = dir;
    if (caps) caps.dataset.dir = dir;
    $('#mv-a').setAttribute('href', dir === 'in' ? '#tk-btc' : '#tk-eth');
    $('#mv-b').setAttribute('href', dir === 'in' ? '#tk-eth' : '#tk-btc');
    $$('#mv-dir button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dir === dir)));
  };
  $$('#mv-dir button').forEach((b) => b.addEventListener('click', () => set(b.dataset.dir)));
  set('in');
}

// Under the hood: one switch shows the way in or the way out, its steps and its drawing.
function wireHood() {
  const box = $('#hood');
  if (!box) return;
  const set = (dir) => {
    $$('[data-hood], [data-hood-fig]', box).forEach((e) => { e.hidden = (e.dataset.hood || e.dataset.for) !== dir; });
    $$('#hood-dir button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dir === dir)));
  };
  $$('#hood-dir button').forEach((b) => b.addEventListener('click', () => set(b.dataset.dir)));
}

// Who checks what: a press on a hop names who checks it.
function wireChecks() {
  const box = $('#ck');
  if (!box) return;
  const pick = (k) => {
    $$('[data-ck]', box).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ck === k)));
    $$('[data-ckp]', box).forEach((p) => { p.hidden = p.dataset.ckp !== k; });
  };
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-ck]'); if (b) pick(b.dataset.ck); });
  pick($('[data-ck]', box).dataset.ck);
}

function revealOnScroll() {
  const els = $$('.rv');
  if (reduce || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -12% 0px' });
  els.forEach((e) => io.observe(e));
}

// The live picture of both chains kept in step, drawn when it comes near.
function mountLive() {
  const host = $('#live-v');
  if (!host || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    io.disconnect();
    import('/weld/flow/viz.js?cb=154b32e7').then((m) => m.mountFlow(host, {})).catch(() => { $('#live').hidden = true; });
  }, { rootMargin: '400px' });
  io.observe(host);
}

// ── start ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
readHash();
wireTile();
paintTile();
readMine();
wireSteppers();
wireNote();
wireMoves();
wireHood();
wireChecks();
// On a narrow screen a wide drawing scrolls inside its frame: it opens on its middle, where the proof is.
const centre = () => $$('.fig.big').forEach((f) => { if (f.scrollWidth > f.clientWidth) f.scrollLeft = (f.scrollWidth - f.clientWidth) / 2; });
centre();
addEventListener('resize', centre);
// Motion runs only where it can be seen. The tile, the proof lines, the bridges list and each drawing run their animations (CSS and
// SVG) while they are in view in a visible tab, and hold still otherwise; a reader who asks for less motion gets none of it.
function gateMotion() {
  document.documentElement.classList.add('m');
  const els = $$('.fig, #bt, .pf, #mine'), seen = new Map();
  const apply = (el) => {
    const on = !!seen.get(el) && !document.hidden && !reduce;
    el.dataset.run = on ? '1' : '0';
    for (const s of el.matches('svg') ? [el] : $$('svg', el)) { try { on ? s.unpauseAnimations() : s.pauseAnimations(); } catch { /* not an SVG root */ } }
  };
  if (!('IntersectionObserver' in window)) { els.forEach((el) => { seen.set(el, true); apply(el); }); return; }
  const io = new IntersectionObserver((es) => { for (const e of es) { seen.set(e.target, e.isIntersecting); apply(e.target); } }, { rootMargin: '60px' });
  els.forEach((el) => io.observe(el));
  document.addEventListener('visibilitychange', () => els.forEach(apply));
}
gateMotion();
revealOnScroll();
mountLive();

async function tick() {
  await readProofs().catch(() => {});
  await readTxs(ROWS);
  paintMine();
  paintTile();
}
tick();
readSupply();
setInterval(() => { if (!document.hidden) tick(); }, 60e3);
// The front page writes its journals as it moves a bridge on; another tab's write arrives here at once.
addEventListener('storage', (e) => { if (!e.key || /^tacit-(burndep|crossout)-bridge-v1:/.test(e.key)) readMine(); });
setInterval(() => { if (!document.hidden) readMine(); }, 5e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - LIVE.at > 60e3) tick(); });
