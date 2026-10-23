import { keccak_256 } from '/vendor/tacit-deps.min.js';
import { makeEvmTradeVenues, _internal as V, MULTICALL3 } from '/evm-trade-venues.js?cb=5a940508';
import { makeConnect, UserStopped } from '/trade/connect.js?cb=92188b57';
import { rpc, RPCS, api, esc, fmtUnits, parseUnits, plain, usd, sig, $, E10, E18, ago } from '/trade/util.js?cb=509d6618';
import * as R from '/swap/route.js?cb=35ce60db';
import * as A from '/swap/aggregate.js?cb=79df325d';
import { makePointsNote } from '/points-note.js?cb=eacef061';
import { aprText, readPrecision, readSpot, privateFarms } from '/trade/farm-read.js?cb=112a01b9';

const CHAINLINK = { eth: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', btc: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' };
const PRECISION_POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E';
const CETH_ID = R.POOL_ID[R.ZERO];
const now = () => Math.floor(Date.now() / 1000);
const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const wordAt = (h, i) => BigInt('0x' + (strip(h).slice(i * 64, (i + 1) * 64) || '0'));
const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
const lc = (a) => String(a).toLowerCase();

const HEAVY_HOSTS = [RPCS[RPCS.length - 1], ...RPCS.slice(0, -1)];
const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: '0x' + BigInt(o.value).toString(16) } : {}), ...(o.gas ? { gas: o.gas } : {}) }, block], o.gas ? HEAVY_HOSTS : undefined);
const batch = async (calls) => V.decAggregate3(await ethCall(MULTICALL3, V.encAggregate3(calls)), calls.length);
const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak_256 });
const within = (p, ms, why) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(why)), ms))]);
const PN = makePointsNote({ read: () => fetch('https://api.tacit.finance/leaderboard?day=today&limit=1', { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)) });
const noteOf = (x, q) => [x.note, q?.dir === 'ETH_TO_TAC' ? PN.floor(x.k === 'precision' ? q.wei : x.k === 'split' ? x.split?.legs?.[0]?.amountIn : 0n) : ''].filter(Boolean).join(' · ');
const txLink = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}…↗</a>`;

const TETH = { sym: 'tETH', name: 'Ether, private', addr: 'teth', dec: 18, icon: 'teth', priv: true };
const CUSTOM_KEY = 'tacit-swap-tokens-v1';
const S = {
  tab: 'swap', inP: false, outP: false, btc: false, pay: lc(R.ZERO), get: lc(R.TAC), amt: '', slip: 50, pick: null, hold: false, q: null, seq: 0, busy: false, ack: false,
  custom: [], bal: {}, px: {}, gasPrice: null, chainT: 0, chainAt: 0, farm: 'precision', farms: null, lastBuy: null, note: '', ackKey: '', to: null, toOpen: false, toBad: '', ammRoute: null,
};
// The last swaps made from this browser, so a swap does not vanish with the line that said "Done": a short sentence and its transaction.
const RECENT_KEY = 'tacit-swap-recent-v1';
let RECENT = [];
try { RECENT = (JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') || []).filter((r) => /^0x[0-9a-f]{64}$/.test(r?.h) && Number.isFinite(r.t) && typeof r.s === 'string').slice(0, 8); } catch { }
function remember(h, s) {
  RECENT = [{ h, s: s.slice(0, 120), t: now() }, ...RECENT.filter((r) => r.h !== h)].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(RECENT)); } catch { }
}
function paintRecent() {
  $('#recent').hidden = !RECENT.length;
  $('#recent-l').innerHTML = RECENT.map((r) => `<li><a href="https://etherscan.io/tx/${esc(r.h)}" target="_blank" rel="noopener noreferrer">${esc(r.s)}</a><time>${esc(ago(r.t))}</time></li>`).join('');
}
const SLIP_KEY = 'tacit-swap-slip-v1';
try { const v = Number(localStorage.getItem(SLIP_KEY)); if ([10, 50, 100, 300].includes(v)) S.slip = v; } catch { }
try { S.custom = (JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]') || []).filter((t) => /^0x[0-9a-f]{40}$/.test(t?.addr) && Number.isInteger(t.dec)).slice(0, 20); } catch { }
const TL = { reg: '0x0000006013df75a31678b786061c2b54bf531524', key: 'tacit-swap-list-v1', day: 864e5, rows: [], at: 0, p: null };
const SKIP = new Set(['0xae7ab96520de3a18e5e111b5eaab095312d7fe84']);
const LOGO = {};
const okLogo = (l) => (typeof l === 'string' && /^data:image\/(svg\+xml|png);base64,[A-Za-z0-9+/=]+$/.test(l) && l.length < 40000 ? l : null);
function takeList(rows) {
  TL.rows = [];
  for (const o of rows || []) {
    const a = lc(o?.a || ''), logo = okLogo(o?.l);
    if (!/^0x[0-9a-f]{40}$/.test(a)) continue;
    if (logo && (o.c === 1 || o.c === 0)) LOGO[a] ||= logo;
    if (o.c !== 1 || o.p !== 'ERC-20' || !o.v || SKIP.has(a) || !Number.isInteger(o.d) || o.d > 36) continue;
    TL.rows.push({ sym: String(o.s || '?').slice(0, 12), name: String(o.n || '').slice(0, 40), addr: a, dec: o.d });
  }
}
try { const c = JSON.parse(localStorage.getItem(TL.key) || 'null'); if (c?.rows) { takeList(c.rows); TL.at = c.at || 0; } } catch { }
// Whether TacitAmmRoute is deployed, which is what lets a token be swapped into tacUSD or tacBTC in one transaction. Read now and then, so the
// pair appears by itself the day it is.
async function checkAmmRoute() {
  const v = await R.ammRouteLive({ ethCall }).catch(() => null);
  if (v == null || v === S.ammRoute) return;
  const was = `${S.pay}>${S.get}:${kindOf(S.pay, S.get)}`;
  S.ammRoute = v;
  if (S.busy) return;
  fit('pay'); paint();
  if (S.q && `${S.pay}>${S.get}:${kindOf(S.pay, S.get)}` !== was) requote(true);
}
function loadList() {
  if (Date.now() - TL.at < TL.day && TL.rows.length) return Promise.resolve();
  return (TL.p ||= (async () => {
    const ids = strip(await ethCall(TL.reg, '0xdf7ca268')), n = Math.min(Number(wordAt(ids, 1)), 400);
    const r = await batch(Array.from({ length: n }, (_, i) => ({ to: TL.reg, data: '0x74e18e96' + word(wordAt(ids, 2 + i)) })));
    const rows = r.map((x) => { try { const h = strip(x), len = Number(wordAt(h, 1)); return JSON.parse(new TextDecoder().decode(Uint8Array.from(h.slice(128, 128 + len * 2).match(/../g).map((b) => parseInt(b, 16))))); } catch { return null; } }).filter(Boolean);
    takeList(rows); TL.at = Date.now();
    try { localStorage.setItem(TL.key, JSON.stringify({ at: TL.at, rows: rows.filter((o) => o.c === 1 || o.c === 0) })); } catch { }
    paintSides(); if (W.account) readBalances().then(paintSides);
  })().catch(() => {}).finally(() => { TL.p = null; }));
}
const listed = () => {
  const known = R.TOKENS.map((t) => ({ ...t, addr: lc(t.addr) })), have = new Set(known.map((t) => t.addr));
  return [...known, ...TL.rows.filter((t) => !have.has(t.addr) && (have.add(t.addr), true)), ...S.custom.filter((t) => !have.has(t.addr))];
};
// A coin as its side shows it: on a private side tacUSD and tacBTC are the notes cUSD and cBTC.
const sidePriv = (k) => (k === S.pay ? S.inP : k === S.get ? S.outP : false);
const tokenOf = (k, priv = sidePriv(k)) => { const t = (k === 'teth' ? TETH : listed().find((x) => x.addr === k)) || null; return t?.psym && priv ? { ...t, sym: t.psym } : t; };
const nameIs = (t, x) => lc(t.sym) === x || (t.psym && lc(t.psym) === x);
const isEth = (k) => k === lc(R.ZERO);
const tacitKey = (k) => R.tacitToken(k);
const POOLID = (k) => (k === 'teth' ? CETH_ID : R.POOL_ID[Object.keys(R.POOL_ID).find((a) => lc(a) === k)]);

// ── the output to another address (public swaps only; never read from the address bar, so a shared link cannot name one) ──
const NOT_A_WALLET = new Set([R.ZERO, R.TAC, R.CUSD, R.CBTC, R.WETH, R.ZROUTER, R.ZQUOTER, R.PERMIT2, R.PRECISION_ROUTE, R.PRECISION_GUARD, R.TACIT_AMM, R.TACIT_AMM_ROUTE, R.CONF_ROUTER, PRECISION_POOL, MULTICALL3].map(lc));
// EIP-55: the capitals of an address are its checksum
const checksum = (a) => {
  const body = lc(a).slice(2), h = Array.from(keccak_256(new TextEncoder().encode(body)), (x) => x.toString(16).padStart(2, '0')).join('');
  return '0x' + [...body].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
};
function recipientOf(text) {
  const t = String(text || '').trim();
  if (!t) return { addr: null, bad: '' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return { addr: null, bad: 'Paste a full 0x address.' };
  if (/[a-f]/.test(t.slice(2)) && /[A-F]/.test(t.slice(2)) && t !== checksum(t)) return { addr: null, bad: 'The capitals do not match this address’s checksum. Check it.' };
  if (NOT_A_WALLET.has(lc(t)) || listed().some((x) => lc(x.addr) === lc(t))) return { addr: null, bad: 'That is a contract this swap uses. Send to a wallet.' };
  return { addr: lc(t), bad: '' };
}
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const recipient = () => (S.to && !S.inP && !S.outP && lc(S.to) !== lc(W.account || '') ? S.to : null);
// Where a swap out of the private pool goes: the address typed, else the wallet connected here (never taken from the address bar).
const outTo = () => (kindOf(S.pay, S.get) === 'pout' ? S.to || (W.account ? lc(W.account) : null) : null);

// Which way a pair goes, from where each side is (a wallet, or the private balance):
//   wallet → wallet    the Tacit routes for TAC, tacUSD and tacBTC; any other pair zQuoter's best onchain route ('agg')
//   wallet → private   ETH made private, then swapped in the pool ('private'); another token first swapped for ETH ('pin')
//   private → private  a swap in the pool ('private')
//   private → wallet   a swap in the pool to tETH, then out of it to the address, as ETH or a token ('pout')
const POOL_COINS = ['teth', lc(R.TAC), lc(R.CUSD), lc(R.CBTC)];
const inPool = (k) => POOL_COINS.includes(k);
const isListed = (k) => listed().some((t) => t.addr === k);
function kindOf(pay, get, inP = S.inP, outP = S.outP) {
  if (inP && outP) return inPool(pay) && inPool(get) && pay !== get ? 'private' : null;
  if (outP) {
    if (!inPool(get)) return null;
    if (isEth(pay)) return 'private';
    return isListed(pay) && !tacitKey(pay) && pay !== lc(R.WETH) ? 'pin' : null;
  }
  if (inP) return inPool(pay) && (isEth(get) || (isListed(get) && !tacitKey(get) && get !== lc(R.WETH))) ? 'pout' : null;
  if (pay === get || get === 'teth' || pay === 'teth') return null;
  if ((isEth(pay) && get === lc(R.TAC)) || (isEth(get) && pay === lc(R.TAC))) return 'tac';
  if ((isEth(pay) && (get === lc(R.CUSD) || get === lc(R.CBTC))) || (isEth(get) && (pay === lc(R.CUSD) || pay === lc(R.CBTC)))) return 'amm';
  const tin = tacitKey(pay), tout = tacitKey(get);
  if (get === lc(R.TAC) && !tin) return 'any';
  if (tin && !tout) return isListed(get) ? 'out' : null;                                                // TAC, tacUSD or tacBTC out to any token
  if (!tin && tout) return pay !== lc(R.WETH) && (get === lc(R.CUSD) || get === lc(R.CBTC)) && S.ammRoute === true ? 'in' : null;   // any token in to tacUSD or tacBTC, once TacitAmmRoute is deployed
  const wrapPair = [pay, get].every((k) => isEth(k) || k === lc(R.WETH));
  return isListed(pay) && isListed(get) && !wrapPair && !(tin && tout) ? 'agg' : null;                   // any token to any token
}
const payList = () => (S.inP ? POOL_COINS : listed().map((t) => t.addr));
const getList = () => (S.outP ? POOL_COINS : listed().map((t) => t.addr));
// A pair that goes nowhere is mended from the side that changed: the other side takes the coin most likely to go with it.
function fit(changed) {
  if (kindOf(S.pay, S.get)) return;
  if (changed === 'pay') S.get = S.outP ? (S.pay === 'teth' || isEth(S.pay) ? lc(R.TAC) : 'teth') : S.inP ? lc(R.ZERO) : isEth(S.pay) ? lc(R.TAC) : tacitKey(S.pay) ? lc(R.ZERO) : lc(R.TAC);
  else S.pay = S.inP ? (S.get === 'teth' ? lc(R.TAC) : 'teth') : S.outP ? lc(R.ZERO) : isEth(S.get) || !tacitKey(S.get) ? lc(R.TAC) : lc(R.ZERO);
  if (!kindOf(S.pay, S.get)) { S.pay = S.inP ? 'teth' : lc(R.ZERO); S.get = S.outP ? (S.pay === 'teth' ? lc(R.TAC) : 'teth') : S.inP ? lc(R.ZERO) : lc(R.TAC); }
}
// A side turned private or public: its coin becomes the same coin on that side (ETH and tETH trade places; TAC, USD and BTC keep theirs).
function setSide(side, priv) {
  const k = side === 'pay' ? 'inP' : 'outP';
  if (S[k] === priv || S.busy) return;
  const was = side === 'pay' ? S.pay : S.get, now_ = priv ? (isEth(was) ? 'teth' : inPool(was) ? was : 'teth') : was === 'teth' ? lc(R.ZERO) : was;
  keepAmt(() => { S[k] = priv; if (side === 'pay') S.pay = now_; else S.get = now_; fit(side === 'pay' ? 'get' : 'pay'); });
  if (priv) { warmPrivate(); farmsSoon(); }
  S.amt = fitAmt(S.amt); S.q = null; S.pick = null; S.hold = false; S.ack = false; keepUrl(); paint(); requote(true);
}

const SPRITE = new Set(['tac', 'teth', 'cbtc', 'cusd', 'btc', 'eth']);
const coin = (t, cls = '') => (!t ? '' : SPRITE.has(t.icon) ? `<svg class="tk ${cls}" aria-hidden="true"><use href="#tk-${t.icon}"/></svg>` : LOGO[t.addr] ? `<img class="tk ${cls}" src="${LOGO[t.addr]}" alt="" aria-hidden="true">` : letter(t, cls));
const TINT = { USDC: '#2775CA', USDT: '#26A17B', DAI: '#F5AC37', wstETH: '#00A3FF', WETH: '#627EEA' };
function letter(t, cls) { return `<span class="tk letter ${cls}" style="--c:${TINT[t.sym] || '#8F8979'}" aria-hidden="true">${esc((t.sym || '?').replace(/^w(?=[A-Z])/, '').slice(0, 1).toUpperCase())}</span>`; }
function amtFmt(v, dec) {
  const n = Number(v) / 10 ** dec;
  const dp = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return fmtUnits(v, dec, Math.min(dp, dec));
}
const tidy = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
// What goes into the pool is counted in 8 decimals, its unit (a private balance, or ETH made private): a longer amount (Max on a wallet balance,
// a pasted figure) is cut there, never refused.
const poolUnits = () => S.inP || (S.outP && isEth(S.pay));
const fitAmt = (s, on = poolUnits()) => (on ? String(s).replace(/([.,]\d{8})\d+$/, '$1') : s);
// What a swap from the wallet's ETH leaves behind for the network fee, in wei: what Max keeps back, and what an amount is checked against.
const gasKeep = () => (S.gasPrice || 3n * 10n ** 9n) * 400000n;
// What a private swap from the wallet's ETH also keeps back for the relay's deposit tip: the last one quoted, twice over, or 0.001 ETH before any.
const tipKeep = () => (S.q?.tip != null ? S.q.tip * 2n : 10n ** 15n);
function usdOf(k, wei) {
  const t = tokenOf(k), p = S.px;
  if (!t || wei == null) return null;
  const n = Number(wei) / 10 ** t.dec, is = (sym) => R.TOKENS.some((x) => x.sym === sym && lc(x.addr) === lc(k));
  if (isEth(k) || k === 'teth' || lc(k) === lc(R.WETH)) return p.ethUsd ? n * p.ethUsd : null;
  if (is('wstETH')) return p.ethUsd && p.wstEth ? n * p.wstEth * p.ethUsd : null;
  if (lc(k) === lc(R.CBTC) || is('WBTC')) return p.btcUsd ? n * p.btcUsd : null;
  if (lc(k) === lc(R.CUSD) || is('USDC') || is('USDT') || is('DAI')) return n;
  if (k === lc(R.TAC)) return p.ethUsd && p.perEth ? (n / p.perEth) * p.ethUsd : null;
  return null;
}

async function readPrices() {
  const r = await batch([
    { to: PRECISION_POOL, data: '0x2af1f249' }, { to: CHAINLINK.eth, data: '0xfeaf968c' }, { to: CHAINLINK.btc, data: '0xfeaf968c' }, { to: MULTICALL3, data: '0x0f28c97d' },
    { to: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', data: '0x035faf82' },
  ]);
  const fresh = (x) => (x && wordAt(x, 3) > BigInt(now() - 6 * 3600) && wordAt(x, 1) > 0n ? Number(wordAt(x, 1)) / 1e8 : null);
  if (r[0]) { const root = Number(wordAt(r[0], 0)) / 1e18; S.px.perEth = root > 0 ? root * root : null; }
  S.px.ethUsd = fresh(r[1]) ?? S.px.ethUsd; S.px.btcUsd = fresh(r[2]) ?? S.px.btcUsd;
  if (r[3]) { S.chainT = Number(wordAt(r[3], 0)); S.chainAt = now(); }
  if (r[4]) S.px.wstEth = Number(wordAt(r[4], 0)) / 1e18;
  paintPx();
}
const chainDeadline = (s = 1200) => BigInt((S.chainT ? S.chainT + (now() - S.chainAt) : now()) + s);
const gasPrice = (() => { let at = 0; return async () => { if (S.gasPrice != null && now() - at < 20) return S.gasPrice; try { S.gasPrice = BigInt(await rpc('eth_gasPrice', [])); at = now(); } catch { } return S.gasPrice; }; })();
function paintPx() {
  const p = S.px, el = $('#pxs');
  if (!p.ethUsd) return;
  const tac = p.perEth ? p.ethUsd / p.perEth : null;
  el.innerHTML = `${tac ? `<span><svg class="tk xs" aria-hidden="true"><use href="#tk-tac"/></svg>TAC <b class="num">${usd(tac)}</b></span>` : ''}<span><svg class="tk xs" aria-hidden="true"><use href="#tk-eth"/></svg>ETH <b class="num">${usd(p.ethUsd)}</b></span>${p.btcUsd ? `<span><svg class="tk xs" aria-hidden="true"><use href="#tk-btc"/></svg>BTC <b class="num">${usd(p.btcUsd)}</b></span>` : ''}`;
  el.classList.add('on');
}
async function readBalances() {
  const who = W.account;
  if (!who) { S.bal = {}; return; }
  const toks = listed().filter((t) => !isEth(t.addr));
  const [eth, r] = await Promise.all([rpc('eth_getBalance', [who, 'latest']).then(BigInt, () => null), batch(toks.map((t) => ({ to: t.addr, data: '0x70a08231' + addrWord(who) }))).catch(() => [])]);
  const bal = {};
  if (eth != null) bal[lc(R.ZERO)] = eth;
  toks.forEach((t, i) => { if (r[i]) bal[t.addr] = wordAt(r[i], 0); });
  if (W.account === who) S.bal = bal;
}

const live = (t) => { $('#live').textContent = t; };
const say = (h, cls = '', stick = false) => { if (stick) S.note = { h, cls }; const q = $('#q'); q.className = `q${cls ? ` ${cls}` : ''}`; q.innerHTML = h; };
const connect = makeConnect({
  describe: 'Swap into Tacit’s tokens and farm them.',
  busy: () => S.busy,
  say: (t, bad) => say(t, bad ? 'err' : ''),
  onChange: () => { S.bal = {}; paint(); readBalances().then(paint); if (S.q) requote(true); },
});
const { wallet, W } = connect;
async function signTyped(typed, from) {
  if (lc(W.account || '') !== lc(from)) throw new Error('The wallet’s account changed. Nothing was signed; review it again.');
  await wallet.ensureMainnet();
  try { return await W.prov.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] }); } catch (e) {
    if (e?.code === 4001 || /user (rejected|denied)|rejected the request|denied/i.test(e?.message || '')) throw new UserStopped();
    throw e;
  }
}

const PREVIEW = '0x0000000000000000000000000000000000000001';           // who a quote pays before a wallet is connected
const GAS = { single: 160000n, twohop: 260000n, tac: 160000n, tacSell: 210000n, split: 270000n, any: 320000n, amm: 150000n, ammIn: 200000n, out: 340000n, in: 290000n };
const picked = (q = S.q) => (q?.rows || []).find((r) => r.k === S.pick) || q?.rows?.find((r) => r.best) || q?.rows?.[0] || null;

let qTimer = 0;
function requote(now_ = false) {
  clearTimeout(qTimer);
  if (S.btc) return;
  const my = ++S.seq;
  const t = tokenOf(S.pay), wei = parseUnits(S.amt, t?.dec ?? 18);
  if (!wei) { S.q = null; paint(); return; }
  S.q = { ...(S.q || {}), busy: true }; paintQuote();
  qTimer = setTimeout(() => quote(my, wei).catch((e) => { if (my === S.seq) { S.q = { err: e?.message || String(e) }; paint(); } }), now_ ? 0 : 350);
}
async function quote(my, wei) {
  const kind = kindOf(S.pay, S.get), pay = tokenOf(S.pay), get = tokenOf(S.get);
  const done = (q) => { if (my !== S.seq) return; S.q = { ...q, kind, wei, at: now() }; if (!S.hold || !S.q.rows?.some((r) => r.k === S.pick)) S.pick = S.q.rows?.find((r) => r.best)?.k || S.q.rows?.[0]?.k || null; const ak = `${S.pay}>${S.get}:${S.amt}:${S.pick}`; if (ak !== S.ackKey) { S.ack = false; S.ackKey = ak; } paint(); };
  if (!kind) return done({ none: true });
  const account = W.account || undefined;
  if (kind === 'tac') {
    const dir = isEth(S.pay) ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
    const rt = await venues.route({ dir, amountIn: wei, account, gasPrice: await gasPrice() });
    if (!rt.single) return done({ rows: [], why: 'No pool can fill this right now.' });
    const rows = [];
    const ranked = rt.r.ranked || [];
    for (const v of ranked) rows.push({ k: v.venue, name: v.venue === 'precision' ? 'Precision pool' : 'Tacit pool', note: '', out: BigInt(v.amountOut), venue: v, gas: dir === 'ETH_TO_TAC' ? GAS.tac : GAS.tacSell });
    if (rt.split) { const sh = Math.round(Number(rt.split.legs[0].amountIn * 1000n / (rt.split.legs[0].amountIn + rt.split.legs[1].amountIn)) / 10); rows.push({ k: 'split', name: 'Both pools', note: `${sh}% / ${100 - sh}%`, out: BigInt(rt.split.amountOut), split: rt.split, gas: GAS.split }); }
    const best = rt.pick === 'split' ? rows.find((r) => r.k === 'split') : rows.find((r) => r.k === rt.single.venue);
    if (best) best.best = true;
    return done({ rows, dir });
  }
  if (kind === 'amm') {
    const q = await R.quoteAmm({ ethCall, tokenIn: isEth(S.pay) ? R.ZERO : S.pay, tokenOut: isEth(S.get) ? R.ZERO : S.get, amountIn: wei });
    if (!q) return done({ rows: [], why: wei < R.UNIT ? 'Enter a larger amount.' : 'The Tacit pool has no price for this pair right now.', tiny: wei < R.UNIT });
    return done({ rows: [{ k: 'amm', name: 'Tacit pool', note: '', out: q.amountOut, amm: q, gas: isEth(S.pay) ? GAS.amm : GAS.ammIn, best: true }], dust: wei - q.amountIn });
  }
  if (kind === 'any') {
    const q = await within(R.quoteAnyToTac({ ethCall, venues, token: S.pay, amountIn: wei, account: account || '0x0000000000000000000000000000000000000001', slippageBps: S.slip, deadline: chainDeadline(1800), reuse: true }), 15e3, 'zQuoter did not answer in time. Try again.');
    if (!q) return done({ rows: [], why: `No pool trades ${esc(pay.sym)} against WETH deeply enough. Swap it for ETH elsewhere first.` });
    const hop = q.hop ? `${q.hop.name}${q.hop.feeBps ? ` ${Number(q.hop.feeBps) / 100}%` : ''}` : null;
    return done({ rows: [{ k: 'any', name: hop ? `${hop} → Precision pool` : 'Precision pool', note: '', out: q.tacOut, any: q, gas: GAS.any, best: true }] });
  }
  if (kind === 'out' || kind === 'in') {
    const who = account || '0x0000000000000000000000000000000000000001', dest = recipient() || who, args = { ethCall, amountIn: wei, account: who, to: dest, slippageBps: S.slip, deadline: chainDeadline(1800), reuse: true };
    if (kind === 'out') {
      const q = await within(R.quoteTacitToToken({ ...args, venues, tokenIn: S.pay, tokenOut: S.get }), 20e3, 'zQuoter did not answer in time. Try again.');
      if (!q) return done({ rows: [], why: `No pool trades WETH for ${esc(get.sym)} deeply enough. Sell ${esc(pay.sym)} for ETH, then swap it elsewhere.` });
      const via = q.leg.venue === 'precision' ? 'Precision pool' : 'Tacit pool', hop = q.hop ? `${q.hop.name}${q.hop.feeBps ? ` ${Number(q.hop.feeBps) / 100}%` : ''}` : null;
      return done({ rows: [{ k: 'out', name: hop ? `${via} → ${hop}` : via, note: '', out: q.out, val: q.val, min: q.min, sell: q, gas: GAS.out, best: true }] });
    }
    const q = await within(R.quoteTokenToTacit({ ...args, token: S.pay, tokenOut: S.get }), 20e3, 'zQuoter did not answer in time. Try again.');
    if (!q) return done({ rows: [], why: `No pool trades ${esc(pay.sym)} against WETH deeply enough. Swap it for ETH elsewhere first.` });
    const hop = `${q.hop.name}${q.hop.feeBps ? ` ${Number(q.hop.feeBps) / 100}%` : ''}`;
    return done({ rows: [{ k: 'in', name: `${hop} → Tacit pool`, note: '', out: q.out, buy: q, gas: GAS.in, best: true }] });
  }
  // any token to any token: zQuoter's best onchain route, held to the terms by the guard (swap/aggregate.js)
  if (kind === 'agg') {
    const who = recipient() || account || PREVIEW, ksP = A.kyberOut({ tokenIn: S.pay, tokenOut: S.get, amountIn: wei });
    const q = await within(A.bestRoute({ ethCall, to: who, refundTo: account || who, tokenIn: S.pay, tokenOut: S.get, amountIn: wei, slippageBps: S.slip, deadline: chainDeadline(1200) }), 20e3, 'zQuoter did not answer in time. Try again.');
    if (!q) return done({ rows: [], why: 'No pool trades this pair deeply enough onchain.' });
    return done({ rows: [{ k: 'agg', name: q.name, note: '', out: q.out, min: q.min, agg: q, ks: await ksP, gas: GAS[q.kind] || GAS.split, best: true }] });
  }
  // a wallet token into the private balance: swapped for ETH (the best onchain route, paid to the wallet), then the least it is sure to pay made private and swapped in the pool
  if (kind === 'pin') {
    const who = account || PREVIEW, r1 = await within(A.bestRoute({ ethCall, to: who, refundTo: who, tokenIn: S.pay, tokenOut: R.ZERO, amountIn: wei, slippageBps: S.slip, deadline: chainDeadline(1200) }), 20e3, 'zQuoter did not answer in time. Try again.');
    if (!r1) return done({ rows: [], why: `No pool trades ${esc(pay.sym)} for ETH deeply enough.` });
    const units = r1.min / E10;
    if (!units) return done({ rows: [], why: 'Enter a larger amount.', tiny: true });
    const q = await privQuote(units, 'eth', 'ETH');
    return done(q.rows?.length ? { ...q, pin: r1, ethIn: units * E10, rows: q.rows.map((x) => ({ ...x, name: `${r1.name} → ${x.name === 'Made private' ? 'private' : x.name}`, pin: true })) } : q);
  }
  const units = parseUnits(S.amt, 8);
  if (!units) return done({ rows: [], why: 'Enter an amount with at most 8 decimal places.' });
  if (kind === 'pout') return done(await quoteOut(units, pay, get));
  return done(await privQuote(units, isEth(S.pay) ? 'eth' : PK[S.pay], pay.sym));
}
// A swap into the private balance or inside it, of `units` of the pool coin `from` (the wallet's ETH when it is 'eth' and the pay side is public).
async function privQuote(units, from, sym) {
  const wallet = from === 'eth' && !S.inP, tipP = wallet ? tipFor(units) : null;
  if (wallet && S.get === 'teth') return { rows: [{ k: 'private', name: 'Made private', note: '', out: units * E10, best: true, priv: true }], fee: null, tip: await tipP };
  const t = await getUx(), to = PK[S.get];
  idsOf(t);
  const id = (k) => (k === 'cbtc' ? String(t.pool.CBTC_ZK_ASSET_ID) : String(t.assetByTicker[POOL_TK[k]]?.assetId || '')).toLowerCase();
  const stops = from === 'eth' || to === 'eth' ? [to] : ['eth', to];
  const f0 = BigInt(await t.quoteOpFee(POOL_TK[from], 'route')), fee = stops.length > 1 ? twoDigits((f0 * 14n) / 10n) : f0;
  if (units <= fee * 2n) return { rows: [], why: `Swap more than ${fmtUnits(fee * 2n, 8, 6)} ${esc(sym)}: the relay’s fee is ${fmtUnits(fee, 8, 6)}.`, tiny: true };
  // each hop's reserves are kept, in the hop's order, so the receipt can say how deep the pool is that the swap is made in
  let cur = id(from), amt = units - fee, at = from;
  const pools = [];
  for (const k of stops) {
    const next = id(k);
    const tiers = await Promise.all([30, 5, 100, 1].map((feeBps) => t.quoteRoute({ asset0: cur, amountIn: amt, path: [{ assetNext: next, feeBps }] }).then((r) => (r && r.amountOut > 0n ? r : null), () => null)));
    const best = tiers.filter(Boolean).reduce((a, c) => (!a || c.amountOut > a.amountOut ? c : a), null);
    if (!best) return { rows: [], why: 'The Tacit pool has no price for this pair right now.' };
    const h = best.hops[0], lo = BigInt(cur) <= BigInt(next);
    pools.push({ a: at, b: k, feeBps: Number(h.feeBps), ra: BigInt(lo ? h.reserveAPre : h.reserveBPre), rb: BigInt(lo ? h.reserveBPre : h.reserveAPre) });
    cur = next; amt = best.amountOut; at = k;
  }
  return { rows: [{ k: 'private', name: 'Tacit pool', note: '', out: amt * E10, best: true, priv: true }], fee, feeTick: from, pools, tip: tipP ? await tipP : null };
}
// What the relay's activation of a swap exit costs besides the settle (the escrow made, the swap, the sweep), carried in the exit's fee with a
// third more at the gas price now (the relay refuses an exit whose fee does not cover both).
const ACT_GAS = 450000n;
// A private coin out of the pool: routed to tETH in the pool (unless it is tETH), that note unwrapped to the address as ETH, or to an exit
// recipe's escrow that sells the ETH on zRouter for the token, paid to the address.
async function quoteOut(units, pay, get) {
  const t = await getUx(), from = PK[S.pay], eth = isEth(S.get);
  idsOf(t);
  let tUnits = units, fee = null;
  const pools = [];
  if (from !== 'eth') {
    fee = BigInt(await t.quoteOpFee(POOL_TK[from], 'route'));
    if (units <= fee * 2n) return { rows: [], why: `Swap more than ${fmtUnits(fee * 2n, 8, 6)} ${esc(pay.sym)}: the relay’s fee is ${fmtUnits(fee, 8, 6)}.`, tiny: true };
    const cur = IDS[from], next = IDS.eth;
    const tiers = await Promise.all([30, 5, 100, 1].map((feeBps) => t.quoteRoute({ asset0: cur, amountIn: units - fee, path: [{ assetNext: next, feeBps }] }).then((r) => (r && r.amountOut > 0n ? r : null), () => null)));
    const best = tiers.filter(Boolean).reduce((a, c) => (!a || c.amountOut > a.amountOut ? c : a), null);
    if (!best) return { rows: [], why: 'The Tacit pool has no price for this pair right now.' };
    const h = best.hops[0], lo = BigInt(cur) <= BigInt(next);
    pools.push({ a: from, b: 'eth', feeBps: Number(h.feeBps), ra: BigInt(lo ? h.reserveAPre : h.reserveBPre), rb: BigInt(lo ? h.reserveBPre : h.reserveAPre) });
    tUnits = best.amountOut;
  }
  const gp = eth ? 0n : (await gasPrice()) || 3n * 10n ** 9n;
  const xmin = BigInt(await t.quoteOpFee('cETH', 'unwrap')) + (eth ? 0n : (ACT_GAS * gp * 4n / 3n + E10 - 1n) / E10);
  const { fee: xfee, net } = t.quoteUnwrapFee(tUnits, 'cETH', { minFee: xmin });
  if (net <= 0n) return { rows: [], why: 'Too small to leave the pool: the relay’s fee is more than it.', tiny: true };
  const wei = net * E10, via = from === 'eth' ? '' : 'Tacit pool → ';
  const base = { fee, xfee, xmin, pools, tUnits };
  if (eth) return { ...base, rows: [{ k: 'pout', name: `${via}out of the pool`, out: wei, min: wei, wei, best: true, priv: true, pout: true }] };
  const sale = await within(R.quoteEthToToken({ ethCall, to: S.to || '0x0000000000000000000000000000000000000001', tokenOut: S.get, amount: wei, slippageBps: S.slip, deadline: chainDeadline(1800) }), 20e3, 'zQuoter did not answer in time. Try again.');
  if (!sale) return { rows: [], why: `No pool trades ETH for ${esc(get.sym)} deeply enough.` };
  return { ...base, rows: [{ k: 'pout', name: `${via}${sale.name}${sale.feeBps ? ` ${Number(sale.feeBps) / 100}%` : ''}`, out: sale.amountOut, min: sale.amountLimit, wei, best: true, priv: true, pout: true }] };
}
const PK = { teth: 'eth', [lc(R.TAC)]: 'tac', [lc(R.CUSD)]: 'cusd', [lc(R.CBTC)]: 'cbtc' };
const POOL_TK = { eth: 'cETH', tac: 'cTAC', cbtc: 'cBTC', cusd: 'cUSD' };
// The pool module, one copy for the quotes and the private swap (private.js is handed it).
let uxP = null;
const getUx = () => (uxP ||= (async () => {
  const [{ makeConfidentialPoolUx }, dep, d] = await Promise.all([import('/confidential-pool-ux.js?cb=df0eb74d'), import('/confidential-deployments.js'), import('/vendor/tacit-deps.min.js')]);
  dep.setActiveNetwork('mainnet');
  return makeConfidentialPoolUx({ secp: d.secp, keccak256: d.keccak_256, sha256: d.sha256, network: 'mainnet' });
})().catch((e) => { uxP = null; throw e; }));
// The pool's ids of the four coins, as the quote names them (eth, tac, cusd, cbtc): read once the pool module is in.
const IDS = {};
const idsOf = (t) => { for (const k of ['eth', 'tac', 'cusd']) IDS[k] = String(t.assetByTicker[POOL_TK[k]]?.assetId || '').toLowerCase(); IDS.cbtc = String(t.pool.CBTC_ZK_ASSET_ID).toLowerCase(); return IDS; };
// What the relay asks, in ETH on top, to settle a deposit of the wallet's ETH; null when it cannot be read (the swap reads it again before sending).
const tipFor = (units) => import('/teth/read.js?cb=b2a110d0').then((m) => m.wrapQuote(units * E10)).then((x) => x.tip, () => null);
let warmed = false;
function warmPrivate() {
  if (warmed) return;
  warmed = true;
  const t = $('#warm');
  if (t) { document.head.append(t.content); t.remove(); }
  document.head.append(Object.assign(document.createElement('link'), { rel: 'preconnect', href: 'https://mainnet.gateway.tenderly.co', crossOrigin: '' }));
  getUx().then((t) => t.quoteOpFee('cETH', 'route')).catch(() => {});
}
const twoDigits = (v) => { if (v <= 0n) return 0n; const d = BigInt(String(v).length); if (d <= 2n) return v; const m = 10n ** (d - 2n); return ((v + m - 1n) / m) * m; };

// What the swap itself spends: for a private one the payment less the relay's fee, so the price and its impact are the pool's, not the fee's.
const spentOf = (q, r) => (r?.pin ? q.wei : r?.any ? r.any.spend : r?.buy ? r.buy.spend : r?.sell ? r.sell.amountIn : r?.priv && q.fee != null ? q.wei - q.fee * E10 : q.wei);
function vsMarket(q = S.q, r = picked(q)) {
  if (!q || !r) return null;
  const vin = usdOf(S.pay, spentOf(q, r)) ?? (r.any ? usdOf(lc(R.ZERO), r.any.weth) : null), vout = usdOf(S.get, r.val ?? r.out);
  return vin && vout ? vout / vin - 1 : null;
}
const BAD = -0.03, GATE = -0.1;

function paint() {
  paintTabs(); paintSides(); paintQuote(); paintRecent(); paintNudge();
}
// What a key last read as bridged to its Taproot address (the front page and the Bitcoin lane keep it, per key, in the browser): tETH or TAC that
// waits to be moved to the trading address before it can swap on Bitcoin. The Bitcoin switch carries a dot and says so; the lane has the move.
const BRIDGED_KEY = 'tacit-bridged-v1';
function bridgedWaiting() {
  try {
    const all = JSON.parse(localStorage.getItem(BRIDGED_KEY) || '{}') || {}, out = [];
    for (const held of Object.values(all)) {
      for (const [a, sym] of [['teth', 'tETH'], ['tac', 'TAC']]) {
        const e = held && held[a];
        if (e && Number(e.n) > 0 && /^\d+$/.test(String(e.v)) && BigInt(e.v) > 0n && !out.includes(sym)) out.push(sym);
      }
    }
    return out;
  } catch { return []; }
}
function paintNudge() {
  const b = document.querySelector('.mode [data-mode="bitcoin"]');
  if (!b) return;
  const w = S.btc ? [] : bridgedWaiting(), t = w.length ? `On Bitcoin: your bridged ${w.join(' and ')} waits there to be moved, then swapped` : 'On Bitcoin';
  b.toggleAttribute('data-nudge', w.length > 0);
  b.title = t; b.setAttribute('aria-label', t);
}
addEventListener('storage', (e) => { if (e.key === BRIDGED_KEY || e.key === null) paintNudge(); });
function paintTabs() {
  for (const [t, el] of [['swap', $('#tab-swap')], ['earn', $('#tab-earn')]]) el.setAttribute('aria-selected', String(S.tab === t));
  $('.sw-h').style.setProperty('--i', S.tab === 'swap' ? 0 : 1);
  $('#p-swap').hidden = S.tab !== 'swap'; $('#p-earn').hidden = S.tab !== 'earn';
  // slippage is a public market's: a swap made only inside the pool has none to set
  const k = kindOf(S.pay, S.get), slips = k && k !== 'private' && !(k === 'pout' && isEth(S.get));
  $('#p-swap').classList.toggle('btc', S.btc); $('#btc').hidden = !S.btc; $('.sw-foot').hidden = !slips;
  document.querySelectorAll('.mode [data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === 'bitcoin' ? S.btc : !S.btc)));
  for (const [side, on] of [['pay', S.inP], ['get', S.outP]]) document.querySelectorAll(`.sides[data-side="${side}"] [data-p]`).forEach((b) => b.setAttribute('aria-checked', String((b.dataset.p === '1') === on)));
}
function paintSides() {
  const pay = tokenOf(S.pay), get = tokenOf(S.get);
  $('#pay-coin').innerHTML = `${coin(pay)}${esc(pay.sym)}<span class="car" aria-hidden="true">▾</span>`;
  $('#pay-coin').setAttribute('aria-label', `Pay with ${pay.sym}. Choose another`);
  $('#get-coin').innerHTML = `${coin(get)}${esc(get.sym)}<span class="car" aria-hidden="true">▾</span>`;
  $('#get-coin').setAttribute('aria-label', `Get ${get.sym}. Choose another`);
  const payPriv = S.inP, out = kindOf(S.pay, S.get) === 'pout', inPriv = S.outP;
  // out of the pool with no wallet connected here there is no address to default to: the field opens to ask for one
  if (out && !S.to && !S.toBad && !W.account) S.toOpen = true;
  $('#f-pay').classList.toggle('priv', payPriv); $('#f-get').classList.toggle('priv', inPriv);
  const to = S.inP ? outTo() : recipient(), gw = $('#get-where');
  gw.className = `where${inPriv ? ' priv' : ''}`; gw.textContent = inPriv ? 'private on Ethereum' : S.to && to ? `to ${shortAddr(to)}` : out && !W.account ? 'to an address' : 'to your wallet';
  gw.disabled = inPriv; gw.setAttribute('aria-expanded', String(S.toOpen && !inPriv));
  $('#to').hidden = inPriv || !S.toOpen; $('#to-in').setAttribute('aria-invalid', String(!!S.toBad));
  $('#to-in').placeholder = LATER.on || (out && !W.account) ? 'Address it goes to, 0x…' : 'Send to another address, 0x…';
  $('#to-note').textContent = S.toBad || (to && $('#to-in').value.trim() !== checksum(to) ? checksum(to) : ''); $('#to-note').className = S.toBad ? 'err' : '';
  const a = $('#amt'); if (a.value !== S.amt) a.value = S.amt;
  fitSize(a);
  $('#flip').disabled = !kindOf(S.get, S.pay);
  const bal = payPriv ? privBal(S.pay) : W.account ? S.bal[S.pay] : null, wei = parseUnits(S.amt, pay.dec);
  const side = $('#pay-side');
  if (payPriv && bal == null) side.innerHTML = PV?.unlocked ? '<span>Reading your private balance…</span>' : '<button type="button" id="pv-open">Your private balance</button>';
  else if (bal != null) side.innerHTML = `<button type="button" id="max" class="${wei && wei > bal ? 'over' : ''}">Balance ${esc(amtFmt(bal, pay.dec))}${bal > 0n ? ' · Max' : ''}</button>`;
  else if (!S.amt) side.innerHTML = `<span class="quick">${((poolUnits() ? QUICK_PRIV : QUICK)[pay.sym] || []).map((v) => `<button type="button" data-quick="${v}">${v}</button>`).join('')}</span>`;
  else side.textContent = '';
  const getBal = !S.outP && !S.to && W.account ? S.bal[S.get] : null;
  $('#get-side').textContent = getBal ? `You have ${amtFmt(getBal, get.dec)}` : '';
  const v = wei ? usdOf(S.pay, wei) : null;
  $('#pay-usd').textContent = v != null ? `≈ ${usd(v)}` : '';
}
const QUICK = { ETH: ['0.1', '0.5', '1'], TAC: ['500', '1000'], USDC: ['100', '500'], USDT: ['100', '500'], DAI: ['100', '500'], cUSD: ['100', '500'], tacUSD: ['100', '500'], cBTC: ['0.001', '0.01'], tacBTC: ['0.001', '0.01'], WBTC: ['0.005', '0.01'], WETH: ['0.1', '0.5'], wstETH: ['0.1', '0.5'], tETH: ['0.1', '0.5'] };
// The private pools are young: these are amounts a few times the relay's fee that move the price a few percent, not more.
const QUICK_PRIV = { ETH: ['0.02', '0.05', '0.1'], tETH: ['0.02', '0.05', '0.1'], TAC: ['500', '2000'], cUSD: ['50', '100'], cBTC: ['0.0005', '0.001'] };
// A pool's side by the name the quote keeps it under (the console's), and the icon its farm row is drawn with.
const PSYM = { eth: 'tETH', tac: 'TAC', cusd: 'cUSD', cbtc: 'cBTC' }, PICON = { eth: 'teth', tac: 'tac', cusd: 'cusd', cbtc: 'cbtc' };
// The private farm on the pool the swap ends in: the way to deepen it.
const farmOn = (p) => (S.farms || []).find((f) => f.pid != null && [PICON[p.a], PICON[p.b]].every((i) => f.icons.includes(i))) || null;
const fitSize = (el) => { const n = (el.value || el.textContent || '').length; el.classList.toggle('long', n > 8); el.classList.toggle('longer', n > 11); };

// A private swap's fees said once, in dollars, when each part can be priced (the relay's for the swap, the exit's, the deposit's tip), else a row
// each; the share of the swap they take is said when it is a fiftieth or more.
function feeLines(q, r) {
  const coin = isEth(S.pay) || S.pay === 'teth' || r.pin ? 'teth' : S.pay;
  const parts = [];
  if (q.fee != null) parts.push(['Relay fee', `${fmtUnits(q.fee, 8, 6)} ${tokenOf(coin, true).sym}`, usdOf(coin, q.fee * E10)]);
  if (q.xfee != null) parts.push(['Exit fee', `${fmtUnits(q.xfee, 8, 6)} tETH`, usdOf('teth', q.xfee * E10)]);
  if (q.tip != null) parts.push(['Deposit tip', `${fmtUnits(q.tip, 18, 6)} ETH`, usdOf(lc(R.ZERO), q.tip)]);
  if (!parts.length) return [];
  const share = q.fee != null ? Number(q.fee * E10) / Number(r.pin ? q.ethIn : q.wei) : 0, said = share >= 0.02 ? ` · ${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}% of the swap` : '';
  if (parts.every((x) => x[2] != null)) {
    const t = parts.reduce((a, x) => a + x[2], 0);
    return [['Fees', `about ${t < 1 ? `$${t.toFixed(2)}` : usd(t)}${said}`, share >= 0.05 ? 'warn' : '', parts.map((x) => `${x[0]} ${x[1]}`).join(' + ')]];
  }
  return parts.map(([k, v], i) => [k, `${v}${i === 0 ? said : ''}`]);
}
function paintQuote() {
  const q = S.q, out = $('#out'), get = tokenOf(S.get), pay = tokenOf(S.pay), rows = $('#rows'), rc = $('#rcpt'), go = $('#go'), ackbox = $('#ackbox');
  const r = picked(q), kind = kindOf(S.pay, S.get);
  out.classList.toggle('busy', !!q?.busy);
  if (r && !q.busy) { out.textContent = tidy(amtFmt(r.out, get.dec)); out.classList.remove('ph'); }
  else if (!q?.busy) { out.textContent = '0'; out.classList.add('ph'); }
  fitSize(out);
  const vo = r && !q.busy ? usdOf(S.get, r.out) : null;
  const m = q && !q.busy ? vsMarket(q, r) : null;
  $('#get-usd').innerHTML = vo != null ? `≈ ${usd(vo)}${m != null && Math.abs(m) >= 0.0005 ? ` <span class="${m <= BAD ? 'warn' : m > 0.02 ? 'ok' : 'mute'}">(${m > 0 ? '+' : '−'}${Math.abs(m * 100).toFixed(Math.abs(m) >= 0.1 ? 0 : 2)}%)</span>` : ''}` : '';
  const busy = !!q?.busy, first = busy && !r;
  rows.classList.toggle('stale', busy); rc.classList.toggle('stale', busy);
  const list = first && kind === 'tac' ? [{ k: 'precision', name: 'Precision pool' }, { k: 'tacit-amm', name: 'Tacit pool' }, { k: 'split', name: 'Both pools' }] : (q?.rows || []);
  rows.hidden = !(list.length > 1);
  if (first && !rows.hidden) rows.innerHTML = `<div class="rows-h"><span>Route</span><span>${esc(get.sym)} out</span></div>${list.map((x) => `<button type="button" role="radio" aria-checked="false" disabled><span class="rt"><b>${esc(x.name)}</b></span><span class="ra"><span>…</span></span><span class="rd" aria-hidden="true"></span></button>`).join('')}`;
  else if (!rows.hidden) {
    const top = list.reduce((a, b) => (b.out > a.out ? b : a));
    rows.innerHTML = `<div class="rows-h"><span>Route</span><span>${esc(get.sym)} out</span></div>${list.map((x) => `<button type="button" role="radio" aria-checked="${x.k === r?.k}" data-route="${esc(x.k)}"><span class="rt"><b>${esc(x.name)}</b>${noteOf(x, q) ? `<small>${noteOf(x, q)}</small>` : ''}</span><span class="ra"><span>${esc(tidy(amtFmt(x.out, get.dec)))}</span>${x === top && list.length > 1 ? '<em>best</em>' : x.out < top.out ? `<small>${(Number(top.out - x.out) * 100 / Number(top.out)).toFixed(2)}% less</small>` : ''}</span><span class="rd" aria-hidden="true"></span></button>`).join('')}`;
  }
  const lines = first ? (kind === 'private' || kind === 'pout' ? ['Price', 'Price impact', 'Relay fee'] : ['Price', 'At least', 'Price impact', 'Network fee']).map((k) => [k, '…']) : [];
  if (r) {
    const inAmt = Number(spentOf(q, r)) / 10 ** pay.dec, outAmt = Number(r.val ?? r.out) / 10 ** get.dec;
    const depth = r.priv && q.pools?.length ? `Pool depth: ${q.pools.map((p) => `${tidy(amtFmt(p.ra, 8))} ${PSYM[p.a]} · ${tidy(amtFmt(p.rb, 8))} ${PSYM[p.b]}`).join(' and ')}` : '';
    if (inAmt > 0 && outAmt > 0) lines.push(['Price', outAmt >= inAmt ? `1 ${pay.sym} = ${sig(outAmt / inAmt)} ${get.sym}` : `1 ${get.sym} = ${sig(inAmt / outAmt)} ${pay.sym}`, '', depth]);
    if (!r.priv || (r.pout && !isEth(S.get))) lines.push(['At least', `${tidy(amtFmt(r.min ?? (r.out * BigInt(10000 - S.slip)) / 10000n, get.dec))} ${get.sym}`]);
    if (r.sell?.rest > 0n) lines.push(['Plus', `about ${tidy(amtFmt(r.sell.rest, 18))} WETH`]);
    if (r.any?.hop || r.sell || r.buy || r.agg || r.pin) lines.push(['Route', r.name, '', r.agg?.quotes?.length ? `Compared with ${r.agg.quotes.length} pool${r.agg.quotes.length > 1 ? 's' : ''}` : '']);
    // what the route adds over the best single pool, and how KyberSwap's figure for the same trade compares (a reference: the swap itself goes
    // through zRouter), each shown only when it is 0.1% or more
    if (r.agg?.quotes?.length) {
      const gain = Number(r.out - r.agg.quotes[0].out) / Number(r.agg.quotes[0].out);
      if (gain >= 0.001) lines.push(['Over best pool', `+${(gain * 100).toFixed(2)}%`, 'ok', r.agg.quotes[0].name]);
    }
    if (r.ks) {
      const d = Number(r.out - r.ks) / Number(r.ks);
      if (Math.abs(d) >= 0.001) lines.push(['KyberSwap', d > 0 ? `pays ${(d * 100).toFixed(2)}% less` : `pays ${(-d * 100).toFixed(2)}% more`, d > 0 ? 'ok' : 'warn', `KyberSwap's figure: ${tidy(amtFmt(r.ks, get.dec))} ${get.sym}`]);
    }
    const tacSide = S.pay === lc(R.TAC) || S.get === lc(R.TAC);
    if (m != null && tacSide) lines.push(['Price impact', `${(Math.max(0, -m) * 100).toFixed(2)}%`, m <= GATE ? 'warn' : '']);
    else if (m != null && (!(r.agg || r.pin) || Math.abs(m) >= 0.01)) lines.push(['Against the market', m <= BAD ? `${(Math.abs(m) * 100).toFixed(1)}% below` : m >= 0.02 ? `${(m * 100).toFixed(1)}% above` : `${m >= 0 ? '+' : '−'}${(Math.abs(m) * 100).toFixed(2)}%`, m <= BAD ? 'warn' : m >= 0.02 ? 'ok' : '']);
    if (r.priv) lines.push(...feeLines(q, r));
    if (r.pout) lines.push(['Chain sees', `${get.sym} to ${S.to ? shortAddr(S.to) : W.account ? 'your wallet' : 'the address'}, not from whom`]);
    else if (r.pin) lines.push(['Chain sees', `your ${tidy(amtFmt(q.wei, pay.dec))} ${pay.sym} for ETH, then a deposit`]);
    else if (r.priv) lines.push(['Chain sees', isEth(S.pay) ? `your ${tidy(amtFmt(q.wei, 18))} ETH deposited` : 'a swap, not whose']);
    if (!r.priv && r.gas && S.gasPrice && S.px.ethUsd) { const f = Number(r.gas * S.gasPrice) / 1e18 * S.px.ethUsd; lines.push(['Network fee', `about ${f < 1 ? `$${f.toFixed(2)}` : usd(f)}`]); }
  }
  rc.hidden = !lines.length;
  rc.innerHTML = lines.map(([k, v, c, t]) => `<div${t ? ` title="${esc(t)}"` : ''}><dt>${esc(k)}</dt><dd class="${c || ''}">${esc(v)}</dd></div>`).join('');
  paintLater(q, r, kind);
  const gate = r && !q.busy && m != null && m <= GATE;
  if (busy) { } else if (gate) {
    const pub = r.priv ? '.' : ', then make it public.';
    const alt = S.get === lc(R.CUSD) ? ` <a href="/vault/#btc">Borrow cUSD at $1</a>${pub}` : S.get === lc(R.CBTC) ? ` <a href="/vault/#btc">Mint cBTC 1:1</a>${pub}` : '';
    if (!ackbox.querySelector('input') || ackbox.dataset.k !== `${S.pay}>${S.get}`) {
      ackbox.dataset.k = `${S.pay}>${S.get}`;
      const tac = S.pay === lc(R.TAC) || S.get === lc(R.TAC);
      ackbox.innerHTML = tac
        ? `<label class="ack"><input type="checkbox" id="ack"><span>Moves the price <b>${(Math.abs(m) * 100).toFixed(0)}%</b>. Swap anyway</span></label>`
        : `<label class="ack"><input type="checkbox" id="ack"><span><b>${(Math.abs(m) * 100).toFixed(0)}% under</b> market.${alt} Swap anyway</span></label>`;
      $('#ack').checked = S.ack;
    } else { ackbox.querySelector('input').checked = S.ack; ackbox.querySelector('b').textContent = `${(Math.abs(m) * 100).toFixed(0)}%${S.pay === lc(R.TAC) || S.get === lc(R.TAC) ? '' : ' under'}`; }
  } else { ackbox.innerHTML = ''; ackbox.dataset.k = ''; }
  const [label, can, cls] = button(q, r, kind, gate);
  go.textContent = label; go.disabled = !can; go.className = `go${cls ? ` ${cls}` : ''}`;
  if (!S.busy) { if (S.note) say(S.note.h, S.note.cls); else say(lineFor(q, r, kind)); }
}
function button(q, r, kind, gate) {
  const pay = tokenOf(S.pay), get = tokenOf(S.get);
  if (S.busy) return ['Working…', false];
  if (!kind) return ['Choose another pair', false];
  if (!S.amt || !parseUnits(S.amt, pay.dec)) return ['Enter an amount', false];
  if (q?.busy) return ['Finding the best price…', false];
  if (!r) return [q?.err ? 'Try again' : q?.tiny ? 'Amount too small' : 'No route', !!q?.err];
  if (kind === 'pin') {
    if (!W.account) return ['Connect wallet', true];
    const bal = S.bal[S.pay], eth = S.bal[lc(R.ZERO)], tip = q.tip || 0n;
    if (bal != null && q.wei > bal) return [`Not enough ${pay.sym}`, false];
    if (eth != null && tip + 2n * gasKeep() > eth) return ['Keep some ETH for the network fees', false];
    if (gate && !S.ack) return ['Accept the price above to swap', false];
    return ['Swap privately', true, 'priv'];
  }
  if (kind === 'pout') {
    const pb = privBal(S.pay);
    if (S.toBad) return ['Check the address', false];
    const dest = outTo();
    if (!dest) return ['Add the address it goes to', false];
    if (pb != null && q.wei > pb) return [`Not enough private ${pay.sym}`, false];
    if (gate && !S.ack) return ['Accept the price above to swap', false];
    return [S.to ? `Swap privately → ${shortAddr(dest)}` : 'Swap privately to your wallet', true, 'priv'];
  }
  if (kind === 'private') {
    // The wallet's ETH, and the private balance once the key is open here; the deposit's tip is part of what the wallet sends.
    const bal = isEth(S.pay) && W.account ? S.bal[S.pay] : null, tip = q.tip || 0n, pb = isEth(S.pay) ? null : privBal(S.pay);
    if (bal != null && q.wei > bal) return [`Not enough ${pay.sym}`, false];
    if (bal != null && q.wei + tip + gasKeep() > bal) return ['Leave some ETH for the network fee', false];
    if (pb != null && q.wei > pb) return [`Not enough private ${pay.sym}`, false];
    if (gate && !S.ack) return ['Accept the price above to swap', false];
    return [S.get === 'teth' && isEth(S.pay) ? 'Make it private' : 'Swap privately', true, 'priv'];
  }
  if (S.toBad) return ['Check the address', false];
  if (!W.account) return ['Connect wallet', true];
  if (laterOn(kind)) {
    const dep = laterDeposit(q), eth = S.bal[lc(R.ZERO)];
    if (!S.to) return ['Add the address it goes to', false];
    if (lc(S.to) === lc(W.account)) return ['Use another address than this wallet', false];
    if (dep == null) return [LATER.err ? 'Try again' : 'Reading the relay’s fee…', !!LATER.err];
    if (eth != null && dep + gasKeep() > eth) return ['Not enough ETH for the deposit', false];
    if (gate && !S.ack) return ['Accept the price above to swap', false];
    return [`Deposit ${tidy(amtFmt(dep, 18))} ETH`, true, 'priv'];
  }
  const bal = S.bal[S.pay], wei = q.wei;
  if (bal != null && wei > bal) return [`Not enough ${pay.sym}`, false];
  if (bal != null && isEth(S.pay) && S.gasPrice && wei + r.gas * S.gasPrice > bal) return ['Leave some ETH for the network fee', false];
  if (gate && !S.ack) return ['Accept the price above to swap', false];
  const to = recipient(), tail = to ? ` → ${shortAddr(to)}` : '';
  return [(isEth(S.get) || kind === 'out' ? `Sell ${pay.sym}` : isEth(S.pay) || kind === 'any' || kind === 'in' ? `Buy ${get.sym}` : `Swap ${pay.sym} for ${get.sym}`) + tail, true];
}
function lineFor(q, r, kind) {
  if (!kind) return S.inP && S.outP && S.pay === S.get ? 'Pick another coin to get.' : S.inP && tacitKey(S.get) && !S.outP ? `To take it out as ${esc(tokenOf(S.get).sym)}, <a href="/">use the Tacit app</a>.` : !S.inP && S.outP && tacitKey(S.pay) ? `To make ${esc(tokenOf(S.pay).sym)} private, <a href="/">use the Tacit app</a>.` : 'No route for this pair.';
  if (q?.err) return `<span class="err">${esc(q.err)}</span>`;
  if (!q?.busy && S.amt && (q?.none || !r) && q?.why) return esc(q.why);
  if ((kind === 'private' || kind === 'pout') && r && !q.busy) return privLine(q, r);
  return '';
}
// Private, once priced: where the vault makes cUSD or cBTC for less than this pool asks, the vault; else the farm that deepens the pool it ends in.
function privLine(q, r) {
  const m = vsMarket(q, r);
  if (m != null && m <= BAD && S.get === lc(R.CUSD)) return 'Cheaper at the vault: <a href="/vault/#btc">borrow cUSD at $1</a>.';
  if (m != null && m <= BAD && S.get === lc(R.CBTC)) return 'Cheaper at the vault: <a href="/vault/#btc">mint cBTC 1:1</a>.';
  const p = q.pools?.[q.pools.length - 1], f = p && farmOn(p);
  return f ? `<a href="/#farm/private-${Number(f.pid)}">Deepen ${esc(f.name)} privately${f.apr != null ? ` · ${esc(aprText(f.apr))} APR` : ''} →</a>` : '';
}

