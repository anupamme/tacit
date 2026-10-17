// Airdrop and points for one account: a 0x address, or a .eth, .wei or .gwei name that points to one, and, with a browser wallet on that
// account, the claim of either. Reading comes first and sends nothing; a claim is made only by the account itself, after the contract has
// been asked whether it would accept it (no wallet here: the claim is a link into the dapp; another account: a note says which to switch to).
//
// A lookup starts as soon as what is typed can be one (a whole address, or a whole name after a short pause), the airdrop and the points each
// draw as their own reading arrives, and what was read is kept for a minute, so asking again is instant. The hosts it reads are connected
// while the person types (the page's preconnect links), and the leaderboard, which gives the rank, is fetched once and shared. The ninja
// peeks over the bar and answers what a lookup found; a claim that lands rains TAC coins.
import { secp, keccak_256 } from '/vendor/tacit-deps.min.js';
import { makeConfidentialNames, makeMainnetCall, MAINNET_RPCS, NameError } from '/confidential-names.js?cb=7bb10833';
import { makeTacAirdrop, makeRpcCall } from '/tac-airdrop.js?cb=02ef61b4';
import { makeConnect, UserStopped } from '/trade/connect.js?cb=a8cdf0f7';

const API = 'https://api.tacit.finance', DISTRIBUTOR = '0x000000C918e44A3a443937fA7594eA4f7C95D6b9', BOARD = 500, KEEP = 60e3, RECENT = 'tacit-rewards-recent-v1';
const $ = (s) => document.querySelector(s);
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
  describe: 'Look up and claim the TAC airdrop and points.',
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

// The three Ethereum endpoints are asked a cheap question once the page is idle (and again on the bar's focus when that was a while ago), so
// their connections are open and the browser has their CORS preflights cached by the time a lookup needs them: the first call to a host
// otherwise costs two round trips, and a name is read from all three.
let primedAt = 0;
function prime() {
  if (Date.now() - primedAt < 300e3) return;
  primedAt = Date.now();
  for (const u of MAINNET_RPCS) fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).catch(() => {});
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

// ── what is drawn ──
const card = (title, body) => `<section class="card"><h2>${title}</h2>${body}</section>`;
// A number that counts up to itself when it appears (not for someone who asks for less motion); its text is final from the start.
const figure = (n, text, unit) => `<p class="big num"><span class="cu" data-to="${n}" data-text="${esc(text)}">${esc(text)}</span><small>${unit}</small></p>`;
// A claim is made here when a browser wallet is present; without one it is the link into the dapp.
const claimUi = (kind, label, address, to, amount, wei) => (wallet.available().length
  ? `<button class="act" type="button" data-claim="${kind}" data-addr="${address}" data-amt="${esc(amount)}" data-wei="${wei}">${label}</button>`
  : `<a class="act" href="${to}">${label}</a>`);
