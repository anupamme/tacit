// tacit.finance/swap: one card that swaps into Tacit's tokens and farms them.
//
// To your wallet: ETH ⇄ TAC at the best of the Precision pool, the Tacit pool's public door and a split of the two (the trade page's
// venues); any other token → TAC in one transaction (zQuoter's best pool to WETH, then PrecisionRoute; swap/route.js); ETH ⇄ cUSD and
// cBTC in the Tacit pool's public door. Every quote is set beside the market price (Chainlink's ETH and BTC, cUSD's dollar, the
// Precision pool for TAC), and a buy far below it has to be acknowledged first. A token is spent by a permit where it has one.
// Private: the same pool's private door, priced here and handed to the front page's console, which holds the tacit1 key and proves it.
// Earn: the Precision farm (trade/farm.js) in the card, the private farms by link.
import { keccak_256 } from '/vendor/tacit-deps.min.js';
import { makeEvmTradeVenues, _internal as V, MULTICALL3 } from '/evm-trade-venues.js?cb=f6e1b626';
import { makeConnect, UserStopped } from '/trade/connect.js?cb=4a8e3482';
import { rpc, api, esc, fmtUnits, parseUnits, plain, usd, sig, $, E10, E18 } from '/trade/util.js?cb=782a003c';
import * as R from '/swap/route.js?cb=6eafe8b3';
import { makePointsNote } from '/points-note.js?cb=eacef061';

const CHAINLINK = { eth: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', btc: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' };
const PRECISION_POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E', FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0';
const CETH_ID = R.POOL_ID[R.ZERO];
const now = () => Math.floor(Date.now() / 1000);
const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const wordAt = (h, i) => BigInt('0x' + (strip(h).slice(i * 64, (i + 1) * 64) || '0'));
const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
const lc = (a) => String(a).toLowerCase();

