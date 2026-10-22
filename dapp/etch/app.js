// tacit.finance/etch: an asset made on Bitcoin, and a search of the ones that exist. Create takes a ticker and a supply (a name, a logo and a link are optional)
// and etches it from the Tacit key the visitor opens; Discover searches the registry. tacit.js and the key come in when the visitor first touches the form
// (/trade/btc.js signs them in), not before. The asset is the key's own the moment the reveal is sent, so the front page's wallet lists it as it lists TAC.
import { $, esc, fmtUnits, parseUnits, short } from '/trade/util.js?cb=509d6618';
import { day } from '/trade/fmt.js?cb=c07717c4';
import { loadAssets, readNames, search } from '/etch/find.js?cb=32a2e96a';

const BTC_MODULE = '/trade/btc.js?cb=14765f1e';
const API = 'https://api.tacit.finance', MEMPOOL = 'https://mempool.space', SCAN = 'https://www.tacitscan.io';
const MAX_BASE = (1n << 64n) - 1n, DECIMALS = [0, 2, 6, 8];
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']), LOGO_MAX = 2 * 1024 * 1024;
const PAGE = 30;
const sats = (n) => Math.round(n).toLocaleString('en-US');

const S = { tab: 'create', dec: 8, logo: null, quote: null, busy: false, done: null, soft: '', assets: null, failed: false, named: false, shown: PAGE, open: null };
let bitcoin = null, T = null, laneP = null, quoteKey = '', quoteTimer = 0, warmed = false;
const ui = { tk: $('#tk'), sup: $('#sup'), dec: $('#dec'), nm: $('#nm'), ds: $('#ds'), ln: $('#ln'), pub: $('#pub'), mint: $('#mint'), lg: $('#lg'), find: $('#find'), list: $('#list') };

const live = (t) => { $('#live').textContent = t; };
// A line the visitor must read stays (a progress step, an error) until the next thing they do; the one about sats follows the balance and goes when it is met.
const put = (h, cls = '') => { const q = $('#q'); q.className = `q${cls ? ` ${cls}` : ''}`; q.innerHTML = h; };
const say = (h, cls = '') => { S.soft = ''; put(h, cls); };
const notify = (m, kind) => { live(m); say(esc(m), kind === 'error' ? 'err' : ''); };

// ── marks: a logo where there is one, else the ticker's first letters on a colour taken from the id ──
const hue = (s) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const letters = (t) => String(t || '?').slice(0, 2).toUpperCase();
const colour = (s) => `hsl(${hue(s)} 38% 48%)`;
function paintMark(node, ticker, id, url) {
  node.hidden = !ticker && !url;
  node.textContent = url ? '' : letters(ticker);
  node.style.setProperty('--c', colour(id || ticker));
  node.style.backgroundImage = url ? `url("${url}")` : '';
  node.style.backgroundSize = 'cover'; node.style.backgroundPosition = 'center';
}
const markHtml = (a) => (a.logo
  ? `<img class="tk" src="${esc(a.logo)}" alt="" loading="lazy" decoding="async" data-l="${esc(letters(a.ticker))}" data-c="${colour(a.id)}">`
  : `<span class="tk letter" style="--c:${colour(a.id)}">${esc(letters(a.ticker))}</span>`);

// ── the key and tacit.js, loaded when the form is first touched ──
function lane() {
  return (laneP ||= (async () => {
    const m = await import(BTC_MODULE);
    bitcoin = m.makeBitcoin({ notify, onChange: () => { paint(); needQuote(); } });
    T = await bitcoin.session.load();
    return bitcoin;
  })().catch((e) => { laneP = null; throw e; }));
}
function warm() {
  if (warmed) return;
  warmed = true;
  const t = $('#warm');
  if (t) document.head.append(t.content.cloneNode(true));
  lane().then(() => { paint(); needQuote(); }, () => {});
}