async function go() {
  const kind = kindOf(S.pay, S.get), r = picked();
  if (S.busy) return;
  if (!r) { if (S.q?.err) requote(true); return; }
  S.note = '';
  if (kind === 'private' || kind === 'pout' || kind === 'pin') { await privateGo(r, kind); return; }
  if (laterOn(kind)) { if (!W.account) { await connect.connect(); return; } await laterGo(); return; }
  if (!W.account) { await connect.connect(); return; }
  const from = W.account, P = { kind, r, wei: S.q.wei, floor: (r.out * BigInt(10000 - S.slip)) / 10000n, pay: S.pay, get: S.get, to: recipient() };
  if (S.toBad) return;
  S.busy = true; paintQuote();
  const before = P.to ? null : await balanceNow(P.get, from).catch(() => null);
  try {
    say('Reading the price again…');
    const tx = await prepare(P, from);
    if (!tx) return;
    say(P.to ? `Confirm the swap in your wallet. It sends the ${esc(tokenOf(P.get).sym)} to ${esc(shortAddr(P.to))}.` : 'Confirm the swap in your wallet.');
    const h = await wallet.sendTx({ to: tx.to, data: tx.data, value: tx.value || 0n, from });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    live('Swap sent');
    const rc = await wallet.receipt(h);
    if (rc.status !== '0x1') throw Object.assign(new Error(`The transaction failed (${txLink(h)}). Nothing was swapped.`), { html: true });
    const after = P.to ? null : await balanceNow(P.get, from).catch(() => null), got = before != null && after != null ? after - before : null;
    const g = tokenOf(P.get), where = P.to ? esc(shortAddr(P.to)) : 'your wallet';
    S.lastBuy = P.get === lc(R.TAC) && got > 0n ? got : null;
    if (P.to) { S.to = null; S.toOpen = false; S.toBad = ''; $('#to-in').value = ''; }
    S.amt = ''; S.q = null; S.busy = false; keepUrl(); paint();
    say(`Done ${txLink(h)}: ${isEth(P.get) ? `about ${tidy(amtFmt(P.r.out, g.dec))} ETH to ${where}` : P.to ? `about ${tidy(amtFmt(P.r.out, g.dec))} ${esc(g.sym)} sent to ${where}` : got != null && got > 0n ? `${tidy(amtFmt(got, g.dec))} ${esc(g.sym)} in your wallet` : `${esc(g.sym)} sent to your wallet`}.${!isEth(P.get) && !P.to ? ` <button type="button" class="link" data-watch="${esc(g.addr)}">Add ${esc(g.sym)} to your wallet</button>` : ''}${S.lastBuy ? ` · <button type="button" class="link" data-farm-it>Farm it</button>` : ''}`, 'ok', true);
    remember(h, `${tidy(amtFmt(P.wei, tokenOf(P.pay).dec))} ${tokenOf(P.pay).sym} → ${tidy(amtFmt(got != null && got > 0n ? got : P.r.out, g.dec))} ${g.sym}${P.to ? ` · to ${shortAddr(P.to)}` : ''}`); paintRecent();
    live('Swap done');
    readBalances().then(() => paintSides());
    readPrices().catch(() => {});
  } catch (e) {
    S.busy = false; paintQuote();
    say(e instanceof UserStopped || e?.userStopped ? 'Cancelled in your wallet. Nothing was sent.' : `<span class="err">${e?.html ? e.message : esc(e?.message || String(e)).slice(0, 300)}</span>`, '', true);
  } finally { S.busy = false; }
}
const balanceNow = async (k, who) => (isEth(k) ? BigInt(await rpc('eth_getBalance', [who, 'latest'])) : wordAt(await ethCall(k, '0x70a08231' + addrWord(who)), 0));

