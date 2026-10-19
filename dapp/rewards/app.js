// What Tacit pays in TAC, in one place. Under the bar, for one account (a 0x address, or a .eth, .wei or .gwei name that points to one), what it
// has to claim: the airdrop, the points reward and what its farm stake has earned, with the claim of the first two when a browser wallet is on
// that account. Below it, the farms and the other ways to earn, whoever is looked up: the Precision farm opens in place (its form acts for the
// connected wallet), the private farms, the points program, the liquidity campaign and the tasks lead to their pages. Reading comes first and
// sends nothing; a claim is made only by the account itself, after the contract has been asked whether it would accept it (no wallet here: the
// claim is a link into the dapp; another account: a note says which to switch to).
//
// A lookup starts as soon as what is typed can be one (a whole address, or a whole name after a short pause), the airdrop and the points each
// draw as their own reading arrives, and what was read is kept for a minute, so asking again is instant. The hosts it reads are connected
// while the person types (the page's preconnect links), and the leaderboard, which gives the rank, is fetched once and shared. The ninja
// peeks over the bar and answers what a lookup found; a claim that lands rains TAC coins.
import { secp, keccak_256 } from '/vendor/tacit-deps.min.js';
import { makeConfidentialNames, makeMainnetCall, MAINNET_RPCS, NameError } from '/confidential-names.js?cb=9efdff52';
import { bodyType } from '/rpc-body.js';
import { makeTacAirdrop, makeRpcCall } from '/tac-airdrop.js?cb=04391ed8';
import { makeConnect, UserStopped } from '/trade/connect.js?cb=598b5a23';
import { TAC, POOL, FARM, POINTS, readPrecision, readStake, privateFarms, readLiquidity, readTasks } from '/rewards/earn.js?cb=bafce1da';

// Where an airdrop is never sent: the zero address and the contracts that would hold TAC with no way to give it back.
const NO_SEND = ['0x0000000000000000000000000000000000000000', '0xa1313eb9f3a445606d9583bcac3ebeb56a858279', '0x000000c918e44a3a443937fa7594ea4f7c95d6b9', '0x4b4cb98d0c836c2783ac46f0078b904dab533ae8'];
const API = 'https://api.tacit.finance', DISTRIBUTOR = '0x000000C918e44A3a443937fA7594eA4f7C95D6b9', BOARD = 500, KEEP = 60e3, RECENT = 'tacit-rewards-recent-v1';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const names = makeConfidentialNames({ call: makeMainnetCall({}), secp, keccak256: keccak_256 });
const call = makeRpcCall({ rpcs: MAINNET_RPCS });
const air = makeTacAirdrop({ call, keccak256: keccak_256 });
const within = (s) => (s && AbortSignal.any ? AbortSignal.any([s, AbortSignal.timeout(20e3)]) : AbortSignal.timeout(20e3));
const get = (path, signal) => fetch(`${API}/${path}`, { signal: within(signal) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* a convenience */ } } };
// The wallet, as on the swap page: the header chip, a picker when the browser has several wallets, WalletConnect's pairing for a phone, and the
// account sheet (which here also looks up the account and switches it). It is not restored until the page is idle.
const connect = makeConnect({
  describe: 'Farm TAC, and look up and claim the airdrop and points.',
  rewards: false,
  busy: () => claiming,
  say: (html, bad) => wsay(html, bad),
  onChange: () => onWallet(),
  rows: () => '<button class="btn ghost" type="button" data-mine-sheet>Look up this account</button><button class="btn ghost" type="button" data-switch-sheet>Switch account</button>',
  wire: (root, close) => {
    root.querySelector('[data-mine-sheet]').onclick = () => { close(); lookMine(); };
    root.querySelector('[data-switch-sheet]').onclick = () => { close(); switchAccount(); };
  },
  restore: false,
});
const { wallet, W } = connect;

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
      try { r = await names.resolveAddress(n); } catch (e) { throw new Error(e instanceof NameError ? e.message : 'Could not read that name. Try again.'); }
      if (!r) throw new Error(`${n} has no address set.`);
      return { address: r.address, name: r.name };
    });
  }
  throw new Error('Enter a 0x address, or a name ending in .eth, .wei or .gwei.');
}

// The points service's reading of the address, with what the distributor says it has paid out read at the same time (its own figure, not the
// service's copy): what can be claimed is the earned total less that, which is exactly what the distributor's owed() computes.
const claimedOn = (address) => call({ to: DISTRIBUTOR, data: `0xc884ef83${address.slice(2).padStart(64, '0')}` }).then(BigInt);
// The day's rate cap (the most TAC a point can earn), from the program the leaderboard carries; without it no TAC figure is given for today.
const capNow = () => keep('cap', () => get('leaderboard?day=today&limit=1').then((d) => {
  const c = (d?.program?.rateCap || []).filter((x) => x.fromDay <= d.day).sort((a, b) => b.fromDay - a.fromDay)[0];
  return d?.program ? { program: d.program, day: d.day, cap: c ? BigInt(c.maxWeiPerPoint) : null, programDay: d.programDay, programDays: d.programDays, settleAt: ((d.day + 1) * 86400 + (Number(d.program.settleGraceSecs) || 0)) * 1000 } : null;
}));
function readPoints(address, signal) {
  return keep(`points:${address}`, async () => {
    const [p, c, paid, prog] = await Promise.all([get(`points/${address}`, signal), get(`claim/${address}`, signal), claimedOn(address).catch(() => null), capNow().catch(() => null)]);
    if (!p) return { error: true };
    const earned = BigInt(c?.cumulativeAmount || 0), claimed = paid ?? BigInt(c?.claimedWei || 0);
    // Today: this account's points against everyone's, of the day's pot (at most the cap per point).
    const t = p.today, pts = Number(t?.points) || 0, all = Number(t?.totalPoints) || 0;
    let today = null;
    if (pts > 0 && all > 0) {
      const mp = BigInt(Math.round(pts * 1e6)), share = BigInt(t.dayBudgetWei || 0) * mp / BigInt(Math.round(all * 1e6));
      // The service's own figure when it gives one: with reserved budgets in force an address can be paid at its group's ceiling, which a share of the pot does not say.
      const own = t.tacWei != null && /^\d+$/.test(String(t.tacWei)) ? BigInt(t.tacWei) : null;
      today = { points: pts, pct: pts / all * 100, tac: own ?? (prog ? (prog.cap != null && mp * prog.cap / 1000000n < share ? mp * prog.cap / 1000000n : share) : null) };
    }
    return { points: Number(p.points) || 0, earned, claimed, owed: c?.proof && earned > claimed ? earned - claimed : 0n, unread: paid === null && earned > 0n, today, clock: prog && prog.programDay <= prog.programDays ? { day: prog.programDay, days: prog.programDays, settleAt: prog.settleAt } : null };
  });
}
const readAirdrop = (address) => keep(`airdrop:${address}`, () => air.status(address));

