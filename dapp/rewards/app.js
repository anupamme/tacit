// Airdrop and points for one account: a 0x address, or a .eth, .wei or .gwei name that points to one. All of it is read and nothing is sent;
// a claim goes through the dapp, where the account connects (the links below), so this page never asks for a wallet.
//
// A lookup starts as soon as what is typed can be one (a whole address, or a whole name after a short pause), the airdrop and the points each
// draw as their own reading arrives, and what was read is kept for a minute, so asking again is instant. The hosts it reads are connected
// while the person types (the page's preconnect links), and the leaderboard, which gives the rank, is fetched once and shared.
import { secp, keccak_256 } from '/vendor/tacit-deps.min.js';
import { makeConfidentialNames, makeMainnetCall, MAINNET_RPCS, NameError } from '/confidential-names.js?cb=7bb10833';
import { makeTacAirdrop, makeRpcCall } from '/tac-airdrop.js?cb=02ef61b4';

const API = 'https://api.tacit.finance', DISTRIBUTOR = '0x000000C918e44A3a443937fA7594eA4f7C95D6b9', BOARD = 500, KEEP = 60e3, RECENT = 'tacit-rewards-recent-v1';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const names = makeConfidentialNames({ call: makeMainnetCall({}), secp, keccak256: keccak_256 });
const call = makeRpcCall({ rpcs: MAINNET_RPCS });
const air = makeTacAirdrop({ call, keccak256: keccak_256 });
const within = (s) => (s && AbortSignal.any ? AbortSignal.any([s, AbortSignal.timeout(20e3)]) : AbortSignal.timeout(20e3));
const get = (path, signal) => fetch(`${API}/${path}`, { signal: within(signal) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* a convenience */ } } };

// An amount of TAC (18 decimals) to `dp` places, grouped, trailing zeros dropped; under the smallest place it says so.
function tac(wei, dp = 2) {
  const v = BigInt(wei), unit = 10n ** BigInt(18 - dp), r = (v + unit / 2n) / unit;
  if (v > 0n && r === 0n) return `< ${(0.1 ** dp).toFixed(dp)}`;
  const s = r.toString().padStart(dp + 1, '0'), int = s.slice(0, s.length - dp), frac = s.slice(s.length - dp).replace(/0+$/, '');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
}
const day = (sec) => new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// EIP-55: an address in mixed case has to match its checksum; one in a single case carries none.
function checksumOk(a) {
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const h = Array.from(keccak_256(new TextEncoder().encode(body.toLowerCase())), (x) => x.toString(16).padStart(2, '0')).join('');
  return [...body.toLowerCase()].every((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c) === body[i]);
}

// What was read, kept for a minute by what was asked: a second look at the same name or address costs nothing, and a read still under way is shared.
const kept = new Map();
function keep(key, make) {
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEEP) return hit.p;
  const p = make();
  kept.set(key, { at: Date.now(), p });
  p.then((v) => { if (v == null || v.reason === 'error' || v.error) kept.delete(key); }, () => kept.delete(key));
  return p;
}

// Who was asked for: the address, and the name it came from when it was a name. Throws what the person should read.
function identify(raw) {
  const s = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    if (!checksumOk(s)) throw new Error('That address has a bad checksum. Check it for typos.');
    return Promise.resolve({ address: s.toLowerCase(), name: null });
  }
  if (/^\S+\.\S+$/.test(s)) {
    const n = s.toLowerCase();
    return keep(`name:${n}`, async () => {
      let r;
      try { r = await names.resolveAddress(n); } catch (e) { throw new Error(e instanceof NameError ? e.message : 'Could not read that name just now. Try again.'); }
      if (!r) throw new Error(`${n} has no address set.`);
      return { address: r.address, name: r.name };
    });
  }
  throw new Error('Enter a 0x address, or a name ending in .eth, .wei or .gwei.');
}

// The points service's reading of the address, with what the distributor says it has paid out read at the same time (its own figure, not the
// service's copy): what can be claimed is the earned total less that, which is exactly what the distributor's owed() computes.
const claimedOn = (address) => call({ to: DISTRIBUTOR, data: `0xc884ef83${address.slice(2).padStart(64, '0')}` }).then(BigInt);
function readPoints(address, signal) {
  return keep(`points:${address}`, async () => {
    const [p, c, paid] = await Promise.all([get(`points/${address}`, signal), get(`claim/${address}`, signal), claimedOn(address).catch(() => null)]);
    if (!p) return { error: true };
    const earned = BigInt(c?.cumulativeAmount || 0), claimed = paid ?? BigInt(c?.claimedWei || 0);
    return { points: Number(p.points) || 0, earned, claimed, owed: c?.proof && earned > claimed ? earned - claimed : 0n, unread: paid === null && earned > 0n };
  });
}
const readAirdrop = (address) => keep(`airdrop:${address}`, () => air.status(address));

