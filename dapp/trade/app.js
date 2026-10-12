// tacit.finance/trade: TAC's price on both chains and the best way to trade it.
//
// Ethereum's side is read from the chain with eth_call alone: the Precision pool's own price tape (its candles), the pools'
// prices, the private pool's reserves, the Uniswap v4 pools that list TAC and every order resting on zSwap's boards (which the ticket
// can fill: one order, or the best several in one transaction). The Bitcoin side is the order book's trades and listings from the API. The ticket quotes every way to trade an amount and, with a browser wallet, makes the
// trade: a review of exactly what runs, the route tested once without sending, TAC's permit signed instead of an approval where the
// route allows it, and a result in plain words. It never holds a key. (TAC on Bitcoin is bought on /tac, which the Bitcoin row names.)
import { keccak_256 } from '/vendor/tacit-deps.min.js';
import {
  makeEvmTradeVenues, zswapDeepLink, encErc20Approve, PRECISION_POOL, TAC_ERC20, TACIT_AMM, MULTICALL3, CETH_POOL_ASSET_ID, TAC_POOL_ASSET_ID, V4_TAC_POOLS, V4_STATE_VIEW, _internal,
} from '/evm-trade-venues.js?cb=3f639042';
import { getConfidentialDeployment } from '/confidential-deployments.js';
import { buildBook, planBuy, planSell as planBtcSell, ladderLevels } from '/btc-book.js?cb=91371653';
import { decodeTape, chartBars, invert, ethLaneUsd, btcLaneUsd, candlesFromTrades, closeAt, gap, TAPE_FINE, TAPE_COARSE } from '/trade/tape.js?cb=dfc28dd7';
import { mountChart } from '/trade/chart.js?cb=061eeab7';
import { mountDepth } from '/trade/depth.js?cb=fdae9452';
import { readBook, planBuy as planBoardBuy, planSell as planBoardSell, refine as refineBoards, buildFill as buildBoardFill, BOARD_NAMES } from '/zboards.js?cb=868486b9';
import { makeWallet, UserStopped } from '/trade/wallet.js?cb=5e8bf338';

const API = 'https://api.tacit.finance';
const TAC_BTC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://mainnet.gateway.tenderly.co'];
const CHAINLINK = { ethUsd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', btcUsd: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' };   // 8 decimals
const ZSWAP_HOST = 'https://zswap.wei.limo';
const SCAN = 'https://etherscan.io/address/';
const E10 = 10n ** 10n, E18 = 10n ** 18n;
const ORANGE = '#f7931a', ETHBLUE = '#627eea', GREEN = '#16a34a';

const $ = (s, r = document) => r.querySelector(s);
const html = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? String(vals[i] ?? '') : ''), '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const wordAt = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, (i + 1) * 64) || '0'));
const now = () => Math.floor(Date.now() / 1000);

// ── reading the chain ──
async function rpc(method, params) {
  let last;
  for (const [n, url] of RPCS.entries()) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(n === RPCS.length - 1 ? 30e3 : 12e3) });
      const j = await r.json();
      if (j.error) { if (j.error.code === 3 || /revert/i.test(j.error.message || '')) throw Object.assign(new Error(j.error.message), { revert: true }); last = new Error(j.error.message); continue; }
      return j.result;
    } catch (e) { if (e.revert) throw e; last = e; }
  }
  throw last || new Error('no RPC answered');
}
const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: o.value } : {}), ...(o.gas ? { gas: o.gas } : {}) }, block]);
const batch = async (calls) => _internal.decAggregate3(await ethCall(MULTICALL3, _internal.encAggregate3(calls)), calls.length);
const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak_256 });
const api = (path) => fetch(`${API}${path}`, { signal: AbortSignal.timeout(15e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

// The private pool's id for TAC and tETH at a fee tier: keccak256(lower asset id ++ higher ++ fee as 32 bytes).
function privatePoolId(fee) {
  const hexBytes = (h) => Uint8Array.from(strip(h).match(/../g).map((x) => parseInt(x, 16)));
  const [lo, hi] = BigInt(CETH_POOL_ASSET_ID) <= BigInt(TAC_POOL_ASSET_ID) ? [CETH_POOL_ASSET_ID, TAC_POOL_ASSET_ID] : [TAC_POOL_ASSET_ID, CETH_POOL_ASSET_ID];
  const b = new Uint8Array(96); b.set(hexBytes(lo), 0); b.set(hexBytes(hi), 32); b.set(hexBytes(word(fee)), 64);
  return Array.from(keccak_256(b), (x) => x.toString(16).padStart(2, '0')).join('');
}
const PRIV_TIERS = [30, 5, 100, 1];

// ── the state of the page ──
const D = { ethUsd: null, btcUsd: null, perEth: null, priv: null, v4: [], precision: null, ethSupply: null, btc: null, book: null, bidsRead: false, zb: null, zbFailed: false, tape: { fine: [], coarse: [] }, readAt: 0 };
const S = { side: 'buy', amt: '', book: null, pin: null, lane: 'eth', unit: 'usd', range: 0, log: false, slip: 50, bal: null, review: null, busy: false, tf: { eth: TAPE_COARSE, btc: 86400, cmp: 86400 }, quote: null, seq: 0, zq: null };
const TF = { eth: [['5m', 300], ['15m', 900], ['1h', 3600], ['4h', 14400], ['1d', 86400]], btc: [['1h', 3600], ['4h', 14400], ['1d', 86400], ['1w', 604800]], cmp: [['4h', 14400], ['1d', 86400]] };

async function loadChain() {
  const pool = getConfidentialDeployment('mainnet')?.pool;
  const calls = [
    { to: PRECISION_POOL, data: '0x2af1f249' },
    { to: CHAINLINK.ethUsd, data: '0xfeaf968c' }, { to: CHAINLINK.btcUsd, data: '0xfeaf968c' },
    { to: PRECISION_POOL, data: '0x443cb4bc' }, { to: PRECISION_POOL, data: '0x5a76f25e' }, { to: TAC_ERC20, data: '0x18160ddd' },
    ...PRIV_TIERS.map((fee) => ({ to: pool || TAC_ERC20, data: '0xb5217bb4' + privatePoolId(fee) })),
    ...V4_TAC_POOLS.map((p) => ({ to: V4_STATE_VIEW, data: '0xfa6793d5' + strip(p.id) })),
  ];
  const r = await batch(calls), P = 6;
  const fresh = (x) => (x && wordAt(x, 3) > BigInt(now() - 6 * 3600) && wordAt(x, 1) > 0n ? Number(wordAt(x, 1)) / 1e8 : null);   // a feed that has not answered in six hours is not a price
  D.ethUsd = fresh(r[1]); D.btcUsd = fresh(r[2]);
  if (r[0]) { const root = Number(wordAt(r[0], 0)) / 1e18; D.perEth = root > 0 ? root * root : null; }
  if (r[3] && r[4]) D.precision = { eth: wordAt(r[3], 0), tac: wordAt(r[4], 0) };
  if (r[5]) D.ethSupply = wordAt(r[5], 0);
  // The Tacit pool: one set of reserves, swapped in publicly (its AMM contract) or privately (shielded notes). The first fee tier that holds any.
  D.priv = null;
  if (pool) for (const [i, fee] of PRIV_TIERS.entries()) {
    const x = r[P + i];
    if (x && strip(x).length >= 64 * 7 && wordAt(x, 0) !== 0n && wordAt(x, 3) > 0n && wordAt(x, 4) > 0n) { D.priv = { fee, rEth: wordAt(x, 3), rTac: wordAt(x, 4), price: Number(wordAt(x, 3)) / Number(wordAt(x, 4)) }; break; }   // the lower asset id, cETH, is reserve A
  }
  D.v4 = V4_TAC_POOLS.map((p, i) => ({ ...p, liquidity: r[P + PRIV_TIERS.length + i] ? wordAt(r[P + PRIV_TIERS.length + i], 0) : null }));
}

// The pool's tape is a ring: the 4-hour one holds about six weeks. This browser keeps the bars it has read, so the chart outlives the ring.
const KEPT = 'tacit-trade-tape-v1';
function keptTape() { try { const v = JSON.parse(localStorage.getItem(KEPT) || 'null'); return v?.v === 1 && v.pool === PRECISION_POOL && Array.isArray(v.coarse) ? v.coarse.filter((b) => b && Number.isFinite(b.t) && b.t % TAPE_COARSE === 0) : []; } catch { return []; } }
function keepTape(coarse) { try { localStorage.setItem(KEPT, JSON.stringify({ v: 1, pool: PRECISION_POOL, coarse: coarse.slice(-1500) })); } catch { /* storage is a convenience */ } }
async function loadTapes() {
  const sel = '0x29a65241';
  const words = (r) => { const h = strip(r), n = Number(wordAt(h, 1)); return Array.from({ length: n }, (_, i) => '0x' + h.slice(128 + i * 64, 192 + i * 64)); };
  const [c, f] = await Promise.all([ethCall(PRECISION_POOL, sel + word(TAPE_COARSE) + word(256)), ethCall(PRECISION_POOL, sel + word(TAPE_FINE) + word(256))]);
  const coarse = decodeTape(words(c), TAPE_COARSE), fine = decodeTape(words(f), TAPE_FINE);
  const merged = new Map(keptTape().map((b) => [b.t, b]));
  for (const b of coarse) merged.set(b.t, b);                                           // what the chain says now wins
  D.tape = { coarse: [...merged.values()].sort((a, b) => a.t - b.t), fine };
  keepTape(D.tape.coarse);
}

async function loadBitcoin() {
  const [asset, sales, bidRows] = await Promise.all([api(`/assets/${TAC_BTC_ID}?network=mainnet`), api(`/assets/${TAC_BTC_ID}/preauth-sales?network=mainnet`), api(`/assets/${TAC_BTC_ID}/bid-intents?network=mainnet`)]);
  if (asset) D.btc = { trades: asset.trades || [], mark: Number(asset.mark_price?.unit) || null, last: asset.last_trade || null, change24: asset.price_24h_change_pct, vol24: Number(asset.volume_24h_sats) || 0, holders: asset.holder_count ?? null, firstTrade: asset.price_first_trade_ts || null, tradesCap: asset.trades_cap };
  if (Array.isArray(sales?.sales)) {
    D.bidsRead = Array.isArray(bidRows?.intents);                                              // a bid list that could not be read is not the same as no bids
    D.book = buildBook({ assetId: TAC_BTC_ID, decimals: 8, listings: sales.sales.map((x) => ({ ...x, kind: 'preauth' })), bids: D.bidsRead ? bidRows.intents : [] });   // the sale rows carry no `kind`
    D.btc ||= { trades: [], mark: null };
    D.btc.ask = D.book.bestAsk; D.btc.bid = D.book.bestBid;
  }
}

// zSwap's boards: every order for TAC against ETH (eight view calls). A read that lost a board's answer does not replace one that had it, and
// a read nothing answered is "not read", never "no orders".
const BOARD_CALLS = 8;
let boardRetries = 0;
async function loadBoards() {
  const b = await readBook({ ethCall, base: TAC_ERC20, now: now() });
  if (b.answered > 0 && (!D.zb || b.answered >= D.zb.answered)) D.zb = b;
  D.zbFailed = !D.zb;
  // A node that has not answered yet (a cold start) is asked again shortly, not after the minute's wait.
  if (b.answered === 0 && boardRetries++ < 3) setTimeout(() => loadBoards().then(paintAll).catch(() => {}), 4000); else if (b.answered > 0) boardRetries = 0;
  if (S.pin && !pinnedOrder()) { S.pin = null; renderPin(); if (S.quote && !S.review && !S.busy) requote(true); }          // the order that was pinned has gone
}

// ── formatting ──
const grp = (n, max = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: max });
const sig = (x, n = 3) => (x >= 1 ? grp(x, x >= 100 ? 0 : 2) : x.toLocaleString('en-US', { maximumSignificantDigits: n, maximumFractionDigits: 20 }));
const usd = (x) => (x == null || !Number.isFinite(x) ? '—' : x >= 1000 ? `$${grp(x, 0)}` : x >= 1 ? `$${x.toFixed(2)}` : `$${x.toPrecision(3)}`);
const satsFmt = (n) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }));
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(Math.abs(x) >= 0.095 ? 0 : d)}%`);
function fmtUnits(v, dec = 18, max = 4) {
  let n = BigInt(v), neg = n < 0n; if (neg) n = -n;
  const base = 10n ** BigInt(dec), frac = (n % base).toString().padStart(dec, '0').slice(0, max).replace(/0+$/, '');
  return `${neg ? '−' : ''}${(n / base).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
// An amount as the front page reads it: a comma between digits is a thousands separator only where it plainly is one (1,500.25 or 1,000,000),
// a lone comma is a decimal point (0,05), and an ambiguous 1,500 is left unread rather than guessed. Anything else with a comma is unread.
function parseUnits(text, dec = 18) {
  let t = String(text ?? '').trim().replace(/[_\s]/g, '');
  if (t.includes(',')) {
    if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d*)?$/.test(t) && (t.includes('.') || t.indexOf(',') !== t.lastIndexOf(','))) t = t.replace(/,/g, '');
    else if (/^\d*,\d*$/.test(t) && !/^[1-9]\d{0,2},\d{3}$/.test(t)) t = t.replace(',', '.');
    else return null;
  }
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  if (f.length > dec) return null;
  return BigInt(w || '0') * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}