// The three Ethereum endpoints are asked a cheap question once the page is idle (and again on the bar's focus when that was a while ago), so
// their connections are open and the browser has their CORS preflights cached by the time a lookup needs them: the first call to a host
// otherwise costs two round trips, and a name is read from all three.
let primedAt = 0;
function prime() {
  if (Date.now() - primedAt < 300e3) return;
  primedAt = Date.now();
  for (const u of MAINNET_RPCS) fetch(u, { method: 'POST', headers: { 'content-type': bodyType(u) }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).catch(() => {});
}

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

// ── the ninja: it peeks over the bar, thinks while a lookup is read, and answers it ──
const ninja = $('#ninja'), emo = $('#emo');
let moodTimer = 0, winkTimer = 0;
function react(mood, ms = 3400) {
  clearTimeout(moodTimer); clearTimeout(winkTimer);
  ninja.classList.remove('wink');
  ninja.dataset.mood = mood;
  emo.classList.remove('pop');
  emo.textContent = { up: '👍', down: '👎' }[mood] || '';
  if (emo.textContent) { void emo.offsetWidth; emo.classList.add('pop'); }
  // A press winks at once; a thumbs up nods first, then winks.
  const wink = () => { ninja.classList.add('wink'); winkTimer = setTimeout(() => ninja.classList.remove('wink'), 650); };
  if (mood === 'wink') wink(); else if (mood === 'up') winkTimer = setTimeout(wink, 950);
  if (mood === 'idle' || mood === 'think') return;                                     // thinking lasts until the answer
  moodTimer = setTimeout(() => { ninja.dataset.mood = 'idle'; emo.textContent = ''; }, ms);
}
ninja.addEventListener('click', () => react('wink', 1600));

// ── what is drawn: "Your rewards", one panel with a row for each source ──
// A number that counts up to itself when it appears (not for someone who asks for less motion); its text is final from the start.
const figure = (n, text, unit) => `<p class="fig num"><span class="cu" data-to="${n}" data-text="${esc(text)}">${esc(text)}</span><small>${unit}</small></p>`;
// A row with nothing to show but a line (not on the list, could not be read).
const lone = (title, line, cls = 'mute') => `<div class="rw none"><h3>${title}</h3><p class="st ${cls}">${line}</p></div>`;
// A claim is made here when a browser wallet is present; without one it is the link into the dapp.
const claimUi = (kind, label, address, to, amount, wei) => (wallet.available().length
  ? `<button class="act" type="button" data-claim="${kind}" data-addr="${address}" data-amt="${esc(amount)}" data-wei="${wei}">${label}</button>`
  : `<a class="act" href="${to}">${label}</a>`);
// Sending the allocation to another address (a cold wallet, a Tacit account) instead of the one that claims: the form opens from a link.
const sendTo = (address, wei) => (wallet.available().length ? `<p class="to"><button class="linkbtn" type="button" data-to-show>Send it to another address</button></p>
  <form class="toform" id="to-f" hidden novalidate><label class="sr" for="to-q">Where to send it: an address or a .eth, .wei or .gwei name</label><input id="to-q" placeholder="0x address or name" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off"><button class="act" type="submit" data-claim="airdrop-to" data-addr="${address}" data-amt="${esc(tac(wei))}" data-wei="${wei}">Claim to this address</button></form>` : '');
function airdropRow(s, address) {
  if (s.reason === 'error') return lone('Airdrop', 'Could not read the airdrop. Try again in a moment.', 'warn');
  if (!s.eligible) return lone('Airdrop', 'Not on the airdrop list.');
  const left = Math.ceil((s.deadline - Date.now() / 1000) / 86400), by = day(s.deadline);
  const [cls, line] = s.claimed ? ['ok', 'Claimed'] : s.claimable ? [left <= 7 ? 'warn' : 'ok', `Claim by ${by} · ${left} day${left === 1 ? '' : 's'} left`] : s.reason === 'closed' ? ['mute', `Closed ${by}`] : ['warn', s.message];
  return `<div class="rw"><h3>Airdrop</h3>${figure(Number(s.amountTac), tac(s.amountWei), 'TAC')}<p class="st ${cls}">${esc(line)}</p>${s.claimable ? claimUi('airdrop', `Claim ${tac(s.amountWei)} TAC`, address, '/#airdrop', tac(s.amountWei), s.amountWei) + sendTo(address, s.amountWei) : ''}</div>`;
}
// Where the program is: its day, and when today's points can be claimed (the day's end and the service's grace after it).
function clockLine(c) {
  const at = new Date(c.settleAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `Day ${c.day} of ${c.days} · today’s points can be claimed after ${at} UTC`;
}
function pointsRow(p, address) {
  if (p.error) return lone('Points', 'Could not read points. Try again in a moment.', 'warn');
  const t = p.today, pct = t ? (t.pct < 0.01 ? t.pct.toFixed(4) : t.pct < 1 ? t.pct.toFixed(3) : t.pct.toFixed(2)) : '', pts = Math.round(p.points).toLocaleString('en-US');
  // The figure is what can be claimed; with nothing to claim yet it is the points themselves.
  const fig = p.owed > 0n ? figure(Number(p.owed) / 1e18, tac(p.owed), 'TAC') : figure(Math.round(p.points), pts, 'points');
  const kv = p.earned > 0n ? `<dl class="kv"><div><dt>Earned from finished days</dt><dd class="num">${tac(p.earned)} TAC</dd></div><div><dt>Claimed</dt><dd class="num">${tac(p.claimed)} TAC</dd></div><div><dt>To claim</dt><dd class="num">${p.unread ? 'unavailable' : `${tac(p.owed)} TAC`}</dd></div></dl>` : '';
  return `<div class="rw"><h3>Points</h3>${fig}<p class="st mute"><span>${p.points > 0 ? `${pts} points` : 'No points yet.'}</span><span id="rank"></span></p>`
    + (t ? `<p class="st mute">Today ${Math.round(t.points).toLocaleString('en-US')} points · ${pct}% of the day${t.tac != null ? ` · about ${tac(t.tac)} TAC` : ''}</p>` : '')
    + (p.claimed > 0n && p.owed <= 0n ? `<p class="st mute">${tac(p.claimed)} TAC claimed so far</p>` : '')
    + (p.points > 0 && p.clock ? `<p class="st mute clock">${clockLine(p.clock)}</p>` : '')
    + (p.owed > 0n ? claimUi('points', `Claim ${tac(p.owed)} TAC`, address, '/#points', tac(p.owed), p.owed) : '')
    + (p.points > 0 ? `<details class="fold x" data-days="${address}"><summary>Points by day</summary><div class="fold-b">${kv}<div class="days"></div><p class="more"><a href="/#points">Holding proof and more in the app →</a></p></div></details>` : '')
    + '</div>';
}
// What the account has in the Precision farm, when it has anything there: what it earned and what it holds. The farm itself is the row below.
let stakeOf = null;                                                                  // { address, stake, facts } for the account shown
function farmRow(address) {
  const m = stakeOf?.address === address ? stakeOf.stake : null, f = stakeOf?.facts;
  if (!m || (m.staked === 0n && m.earned === 0n && m.loose === 0n)) return '';
  const mine = !!W.account && W.account.toLowerCase() === address;
  const worth = m.staked > 0n ? `${eth4(m.eth)} ETH + ${tac(m.tac, 0)} TAC in the pool` : `${tac(m.loose, 4)} pool shares, not staked`;
  return `<div class="rw"><h3>Farm</h3>${figure(Number(m.earned) / 1e18, tac(m.earned, 4), 'TAC')}<p class="st mute">${esc(worth)}${f?.apr != null ? ` · ${aprText(f.apr)} APR` : ''}</p>`
    + `<button class="act" type="button" data-open-farm>${mine && m.earned > 0n ? 'Claim in the farm' : 'Open the farm'}</button></div>`;
}
// The total of what can be claimed, once every source has said (a source that could not be read counts as nothing).
let tot = { address: null, air: null, pts: null, farm: null };
function paintTotal() {
  if (!$('#tot') || tot.address !== out.dataset.address || [tot.air, tot.pts, tot.farm].some((v) => v == null)) return;
  const sum = tot.air + tot.pts + tot.farm;
  paint('#tot', sum > 0n ? `<b class="num">${esc(tac(sum))}</b>TAC to claim` : 'Nothing to claim yet');                // no count-up here: the line keeps its size
}
const whoLine = (who, q) => `<p class="who"><b>${esc(who.name || short(who.address))}</b>${who.name ? `<span>${short(who.address)}</span>` : ''}</p>
  <p class="acts"><button type="button" data-copy="${who.address}">Copy address</button><a href="https://etherscan.io/address/${who.address}" target="_blank" rel="noopener noreferrer">Etherscan ↗</a><button type="button" data-copy="${esc(`${location.origin}/rewards/?q=${encodeURIComponent(q)}`)}" data-said="Link copied">Copy link</button></p>
  <p class="wl" id="wl"></p>
  <div id="done" aria-live="polite"></div>`;
const SKEL = (t) => `<div class="rw ld"><h3>${t}</h3><p class="fig"><span class="sk"></span></p></div>`;
const YOURS = `<section class="card yours" id="yours"><div class="yh"><h2>Your rewards</h2><p class="tot" id="tot"></p></div><div id="c-air">${SKEL('Airdrop')}</div><div id="c-pts">${SKEL('Points')}</div><div id="c-farm"></div></section>`;
const SKELETON = `<p class="who"><b><span class="sk"></span></b></p>${YOURS}`;

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
function fillRank(address, p) {
  if (p.error || !(p.points > 0)) return;
  rankOf(address).then((k) => { const el = $('#rank'); if (el && out.dataset.address === address) el.textContent = k > 0 ? ` · Rank #${k.toLocaleString('en-US')}` : k === 0 ? ` · Outside the top ${BOARD}` : ''; });
}

// ── TAC coins fall down the screen when a claim lands ──
const COIN = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#0a0a0a"/><circle cx="16" cy="16" r="13" fill="none" stroke="#f4efe6" stroke-width="2.5"/><path d="M17.5 7L13 22.5Q13 25 18 24" fill="none" stroke="#f7931a" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11L21 11" stroke="#f7931a" stroke-width="2.4" stroke-linecap="round"/></svg>')}`;
function confetti() {
  if (calm) return;
  $('#fx')?.remove();
  const cv = document.createElement('canvas'), W = innerWidth, H = innerHeight, dpr = Math.min(2, devicePixelRatio || 1);
  cv.id = 'fx'; cv.setAttribute('aria-hidden', 'true'); cv.width = W * dpr; cv.height = H * dpr;
  const n = Math.max(40, Math.min(150, Math.round(W / 9))), g = cv.getContext('2d'), img = new Image();
  cv.dataset.coins = String(n);
  g.scale(dpr, dpr);
  document.body.append(cv);
  const coins = Array.from({ length: n }, () => ({ x: Math.random() * W, y: -40 - Math.random() * H * 0.7, s: 18 + Math.random() * 18, vy: 190 + Math.random() * 230, sway: 16 + Math.random() * 38, ph: Math.random() * 6.28, spin: 3 + Math.random() * 5, a: Math.random() * 6.28 }));
  let last = performance.now();
  const t0 = last, frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    g.clearRect(0, 0, W, H);
    let live = 0;
    for (const c of coins) {
      c.y += c.vy * dt; c.vy += 90 * dt; c.a += c.spin * dt;
      if (c.y > H + 40) continue;
      live++;
      g.save();
      g.translate(c.x + Math.sin(c.ph + (now - t0) / 600) * c.sway, c.y); g.rotate(Math.sin(c.a) * 0.4); g.scale(Math.cos(c.a * 1.3), 1);
      g.drawImage(img, -c.s / 2, -c.s / 2, c.s, c.s);
      g.restore();
    }
    cv.dataset.live = String(live);
    if (live && now - t0 < 9000 && cv.isConnected) requestAnimationFrame(frame); else cv.remove();
  };
  img.addEventListener('load', () => requestAnimationFrame(frame), { once: true });
  img.addEventListener('error', () => cv.remove(), { once: true });
  img.src = COIN;
}

// ── claiming: only by the account itself, after the contract has been asked ──
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const txLink = (h) => `<a href="https://etherscan.io/tx/${h}" target="_blank" rel="noopener noreferrer">${h.slice(0, 10)}…${h.slice(-6)} ↗</a>`;
async function signedIn(address) {
  if (!W.account && !(await connect.connect())) throw new UserStopped();              // the connect module has said why when it could not
  const mine = String(W.account || '').toLowerCase();
  if (!mine) throw new Error('Your wallet did not share an account.');
  if (mine !== address) throw new Error(`Your wallet is on ${short(mine)}. Switch it to ${short(address)} to claim.`);
}
// distributor.claim(cumulativeAmount, proof): the running total less what the account already claimed, to itself. The proof is the service's
// current one; one that has been replaced since is read again, once.
async function pointsTx(address) {
  const attempt = async (c) => {
    const proof = c?.proof;
    if (!proof?.length || !c.cumulativeAmount) throw new Error('Nothing left to claim here.');
    const data = `0x2f52ebb7${word(c.cumulativeAmount)}${word(64)}${word(proof.length)}${proof.map((h) => h.replace(/^0x/, '').padStart(64, '0')).join('')}`;
    try { await call({ to: DISTRIBUTOR, data, from: address }); } catch (e) {
      const sel = String(e?.data || '').slice(2, 10);
      if (e?.code !== 3) throw new Error('Could not check the claim before sending it. Nothing was sent.');
      throw Object.assign(new Error(sel === '797dba54' ? 'Nothing left to claim here.' : 'The contract would refuse this claim. Nothing was sent.'), { stale: sel === '7ca55c77' });
    }
    return wallet.sendTx({ to: DISTRIBUTOR, data, from: address });
  };
  try { return await attempt(await get(`claim/${address}`)); } catch (e) {
    if (!e.stale) throw e;
    try { return await attempt(await get(`claim/${address}`)); } catch (e2) { throw e2.stale ? new Error('The reward list just updated. Try again in a minute.') : e2; }
  }
}
let claiming = false;
async function claim(kind, address, btn, to = '') {
  if (claiming) return;
  claiming = true;
  const label = btn.textContent, amt = btn.dataset.amt;
  let dest = null;
  let hash = null;                                                                     // once sent, any note that follows keeps its link
  const say = (html) => { const d = $('#done'); if (!d || out.dataset.address !== address) return; d.querySelector('.note-claim')?.remove(); d.insertAdjacentHTML('afterbegin', html); };
  btn.disabled = true;
  try {
    if (to !== '') {                                                                // a name is read before the wallet is asked
      btn.textContent = 'Looking it up…'; dest = (await identify(to)).address;
      if (NO_SEND.includes(dest)) throw new Error('TAC sent to that address could not be recovered. Use another address.');
    }
    await signedIn(address);
    btn.textContent = 'Confirm in your wallet…'; react('think');
    const send = (t) => wallet.sendTx({ to: t.to, data: t.data, from: address });
    hash = kind === 'airdrop' ? (await (dest ? air.claimTo(address, dest, { send }) : air.claim(address, { from: address, send }))).txHash : await pointsTx(address);
    btn.textContent = 'Claiming…'; say(`<p class="note-claim st mute">Claiming ${esc(amt)} TAC · ${txLink(hash)}</p>`);
    const rc = await wallet.receipt(hash);
    if (rc.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was claimed.`);
    $('#done')?.querySelector('.note-claim')?.remove();
    $('#done')?.insertAdjacentHTML('beforeend', `<p class="done"><b>Claimed ${esc(amt)} TAC${dest ? ` to ${short(dest)}` : ''}</b>${txLink(hash)}${dest ? '' : '<button class="linkbtn" type="button" data-watch>Add TAC to wallet</button>'}</p>`);
    said(`Claimed ${amt} TAC`); react('up', 4200); confetti();
    if (!dest) farmClaimed(BigInt(btn.dataset.wei || 0));                           // the TAC is the wallet's own to farm
    kept.delete(`airdrop:${address}`); kept.delete(`points:${address}`);
    await sleep(1500);
    const [a, p] = await Promise.all([readAirdrop(address), readPoints(address)]);
    if (out.dataset.address === address) {
      paint('#c-air', airdropRow(a, address)); paint('#c-pts', pointsRow(p, address)); fillRank(address, p); claimedNow(address, a0(a), p0(p));
      tot.air = a.claimable ? BigInt(a.amountWei) : 0n; tot.pts = p.error ? 0n : p.owed; paintTotal();
    }
  } catch (e) {
    react(e instanceof UserStopped ? 'idle' : 'shake');
    say(`<p class="note-claim st ${e instanceof UserStopped ? 'mute' : 'warn'}">${esc(e.message || 'The claim did not go through.')}${hash ? ` · ${txLink(hash)}` : ''}</p>`);
    btn.textContent = label;
  } finally { claiming = false; if (btn.isConnected) btn.disabled = false; }
}

// ── borrowing against the TAC claimed ──
// Once a result shows TAC claimed (the airdrop, the points reward, or both), a small card under the points: what that much TAC could borrow from each vault now, as
// collateral alone, and a link that opens the vault page's Borrow box with that amount. The figures are the vault's own (vault/quote.js, loaded the first time
// there is something to show); a vault that cannot lend now gives no figure, and the card then says so or only links.
let got = { address: null, air: 0n, pts: 0n }, bwMod = null, bwSeq = 0;
const bwQuotes = new Map();                                                          // claimed wei → the quote, for a minute
const a0 = (s) => (s && s.claimed && s.amountWei ? BigInt(s.amountWei) : 0n);
const p0 = (v) => (v && !v.error && v.claimed > 0n ? v.claimed : 0n);
const rpcOf = (method, params) => (method === 'eth_call' ? call(params[0]) : Promise.reject(new Error(`${method} is not read here`)));
function quoteFor(wei) {
  return keepFor(bwQuotes, String(wei), () => (bwMod ||= import('/vault/quote.js?cb=7e50e5c9').catch((e) => { bwMod = null; throw e; })).then((m) => m.quoteBorrow({ tac: wei, rpc: rpcOf })));
}
function keepFor(map, key, make) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < KEEP) return hit.p;
  const p = make(); map.set(key, { at: Date.now(), p }); p.catch(() => map.delete(key));
  return p;
}
const BW_DP = { usd: 2, eth: 4 };
function borrowLine(q) {
  const open = ['usd', 'eth'].map((k) => q?.[k]).filter((v) => v?.state === 'open'), fig = (v) => `${esc(tac(v.amount, BW_DP[v.key]))} ${v.sym}`;
  if (!open.length) {
    if (q && ['usd', 'eth'].every((k) => q[k]?.state === 'closed')) return '<p class="bw-l">Borrowing against TAC is not open right now. <a class="bw-alt" href="/vault/">See the vaults →</a></p>';
    return '<p class="bw-l"><a class="bw-go" href="/vault/">Borrow TACD or TACE against the TAC you claimed →</a></p>';
  }
  const [a, b] = open;
  return `<p class="bw-l"><a class="bw-go" href="${esc(a.href)}">Borrow up to <b>${fig(a)}</b> against the TAC you claimed →</a>${b ? `<a class="bw-alt" href="${esc(b.href)}">or ${fig(b)}</a>` : ''}</p>`;
}
// `air`, `pts`: what the airdrop and the points reward say is claimed (null: not read again this time).
function claimedNow(address, air, pts) {
  if (got.address !== address) return;
  if (air != null) got.air = air;
  if (pts != null) got.pts = pts;
  const el = $('#c-bw'), total = got.air + got.pts, my = ++bwSeq;
  if (!el || out.dataset.address !== address) return;
  if (total <= 0n) { el.innerHTML = ''; return; }
  if (!$('#bw')) el.innerHTML = `<section class="card slim bw" id="bw">${borrowLine(null)}</section>`;   // the plain line at once, the figure when it is read: same height
  quoteFor(total).then((q) => q, () => null).then((q) => { const box = $('#bw'); if (my === bwSeq && box && out.dataset.address === address) { const h = borrowLine(q); if (box.__h !== h) { box.__h = h; box.innerHTML = h; } } });
}

// ── what pays TAC: the farms and the other ways to earn, under the result, whoever is looked up ──
// The Precision farm's APR now (paid in TAC, swap fees on top) is the farm's own arithmetic from the pool's reserves and price and the farm's stream
// and stake; the private farms come with the API's farm program, priced at the same pool; the points program's pot is the leaderboard's; the
// liquidity campaign and the task budget are the points service's. Each row draws as its reading arrives and a source that does not answer leaves
// its row plain.
const aprText = (a) => (a == null ? '' : a >= 100000 ? '100,000%+' : `${Math.round(a).toLocaleString('en-US')}%`);
const dayText = (sec) => new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const json = (url) => fetch(url, { signal: AbortSignal.timeout(8e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const farmFacts = () => keep('farm', () => readPrecision(call));
const ICONS = new Set(['tac', 'eth', 'teth', 'cusd', 'cbtc']);
const pairIcons = (ids) => `<span class="pairtk">${ids.filter((i) => ICONS.has(i)).map((i) => `<svg class="tk" aria-hidden="true"><use href="#tk-${i}"/></svg>`).join('')}</span>`;
function noteFarm(f) {
  $('#farm-apr').textContent = f?.live ? aprText(f.apr) : f ? '—' : '';
  $('#farm-d').textContent = f?.live ? `Public · ${tac(f.perDay, 0)} TAC a day` : f ? 'Public · between reward periods' : 'Public';
}
function paintPrivate(list) {
  $$('#farms [data-priv]').forEach((e) => e.remove());
  $('#farms').insertAdjacentHTML('beforeend', list.map((x) => `<a class="ern" data-priv href="/#farm/private-${x.pid}">${pairIcons(x.icons)}<span class="rt"><b>${esc(x.name)}</b><small>Private · ${Math.round(x.perDay).toLocaleString('en-US')} TAC a day</small></span><span class="ra"><b class="apr">${aprText(x.apr)}</b><small>APR now</small></span><span class="go o">Farm</span></a>`).join(''));
}
function notePoints(c) {
  if (!c?.program) return;
  const over = c.programDay > c.programDays;
  $('#pts-f').textContent = over ? '' : tac(BigInt(c.program.dayBudgetWei || 0), 0);
  $('#pts-s').textContent = over ? 'The program has ended' : `Day ${c.programDay} of ${c.programDays} · split by points`;
}
function noteLiquidity(l) {
  const row = $('#lp-row');
  if (!l) { row.hidden = true; return; }
  const open = l.create > 0n && l.bonusOpen;
  $('#lp-f').textContent = tac(l.daily > 0n ? l.daily : l.create, 0);
  $('#lp-u').textContent = l.daily > 0n ? 'TAC a day' : 'TAC once';
  $('#lp-s').textContent = `Supply a Borrow market${l.daily > 0n && open ? ` · ${tac(l.create, 0)} TAC for opening one` : ''}${l.from ? ` · from ${dayText(l.from * 86400)}` : ''}`;
}
const noteTasks = (t) => { $('#tk-f').textContent = t ? tac(t.left, 0) : '—'; };
async function readEarn() {
  const f = await farmFacts().catch(() => null);
  noteFarm(f);
  get('farm/program?network=mainnet').then((prog) => paintPrivate(privateFarms(prog, f?.tacEth || 0)), () => paintPrivate([]));
  capNow().then(notePoints, () => {});
  readLiquidity(json).then(noteLiquidity, () => noteLiquidity(null));
  readTasks(json).then(noteTasks, () => noteTasks(null));
}

// ── putting TAC to work: the Precision farm, the first row of the list ──
// The row is there for everyone; opening it loads the farm module the swap and trade pages use, whose form acts for the connected wallet (its
// button connects one). With the wallet on hand the largest TAC + ETH pair it can make is filled in, so what is left is one button; after a claim
// the row opens by itself with the claimed amount. All of the farm's checks are the module's: the deposit is quoted by the lens, tested before
// the wallet is asked, and a price impact is shown (and confirmed when large). The row's line says what the wallet holds there.
const ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const farm = $('#farm'), farmSum = $('#farm-s'), farmNote = $('#farm-note');
let farmUi = null, farmFor = null, farmSeq = 0, ethUsd = 0, hasStake = false;
const eth4 = (wei) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumSignificantDigits: 3 });
const wordOf = (a) => a.slice(2).toLowerCase().padStart(64, '0');
function mountedFarm() {
  return farmUi ||= Promise.all([import('/trade/farm.js?cb=cf321c4e'), import('/trade/util.js?cb=509d6618'), import('/evm-trade-venues.js?cb=563db4d4'),
    call({ to: ETH_USD, data: '0xfeaf968c' }).then((r) => { ethUsd = Number(BigInt(`0x${r.slice(66, 130)}`)) / 1e8; }, () => {})])
    .then(([{ mountFarm }, U, E]) => {
      const ethCall = (to, data, block = 'latest', o = {}) => U.rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: `0x${BigInt(o.value).toString(16)}` } : {}) }, block]);
      const batch = async (calls) => E._internal.decAggregate3(await ethCall(E.MULTICALL3, E._internal.encAggregate3(calls)), calls.length);
      const done = () => { react('up', 3000); said('Farming'); showFarm(); };
      return mountFarm($('#farm-host'), { ethCall, batch, rpc: U.rpc, api: U.api, wallet, W, connect: () => connect.connect(), fmtUnits: U.fmtUnits, parseUnits: U.parseUnits, esc, usd: U.usd, ethUsd: () => ethUsd, txLink, onDone: done, refarm: true });
    })
    .catch((e) => { farmUi = null; throw e; });
}
// What the connected wallet holds there (`extra`: a claim that may not be in the balance read yet): TAC to farm, or a stake with no TAC left.
async function showFarm(extra = 0n) {
  const mine = W.account ? W.account.toLowerCase() : null, my = ++farmSeq;
  if (!mine) { farmSum.textContent = ''; hasStake = false; return; }
  const [held, staked, earned, lp] = await Promise.all([[TAC, '0x70a08231'], [FARM, '0x98807d84'], [FARM, '0x008cc262'], [POOL, '0x70a08231']].map(([to, sel]) => call({ to, data: `${sel}${wordOf(mine)}` }).then(BigInt, () => 0n)));
  if (my !== farmSeq || (W.account || '').toLowerCase() !== mine) return;
  const shown = held > extra ? held : extra;
  hasStake = staked > 0n || earned > 0n || lp > 0n;
  farmSum.textContent = shown > 0n ? `${tac(shown)} TAC held` : hasStake ? 'Your stake' : '';
}
// The form is filled once the module has the wallet's balances; what went in, and what could not, is said in one line. With no wallet, or none
// of the TAC, the form stays as the module starts it: ETH alone.
async function openFarm() {
  const want = farmFor; farmFor = null;
  farmNote.textContent = '';
  try {
    const f = await mountedFarm();
    if (!W.account) return;
    const r = await f.pairWith(want, { settle: want != null });
    if (!r) farmNote.textContent = want != null ? 'Your TAC has not arrived yet. Close this and open it again in a moment.' : '';
    else if (r.mode === 'tac') farmNote.textContent = 'This wallet has no spare ETH, so the TAC is added alone. The pool first swaps half of it to ETH.';
    else if (r.left > 0n) farmNote.textContent = `Your ETH covers ${tac(r.tac)} of the ${tac(r.all)} TAC. All of it needs ${eth4(r.need)} ETH.`;
  } catch { $('#farm-host').innerHTML = '<p class="note err">Could not load the farm. <a href="/swap/#earn">Open it on the swap page</a>.</p>'; }
}
farm.addEventListener('toggle', () => { if (farm.open) openFarm(); });
$('#farm-host').addEventListener('input', () => { farmNote.textContent = ''; });
const toFarm = () => setTimeout(() => farm.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'nearest' }), 350);
// A claim has landed: the row opens with it, and comes into view.
function farmClaimed(wei) {
  farmFor = wei > 0n ? wei : null;
  showFarm(wei).then(() => { if (farm.open) openFarm(); else farm.open = true; toFarm(); });          // opening it fills it
}
// The farm opens from the account's own row, and from a link ending in #farm.
function openTheFarm() { if (!farm.open) farm.open = true; toFarm(); }
if (location.hash === '#farm') farm.open = true;
addEventListener('hashchange', () => { if (location.hash === '#farm') openTheFarm(); });

// ── the folds: points by day, and the leaderboard, read when they are opened ──
const dayName = (n) => new Date(n * 86400e3).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
async function paintDays(d) {
  const el = d.querySelector('.days'), a = d.dataset.days;
  if (el.dataset.done === a) return;
  el.innerHTML = '<p class="st mute">Loading…</p>';
  const r = await keep(`days:${a}`, () => get(`points/${a}/days`));
  if (!el.isConnected) return;
  if (!r || !Array.isArray(r.days)) { el.innerHTML = '<p class="st warn">Could not load this. Close it and open it again.</p>'; return; }
  const list = r.days.slice(0, 14);
  el.innerHTML = list.length ? `<ul class="rows">${list.map((x) => `<li><span>${dayName(x.day)}</span><b class="num">+${Number(x.points).toLocaleString('en-US', { minimumFractionDigits: Number(x.points) < 10 ? 2 : 1, maximumFractionDigits: Number(x.points) < 10 ? 2 : 1 })}</b><span class="m">${x.settled ? `${tac(BigInt(x.tacWei || 0), 4)} TAC` : 'in progress'}</span></li>`).join('')}</ul>${r.days.length > 14 ? `<p class="st mute">The latest 14 of ${r.days.length} days.</p>` : ''}` : '<p class="st mute">No days yet.</p>';
  el.dataset.done = a;
}
async function paintBoard() {
  const el = $('#lb-b'), who = out.dataset.address;
  if (!el || el.dataset.done === '1') return;
  el.innerHTML = '<p class="st mute">Loading…</p>';
  const b = await board();
  if (!el.isConnected) return;
  if (!b) { el.innerHTML = '<p class="st warn">Could not load this. Close it and open it again.</p>'; return; }
  const i = b.findIndex((e) => String(e.address).toLowerCase() === who);
  const row = (e, k) => `<li${String(e.address).toLowerCase() === who ? ' class="me"' : ''}><button type="button" data-q="${esc(e.address)}"><span class="k">#${k}</span><span class="a">${short(e.address)}</span><b class="num">${Math.round(e.points).toLocaleString('en-US')}</b></button></li>`;
  el.innerHTML = `<ol class="board">${b.slice(0, 10).map((e, k) => row(e, k + 1)).join('')}${i >= 10 ? `<li class="gap" aria-hidden="true">⋯</li>${row(b[i], i + 1)}` : ''}</ol>`;
  el.dataset.done = '1';
}
// What each action earns, from the program itself: its rate and what is in force today (a weight, a per-address limit, a share of the day's pot
// that the activity's points can take together), the holder boost and the early bonus. The same terms the app's points sheet lists.
const inForce = (list, day) => (list || []).filter((e) => e.fromDay <= day).sort((a, b) => b.fromDay - a.fromDay)[0];
async function paintEarn() {
  const el = $('#earn-b');
  if (!el || el.dataset.done === '1') return;
  el.innerHTML = '<p class="st mute">Loading…</p>';
  const c = await capNow().catch(() => null);
  if (!el.isConnected) return;
  const P = c?.program;
  if (!P?.rates) { el.innerHTML = '<p class="st warn">Could not load this. Close it and open it again.</p>'; return; }
  const day = c.day, wts = inForce(P.weights, day)?.weights || {}, caps = inForce(P.addressDayCaps, day)?.caps || {}, shares = inForce(P.categoryShareCaps, day)?.caps || {};
  const pot = tac(BigInt(P.dayBudgetWei || 0), 0), n = (x) => Math.round(x).toLocaleString('en-US');
  const note = (k) => `${wts[k] != null && wts[k] !== 1 ? ` · ${wts[k]}×` : ''}${caps[k] ? ` · up to ${caps[k]} ETH a day per address` : ''}${shares[k] ? ` · together at most ${Math.round(shares[k] * 100)}% of a day’s ${pot} TAC` : ''}`;
  const ways = [
    ['holding', 'Hold ETH in the private pools', '/#points', (r) => `${n(r)} points per ETH a day, proven on your device`],
    ['wrap', 'Wrap ETH into the Tacit pool', '/#private', (r) => `${n(r)} points per ETH`],
    ['evmpooldeposit', 'Deposit ETH in a device pool (Ethereum, Base or Robinhood Chain)', '/#device', (r) => `${n(r)} points per ETH`],
    ['zswapeth', 'Buy TAC with ETH (Precision pool)', '/swap/', (r) => `${n(r)} points per ETH`],
    ['cbtcmint', 'Post a bond toward cBTC', '/#borrow', (r) => `${n(r)} points per wstETH${P.rates.cbtchold ? `, then ${n(P.rates.cbtchold)} a day while it stays posted` : ''}`],
    ['cusdmint', 'Borrow cUSD', '/#borrow', (r) => `${n(r)} points per dollar, when you send the loan yourself`],
  ].filter(([k]) => P.rates[k] && wts[k] !== 0);
  // The groups that have a share of each day's pot set aside (in force, or the next to start): what they are for, how much and at most what a point earns.
  const WORDS = { holding: 'holding ETH in the private pools', cbtchold: 'keeping bonds posted', zswapeth: 'buying TAC', cusdmint: 'borrowing', cbtcmint: 'posting bonds', weiname: '.wei names', pmbet: 'bets', pmcreate: 'markets' };
  const orList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);
  const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const upcoming = (P.budgets || []).filter((e) => e.fromDay > day).sort((a, b) => a.fromDay - b.fromDay)[0], live = inForce(P.budgets, day);
  const entry = live?.groups?.length ? live : upcoming?.groups?.length ? upcoming : null;
  const perPoint = (w) => `${(Number(BigInt(w) / 10n ** 12n) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 4 })} TAC a point`;
  const reserved = entry ? `<p class="st mute">${entry.fromDay > day ? `From ${dayName(entry.fromDay)}, part` : 'Part'} of each day’s ${pot} TAC is set aside: ${entry.groups.map((g) => `${Math.round(g.share * 100)}% for ${andList(g.activities.map((a) => WORDS[a] || a))}${g.maxWeiPerPoint ? ` (up to ${perPoint(g.maxWeiPerPoint)})` : ''}`).join(' and ')}. A share that is not used goes back to everyone else.</p>` : '';
  const tiers = P.holder?.tiers || [];
  el.innerHTML = `<ul class="rows ways">${ways.map(([k, label, to, f]) => `<li><a href="${to}">${esc(label)}</a><span class="m">${f(P.rates[k] * (wts[k] ?? 1))}${esc(note(k))}</span></li>`).join('')}</ul>`
    + reserved
    + (tiers.length ? `<p class="st mute">Holding ${orList(tiers.map((t) => n(t.tac)))} public TAC at the same address for a day multiplies that day’s points by ${orList(tiers.map((t) => `${t.multiplier}×`))}. ` : '<p class="st mute">')
    + `Early activity counts up to ${P.earlyBonus?.max ?? 1}×. Each day’s pot is split by points.</p>`;
  el.dataset.done = '1';
}
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open) return;
  if (d.id === 'lb') paintBoard(); else if (d.id === 'earn') paintEarn(); else if (d.dataset.days) paintDays(d);
}, true);