// The leaderboard gives the rank. It is fetched once, as soon as the page is idle, and shared by every lookup.
let boardP = null, boardAt = 0;
function board() {
  if (!boardP || Date.now() - boardAt > KEEP) {
    boardAt = Date.now();
    boardP = get(`leaderboard?limit=${BOARD}`).then((b) => { if (!Array.isArray(b)) boardP = null; return Array.isArray(b) ? b : null; });
  }
  return boardP;
}
const rankOf = (address) => board().then((b) => { const i = b ? b.findIndex((e) => String(e.address).toLowerCase() === address) : -1; return i >= 0 ? i + 1 : b && b.length >= BOARD ? 0 : null; });

// ── what is drawn ──
const card = (title, body) => `<section class="card"><h2>${title}</h2>${body}</section>`;
// A number that counts up to itself when it appears (not for someone who asks for less motion); its text is final from the start.
const figure = (n, text, unit) => `<p class="big num"><span class="cu" data-to="${n}" data-text="${esc(text)}">${esc(text)}</span><small>${unit}</small></p>`;
function airdropCard(s) {
  if (s.reason === 'error') return card('Airdrop', '<p class="st warn">Could not read the airdrop just now. Look up again in a moment.</p>');
  if (!s.eligible) return card('Airdrop', '<p class="big">—</p><p class="st mute">Not on the airdrop list.</p>');
  const left = Math.ceil((s.deadline - Date.now() / 1000) / 86400), by = day(s.deadline);
  const [cls, line] = s.claimed ? ['ok', 'Claimed'] : s.claimable ? [left <= 7 ? 'warn' : 'ok', `Claim by ${by} · ${left} day${left === 1 ? '' : 's'} left`] : s.reason === 'closed' ? ['mute', `Closed ${by}`] : ['warn', s.message];
  return card('Airdrop', `${figure(Number(s.amountTac), tac(s.amountWei), 'TAC')}<p class="st ${cls}">${esc(line)}</p>${s.claimable ? `<a class="act" href="/#airdrop">Claim ${tac(s.amountWei)} TAC</a>` : ''}`);
}
function pointsCard(p) {
  if (p.error) return card('Points', '<p class="st warn">Could not read points just now. Look up again in a moment.</p>');
  const rows = p.earned > 0n ? [['Earned on settled days', `${tac(p.earned)} TAC`], ['Claimed', `${tac(p.claimed)} TAC`], ['To claim', p.unread ? 'not read' : `${tac(p.owed)} TAC`]] : [];
  return card('Points', `${figure(Math.round(p.points), Math.round(p.points).toLocaleString('en-US'), 'points')}<p class="st mute" id="rank">${p.points <= 0 ? 'No points yet.' : ''}</p>`
    + (rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd class="num">${v}</dd></div>`).join('')}</dl>` : '')
    + (p.owed > 0n ? `<a class="act" href="/#points">Claim ${tac(p.owed)} TAC</a>` : ''));
}
const whoLine = (who, q) => `<p class="who"><b>${esc(who.name || short(who.address))}</b>${who.name ? `<span>${short(who.address)}</span>` : ''}</p>
  <p class="acts"><button type="button" data-copy="${who.address}">Copy address</button><a href="https://etherscan.io/address/${who.address}" target="_blank" rel="noopener noreferrer">Etherscan ↗</a><button type="button" data-copy="${esc(`${location.origin}/rewards/?q=${encodeURIComponent(q)}`)}" data-said="Link copied">Copy link</button></p>`;
const SKEL = (t) => `<section class="card"><h2>${t}</h2><p class="big"><span class="sk"></span></p></section>`;
const SKELETON = `<p class="who"><b><span class="sk"></span></b></p><div id="c-air">${SKEL('Airdrop')}</div><div id="c-pts">${SKEL('Points')}</div>`;

function countUp(el) {
  const to = Number(el.dataset.to), text = el.dataset.text;
  if (calm || !(to > 0)) { el.dataset.settled = '1'; return; }
  const t0 = performance.now(), ms = 650, dp = text.includes('.') ? text.split('.')[1].length : 0;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms), e = 1 - (1 - k) ** 3;
    el.textContent = k >= 1 ? text : (to * e).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    if (k < 1 && el.isConnected) requestAnimationFrame(step); else { el.textContent = text; el.dataset.settled = '1'; }
  };
  requestAnimationFrame(step);
}
function paint(sel, html) { const el = $(sel); if (!el) return; el.innerHTML = html; el.querySelectorAll('.cu').forEach(countUp); }