const priceEth = () => (D.perEth ? 1 / D.perEth : null);                                          // ETH per TAC at the Precision pool
const usdOf = (eth) => (eth != null && D.ethUsd ? eth * D.ethUsd : null);
const btcUsdPerTac = () => (D.btc?.mark && D.btcUsd ? (D.btc.mark * D.btcUsd) / 1e8 : null);
const laneGap = (other) => { const base = usdOf(priceEth()); return base && other ? gap(base, other) : null; };
const gapClass = (g) => (g == null ? '' : Math.abs(g) < 0.01 ? 'mute' : g > 0 ? 'up' : 'down');
const tacitEth = () => D.priv?.price ?? null;                                                       // ETH per TAC in the Tacit pool's reserves

// ── the head: the price and where it trades ──
function renderHead() {
  const eth = priceEth(), px = usdOf(eth);
  $('#px-usd').textContent = px != null ? usd(px) : eth != null ? `${sig(eth)} ETH` : 'TAC';
  const day = D.tape.coarse.length ? closeAt(D.tape.coarse, now() - 86400) : null, ch = day && D.perEth ? day / D.perEth - 1 : null;     // TAC per ETH then and now: TAC's price in ETH moved by then/now − 1
  // The candles that began in the last day: the 4-hour ones, and the 5-minute ones newer than the last of those (it lags by one).
  const vol = D.tape.coarse.filter((b) => b.t >= now() - 86400).reduce((a, b) => a + b.vol, 0) + D.tape.fine.filter((b) => b.t >= (D.tape.coarse.at(-1)?.t ?? 0) + TAPE_COARSE && b.t >= now() - 86400).reduce((a, b) => a + b.vol, 0);
  const bits = [];
  if (eth != null) bits.push(html`<span><b class="num">${sig(eth)} ETH</b> · ${grp(D.perEth, 0)} TAC to the ETH</span>`);
  if (ch != null) bits.push(html`<span class="chg ${ch >= 0 ? 'up' : 'down'}">${pct(ch)} in 24 hours</span>`);
  if (D.tape.coarse.length) bits.push(html`<span>${vol >= 0.01 ? `${grp(vol, vol < 10 ? 2 : 0)} ETH` : 'under 0.01 ETH'} traded in the last day</span>`);
  $('#px-sub').innerHTML = bits.length ? bits.join('') : '<span class="mute">Reading the pools…</span>';
  const bg = btcUsdPerTac(), g = bg ? gap(bg, px) : null;
  $('#gapnote').innerHTML = g != null && Math.abs(g) >= 0.01
    ? html`On Ethereum TAC costs <b>${pct(g, 0).replace(/^[+−]/, '')} ${g > 0 ? 'more' : 'less'}</b> than on the Bitcoin order book. A bridge joins the two, a few hours and sometimes up to a day, so they can sit apart.`
    : g != null ? 'TAC costs about the same on Ethereum and on the Bitcoin order book.' : '';
}
function renderLanes() {
  const base = usdOf(priceEth()), ask = D.btc?.ask ? (D.btc.ask * (D.btcUsd || 0)) / 1e8 : null, cards = [
    { name: 'Precision pool', sw: ETHBLUE, v: base, s: priceEth() != null ? `${sig(priceEth())} ETH` : null, g: 'Ethereum · the reference', gc: 'mute' },
    { name: 'Tacit pool', sw: GREEN, v: usdOf(tacitEth()), s: tacitEth() != null ? `${sig(tacitEth())} ETH` : null, gap: laneGap(usdOf(tacitEth())), dev: true, sub: 'public or private swap' },
    { name: 'Bitcoin, last trade', sw: ORANGE, v: btcUsdPerTac(), s: D.btc?.mark ? `${satsFmt(D.btc.mark)} sats` : null, gap: laneGap(btcUsdPerTac()) },
    { name: 'Bitcoin, cheapest listing', sw: ORANGE, v: ask || null, s: D.btc?.ask ? `${satsFmt(D.btc.ask)} sats` : null, gap: laneGap(ask || null) },
  ];
  $('#lanes').innerHTML = cards.map((c) => {
    const g = c.g ?? (c.gap != null ? `${pct(c.gap)} against the Precision pool${c.dev && Math.abs(c.gap) >= 0.01 ? ' · apart' : ''}` : c.sub || '');
    const loading = c.v == null && c.s == null && !(D.tape.coarse.length || D.btc);
    return html`<div class="lane"><span class="k"><i class="sw" style="background:${c.sw}"></i>${esc(c.name)}</span><span class="v num">${loading ? '<i class="sk"></i>' : usd(c.v)}</span><span class="s num">${c.s ? esc(c.s) : ''}</span><span class="g ${c.gc ?? gapClass(c.gap)}">${esc(g)}</span></div>`;
  }).join('');
}