// ── the wallet's part: a notice, a line under the result, what connecting does, switching accounts ──
let wmsgTimer = 0;
function wsay(html, bad = false) {
  const el = $('#wmsg'); if (!el) return;
  clearTimeout(wmsgTimer);
  el.className = `wmsg${bad ? ' bad' : ''}`; el.innerHTML = html;
  if (html) wmsgTimer = setTimeout(() => { el.innerHTML = ''; }, 9000);
}
// Under a result: whether the wallet is on this account, and when it is not, the two ways on.
function paintWallet() {
  const el = $('#wl'); if (!el) return;
  const mine = W.account ? W.account.toLowerCase() : null, asked = out.dataset.address;
  el.innerHTML = !mine || !asked ? '' : mine === asked ? '<span class="ok">Your wallet is on this account</span>'
    : `Your wallet is on ${short(mine)}.<button type="button" data-mine>Look up mine</button><button type="button" data-switch>Switch account</button>`;
  if (asked && $('#c-farm')) paint('#c-farm', farmRow(asked));                          // its button says claim only on the wallet's own account
}
// The wallet's own account, looked up: what a first connection with nothing asked does, and what "look up mine" does.
function lookMine() {
  if (!W.account) return;
  const a = W.account.toLowerCase();
  input.value = a; showHints(''); run(a);
}
let seenAccount = null;
function onWallet() {
  const acct = W.account ? W.account.toLowerCase() : null, fresh = !!acct && acct !== seenAccount;
  seenAccount = acct;
  paintWallet(); showFarm(); showRecent(); farmUi?.then((f) => f.refresh()).catch(() => {});
  if (fresh && farm.open) openFarm();                                                  // connected from the form's own button: its pair is filled in
  if (fresh) { if (!input.value.trim() && !out.innerHTML) lookMine(); else react('wink', 1600); }          // connected with nothing asked: its own rewards; else a wink
}
// The wallet's account chooser (EIP-2255); a wallet app on a phone is switched in the app.
async function switchAccount() {
  const prov = W.prov;
  if (!prov) { connect.connect(); return; }
  if (prov.isWalletConnect) { wsay('Switch accounts in your wallet app, then press Claim.'); return; }
  try { await prov.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); }          // its account change reaches onWallet by itself
  catch (e) { if (e?.code !== 4001) wsay('Switch accounts in your wallet, then press Claim.'); }
}