// ── reading the chain ──
const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: '0x' + BigInt(o.value).toString(16) } : {}), ...(o.gas ? { gas: o.gas } : {}) }, block]);
const batch = async (calls) => V.decAggregate3(await ethCall(MULTICALL3, V.encAggregate3(calls)), calls.length);
const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak_256 });
// zQuoter reads every pool it knows in one call: a node slow to answer is not waited on past ten seconds.
const within = (p, ms, why) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(why)), ms))]);
// What each ETH → TAC route says it earns in the points program (the terms are read once, never waited for): the Precision pool's share of the
// ETH is what scores, so the Tacit pool earns none and a split earns on its first leg.
const PN = makePointsNote({ read: () => fetch('https://api.tacit.finance/leaderboard?day=today&limit=1', { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)) });
const noteOf = (x, q) => [x.note, q?.dir === 'ETH_TO_TAC' ? PN.floor(x.k === 'precision' ? q.wei : x.k === 'split' ? x.split?.legs?.[0]?.amountIn : 0n) : ''].filter(Boolean).join(' · ');
const txLink = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}…↗</a>`;

// ── the tokens ──
// Each is known by its address in lower case (ETH by the zero address); tETH has no address of its own here, being private only.
const TETH = { sym: 'tETH', name: 'Ether, private', addr: 'teth', dec: 18, icon: 'teth', priv: true };
const CUSTOM_KEY = 'tacit-swap-tokens-v1';
const S = {
  tab: 'swap', mode: 'wallet', pay: lc(R.ZERO), get: lc(R.TAC), amt: '', slip: 50, pick: null, hold: false, q: null, seq: 0, busy: false, ack: false, max: false,
  custom: [], bal: {}, px: {}, gasPrice: null, chainT: 0, chainAt: 0, farm: 'precision', farms: null, lastBuy: null, note: '', ackKey: '',
};
const SLIP_KEY = 'tacit-swap-slip-v1';
try { const v = Number(localStorage.getItem(SLIP_KEY)); if ([10, 50, 100, 300].includes(v)) S.slip = v; } catch { /* storage is a convenience */ }
try { S.custom = (JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]') || []).filter((t) => /^0x[0-9a-f]{40}$/.test(t?.addr) && Number.isInteger(t.dec)).slice(0, 20); } catch { /* storage is a convenience */ }
// The tokens offered: ETH and Tacit's, then the mainnet ERC-20s of token.list.wei (an onchain list: registry, ranked ids, one JSON each, its
// logo inline), the page's own known ones among them for their permits, then any pasted here.
const TL = { reg: '0x0000006013df75a31678b786061c2b54bf531524', key: 'tacit-swap-list-v1', day: 864e5, rows: [], at: 0, p: null };
const SKIP = new Set(['0xae7ab96520de3a18e5e111b5eaab095312d7fe84']);              // stETH: a transfer moves a wei less than asked, which an exact leg refuses
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
try { const c = JSON.parse(localStorage.getItem(TL.key) || 'null'); if (c?.rows) { takeList(c.rows); TL.at = c.at || 0; } } catch { /* storage is a convenience */ }
function loadList() {
  if (Date.now() - TL.at < TL.day && TL.rows.length) return Promise.resolve();
  return (TL.p ||= (async () => {
    const ids = strip(await ethCall(TL.reg, '0xdf7ca268')), n = Math.min(Number(wordAt(ids, 1)), 400);
    const r = await batch(Array.from({ length: n }, (_, i) => ({ to: TL.reg, data: '0x74e18e96' + word(wordAt(ids, 2 + i)) })));
    const rows = r.map((x) => { try { const h = strip(x), len = Number(wordAt(h, 1)); return JSON.parse(new TextDecoder().decode(Uint8Array.from(h.slice(128, 128 + len * 2).match(/../g).map((b) => parseInt(b, 16))))); } catch { return null; } }).filter(Boolean);
    takeList(rows); TL.at = Date.now();
    try { localStorage.setItem(TL.key, JSON.stringify({ at: TL.at, rows: rows.filter((o) => o.c === 1 || o.c === 0) })); } catch { /* storage is a convenience */ }
    paintSides(); if (W.account) readBalances().then(paintSides);
  })().catch(() => {}).finally(() => { TL.p = null; }));
}
const listed = () => {
  const known = R.TOKENS.map((t) => ({ ...t, addr: lc(t.addr) })), have = new Set(known.map((t) => t.addr));
  return [...known, ...TL.rows.filter((t) => !have.has(t.addr) && (have.add(t.addr), true)), ...S.custom.filter((t) => !have.has(t.addr))];
};
const tokenOf = (k) => (k === 'teth' ? TETH : listed().find((t) => t.addr === k)) || null;
const isEth = (k) => k === lc(R.ZERO);
const tacitKey = (k) => R.tacitToken(k);
const KEY = { [lc(R.ZERO)]: 'ether', teth: 'eth', [lc(R.TAC)]: 'tac', [lc(R.CUSD)]: 'cusd', [lc(R.CBTC)]: 'cbtc' };
const POOLID = (k) => (k === 'teth' ? CETH_ID : R.POOL_ID[Object.keys(R.POOL_ID).find((a) => lc(a) === k)]);

// What a pair is, where it arrives: 'tac' (ETH ⇄ TAC, the venues), 'amm' (ETH ⇄ cUSD/cBTC), 'any' (a token → TAC), 'private', or null.
function kindOf(pay, get, mode = S.mode) {
  if (pay === get) return null;
  if (mode === 'private') return KEY[pay] && KEY[get] && get !== lc(R.ZERO) ? 'private' : null;
  if (get === 'teth' || pay === 'teth') return null;
  if (isEth(pay)) return get === lc(R.TAC) ? 'tac' : (get === lc(R.CUSD) || get === lc(R.CBTC)) ? 'amm' : null;
  if (isEth(get)) return pay === lc(R.TAC) ? 'tac' : (pay === lc(R.CUSD) || pay === lc(R.CBTC)) ? 'amm' : null;
  return get === lc(R.TAC) && !tacitKey(pay) ? 'any' : null;
}
const payList = () => (S.mode === 'private' ? [lc(R.ZERO), 'teth', lc(R.TAC), lc(R.CUSD), lc(R.CBTC)] : listed().map((t) => t.addr));
const getList = () => (S.mode === 'private' ? ['teth', lc(R.TAC), lc(R.CUSD), lc(R.CBTC)] : [lc(R.TAC), lc(R.CUSD), lc(R.CBTC), lc(R.ZERO)]);
// The side not chosen follows the one that was, when the pair it leaves has no route.
function fit(changed) {
  if (kindOf(S.pay, S.get)) return;
  if (changed === 'pay') S.get = S.mode === 'private' ? (S.pay === lc(R.TAC) ? 'teth' : lc(R.TAC)) : isEth(S.pay) ? lc(R.TAC) : tacitKey(S.pay) ? lc(R.ZERO) : lc(R.TAC);
  else S.pay = S.mode === 'private' ? lc(R.ZERO) : isEth(S.get) ? lc(R.TAC) : lc(R.ZERO);
  if (!kindOf(S.pay, S.get)) { S.pay = lc(R.ZERO); S.get = lc(R.TAC); }
}

// ── formatting ──
// The page's sprite has Tacit's coins, ETH and BTC; any other token is its first letter on its colour.
const SPRITE = new Set(['tac', 'teth', 'cbtc', 'cusd', 'btc', 'eth']);
const coin = (t, cls = '') => (!t ? '' : SPRITE.has(t.icon) ? `<svg class="tk ${cls}" aria-hidden="true"><use href="#tk-${t.icon}"/></svg>` : LOGO[t.addr] ? `<img class="tk ${cls}" src="${LOGO[t.addr]}" alt="" aria-hidden="true">` : letter(t, cls));
const TINT = { USDC: '#2775CA', USDT: '#26A17B', DAI: '#F5AC37', wstETH: '#00A3FF', WETH: '#627EEA' };
function letter(t, cls) { return `<span class="tk letter ${cls}" style="--c:${TINT[t.sym] || '#8F8979'}" aria-hidden="true">${esc((t.sym || '?').replace(/^w(?=[A-Z])/, '').slice(0, 1).toUpperCase())}</span>`; }
// An amount with sensible places: more for a small one, fewer for a large one.
function amtFmt(v, dec) {
  const n = Number(v) / 10 ** dec;
  const dp = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return fmtUnits(v, dec, Math.min(dp, dec));
}
const tidy = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
// A dollar value of an amount where one is known: ETH and its wraps at Chainlink's ETH, BTC's at its BTC, the dollar coins at a dollar, TAC at the Precision pool.
function usdOf(k, wei) {
  const t = tokenOf(k), p = S.px;
  if (!t || wei == null) return null;
  const n = Number(wei) / 10 ** t.dec;
  if (isEth(k) || k === 'teth' || t.sym === 'WETH') return p.ethUsd ? n * p.ethUsd : null;
  if (t.sym === 'wstETH') return p.ethUsd && p.wstEth ? n * p.wstEth * p.ethUsd : null;
  if (t.sym === 'cBTC' || t.sym === 'WBTC') return p.btcUsd ? n * p.btcUsd : null;
  if (['USDC', 'USDT', 'DAI', 'cUSD'].includes(t.sym) && !t.custom) return n;
  if (k === lc(R.TAC)) return p.ethUsd && p.perEth ? (n / p.perEth) * p.ethUsd : null;
  return null;
}

// ── prices, balances and the chain's clock ──
async function readPrices() {
  const r = await batch([
    { to: PRECISION_POOL, data: '0x2af1f249' }, { to: CHAINLINK.eth, data: '0xfeaf968c' }, { to: CHAINLINK.btc, data: '0xfeaf968c' }, { to: MULTICALL3, data: '0x0f28c97d' },
    { to: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', data: '0x035faf82' },                     // wstETH's stETH per token
  ]);
  const fresh = (x) => (x && wordAt(x, 3) > BigInt(now() - 6 * 3600) && wordAt(x, 1) > 0n ? Number(wordAt(x, 1)) / 1e8 : null);
  if (r[0]) { const root = Number(wordAt(r[0], 0)) / 1e18; S.px.perEth = root > 0 ? root * root : null; }
  S.px.ethUsd = fresh(r[1]) ?? S.px.ethUsd; S.px.btcUsd = fresh(r[2]) ?? S.px.btcUsd;
  if (r[3]) { S.chainT = Number(wordAt(r[3], 0)); S.chainAt = now(); }
  if (r[4]) S.px.wstEth = Number(wordAt(r[4], 0)) / 1e18;
  paintPx();
}
const chainDeadline = (s = 1200) => BigInt((S.chainT ? S.chainT + (now() - S.chainAt) : now()) + s);
const gasPrice = (() => { let at = 0; return async () => { if (S.gasPrice != null && now() - at < 20) return S.gasPrice; try { S.gasPrice = BigInt(await rpc('eth_gasPrice', [])); at = now(); } catch { /* the last one stands */ } return S.gasPrice; }; })();
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

// ── the wallet ──
const live = (t) => { $('#live').textContent = t; };
// `stick`: the notice stays under the button until the amount, the pair or the mode changes (a later quote does not wipe it).
const say = (h, cls = '', stick = false) => { if (stick) S.note = { h, cls }; const q = $('#q'); q.className = `q${cls ? ` ${cls}` : ''}`; q.innerHTML = h; };
const connect = makeConnect({
  describe: 'Swap into Tacit’s tokens and farm them.',
  busy: () => S.busy,
  say: (t, bad) => say(t, bad ? 'err' : ''),
  onChange: () => { S.bal = {}; paint(); readBalances().then(paint); if (S.q) requote(true); },
});
const { wallet, W } = connect;
// A signature over typed data from the connected wallet, on Ethereum, from the account that was reviewed.
async function signTyped(typed, from) {
  if (lc(W.account || '') !== lc(from)) throw new Error('The wallet’s account changed. Nothing was signed; review it again.');
  await wallet.ensureMainnet();
  try { return await W.prov.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] }); } catch (e) {
    if (e?.code === 4001 || /user (rejected|denied)|rejected the request|denied/i.test(e?.message || '')) throw new UserStopped();
    throw e;
  }
}

// ── the quote ──
const GAS = { tac: 160000n, tacSell: 210000n, split: 270000n, any: 320000n, amm: 150000n, ammIn: 200000n };
function rowsFor(q) { return q?.rows || []; }
const picked = (q = S.q) => (q?.rows || []).find((r) => r.k === S.pick) || q?.rows?.find((r) => r.best) || q?.rows?.[0] || null;

let qTimer = 0;
function requote(now_ = false) {
  clearTimeout(qTimer);
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
    if (!q) return done({ rows: [], why: wei < R.UNIT ? 'Enter a larger amount.' : 'The Tacit pool has no price for this pair right now.' });
    return done({ rows: [{ k: 'amm', name: 'Tacit pool', note: '', out: q.amountOut, amm: q, gas: isEth(S.pay) ? GAS.amm : GAS.ammIn, best: true }], dust: wei - q.amountIn });
  }
  if (kind === 'any') {
    const q = await within(R.quoteAnyToTac({ ethCall, venues, token: S.pay, amountIn: wei, account: account || '0x0000000000000000000000000000000000000001', slippageBps: S.slip, deadline: chainDeadline(1800) }), 15e3, 'zQuoter did not answer in time. Try again.');
    if (!q) return done({ rows: [], why: `No pool trades ${esc(pay.sym)} against WETH deeply enough. Swap it for ETH elsewhere first.` });
    const hop = q.hop ? `${q.hop.name}${q.hop.feeBps ? ` ${Number(q.hop.feeBps) / 100}%` : ''}` : null;
    return done({ rows: [{ k: 'any', name: hop ? `${hop} → Precision pool` : 'Precision pool', note: '', out: q.tacOut, any: q, gas: GAS.any, best: true }] });
  }
  // Private: priced exactly as the front page's console prices it (its hxPoolSwap: the relay's route fee from pool-ux, then the best tier at each
  // stop through tETH), with the same module the console then loads, so the figure handed over is the figure it shows.
  const units = parseUnits(S.amt, 8);
  if (!units) return done({ rows: [], why: 'Enter an amount with at most 8 decimal places.' });
  if (isEth(S.pay) && S.get === 'teth') return done({ rows: [{ k: 'private', name: 'Made private', note: '', out: units * E10, best: true, priv: true }], fee: null });
  const t = await getUx(), from = isEth(S.pay) ? 'eth' : PK[S.pay], to = PK[S.get];
  const id = (k) => (k === 'cbtc' ? String(t.pool.CBTC_ZK_ASSET_ID) : String(t.assetByTicker[POOL_TK[k]]?.assetId || '')).toLowerCase();
  const stops = from === 'eth' || to === 'eth' ? [to] : ['eth', to];
  const f0 = BigInt(await t.quoteOpFee(POOL_TK[from], 'route')), fee = stops.length > 1 ? twoDigits((f0 * 14n) / 10n) : f0;
  if (units <= fee * 2n) return done({ rows: [], why: `Swap more than ${fmtUnits(fee * 2n, 8, 6)} ${esc(pay.sym)}: the relay’s fee is ${fmtUnits(fee, 8, 6)}.` });
  let cur = id(from), amt = units - fee;
  for (const k of stops) {
    const next = id(k);
    const tiers = await Promise.all([30, 5, 100, 1].map((feeBps) => t.quoteRoute({ asset0: cur, amountIn: amt, path: [{ assetNext: next, feeBps }] }).then((r) => (r && r.amountOut > 0n ? r.amountOut : null), () => null)));
    const best = tiers.filter(Boolean).reduce((a, c) => (c > a ? c : a), 0n);
    if (!best) return done({ rows: [], why: 'The Tacit pool has no price for this pair right now.' });
    cur = next; amt = best;
  }
  return done({ rows: [{ k: 'private', name: 'Tacit pool', note: '', out: amt * E10, best: true, priv: true }], fee, feeTick: from });
}
// The private pool's module, loaded the first time a private swap is priced (the console loads the same file next, from the cache).
const PK = { teth: 'eth', [lc(R.TAC)]: 'tac', [lc(R.CUSD)]: 'cusd', [lc(R.CBTC)]: 'cbtc' };
const POOL_TK = { eth: 'cETH', tac: 'cTAC', cbtc: 'cBTC', cusd: 'cUSD' };
let uxP = null;
const getUx = () => (uxP ||= (async () => {
  const [{ makeConfidentialPoolUx }, dep, d] = await Promise.all([import('/confidential-pool-ux.js?cb=48f19c85'), import('/confidential-deployments.js'), import('/vendor/tacit-deps.min.js')]);
  dep.setActiveNetwork('mainnet');
  return makeConfidentialPoolUx({ secp: d.secp, keccak256: d.keccak_256, sha256: d.sha256, network: 'mainnet' });
})().catch((e) => { uxP = null; throw e; }));
// The way to the private door is warmed before it is taken: its modules (the template holds their links, made by build/build.mjs, so the
// graph is fetched in one round rather than one import level at a time), a connection to the node it reads, the module, and the gas price and prove cost its
// first quote asks for in turn (read now, as the console does).
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

// How the pick compares with the market: the dollar value out over the dollar value in (fees and price impact included).
// An any-token swap spends what its WETH leg needs, not all that was typed (the margin stays in the wallet): that is what is priced, and a token
// with no dollar price of its own is worth the WETH it buys.
const spentOf = (q, r) => (r?.any ? r.any.spend : q.wei);
function vsMarket(q = S.q, r = picked(q)) {
  if (!q || !r) return null;
  const vin = usdOf(S.pay === 'teth' ? lc(R.ZERO) : S.pay, spentOf(q, r)) ?? (r.any ? usdOf(lc(R.ZERO), r.any.weth) : null), vout = usdOf(S.get === 'teth' ? lc(R.ZERO) : S.get, r.out);
  return vin && vout ? vout / vin - 1 : null;
}
const BAD = -0.03, GATE = -0.1;

// ── painting ──
function paint() {
  paintTabs(); paintSides(); paintQuote();
}
function paintTabs() {
  for (const [t, el] of [['swap', $('#tab-swap')], ['earn', $('#tab-earn')]]) el.setAttribute('aria-selected', String(S.tab === t));
  $('.sw-h').style.setProperty('--i', S.tab === 'swap' ? 0 : 1);
  $('#p-swap').hidden = S.tab !== 'swap'; $('#p-earn').hidden = S.tab !== 'earn';
  document.querySelectorAll('.mode [data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === S.mode)));
}
function paintSides() {
  const pay = tokenOf(S.pay), get = tokenOf(S.get), priv = S.mode === 'private';
  $('#pay-coin').innerHTML = `${coin(pay)}${esc(pay.sym)}<span class="car" aria-hidden="true">▾</span>`;
  $('#pay-coin').setAttribute('aria-label', `Pay with ${pay.sym}. Choose another`);
  $('#get-coin').innerHTML = `${coin(get)}${esc(get.sym)}<span class="car" aria-hidden="true">▾</span>`;
  $('#get-coin').setAttribute('aria-label', `Get ${get.sym}. Choose another`);
  const payPriv = priv && !isEth(S.pay);
  $('#f-pay').classList.toggle('priv', payPriv); $('#f-get').classList.toggle('priv', priv);
  $('#pay-where').className = `where${payPriv ? ' priv' : ''}`; $('#pay-where').textContent = payPriv ? 'from your private balance' : 'from your wallet';
  $('#get-where').className = `where${priv ? ' priv' : ''}`; $('#get-where').textContent = priv ? 'private on Ethereum' : 'to your wallet';
  const a = $('#amt'); if (a.value !== S.amt) a.value = S.amt;
  fitSize(a);
  $('#flip').disabled = !kindOf(S.get, S.pay);
  // The balance and Max, or quick amounts while nothing is typed.
  const bal = !payPriv && W.account ? S.bal[S.pay] : null, wei = parseUnits(S.amt, pay.dec);
  const side = $('#pay-side');
  if (bal != null) side.innerHTML = `<button type="button" id="max" class="${wei && wei > bal ? 'over' : ''}">Balance ${esc(amtFmt(bal, pay.dec))}${bal > 0n ? ' · Max' : ''}</button>`;
  else if (!S.amt) side.innerHTML = `<span class="quick">${(QUICK[pay.sym] || []).map((v) => `<button type="button" data-quick="${v}">${v}</button>`).join('')}</span>`;
  else side.textContent = '';
  const getBal = !priv && W.account ? S.bal[S.get] : null;
  $('#get-side').textContent = getBal ? `You have ${amtFmt(getBal, get.dec)}` : '';
  const v = wei ? usdOf(S.pay === 'teth' ? lc(R.ZERO) : S.pay, wei) : null;
  $('#pay-usd').textContent = v != null ? `≈ ${usd(v)}` : '';
}
const QUICK = { ETH: ['0.1', '0.5', '1'], TAC: ['500', '1000'], USDC: ['100', '500'], USDT: ['100', '500'], DAI: ['100', '500'], cUSD: ['100', '500'], cBTC: ['0.001', '0.01'], WBTC: ['0.005', '0.01'], WETH: ['0.1', '0.5'], wstETH: ['0.1', '0.5'], tETH: ['0.1', '0.5'] };
const fitSize = (el) => { const n = (el.value || el.textContent || '').length; el.classList.toggle('long', n > 8); el.classList.toggle('longer', n > 11); };

function paintQuote() {
  const q = S.q, out = $('#out'), get = tokenOf(S.get), pay = tokenOf(S.pay), rows = $('#rows'), rc = $('#rcpt'), go = $('#go'), ackbox = $('#ackbox');
  const r = picked(q), kind = kindOf(S.pay, S.get);
  // The figure out.
  out.classList.toggle('busy', !!q?.busy);
  if (r && !q.busy) { out.textContent = tidy(amtFmt(r.out, get.dec)); out.classList.remove('ph'); }
  else if (!q?.busy) { out.textContent = '0'; out.classList.add('ph'); }
  fitSize(out);
  const vo = r && !q.busy ? usdOf(S.get === 'teth' ? lc(R.ZERO) : S.get, r.out) : null;
  const m = q && !q.busy ? vsMarket(q, r) : null;
  $('#get-usd').innerHTML = vo != null ? `≈ ${usd(vo)}${m != null && Math.abs(m) >= 0.0005 ? ` <span class="${m <= BAD ? 'warn' : m > 0.02 ? 'ok' : 'mute'}">(${m > 0 ? '+' : '−'}${Math.abs(m * 100).toFixed(Math.abs(m) >= 0.1 ? 0 : 2)}%)</span>` : ''}` : '';
  // The routes, when there is a choice.
  // While a quote is read the last one stays, dimmed, so the card keeps its height; the first one is drawn as placeholders of the same height.
  const busy = !!q?.busy, first = busy && !r;
  rows.classList.toggle('stale', busy); rc.classList.toggle('stale', busy);
  const list = first && kind === 'tac' ? [{ k: 'precision', name: 'Precision pool' }, { k: 'tacit-amm', name: 'Tacit pool' }, { k: 'split', name: 'Both pools' }] : rowsFor(q);
  rows.hidden = !(list.length > 1);
  if (first && !rows.hidden) rows.innerHTML = `<div class="rows-h"><span>Route</span><span>${esc(get.sym)} out</span></div>${list.map((x) => `<button type="button" role="radio" aria-checked="false" disabled><span class="rt"><b>${esc(x.name)}</b></span><span class="ra"><span>…</span></span><span class="rd" aria-hidden="true"></span></button>`).join('')}`;
  else if (!rows.hidden) {
    const top = list.reduce((a, b) => (b.out > a.out ? b : a));
    rows.innerHTML = `<div class="rows-h"><span>Route</span><span>${esc(get.sym)} out</span></div>${list.map((x) => `<button type="button" role="radio" aria-checked="${x.k === r?.k}" data-route="${esc(x.k)}"><span class="rt"><b>${esc(x.name)}</b>${noteOf(x, q) ? `<small>${noteOf(x, q)}</small>` : ''}</span><span class="ra"><span>${esc(tidy(amtFmt(x.out, get.dec)))}</span>${x === top && list.length > 1 ? '<em>best</em>' : x.out < top.out ? `<small>−${(Number(top.out - x.out) * 100 / Number(top.out)).toFixed(2)}%</small>` : ''}</span><span class="rd" aria-hidden="true"></span></button>`).join('')}`;
  }
  // The receipt.
  const lines = first ? (kind === 'private' ? ['Price', 'Price impact', 'Relay fee'] : ['Price', 'At least', 'Price impact', 'Network fee']).map((k) => [k, '…']) : [];
  if (r) {
    const inAmt = Number(spentOf(q, r)) / 10 ** pay.dec, outAmt = Number(r.out) / 10 ** get.dec;
    if (inAmt > 0 && outAmt > 0) lines.push(['Price', outAmt >= inAmt ? `1 ${pay.sym} = ${sig(outAmt / inAmt)} ${get.sym}` : `1 ${get.sym} = ${sig(inAmt / outAmt)} ${pay.sym}`]);
    if (!r.priv) lines.push(['At least', `${tidy(amtFmt((r.out * BigInt(10000 - S.slip)) / 10000n, get.dec))} ${get.sym}`]);
    if (r.any?.hop) lines.push(['Route', r.name]);
    const tacSide = S.pay === lc(R.TAC) || S.get === lc(R.TAC);                  // TAC's market is these pools: what shows is the price the trade moves
    if (m != null && tacSide) lines.push(['Price impact', `${(Math.max(0, -m) * 100).toFixed(2)}%`, m <= GATE ? 'warn' : '']);
    else if (m != null) lines.push(['Against the market', m <= BAD ? `${(Math.abs(m) * 100).toFixed(1)}% below` : m >= 0.02 ? `${(m * 100).toFixed(1)}% above` : `${m >= 0 ? '+' : '−'}${(Math.abs(m) * 100).toFixed(2)}%`, m <= BAD ? 'warn' : m >= 0.02 ? 'ok' : '']);
    if (r.priv && q.fee != null) lines.push(['Relay fee', `${fmtUnits(q.fee, 8, 6)} ${S.pay === lc(R.ZERO) || S.pay === 'teth' ? 'tETH' : pay.sym}`]);
    if (!r.priv && r.gas && S.gasPrice && S.px.ethUsd) { const f = Number(r.gas * S.gasPrice) / 1e18 * S.px.ethUsd; lines.push(['Network fee', `about ${f < 1 ? `$${f.toFixed(2)}` : usd(f)}`]); }
  }
  rc.hidden = !lines.length;
  rc.innerHTML = lines.map(([k, v, c]) => `<div><dt>${esc(k)}</dt><dd class="${c || ''}">${esc(v)}</dd></div>`).join('');
  // A buy far under the market is acknowledged first.
  const gate = r && !q.busy && m != null && m <= GATE && !r.priv;
  if (busy) { /* the acceptance stays as it is until the new quote is in */ } else if (gate) {
    const alt = S.get === lc(R.CUSD) ? ' <a href="/#borrow">Borrow cUSD at $1</a>.' : S.get === lc(R.CBTC) ? ' <a href="/#card=borrow:cbtc:mint">Mint cBTC 1:1</a>.' : '';
    if (!ackbox.querySelector('input') || ackbox.dataset.k !== `${S.pay}>${S.get}`) {
      ackbox.dataset.k = `${S.pay}>${S.get}`;
      const tac = S.pay === lc(R.TAC) || S.get === lc(R.TAC);
      ackbox.innerHTML = tac
        ? `<label class="ack"><input type="checkbox" id="ack"><span>Moves the price <b>${(Math.abs(m) * 100).toFixed(0)}%</b>. Swap anyway</span></label>`
        : `<label class="ack"><input type="checkbox" id="ack"><span><b>${(Math.abs(m) * 100).toFixed(0)}% under</b> market.${alt} Swap anyway</span></label>`;
      $('#ack').checked = S.ack;
    } else ackbox.querySelector('b').textContent = `${(Math.abs(m) * 100).toFixed(0)}%${S.pay === lc(R.TAC) || S.get === lc(R.TAC) ? '' : ' under'}`;
  } else { ackbox.innerHTML = ''; ackbox.dataset.k = ''; }
  // The button and the line under it.
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
  if (!r) return [q?.err ? 'Try again' : 'No route', !!q?.err];
  if (kind === 'private') return [S.get === 'teth' && isEth(S.pay) ? 'Make it private →' : 'Continue privately →', true, 'priv'];
  if (!W.account) return ['Connect wallet', true];
  const bal = S.bal[S.pay], wei = q.wei;
  if (bal != null && wei > bal) return [`Not enough ${pay.sym}`, false];
  if (bal != null && isEth(S.pay) && S.gasPrice && wei + r.gas * S.gasPrice > bal) return ['Leave some ETH for the network fee', false];
  if (gate && !S.ack) return ['Accept the price above to swap', false];
  return [isEth(S.get) ? `Sell ${pay.sym}` : isEth(S.pay) || kind === 'any' ? `Buy ${get.sym}` : `Swap ${pay.sym} for ${get.sym}`, true];
}
// The line under the button: only what the button cannot say (no route, an error); progress and results are said by go().
function lineFor(q, r, kind) {
  if (!kind) return kindOf(S.pay, S.get, 'private') ? `Swaps privately: <button type="button" class="link" data-mode-go="private">switch</button>.` : 'No route for this pair.';
  if (q?.err) return `<span class="err">${esc(q.err)}</span>`;
  if (!q?.busy && S.amt && (q?.none || !r) && q?.why) return esc(q.why);
  return '';
}

// ── doing it ──
async function go() {
  const kind = kindOf(S.pay, S.get), r = picked();
  if (S.busy) return;
  if (!r) { if (S.q?.err) requote(true); return; }
  S.note = '';
  if (kind === 'private') { location.href = privateLink(); return; }
  if (!W.account) { await connect.connect(); return; }
  const from = W.account, P = { kind, r, wei: S.q.wei, floor: (r.out * BigInt(10000 - S.slip)) / 10000n, pay: S.pay, get: S.get };
  S.busy = true; paintQuote();
  const before = await balanceNow(P.get, from).catch(() => null);
  try {
    say('Reading the price again…');
    const tx = await prepare(P, from);
    if (!tx) return;
    say('Confirm the swap in your wallet.');
    const h = await wallet.sendTx({ to: tx.to, data: tx.data, value: tx.value || 0n, from });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    live('Swap sent');
    const rc = await wallet.receipt(h);
    if (rc.status !== '0x1') throw new Error(`The transaction failed (${txLink(h)}). Nothing was swapped.`);
    const after = await balanceNow(P.get, from).catch(() => null), got = before != null && after != null ? after - before : null;
    const g = tokenOf(P.get);
    S.lastBuy = P.get === lc(R.TAC) && got > 0n ? got : null;
    S.amt = ''; S.q = null; S.busy = false; keepUrl(); paint();
    say(`Done ${txLink(h)}: ${isEth(P.get) ? `about ${tidy(amtFmt(P.r.out, g.dec))} ETH to your wallet` : got != null && got > 0n ? `${tidy(amtFmt(got, g.dec))} ${esc(g.sym)} in your wallet` : `${esc(g.sym)} sent to your wallet`}.${!isEth(P.get) ? ` <button type="button" class="link" data-watch="${esc(g.addr)}">Add ${esc(g.sym)} to your wallet</button>` : ''}${S.lastBuy ? ` · <button type="button" class="link" data-farm-it>Farm it</button>` : ''}`, 'ok', true);
    live('Swap done');
    readBalances().then(() => paintSides());
    readPrices().catch(() => {});                                             // the price the next quote is judged against moved with this swap
  } catch (e) {
    S.busy = false; paintQuote();
    say(e instanceof UserStopped || e?.userStopped ? 'Cancelled in your wallet. Nothing was sent.' : `<span class="err">${e?.message?.includes('<a ') ? e.message : esc(e?.message || String(e)).slice(0, 300)}</span>`, '', true);
  } finally { S.busy = false; }
}
const balanceNow = async (k, who) => (isEth(k) ? BigInt(await rpc('eth_getBalance', [who, 'latest'])) : wordAt(await ethCall(k, '0x70a08231' + addrWord(who)), 0));

// The transaction, made from a fresh read of the pools and never below the floor that was reviewed; access to the token arranged first.
async function prepare(P, from) {
  const floorFor = (out) => { const f = (out * BigInt(10000 - S.slip)) / 10000n; return f > P.floor ? f : P.floor; };
  const dl = chainDeadline(1200);
  const moved = () => { say('The price moved below the least you accept. Nothing was sent; the quote above is the new one.', '', true); S.busy = false; requote(true); return null; };
  let tx;
  if (P.kind === 'tac') {
    const dir = isEth(P.pay) ? 'ETH_TO_TAC' : 'TAC_TO_ETH';
    const rt = await venues.route({ dir, amountIn: P.wei, account: from, gasPrice: await gasPrice() });
    const pick = P.r.split ? rt.split : (rt.r.ranked || []).find((v) => v.venue === P.r.venue.venue);
    if (!pick) { say('That route is no longer offered. Nothing was sent; press again for the new quote.', '', true); S.busy = false; requote(true); return null; }
    if (BigInt(pick.amountOut) < P.floor) return moved();
    const floor = floorFor(BigInt(pick.amountOut)), isSplit = !!P.r.split;
    const make = (permit) => (isSplit ? venues.buildSplit({ split: pick, account: from, minOut: floor, deadline: dl, permit }) : venues.build({ quote: pick, dir, account: from, minOut: floor, deadline: dl, permit }));
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
    tx = R.buildAmm({ quote: q, account: from, minOut: floor, deadline: dl, permit });
  } else if (P.kind === 'any') {
    const q = await within(R.quoteAnyToTac({ ethCall, venues, token: P.pay, amountIn: P.wei, account: from, slippageBps: S.slip, deadline: dl }), 15e3, 'zQuoter did not answer in time. Nothing was sent; try again.');
    if (!q || q.tacOut < P.floor) return moved();
    const floor = floorFor(q.tacOut), access = await anyAccess(q, from);
    tx = R.buildAnyToTac({ quote: q, account: from, minOut: floor, keccak256: keccak_256, access });
  } else throw new Error('Nothing to do for this pair.');
  say('Checking it first…');
  const sim = await venues.simulate({ tx, from });
  if (!sim.ok) throw new Error('This swap would fail, so nothing was sent. Try a smaller amount or try again.');
  return tx;
}
// TAC's way in for the trade venues: a permit where the route takes one, else an approval sent first (the Tacit pool alone).
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
// Any token's way into zRouter: its permit (DAI's own for DAI), a Permit2 signature where it already allows Permit2, else an approval of the most it can spend.
async function anyAccess(q, from) {
  const t = tokenOf(lc(q.token)), acc = await R.readAccess({ ethCall, token: q.token, owner: from });
  if (acc.balance < q.maxIn) throw new Error(`Not enough ${t.sym}: the swap may spend up to ${tidy(amtFmt(q.maxIn, t.dec))}.`);
  if (acc.allowed >= q.maxIn) return { kind: 'approved' };                       // allowed already: nothing to sign
  if (t.permit === undefined) t.permit = (await R.readToken({ ethCall, keccak256: keccak_256, address: q.token }).catch(() => null))?.permit ?? null;
  if (t.permit === 'dai') {
    say('Sign DAI’s permit in your wallet. The signature costs nothing.');
    return { kind: 'dai', nonce: acc.nonce, expiry: q.deadline, ...R.splitSig(await signTyped(R.daiPermitTyped({ owner: from, nonce: acc.nonce, expiry: q.deadline }), from)) };
  }
  if (t.permit && acc.nonce != null) {
    say(`Sign the permit for your ${esc(t.sym)} in your wallet. The signature costs nothing.`);
    return { kind: 'permit', value: q.maxIn, deadline: q.deadline, ...R.splitSig(await signTyped(R.permitTyped({ token: q.token, name: await tokenName(q.token), version: t.permit, owner: from, spender: R.ZROUTER, value: q.maxIn, nonce: acc.nonce, deadline: q.deadline }), from)) };
  }
  if (acc.permit2 >= q.maxIn) {
    say(`Sign a Permit2 transfer of your ${esc(t.sym)} in your wallet. The signature costs nothing.`);
    const nonce = R.randomNonce();
    return { kind: 'permit2', nonce, deadline: q.deadline, signature: await signTyped(R.permit2Typed({ token: q.token, amount: q.maxIn, nonce, deadline: q.deadline }), from) };
  }
  await approve(q.token, R.ZROUTER, q.maxIn, from, acc.allowed);
  return { kind: 'approved' };
}
// The name a token signs its permits under (its name(), which its domain separator was checked against).
const NAMES = new Map();
async function tokenName(token) {
  if (NAMES.has(lc(token))) return NAMES.get(lc(token));
  const t = await R.readToken({ ethCall, keccak256: keccak_256, address: token });
  NAMES.set(lc(token), t?.name || '');
  return t?.name || '';
}
async function approve(token, spender, amount, from, had) {
  const t = tokenOf(lc(token));
  // USDT and a few others refuse to change one allowance straight to another: it goes to zero first.
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
// The front page's console, set to this swap: #card=swap:<from>:<to>:private&amt=… (or the shield verb for ETH into tETH).
function privateLink() {
  const amt = tidy((S.amt || '').replace(/,/g, '').replace(/(\.\d{8})\d+$/, '$1'));
  const ok = /^\d{0,12}(\.\d{1,18})?$/.test(amt) && amt ? `&amt=${amt}` : '';
  if (isEth(S.pay) && S.get === 'teth') return `/#card=shield:ether:defi${ok}`;
  return `/#card=swap:${KEY[S.pay]}:${KEY[S.get]}:private${ok}`;
}