async function prepare(P, from) {
  const floorFor = (out) => { const f = (out * BigInt(10000 - S.slip)) / 10000n; return f > P.floor ? f : P.floor; };
  const dl = chainDeadline(1200), dest = P.to || from;
  const moved = () => { say('The price moved below the least you accept. Nothing was sent; the quote above is the new one.', '', true); S.busy = false; requote(true); return null; };
  let tx;
  if (P.kind === 'tac') {
    const dir = isEth(P.pay) ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
    const rt = await venues.route({ dir, amountIn: P.wei, account: from, gasPrice: await gasPrice() });
    const pick = P.r.split ? rt.split : (rt.r.ranked || []).find((v) => v.venue === P.r.venue.venue);
    if (!pick) { say('That route is no longer offered. Nothing was sent; press again for the new quote.', '', true); S.busy = false; requote(true); return null; }
    if (BigInt(pick.amountOut) < P.floor) return moved();
    const floor = floorFor(BigInt(pick.amountOut)), isSplit = !!P.r.split;
    const make = (permit) => (isSplit ? venues.buildSplit({ split: pick, account: from, to: dest, minOut: floor, deadline: dl, permit }) : venues.build({ quote: pick, dir, account: from, to: dest, minOut: floor, deadline: dl, permit }));
    tx = make();
    if (tx.approval) tx = await withAccess({ tx, make, from, dl, permit: pick.venue === 'precision' || isSplit });
  } else if (P.kind === 'amm') {
    const q = await R.quoteAmm({ ethCall, tokenIn: isEth(P.pay) ? R.ZERO : P.pay, tokenOut: isEth(P.get) ? R.ZERO : P.get, amountIn: P.wei });
    if (!q || q.amountOut < P.floor) return moved();
    const floor = floorFor(q.amountOut);
    let permit = null;
    if (!isEth(P.pay)) {
      const acc = await R.readAccess({ ethCall, token: P.pay, owner: from, spender: R.TACIT_AMM });
      if (acc.allowed < q.amountIn) {
        say(`Sign the permit for your ${esc(tokenOf(P.pay).sym)} in your wallet. The signature costs nothing.`);
        const accR = await R.readAccess({ ethCall, token: P.pay, owner: from, spender: R.CONF_ROUTER });
        permit = R.splitSig(await signTyped(R.permitTyped({ token: P.pay, name: 'Tacit Token', version: '1', owner: from, spender: R.CONF_ROUTER, value: q.amountIn, nonce: accR.nonce, deadline: dl }), from));
      }
    }
    tx = R.buildAmm({ quote: q, account: from, to: dest, minOut: floor, deadline: dl, permit });
  } else if (P.kind === 'any') {
    const q = await within(R.quoteAnyToTac({ ethCall, venues, token: P.pay, amountIn: P.wei, account: from, slippageBps: S.slip, deadline: dl }), 15e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!q || q.tacOut < P.floor) return moved();
    const floor = floorFor(q.tacOut), access = await anyAccess(q, from);
    tx = R.buildAnyToTac({ quote: q, account: from, to: dest, minOut: floor, keccak256: keccak_256, access });
  } else if (P.kind === 'out') {
    const q = await within(R.quoteTacitToToken({ ethCall, venues, tokenIn: P.pay, tokenOut: P.get, amountIn: P.wei, account: from, to: dest, slippageBps: S.slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!q || q.out < P.floor) return moved();
    tx = R.buildTacitToToken({ quote: q, account: from, to: dest, venues, access: await tacitAccess(P.pay, q.amountIn, from, dl) });
  } else if (P.kind === 'in') {
    { const live = await R.ammRouteLive({ ethCall }); if (live !== true) { if (live === false) S.ammRoute = false; say(live === false ? 'That swap is not available right now. Nothing was sent.' : 'Could not check that swap right now. Nothing was sent; try again.', '', true); S.busy = false; paint(); return null; } }
    const q = await within(R.quoteTokenToTacit({ ethCall, token: P.pay, tokenOut: P.get, amountIn: P.wei, account: from, to: dest, slippageBps: S.slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!q || q.out < P.floor) return moved();
    tx = R.buildTokenToTacit({ quote: q, account: from, to: dest, minOut: floorFor(q.out), access: await anyAccess(q, from) });
  } else if (P.kind === 'agg') {
    const q = await within(A.bestRoute({ ethCall, to: dest, refundTo: from, tokenIn: P.pay, tokenOut: P.get, amountIn: P.wei, slippageBps: S.slip, deadline: dl }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    // the calldata's own limits are the swap's floor: it is sent only when they still pay at least what was shown
    if (!q || q.out < P.floor || q.min < (P.r.min ?? P.floor)) return moved();
    tx = await aggTx(q, from);
  } else throw new Error('Nothing to do for this pair.');
  say('Checking it first…');
  const sim = await venues.simulate({ tx, from });
  if (!sim.ok) throw new Error('This swap would fail, so nothing was sent. Try a smaller amount or try again.');
  return tx;
}
async function withAccess({ tx, make, from, dl, permit }) {
  const acc = await R.readAccess({ ethCall, token: R.TAC, owner: from, spender: tx.approval.spender });
  if (acc.allowed >= tx.approval.amount) return tx;
  if (permit) {
    say('Sign the permit for your TAC in your wallet. The signature costs nothing.');
    const sig = R.splitSig(await signTyped(R.permitTyped({ token: R.TAC, name: 'Tacit Token', version: '1', owner: from, spender: tx.approval.spender, value: tx.approval.amount, nonce: acc.nonce, deadline: dl }), from));
    return make({ value: tx.approval.amount, deadline: dl, ...sig });
  }
  await approve(R.TAC, tx.approval.spender, tx.approval.amount, from, acc.allowed);
  return tx;
}
// How a Tacit asset reaches zRouter: the allowance it already has, else a permit signed for free.
async function tacitAccess(token, amount, from, dl) {
  const t = tokenOf(lc(token)), acc = await R.readAccess({ ethCall, token, owner: from });
  if (acc.balance < amount) throw new Error(`Not enough ${t.sym}.`);
  if (acc.allowed >= amount) return { kind: 'approved' };
  say(`Sign the permit for your ${esc(t.sym)} in your wallet. The signature costs nothing.`);
  return { kind: 'permit', value: amount, deadline: dl, ...R.splitSig(await signTyped(R.permitTyped({ token, name: 'Tacit Token', version: '1', owner: from, spender: R.ZROUTER, value: amount, nonce: acc.nonce, deadline: dl }), from)) };
}
// An aggregated route as one transaction: zQuoter's swaps, with what lets zRouter spend the token (a permit, or an allowance made first) ahead of them.
async function aggTx(q, from) {
  if (isEth(q.tokenIn)) return { to: R.ZROUTER, data: q.callData, value: q.value };
  const access = await anyAccess({ token: q.tokenIn, maxIn: q.amountIn, deadline: q.deadline }, from, { permit2: false });
  const legs = R.accessLegs(access, q.tokenIn, q.amountIn, 'aggTx');
  return { to: R.ZROUTER, data: legs.length ? R.encMulticall([...legs, ...A.legsOf(q.callData)]) : q.callData, value: q.value };
}
async function anyAccess(q, from, { permit2 = true } = {}) {
  const t = tokenOf(lc(q.token)), acc = await R.readAccess({ ethCall, token: q.token, owner: from });
  if (acc.balance < q.maxIn) throw new Error(`Not enough ${t.sym}: the swap may spend up to ${tidy(amtFmt(q.maxIn, t.dec))}.`);
  if (acc.allowed >= q.maxIn) return { kind: 'approved' };
  if (t.permit === undefined) t.permit = (await R.readToken({ ethCall, keccak256: keccak_256, address: q.token }).catch(() => null))?.permit ?? null;
  if (t.permit === 'dai') {
    say('Sign DAI’s permit in your wallet. The signature costs nothing.');
    return { kind: 'dai', nonce: acc.nonce, expiry: q.deadline, ...R.splitSig(await signTyped(R.daiPermitTyped({ owner: from, nonce: acc.nonce, expiry: q.deadline }), from)) };
  }
  if (t.permit && acc.nonce != null) {
    say(`Sign the permit for your ${esc(t.sym)} in your wallet. The signature costs nothing.`);
    return { kind: 'permit', value: q.maxIn, deadline: q.deadline, ...R.splitSig(await signTyped(R.permitTyped({ token: q.token, name: await tokenName(q.token), version: t.permit, owner: from, spender: R.ZROUTER, value: q.maxIn, nonce: acc.nonce, deadline: q.deadline }), from)) };
  }
  if (permit2 && acc.permit2 >= q.maxIn) {
    say(`Sign a Permit2 transfer of your ${esc(t.sym)} in your wallet. The signature costs nothing.`);
    const nonce = R.randomNonce();
    return { kind: 'permit2', nonce, deadline: q.deadline, signature: await signTyped(R.permit2Typed({ token: q.token, amount: q.maxIn, nonce, deadline: q.deadline }), from) };
  }
  await approve(q.token, R.ZROUTER, q.maxIn, from, acc.allowed);
  return { kind: 'approved' };
}
const NAMES = new Map();
async function tokenName(token) {
  if (NAMES.has(lc(token))) return NAMES.get(lc(token));
  const t = await R.readToken({ ethCall, keccak256: keccak_256, address: token });
  NAMES.set(lc(token), t?.name || '');
  return t?.name || '';
}
async function approve(token, spender, amount, from, had) {
  const t = tokenOf(lc(token));
  if (had > 0n && t?.sym === 'USDT') {
    say('Your USDT allowance is reset to zero first (USDT asks for this).');
    const h0 = await wallet.sendTx({ to: token, data: R.encApprove(spender, 0n), from });
    if ((await wallet.receipt(h0)).status !== '0x1') throw new Error('The reset did not go through.');
  }
  say(`Approve exactly this much ${esc(t?.sym || 'of the token')} in your wallet, once.`);
  const h = await wallet.sendTx({ to: token, data: R.encApprove(spender, amount), from });
  say(`Waiting for the approval ${txLink(h)}…`);
  if ((await wallet.receipt(h)).status !== '0x1') throw new Error('The approval did not go through.');
}
// ── Swap privately: ETH deposited now into the private ETH pool, swapped out later to an address (swap/later.js) ──
// Offered for a wallet ETH swap on the onchain route; the deposit is the swap, the relay's fee for the swap out (twice, for a fee that rises
// while it waits) and an extra the slider sets, so the deposit is not the swap; what is not swapped stays a private note.
const LATER = { on: false, pct: 25, rand: Math.random(), fee: null, feeAt: 0, err: null, offers: {} };
const PLANS_KEY = 'tacit-swap-later-v1';
const plans = () => { try { return (JSON.parse(localStorage.getItem(PLANS_KEY) || '[]') || []).filter((p) => p?.id); } catch { return []; } };
let LTP = null, LT = null;
const pageSigner = { get address() { return W.account; }, ready: async () => { if (!W.account) await connect.connect(); await wallet.ensureMainnet(); },
  send: ({ to, data, value }) => wallet.sendTx({ to, data, value: BigInt(value || 0), from: W.account }), rpc: (m, p) => rpc(m, p) };
const ltLoad = () => (LTP ||= import('/swap/later.js?cb=df9e8dec').then((m) => { LT = m.makeLater({ keyHex: async () => (await pvLoad()).keyHex(), signer: pageSigner, ethCall }); LT.mod = m; return LT; }).catch((e) => { LTP = null; throw e; }));
const laterFits = (kind) => kind === 'agg' && isEth(S.pay) && !S.inP && !S.outP;
const laterOn = (kind) => LATER.on && laterFits(kind);
// the deposit and its extra as later.js draws them (a random share around the slider's, rounded up), drawn again only when the slider moves
const laterAmounts = (q) => (q?.wei && LATER.fee != null && LT ? LT.mod.depositFor({ swapWei: q.wei, feeWei: LATER.fee, pct: LATER.pct, rand: () => LATER.rand }) : null);
const laterExtra = (q) => laterAmounts(q)?.extraWei ?? 0n;
const laterDeposit = (q) => laterAmounts(q)?.depositWei ?? null;
function readFee() {
  LATER.err = null;
  return ltLoad().then((m) => m.mod.relayFee()).then((f) => { LATER.fee = f; LATER.feeAt = Date.now(); paintQuote(); }, (e) => { LATER.err = e?.message || String(e); paintQuote(); });
}
// The box under the receipt: one row that switches it and, while it is on, the buffer and the three steps it takes. Drawn again only when it is
// switched, so the slider keeps its hold while dragged; its figures are written in place.
const eth2 = (wei) => { const n = Number(wei) / 1e18; return tidy(n >= 1 ? n.toFixed(2) : n.toPrecision(2)); };
const LATER_TIP = 'Deposit now into the private ETH pool and swap out later, so nothing on chain links your wallet to where the tokens go.';
function paintLater(q, r, kind) {
  const el = $('#later'), fits = !!r && laterFits(kind);
  el.hidden = !fits;
  if (!fits) return;
  const k = String(LATER.on);
  if (el.dataset.k !== k) {
    el.dataset.k = k;
    el.classList.toggle('on', LATER.on);
    el.innerHTML = `<button type="button" class="tgl" id="later-on" role="switch" aria-checked="${LATER.on}" title="${esc(LATER_TIP)}"><svg class="tk sm" aria-hidden="true"><use href="#tk-peth"/></svg><b>Swap privately</b><span class="pill" aria-hidden="true"></span></button>`
      + (LATER.on ? `<div class="buf"><span>Buffer</span><input type="range" id="later-x" min="5" max="100" step="5" value="${LATER.pct}" aria-label="Buffer added to the deposit, as a share of the swap"><b id="later-xv"></b></div>`
        + `<ol class="st pre" aria-label="How it goes"><li><i class="mk" aria-hidden="true">1</i><span>Deposit <b id="later-dep"></b></span></li><li><i class="mk" aria-hidden="true">2</i><span>Wait</span></li><li><i class="mk" aria-hidden="true">3</i><span>Swap</span></li></ol>` : '');
  }
  if (!LATER.on) return;
  $('#later-xv').textContent = `+${eth2(laterExtra(q))} ETH`;
  const dep = laterDeposit(q);
  $('#later-dep').textContent = dep != null ? `${eth2(dep)} ETH` : LATER.err ? '(fee unavailable)' : '…';
}
$('#later').addEventListener('click', (e) => {
  if (!e.target.closest('#later-on')) return;
  LATER.on = !LATER.on;
  if (LATER.on) { S.toOpen = true; if (LATER.fee == null) readFee(); warmPrivate(); }
  paint();
});
// the buffer moves the deposit as it is dragged; the random draw around it is made again when it is let go
$('#later').addEventListener('input', (e) => { if (e.target.id === 'later-x') { LATER.pct = Number(e.target.value); paintQuote(); } });
$('#later').addEventListener('change', (e) => { if (e.target.id === 'later-x') { LATER.rand = Math.random(); paintQuote(); } });
const laterStep = (s) => ({ 'proving on this device': 'Proving on this device…', 'confirm in your wallet': 'Confirm the deposit in your wallet…', 'waiting for it to be mined': 'Waiting for it to land…',
  'sending through the relayer': 'The relay is sending it…', 'reading the price again': 'Reading the price again…' }[s] || `${s.charAt(0).toUpperCase()}${s.slice(1)}…`);
async function laterGo() {
  const q = S.q, to = S.to, get = tokenOf(S.get);
  if (!q || !to || laterDeposit(q) == null || S.busy) return;
  if (now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }
  // the relay's fee read again if it is old: the deposit is shown again when it has moved
  if (Date.now() - LATER.feeAt > 120e3) { const was = laterDeposit(q); await readFee(); if (laterDeposit(q) !== was) { say('The relay’s fee moved, so the deposit is shown again. Check it and press once more.', '', true); return; } }
  const dep = laterDeposit(q), extra = laterExtra(q);
  S.busy = true; S.note = ''; paintQuote();
  try {
    const lt = await ltLoad();
    await lt.start({ swapWei: q.wei, extraWei: extra, token: S.get, sym: get.sym, dec: get.dec, to, depositWei: dep, onStep: (s) => say(esc(laterStep(s))) });
    LATER.on = false; S.amt = ''; S.q = null; S.to = null; S.toOpen = false; $('#to-in').value = '';
    say('<span class="ok">Deposited.</span> The swap waits below.', 'ok', true);
  } catch (e) { say(e instanceof UserStopped || e?.userStopped ? 'Nothing was sent.' : esc(e?.message || String(e)), e instanceof UserStopped ? '' : 'err', true); }
  finally { S.busy = false; keepUrl(); paint(); paintSteps(); readBalances().then(paintSides, () => {}); }
}
// Each kept swap as steps: its deposit, its wait (the pool's new notes since, once the key is open here) and its swap out, with the price to
// confirm and what went wrong in the swap's own card.
const BLEND = {};
const ago_ = (t) => { const m = Math.floor((Date.now() - t) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const stepLi = (state, n, title, detail = '', action = '') => `<li class="${state}"${state === 'now' ? ' aria-current="step"' : ''}><i class="mk" aria-hidden="true">${state === 'done' ? '✓' : state === 'fail' ? '!' : state === 'now' ? '' : n}</i><div class="t"><span>${title}</span>${detail ? `<small>${detail}</small>` : ''}</div>${action ? `<div class="a">${action}</div>` : ''}</li>`;
function paintSteps() {
  const el = $('#steps'), ps = plans().filter((p) => p.state !== 'done' || Date.now() - (p.doneAt || 0) < 864e5).slice(0, 6);
  el.hidden = !ps.length;
  el.innerHTML = ps.map((p) => {
    const b = BLEND[p.id], o = LATER.offers[p.id], id = esc(p.id), amt = tidy(amtFmt(BigInt(p.swapWei), 18));
    const link = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer" aria-label="Transaction ${esc(h.slice(0, 10))}">${esc(h.slice(0, 8))}…↗</a>`;
    const deposited = !!p.depositedAt, done = p.state === 'done', swapping = p.state === 'swapping', stopped = p.state === 'stopped', waiting = p.state === 'waiting';
    const depDoubt = !deposited && !stopped && (p.state === 'unsure' || Date.now() - p.at > 3 * 60e3);
    const swapDoubt = deposited && !done && (p.state === 'unsure' || (swapping && Date.now() - (p.swapAt || p.at) > 10 * 60e3));
    const mix = b ? `${ago_(p.depositedAt || p.at)} · ${b.since} new note${b.since === 1 ? '' : 's'} in the pool` : ago_(p.depositedAt || p.at);
    const check = `<button type="button" class="btn sm ghost" data-later-check="${id}">Check it</button>`;
    const s1 = stopped ? stepLi('fail', 1, 'Deposit', 'did not go through') : depDoubt ? stepLi('fail', 1, 'Deposit', 'not confirmed', check)
      : deposited ? stepLi('done', 1, 'Deposit', '', p.depositTx ? link(p.depositTx) : 'in the pool') : stepLi('now', 1, 'Deposit', 'sending…');
    const s2 = !deposited ? stepLi('todo', 2, 'Wait') : done || swapping || swapDoubt || (waiting && o) ? stepLi('done', 2, 'Wait', mix) : stepLi('now', 2, 'Wait', mix);
    const s3 = done ? stepLi('done', 3, 'Swap', '', p.swapTx ? link(p.swapTx) : 'done') : swapDoubt ? stepLi('fail', 3, 'Swap', 'not confirmed', check)
      : swapping ? stepLi('now', 3, 'Swap', 'sending…') : waiting && o ? stepLi('now', 3, 'Swap', 'confirm the price')
      : waiting ? stepLi('todo', 3, 'Swap', '', `<button type="button" class="btn sm" data-later-go="${id}">Swap now</button>`) : stepLi('todo', 3, 'Swap');
    const dec = Number(p.dec), self = o?.via === 'self';
    const offer = waiting && o ? `<div class="offer"><div><b>At least ${esc(tidy(amtFmt(o.min, dec)))} ${esc(p.sym)}</b>${o.ks ? `<small>KyberSwap ${esc(tidy(amtFmt(o.ks, dec)))}</small>` : ''}</div>`
      + `<div class="acts"><button type="button" class="btn sm" data-later-ok="${id}" data-via="${self ? 'self' : 'relay'}">${self ? 'Confirm from this wallet' : 'Confirm'}</button><button type="button" class="btn sm ghost" data-later-no="${id}">Cancel</button></div></div>` : '';
    const selfOk = p.refused && waiting && W.account && lc(W.account) !== p.from;
    const note = p.err && !done ? `<p class="note ${stopped || depDoubt || swapDoubt ? 'err' : 'warn'}" role="status">${esc(p.err)}${selfOk ? ` <button type="button" class="link" data-later-self="${id}">Send it from this wallet</button>` : ''}</p>` : '';
    const x = done ? `<button type="button" class="x" data-later-forget="${id}" aria-label="Hide">×</button>` : stopped ? `<button type="button" class="x" data-later-forget="${id}" aria-label="Remove">×</button>`
      : waiting ? `<button type="button" class="x" data-later-forget="${id}" data-ask="1" aria-label="Remove this swap">×</button>` : '';
    return `<section class="plan" aria-label="Private swap of ${esc(amt)} ETH to ${esc(p.sym)}"><header><svg class="tk sm" aria-hidden="true"><use href="#tk-peth"/></svg><b>${esc(amt)} ETH → ${esc(p.sym)}</b><small>to ${esc(shortAddr(p.to))}</small>${x}</header><ol class="st">${s1}${s2}${s3}</ol>${offer}${note}</section>`;
  }).join('');
}
// Swap now: the route read now (with the stand-in) and shown with KyberSwap's figure; Confirm sends it while it pays at least that.
async function laterOffer(id, via = 'relay') {
  const p = plans().find((x) => x.id === id);
  if (!p || S.busy) return;
  S.busy = true; paintQuote(); say('Reading the price…');
  try {
    const lt = await ltLoad(), [o, ks] = await Promise.all([lt.offer(p, { slippageBps: S.slip }), p.token === lc(R.ZERO) ? null : A.kyberOut({ tokenIn: R.ZERO, tokenOut: p.token, amountIn: BigInt(p.swapWei) })]);
    LATER.offers[id] = { ...o, ks, via };
    say('');
  } catch (e) { say(esc(e?.message || String(e)), 'err', true); }
  finally { S.busy = false; paint(); paintSteps(); }
}
async function laterCheck(id) {
  const p = plans().find((x) => x.id === id);
  if (!p || S.busy) return;
  S.busy = true; paintQuote(); say('Checking it against the pool…');
  try { const q = await (await ltLoad()).check(p); say(q.state === 'done' ? 'Its swap went through.' : q.state === 'waiting' ? 'It is in the pool and waits to be swapped.' : esc(q.err || 'It did not go through.'), '', true); }
  catch (e) { say(esc(e?.message || String(e)), 'err', true); }
  finally { S.busy = false; paint(); paintSteps(); }
}
// Only ever a price that was shown: no press sends at one read behind the user's back, by the relay or from a wallet.
async function laterSwap(id, via = 'relay') {
  const p = plans().find((x) => x.id === id), shown = LATER.offers[id];
  if (!p || S.busy || !shown) return;
  if (via === 'self' && !confirm('This wallet pays for the swap out and is seen sending it. Send it from this wallet?')) return;
  S.busy = true; paintQuote();
  try {
    const lt = await ltLoad();
    const done = await lt.swapOut(p, { shown, slippageBps: S.slip, via, onStep: (s) => say(esc(laterStep(s))) });
    delete LATER.offers[id];
    remember(done.swapTx, `${tidy(amtFmt(BigInt(p.swapWei), 18))} ETH → ${p.sym}, privately, to ${shortAddr(p.to)}`);
    say(`<span class="ok">Swapped.</span> ${esc(p.sym)} went to ${esc(shortAddr(p.to))}. <a href="https://etherscan.io/tx/${esc(done.swapTx)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>`, 'ok', true);
  } catch (e) { if (e?.moved) delete LATER.offers[id]; say(esc(e?.message || String(e)), 'err', true); }
  finally { S.busy = false; paint(); paintSteps(); }
}
async function readBlend() {
  const ps = plans().filter((p) => p.state === 'waiting');
  if (!ps.length || !LT || !PV?.unlocked) return;
  for (const p of ps) { try { BLEND[p.id] = await LT.blend(p); } catch { } }
  paintSteps();
}
$('#steps').addEventListener('click', (e) => {
  const g = e.target.closest('[data-later-go]'), ok_ = e.target.closest('[data-later-ok]'), no = e.target.closest('[data-later-no]'), c = e.target.closest('[data-later-check]');
  const s = e.target.closest('[data-later-self]'), f = e.target.closest('[data-later-forget]');
  if (g) laterOffer(g.dataset.laterGo);
  if (ok_) laterSwap(ok_.dataset.laterOk, ok_.dataset.via === 'self' ? 'self' : 'relay').then(readBlend, () => {});
  if (no) { delete LATER.offers[no.dataset.laterNo]; say(''); paintSteps(); }
  if (c) laterCheck(c.dataset.laterCheck);
  if (s) laterOffer(s.dataset.laterSelf, 'self');
  if (f && (!f.dataset.ask || confirm('Remove this plan? Its deposit stays in your private ETH balance, on the private ETH page.'))) { try { localStorage.setItem(PLANS_KEY, JSON.stringify(plans().filter((p) => p.id !== f.dataset.laterForget))); } catch { } paintSteps(); }
});

// ── a private swap, made on this card: the Tacit key is opened here (private.js), and the relay proves and sends each step ──
let PVP = null, PV = null;
const pickWallet = (list) => { const mine = wallet.available().find((w) => w.provider === W.prov)?.info?.uuid; return mine && list.some((x) => x.uuid === mine) ? mine : list[0]?.uuid; };
const pvLoad = () => (PVP ||= import('/swap/private.js?cb=eac5dde7').then((m) => {
  PV = m.makePrivate({ getUx, pick: pickWallet, onKey: (why) => { if (why) say(esc(why), 'err', true); else PV.read().then(paint, () => {}); paint(); } });
  PV.mod = m;
  return PV;
}).catch((e) => { PVP = null; throw e; }));
// The key's private balance of a coin, in its 18 decimals: null until the key is open here and its notes are read.
const privBal = (k) => { const id = IDS[PK[k]]; return PV?.held && id ? PV.of(id).value * E10 : null; };
async function openPrivate() {
  const pv = await pvLoad();
  try { await pv.open(); } catch (e) { if (!e?.unlockCancelled) say(esc(e?.message || String(e)), 'err'); return; }
  idsOf(await getUx());
  paint();
}
// An exit whose swap did not run (the relay refused it, or it is slow): kept in this browser until its escrow is empty, so the card can offer
// to run the swap from a wallet until the recipe's deadline, or to send the escrow's ETH on to the address after it. Public data only.
const EXITS_KEY = 'tacit-swap-exits-v1';
const readExits = () => { try { return (JSON.parse(localStorage.getItem(EXITS_KEY) || '[]') || []).filter((x) => x?.recipe && /^0x[0-9a-f]{40}$/.test(x.escrow || '')).slice(0, 8); } catch { return []; } };
const keepExits = (xs) => { try { localStorage.setItem(EXITS_KEY, JSON.stringify(xs.slice(0, 8))); } catch { } };
const saveExit = (x) => keepExits([x, ...readExits().filter((y) => y.escrow !== x.escrow)]);
function exitLine(x) {
  const late = now() > Number(x.recipe.deadline), when = new Date(Number(x.recipe.deadline) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const to = shortAddr(x.recipe.finalRecipient);
  return `${esc(x.what || 'Your ETH')} is out of the pool, at its escrow ${addrLink(x.escrow)}, but the swap to ${esc(x.sym || 'the token')} has not run${x.why ? ` (${esc(String(x.why).slice(0, 120))})` : ''}. `
    + (late ? `<button type="button" class="link" data-exit-back="${esc(x.escrow)}">Send it to ${esc(to)} as ETH</button>.`
      : `<button type="button" class="link" data-exit-run="${esc(x.escrow)}">Run the swap from your wallet</button> (anyone may: the wallet that does is seen doing it), or after ${esc(when)} send it to ${esc(to)} as ETH.`);
}
const addrLink = (a) => `<a href="https://etherscan.io/address/${esc(a)}" target="_blank" rel="noopener noreferrer">${esc(shortAddr(a))}↗</a>`;
async function exitAct(escrow, back) {
  const x = readExits().find((y) => y.escrow === escrow);
  if (!x || S.busy) return;
  if (!W.account) { await connect.connect(); return; }
  S.busy = true; paintQuote();
  try {
    const calls = await (await pvLoad()).exitCalls(x.recipe);
    say('Confirm it in your wallet…');
    const h = await wallet.sendTx({ to: calls.router, data: back ? calls.reclaim : calls.activate, from: W.account });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    if ((await wallet.receipt(h)).status !== '0x1') throw new Error('It did not go through. Nothing was lost but its network fee.');
    keepExits(readExits().filter((y) => y.escrow !== escrow));
    remember(h, back ? `Sent ${x.what || 'the ETH'} to ${shortAddr(x.recipe.finalRecipient)} as ETH` : `Swapped ${x.what || 'the ETH'} for ${x.sym || 'the token'} to ${shortAddr(x.recipe.finalRecipient)}`);
    say(`<span class="ok">Done.</span> ${back ? 'The ETH went' : 'The swap ran and paid'} to ${esc(shortAddr(x.recipe.finalRecipient))}. ${txLink(h)}`, 'ok', true);
  } catch (e) { say(esc(e instanceof UserStopped ? 'Nothing was sent.' : e?.message || String(e)), 'err', true); }
  finally { S.busy = false; paint(); }
}
// On a visit, an exit still waiting at its escrow is said again; one whose escrow has emptied (it ran, or was sent on) is forgotten.
async function checkExits() {
  const xs = readExits(), left = [];
  for (const x of xs) {
    const bal = await rpc('eth_getBalance', [x.escrow, 'latest']).then(BigInt, () => null);
    if (bal == null || bal > 0n || now() - (x.at || 0) < 900) left.push(x);
  }
  keepExits(left);
  const w = left.find((x) => now() - (x.at || 0) >= 120);
  if (w && !S.busy && !S.note) say(exitLine(w), 'err', true);
}
async function privateGo(r, kind = 'private') {
  if (kind === 'pin') return pinGo(r);
  const q = S.q, fromWallet = isEth(S.pay), units = parseUnits(S.amt, 8);
  if (!q || !units) return;
  if (fromWallet && !W.account) { await connect.connect(); return; }
  if (now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }
  const pay = tokenOf(S.pay), get = tokenOf(S.get), what = `${tidy(plain(units, 8))} ${pay.sym}`, payKey = S.pay;
  const step = (k, h) => say({
    prepare: 'Preparing the deposit…', confirm: 'Confirm the deposit in your wallet…', sent: `Deposit sent ${h ? txLink(h) : ''}. Waiting for it to land…`,
    proving: `Deposited ${h ? txLink(h) : ''}. The relay is making it private, about a minute…`, note: 'Private now. Finding its note…',
    split: 'The relay is cutting a note to the amount first, about a minute…', combine: 'The relay is combining your notes into one of the amount first, about a minute…',
    route: 'The relay is proving your private swap, about a minute…',
    exit: 'The relay is sending it out of the pool, about a minute…', exitswap: 'The relay is sending it out of the pool to be swapped, about a minute…',
    activate: `Out of the pool ${h ? txLink(h) : ''}. The relay is running the swap…`,
  }[k] || '');
  S.busy = true; S.note = ''; paintQuote();
  try {
    const pv = await pvLoad(), t = await getUx();
    idsOf(t);
    if (kind === 'pout') {
      const k0 = PK[S.pay], to = outTo(), tokenOut = S.get, eth = isEth(S.get), slip = S.slip;
      if (!to) throw new Error('Name the address it goes to, or connect a wallet. Nothing was sent.');
      const plan = { asset: IDS[k0], units, ticker: POOL_TK[k0], fee: q.fee ?? 0n, eth: IDS.eth,
        path: k0 === 'eth' ? [] : (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })),
        minOut: (q.tUnits * 99n) / 100n, label: `Swap ${what} for ${get.sym} to ${shortAddr(to)}`,
        out: { token: eth ? null : tokenOut, to, minFee: q.xmin, min: r.min, wei: r.wei,
          quote: (wei) => R.quoteEthToToken({ ethCall, to, tokenOut, amount: wei, slippageBps: slip, deadline: chainDeadline(1800) }) } };
      let res;
      try { res = await pv.swapOut(plan, { say: step }); }
      catch (e) { if (e?.stuck) { e.stuck = { ...e.stuck, what: `About ${tidy(amtFmt(r.wei, 18))} ETH`, sym: get.sym, at: now() }; saveExit(e.stuck); } throw e; }
      const got = `${tidy(amtFmt(res.out, get.dec))} ${get.sym}`;
      if (res.txHash) remember(res.txHash, `Swapped ${what} for ${got} to ${shortAddr(to)}`);
      if (S.pay === payKey) { S.amt = ''; S.q = null; }
      if (S.to === to) { S.to = null; S.toBad = ''; $('#to-in').value = ''; }
      say(`<span class="ok">Done.</span> About ${esc(got)} went to ${esc(shortAddr(to))}.${res.txHash ? ` <a href="https://etherscan.io/tx/${esc(res.txHash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>` : ''}`, 'ok', true);
      return;
    }
    const k0 = fromWallet ? 'eth' : PK[S.pay];
    const plan = { wallet: fromWallet, wei: units * E10, units, asset: IDS[k0], ticker: POOL_TK[k0], fee: q.fee ?? 0n,
      path: S.get === 'teth' && fromWallet ? [] : (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })),
      minOut: (r.out / E10) * 99n / 100n, label: `Swap ${what} for ${get.sym} privately` };
    const res = await pv.swap(plan, { wallet, from: W.account, say: step });
    const got = res.made != null ? `${tidy(plain(res.made, 8))} tETH` : `${tidy(amtFmt(res.out * E10, 18))} ${get.sym}`;
    if (res.txHash) remember(res.txHash, res.made != null ? `Made ${what} private` : `Swapped ${what} for ${got} privately`);
    if (S.pay === payKey) { S.amt = ''; S.q = null; }
    say(`<span class="ok">Done.</span> ${res.made != null ? '' : 'About '}${esc(got)} is in your private balance.${res.txHash ? ` <a href="https://etherscan.io/tx/${esc(res.txHash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>` : ''}`, 'ok', true);
  } catch (e) {
    const m = PV?.mod;
    if (e?.unlockCancelled) say('');
    else if (e instanceof UserStopped || e?.userStopped || e?.code === 4001) say('Nothing was sent.', '', true);
    else if (e?.code === 'short') say(`Not enough private ${esc(pay.sym)}${e.most ? `: at most ${esc(tidy(plain(e.most, 8)))}, after the relay’s fee to cut a note to the amount` : ''}.`, 'err', true);
    else if (e?.stuck) say(exitLine(e.stuck), 'err', true);
    else if (e?.pending) say(esc(e.message), 'err', true);
    else if (e?.kept) { if (S.pay === payKey) { S.inP = true; S.pay = 'teth'; S.amt = fitAmt(S.amt, true); S.q = null; if (!kindOf(S.pay, S.get)) fit('pay'); } say(`${esc(e.message)} Press Swap privately to swap it from there.`, 'err', true); }
    else if (e?.deposit && !e.deposit.landed) say(`${esc(m ? m.relayWords(e) : e.message)} Your deposit was sent ${e.deposit.hash ? txLink(e.deposit.hash) : ''} and is not confirmed yet. There is no need to send it again: once it lands, <a href="/teth/">finish it on the tETH page →</a>`, 'err', true);
    else if (e?.deposit) say(`${esc(m ? m.relayWords(e) : e.message)} Your ETH is in the Tacit pool ${e.deposit.hash ? txLink(e.deposit.hash) : ''}, not lost: <a href="/teth/">finish it on the tETH page →</a>`, 'err', true);
    else say(esc(m ? m.relayWords(e) : e?.message || String(e)), 'err', true);
  } finally {
    S.busy = false; keepUrl(); paint();
    if (S.pay !== payKey || !S.q) requote(true);
    PV?.read(true).then(paint, () => {});
    if (fromWallet) readBalances().then(paintSides, () => {});
  }
}
// A wallet token into the private balance: the best onchain route to ETH, paid to the wallet and held to at least the ETH the quote made
// private; then that ETH deposited and swapped in the pool, as a swap from the wallet's ETH is (private.js). Stopped between the two, the
// token is ETH in the wallet, and the card says so.
async function pinGo(r) {
  const q = S.q, from = W.account;
  if (!q?.pin || !q.ethIn) return;
  if (!from) { await connect.connect(); return; }
  if (now() - (q.at || 0) > 60) { say('The price was read again. Check it and press once more.', '', true); requote(true); return; }
  // the coins are the ones pressed for, read once: the pair cannot change while this runs, and nothing after an await reads it again
  const pay = tokenOf(S.pay), get = tokenOf(S.get), what = `${tidy(amtFmt(q.wei, pay.dec))} ${pay.sym}`, payKey = S.pay, getKey = S.get;
  S.busy = true; S.note = ''; paintQuote();
  let h = null, swapped = false;
  try {
    const pv = await pvLoad(), t = await getUx();
    idsOf(t);
    await pv.open();
    say('Reading the price again…');
    const r1 = await within(A.bestRoute({ ethCall, to: from, refundTo: from, tokenIn: payKey, tokenOut: R.ZERO, amountIn: q.wei, slippageBps: S.slip, deadline: chainDeadline(1200) }), 20e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!r1 || r1.min < q.ethIn) { say('The price moved below what was quoted. Nothing was sent; the quote above is the new one.', '', true); return; }
    const tx = await aggTx(r1, from);
    say('Checking it first…');
    if (!(await venues.simulate({ tx, from })).ok) throw new Error('The swap to ETH would fail, so nothing was sent. Try a smaller amount or try again.');
    say(`Confirm the swap of ${esc(what)} to ETH in your wallet…`);
    h = await wallet.sendTx({ to: tx.to, data: tx.data, value: tx.value || 0n, from });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    if ((await wallet.receipt(h)).status !== '0x1') throw Object.assign(new Error(`The swap to ETH failed (${txLink(h)}). Your ${esc(what)} is still in your wallet; nothing was lost but its network fee.`), { html: true });
    swapped = true;
    remember(h, `${what} → ETH, to be made private`);
    const plan = { wallet: true, wei: q.ethIn, units: q.ethIn / E10, asset: IDS.eth, ticker: 'cETH', fee: q.fee ?? 0n,
      path: getKey === 'teth' ? [] : (q.pools || []).map((p) => ({ assetNext: IDS[p.b], feeBps: p.feeBps })),
      minOut: (r.out / E10) * 99n / 100n, label: `Swap ${what} for ${get.sym} privately` };
    const step = (k, x) => say({ prepare: 'Swapped to ETH. Preparing the deposit…', confirm: 'Confirm the deposit in your wallet…', sent: `Deposit sent ${x ? txLink(x) : ''}. Waiting for it to land…`,
      proving: `Deposited ${x ? txLink(x) : ''}. The relay is making it private, about a minute…`, note: 'Private now. Finding its note…', route: 'The relay is proving your private swap, about a minute…' }[k] || '');
    const res = await pv.swap(plan, { wallet, from, say: step });
    const got = res.made != null ? `${tidy(plain(res.made, 8))} tETH` : `about ${tidy(amtFmt(res.out * E10, 18))} ${get.sym}`;
    if (res.txHash) remember(res.txHash, `Swapped ${what} for ${got} privately`);
    if (S.pay === payKey) { S.amt = ''; S.q = null; }
    say(`<span class="ok">Done.</span> ${esc(got)} is in your private balance.${res.txHash ? ` <a href="https://etherscan.io/tx/${esc(res.txHash)}" target="_blank" rel="noopener noreferrer">What the chain sees ↗</a>` : ''}`, 'ok', true);
  } catch (e) {
    const m = PV?.mod, why = esc(m ? m.relayWords(e) : e?.message || String(e));
    // after the swap to ETH the card is turned to what is now held, so a second press never swaps the token again
    const turn = (inP, k, amt) => { S.inP = inP; S.pay = k; S.amt = amt; S.q = null; if (!kindOf(S.pay, S.get)) fit('pay'); };
    if (e?.unlockCancelled) say('');
    else if ((e instanceof UserStopped || e?.userStopped) && !swapped) say('Nothing was sent.', '', true);
    else if (e?.html && !swapped) say(e.message, 'err', true);
    else if (e?.kept) { turn(true, 'teth', tidy(plain(q.ethIn / E10, 8))); say(`${esc(e.message)} Press Swap privately to swap it from there.`, 'err', true); }
    else if (e?.deposit && !e.deposit.landed) { turn(false, lc(R.ZERO), ''); say(`${why} Your deposit was sent ${e.deposit.hash ? txLink(e.deposit.hash) : ''} and is not confirmed yet. There is no need to send it again: once it lands, <a href="/teth/">finish it on the tETH page →</a>`, 'err', true); }
    else if (e?.deposit) { turn(false, lc(R.ZERO), ''); say(`${why} Your ETH is in the Tacit pool ${e.deposit.hash ? txLink(e.deposit.hash) : ''}, not lost: <a href="/teth/">finish it on the tETH page →</a>`, 'err', true); }
    else if (swapped) { turn(false, lc(R.ZERO), tidy(plain(q.ethIn, 18))); say(`Your ${esc(what)} is ETH in your wallet now ${txLink(h)}, but it was not made private: ${e instanceof UserStopped || e?.userStopped ? 'the deposit was cancelled' : why}. The card now swaps from that ETH: press again to try.`, 'err', true); }
    else if (h) say(`The swap to ETH was sent ${txLink(h)} but its result could not be read: ${why}. Check your wallet before swapping again.`, 'err', true);
    else say(e?.html ? e.message : why, 'err', true);
  } finally {
    S.busy = false; keepUrl(); paint();
    if (!S.q) requote(true);
    PV?.read(true).then(paint, () => {});
    readBalances().then(paintSides, () => {});
  }
}

function openPicker(side) {
  if (!(TL.rows.length && Date.now() - TL.at < TL.day)) loadList().then(() => { if (!$('#pk').hidden && side === 'pay' && !$('#pk-q')?.value && TL.rows.length) openPicker(side); });
  const pk = $('#pk'), keys = side === 'pay' ? payList() : getList(), cur = side === 'pay' ? S.pay : S.get;
  const row = (k) => {
    const priv = side === 'pay' ? S.inP : S.outP, t = tokenOf(k, priv);
    if (!t) return '';
    const bal = !priv ? S.bal[k] : null, other = side === 'pay' ? S.get : S.pay;
    const ok = side === 'pay' ? kindOf(k, other) || kindOf(k, defaultFor(k)) : kindOf(other, k) || true;
    return `<button type="button" class="pk-r${ok ? '' : ' off'}" data-k="${esc(k)}" aria-current="${k === cur}">${coin(t)}<span><b>${esc(t.sym)}</b><small>${esc(priv ? 'private' : t.custom ? `${t.addr.slice(0, 8)}…${t.addr.slice(-6)}` : t.name)}</small></span><em>${bal ? esc(amtFmt(bal, t.dec)) : ''}</em></button>`;
  };
  const groups = (side === 'pay' ? S.inP : S.outP) ? [[null, keys]]
    : side === 'pay' ? [[null, keys.filter((k) => isEth(k) || tacitKey(k))], ['Any token', held(keys.filter((k) => !isEth(k) && !tacitKey(k)))]]
    : tacitKey(S.pay) ? [[null, keys.filter((k) => isEth(k) || tacitKey(k))], ['Any token', keys.filter((k) => !isEth(k) && !tacitKey(k))]]
    : [[null, keys]];
  pk.innerHTML = `<div class="pk-s" role="dialog" aria-modal="true" aria-label="${side === 'pay' ? 'Pay with' : 'Get'}"><div class="pk-h"><b>${side === 'pay' ? 'Pay with' : 'Get'}</b><button type="button" class="pk-x" aria-label="Close">×</button></div>${!(side === 'pay' ? S.inP : S.outP) ? '<input class="pk-q" id="pk-q" placeholder="Search, or paste a token address" autocomplete="off" spellcheck="false" aria-label="Search tokens or paste an address">' : ''}<div class="pk-l" id="pk-l">${groups.map(([g, ks]) => `${g ? `<p class="pk-g">${esc(g)}</p>` : ''}${ks.map(row).join('')}`).join('')}<p class="pk-n" id="pk-n"></p></div></div>`;
  pk.hidden = false;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...pk.querySelectorAll('button, input')].filter((x) => !x.hidden), a = document.activeElement;
    if (!f.length) return;
    if (e.shiftKey ? a === f[0] || !pk.contains(a) : a === f[f.length - 1] || !pk.contains(a)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
  };
  const close = () => { document.removeEventListener('keydown', onKey, true); pk.hidden = true; pk.innerHTML = ''; $(side === 'pay' ? '#pay-coin' : '#get-coin').focus(); };
  document.addEventListener('keydown', onKey, true);
  pk.querySelector('.pk-x').onclick = close;
  pk.onclick = (e) => {
    if (e.target === pk) return close();
    const b = e.target.closest('[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    if (b.dataset.add) { const t = JSON.parse(b.dataset.add); S.custom = [t, ...S.custom.filter((x) => x.addr !== t.addr)].slice(0, 20); try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(S.custom)); } catch { } readBalances().then(paintSides); }
    choose(side, k); close();
  };
  const qEl = $('#pk-q');
  if (qEl) {
    qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); [...pk.querySelectorAll('.pk-r')].find((b) => !b.hidden)?.click(); } });
    let seq = 0;
    qEl.oninput = async () => {
      const v = qEl.value.trim(), my = ++seq, l = $('#pk-l');
      l.querySelectorAll('.pk-r').forEach((b) => { const t = tokenOf(b.dataset.k); b.hidden = !!v && !/^0x/i.test(v) && !`${t.sym} ${t.psym || ''} ${t.name}`.toLowerCase().includes(v.toLowerCase()); });
      l.querySelector('[data-add]')?.remove();
      $('#pk-n').textContent = '';
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return;
      const k = lc(v);
      if (tokenOf(k)) { l.querySelectorAll('.pk-r').forEach((b) => { b.hidden = b.dataset.k !== k; }); return; }
      $('#pk-n').textContent = 'Reading the token…';
      const t = await R.readToken({ ethCall, keccak256: keccak_256, address: k }).catch(() => null);
      if (my !== seq) return;
      if (!t) { $('#pk-n').textContent = 'No token at that address on Ethereum.'; return; }
      const add = { addr: k, sym: t.sym, name: t.name, dec: t.dec, permit: t.permit, icon: null, custom: true };
      $('#pk-n').insertAdjacentHTML('beforebegin', `<button type="button" class="pk-r" data-k="${esc(k)}" data-add="${esc(JSON.stringify(add))}">${letter(add, '')}<span><b>${esc(t.sym)}</b><small>${esc(t.name)}</small></span><em>Add</em></button>`);
      $('#pk-n').textContent = 'Check the address: anyone can make a token with any name.';
    };
  }
  setTimeout(() => (qEl || pk.querySelector('[aria-current="true"]') || pk.querySelector('.pk-r'))?.focus(), 0);
}
const held = (ks) => ks.map((k, i) => ({ k, i, v: S.bal[k] ? (usdOf(k, S.bal[k]) ?? 1e-9) : 0 })).sort((a, b) => b.v - a.v || a.i - b.i).map((x) => x.k);
const defaultFor = (k) => (isEth(k) ? lc(R.TAC) : tacitKey(k) ? lc(R.ZERO) : lc(R.TAC));
function keepAmt(change) { const was = S.pay; change(); if (S.pay !== was) S.amt = ''; S.note = ''; }
function choose(side, k) {
  if (S.busy) return;
  keepAmt(() => { if (side === 'pay') { S.pay = k; fit('pay'); } else { S.get = k; fit('get'); } });
  S.q = null; S.pick = null; S.hold = false; keepUrl(); paint(); requote(true);
}

let farmUi = null;
async function readFarms() {
  const [prog, f, spot] = await Promise.all([api('/farm/program?network=mainnet'), readPrecision(({ to, data }) => ethCall(to, data)), readSpot(batch)]);
  const out = [{ k: 'precision', name: 'Precision farm', note: 'public', apr: f?.apr ?? null, icons: ['tac', 'eth'] }];
  for (const p of privateFarms(prog, f?.tacEth || 0, { ethUsd: spot.ethUsd ?? S.px.ethUsd, btcUsd: spot.btcUsd ?? S.px.btcUsd })) out.push({ k: `p${p.pid}`, pid: p.pid, name: p.name, note: 'private', apr: p.apr, icons: p.icons });
  S.farms = out;
}
function paintEarn() {
  const list = S.farms || [{ k: 'precision', name: 'Precision farm', note: 'public', icons: ['tac', 'eth'] }];
  $('#farms').innerHTML = list.map((f) => `<button type="button" role="radio" class="c" aria-checked="${f.k === S.farm}" data-farm="${esc(f.k)}"><span class="pairtk">${f.icons.map((i) => `<svg class="tk sm" aria-hidden="true"><use href="#tk-${esc(i)}"/></svg>`).join('')}</span><span class="rt"><b>${esc(f.name)}</b><small>${esc(f.note)}</small></span><span class="ra"><span>${f.apr != null ? esc(aprText(f.apr)) : S.farms ? '—' : '…'}</span><small>APR now</small></span><span class="rd" aria-hidden="true"></span></button>`).join('');
  const f = list.find((x) => x.k === S.farm) || list[0];
  $('#farm').hidden = f.k !== 'precision';
  $('#privfarm').hidden = f.k === 'precision';
  if (f.k === 'precision' && !farmUi) {
    farmUi = import('/trade/farm.js?cb=0fa1ad1e').then(({ mountFarm }) => mountFarm($('#farm'), { ethCall, batch, rpc, api, wallet, W, connect: () => connect.connect(), fmtUnits, parseUnits, esc, usd, ethUsd: () => S.px.ethUsd, txLink, onDone: () => readBalances().then(paintSides) }));
  }
  if (f.k !== 'precision') {
    $('#privfarm').innerHTML = `<a class="go priv" href="/#farm/private-${f.pid}">Farm ${esc(f.name)} privately →</a>`;
  }
}
function farmIt() {
  const got = S.lastBuy;
  S.tab = 'earn'; S.farm = 'precision'; paint(); paintEarn(); keepUrl();
  if (!S.farms) readFarms().then(paintEarn, paintEarn);
  const host = $('#farm');
  Promise.resolve(farmUi).then(() => {
    host.querySelector('[data-fm="tac"]')?.click();
    const i = host.querySelector('#fm-tacamt');
    if (i && got) { i.value = plain(got); i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); }
  });
}

function keepUrl() {
  const p = new URLSearchParams(), sym = (k) => { const t = tokenOf(k); return t?.custom ? t.addr : t?.sym; };
  if (S.tab === 'swap' && !S.btc) {
    if (S.pay !== lc(R.ZERO)) p.set('from', sym(S.pay));
    if (S.get !== lc(R.TAC)) p.set('to', sym(S.get));
    if (S.amt) p.set('amt', S.amt);
    if (S.inP || S.outP) p.set('private', S.inP && S.outP ? 'both' : S.inP ? 'from' : 'to');
  }
  const qs = p.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${S.tab === 'earn' ? '#earn' : S.btc ? '#bitcoin' : ''}`);
}
function readUrl() {
  const p = new URLSearchParams(location.search), find = (v) => { if (!v) return null; const x = lc(v); return x === 'teth' ? 'teth' : (listed().find((t) => nameIs(t, x) || t.addr === x)?.addr) || null; };
  const pv = p.get('private'), f = find(p.get('from')), t = find(p.get('to'));
  if (pv != null) {
    S.outP = pv !== 'from';
    S.inP = pv === 'from' || pv === 'both' || (pv === '' && !!f && !isEth(f));
  }
  const side = (k, priv) => (priv ? (isEth(k) ? 'teth' : k) : k === 'teth' ? lc(R.ZERO) : k);
  if (f) S.pay = side(f, S.inP); else if (S.inP) S.pay = 'teth';
  if (t) S.get = side(t, S.outP); else if (S.outP) S.get = S.pay === 'teth' ? lc(R.TAC) : 'teth';
  if (!kindOf(S.pay, S.get)) fit(t ? 'get' : 'pay');
  const a = p.get('amt');
  if (a && (f || !p.get('from')) && parseUnits(a, tokenOf(S.pay).dec)) S.amt = fitAmt(a);
  if (location.hash === '#earn') S.tab = 'earn';
  else if (location.hash === '#bitcoin') S.btc = true;
}

function slipPaint() { $('#slip').innerHTML = [10, 50, 100, 300].map((b) => `<button type="button" data-slip="${b}" aria-pressed="${S.slip === b}">${b / 100}%</button>`).join(''); }
$('#slip').addEventListener('click', (e) => { const b = e.target.closest('[data-slip]'); if (!b) return; S.slip = Number(b.dataset.slip); try { localStorage.setItem(SLIP_KEY, String(S.slip)); } catch { } slipPaint(); if (S.q) requote(true); else paintQuote(); });
$('#amt').addEventListener('input', (e) => { S.amt = fitAmt(e.target.value.trim()); S.note = ''; fitSize(e.target); keepUrl(); paintSides(); requote(); });
$('#amt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#go').disabled) $('#go').click(); });
$('#pay-coin').addEventListener('click', () => openPicker('pay'));
for (const ev of ['pointerenter', 'focus', 'touchstart']) $('#pay-coin').addEventListener(ev, () => { loadList(); }, { once: true, passive: true });
$('#get-coin').addEventListener('click', () => openPicker('get'));
$('#flip').addEventListener('click', () => {
  if (S.busy || !kindOf(S.get, S.pay)) return;
  const r = picked(), out = r && !S.q?.busy ? tidy(plain(r.out, tokenOf(S.get).dec)) : '';
  [S.pay, S.get] = [S.get, S.pay]; S.note = '';
  S.amt = out ? tidy(out.replace(/(\.\d{8})\d+$/, '$1')) : S.amt; S.q = null; S.pick = null; S.hold = false; keepUrl(); paint(); requote(true);
});
$('#get-where').addEventListener('click', () => { if (S.outP) return; S.toOpen = !S.toOpen; paintSides(); if (S.toOpen) $('#to-in').focus(); });
$('#to-in').addEventListener('input', (e) => { const r = recipientOf(e.target.value); S.to = r.addr; S.toBad = r.bad; S.note = ''; paint(); });
$('#to-in').addEventListener('keydown', (e) => { if (e.key === 'Escape') { S.toOpen = false; paintSides(); $('#get-where').focus(); } });
$('#go').addEventListener('click', go);
$('#rows').addEventListener('click', (e) => { const b = e.target.closest('[data-route]'); if (!b) return; S.pick = b.dataset.route; S.hold = true; S.ack = false; S.ackKey = `${S.pay}>${S.get}:${S.amt}:${S.pick}`; paintQuote(); });
$('#p-swap').addEventListener('click', (e) => {
  const q = e.target.closest('[data-quick]');
  if (q) { S.amt = q.dataset.quick; S.note = ''; keepUrl(); paintSides(); requote(true); return; }
  if (e.target.closest('#max') && S.inP && PV) {
    const was = S.pay, k = PK[S.pay];
    PV.most(IDS[k], POOL_TK[k]).then((v) => { if (v == null || S.pay !== was) return; S.amt = tidy(plain(v, 8)); S.note = ''; keepUrl(); paintSides(); requote(true); }, () => {});
    return;
  }
  if (e.target.closest('#max')) {
    const t = tokenOf(S.pay), bal = S.inP ? privBal(S.pay) : S.bal[S.pay];
    if (bal == null) return;
    // Max keeps half again the network fee it checks against, so a gas price that ticks up before the button is drawn does not undo it
    const keep = isEth(S.pay) ? (gasKeep() * 3n) / 2n + (S.outP ? tipKeep() : 0n) : 0n, v = bal > keep ? bal - keep : 0n;
    S.amt = tidy(fitAmt(plain(v, t.dec))); S.note = ''; keepUrl(); paintSides(); requote(true); return;
  }
  if (e.target.closest('[data-watch]')) { const t = tokenOf(e.target.closest('[data-watch]').dataset.watch); if (t) wallet.watchAsset({ address: t.addr, symbol: t.sym, decimals: t.dec }); return; }
  if (e.target.closest('[data-farm-it]')) farmIt();
  if (e.target.closest('#pv-open')) openPrivate().catch(() => {});
  const xr = e.target.closest('[data-exit-run], [data-exit-back]');
  if (xr) exitAct(xr.dataset.exitRun || xr.dataset.exitBack, !!xr.dataset.exitBack).catch(() => {});
});
$('#ackbox').addEventListener('change', (e) => { if (e.target.id === 'ack') { S.ack = e.target.checked; paintQuote(); } });
// the farms are read once Private is open: the line under a private quote names the one that deepens its pool
const farmsSoon = () => { if (!S.farms) readFarms().then(() => { if ((S.inP || S.outP) && S.q?.pools) paintQuote(); }, () => {}); };
for (const el of document.querySelectorAll('.sides [data-p="1"]')) for (const ev of ['pointerenter', 'focus', 'touchstart']) el.addEventListener(ev, warmPrivate, { once: true, passive: true });
document.querySelector('.mode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]'); if (!b) return;
  if (b.dataset.mode === 'bitcoin') { setBtc(!S.btc); return; }
  if (S.btc) setBtc(false);
});
for (const g of document.querySelectorAll('.sides')) {
  g.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) setSide(g.dataset.side, b.dataset.p === '1'); });
  arrows(g, 'data-p');
}
// The Bitcoin lane is another module, loaded the first time it opens: it swaps in the Bitcoin pool with a Tacit key, apart from this page's wallet
// and routes. The wallet connected here only helps open that key.
let lane = null;
const pageWallet = () => (W.account && W.prov && !W.prov.isWalletConnect ? { uuid: W.uuid, address: W.account } : null);
async function openLane() {
  try {
    lane ||= (await import('/swap/bitcoin.js?cb=3c634104')).makeBitcoinLane({ host: $('#btc'), notify: (m) => live(m), wallet: pageWallet, onBridged: paintNudge });
    if (S.btc) await lane.show();
  } catch (e) { $('#btc').innerHTML = `<p class="q err">The Bitcoin lane could not be loaded: ${esc(e?.message || e)}</p>`; lane = null; }
}
function setBtc(on) {
  if (S.btc === on) return;
  S.btc = on; keepUrl(); paint();
  if (on) openLane(); else lane?.hide();
}
function setTab(t) { if (S.tab === t) return; S.tab = t; keepUrl(); paint(); if (t === 'earn') { paintEarn(); if (!S.farms) readFarms().then(paintEarn, paintEarn); } }
$('#tab-swap').addEventListener('click', () => setTab('swap'));
$('#tab-earn').addEventListener('click', () => setTab('earn'));
$('.sw-h').addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { setTab(S.tab === 'swap' ? 'earn' : 'swap'); $(`#tab-${S.tab}`).focus(); } });
$('#farms').addEventListener('click', (e) => { const b = e.target.closest('[data-farm]'); if (!b) return; S.farm = b.dataset.farm; paintEarn(); });
addEventListener('hashchange', () => { setTab(location.hash === '#earn' ? 'earn' : 'swap'); if (location.hash !== '#earn') setBtc(location.hash === '#bitcoin'); });
function arrows(box, attr) {
  box.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    const rs = [...box.querySelectorAll('[role="radio"]:not(:disabled)')], i = rs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = rs[(i + d + rs.length) % rs.length], k = next.getAttribute(attr);
    next.click();
    ([...box.querySelectorAll(`[${attr}]`)].find((x) => x.getAttribute(attr) === k) || next).focus();
  });
}
arrows(document.querySelector('.mode'), 'data-mode'); arrows($('#rows'), 'data-route'); arrows($('#farms'), 'data-farm');

readUrl();
const FIRST_PAIR = `${S.pay}>${S.get}`;
{
  const q = new URLSearchParams(location.search), named = [q.get('from'), q.get('to')].filter((v) => v && !/^0x/i.test(v));
  if (named.some((v) => !listed().some((t) => nameIs(t, lc(v))) && lc(v) !== 'teth')) loadList().then(() => { const was = S.pay; readUrl(); if (S.pay !== was) { S.q = null; paint(); if (S.amt) requote(true); } });
}
{
  const f = new URLSearchParams(location.search).get('from');
  if (/^0x[0-9a-fA-F]{40}$/.test(f || '') && !tokenOf(lc(f))) R.readToken({ ethCall, keccak256: keccak_256, address: lc(f) }).then((t) => {
    if (!t) return;
    S.custom = [{ addr: lc(f), sym: t.sym, name: t.name, dec: t.dec, permit: t.permit, icon: null, custom: true }, ...S.custom].slice(0, 20);
    S.inP = false; S.pay = lc(f); if (!kindOf(S.pay, S.get)) S.get = lc(R.TAC);
    const a = new URLSearchParams(location.search).get('amt'); if (a && parseUnits(a, t.dec)) S.amt = a;
    paint(); readBalances().then(paintSides); if (S.amt) requote(true);
  }).catch(() => {});
}
slipPaint();
paint();
if (S.btc) openLane();
if ([S.pay, S.get].some((k) => { const t = tokenOf(k); return t && !SPRITE.has(t.icon) && !LOGO[k]; })) loadList();
if (S.tab === 'swap' && matchMedia('(pointer: fine)').matches && !location.hash) $('#amt').focus({ preventScroll: true });
if (S.tab === 'earn') { paintEarn(); }
if (S.inP || S.outP) { warmPrivate(); farmsSoon(); if (S.amt) requote(true); }
readPrices().then(() => { paint(); if (S.amt && !(S.inP || S.outP)) requote(true); if (S.tab === 'earn') readFarms().then(paintEarn, paintEarn); }).catch(() => { if (S.amt && !(S.inP || S.outP)) requote(true); });
gasPrice();
checkAmmRoute().then(() => {
  if (S.ammRoute !== true || S.busy || `${S.pay}>${S.get}` !== FIRST_PAIR) return;
  readUrl();
  if (`${S.pay}>${S.get}` !== FIRST_PAIR) { S.q = null; paint(); readBalances().then(paintSides); if (S.amt) requote(true); }
});
checkExits().catch(() => {});
paintSteps();
if (plans().some((p) => p.state === 'waiting')) ltLoad().then(readBlend, () => {});
PN.load().then(() => { if (S.q?.rows && !S.q.busy) paintQuote(); }, () => {});
let ticked = 0, routeAt = now();
const tick = () => {
  if (document.hidden || now() - ticked < 10) return;
  ticked = now();
  readPrices().catch(() => {});
  if (now() - routeAt > 300) { routeAt = now(); checkAmmRoute(); }
  if (S.q && !S.busy && !S.q.busy && now() - (S.q.at || 0) > (['any', 'out', 'in', 'pout'].includes(S.q.kind) ? 55 : 25)) requote(true);
};
setInterval(tick, 30e3);
setInterval(() => { if (!document.hidden) readBlend(); }, 30e3);
document.addEventListener('visibilitychange', tick);