function airdropCard(s, address) {
  if (s.reason === 'error') return card('Airdrop', '<p class="st warn">Could not read the airdrop just now. Look up again in a moment.</p>');
  if (!s.eligible) return card('Airdrop', '<p class="st mute">Not on the airdrop list.</p>').replace('class="card"', 'class="card slim"');
  const left = Math.ceil((s.deadline - Date.now() / 1000) / 86400), by = day(s.deadline);
  const [cls, line] = s.claimed ? ['ok', 'Claimed'] : s.claimable ? [left <= 7 ? 'warn' : 'ok', `Claim by ${by} · ${left} day${left === 1 ? '' : 's'} left`] : s.reason === 'closed' ? ['mute', `Closed ${by}`] : ['warn', s.message];
  return card('Airdrop', `${figure(Number(s.amountTac), tac(s.amountWei), 'TAC')}<p class="st ${cls}">${esc(line)}</p>${s.claimable ? claimUi('airdrop', `Claim ${tac(s.amountWei)} TAC`, address, '/#airdrop', tac(s.amountWei), s.amountWei) : ''}`);
}
function pointsCard(p, address) {
  if (p.error) return card('Points', '<p class="st warn">Could not read points just now. Look up again in a moment.</p>');
  const rows = p.earned > 0n ? [['Earned on settled days', `${tac(p.earned)} TAC`], ['Claimed', `${tac(p.claimed)} TAC`], ['To claim', p.unread ? 'not read' : `${tac(p.owed)} TAC`]] : [];
  return card('Points', `${figure(Math.round(p.points), Math.round(p.points).toLocaleString('en-US'), 'points')}<p class="st mute" id="rank">${p.points <= 0 ? 'No points yet.' : ''}</p>`
    + (rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd class="num">${v}</dd></div>`).join('')}</dl>` : '')
    + (p.owed > 0n ? claimUi('points', `Claim ${tac(p.owed)} TAC`, address, '/#points', tac(p.owed), p.owed) : ''));
}
const whoLine = (who, q) => `<p class="who"><b>${esc(who.name || short(who.address))}</b>${who.name ? `<span>${short(who.address)}</span>` : ''}</p>
  <p class="acts"><button type="button" data-copy="${who.address}">Copy address</button><a href="https://etherscan.io/address/${who.address}" target="_blank" rel="noopener noreferrer">Etherscan ↗</a><button type="button" data-copy="${esc(`${location.origin}/rewards/?q=${encodeURIComponent(q)}`)}" data-said="Link copied">Copy link</button></p>
  <p class="wl" id="wl"></p>
  <div id="done" aria-live="polite"></div>`;
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
function fillRank(address, p) {
  if (p.error || !(p.points > 0)) return;
  rankOf(address).then((k) => { const el = $('#rank'); if (el && out.dataset.address === address) el.textContent = k > 0 ? `Rank #${k.toLocaleString('en-US')}` : k === 0 ? `Outside the top ${BOARD}` : ''; if (el.textContent) el.classList.add('pill'); });
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
    if (!proof?.length || !c.cumulativeAmount) throw new Error('There is nothing left to claim here.');
    const data = `0x2f52ebb7${word(c.cumulativeAmount)}${word(64)}${word(proof.length)}${proof.map((h) => h.replace(/^0x/, '').padStart(64, '0')).join('')}`;
    try { await call({ to: DISTRIBUTOR, data, from: address }); } catch (e) {
      const sel = String(e?.data || '').slice(2, 10);
      if (e?.code !== 3) throw new Error('Could not check the claim before sending it. Nothing was sent.');
      throw Object.assign(new Error(sel === '797dba54' ? 'There is nothing left to claim here.' : 'The distributor would refuse this claim. Nothing was sent.'), { stale: sel === '7ca55c77' });
    }
    return wallet.sendTx({ to: DISTRIBUTOR, data, from: address });
  };
  try { return await attempt(await get(`claim/${address}`)); } catch (e) {
    if (!e.stale) throw e;
    try { return await attempt(await get(`claim/${address}`)); } catch (e2) { throw e2.stale ? new Error('The reward list was just updated. Try again in a minute.') : e2; }
  }
}
let claiming = false;
async function claim(kind, address, btn) {
  if (claiming) return;
  claiming = true;
  const label = btn.textContent, amt = btn.dataset.amt;
  let hash = null;                                                                     // once sent, any note that follows keeps its link
  const say = (html) => { const d = $('#done'); if (!d || out.dataset.address !== address) return; d.querySelector('.note-claim')?.remove(); d.insertAdjacentHTML('afterbegin', html); };
  btn.disabled = true;
  try {
    await signedIn(address);
    btn.textContent = 'Confirm in your wallet…'; react('think');
    hash = kind === 'airdrop' ? (await air.claim(address, { from: address, send: (t) => wallet.sendTx({ to: t.to, data: t.data, from: address }) })).txHash : await pointsTx(address);
    btn.textContent = 'Claiming…'; say(`<p class="note-claim st mute">Claiming ${esc(amt)} TAC · ${txLink(hash)}</p>`);
    const rc = await wallet.receipt(hash);
    if (rc.status !== '0x1') throw new Error(`The transaction failed on chain (${hash.slice(0, 10)}…). Nothing was claimed.`);
    $('#done')?.querySelector('.note-claim')?.remove();
    $('#done')?.insertAdjacentHTML('beforeend', `<p class="done"><b>Claimed ${esc(amt)} TAC</b>${txLink(hash)}</p>`);
    said(`Claimed ${amt} TAC`); react('up', 4200); confetti();
    farmClaimed(BigInt(btn.dataset.wei || 0));
    kept.delete(`airdrop:${address}`); kept.delete(`points:${address}`);
    await sleep(1500);
    const [a, p] = await Promise.all([readAirdrop(address), readPoints(address)]);
    if (out.dataset.address === address) { paint('#c-air', airdropCard(a, address)); paint('#c-pts', pointsCard(p, address)); fillRank(address, p); }
  } catch (e) {
    react(e instanceof UserStopped ? 'idle' : 'shake');
    say(`<p class="note-claim st ${e instanceof UserStopped ? 'mute' : 'warn'}">${esc(e.message || 'The claim did not go through.')}${hash ? ` · ${txLink(hash)}` : ''}</p>`);
    btn.textContent = label;
  } finally { claiming = false; if (btn.isConnected) btn.disabled = false; }
}