// ── the coin picker ──
function openPicker(side) {
  if (!(TL.rows.length && Date.now() - TL.at < TL.day)) loadList().then(() => { if (!$('#pk').hidden && side === 'pay' && !$('#pk-q')?.value && TL.rows.length) openPicker(side); });
  const pk = $('#pk'), keys = side === 'pay' ? payList() : getList(), cur = side === 'pay' ? S.pay : S.get;
  const row = (k) => {
    const t = tokenOf(k);
    if (!t) return '';
    const bal = S.mode !== 'private' || isEth(k) ? S.bal[k] : null, other = side === 'pay' ? S.get : S.pay;
    const ok = side === 'pay' ? kindOf(k, other) || kindOf(k, defaultFor(k)) : kindOf(other, k) || true;
    return `<button type="button" class="pk-r${ok ? '' : ' off'}" data-k="${esc(k)}" aria-current="${k === cur}">${coin(t)}<span><b>${esc(t.sym)}</b><small>${esc(S.mode === 'private' ? (isEth(k) ? 'wallet' : 'private') : t.custom ? `${t.addr.slice(0, 8)}…${t.addr.slice(-6)}` : t.name)}</small></span><em>${bal ? esc(amtFmt(bal, t.dec)) : ''}</em></button>`;
  };
  const groups = side === 'pay' && S.mode !== 'private'
    ? [[null, keys.filter((k) => isEth(k) || tacitKey(k))], ['Any token → TAC', held(keys.filter((k) => !isEth(k) && !tacitKey(k)))]]
    : [[null, keys]];
  pk.innerHTML = `<div class="pk-s" role="dialog" aria-modal="true" aria-label="${side === 'pay' ? 'Pay with' : 'Get'}"><div class="pk-h"><b>${side === 'pay' ? 'Pay with' : 'Get'}</b><button type="button" class="pk-x" aria-label="Close">×</button></div>${side === 'pay' && S.mode !== 'private' ? '<input class="pk-q" id="pk-q" placeholder="Search, or paste a token address" autocomplete="off" spellcheck="false" aria-label="Search tokens or paste an address">' : ''}<div class="pk-l" id="pk-l">${groups.map(([g, ks]) => `${g ? `<p class="pk-g">${esc(g)}</p>` : ''}${ks.map(row).join('')}`).join('')}<p class="pk-n" id="pk-n"></p></div></div>`;
  pk.hidden = false;
  // Escape closes it wherever the keyboard is, not only inside it.
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
    if (b.dataset.add) { const t = JSON.parse(b.dataset.add); S.custom = [t, ...S.custom.filter((x) => x.addr !== t.addr)].slice(0, 20); try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(S.custom)); } catch { /* storage is a convenience */ } readBalances().then(paintSides); }
    choose(side, k); close();
  };
  const qEl = $('#pk-q');
  if (qEl) {
    qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); [...pk.querySelectorAll('.pk-r')].find((b) => !b.hidden)?.click(); } });
    let seq = 0;
    qEl.oninput = async () => {
      const v = qEl.value.trim(), my = ++seq, l = $('#pk-l');
      l.querySelectorAll('.pk-r').forEach((b) => { const t = tokenOf(b.dataset.k); b.hidden = !!v && !/^0x/i.test(v) && !`${t.sym} ${t.name}`.toLowerCase().includes(v.toLowerCase()); });
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
// What the wallet holds comes first, the most valuable first (a token with no dollar price after those with one).
const held = (ks) => ks.map((k, i) => ({ k, i, v: S.bal[k] ? (usdOf(k, S.bal[k]) ?? 1e-9) : 0 })).sort((a, b) => b.v - a.v || a.i - b.i).map((x) => x.k);
const defaultFor = (k) => (isEth(k) ? lc(R.TAC) : tacitKey(k) ? lc(R.ZERO) : lc(R.TAC));
// An amount is typed in one asset: whatever changes the asset paid (a choice, the side that follows it, the mode) clears it, rather than
// read 500 USDC as 500 ETH.
function keepAmt(change) { const was = S.pay; change(); if (S.pay !== was) { S.amt = ''; S.max = false; } S.note = ''; }
function choose(side, k) {
  keepAmt(() => { if (side === 'pay') { S.pay = k; fit('pay'); } else { S.get = k; fit('get'); } });
  S.q = null; S.pick = null; S.hold = false; keepUrl(); paint(); requote(true);
}

// ── Earn ──
let farmUi = null;
async function readFarms() {
  if (!S.px.perEth) await readPrices().catch(() => {});                          // the APRs are priced in ETH at the Precision pool
  const [prog, r] = await Promise.all([
    api('/farm/program?network=mainnet'),
    batch([{ to: PRECISION_POOL, data: '0x443cb4bc' }, { to: PRECISION_POOL, data: '0x5a76f25e' }, { to: PRECISION_POOL, data: '0x18160ddd' }, { to: FARM, data: '0x817b1cd2' }, { to: FARM, data: '0x7b0a47ee' }, { to: FARM, data: '0xebe2b12b' }]).catch(() => []),
  ]);
  const tacEth = S.px.perEth ? 1 / S.px.perEth : null, out = [];
  if (r.length && r.every(Boolean) && tacEth) {
    const [r0, r1, supply, staked, rate, finish] = r.map((x) => wordAt(x, 0)), value = Number(r0) + Number(r1) * tacEth, stakedEth = supply ? value * Number(staked) / Number(supply) / 1e18 : 0;
    const perDay = Number(rate) * 86400 / 1e18, live = Number(finish) > now();
    out.push({ k: 'precision', name: 'Precision farm', note: 'public', apr: live && stakedEth > 0 ? perDay * 365 * tacEth / stakedEth * 100 : null, icons: ['tac', 'eth'] });
  } else out.push({ k: 'precision', name: 'Precision farm', note: 'public', apr: null, icons: ['tac', 'eth'] });
  for (const p of prog?.pools || []) {
    const rr = p.reserves || {};
    if (p.idle || lc(rr.assetA) !== CETH_ID || !Number(rr.lpTotalShares)) continue;
    const bonded = 2 * Number(rr.reserveA) / 1e8 * Number(p.totalShares) / Number(rr.lpTotalShares);
    const other = String(p.pair).split('/').find((x) => x !== 'cETH') || 'TAC';
    out.push({ k: `p${p.pid}`, pid: p.pid, name: `tETH / ${other}`, note: 'private', apr: tacEth && bonded > 0 ? Number(p.tacPerDayForPool) * 365 * tacEth / bonded * 100 : null, icons: [other.toLowerCase(), 'teth'] });
  }
  S.farms = out;
}
const aprTxt = (a) => (a == null ? '' : a >= 100000 ? 'over 100,000%' : `${a >= 100 ? Math.round(a).toLocaleString('en-US') : a.toFixed(1)}%`);
function paintEarn() {
  const list = S.farms || [{ k: 'precision', name: 'Precision farm', note: 'public', icons: ['tac', 'eth'] }];
  $('#farms').innerHTML = list.map((f) => `<button type="button" role="radio" class="c" aria-checked="${f.k === S.farm}" data-farm="${esc(f.k)}"><span class="pairtk">${f.icons.map((i) => `<svg class="tk sm" aria-hidden="true"><use href="#tk-${esc(i)}"/></svg>`).join('')}</span><span class="rt"><b>${esc(f.name)}</b><small>${esc(f.note)}</small></span><span class="ra"><span>${f.apr != null ? esc(aprTxt(f.apr)) : S.farms ? '—' : '…'}</span><small>APR now</small></span><span class="rd" aria-hidden="true"></span></button>`).join('');
  const f = list.find((x) => x.k === S.farm) || list[0];
  $('#farm').hidden = f.k !== 'precision';
  $('#privfarm').hidden = f.k === 'precision';
  if (f.k === 'precision' && !farmUi) {
    farmUi = import('/trade/farm.js?cb=cf321c4e').then(({ mountFarm }) => mountFarm($('#farm'), { ethCall, batch, rpc, api, wallet, W, connect: () => connect.connect(), fmtUnits, parseUnits, esc, usd, ethUsd: () => S.px.ethUsd, txLink, onDone: () => readBalances().then(paintSides) }));
  }
  if (f.k !== 'precision') {
    $('#privfarm').innerHTML = `<a class="go priv" href="/#card=earn:ether:p${f.pid}">Farm ${esc(f.name)} privately →</a>`;
  }
}
// After a purchase of TAC: the Precision farm opened on TAC, with what was bought.
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

// ── the address bar: /swap/?from=USDC&to=TAC&amt=100 (and &private), #earn ──
function keepUrl() {
  const p = new URLSearchParams(), sym = (k) => { const t = tokenOf(k); return t?.custom ? t.addr : t?.sym; };
  if (S.tab === 'swap') {
    if (S.pay !== lc(R.ZERO) || S.mode === 'private') p.set('from', sym(S.pay));
    if (S.get !== lc(R.TAC)) p.set('to', sym(S.get));
    if (S.amt) p.set('amt', S.amt);
    if (S.mode === 'private') p.set('private', '');
  }
  const qs = p.toString().replace(/private=(&|$)/, 'private$1');
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${S.tab === 'earn' ? '#earn' : ''}`);
}
function readUrl() {
  const p = new URLSearchParams(location.search), find = (v) => { if (!v) return null; const x = lc(v); return x === 'teth' ? 'teth' : (listed().find((t) => lc(t.sym) === x || t.addr === x)?.addr) || null; };
  if (p.has('private')) S.mode = 'private';
  const f = find(p.get('from')), t = find(p.get('to'));
  if (f) S.pay = f; if (t) S.get = t;
  if (!kindOf(S.pay, S.get)) fit(t ? 'get' : 'pay');
  const a = p.get('amt');
  if (a && (f || !p.get('from')) && parseUnits(a, tokenOf(S.pay).dec)) S.amt = a;     // an amount is in the token named, so it waits for that token
  if (location.hash === '#earn') S.tab = 'earn';
}

// ── the controls ──
function slipPaint() { $('#slip').innerHTML = [10, 50, 100, 300].map((b) => `<button type="button" data-slip="${b}" aria-pressed="${S.slip === b}">${b / 100}%</button>`).join(''); }
$('#slip').addEventListener('click', (e) => { const b = e.target.closest('[data-slip]'); if (!b) return; S.slip = Number(b.dataset.slip); try { localStorage.setItem(SLIP_KEY, String(S.slip)); } catch { /* storage is a convenience */ } slipPaint(); if (S.q) requote(true); else paintQuote(); });
$('#amt').addEventListener('input', (e) => { S.amt = e.target.value.trim(); S.max = false; S.note = ''; fitSize(e.target); keepUrl(); paintSides(); requote(); });
$('#amt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#go').disabled) $('#go').click(); });
$('#pay-coin').addEventListener('click', () => openPicker('pay'));
// The token list is read only by someone who may open the picker: on the way to the coin.
for (const ev of ['pointerenter', 'focus', 'touchstart']) $('#pay-coin').addEventListener(ev, () => { loadList(); }, { once: true, passive: true });
$('#get-coin').addEventListener('click', () => openPicker('get'));
$('#flip').addEventListener('click', () => {
  if (!kindOf(S.get, S.pay)) return;
  const r = picked(), out = r && !S.q?.busy ? tidy(plain(r.out, tokenOf(S.get).dec)) : '';
  [S.pay, S.get] = [S.get, S.pay]; S.note = '';
  S.amt = out ? tidy(out.replace(/(\.\d{8})\d+$/, '$1')) : S.amt; S.q = null; S.pick = null; S.hold = false; keepUrl(); paint(); requote(true);
});
$('#go').addEventListener('click', go);
$('#rows').addEventListener('click', (e) => { const b = e.target.closest('[data-route]'); if (!b) return; S.pick = b.dataset.route; S.hold = true; S.ack = false; S.ackKey = `${S.pay}>${S.get}:${S.amt}:${S.pick}`; paintQuote(); });
$('#p-swap').addEventListener('click', (e) => {
  const q = e.target.closest('[data-quick]');
  if (q) { S.amt = q.dataset.quick; S.note = ''; keepUrl(); paintSides(); requote(true); return; }
  if (e.target.closest('#max')) {
    const t = tokenOf(S.pay), bal = S.bal[S.pay];
    if (bal == null) return;
    const keep = isEth(S.pay) ? (S.gasPrice || 3n * 10n ** 9n) * 400000n : 0n, v = bal > keep ? bal - keep : 0n;
    S.amt = tidy(plain(v, t.dec)); S.max = true; S.note = ''; keepUrl(); paintSides(); requote(true); return;
  }
  const m = e.target.closest('[data-mode-go]');
  if (m) { setMode(m.dataset.modeGo); return; }
  if (e.target.closest('[data-watch]')) { const t = tokenOf(e.target.closest('[data-watch]').dataset.watch); if (t) wallet.watchAsset({ address: t.addr, symbol: t.sym, decimals: t.dec }); return; }
  if (e.target.closest('[data-farm-it]')) farmIt();
});
$('#ackbox').addEventListener('change', (e) => { if (e.target.id === 'ack') { S.ack = e.target.checked; paintQuote(); } });
function setMode(m) { if (S.mode === m) return; if (m === 'private') warmPrivate(); keepAmt(() => { S.mode = m; fit('pay'); if (!kindOf(S.pay, S.get)) fit('get'); }); S.q = null; S.pick = null; S.hold = false; keepUrl(); paint(); requote(true); }
for (const ev of ['pointerenter', 'focus', 'touchstart']) document.querySelector('.mode [data-mode="private"]').addEventListener(ev, warmPrivate, { once: true, passive: true });
document.querySelector('.mode').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
function setTab(t) { if (S.tab === t) return; S.tab = t; keepUrl(); paint(); if (t === 'earn') { paintEarn(); if (!S.farms) readFarms().then(paintEarn, paintEarn); } }
$('#tab-swap').addEventListener('click', () => setTab('swap'));
$('#tab-earn').addEventListener('click', () => setTab('earn'));
$('.sw-h').addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { setTab(S.tab === 'swap' ? 'earn' : 'swap'); $(`#tab-${S.tab}`).focus(); } });
$('#farms').addEventListener('click', (e) => { const b = e.target.closest('[data-farm]'); if (!b) return; S.farm = b.dataset.farm; paintEarn(); });
addEventListener('hashchange', () => setTab(location.hash === '#earn' ? 'earn' : 'swap'));
// A group of radios takes the arrow keys: each press chooses the next (or previous) and keeps the focus on it, whichever way the group is redrawn.
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

// ── start ──
readUrl();
{
  const q = new URLSearchParams(location.search), named = [q.get('from'), q.get('to')].filter((v) => v && !/^0x/i.test(v));
  if (named.some((v) => !listed().some((t) => lc(t.sym) === lc(v)) && lc(v) !== 'teth')) loadList().then(() => { const was = S.pay; readUrl(); if (S.pay !== was) { S.q = null; paint(); if (S.amt) requote(true); } });
}
{
  const f = new URLSearchParams(location.search).get('from');
  if (/^0x[0-9a-fA-F]{40}$/.test(f || '') && !tokenOf(lc(f))) R.readToken({ ethCall, keccak256: keccak_256, address: lc(f) }).then((t) => {
    if (!t) return;
    S.custom = [{ addr: lc(f), sym: t.sym, name: t.name, dec: t.dec, permit: t.permit, icon: null, custom: true }, ...S.custom].slice(0, 20);
    S.mode = 'wallet'; S.pay = lc(f); S.get = lc(R.TAC);
    const a = new URLSearchParams(location.search).get('amt'); if (a && parseUnits(a, t.dec)) S.amt = a;
    paint(); readBalances().then(paintSides); if (S.amt) requote(true);
  }).catch(() => {});
}
slipPaint();
paint();
// A page that opens on a token from the list shows its logo: the list is read now rather than on the way to the picker.
if ([S.pay, S.get].some((k) => { const t = tokenOf(k); return t && !SPRITE.has(t.icon) && !LOGO[k]; })) loadList();
if (S.tab === 'swap' && matchMedia('(pointer: fine)').matches && !location.hash) $('#amt').focus({ preventScroll: true });
if (S.tab === 'earn') { paintEarn(); }
if (S.mode === 'private') { warmPrivate(); if (S.amt) requote(true); }                    // a private quote has no price gate, so it need not wait for the prices
readPrices().then(() => { paint(); if (S.amt && S.mode !== 'private') requote(true); if (S.tab === 'earn') readFarms().then(paintEarn, paintEarn); }).catch(() => { if (S.amt && S.mode !== 'private') requote(true); });
gasPrice();
PN.load().then(() => { if (S.q?.rows && !S.q.busy) paintQuote(); }, () => {});
// Every half minute, and when the tab comes back to the front: the prices, and the quote when it has grown old (zQuoter's scan is heavy: a minute between).
let ticked = 0;
const tick = () => {
  if (document.hidden || now() - ticked < 10) return;
  ticked = now();
  readPrices().catch(() => {});
  if (S.q && !S.busy && !S.q.busy && now() - (S.q.at || 0) > (S.q.kind === 'any' ? 55 : 25) && kindOf(S.pay, S.get) !== 'private') requote(true);
};
setInterval(tick, 30e3);
document.addEventListener('visibilitychange', tick);