// ── the bar, its suggestions, and what was looked up before ──
const input = $('#q'), go = $('#go'), out = $('#out'), hints = $('#hints'), recent = $('#recent'), note = $('#note');
const said = (t) => { note.textContent = ''; setTimeout(() => { note.textContent = t; }, 30); };
const recents = () => { try { const l = JSON.parse(store.get(RECENT) || '[]'); return Array.isArray(l) ? l.filter((x) => typeof x === 'string').slice(0, 6) : []; } catch { return []; } };
const remember = (q) => store.set(RECENT, JSON.stringify([q, ...recents().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6)));
function showRecent() {
  const l = recents();
  recent.innerHTML = l.length && !out.innerHTML && !input.value.trim() ? `${l.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q.length > 22 ? short(q) : q)}</button>`).join('')}<button type="button" class="chip x" data-clear aria-label="Clear recent lookups">×</button>` : '';
}
// A bare name is offered under all three services.
function showHints(v) {
  hints.innerHTML = /^[a-z0-9][a-z0-9-]{1,62}$/i.test(v) && !/^0x/i.test(v) ? ['eth', 'wei', 'gwei'].map((t) => `<button type="button" class="chip" data-q="${esc(`${v.toLowerCase()}.${t}`)}">${esc(v.toLowerCase())}.${t}</button>`).join('') : '';
}

let seq = 0, ctl = null, last = '';
function clear() {
  seq++; ctl?.abort(); last = ''; out.innerHTML = ''; hints.innerHTML = ''; go.disabled = false;
  input.setAttribute('aria-invalid', 'false');
  try { history.replaceState(null, '', location.pathname); } catch { /* the address bar is a convenience */ }
  showRecent();
}
async function run(raw) {
  const q = raw.trim(), my = ++seq;
  ctl?.abort(); ctl = new AbortController();
  input.setAttribute('aria-invalid', 'false');
  if (!q) { clear(); return; }
  last = q; hints.innerHTML = ''; recent.innerHTML = ''; go.disabled = true; out.innerHTML = SKELETON;
  try {
    const who = await identify(q);
    if (my !== seq) return;
    remember(q);
    out.innerHTML = `${whoLine(who, q)}<div id="c-air">${SKEL('Airdrop')}</div><div id="c-pts">${SKEL('Points')}</div>`;
    try { history.replaceState(null, '', `?q=${encodeURIComponent(q)}`); } catch { /* the address bar is a convenience */ }
    const a = readAirdrop(who.address), p = readPoints(who.address, ctl.signal), r = rankOf(who.address);
    a.then((s) => { if (my === seq) paint('#c-air', airdropCard(s)); });
    p.then((v) => {
      if (my !== seq) return;
      paint('#c-pts', pointsCard(v));
      if (!v.error && v.points > 0) r.then((k) => { if (my === seq && $('#rank')) $('#rank').textContent = k > 0 ? `Rank #${k.toLocaleString('en-US')}` : k === 0 ? `Outside the top ${BOARD}` : ''; });
    });
    await Promise.allSettled([a, p]);
  } catch (e) {
    if (my !== seq) return;
    input.setAttribute('aria-invalid', 'true');
    out.innerHTML = `<p class="err" role="alert">${esc(e.message || 'Something went wrong. Try again.')}</p>`;
  } finally { if (my === seq) go.disabled = false; }
}

let pause = 0;
input.addEventListener('input', () => {
  clearTimeout(pause);
  const v = input.value.trim();
  showHints(v); showRecent();                                                   // what was looked up before is for an empty bar
  if (!v) { clear(); return; }
  if (v === last) return;
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) run(v);
  else if (/^\S+\.(eth|wei|gwei)$/i.test(v)) pause = setTimeout(() => { if (input.value.trim() === v && v !== last) run(v); }, 450);
});
input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; clear(); } });
document.addEventListener('keydown', (e) => { if (e.key === '/' && !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); input.focus(); input.select(); } });
$('#f').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(pause); run(input.value); });

// A suggestion or a recent lookup fills the bar and answers; a copy button copies and says so.
document.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-q]'), cp = e.target.closest('[data-copy]');
  if (chip) { input.value = chip.dataset.q; run(chip.dataset.q); return; }
  if (e.target.closest('[data-clear]')) { store.set(RECENT, '[]'); showRecent(); return; }
  if (cp) {
    const text = cp.dataset.copy, was = cp.textContent;
    try { await navigator.clipboard.writeText(text); } catch {
      const t = Object.assign(document.createElement('textarea'), { value: text }); document.body.append(t); t.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ } t.remove();
    }
    cp.textContent = 'Copied'; said(cp.dataset.said || 'Address copied'); setTimeout(() => { cp.textContent = was; }, 1400);
  }
});

const asked = new URLSearchParams(location.search).get('q');
if (asked) { input.value = asked; run(asked); } else { showRecent(); if (matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true }); }
// The rank's board is fetched once the page has nothing else to do.
(window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => { board(); });