// The Precision farm's APR now (paid in TAC, swap fees on top), noted on the links that lead to the farm: the farm's own arithmetic, from the
// pool's reserves and price and the farm's stream and stake.
async function readApr() {
  const POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E', FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0';
  const [r0, r1, supply, sp, staked, rate, finish] = await Promise.all([[POOL, '0x443cb4bc'], [POOL, '0x5a76f25e'], [POOL, '0x18160ddd'], [POOL, '0x2af1f249'], [FARM, '0x817b1cd2'], [FARM, '0x7b0a47ee'], [FARM, '0xebe2b12b']]
    .map(([to, data]) => call({ to, data }).then(BigInt)));
  const sq = Number(sp) / 1e18, tacEth = sq > 0 ? 1 / (sq * sq) : 0;
  if (!tacEth || !supply || !staked || Date.now() / 1000 >= Number(finish)) return null;
  const stakedEth = (Number(r0) + Number(r1) * tacEth) * Number(staked) / Number(supply);
  return stakedEth > 0 ? Number(rate) * 86400 * 365 * tacEth / stakedEth * 100 : null;
}
function noteApr(a) {
  const txt = a >= 100000 ? '100,000%+' : `${Math.round(a).toLocaleString('en-US')}%`, link = $('.uses a[data-apr]'), tag = link?.querySelector('.apr'), sum = $('#farm-apr');
  if (tag) { tag.textContent = txt; tag.classList.add('on'); link.title = `Farm TAC and ETH in the Precision pool: ${txt} APR now, paid in TAC`; }
  if (sum) sum.textContent = `${txt} APR`;
}

// ── putting TAC to work: the Precision farm, in a card under the result for the account the wallet is on ──
// The card appears when that account holds TAC (or has just claimed some). Opening it loads the farm module the swap and trade pages use, and
// fills in the largest TAC + ETH pair the wallet can make, so what is left is one button; after a claim it opens by itself with the claimed
// amount. All of the farm's checks are the module's: the deposit is quoted by the lens, tested before the wallet is asked, and a price impact
// is shown (and confirmed when large).
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const farm = $('#farm'), farmSum = $('#farm-s'), farmNote = $('#farm-note');
let farmUi = null, farmFor = null, farmSeq = 0, ethUsd = 0;
const eth4 = (wei) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumSignificantDigits: 3 });
const wordOf = (a) => a.slice(2).toLowerCase().padStart(64, '0');
function mountedFarm() {
  return farmUi ||= Promise.all([import('/trade/farm.js?cb=3a32fe43'), import('/trade/util.js?cb=c3dc39b3'), import('/evm-trade-venues.js?cb=a08631ce'),
    call({ to: ETH_USD, data: '0xfeaf968c' }).then((r) => { ethUsd = Number(BigInt(`0x${r.slice(66, 130)}`)) / 1e8; }, () => {})])
    .then(([{ mountFarm }, U, E]) => {
      const ethCall = (to, data, block = 'latest', o = {}) => U.rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: `0x${BigInt(o.value).toString(16)}` } : {}) }, block]);
      const batch = async (calls) => E._internal.decAggregate3(await ethCall(E.MULTICALL3, E._internal.encAggregate3(calls)), calls.length);
      const done = () => { react('up', 3000); said('Farming'); showFarm(); };
      return mountFarm($('#farm-host'), { ethCall, batch, rpc: U.rpc, api: U.api, wallet, W, connect: () => connect.connect(), fmtUnits: U.fmtUnits, parseUnits: U.parseUnits, esc, usd: U.usd, ethUsd: () => ethUsd, txLink, onDone: done });
    })
    .catch((e) => { farmUi = null; throw e; });
}
// Shown for the wallet's own account when it holds TAC (`extra`: a claim that may not be in the balance read yet).
async function showFarm(extra = 0n) {
  const mine = W.account ? W.account.toLowerCase() : null, my = ++farmSeq;
  if (!mine || out.dataset.address !== mine) { farm.hidden = true; farm.open = false; return; }
  const held = await call({ to: TAC, data: `0x70a08231${wordOf(mine)}` }).then(BigInt, () => 0n);
  if (my !== farmSeq || out.dataset.address !== mine || (W.account || '').toLowerCase() !== mine) return;
  const shown = held > extra ? held : extra;
  farm.hidden = !(shown > 0n); if (farm.hidden) farm.open = false;
  farmSum.textContent = shown > 0n ? `${tac(shown)} TAC` : '';
}
// The form is filled once the module has the wallet's balances; what went in, and what could not, is said in one line.
async function openFarm() {
  const want = farmFor; farmFor = null;
  farmNote.textContent = '';
  try {
    const f = await mountedFarm(), r = await f.pairWith(want, { settle: want != null });
    if (!r) farmNote.textContent = want != null ? 'Your TAC has not shown in this wallet yet. Close this and open it again in a moment.' : 'There is no TAC in this wallet to farm.';
    else if (r.mode === 'tac') farmNote.textContent = 'There is no spare ETH in this wallet, so the TAC goes in alone: the pool swaps half of it to ETH first.';
    else if (r.left > 0n) farmNote.textContent = `Your ETH pairs with ${tac(r.tac)} of the ${tac(r.all)} TAC. All of it needs ${eth4(r.need)} ETH.`;
  } catch { $('#farm-host').innerHTML = '<p class="note err">The farm could not be loaded just now. <a href="/swap/#earn">Open it on the swap page</a>.</p>'; }
}
farm.addEventListener('toggle', () => { if (farm.open) openFarm(); });
$('#farm-host').addEventListener('input', () => { farmNote.textContent = ''; });
// A claim has landed: the card opens with it, and comes into view.
function farmClaimed(wei) {
  farmFor = wei > 0n ? wei : null;
  showFarm(wei).then(() => {
    if (farm.hidden) return;
    if (farm.open) openFarm(); else farm.open = true;                                // opening it fills it
    setTimeout(() => farm.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'nearest' }), 350);
  });
}

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
}
// A bare name is offered under all three services.
function showHints(v) {
  hints.innerHTML = /^[a-z0-9][a-z0-9-]{1,62}$/i.test(v) && !/^0x/i.test(v) ? ['eth', 'wei', 'gwei'].map((t) => `<button type="button" class="chip" data-q="${esc(`${v.toLowerCase()}.${t}`)}">${esc(v.toLowerCase())}.${t}</button>`).join('') : '';
}