// ── the bar, its suggestions, and what was looked up before ──
const input = $('#q'), go = $('#go'), out = $('#out'), hints = $('#hints'), recent = $('#recent'), note = $('#note');
const said = (t) => { note.textContent = ''; setTimeout(() => { note.textContent = t; }, 30); };
const recents = () => { try { const l = JSON.parse(store.get(RECENT) || '[]'); return Array.isArray(l) ? l.filter((x) => typeof x === 'string').slice(0, 6) : []; } catch { return []; } };
const remember = (q) => store.set(RECENT, JSON.stringify([q, ...recents().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6)));
function showRecent() {
  const l = recents(), empty = !out.innerHTML && !input.value.trim(), own = empty && !W.account ? '<button type="button" class="chip own" data-own>Connect wallet</button>' : '';
  recent.innerHTML = empty && (l.length || own) ? `${own}${l.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q.length > 22 ? short(q) : q)}</button>`).join('')}${l.length ? '<button type="button" class="chip x" data-clear aria-label="Clear recent lookups">×</button>' : ''}` : '';
  recent.dataset.ready = '1';
}
// A bare name is offered under all three services.
function showHints(v) {
  hints.innerHTML = /^[a-z0-9][a-z0-9-]{1,62}$/i.test(v) && !/^0x/i.test(v) ? ['eth', 'wei', 'gwei'].map((t) => `<button type="button" class="chip" data-q="${esc(`${v.toLowerCase()}.${t}`)}">${esc(v.toLowerCase())}.${t}</button>`).join('') : '';
}

let seq = 0, ctl = null, last = '';
const unreserve = () => { delete document.documentElement.dataset.lookup; };                  // the answer's reserved place (early.js) is let go when there will be none
function clear() {
  unreserve(); seq++; ctl?.abort(); last = ''; out.innerHTML = ''; delete out.dataset.address; hints.innerHTML = ''; go.disabled = false;
  input.setAttribute('aria-invalid', 'false');
  react('idle');
  try { history.replaceState(null, '', location.pathname); } catch { /* the address bar is a convenience */ }
  showRecent();
}
async function run(raw) {
  const q = raw.trim(), my = ++seq;
  ctl?.abort(); ctl = new AbortController();
  input.setAttribute('aria-invalid', 'false');
  if (!q) { clear(); return; }
  last = q; hints.innerHTML = ''; recent.innerHTML = ''; go.disabled = true; out.innerHTML = SKELETON; delete out.dataset.address;
  react('think');
  try {
    const who = await identify(q);
    if (my !== seq) return;
    remember(q);
    out.dataset.address = who.address;
    out.innerHTML = `${whoLine(who, q)}${YOURS}<div id="c-bw"></div>`;
    got = { address: who.address, air: 0n, pts: 0n };
    tot = { address: who.address, air: null, pts: null, farm: null }; stakeOf = null;
    paintWallet();
    try { history.replaceState(null, '', `?q=${encodeURIComponent(q)}`); } catch { /* the address bar is a convenience */ }
    const a = readAirdrop(who.address), p = readPoints(who.address, ctl.signal);
    // The ninja answers once something is claimable (thumbs up at once), or once both are read and nothing is (thumbs down).
    const can = { air: null, pts: null };
    let given = false;                                                              // one answer to a lookup, whichever reading settles it
    const answer = () => {
      if (my !== seq || given) return;
      if (can.air === true || can.pts === true) { given = true; react('up'); said('Something to claim'); }
      else if (can.air === false && can.pts === false) { given = true; react('down'); said('Nothing to claim'); }
      else if (can.air !== null && can.pts !== null) { given = true; react('idle'); }   // a reading failed: nothing to say
    };
    a.then((s) => { if (my !== seq) return; paint('#c-air', airdropRow(s, who.address)); can.air = s.reason === 'error' ? undefined : !!s.claimable; answer(); claimedNow(who.address, a0(s), null); tot.air = s.claimable ? BigInt(s.amountWei) : 0n; paintTotal(); });
    p.then((v) => { if (my !== seq) return; paint('#c-pts', pointsRow(v, who.address)); fillRank(who.address, v); can.pts = v.error ? undefined : v.owed > 0n; answer(); claimedNow(who.address, null, p0(v)); tot.pts = v.error ? 0n : v.owed; paintTotal(); });
    // What the account has in the Precision farm: its row appears when there is anything there, and what it earned is part of the total.
    const fm = farmFacts().then((facts) => readStake(call, who.address, facts).then((stake) => ({ facts, stake })), () => null);
    fm.then((r) => { if (my !== seq) return; stakeOf = r?.stake ? { address: who.address, stake: r.stake, facts: r.facts } : null; paint('#c-farm', farmRow(who.address)); tot.farm = r?.stake ? r.stake.earned : 0n; paintTotal(); });
    await Promise.allSettled([a, p, fm]);
  } catch (e) {
    if (my !== seq) return;
    react('shake'); unreserve();
    input.setAttribute('aria-invalid', 'true');
    out.innerHTML = `<p class="err" role="alert">${esc(e.message || 'Something went wrong. Try again.')}</p>`;
  } finally { if (my === seq) go.disabled = false; }
}

// A whole address starts at once. A whole name starts at once when it was pasted (the bar jumped by more than a key), and a moment after the
// last key when it was typed, so a name still being written is not read.
let pause = 0, was = 0;
input.addEventListener('input', () => {
  clearTimeout(pause);
  const v = input.value.trim(), jumped = Math.abs(v.length - was) > 1;
  was = v.length;
  showHints(v); showRecent();                                                   // what was looked up before is for an empty bar
  if (!v) { clear(); return; }
  if (v === last) return;
  if (/^0x[0-9a-fA-F]{40}$/.test(v) || (jumped && /^\S+\.(eth|wei|gwei)$/i.test(v))) run(v);
  else if (/^\S+\.(eth|wei|gwei)$/i.test(v)) pause = setTimeout(() => { if (input.value.trim() === v && v !== last) run(v); }, 450);
});
input.addEventListener('focus', prime);
input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; clear(); } });
document.addEventListener('keydown', (e) => { if (e.key === '/' && !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); input.focus(); input.select(); } });
$('#f').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(pause); run(input.value); });
document.addEventListener('submit', (e) => { if (e.target.id === 'to-f') e.preventDefault(); });

// A suggestion or a recent lookup fills the bar and answers; a copy button copies and says so; a claim button claims.
document.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-q]'), cp = e.target.closest('[data-copy]'), cl = e.target.closest('[data-claim]');
  if (chip) { input.value = chip.dataset.q; run(chip.dataset.q); return; }
  if (e.target.closest('[data-own]')) { connect.connect(); return; }
  if (e.target.closest('[data-open-farm]')) { openTheFarm(); return; }
  if (e.target.closest('[data-clear]')) { store.set(RECENT, '[]'); showRecent(); return; }
  if (cl) { const toward = cl.dataset.claim === 'airdrop-to'; claim(toward ? 'airdrop' : cl.dataset.claim, cl.dataset.addr, cl, toward ? $('#to-q').value.trim() || ' ' : ''); return; }
  if (e.target.closest('[data-to-show]')) { const f = $('#to-f'); f.hidden = false; e.target.closest('.to').hidden = true; $('#to-q').focus(); return; }
  if (e.target.closest('[data-watch]')) { wallet.watchAsset({ address: TAC, symbol: 'TAC', decimals: 18 }).catch(() => {}); return; }
  if (e.target.closest('[data-mine]')) { lookMine(); return; }
  if (e.target.closest('[data-switch]')) { switchAccount(); return; }
  if (cp) {
    const text = cp.dataset.copy, label = cp.textContent;
    try { await navigator.clipboard.writeText(text); } catch {
      const t = Object.assign(document.createElement('textarea'), { value: text }); document.body.append(t); t.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ } t.remove();
    }
    cp.textContent = 'Copied'; said(cp.dataset.said || 'Address copied'); setTimeout(() => { cp.textContent = label; }, 1400);
  }
});

const asked = new URLSearchParams(location.search).get('q');
if (asked) { input.value = asked; run(asked); } else { showRecent(); if (matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true }); }
// The rank's board is fetched once the page has nothing else to do; a wallet connected here before is found again without a prompt.
(window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => { prime(); board(); connect.restore().then(() => { if (!W.account && !out.innerHTML) unreserve(); }); });
readEarn();