// ── Create ──
function read() {
  const ticker = ui.tk.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (ui.tk.value !== ticker) ui.tk.value = ticker;
  const raw = ui.sup.value.trim();
  let base = null, err = '';
  if (raw) {
    base = parseUnits(raw, S.dec);
    if (base == null) err = parseUnits(raw, 18) != null ? (S.dec ? `Up to ${S.dec} decimals` : 'Whole numbers only') : 'Enter a number';
    else if (base <= 0n) { base = null; err = 'More than zero'; }
    else if (base > MAX_BASE) { base = null; err = `At most ${fmtUnits(MAX_BASE, S.dec, S.dec)}`; }
  }
  const link = ui.ln.value.trim();
  return { ticker, tickerOk: /^[A-Z0-9]{1,8}$/.test(ticker), base, supplyOk: base != null, err, linkOk: !link || /^https:\/\//i.test(link) };
}
const wantsPin = () => !!(ui.nm.value.trim() || ui.ds.value.trim() || ui.ln.value.trim() || ui.pub.checked);

function needQuote() {
  const r = read();
  if (!T || !r.tickerOk) return;
  const pin = wantsPin(), key = `${r.ticker.length}|${pin ? 1 : 0}|${S.logo ? 1 : 0}`;
  if (key === quoteKey) return;
  quoteKey = key;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    try {
      const q = await T.etchQuote({ tickerLen: r.ticker.length, imageUri: S.logo?.uri || null, pin });
      if (quoteKey === key) { S.quote = q; paint(); }
    } catch { if (quoteKey === key) quoteKey = ''; }
  }, 150);
}

function goState(r) {
  const unlocked = !!bitcoin?.session.unlocked, mine = bitcoin?.me?.sats;
  if (S.busy) return ['Etching…', true];
  if (!unlocked) return ['Open your Tacit wallet', false];
  if (!r.tickerOk) return ['Enter a ticker', true];
  if (!r.supplyOk) return ['Enter a supply', true];
  if (!r.linkOk) return ['The link starts with https://', true];
  if (S.quote && mine != null && mine < S.quote.need) return ['Add sats', false];
  return [`Etch ${r.ticker}`, false];
}

function paint() {
  const r = read(), unlocked = !!bitcoin?.session.unlocked, mine = bitcoin?.me?.sats;
  ui.tk.classList.toggle('long', ui.tk.value.length > 6);
  ui.sup.classList.toggle('long', ui.sup.value.length > 12); ui.sup.classList.toggle('longer', ui.sup.value.length > 17);
  paintMark($('#mark'), r.tickerOk ? r.ticker : '', r.ticker, S.logo?.url);
  $('#unit').textContent = r.tickerOk ? r.ticker : '';
  $('#sup-note').textContent = r.err;
  for (const b of ui.dec.querySelectorAll('[data-d]')) b.setAttribute('aria-pressed', String(Number(b.dataset.d) === S.dec));
  const used = r.tickerOk && S.assets ? S.assets.filter((a) => a.ticker.toLowerCase() === r.ticker.toLowerCase()).length : 0;
  $('#tk-note').innerHTML = used ? `<button class="link" type="button" data-find="${esc(r.ticker)}">${used === 1 ? '1 asset uses' : `${used} assets use`} ${esc(r.ticker)}</button>` : '';
  const rc = $('#rcpt');
  rc.hidden = !(r.tickerOk && r.supplyOk);
  if (!rc.hidden) {
    const rows = [['Supply', `${fmtUnits(r.base, S.dec, S.dec)} ${esc(r.ticker)}`], ['Network fee', S.quote ? `about ${sats(S.quote.fee)} sats` : '…']];
    if (unlocked && mine != null) rows.push(['In your wallet', `${sats(mine)} sats`, S.quote && mine < S.quote.need ? 'warn' : '']);
    rc.innerHTML = rows.map(([k, v, c]) => `<div><dt>${k}</dt><dd${c ? ` class="${c}"` : ''}>${v}</dd></div>`).join('');
  }
  const [label, off] = goState(r), go = $('#go');
  go.textContent = label; go.disabled = off;
  const needMore = !S.busy && S.quote && unlocked && mine != null && mine < S.quote.need && r.tickerOk && r.supplyOk;
  const soft = needMore ? `Needs about ${sats(S.quote.need)} sats at your wallet’s address. It holds ${sats(mine)}.` : '';
  if (soft !== S.soft) { if (soft || S.soft) put(soft); S.soft = soft; }
}