let seq = 0, ctl = null, last = '';
function clear() {
  seq++; ctl?.abort(); last = ''; out.innerHTML = ''; delete out.dataset.address; showFarm(); hints.innerHTML = ''; go.disabled = false;
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
  last = q; hints.innerHTML = ''; recent.innerHTML = ''; go.disabled = true; out.innerHTML = SKELETON; delete out.dataset.address; showFarm();
  react('think');
  try {
    const who = await identify(q);
    if (my !== seq) return;
    remember(q);
    out.dataset.address = who.address;
    out.innerHTML = `${whoLine(who, q)}<div id="c-air">${SKEL('Airdrop')}</div><div id="c-pts">${SKEL('Points')}</div>`;
    paintWallet(); showFarm();
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
    a.then((s) => { if (my !== seq) return; paint('#c-air', airdropCard(s, who.address)); can.air = s.reason === 'error' ? undefined : !!s.claimable; answer(); });
    p.then((v) => { if (my !== seq) return; paint('#c-pts', pointsCard(v, who.address)); fillRank(who.address, v); can.pts = v.error ? undefined : v.owed > 0n; answer(); });
    await Promise.allSettled([a, p]);
  } catch (e) {
    if (my !== seq) return;
    react('shake');
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

// A suggestion or a recent lookup fills the bar and answers; a copy button copies and says so; a claim button claims.
document.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-q]'), cp = e.target.closest('[data-copy]'), cl = e.target.closest('[data-claim]');
  if (chip) { input.value = chip.dataset.q; run(chip.dataset.q); return; }
  if (e.target.closest('[data-own]')) { connect.connect(); return; }
  if (e.target.closest('[data-clear]')) { store.set(RECENT, '[]'); showRecent(); return; }
  if (cl) { claim(cl.dataset.claim, cl.dataset.addr, cl); return; }
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
(window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => { prime(); board(); connect.restore(); readApr().then((a) => { if (a != null) noteApr(a); else $('.uses .apr')?.remove(); }, () => $('.uses .apr')?.remove()); });