// ── the chart ──
const chartHost = $('#chart');
const chart = mountChart(chartHost);
const unitOf = () => (S.lane === 'cmp' ? 'usd' : S.unit);
function priceFmt(unit, lane) {
  if (unit === 'usd') return (v) => usd(v);
  return lane === 'btc' ? (v) => `${satsFmt(v)} sats` : (v) => `${sig(v)} ETH`;
}
const RANGES = [['7d', 7], ['30d', 30], ['All', 0]];
function renderControls() {
  $('#lane-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lane === S.lane)));
  $('#tf-seg').innerHTML = TF[S.lane].map(([l, p]) => `<button type="button" data-tf="${p}" aria-pressed="${S.tf[S.lane] === p}">${l}</button>`).join('');
  const native = S.lane === 'btc' ? 'sats' : 'ETH';
  $('#view-seg').innerHTML = RANGES.map(([l, d]) => `<button type="button" data-range="${d}" aria-pressed="${S.range === d}">${l}</button>`).join('')
    + `<button type="button" data-log="1" aria-pressed="${S.log}" title="A log axis shows moves of the same size the same height">Log</button>`
    + (S.lane === 'cmp' ? '' : `<button type="button" data-unit="${S.unit === 'usd' ? 'native' : 'usd'}" aria-pressed="false" title="Show the price in ${S.unit === 'usd' ? native : 'dollars'}">in ${S.unit === 'usd' ? native : 'USD'}</button>`);
}
function renderChart() {
  const lane = S.lane, tf = S.tf[lane];
  const unit = (lane === 'cmp' || (lane === 'eth' && !D.ethUsd) || (lane === 'btc' && !D.btcUsd)) ? (lane === 'cmp' ? 'usd' : 'native') : S.unit;
  if (lane === 'cmp' && !(D.ethUsd && D.btcUsd)) {                                              // the two lanes meet in dollars, which needs both rates
    chart.update({ series: [], tags: [], period: tf, label: 'TAC price, both lanes' });
    $('#legend').innerHTML = ''; $('#chart-note').textContent = D.ethUsd || D.btcUsd ? 'One of the dollar rates has not been read yet, so the two lanes cannot be set side by side.' : 'The dollar rates have not been read yet, so the two lanes cannot be set side by side.';
    renderControls();
    return;
  }
  const since = S.range ? now() - S.range * 86400 : 0;                                          // the range limits what is drawn, not what is read
  const eth = chartBars(D.tape, tf).filter((b) => b.t + tf > since), btc = (D.btc ? candlesFromTrades(D.btc.trades, tf) : []).filter((b) => b.t + tf > since);
  const ethBars = (u) => eth.map((b) => (u === 'usd' ? ethLaneUsd(b, D.ethUsd) : invert(b)));
  const btcBars = (u) => btc.map((b) => (u === 'usd' && D.btcUsd ? btcLaneUsd(b, D.btcUsd) : b));
  const series = [], tags = [], legend = [];
  const priv = tacitEth(), deviates = priv != null && priceEth() != null && Math.abs(priv / priceEth() - 1) >= 0.01;
  const ethSpot = unit === 'usd' ? usdOf(priceEth()) : priceEth(), privSpot = unit === 'usd' ? usdOf(priv) : priv;
  const btcSpot = D.btc?.mark ? (unit === 'usd' ? btcUsdPerTac() : D.btc.mark) : null;
  if (lane === 'eth' || lane === 'cmp') {
    series.push({ id: 'eth', name: 'Precision pool', color: ETHBLUE, kind: lane === 'cmp' ? 'line' : 'candles', bars: ethBars(unit), fmt: priceFmt(unit, 'eth'), volFmt: (v) => `${v.toFixed(3)} ETH` });
    if (ethSpot != null) tags.push({ y: ethSpot, label: 'Precision', color: ETHBLUE });
    if (deviates && privSpot != null) tags.push({ y: privSpot, label: 'Tacit', color: GREEN });
  }
  if (lane === 'btc' || lane === 'cmp') {
    const t0 = lane === 'cmp' && eth.length ? eth[0].t - tf : 0;
    series.push({ id: 'btc', name: 'Bitcoin order book', color: ORANGE, kind: lane === 'cmp' ? 'line' : 'candles', bars: btcBars(unit).filter((b) => b.t >= t0), fmt: priceFmt(unit, 'btc'), volFmt: (v) => `${grp(v, 0)} TAC` });
    if (btcSpot != null) tags.push({ y: btcSpot, label: 'Bitcoin', color: ORANGE });
  }
  const names = { eth: 'Precision pool on Ethereum', btc: 'Bitcoin order book', cmp: 'Ethereum and Bitcoin, in dollars' };
  chart.update({ series, tags, period: tf, log: S.log, label: `TAC price, ${names[lane]}, ${TF[lane].find(([, p]) => p === tf)?.[0]} candles` });
  const sw = (c) => `<i class="sw" style="background:${c}"></i>`;
  if (lane !== 'btc') legend.push(`<span>${sw(ETHBLUE)}Precision pool (Ethereum)${ethSpot != null ? ` · ${priceFmt(unit, 'eth')(ethSpot)}` : ''}</span>`);
  if (lane !== 'eth') legend.push(`<span>${sw(ORANGE)}Bitcoin order book${btcSpot != null ? ` · ${priceFmt(unit, 'btc')(btcSpot)}` : ''}</span>`);
  if (lane !== 'btc' && priv != null) legend.push(`<span>${sw(GREEN)}Tacit pool, public or private · ${priceFmt(unit, 'eth')(privSpot)}${deviates ? `, ${pct(priv / priceEth() - 1)} against Precision` : ', level with Precision'}</span>`);
  $('#legend').innerHTML = legend.join('');
  const first = D.tape.coarse[0], days = first ? Math.max(1, Math.round((now() - first.t) / 86400)) : 0;
  $('#chart-note').textContent = lane === 'eth'
    ? `Executed prices, fee included, from the Precision pool's own on-chain price tape, read from Ethereum with no indexer between. A chart, not an oracle: one small trade can move a candle's high or low. The 5-minute tape reaches back about a day and the 4-hour tape about six weeks; this browser keeps what it has read${first ? ` (${days} days so far)` : ''}.`
    : lane === 'btc' ? `Every trade on the Bitcoin order book since ${D.btc?.firstTrade ? new Date(D.btc.firstTrade * 1000).toISOString().slice(0, 10) : 'it began'}, as sats per TAC${D.btc?.trades?.length ? ` (${D.btc.trades.length} trades)` : ''}. A fill far from the others' prices is left out.`
    : 'Both lanes in dollars at today\'s ETH and BTC prices, since a tape has no dollar history: the lines show how the two lanes sit against each other, not what a dollar was worth on a day. A lane draws only where it traded.';
  renderControls();
}

// ── the ticket and the venues ──
const dirOf = () => (S.side === 'buy' ? 'ETH_TO_TAC' : 'TAC_TO_ETH');
const getAmount = () => parseUnits(S.amt, 18);
const gasPrice = (() => { let at = 0, v = null; return async () => { if (now() - at < 20) return v; at = now(); v = await rpc('eth_gasPrice', []).then((g) => BigInt(g), () => null); return v; }; })();
// The private pool's answer from its reserves alone (both sides at 8 decimals, the pool's own fee), before the relay's fee.
function privQuote(dir, wei) {
  if (!D.priv) return null;
  const inU = wei / E10, [rIn, rOut] = dir === 'ETH_TO_TAC' ? [D.priv.rEth, D.priv.rTac] : [D.priv.rTac, D.priv.rEth];
  if (inU <= 0n) return null;
  const g = BigInt(10000 - D.priv.fee), a = inU * g;
  return ((rOut * a) / (rIn * 10000n + a)) * E10;
}
function bookQuote(dir, wei) {
  if (!D.book || !D.ethUsd || !D.btcUsd) return null;
  if (dir === 'ETH_TO_TAC') {
    const sats = Math.floor((Number(wei) / 1e18) * D.ethUsd / D.btcUsd * 1e8);
    if (sats < 546) return { sats, out: null };
    const plan = planBuy(D.book, { spendSats: sats });
    return { sats, out: plan.fills.length ? plan.amount * E10 : null, plan };
  }
  const tac = Number(wei) / 1e18, ref = D.btc?.mark || D.book.bestAsk;
  const sell = planBtcSell(D.book, { sellBase: wei / E10, includeManual: true });                      // the standing bids, which settle when their bidder is online
  return ref || sell.fills.length ? { sats: sell.fills.length ? sell.sats : tac * ref, out: null, sell, bids: D.book.bids.length } : null;
}
async function zq(dir, wei) {
  const k = `${dir}:${wei}`;
  if (S.zq?.k === k && now() - S.zq.at < 300) return S.zq.v;
  // zQuoter scans every Uniswap, Sushi and Curve pool in one heavy call: a node that is slow to answer is not waited on past eight seconds.
  const v = await Promise.race([
    venues.quoteZQuoter({ dir, amountIn: wei, account: undefined, deadline: BigInt(now() + 1800) }).catch(() => ({ status: 'error' })),
    new Promise((res) => setTimeout(() => res({ status: 'timeout' }), 8000)),
  ]);
  S.zq = { k, at: now(), v };
  return v;
}

// What zSwap's boards would pay for the amount: the best orders, or only the one the person pinned, each asked of its own board for the
// figure it would settle at. `full` says the orders take the whole amount (whole-only orders can leave some of it unspent).
const isMine = (o) => !!W.account && o.maker.toLowerCase() === W.account.toLowerCase();
const pinnedOrder = () => (S.pin ? [...(D.zb?.asks || []), ...(D.zb?.bids || [])].find((o) => o.key === S.pin) || null : null);
async function boardQuote(dir, wei) {
  const z = D.zb, buy = dir === 'ETH_TO_TAC', list = z ? (buy ? z.asks : z.bids) : [];
  if (!list.length) return null;
  const skip = (o) => isMine(o) || (S.pin != null && o.key !== S.pin);
  const plan = buy ? planBoardBuy(list, wei, { skip }) : planBoardSell(list, wei, { skip });
  if (!plan.fills.length) return { ok: false, orders: list.filter((o) => !isMine(o)).length };
  const fine = await refineBoards({ ethCall, plan, side: buy ? 'buy' : 'sell' });
  if (!fine) return { ok: false, orders: list.length, stale: true };
  return { ok: true, plan: fine, out: fine.get, spent: fine.pay, full: fine.pay * 1000n >= wei * 995n, keys: fine.fills.map((f) => f.order.key) };
}
// Which way the ticket trades: the pools, or the boards' orders (the one pinned, or the best ones when they take the whole amount and pay 1% more
// than the pool the ticket would use).
function routeOf(q) {
  const bd = q?.board, pools = q?.rt?.single ? (q.rt.pick === 'split' ? q.rt.split : q.rt.single) : null;
  if (S.pin) return bd?.ok ? 'boards' : null;                                                    // a pinned order is the route, or there is none
  if (!bd?.ok || !bd.full) return pools ? 'pools' : null;
  if (!pools) return 'boards';
  return bd.out * 100n >= BigInt(pools.amountOut) * 101n ? 'boards' : 'pools';
}
const boardsName = (bd) => (bd.plan.fills.length === 1 ? `${BOARD_NAMES[bd.plan.fills[0].order.board]} order #${bd.plan.fills[0].order.id}` : `${bd.plan.fills.length} zSwap orders`);

// `quiet` is the page's own refresh: what is on the ticket stays as it is, with no flicker or disabled button, until the new quote replaces
// it (and is dropped if the amount has changed meanwhile). A change the person made clears the ticket first.
async function requote(quiet = false) {
  const my = ++S.seq, wei = getAmount(), dir = dirOf(), buy = S.side === 'buy';
  if (!quiet) { S.quote = null; S.review = null; renderReview(); }
  if (!wei || wei <= 0n) { S.quote = null; renderQuote(null); renderVenues(null); return; }
  if (!quiet) renderQuote({ busy: true });
  if (quiet) S.refreshing = true;
  try {
    // The Precision pool's price is read with the quote, so the price impact is measured against the price as it stands now.
    const [rt, sp, board] = await Promise.all([venues.route({ dir, amountIn: wei, account: W.account || undefined, gasPrice: await gasPrice() }), ethCall(PRECISION_POOL, '0x2af1f249').catch(() => null), boardQuote(dir, wei).catch(() => null)]);
    if (my !== S.seq) return;
    if (sp) { const root = Number(wordAt(sp, 0)) / 1e18; if (root > 0) { D.perEth = root * root; renderHead(); renderLanes(); } }
    S.quote = { wei, dir, buy, rt, board, priv: privQuote(dir, wei), book: bookQuote(dir, wei), zq: S.zq?.k === `${dir}:${wei}` ? S.zq.v : null };
    renderQuote(S.quote); renderVenues(S.quote); renderBook();
    // zQuoter's answer belongs to the amount and direction asked, so it lands on whichever quote is current for them (a refresh that began meanwhile has the same ones).
    zq(dir, wei).then((v) => { if (S.quote && S.quote.wei === wei && S.quote.dir === dir) { S.quote.zq = v; renderVenues(S.quote); } });
  } catch (e) { if (my === S.seq && !quiet) { renderQuote({ err: 'The pools could not be read just now.' }); renderVenues(null); } }
  finally { if (quiet) S.refreshing = false; }
}
function renderQuote(q) {
  const buy = S.side === 'buy', outEl = $('#out'), route = $('#route'), go = $('#go');
  $('#in-lbl').textContent = 'You pay';
  $('#in-unit').innerHTML = `<svg class="tk sm" aria-hidden="true"><use href="#tk-${buy ? 'eth' : 'tac'}"/></svg>${buy ? 'ETH' : 'TAC'}`;
  $('#out-unit').textContent = buy ? 'TAC' : 'ETH';
  $('#amt').setAttribute('aria-label', buy ? 'ETH to pay' : 'TAC to pay');
  const none = (t) => { outEl.textContent = t; outEl.classList.add('ph'); $('#out-usd').textContent = ''; route.innerHTML = ''; renderGo(); };
  if (!q) { none('0.00'); if (!S.busy) $('#status').textContent = S.amt && getAmount() == null ? 'That amount cannot be read. Write it like 1500 or 0.05, with up to 18 decimals (1,500 alone is ambiguous).' : ''; return; }
  if (q.busy) { none('…'); return; }
  if (q.err) { none('—'); $('#status').textContent = q.err; return; }
  if (!S.busy) $('#status').textContent = '';
  const { rt, wei } = q, via = routeOf(q);
  if (!via) { none('—'); $('#status').textContent = S.pin ? 'That order cannot fill this amount: it may be taken whole, or it has just been filled.' : 'No pool can fill this right now.'; return; }
  let out, perTac, name, note = '', usdIn;
  if (via === 'boards') {
    const bd = q.board;
    out = bd.out; usdIn = buy ? bd.spent : bd.out;
    perTac = buy ? Number(bd.spent) / Number(bd.out) : Number(bd.out) / Number(bd.spent);
    name = boardsName(bd);
    if (!bd.full) note = `<p class="splitnote">${S.pin ? 'This order' : 'These orders'} ${buy ? 'cost' : 'take'} ${esc(fmtUnits(bd.spent, 18, 6))} ${buy ? 'ETH' : 'TAC'}, less than the amount you entered; the rest stays with you.</p>`;
  } else {
    const pick = rt.pick === 'split' ? rt.split : rt.single;
    out = BigInt(pick.amountOut); usdIn = buy ? wei : out;
    perTac = buy ? Number(wei) / Number(out) : Number(out) / Number(wei);                      // ETH per TAC, as executed
    name = rt.pick === 'split' ? `Split: ${splitWhat(rt.split)}` : rt.single.venue === 'precision' ? 'Precision pool' : rt.single.venue === 'tacit-amm' ? 'Tacit pool' : 'Other pool';
    const gainTxt = rt.split ? `${(rt.split.gainBps / 100).toFixed(rt.split.gainBps < 100 ? 2 : 1)}%` : '';
    if (rt.pick === 'split') note = `<p class="splitnote">Split: <b>${gainTxt}</b> ${buy ? 'more TAC' : 'more ETH'} than the better pool alone.</p>`;
    else if (rt.split && buy && rt.split.gainBps >= 30) note = `<p class="splitnote mute">A split would pay ${gainTxt} more: not enough to leave the Precision pool, which earns points.</p>`;
    else if (rt.split) note = `<p class="splitnote mute">A split would pay ${gainTxt} more, less than its extra gas.</p>`;
  }
  outEl.textContent = fmtUnits(out, 18, buy ? 2 : 6); outEl.classList.remove('ph');
  const usdOut = D.ethUsd ? usd((Number(usdIn) / 1e18) * D.ethUsd) : '';
  $('#out-usd').textContent = usdOut ? `≈ ${usdOut}` : '';
  const rows = [['Route', name], ['Price', `${usd(usdOf(perTac))} per TAC${D.ethUsd ? '' : ` · ${sig(perTac)} ETH`}`]];
  route.innerHTML = rows.map(([k, v]) => html`<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('') + note;
  renderGo();
}
const splitShare = (sp) => Math.round(Number(sp.legs[0].amountIn * 1000n / (sp.legs[0].amountIn + sp.legs[1].amountIn)) / 10);
const splitWhat = (sp) => `${splitShare(sp)}% Precision pool, ${100 - splitShare(sp)}% Tacit pool`;

function renderVenues(q) {
  const tb = $('#venues tbody'), note = $('#venues-note'), absent = $('#absent'), buy = S.side === 'buy';
  const unit = buy ? 'TAC' : 'ETH', f = (v) => `${fmtUnits(v, 18, buy ? 2 : 6)} ${unit}`;
  $('#venues').classList.toggle('empty', !q); note.closest('details').hidden = !q;
  if (!q) { tb.innerHTML = `<tr><td colspan="3" class="mute">Enter an amount in the ticket to see what every pool would pay for it.</td></tr>`; note.textContent = ''; absent.textContent = ''; return; }
  const { rt } = q, rows = [], via = routeOf(q);
  const add = (r) => rows.push(r);
  const p = rt.r?.precision, t = rt.r?.tacitAmm;
  const runs = via === 'boards' ? 'boards' : rt.pick === 'split' ? 'split' : rt.single?.venue;       // the row the ticket sends the order to
  add({ name: 'Precision pool', note: p ? `fee ${(Number(p.feeBps) / 1e4).toFixed(2)}%` : '', out: p?.amountOut, why: p ? null : 'could not quote', runs: runs === 'precision' });
  add({ name: 'Tacit pool', note: 'public swap · fee 0.30%', out: t?.amountOut, why: t ? null : 'could not quote', runs: runs === 'tacit-amm' });
  if (rt.split) add({ name: 'Both, split', note: splitWhat(rt.split), out: rt.split.amountOut, split: true, runs: runs === 'split' });
  const priv = q.priv;
  add({ name: 'Tacit pool, private', note: 'a shielded note, before the relay\'s fee', out: priv, why: D.priv ? null : 'not read', priv: true });
  const v4 = D.v4, funded = v4.filter((x) => x.liquidity && x.liquidity > 0n).length, zqv = q.zq;
  if (funded) add({ name: 'Uniswap v4', note: `${funded} of ${v4.length} ETH/TAC pools hold liquidity`, why: 'quoted by zQuoter', out: null });
  if (zqv?.status === 'ok') add({ name: 'Uniswap, Sushi or Curve', note: 'found by zQuoter', out: zqv.amountOut });
  const bz = q.board, zside = D.zb ? (buy ? D.zb.asks : D.zb.bids) : [];
  if (bz?.ok) add({ name: 'zSwap boards', note: `${boardsName(bz)}${bz.full ? '' : ` · takes ${fmtUnits(bz.spent, 18, 4)} ${buy ? 'ETH' : 'TAC'} of your amount`}`, out: bz.out, part: !bz.full, boards: true, runs: runs === 'boards' });
  else if (zside.length) add({ name: 'zSwap boards', note: `${zside.length} resting order${zside.length === 1 ? '' : 's'}`, why: S.pin ? 'the pinned order cannot fill this' : 'none fits this amount', out: null });
  const bk = q.book;
  if (bk) {
    if (buy) add({ name: 'Bitcoin order book', note: `pay ${satsFmt(bk.sats)} sats instead`, out: bk.out, why: bk.out ? null : 'no listing that small', btc: true });
    else if (bk.sell?.fills.length) {
      const sp = bk.sell, manual = sp.fills.filter((f) => !f.bid.auto).length;
      add({ name: 'Bitcoin order book', show: `${satsFmt(bk.sats)} sats`, btc: true,
        note: `${sp.fills.length} standing bid${sp.fills.length === 1 ? '' : 's'} · ${!manual ? 'a watchtower settles them, usually within minutes' : manual === sp.fills.length ? 'each settles when its bidder is online' : 'some settle when their bidder is online'}${sp.leftoverBase ? ` · for ${fmtUnits(sp.amount * E10, 18, 2)} of your TAC` : ''} · before about ${satsFmt(sp.feesEst)} sats of Bitcoin fees`, out: null });
    } else add({ name: 'Bitcoin order book', note: bk.bids ? `${bk.bids} standing bids, none takes this amount` : D.bidsRead ? 'no standing bid' : 'the standing bids could not be read', why: `a sale can be listed at your price: about ${satsFmt(bk.sats)} sats at the last trade`, out: null, btc: true });
  }
  // The best is among the ways that fill the whole amount in ETH or TAC: the pools, zQuoter's finds and the boards' orders when they take it all.
  const eth = rows.filter((r) => r.out != null && !r.priv && !r.btc && !r.part).map((r) => BigInt(r.out));
  const best = eth.length ? eth.reduce((a, b) => (b > a ? b : a)) : null;
  tb.innerHTML = rows.map((r) => {
    const isBest = best != null && r.out != null && !r.priv && !r.btc && !r.part && BigInt(r.out) === best;
    const delta = r.out != null && best && !r.part && !r.btc ? Number((BigInt(r.out) - best) * 10000n / best) / 10000 : null;
    const cell = r.out != null ? `<b class="num">${f(r.out)}</b>` : r.show ? `<b class="num">${esc(r.show)}</b>` : `<span class="mute">${esc(r.why || '')}</span>`;
    return `<tr${isBest ? ' class="best"' : ''}><td><b>${esc(r.name)}</b>${isBest ? '<span class="tag">best</span>' : ''}${r.runs ? '<span class="tag mute">this ticket</span>' : ''}${r.priv ? '<span class="tag mute">estimate</span>' : ''}<small>${esc(r.note || '')}</small></td><td class="r">${cell}</td><td class="r opt num">${delta != null && !isBest ? esc(pct(delta, 1)) : ''}</td></tr>`;
  }).join('');
  // What holds no TAC quote is one line, not three rows of "none".
  const none = [];
  if (!funded) none.push(v4.length ? `Uniswap v4's ${v4.length} ETH/TAC pools hold no liquidity` : 'Uniswap v4 has no ETH/TAC pool');
  if (zqv == null) none.push('Uniswap v2/v3, Sushi and Curve are being checked');
  else if (zqv.status === 'no-route') none.push('no Uniswap v2/v3, Sushi or Curve pool lists TAC');
  else if (zqv.status !== 'ok') none.push('Uniswap v2/v3, Sushi and Curve did not answer in time');
  if (D.zb && !D.zb.asks.length && !D.zb.bids.length) none.push(D.zb.answered < BOARD_CALLS ? 'no TAC order was found on the zSwap boards that answered' : 'zSwap has no TAC orders');
  absent.textContent = none.length ? `Not quoting: ${none.join('; ')}.` : '';
  note.textContent = `The first rows are what the ticket runs on. The Tacit pool is one set of reserves: a public swap goes through its AMM contract, a private one spends a shielded note in the app and pays the relay's fee ${buy ? 'on top' : 'out of the TAC'}. zSwap's boards run on their resting orders: the ticket uses them when they take the whole amount and pay 1% more than the pool it would use, or when you pick an order in the order book. ${buy ? 'The Bitcoin row buys with sats rather than ETH, and the TAC arrives on Bitcoin.' : 'On the Bitcoin order book a sale goes to a standing bid, which settles when its bidder is online (or within minutes when a watchtower covers it), or is listed at your price.'}`;
}

// ── Bitcoin from the page ──
// The Bitcoin tab's ladders take the visitor into the market module (trade/btc.js: tacit.js's own executors behind a sheet). It can be switched
// off in one browser with #btc=off (and on again with #btc=on).
const btcOn = () => { try { return localStorage.getItem('tacit-trade-btc') !== '0'; } catch { return true; } };
let bitcoin = null;
function notify(msg, kind = '', ms = 5000) {
  const t = document.createElement('div');
  t.className = `btoast ${kind}`; t.setAttribute('role', 'status'); t.textContent = msg; document.body.append(t);
  $('#live').textContent = msg;
  setTimeout(() => t.remove(), ms);
}
async function openBitcoin(prime = null) {
  try {
    bitcoin ||= (await import('/trade/btc.js?cb=91c6530d')).makeBitcoin({ notify, onTraded: () => loadBitcoin().then(paintAll).catch(() => {}) });
    await bitcoin.open(prime);
  } catch (e) { notify(`The Bitcoin market could not be opened: ${e?.message || e}`, 'error', 9000); }
}
// What the ticket is set to when a listing or a bid is picked: everything cheaper than it, and it, as the market module's own rows do.
function bookPrime(kind, i) {
  const b = D.book, upTo = (rows, side) => ladderLevels(rows, side).slice(0, i + 1).reduce((a, l) => a + l.amount, 0n);
  if (kind === 'buy') return { side: 'buy', type: 'market', receiveBase: upTo(b.asks.filter((r) => !r.mine), 'ask') };
  if (kind === 'sell') return { side: 'sell', type: 'market', sellBase: upTo(b.bids.filter((r) => !r.mine), 'bid') };
  if (kind === 'list') return { side: 'sell', type: 'limit' };
  return null;
}

// ── the order books and the facts ──
// Two books, one panel: zSwap's boards on Ethereum (orders to buy and to sell, any of which the ticket can fill) and the Bitcoin order book
// (listings). The depth chart draws what the orders add up to by price; the ladders list them, with a Fill on each Ethereum order.
const depth = mountDepth($('#depthchart'), { onPick: (e) => { if (e?.order && bookTab() === 'eth') pinOrder(e.order.key); } });
const hasBoardOrders = () => !!D.zb && (D.zb.asks.length > 0 || D.zb.bids.length > 0);
const bookTab = () => S.book || (D.zb ? (hasBoardOrders() ? 'eth' : 'btc') : (D.zbFailed ? 'btc' : 'eth'));                   // until a tab is chosen: Ethereum, unless its boards hold nothing
const ethPx = (p) => (D.ethUsd ? p * D.ethUsd : p);
const ethPxFmt = (v) => (D.ethUsd ? usd(v) : `${sig(v)} ETH`);
const btcPx = (sats) => (D.btcUsd ? (sats * D.btcUsd) / 1e8 : sats);
const btcPxFmt = (v) => (D.btcUsd ? usd(v) : `${satsFmt(v)} sats`);
const tacFmt = (n) => grp(n, n >= 100 ? 0 : 2);
const left = (t) => { const d = t - now(); return d <= 0 ? 'now' : d < 3600 ? `${Math.ceil(d / 60)} min` : d < 172800 ? `${Math.round(d / 3600)} h` : `${Math.round(d / 86400)} days`; };
const ZSWAP_LINK = `<a href="${ZSWAP_HOST}" target="_blank" rel="noopener noreferrer">Place an order on zSwap →</a>`;
function ethRow(o, taking) {
  const ask = o.side === 'ask', mine = isMine(o), tac = Number(o.base) / 1e18;
  const meta = [o.partial ? 'part fills ok' : 'whole only', o.expiry ? `ends in ${left(o.expiry)}` : 'no end', o.board === 'dutch' ? 'price changes with time' : o.board === 'floor' ? 'bid climbs' : ''].filter(Boolean).join(' · ');
  return `<tr class="${taking ? 'take' : ''}${mine ? ' mine' : ''}"><td><b class="num">${esc(ethPxFmt(ethPx(o.price)))}</b>${D.ethUsd ? `<small>${esc(sig(o.price))} ETH</small>` : ''}</td><td class="r num">${esc(tacFmt(tac))}</td><td class="r num">${esc(fmtUnits(o.quote, 18, 4))}</td>`
    + `<td class="r opt">${esc(BOARD_NAMES[o.board])}<small>${esc(meta)}</small></td><td class="go">${mine ? '<span class="mute">yours</span>' : `<button class="fillbtn" type="button" data-fill="${esc(o.key)}" aria-label="${ask ? 'Buy' : 'Sell'} ${esc(tacFmt(tac))} TAC at ${esc(ethPxFmt(ethPx(o.price)))} each">Fill</button>`}</td></tr>`;
}
function ethLadder(list, ask) {
  if (!list.length) return '';
  const taking = new Set(S.quote?.board?.ok && routeOf(S.quote) === 'boards' ? S.quote.board.keys : []);
  const head = `<thead><tr><th>Price</th><th class="r">TAC</th><th class="r">ETH</th><th class="r opt">Order</th><th></th></tr></thead>`, rows = (l) => l.map((o) => ethRow(o, taking.has(o.key))).join('');
  const first = list.slice(0, 6), rest = list.slice(6);
  return `<div class="lad"><h3>${ask ? 'For sale' : 'Wanted'} <span>${ask ? 'buy TAC with ETH' : 'sell TAC for ETH'}</span></h3><table class="table">${head}<tbody>${rows(first)}</tbody></table>`
    + (rest.length ? `<details class="more more-rows"><summary>${rest.length} more</summary><table class="table"><tbody>${rows(rest)}</tbody></table></details>` : '') + `</div>`;
}
function renderBook() {
  const tab = bookTab(), box = $('#ladders'), note = $('#depth-note');
  $('#book-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.book === tab)));
  if (tab === 'eth') {
    const z = D.zb;
    if (!z) {
      depth.update({ asks: [], bids: [], empty: D.zbFailed ? 'zSwap\'s boards could not be read just now.' : 'Reading zSwap\'s boards…' });
      box.innerHTML = D.zbFailed ? `<p class="note">zSwap's boards could not be read just now. ${ZSWAP_LINK}</p>` : ''; note.textContent = ''; return;
    }
    const missing = z.answered < BOARD_CALLS ? ' Some of the boards did not answer, so orders may be missing here.' : '';
    const bd = S.quote?.board, via = routeOf(S.quote);
    const take = S.pin == null && via === 'boards' && bd?.ok ? { side: S.quote.buy ? 'ask' : 'bid', size: Number(S.quote.buy ? bd.out : bd.spent) / 1e18 } : null;
    depth.update({
      asks: z.asks.map((o) => ({ price: ethPx(o.price), size: Number(o.base) / 1e18, order: o })), bids: z.bids.map((o) => ({ price: ethPx(o.price), size: Number(o.base) / 1e18, order: o })), take,
      priceFmt: ethPxFmt, sizeFmt: (n) => `${tacFmt(n)} TAC`, label: 'zSwap order book for TAC', empty: 'No TAC orders rest on zSwap\'s boards right now.',
    });
    box.innerHTML = hasBoardOrders() ? `<div class="lads">${ethLadder(z.asks, true)}${ethLadder(z.bids, false)}</div>` : `<p class="note">${z.answered < BOARD_CALLS ? 'No TAC orders were found on the boards that answered.' : 'No TAC orders rest on zSwap\'s boards right now.'}${missing} ${ZSWAP_LINK}</p>`;
    note.innerHTML = hasBoardOrders() ? `Orders resting on zSwap's boards, read from Ethereum. Fill reads one into the ticket; with none picked, the ticket fills the best several in one transaction when that pays more.${missing} ${ZSWAP_LINK}` : '';
    return;
  }
  const b = D.book;
  if (!b) { depth.update({ asks: [], bids: [], empty: 'Reading the Bitcoin order book…' }); box.innerHTML = ''; note.textContent = ''; return; }
  const take = S.quote?.book?.plan?.fills?.length && S.side === 'buy' ? { side: 'ask', size: Number(S.quote.book.plan.amount) / 1e8 } : null;
  depth.update({
    asks: b.asks.map((r) => ({ price: btcPx(r.unit), size: Number(r.amount) / 1e8 })), bids: b.bids.map((r) => ({ price: btcPx(r.unit), size: Number(r.amount) / 1e8 })), take,
    priceFmt: btcPxFmt, sizeFmt: (n) => `${tacFmt(n)} TAC`, label: 'Bitcoin order book for TAC', empty: 'No TAC is listed on the Bitcoin order book right now.',
  });
  const live = btcOn();
  // One line per price (listings at the same price are one level, with how many), as the market page's own book does.
  const side = (rows, ask) => {
    const levels = ladderLevels(rows, ask ? 'ask' : 'bid').slice(0, ask ? 8 : 6);
    if (!levels.length) return '';
    const sub = ask ? 'listings are taken whole' : rows.some((r) => r.auto) ? 'sell TAC for sats' : 'sell TAC for sats · settles when the bidder is online';
    return `<div class="lad"><h3>${ask ? 'For sale' : 'Wanted'} <span>${sub}</span></h3><table class="table"><thead><tr><th>Price</th><th class="r">TAC</th><th class="r">Sats</th>${live ? '<th></th>' : ''}</tr></thead><tbody>${levels.map((l, i) => {
      const amt = Number(l.amount) / 1e8, ends = ask ? Math.min(...l.rows.map((r) => r.expiry).filter(Boolean)) : 0, mine = l.flag === 'mine';
      const small = [D.btcUsd ? `${satsFmt(l.unit)} sats` : '', l.count > 1 ? `×${l.count}` : '', !ask && l.flag === 'auto' ? 'within minutes' : ''].filter(Boolean).join(' · ');
      return `<tr${mine ? ' class="mine"' : ''}${Number.isFinite(ends) && ends ? ` title="Ends in ${esc(left(ends))}"` : ''}><td><b class="num">${esc(btcPxFmt(btcPx(l.unit)))}</b>${small ? `<small>${esc(small)}</small>` : ''}</td><td class="r num">${esc(tacFmt(amt))}</td><td class="r num">${esc(satsFmt(l.sats))}</td>${live ? `<td class="go">${mine ? '<span class="mute">yours</span>' : `<button class="fillbtn" type="button" data-btc="${ask ? 'buy' : 'sell'}" data-i="${i}" aria-label="${ask ? 'Buy up to' : 'Sell up to'} ${esc(tacFmt(amt))} TAC at ${esc(btcPxFmt(btcPx(l.unit)))} each">${ask ? 'Buy' : 'Sell'}</button>`}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
  };
  box.innerHTML = `<div class="lads two">${side(b.asks, true)}${side(b.bids, false)}</div>` + (live ? `<div class="btc-actions"><button class="fillbtn primary" type="button" data-btc="open">Trade on Bitcoin</button><button class="fillbtn" type="button" data-btc="list">List a sale</button></div>` : '');
  const total = b.asks.reduce((a, r) => a + r.amount, 0n), sats = b.asks.reduce((a, r) => a + r.sats, 0), want = b.bids.reduce((a, r) => a + r.amount, 0n);
  const bidsTxt = !D.bidsRead ? 'The standing bids could not be read just now.' : b.bids.length ? `${b.bids.length} standing bid${b.bids.length === 1 ? '' : 's'} want${b.bids.length === 1 ? 's' : ''} ${grp(Number(want) / 1e8, 0)} TAC; a sale to one settles when its bidder is online${b.bids.some((r) => r.auto) ? ', or within minutes where a watchtower covers it' : ''}.` : 'No bid stands on the book right now.';
  note.innerHTML = b.asks.length ? `${b.asks.length} listings hold ${grp(Number(total) / 1e8, 0)} TAC for ${grp(sats, 0)} sats in all, taken whole. ${bidsTxt} A buyer needs sats on a Bitcoin address.${live ? '' : ` <a href="/tac/#buy">Buy on Bitcoin →</a> · <a href="/classic.html#tab=market&aid=${TAC_BTC_ID}&lane=btc">List a sale →</a>`}` : bidsTxt;
}
// Pinning an order: the ticket takes its side and size, and trades with that order alone.
function renderPin() {
  const el = $('#pin'), o = pinnedOrder();
  if (!S.pin || !o) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span>Filling ${esc(BOARD_NAMES[o.board])} order #${esc(o.id)}</span><button class="linkbtn" type="button" id="unpin">Use the best route</button>`;
}
function pinOrder(key) {
  const o = [...(D.zb?.asks || []), ...(D.zb?.bids || [])].find((x) => x.key === key);
  if (!o || isMine(o) || S.busy) return;
  const buy = o.side === 'ask';
  S.pin = key; S.side = buy ? 'buy' : 'sell'; S.review = null;
  S.amt = plain(buy ? o.quote : o.base); $('#amt').value = S.amt;
  $('#side-seg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.side === S.side)));
  renderBalance(); renderPin(); renderReview(); requote();
  $('.p-ticket').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function renderAbout() {
  $('#about').innerHTML = `<p><b>TAC</b> is Tacit's token: 21,000,000, issued once on Bitcoin with no mint authority. On Ethereum it is an ERC-20 that only Tacit's confidential pool can mint, from TAC proven to have left Bitcoin, so there is one supply and two lanes. <a href="/verify.html">Check the supply →</a></p>`;
  const link = (a, t) => `<a href="${SCAN}${a}" target="_blank" rel="noopener noreferrer">${t || `${a.slice(0, 8)}…${a.slice(-6)}`}</a>`;
  const pool = getConfidentialDeployment('mainnet')?.pool;
  const main = [
    ['On Ethereum', `ERC-20 ${link(TAC_ERC20)}${D.ethSupply != null ? ` · ${grp(Number(D.ethSupply) / 1e18, 0)} TAC minted there so far` : ''}`],
    ['On Bitcoin', `Asset <code>${TAC_BTC_ID.slice(0, 8)}…${TAC_BTC_ID.slice(-6)}</code>${D.btc?.holders ? ` · ${grp(D.btc.holders, 0)} holders` : ''}${D.btc?.vol24 ? ` · ${grp(D.btc.vol24, 0)} sats traded in 24 hours` : ''}`],
    ['Between them', `<a href="/#bridge">The bridge</a> moves TAC from Bitcoin to Ethereum in a few hours, sometimes up to a day.`],
  ];
  const more = [
    ['Precision pool', `${link(PRECISION_POOL)} · TAC/ETH${D.precision ? ` · holds ${fmtUnits(D.precision.eth, 18, 2)} ETH and ${fmtUnits(D.precision.tac, 18, 0)} TAC` : ''}`],
    ['Tacit pool', `AMM inside Tacit's confidential pool ${pool ? link(pool) : ''} · TAC/tETH, 0.30% fee${D.priv ? ` · ${fmtUnits(D.priv.rEth, 8, 2)} tETH and ${fmtUnits(D.priv.rTac, 8, 0)} TAC` : ''}. One set of reserves: swap through its AMM contract ${link(TACIT_AMM)} (amounts visible) or with shielded notes (who and how much stay hidden).`],
    ['Uniswap v4', `${D.v4.length} hookless ETH/TAC pools exist, with fees of ${D.v4.map((x) => `${x.fee / 1e4}%`).join(', ')}. ${D.v4.some((x) => x.liquidity > 0n) ? 'Some hold liquidity.' : 'None holds liquidity now.'} zQuoter scans only the standard fee tiers, so this page reads these pools itself.`],
    ['Buybacks', `${link('0x6919cbEf0e70AFFA02Ae02c86c532A137154f250', 'TacBuyback')} buys TAC for the reserve on the Tacit pool or the Precision pool, whichever quotes better: at most 0.25 ETH, once every 6 hours.`],
    ['More', `<a href="https://github.com/src-company/tacit/blob/main/docs/TAC.md" target="_blank" rel="noopener noreferrer">About TAC</a> · <a href="/#asset/tac">TAC in the app</a> · <a href="/weld/stats/">Stats</a>`],
  ];
  const li = ([k, v]) => `<li><b>${esc(k)}</b><span>${v}</span></li>`;
  $('#facts').innerHTML = main.map(li).join('');
  $('#facts-more').innerHTML = more.map(li).join('');
}

// ── the wallet and the trade ──
const wallet = makeWallet({ rpc });
const W = wallet.state;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const plain = (v, dec = 18) => { const n = BigInt(v), b = 10n ** BigInt(dec), f = (n % b).toString().padStart(dec, '0').replace(/0+$/, ''); return `${n / b}${f ? `.${f}` : ''}`; };
const say = (t) => { $('#status').innerHTML = t; };
const txLink = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}…↗</a>`;
async function readBalances() {
  if (!W.account) { S.bal = null; return; }
  const [eth, tac] = await Promise.all([rpc('eth_getBalance', [W.account, 'latest']).then((x) => BigInt(x), () => null), ethCall(TAC_ERC20, '0x70a08231' + word(BigInt(W.account))).then((x) => wordAt(x, 0), () => null)]);
  S.bal = { eth, tac };
}
const spendable = () => (S.bal ? (S.side === 'buy' ? S.bal.eth : S.bal.tac) : null);
function renderBalance() {
  const b = $('#in-bal'), have = spendable();
  b.hidden = have == null;
  if (have != null) b.textContent = `Balance ${fmtUnits(have, 18, 4)} ${S.side === 'buy' ? 'ETH' : 'TAC'} · Max`;
}
function renderGo() {
  const go = $('#go'), q = S.quote, buy = S.side === 'buy', wei = getAmount();
  go.hidden = !!S.review;
  go.disabled = false;
  if (!W.account) { go.textContent = 'Connect wallet'; return; }
  if (!wei) { go.textContent = 'Enter an amount'; go.disabled = true; return; }
  if (!routeOf(q) || !D.perEth) { go.textContent = 'Reading the pools…'; go.disabled = true; return; }     // the review measures the price impact against the Precision pool's price, so it needs it
  const have = spendable();
  if (have != null && wei > have) { go.textContent = `Not enough ${buy ? 'ETH' : 'TAC'}`; go.disabled = true; return; }
  if (!buy && S.bal && S.bal.eth != null && S.bal.eth < 5n * 10n ** 14n) { go.textContent = 'Needs a little ETH for the network fee'; go.disabled = true; return; }
  go.textContent = buy ? 'Review buy' : 'Review sell';
}
// Everything the trade will do, from the quote on the ticket: the amount, the least it will accept, the route and what it costs in price.
function planOf() {
  const q = S.quote, { wei, dir, buy, rt } = q;
  if (routeOf(q) === 'boards') {
    const bd = q.board, expected = D.perEth ? (buy ? Number(bd.spent) * D.perEth : Number(bd.spent) / D.perEth) : null;
    // the least the boards guarantee at the slippage chosen, summed over the orders
    const floor = buildBoardFill({ plan: bd.plan, side: buy ? 'buy' : 'sell', token: TAC_ERC20, account: W.account, deadline: 0n, slipBps: S.slip }).minOut;
    return { via: 'boards', wei: bd.spent, dir, buy, board: bd, out: bd.out, floor, impact: expected ? Math.max(0, 1 - Number(bd.out) / expected) : 0, split: false };
  }
  const pick = rt.pick === 'split' ? rt.split : rt.single, out = BigInt(pick.amountOut);
  const expected = D.perEth ? (buy ? Number(wei) * D.perEth : Number(wei) / D.perEth) : null;                      // at the Precision pool's own price, before any impact
  return { via: 'pools', wei, dir, buy, rt, out, floor: (out * BigInt(10000 - S.slip)) / 10000n, impact: expected ? Math.max(0, 1 - Number(out) / expected) : 0, split: rt.pick === 'split' };
}
function renderReview() {
  const box = $('#review');
  if (!S.review) { box.hidden = true; box.innerHTML = ''; renderGo(); return; }
  box.hidden = false; renderGo();
  if (S.review.pick) {
    box.className = 'review';
    box.innerHTML = `<h3>Choose a wallet</h3><div class="picks">${wallet.available().map((w, i) => `<button class="btn ghost" type="button" data-pick="${i}">${esc(w.info?.name || 'Wallet')}</button>`).join('')}</div>`;
    return;
  }
  const P = S.review, buy = P.buy, inU = buy ? 'ETH' : 'TAC', outU = buy ? 'TAC' : 'ETH', dp = buy ? 2 : 6;
  const gate = P.impact >= 0.1;
  box.className = 'review';
  box.innerHTML = html`<h3>${buy ? 'Buy' : 'Sell'} TAC</h3>
    <div class="kv"><span>You pay</span><b>${esc(fmtUnits(P.wei, 18, 6))} ${inU}</b></div>
    <div class="kv"><span>You get about</span><b>${esc(fmtUnits(P.out, 18, dp))} ${outU}</b></div>
    <div class="kv"><span>At least</span><b>${esc(fmtUnits(P.floor, 18, dp))} ${outU}</b></div>
    <div class="kv"><span>Route</span><b>${esc(P.via === 'boards' ? boardsName(P.board) : P.split ? `Split: ${splitWhat(P.rt.split)}` : P.rt.single.venue === 'precision' ? 'Precision pool' : 'Tacit pool')}</b></div>${P.via === 'boards' ? boardLegs(P) : ''}
    ${P.impact >= 0.005 ? `<div class="kv"><span>Price impact</span><b class="${P.impact >= 0.05 ? 'err' : ''}">${(P.impact * 100).toFixed(P.impact < 0.1 ? 1 : 0)}%</b></div>` : ''}
    <div class="kv"><span>From</span><b>${esc(short(W.account))} · ${esc(W.name)}</b></div>
    ${gate ? `<label class="ack"><input type="checkbox" id="ack"><span>I accept losing about ${Math.round(P.impact * 100)}% of this ${buy ? 'purchase' : 'sale'} ${P.via === 'boards' ? 'against the Precision pool\'s price' : 'to the pools\' price move. A smaller amount moves it less'}.</span></label>` : ''}
    <div class="slip"><span class="mute">Slippage</span><div class="seg" id="slip-seg" role="group" aria-label="Slippage"><button type="button" data-slip="50">0.5%</button><button type="button" data-slip="100">1%</button><button type="button" data-slip="300">3%</button></div></div>
    <p class="note">${buy ? 'One transaction.' : 'A permit signature (no gas), then one transaction.'} It is tested without sending first${P.split ? ', and goes to one pool if the split fails its test' : P.via === 'boards' ? '. If an order is filled before the test, nothing is sent' : ''}.</p>
    <div class="row2"><button class="btn ghost" type="button" id="rv-back">Back</button><button class="btn" type="button" id="rv-go"${gate ? ' disabled' : ''}>Confirm in wallet</button></div>`;
  $('#rv-back').onclick = () => { S.review = null; renderReview(); say(''); };
  paintSlip();
  if (gate) $('#ack').onchange = (e) => { $('#rv-go').disabled = !e.target.checked; };
  $('#rv-go').onclick = () => execute(P);
}
// The orders a review will fill, one line each (the first five).
function boardLegs(P) {
  const fills = P.board.plan.fills, buy = P.buy;
  const line = (f) => `<div class="kv"><span>${esc(BOARD_NAMES[f.order.board])} #${f.order.id}</span><b>${esc(fmtUnits(buy ? f.get : f.pay, 18, 2))} TAC for ${esc(fmtUnits(buy ? f.pay : f.get, 18, 5))} ETH${f.whole ? '' : ' · part'}</b></div>`;
  return fills.slice(0, 5).map(line).join('') + (fills.length > 5 ? `<div class="kv"><span>and ${fills.length - 5} more</span><b></b></div>` : '');
}
async function connectWallet() {
  const list = wallet.available();
  if (!list.length) { say('No wallet was found in this browser. Open this page in one that has a wallet, or trade from the app.'); return; }
  try {
    if (list.length > 1 && !S.review) { S.review = { pick: true }; renderReview(); return; }
    await wallet.connect(list[0]);
    await afterConnect();
  } catch (e) { say(esc(e instanceof UserStopped ? e.message : (e.message || 'The wallet did not connect.'))); }
}
async function afterConnect() { S.review = null; await readBalances(); renderBalance(); renderReview(); if (getAmount()) requote(); else renderGo(); }
wallet.onChange(() => { if (S.busy) return; S.review = null; readBalances().then(() => { renderBalance(); renderReview(); if (getAmount()) requote(); }); });   // a trade in flight keeps the account it was reviewed for: the wallet module refuses to send for another

// The transaction, with the TAC a sale spends made available: a permit signed (no gas) where the route takes one, else an approval sent first.
async function withTacAccess({ make, buy, permit, from, dl }) {
  let tx = make();
  if (!buy && tx.approval) {
    const have = wordAt(await ethCall(TAC_ERC20, '0xdd62ed3e' + word(BigInt(from)) + word(BigInt(tx.approval.spender))), 0);
    if (have < tx.approval.amount) {
      if (permit) {
        say('Sign the permit for your TAC in your wallet. It costs no gas.');
        const nonce = wordAt(await ethCall(TAC_ERC20, '0x7ecebe00' + word(BigInt(from))), 0);
        const sig = await wallet.signPermit({ token: TAC_ERC20, name: 'Tacit Token', spender: tx.approval.spender, value: tx.approval.amount, deadline: dl, nonce, owner: from });
        tx = make({ value: tx.approval.amount, deadline: dl, ...sig });
      } else {
        say('Approve the TAC for this pool in your wallet.');
        const h = await wallet.sendTx({ to: TAC_ERC20, data: encErc20Approve(tx.approval.spender, tx.approval.amount), from });
        say(`Waiting for the approval ${txLink(h)}`);
        if ((await wallet.receipt(h)).status !== '0x1') throw new Error('The approval did not go through.');
      }
    }
  }
  return tx;
}

// The pools' trade, made ready: the price read again, the route that was reviewed kept (a split stays a split, one pool stays that pool), tested once.
// → the transaction, or null when a reason has been said and nothing is to be sent.
async function preparePools(P, from) {
  const buy = P.buy, dir = P.dir;
  say('Reading the price again…');
  const rt = await venues.route({ dir, amountIn: P.wei, account: from, gasPrice: await gasPrice() });
  if (!rt.single) throw new Error('No pool can fill this right now.');
  const venue = P.rt.single.venue, pick = P.split ? rt.split : (rt.r.ranked || []).find((x) => x.venue === venue);
  if (!pick) { S.review = null; renderReview(); say('The route you reviewed is no longer on offer. Nothing was sent; review it again.'); requote(); return null; }
  if (BigInt(pick.amountOut) < P.floor) { S.review = null; renderReview(); say('The price moved below the least you accepted. Nothing was sent; review it again.'); requote(); return null; }
  // The least it will take follows the price now, at the slippage chosen, and is never below what was reviewed.
  const floorFor = (route) => { const f = (BigInt(route.amountOut) * BigInt(10000 - S.slip)) / 10000n; return f > P.floor ? f : P.floor; };
  const dl = BigInt(now() + 1200);
  const prepare = async (route) => {
    const isSplit = !!route.legs, floor = floorFor(route);
    const make = (permit) => (isSplit ? venues.buildSplit({ split: route, account: from, minOut: floor, deadline: dl, permit }) : venues.build({ quote: route, dir, account: from, minOut: floor, deadline: dl, permit }));
    const tx = await withTacAccess({ make, buy, permit: route.venue === 'precision' || isSplit, from, dl });
    say('Testing it once without sending…');
    return { tx, sim: await venues.simulate({ tx, from }) };
  };
  let run = await prepare(pick);
  if (!run.sim.ok && P.split) {
    say('The split did not run in a test, so this goes to one pool.');
    if (BigInt(rt.single.amountOut) < P.floor) throw new Error('The price on one pool alone is below the least you accepted. Nothing was sent.');
    run = await prepare(rt.single);
  }
  if (!run.sim.ok) throw new Error('This trade would not go through right now: it was tested first, and nothing was sent. Try a smaller amount, or again in a moment.');
  return run.tx;
}

// The boards' trade: the same orders read again at their terms now (an order filled or taken down meanwhile stops it), each asked of its own
// board for what it settles at, then one transaction that fills them all, tested once.
async function prepareBoards(P, from) {
  const buy = P.buy, side = buy ? 'buy' : 'sell';
  say('Reading the order book again…');
  const book = await readBook({ ethCall, base: TAC_ERC20, now: now() });
  const rows = new Map((buy ? book.asks : book.bids).map((o) => [o.key, o]));
  const orders = P.board.keys.map((k) => rows.get(k));
  const stop = (why) => { S.review = null; renderReview(); say(why); loadBoards().then(paintAll).catch(() => {}); requote(); return null; };
  if (orders.some((o) => !o)) return stop('An order you reviewed was just filled or taken down. Nothing was sent; review it again.');
  const again = (buy ? planBoardBuy : planBoardSell)(orders, P.wei);
  const fine = again.fills.length ? await refineBoards({ ethCall, plan: again, side }) : null;
  if (!fine) return stop('These orders can no longer be filled together. Nothing was sent; review it again.');
  if (fine.get < P.floor) return stop('The price moved below the least you accepted. Nothing was sent; review it again.');
  const dl = BigInt(now() + 1200);
  const make = (permit) => buildBoardFill({ plan: fine, side, token: TAC_ERC20, account: from, deadline: dl, slipBps: S.slip, permit, floor: P.floor });      // never below the "at least" that was reviewed
  const tx = await withTacAccess({ make, buy, permit: true, from, dl });
  say('Testing it once without sending…');
  if (!(await venues.simulate({ tx, from })).ok) throw new Error('This would not go through right now: it was tested first, and nothing was sent. An order may have been filled; the order book is read again.');
  return tx;
}

// The tested transaction sent, and what arrived said in plain words.
async function sendAndReport(tx, { from, buy }) {
  say('Confirm the transaction in your wallet.');
  const eth0 = await rpc('eth_getBalance', [from, 'latest']).then((x) => BigInt(x), () => null);      // read now: any approval above has been paid for already
  const hash = await wallet.sendTx({ ...tx, from });
  say(`Sent ${txLink(hash)}. Waiting for it to land…`);
  const rc = await wallet.receipt(hash);
  if (rc.status !== '0x1') throw new Error(`The transaction failed on chain (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`);
  // What arrived: the TAC transferred to the account in this transaction (a split or several orders make more than one), or the ETH balance's rise.
  let got;
  if (buy) { const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', me = '0x' + word(BigInt(from)); got = rc.logs.filter((l) => l.address.toLowerCase() === TAC_ERC20.toLowerCase() && l.topics[0] === T && l.topics[2]?.toLowerCase() === me).reduce((a, l) => a + BigInt(l.data), 0n); }
  await readBalances();
  if (!buy && eth0 != null && S.bal?.eth != null && W.account?.toLowerCase() === from.toLowerCase()) got = S.bal.eth - eth0 + BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || 0);
  S.review = null; S.quote = null; S.amt = ''; S.pin = null; $('#amt').value = '';
  renderBalance(); renderReview(); renderQuote(null); renderVenues(null); renderPin();
  loadChain().then(paintAll).catch(() => {});                                                  // the pools have moved
  loadBoards().then(paintAll).catch(() => {});                                                 // and the orders that were filled are gone
  say(`<span class="ok">${buy ? 'Bought' : 'Sold'}.</span> ${got != null ? `${buy ? 'Received' : 'Received about'} ${esc(fmtUnits(got, 18, buy ? 2 : 6))} ${buy ? 'TAC' : 'ETH'} · ` : ''}${txLink(hash)}`);
}

// The trade: made ready for the pools or the boards (whichever the review named), tested once, and only then sent.
async function execute(P) {
  if (S.busy || !W.account) return;
  const from = W.account;                                                                           // everything below is for this account, and the wallet is asked for no other
  S.busy = true; $('#rv-go').disabled = true; $('#rv-back').disabled = true;
  try {
    const tx = await (P.via === 'boards' ? prepareBoards(P, from) : preparePools(P, from));
    if (tx) await sendAndReport(tx, { from, buy: P.buy });
  } catch (e) {
    S.review = null; renderReview();
    say(`<span class="err">${esc(e instanceof UserStopped ? e.message : String(e.message || e).slice(0, 220))}</span>`);
  } finally { S.busy = false; renderGo(); }
}
$('#go').addEventListener('click', () => { if (!W.account) connectWallet(); else if (routeOf(S.quote) && getAmount()) { S.review = planOf(); renderReview(); say(''); } });
$('#review').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  try { await wallet.connect(wallet.available()[Number(b.dataset.pick)]); await afterConnect(); } catch (err) { S.review = null; renderReview(); say(esc(err instanceof UserStopped ? err.message : (err.message || 'The wallet did not connect.'))); }
});
$('#in-bal').addEventListener('click', () => {
  const have = spendable();
  if (have == null) return;
  const v = S.side === 'buy' ? (have > 4n * 10n ** 15n ? have - 4n * 10n ** 15n : 0n) : have;      // a purchase keeps 0.004 ETH back for the network fee
  S.amt = plain(v); $('#amt').value = S.amt; requote();
});
S.slip = (() => { try { const v = Number(localStorage.getItem('tacit-trade-slip')); return [50, 100, 300].includes(v) ? v : 50; } catch { return 50; } })();
const paintSlip = () => $('#slip-seg')?.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.slip) === S.slip)));
$('#review').addEventListener('click', (e) => { const b = e.target.closest('[data-slip]'); if (!b || S.busy) return; S.slip = Number(b.dataset.slip); try { localStorage.setItem('tacit-trade-slip', String(S.slip)); } catch { /* storage is a convenience */ } paintSlip(); if (S.review && !S.review.pick) { S.review = planOf(); renderReview(); } });
paintSlip();