async function act() {
  if (S.busy) return;
  try {
    const b = await lane();
    if (typeof T.etchAsset !== 'function') throw new Error('the wallet library served to this browser is older than the page: reload in a minute');
    if (!b.session.unlocked) { say(''); await b.signIn(); paint(); return; }
    const r = read();
    if (!r.tickerOk || !r.supplyOk || !r.linkOk) return;
    S.quote = await T.etchQuote({ tickerLen: r.ticker.length, imageUri: S.logo?.uri || null, pin: wantsPin() });
    if (b.me?.sats != null && b.me.sats < S.quote.need) {
      await b.refresh();
      if (b.me?.sats != null && b.me.sats < S.quote.need) { paint(); b.fund(); return; }
    }
    await etch(r);
  } catch (e) {
    if (e?.unlockCancelled) return;
    say(esc(e?.message || String(e)), 'err');
  }
}

async function etch(r) {
  let reached = '';
  S.busy = true; paint();
  say('Proving the supply…');
  try {
    const out = await T.etchAsset({
      ticker: r.ticker, supply: r.base, decimals: S.dec, name: ui.nm.value, description: ui.ds.value, externalUrl: ui.ln.value,
      imageUri: S.logo?.uri || null, mintable: ui.mint.checked, publishSupply: ui.pub.checked,
      onProgress: (st) => { reached = st; say(st === 'commit-start' ? 'Sending the first transaction…' : st === 'reveal-start' ? 'Sending the second…' : 'Proving the supply…'); },
    });
    S.done = { ...out, ticker: r.ticker, base: r.base, dec: S.dec, logo: S.logo?.url || null };
    bitcoin.refresh().catch(() => {});
    showDone();
  } catch (e) {
    const m = esc(e?.message || String(e));
    say(reached === 'reveal-start' ? `The first transaction went out and the second did not: ${m}` : m, 'err');
  } finally { S.busy = false; paint(); }
}

function showDone() {
  const d = S.done, done = $('#done');
  done.innerHTML = `<span class="tk letter" id="d-mark"></span>
    <h2>${esc(d.ticker)} <em>is etched</em></h2>
    <div class="kvs">
      <div class="kv"><span>Asset ID</span><b><code>${esc(short(d.assetIdHex, 6))}</code> <button class="link" type="button" data-copy="${esc(d.assetIdHex)}">Copy</button></b></div>
      <div class="kv"><span>Supply</span><b>${esc(fmtUnits(d.base, d.dec, d.dec))} ${esc(d.ticker)}${d.supplyPublished ? '' : ' · private'}</b></div>
      <div class="kv"><span>Transactions</span><b><a href="${MEMPOOL}/tx/${esc(d.commitTxid)}" target="_blank" rel="noopener noreferrer">commit</a> · <a href="${MEMPOOL}/tx/${esc(d.revealTxid)}" target="_blank" rel="noopener noreferrer">reveal</a></b></div>
    </div>
    <a class="btn" href="/#bitcoin">See it in your wallet</a>
    <button class="btn ghost" type="button" id="again">Etch another</button>
    <p class="q">Discover lists it once Bitcoin confirms it.</p>`;
  paintMark($('#d-mark'), d.ticker, d.assetIdHex, d.logo);
  $('#edit').hidden = true; $('.act').hidden = true; done.hidden = false;
  $('#again').onclick = reset;
  $('#again').focus();
}
function reset() {
  if (S.logo) URL.revokeObjectURL(S.logo.url);
  S.done = null; S.logo = null;
  for (const k of ['tk', 'sup', 'nm', 'ds', 'ln']) ui[k].value = '';
  ui.pub.checked = true; ui.mint.checked = false;
  lgSay(''); $('#lg-x').hidden = true; paintMark($('#lg-mark'), '', '', null);
  quoteKey = ''; say('');
  $('#done').hidden = true; $('#edit').hidden = false; $('.act').hidden = false;
  paint(); needQuote();
  ui.tk.focus();
}

// ── the logo: pinned to IPFS through the API, then named in the envelope by its CID ──
const lgSay = (t, err = false) => { const s = $('#lg-s'); s.textContent = t; s.style.color = err ? 'var(--err)' : ''; };
ui.lg.addEventListener('change', async () => {
  const f = ui.lg.files && ui.lg.files[0];
  ui.lg.value = '';
  if (!f) return;
  if (!LOGO_TYPES.has(f.type)) return lgSay('PNG, JPEG or WebP', true);
  if (f.size > LOGO_MAX) return lgSay('2 MB at most', true);
  lgSay('Uploading…');
  const url = URL.createObjectURL(f);
  try {
    const fd = new FormData();
    fd.append('file', f);
    const r = await fetch(`${API}/pin`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30e3) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.cid) throw new Error(j.error || `the upload failed (${r.status})`);
    if (S.logo) URL.revokeObjectURL(S.logo.url);
    S.logo = { uri: `ipfs://${j.cid}`, url };
    lgSay(''); $('#lg-x').hidden = false; paintMark($('#lg-mark'), '', '', url);
    paint(); needQuote();
  } catch (e) { URL.revokeObjectURL(url); lgSay(e?.message || 'The upload failed', true); }
});
$('#lg-x').addEventListener('click', () => {
  if (S.logo) URL.revokeObjectURL(S.logo.url);
  S.logo = null; $('#lg-x').hidden = true; paintMark($('#lg-mark'), '', '', null); lgSay('');
  paint(); needQuote();
});

// ── Discover ──
const ageOf = (a) => (a.at ? day(a.at) : '');
function row(a) {
  const sup = a.supply != null ? `${fmtUnits(a.supply, a.decimals, Math.min(a.decimals, 4))}` : null;
  const note = a.later ? 'Ticker used by an earlier asset' : [a.mintable ? 'Mintable' : '', ageOf(a)].filter(Boolean).join(' · ');
  return `<li class="as" data-id="${a.id}"><button class="as-b" type="button" aria-expanded="${S.open === a.id}">${markHtml(a)}
    <span class="as-t"><span class="as-n"><b>${esc(a.ticker)}</b>${a.verified ? '<i class="vf" title="On Tacit’s list of official assets">✓</i>' : ''}${a.name ? `<small>${esc(a.name)}</small>` : ''}</span><small>${esc(note)}</small></span>
    <span class="as-v num">${sup != null ? esc(sup) : '<small>Supply private</small>'}<small>${a.holders ? `${a.holders} holder${a.holders === 1 ? '' : 's'}` : ''}</small></span></button>
    <div class="as-d"${S.open === a.id ? '' : ' hidden'}>${S.open === a.id ? details(a) : ''}</div></li>`;
}
function details(a) {
  return `<div class="kv"><span>Asset ID</span><b><code>${a.id}</code> <button class="link" type="button" data-copy="${a.id}">Copy</button></b></div>
    ${a.at ? `<div class="kv"><span>Etched</span><b>${esc(day(a.at))}</b></div>` : ''}
    <div class="links"><a href="${SCAN}/assets/${a.id}" target="_blank" rel="noopener noreferrer">tacitscan ↗</a>${a.etchTxid ? `<a href="${MEMPOOL}/tx/${a.etchTxid}" target="_blank" rel="noopener noreferrer">Etch transaction ↗</a>` : ''}</div>`;
}
const skeleton = `<li class="sks" aria-hidden="true"><span class="sk" style="width:62%"></span><span class="sk" style="width:48%"></span><span class="sk" style="width:55%"></span><span class="sk" style="width:40%"></span></li>`;
function paintList() {
  const cnt = $('#cnt'), more = $('#more-r'), fq = $('#find-q');
  fq.textContent = '';
  if (!S.assets) {
    more.hidden = true; cnt.textContent = '';
    if (S.failed) { ui.list.innerHTML = ''; fq.className = 'q err'; fq.innerHTML = 'Could not load the assets. <button class="link" type="button" id="retry">Try again</button>'; $('#retry').onclick = () => { S.failed = false; openFind(); }; }
    else ui.list.innerHTML = skeleton;
    return;
  }
  const term = ui.find.value.trim(), hits = search(S.assets, term), shown = hits.slice(0, S.shown);
  cnt.textContent = term ? `${hits.length} found` : `${hits.length} asset${hits.length === 1 ? '' : 's'}`;
  ui.list.innerHTML = shown.length ? shown.map(row).join('') : `<li class="empty">Nothing matches “${esc(term)}”.</li>`;
  more.hidden = hits.length <= shown.length;
}
let loading = null;
function ensureAssets() {
  if (S.assets) return Promise.resolve();
  return (loading ||= loadAssets().then((a) => { S.assets = a; S.failed = false; }, () => { S.failed = true; }).finally(() => { loading = null; }));
}
async function openFind(term) {
  if (term != null) ui.find.value = term;
  S.shown = PAGE;
  paintList();
  await ensureAssets();
  paintList(); paint();
  if (S.assets && !S.named) { S.named = true; readNames(S.assets, paintList).catch(() => {}); }
}
ui.find.addEventListener('input', () => { S.shown = PAGE; S.open = null; paintList(); keepUrl(); });
$('#more-r').addEventListener('click', () => { S.shown += PAGE; paintList(); });
ui.list.addEventListener('click', (e) => {
  const b = e.target.closest('.as-b');
  if (!b) return;
  const id = b.closest('.as').dataset.id;
  S.open = S.open === id ? null : id;
  paintList();
});
// a logo that does not load is a letter again
ui.list.addEventListener('error', (e) => {
  const i = e.target;
  if (i.tagName !== 'IMG' || !i.dataset.l) return;
  const s = document.createElement('span');
  s.className = 'tk letter'; s.style.setProperty('--c', i.dataset.c); s.textContent = i.dataset.l;
  i.replaceWith(s);
}, true);