// ── wiring ──
let amtTimer = 0;
$('#amt').addEventListener('input', (e) => { S.amt = e.target.value; clearTimeout(amtTimer); amtTimer = setTimeout(requote, 350); });
$('#side-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-side]');
  if (!b || b.dataset.side === S.side) return;
  S.side = b.dataset.side; S.amt = ''; $('#amt').value = ''; S.review = null; S.pin = null; renderPin(); renderBalance();
  $('#side-seg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.side === S.side)));
  requote(); renderQuote(null); renderVenues(null);
});
$('#book-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-book]'); if (b) { S.book = b.dataset.book; renderBook(); } });
$('#ladders').addEventListener('click', (e) => {
  const f = e.target.closest('[data-fill]'); if (f) { pinOrder(f.dataset.fill); return; }
  const k = e.target.closest('[data-btc]'); if (k) openBitcoin(bookPrime(k.dataset.btc, Number(k.dataset.i)));
});
$('#pin').addEventListener('click', (e) => { if (e.target.closest('#unpin')) { S.pin = null; renderPin(); S.review = null; renderReview(); requote(); renderBook(); } });
$('#lane-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-lane]'); if (b) { S.lane = b.dataset.lane; renderChart(); } });
$('.p-chart').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.closest('#lane-seg')) return;
  if (b.dataset.unit) S.unit = b.dataset.unit; else if (b.dataset.tf) S.tf[S.lane] = Number(b.dataset.tf); else if (b.dataset.range != null) S.range = Number(b.dataset.range); else if (b.dataset.log) S.log = !S.log;
  renderChart();
});
function paintAll() { renderHead(); renderLanes(); renderChart(); renderBook(); renderPin(); renderAbout(); if (S.quote) renderVenues(S.quote); }
renderQuote(null); renderVenues(null); renderControls(); renderAbout(); renderLanes();
const loads = [loadChain().then(paintAll), loadTapes().then(paintAll), loadBitcoin().then(paintAll), loadBoards().then(paintAll)];
Promise.allSettled(loads).then((rs) => {
  D.readAt = now();
  if (rs.every((r) => r.status === 'rejected')) $('#chart').innerHTML = '<p class="chart-empty">The pools could not be read just now. Try again in a moment.</p>';
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (params.get('btc') === 'on' || params.get('btc') === 'off') { try { localStorage.setItem('tacit-trade-btc', params.get('btc') === 'on' ? '1' : '0'); } catch { /* storage is a convenience */ } renderBook(); }
  if (params.get('side') === 'sell') $('#side-seg [data-side="sell"]').click();                   // a side change clears the amount, so it comes first
  if (params.get('amount')) { S.amt = params.get('amount'); $('#amt').value = S.amt; requote(); }
  paintAll();
});
setInterval(() => { if (!document.hidden) { loadChain().then(paintAll).catch(() => {}); loadTapes().then(paintAll).catch(() => {}); loadBitcoin().then(paintAll).catch(() => {}); loadBoards().then(paintAll).catch(() => {}); if (S.quote && !S.review && !S.busy && !S.refreshing) requote(true); if (W.account && !S.review && !S.busy) readBalances().then(() => { renderBalance(); renderGo(); }); } }, 60e3);       // a review being read, or a trade being made, is not redrawn under the person