// ── the two panels ──
function setTab(t, term = null) {
  S.tab = t;
  for (const [k, id] of [['create', 't-create'], ['find', 't-find']]) { const b = $(`#${id}`); b.setAttribute('aria-selected', String(k === t)); b.tabIndex = k === t ? 0 : -1; }
  $('.sw-h').style.setProperty('--i', t === 'find' ? 1 : 0);
  $('#p-create').hidden = t !== 'create'; $('#p-find').hidden = t !== 'find';
  if (t === 'find') openFind(term);
  keepUrl();
}
function keepUrl() {
  const q = ui.find.value.trim(), h = S.tab === 'find' ? `#discover${q ? `=${encodeURIComponent(q)}` : ''}` : '';
  try { history.replaceState(null, '', location.pathname + location.search + h); } catch { /* the address is a convenience */ }
}
function readUrl() {
  let h = '';
  try { h = decodeURIComponent(location.hash.slice(1)); } catch { /* an unreadable address opens Create */ }
  return h.startsWith('discover') ? { tab: 'find', term: h.slice(9) } : { tab: 'create', term: null };
}
$('#t-create').addEventListener('click', () => setTab('create'));
$('#t-find').addEventListener('click', () => setTab('find'));
$('.sw-h').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const t = S.tab === 'create' ? 'find' : 'create';
  setTab(t); $(`#t-${t}`).focus();
});
addEventListener('hashchange', () => { const u = readUrl(); if (u.tab !== S.tab || u.term != null) setTab(u.tab, u.term); });

// ── events ──
ui.dec.innerHTML = `<span>Decimals</span>${DECIMALS.map((d) => `<button type="button" data-d="${d}" aria-pressed="false">${d}</button>`).join('')}`;
$('#form').addEventListener('submit', (e) => { e.preventDefault(); act(); });
$('#form').addEventListener('input', () => { warm(); if (!S.busy && !S.soft) say(''); paint(); needQuote(); });
$('#form').addEventListener('pointerenter', warm, { once: true, passive: true });
$('#form').addEventListener('focusin', warm, { once: true });
$('#more').addEventListener('toggle', warm);
ui.dec.addEventListener('click', (e) => {
  const b = e.target.closest('[data-d]');
  if (!b) return;
  S.dec = Number(b.dataset.d); paint();
});
document.addEventListener('click', (e) => {
  const f = e.target.closest('[data-find]');
  if (f) { setTab('find', f.dataset.find); return; }
  const c = e.target.closest('[data-copy]');
  if (c) navigator.clipboard?.writeText(c.dataset.copy).then(() => { c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1500); }, () => { c.textContent = 'Could not copy'; });
});
addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });

// the registry is read at once so a ticker already in use is said while it is typed
ensureAssets().then(paint);
const u = readUrl();
paint();
if (u.tab === 'find') setTab('find', u.term);
