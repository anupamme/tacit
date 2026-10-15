// tacit.finance/trade/teth: tETH, private ETH. The pool's totals and its ETH history, the private farms that pair tETH and what a tETH is worth in
// each, and the one thing the page does itself: make ETH private. A wallet pays the deposit and the relay's tip in one transaction; a Tacit key
// (opened here from the wallet's signature or a passkey, never stored) builds the note; the relay proves it. What happens to tETH after that
// (send, swap, farm, bridge to Bitcoin, take out) is done on tacit.finance with the same key, and each button here opens it ready, with the amount.
//
// It reads the chain and the API with no wallet, as /trade/tac/ does, and holds no key it was not given: the key lives in this visit's memory.
import { mountChart, fmtLocalStamp, fmtLocalTime } from '/trade/chart.js?cb=f31c8773';
import { makeConnect, UserStopped } from '/trade/connect.js?cb=b4f67314';
import { makeKeySession, signInSheet, Cancelled } from '/trade/key.js?cb=0a77ef18';
import { readPool, heldHistory, heldBars, rangesFor, barSize, recentMoves, movedSince, readRates, readProgram, poolRows, positionsIn, programEnds, wrapQuote, shown, POOL, WRAP_TIP } from '/trade/teth/read.js?cb=bbfd12bd';
import { wrapEth, settle, readHeld, finish, wrapIssue, relayWords, forgetUx, getUx } from '/trade/teth/wrap.js?cb=0b6c2c41';
import { mountDepth } from '/trade/depth.js?cb=1e8ce418';
import { candlesFromTrades, closeAt } from '/trade/tape.js?cb=6565501b';
import { readMarket, isActive, bookState, refSats, premium, satsTxt, ladders, idle, bookPrime, summary, fillBars, BTC_ID } from '/trade/teth/market.js?cb=7d844f53';
import { $, esc, now, rpc, fmtUnits, plain, parseUnits, grp, sig, usd, pct, ago, short, E10, E18 } from '/trade/util.js?cb=dd68ca48';

const ETHBLUE = '#627eea', ORANGE = '#f7931a';
const SCAN = 'https://etherscan.io/';
const GAS_RESERVE = 4n * 10n ** 15n;                                                              // ETH kept back for the network fee when a deposit takes the whole balance
const PRESETS = [['0.01 ETH', '0.01'], ['0.05 ETH', '0.05'], ['0.25 ETH', '0.25']];

// ── the state of the page ──
const D = { pool: null, hist: null, rates: {}, program: null, rows: [], floor: null, held: null, bal: null, btc: null, btcFailed: false };
let amtTimer = 0;
const S = { mode: 'get', amt: '', useAmt: '', quote: null, seq: 0, busy: false, range: null, unit: 'eth', chart: 'held', bunit: 'usd', btcAll: false, stuck: null, steps: null, ready: false };

const compact = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}k` : usd(x));
const ethUsd = () => D.rates.ethUsd, btcUsd = () => D.rates.btcUsd;
const toEth = (wei) => Number(wei) / 1e18;
// An ETH total as shown (rounded, not cut, so the figure here is the one on the chart): fewer digits the larger it is.
const ethTxt = (wei) => { const x = Math.abs(toEth(wei)); return grp(toEth(wei), x >= 10 ? 1 : x >= 1 ? 2 : x >= 0.1 ? 3 : 4); };
const aprTxt = (a) => (a == null ? '—' : a >= 10000 ? '10,000%+' : `${Math.round(a).toLocaleString('en-US')}%`);
const txLink = (h) => `<a href="${SCAN}tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}…↗</a>`;
const say = (t, err = false) => { const s = $('#status'); s.innerHTML = err ? `<span class="err">${t}</span>` : t; };

// ── the head: what a tETH is worth, what the pool holds ──
function renderHead() {
  const px = ethUsd(), P = D.pool;
  $('#px-usd').textContent = px != null ? usd(px) : 'tETH';
  document.title = px != null ? `tETH ${usd(px)} · tacit trade` : 'tacit trade · tETH';
  const bits = [`<span title="Put in ETH, take out ETH: the pool gives one for one"><b class="num">1 tETH</b> = 1 ETH, private</span>`];
  if (P) {
    bits.push(`<span><b class="num">${esc(grp(toEth(P.held), 2))} ETH</b>${px != null ? ` (${compact(toEth(P.held) * px)})` : ''} held in the pool</span>`);
    bits.push(`<span>${grp(P.deposits, 0)} deposits${P.wallets ? ` · ${grp(P.wallets, 0)} wallets` : ''}</span>`);
  }
  if (D.hist) {
    const m = movedSince(D.hist.pts, 86400);
    if (m.in > 0n || m.out > 0n) bits.push(`<span class="chgs"><span class="chg up"><i>24h in</i> ${esc(ethTxt(m.in))} ETH</span><span class="chg down"><i>out</i> ${esc(ethTxt(m.out))} ETH</span></span>`);
  }
  $('#px-sub').innerHTML = P || px != null ? bits.join('') : '<span class="mute">Reading the pool…</span>';
}

// Where a tETH sits and what each place says it is worth: the pool's own rate, and the three private pools that pair it (priced by their reserves).
function renderLanes() {
  const px = ethUsd(), rows = D.rows, cards = [{ name: 'Wrapped', sw: ETHBLUE, v: px, s: '1 ETH', g: 'the pool\'s own rate' },
    ...rows.map((r) => ({ name: `In the ${r.other} pool`, sw: r.other === 'TAC' ? '#f7931a' : r.other === 'cUSD' ? '#16a34a' : '#f7931a', v: r.usd, s: `${sig(r.per, 3)} ${r.other}`, gap: r.gap, g: r.gap != null ? `${pct(r.gap)} vs ETH${Math.abs(r.gap) >= 0.01 ? ' · apart' : ''}` : 'reading' }))];
  const usds = rows.map((r) => r.usd).filter((x) => x != null), apart = Math.max(0, ...rows.map((r) => (r.gap == null ? 0 : Math.abs(r.gap))));
  const m = D.btc, ref = refSats(px, btcUsd());
  const best = m?.book ? m.book.bestAsk ?? m.book.bestBid : null, bestWord = m?.book?.bestAsk != null ? 'cheapest ask' : 'best bid';
  if (m) cards.push(bookState(m) === 'unread' ? { name: 'On Bitcoin', sw: ORANGE, v: null, s: '', g: 'book not read just now', idle: true }
    : isActive(m) && !m.mark && best ? { name: 'On Bitcoin', sw: ORANGE, v: btcUsd() ? best * btcUsd() / 1e8 : null, s: `${satsTxt(best)} sats`, gap: premium(best, ref), g: `${bestWord} · no trades yet` }
    : isActive(m) && m.mark ? { name: 'On Bitcoin', sw: ORANGE, v: btcUsd() ? m.mark * btcUsd() / 1e8 : null, s: `${satsTxt(m.mark)} sats`, gap: premium(m.mark, ref), g: ref ? `${pct(premium(m.mark, ref))} vs ETH${Math.abs(premium(m.mark, ref)) >= 0.01 ? ' · apart' : ''}` : 'last trade' }
    : { name: 'On Bitcoin', sw: ORANGE, v: null, s: ref ? `ETH is ≈ ${satsTxt(ref)} sats` : '', g: 'not listed yet', idle: true });
  $('#hints-sum').innerHTML = px != null
    ? `<span>Wrapped <b>${usd(px)}</b></span>${usds.length ? `<span>· in the pools <b>${usd(Math.min(...usds))}${Math.min(...usds) === Math.max(...usds) ? '' : ` to ${usd(Math.max(...usds))}`}</b></span>` : ''}${m && isActive(m) && m.mark && btcUsd() ? `<span>· on Bitcoin <b>${usd(m.mark * btcUsd() / 1e8)}</b></span>` : ''}${apart >= 0.01 ? `<span class="apart">· up to ${Math.round(apart * 100)}% apart</span>` : ''}`
    : 'Where tETH sits';
  $('#lanes').innerHTML = cards.map((c) => `<div class="lane"><span class="k"><i class="sw" style="background:${c.sw}"></i>${esc(c.name)}</span><span class="v num">${c.idle ? '—' : c.v == null && c.name !== 'Wrapped' ? '<i class="sk"></i>' : usd(c.v)}</span><span class="s num">${esc(c.s || '')}</span><span class="g ${c.gap != null && Math.abs(c.gap) >= 0.01 ? 'dev' : ''}">${esc(c.g || '')}</span></div>`).join('');
  $('#gapnote').textContent = apart >= 0.01 ? 'A private pool prices tETH by its own reserves, so a small one can sit well away from ETH. A swap there settles at that pool\'s price.' : '';
}

// ── the chart: the ETH the pool holds, and, once tETH trades on Bitcoin, its price there against ETH's ──
const chart = mountChart($('#chart'), (h) => paintRead(h));
const RANGE_WORDS = { 1: 'past day', 7: 'past week', 30: 'past month', 90: 'past 3 months', 0: 'all time' };
const KINDS = { held: 'ETH held', btc: 'On Bitcoin' };
const btcTrades = () => D.btc?.trades || [];
const kinds = () => ['held', ...(btcTrades().length >= 2 ? ['btc'] : [])];
const kindNow = () => (kinds().includes(S.chart) ? S.chart : 'held');
function spanDays() {
  if (kindNow() === 'btc') { const ts = btcTrades().map((t) => Number(t.ts)).filter(Number.isFinite); return ts.length ? (now() - Math.min(...ts)) / 86400 : 0; }
  return D.hist?.pts.length ? (now() - D.hist.pts[0].t) / 86400 : 0;
}
function effRange() { const days = rangesFor(spanDays()).map(([, d]) => d); return days.includes(S.range) ? S.range : days.includes(30) ? 30 : 0; }
const unitOf = () => (kindNow() === 'btc' ? (S.bunit === 'sats' || !btcUsd() ? 'sats' : 'usd') : (S.unit === 'usd' && ethUsd() ? 'usd' : 'eth'));
const fmtOf = (kind, unit) => (kind === 'btc' ? (unit === 'usd' ? (v) => usd(v) : (v) => `${satsTxt(v)} sats`) : (unit === 'usd' ? (v) => usd(v) : (v) => `${v < 10 ? v.toFixed(2) : grp(v, 1)} ETH`));
function renderControls() {
  const r = effRange(), kind = kindNow(), seg = (label, attr, opts, cur) => `<div class="seg sm" role="group" aria-label="${label}">${opts.map(([v, l]) => `<button type="button" data-${attr}="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
  $('#lane-seg').innerHTML = kinds().map((k) => `<button type="button" data-chart="${k}" aria-pressed="${k === kind}">${KINDS[k]}</button>`).join('');
  $('#range-seg').innerHTML = rangesFor(spanDays()).map(([l, d]) => `<button type="button" data-range="${d}" aria-pressed="${r === d}">${l}</button>`).join('');
  $('#view-seg').innerHTML = kind === 'btc' ? seg('Show in', 'unit', [['usd', 'USD'], ['sats', 'sats']], unitOf()) : seg('Show in', 'unit', [['eth', 'ETH'], ['usd', 'USD']], unitOf());
  const icon = (id) => `<svg class="tk sm" aria-hidden="true"><use href="#tk-${id}"/></svg>`;
  $('#chart-name').textContent = kind === 'btc' ? 'tETH · price on the Bitcoin order book' : 'tETH · private ETH held in the pool';
  $('#chart-pair').innerHTML = icon('teth') + (kind === 'btc' ? icon('btc') : '');
}
function paintRead(h = null) {
  const el = $('#ch-read'), V = S.view;
  let out = '';
  if (V?.bars.length) {
    const { bars, unit, range, kind } = V, b = h?.b || bars.at(-1), first = bars[0].close, k = unit === 'usd' ? ethUsd() : 1;
    const chg = (kind === 'btc' ? first > 0 : first / k >= 0.1) ? b.close / first - 1 : null, up = chg != null && chg >= 0.0005, down = chg != null && chg <= -0.0005;
    const closes = bars.map((x) => x.close), lo = Math.min(...closes), hi = Math.max(...closes), moved = bars.reduce((a, x) => a + (x.vol || 0), 0);
    const f = fmtOf(kind, unit), btc = kind === 'btc';
    const word = h ? `${fmtLocalStamp(b.t)}${b.held ? (btc ? ' · no trades, price held' : ' · no movement') : ''}` : range ? RANGE_WORDS[range] : `all time · since ${fmtLocalTime(bars[0].t, true)}`;
    const ref = unit === 'usd' ? ethUsd() : refSats(ethUsd(), btcUsd()), vs = btc && ref ? premium(b.close, ref) : null;
    const right = h
      ? (b.vol > 0 ? (btc ? `<span><b>${grp(b.vol, b.vol < 10 ? 2 : 1)}</b> tETH${b.n ? ` in ${b.n} trade${b.n === 1 ? '' : 's'}` : ''}</span>` : `<span><b>${grp(b.vol / k, b.vol / k < 10 ? 2 : 1)}</b> ETH moved${b.n ? ` in ${b.n} step${b.n === 1 ? '' : 's'}` : ''}</span>`) : `<span>${btc ? 'no trades in this bar' : 'nothing moved in this bar'}</span>`)
      : `<span>low <b>${f(lo)}</b></span><span>high <b>${f(hi)}</b></span>${moved > 0 ? (btc ? `<span><b>${grp(moved, moved < 10 ? 2 : 0)}</b> tETH traded</span>` : `<span><b>${grp(moved / k, moved / k < 10 ? 2 : 0)}</b> ETH moved</span>`) : ''}${vs != null ? `<span>vs ETH <b>${pct(vs)}</b></span>` : ''}`;
    out = `<div class="l"><span class="px num">${f(b.close)}</span>${chg != null ? `<span class="chg ${up ? 'up' : down ? 'down' : 'mute'}">${up ? '▲' : down ? '▼' : ''} ${Math.abs(chg * 100).toFixed(Math.abs(chg) < 0.1 ? 1 : 0)}%</span>` : ''}<em>${esc(word)}</em></div><div class="r">${right}</div>`;
  }
  if (el.__h !== out) { el.__h = out; el.innerHTML = out; }
}
function renderChart() {
  const kind = kindNow(), H = D.hist;
  renderControls();
  if (kind === 'held' && !H?.pts.length) { chart.update({ series: [], tags: [], period: 3600, label: 'ETH held in the pool', empty: S.histFailed ? 'The pool\'s history could not be read just now. Try again in a moment.' : 'Reading the pool\'s history…' }); S.view = null; paintRead(); return; }
  const span = spanDays(), range = effRange(), unit = unitOf(), since = range ? now() - range * 86400 : 0;
  if (kind === 'btc') {
    const m = D.btc, tf = range === 1 ? 3600 : range === 7 ? 14400 : 86400, all = candlesFromTrades(m.trades, tf);
    const k = unit === 'usd' ? btcUsd() / 1e8 : 1, ref = refSats(ethUsd(), btcUsd());
    const raw = fillBars(all.filter((b) => b.t + tf > since), { tf, since, seed: closeAt(all, since), spot: m.mark || 0, at: now() });
    const bars = raw.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));
    const eth = unit === 'usd' ? ethUsd() : ref;
    chart.update({ series: [{ id: 'btc', name: 'tETH on Bitcoin', color: ORANGE, kind: 'line', area: true, bars, fmt: fmtOf('btc', unit), volFmt: (v) => `${grp(v, 2)} tETH` }],
      tags: [...(bars.length ? [{ y: bars.at(-1).close, label: 'Bitcoin', color: ORANGE }] : []), ...(eth ? [{ y: eth, label: 'ETH', color: ETHBLUE }] : [])], empty: 'Nothing to draw for this range yet.', period: tf, label: `tETH's price on the Bitcoin order book, ${range ? RANGE_WORDS[range] : 'all time'}` });
    S.view = { bars, unit, range, kind };
    paintRead();
    $('#chart-note').textContent = `The trades of tETH the Bitcoin order book has recorded${m.trades.length ? ` (${m.trades.length}; a fill far from the rest is left out)` : ''}; a stretch with no trades holds the price before it. The blue mark is ETH's own price, so the gap between them is what Bitcoin pays for tETH over or under ETH.`;
    return;
  }
  const tf = barSize(range, span), k = unit === 'usd' ? ethUsd() : 1;
  const raw = heldBars(H.pts, { tf, since, spot: D.pool?.held ?? null });
  const bars = raw.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k, vol: b.vol * k }));
  const f = fmtOf('held', unit);
  chart.update({ series: [{ id: 'held', name: 'ETH held', color: ETHBLUE, kind: 'line', area: true, bars, fmt: f, volFmt: (v) => `${grp(v / (k || 1), 2)} ETH` }], tags: bars.length ? [{ y: bars.at(-1).close, label: 'Now', color: ETHBLUE }] : [], empty: 'Nothing to draw for this range yet.', period: tf, label: `ETH held in the Tacit pool, ${range ? RANGE_WORDS[range] : 'all time'}` });
  S.view = { bars, unit, range, kind };
  paintRead();
  $('#chart-note').textContent = `The ETH the Tacit pool contract holds, from every movement of ETH into and out of it: deposits, withdrawals and public swaps. A quiet stretch holds the figure before it, and the right edge is the balance now.${H.exact ? '' : ' The history read does not add up to the balance exactly, so its last point is the balance.'}`;
}

// ── tETH on Bitcoin: the order book, or the quiet state until there is one ──
// With a listing, a bid or a trade, the panel is the TAC page's Bitcoin book (depth, ladders, the last price against ETH's) with a way into the
// market, which opens in a sheet: its executors are tacit.js's, as for TAC. Without one it is the book's empty shape and ETH's price in sats.
const btcOn = () => { try { return localStorage.getItem('tacit-trade-btc') !== '0'; } catch { return true; } };
const depth = mountDepth($('#btc-depth'));
const setHtml = (el, h) => { if (el.__h !== h) { el.__h = h; el.innerHTML = h; } };
function renderBtc() {
  const m = D.btc, ref = refSats(ethUsd(), btcUsd()), live = btcOn(), box = $('#btc-ladder'), acts = $('#btc-actions'), facts = $('#btc-facts'), note = $('#btc-note'), lead = $('#btc-lead'), dep = $('#btc-depth');
  setHtml($('#btc-sum'), summary(m, { ethUsd: ethUsd(), btcUsd: btcUsd(), ref }));
  if (!m) {
    lead.textContent = ''; dep.hidden = true; setHtml(acts, ''); setHtml(facts, ''); note.textContent = '';
    setHtml(box, `<p class="note">${D.btcFailed ? 'Could not read the Bitcoin order book just now. Try again in a moment.' : 'Reading the Bitcoin order book…'}</p>`);
    return;
  }
  const lines = [m.holders != null ? `<li><b>${grp(m.holders, 0)}</b> holder${m.holders === 1 ? '' : 's'} on Bitcoin${m.transfers ? ` · ${grp(m.transfers, 0)} transfer${m.transfers === 1 ? '' : 's'}` : ''}</li>` : ''];
  if (bookState(m) === 'unread') {                                                                  // a listing or a bid list that could not be read is not an empty book
    lead.textContent = ''; dep.hidden = true; setHtml(acts, ''); note.textContent = '';
    setHtml(box, '<p class="note">Could not read the Bitcoin order book just now: its listings or its bids did not answer. Try again in a moment.</p>');
    setHtml(facts, lines.join(''));
    return;
  }
  if (!isActive(m)) {
    lead.innerHTML = '<b>No tETH is listed on Bitcoin yet.</b> Its price in sats, its order book and a way to buy and sell it appear here the moment someone lists or bids.';
    dep.hidden = true; setHtml(acts, '');
    setHtml(box, idle(m, { ref }));
    setHtml(facts, lines.join(''));
    note.innerHTML = 'A listing there is a signed sale anyone can take, and a bid a signed offer anyone can fill: the tETH and the sats change hands together in the transaction that takes it. tETH reaches Bitcoin by the bridge: <a href="/#private/bitcoin">Bridge →</a>';
    return;
  }
  lead.textContent = '';
  const b = m.book, px = (sats) => (btcUsd() ? sats * btcUsd() / 1e8 : sats), pxFmt = (v) => (btcUsd() ? usd(v) : `${satsTxt(v)} sats`);
  dep.hidden = false;
  depth.update({ asks: (b?.asks || []).map((r) => ({ price: px(r.unit), size: Number(r.amount) / 1e8 })), bids: (b?.bids || []).map((r) => ({ price: px(r.unit), size: Number(r.amount) / 1e8 })),
    priceFmt: pxFmt, sizeFmt: (n) => `${grp(n, n >= 100 ? 0 : 2)} tETH`, label: 'Bitcoin order book for tETH', empty: 'No tETH is listed on the Bitcoin order book right now.' });
  setHtml(box, b ? ladders(m, { btcUsd: btcUsd(), live, all: S.btcAll, at: now() }) : '<p class="note">Could not read the listings just now.</p>');
  setHtml(acts, live ? '<button class="fillbtn primary" type="button" data-btc="open">Trade on Bitcoin</button><button class="fillbtn" type="button" data-btc="list">List a sale</button>'
    : `<a class="fillbtn" href="/classic.html#tab=market&aid=${BTC_ID}&lane=btc">Trade on Bitcoin →</a>`);
  if (ref) lines.unshift(`<li>ETH's price: <b>≈ ${esc(satsTxt(ref))} sats</b> a tETH</li>`);
  if (m.vol24) lines.push(`<li><b>${grp(m.vol24, 0)}</b> sats traded in 24h</li>`);
  setHtml(facts, lines.join(''));
  const total = b ? b.asks.reduce((a, r) => a + r.amount, 0n) : 0n, want = b ? b.bids.reduce((a, r) => a + r.amount, 0n) : 0n;
  const bidsTxt = !m.bidsRead ? 'Could not read the bids.' : b?.bids.length ? `${b.bids.length} bid${b.bids.length === 1 ? '' : 's'} (${grp(Number(want) / 1e8, 2)} tETH) settle when the bidder is online${b.bids.some((r) => r.auto) ? ', some within minutes' : ''}.` : 'No bids.';
  note.innerHTML = b?.asks.length ? `${b.asks.length} listing${b.asks.length === 1 ? '' : 's'} (${grp(Number(total) / 1e8, 2)} tETH), taken whole. ${bidsTxt}` : bidsTxt;
}
let bitcoin = null;
function notify(msg, kind = '', ms = 5000) {
  const t = document.createElement('div');
  t.className = `btoast ${kind}`; t.setAttribute('role', 'status'); t.textContent = msg; document.body.append(t);
  $('#live').textContent = msg;
  setTimeout(() => t.remove(), ms);
}
async function openBitcoin(prime = null) {
  try {
    bitcoin ||= (await import('/trade/btc.js?cb=b0f73a4b')).makeBitcoin({ notify, onTraded: () => loadMarket().then(paintAll).catch(() => {}),
      asset: { id: BTC_ID, title: 'tETH on Bitcoin', after: 'tETH you hold on Ethereum comes to Bitcoin by the bridge: <a href="/#private/bitcoin">Bridge →</a>' } });
    await bitcoin.open(prime);
  } catch (e) { notify(`The Bitcoin market could not be opened: ${e?.message || e}`, 'error', 9000); }
}

// ── the ticket: make ETH private ──
const getWei = () => parseUnits(S.amt, 18);
const spendable = () => (D.bal?.who === W.account ? D.bal.eth : null);
async function readBalances() {
  const who = W.account;
  if (!who) { D.bal = null; return; }
  const eth = await rpc('eth_getBalance', [who, 'latest']).then((x) => BigInt(x), () => null);
  if (W.account === who) D.bal = { who, eth };                                                    // read for an account that has since changed: dropped
}
function renderBalance() {
  const b = $('#in-bal'), have = spendable();
  b.hidden = have == null;
  if (have != null) b.textContent = `Balance ${fmtUnits(have, 18, 4)} ETH · Max`;
}
function renderChips() {
  $('#chips').innerHTML = PRESETS.map(([l, v]) => `<button type="button" data-amt="${v}" aria-pressed="${S.amt === v}"${S.busy ? ' disabled' : ''}>${l}</button>`).join('');
}
function lockTicket() {
  for (const el of $('#get').querySelectorAll('input, [data-amt], #in-bal')) el.disabled = S.busy;
  $('#mode-seg').querySelectorAll('button').forEach((b) => { b.disabled = S.busy; });
}
function keepInHash() {
  if (!S.ready) return;
  const p = new URLSearchParams();
  if (S.mode === 'use') p.set('mode', 'use');
  if (S.amt) p.set('amount', S.amt);
  history.replaceState(null, '', `${location.pathname}${location.search}${p.size ? `#${p}` : ''}`);
}
async function requote() {
  const wei = getWei(), my = ++S.seq;
  $('.p-ticket').classList.remove('stale');
  if (!wei) { S.quote = null; renderQuote(); renderGo(); return; }
  const issue = wrapIssue(wei);
  if (issue) { S.quote = { wei, issue }; renderQuote(); renderGo(); return; }
  S.quote = { wei, loading: true }; renderQuote(); renderGo();
  try { const q = await wrapQuote(wei); if (my !== S.seq) return; S.quote = { wei, ...q }; }
  catch (e) { if (my !== S.seq) return; S.quote = { wei, err: e.message || 'The relay could not quote right now.' }; }
  renderQuote(); renderGo();
}
function renderQuote() {
  const q = S.quote, ok = q && q.tip != null, out = $('#out');
  out.textContent = q?.wei && !q.issue ? fmtUnits(q.wei, 18, 8) : '0.00'; out.classList.toggle('ph', !(q?.wei && !q.issue));
  $('#out-usd').textContent = q?.wei && !q.issue && ethUsd() ? `≈ ${usd(toEth(q.wei) * ethUsd())}` : '';
  const box = $('#route');
  if (!q) { box.innerHTML = ''; $('#tk-note').innerHTML = noteHtml(); return; }
  if (q.issue) { box.innerHTML = `<p class="note err">${esc(q.issue)}</p>`; return; }
  if (q.err) { box.innerHTML = `<p class="note err">${esc(q.err)}</p>`; return; }
  if (q.loading) { box.innerHTML = '<div class="kv"><span>Relay tip</span><b class="mute">reading…</b></div>'; return; }
  const total = q.wei + q.tip, share = q.wei > 0n ? Number(q.tip) / Number(q.wei) : 0;
  box.innerHTML = `<div class="kv"><span title="Paid to Tacit's relay, ${esc(short(q.to, 4))}, in the same transaction">Relay tip</span><b>${esc(fmtUnits(q.tip, 18, 6))} ETH${ethUsd() ? ` <span class="mute">· ${usd(toEth(q.tip) * ethUsd())}${share >= 0.0005 ? `, ${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%` : ''}</span>` : ''}</b></div>
    <div class="kv"><span>Your wallet sends</span><b>${esc(fmtUnits(total, 18, 6))} ETH</b></div>
    <div class="kv"><span>Private to</span><b>${esc(ownerText())}</b></div>
    ${q.floor && q.wei < 3n * q.floor ? `<p class="note">Sending or taking out a note this small later costs about ${esc(fmtUnits(q.floor, 18, 6))} ETH in relay fees.</p>` : ''}`;
  $('#tk-note').innerHTML = noteHtml();
}
// Whose key the note will be made for, said before the wallet is asked: the wallet that pays need not be the one that opened the key.
const ownerText = () => (key.unlocked ? (key.key.address ? `the key of ${short(key.key.address, 4)}` : key.key.label ? `your passkey “${key.key.label}”` : `the key ${short(key.key.pubHex, 4)}`) : 'the Tacit key you open next');
const noteHtml = () => 'One transaction from your wallet pays the deposit and a small tip to Tacit\'s relay, which does the privacy work so nothing heavy runs on your device. Deposits count toward <a href="/#points">TAC points</a>.';
function renderGo() {
  const go = $('#go'), q = S.quote, wei = getWei();
  go.disabled = false; go.title = '';
  if (!W.account) { go.textContent = 'Connect wallet'; return; }
  if (S.busy) { go.textContent = 'Working…'; go.disabled = true; return; }
  if (S.stuck) { go.textContent = 'Finish the earlier deposit first'; go.disabled = true; return; }
  if (!wei) { go.textContent = 'Enter an amount'; go.disabled = true; return; }
  if (q?.issue) { go.textContent = q.issue.replace(/\.$/, ''); go.disabled = true; return; }
  if (!q || q.loading || q.wei !== wei) { go.textContent = 'Reading the relay\'s tip…'; go.disabled = true; return; }
  if (q.err) { go.textContent = 'Try again'; return; }
  const have = spendable();
  if (have != null && q.wei + q.tip > have) { go.textContent = 'Not enough ETH'; go.disabled = true; return; }
  go.textContent = key.unlocked ? 'Make ETH private' : 'Sign in to make ETH private';
}
// The steps of a deposit, as they happen. `now` names the one running; those before it are done.
const STEPS = [['key', 'Open your Tacit wallet'], ['prepare', 'Prepare your note, about half a minute'], ['confirm', 'Confirm the deposit in your wallet'], ['landing', 'The deposit lands on Ethereum'], ['proving', 'The relay proves your note, about a minute']];
function paintSteps(now_ = null, { failed = false, all = false } = {}) {
  const el = $('#steps');
  if (!now_ && !all) { el.hidden = true; el.innerHTML = ''; return; }
  const list = S.steps || STEPS, at = list.findIndex(([k]) => k === now_);
  el.hidden = false;
  el.innerHTML = list.map(([k, t], i) => `<li data-s="${all ? 'done' : i < at ? 'done' : i === at ? (failed ? 'fail' : 'now') : 'todo'}">${esc(t)}</li>`).join('');
}

// ── the key and the wallet ──
const key = makeKeySession();
const connect = makeConnect({
  describe: 'Make ETH private',
  rows: () => `${D.bal?.eth != null ? `<div class="kv"><span>ETH</span><b class="num">${esc(fmtUnits(D.bal.eth, 18, 4))}</b></div>` : ''}${key.unlocked ? `<div class="kv"><span>Tacit key</span><b class="addr-s">${esc(key.key.address ? short(key.key.address, 6) : key.key.label || short(key.key.pubHex, 6))} <button class="linkbtn" type="button" id="sheet-lock">Lock</button></b></div>` : ''}`,
  busy: () => S.busy,
  say,
  onChange: () => { renderBalanceAfter(); },
});
const { wallet, W } = connect;
document.addEventListener('click', (e) => { if (e.target.id === 'sheet-lock' && !S.busy) { lockKey(); e.target.closest('.bsheet')?.querySelector('.x')?.click(); } });
// Which of several announced wallets the key is derived with: the one already connected here.
function pickProvider(list) {
  const mine = wallet.available().find((w) => w.provider === W.prov)?.info?.uuid;
  return mine && list.some((x) => x.uuid === mine) ? mine : list[0]?.uuid;
}
const signIn = () => signInSheet(key, { pick: pickProvider });
function lockKey() {
  key.lock(); forgetUx(); D.held = null; heldP = null; S.stuck = null; S.askedPending = null;                    // what a retry holds (the note's secrets) goes with the key
  paintSteps(null); say(''); renderTicketAll(); renderFarm();
}
key.onChange(() => { renderGo(); renderUse(); renderFarm(); renderQuote(); renderWaiting(); if (key.unlocked && D.held?.pub !== key.key.pubHex) loadHeld(); });   // a key just opened is read at once: what it already holds, and any deposit waiting
function renderBalanceAfter() {
  readBalances().then(() => { renderBalance(); renderGo(); }).catch(() => {});
  renderBalance(); renderGo(); renderUse();
}

// What the key holds: its private tETH, its positions in the farms, and any deposit of its that landed and is waiting for its settle. One read
// per key at a time (a second ask joins it) unless forced; the result is what was read, or null when the key changed meanwhile.
let heldSeq = 0, heldP = null, heldFor = null;
function loadHeld(force = false) {
  if (!key.unlocked) return Promise.resolve(null);
  const pub = key.key.pubHex;
  if (!force && heldP && heldFor === pub) return heldP;
  const my = ++heldSeq;
  heldFor = pub;
  D.held = { ...(D.held?.pub === pub ? D.held : {}), pub, loading: true }; renderUse(); renderWaiting();
  const p = (async () => {
    try {
      const h = await readHeld({ priv: () => key.priv() });
      if (my !== heldSeq || key.key?.pubHex !== pub) return null;
      D.held = { pub, ...h, at: now() };
    } catch (e) { if (my === heldSeq && key.key?.pubHex === pub) D.held = { pub, err: e.message || 'Your private balance could not be read.', at: now() }; }
    finally { if (heldP === p) heldP = null; }
    renderUse(); renderWaiting(); renderFarm();
    return D.held?.pub === pub ? D.held : null;
  })();
  return (heldP = p);
}
function renderWaiting() {
  const el = $('#waiting'), h = D.held, p = key.unlocked && h?.pub === key.key.pubHex ? h.pending || [] : [];
  if (!p.length) { el.innerHTML = ''; return; }
  const sum = p.reduce((a, x) => a + x.value * E10, 0n);
  el.innerHTML = `<div class="callout"><span>${esc(fmtUnits(sum, 18, 6))} ETH ${p.length > 1 ? `in ${p.length} deposits is` : 'is'} waiting to become private.</span><button class="btn" type="button" id="finish"${S.busy ? ' disabled' : ''}>Finish</button></div>`;
}

// The whole of it, from the press: the key if it is not open, then the note, the deposit and the relay's proof.
async function press() {
  if (!W.account) { await connect.connect(); return; }
  const q = S.quote;
  if (S.busy || S.stuck) return;
  if (!q || q.wei !== getWei() || q.tip == null) { clearTimeout(amtTimer); requote(); return; }   // pressed while the amount was still being typed: quote it first
  const from = W.account, hadKey = key.unlocked;
  S.busy = true; S.steps = hadKey ? STEPS.slice(1) : STEPS;
  lockTicket(); renderGo(); renderChips(); renderWaiting(); say('');
  let at = null;
  const step = (k, hash) => { at = k === 'sent' ? 'landing' : k; paintSteps(at); if (hash && k === 'sent') say(`Deposit sent ${txLink(hash)}. Waiting for it to land…`); else if (k === 'proving') say(`${hash ? `Deposited ${txLink(hash)}. ` : ''}The relay is proving your note, about a minute…`); else if (k === 'confirm') say('Confirm the deposit in your wallet.'); else if (k === 'prepare') say('Preparing your note, about half a minute…'); };
  try {
    if (!hadKey) {
      paintSteps('key'); at = 'key'; await signIn();
      // A key just opened is read before it is given a second note: a deposit of its that never finished is the first thing to see.
      const h = await loadHeld();
      if (h?.pending?.length && S.askedPending !== h.pub) { S.askedPending = h.pub; paintSteps(null); say('A deposit of yours is waiting to become private. Press Finish above to make it private first, or press the button again to make a new deposit.'); return; }
    }
    if (W.account !== from) throw new Error('The wallet\'s account changed. Nothing was sent; try again.');
    await wrapEth({ priv: () => key.priv(), wei: q.wei, tip: q.tip, to: q.to, from, wallet, say: step });
    paintSteps(null, { all: true });
    say(`<span class="ok">Done.</span> ${esc(fmtUnits(q.wei, 18, 8))} tETH is private now. It is in your private balance, and ready to send, swap, farm or bridge. <a href="#" data-mode-go="use">What next →</a>`);
    S.amt = ''; $('#amt').value = ''; S.quote = null; S.seq++; renderQuote(); keepInHash();
    const before = D.held?.pub === key.key.pubHex ? D.held.value ?? null : null;
    loadHeldUntil((h) => (before != null ? (h.value ?? 0n) >= before + q.wei / E10 : !(h.pending || []).length));
  } catch (e) { fail(e, at, q); }
  finally { S.busy = false; lockTicket(); renderGo(); renderChips(); renderWaiting(); readBalances().then(() => { renderBalance(); renderGo(); }).catch(() => {}); }
}
// A note shows in a scan a moment after its settle: look again a few times before leaving it. `done(held)` says when it has.
async function loadHeldUntil(done) {
  for (let i = 0; i < 6; i++) {
    const h = await loadHeld(true);
    if (!h || done(h)) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}
// A deposit that is on its way or in, and then a step failed: it is never asked for again. What is left is the relay's half (asked again for the
// same note, or finished from the key, here or on tacit.finance), and the form is cleared so the deposit cannot be made twice by a press.
function fail(e, at, q) {
  if (e instanceof Cancelled || e?.unlockCancelled) { paintSteps(null); say(''); return; }
  if (e instanceof UserStopped || e?.userStopped) { paintSteps(null); say(esc(e.message), false); return; }
  const dep = e?.deposit;
  paintSteps(at, { failed: true });
  if (dep) {
    S.stuck = { ...dep, wei: q.wei };
    S.amt = ''; $('#amt').value = ''; S.quote = null; S.seq++; renderQuote(); renderChips(); keepInHash();
    say(stuckText(e, S.stuck));
    if (key.unlocked) setTimeout(() => { if (key.unlocked) loadHeld(true); }, dep.landed ? 0 : 20000);
    return;
  }
  say(esc(relayWords(e)), true);
}
const stuckText = (e, st) => `<span class="err">${esc(relayWords(e))}</span><br>${st.landed ? `Your ${esc(fmtUnits(st.wei, 18, 6))} ETH is in the Tacit pool, but it is not private yet.` : `Your ${esc(fmtUnits(st.wei, 18, 6))} ETH deposit was sent ${txLink(st.hash)} but is not confirmed yet.`} There is no need to send it again: <button class="linkbtn" type="button" id="retry">${st.landed ? 'Finish it now' : 'Check again'}</button>, or ${st.landed ? 'finish' : 'once it lands, finish'} it on tacit.finance's Private ETH tab with the same key.`;
async function retry() {
  const st = S.stuck;
  if (!st || S.busy) return;
  S.busy = true; S.steps = STEPS.slice(3); lockTicket(); renderGo();
  try {
    if (!st.landed) {
      say('Waiting for the deposit to land…'); paintSteps('landing');
      const rc = await wallet.receipt(st.hash);
      if (rc.status !== '0x1') { S.stuck = null; paintSteps('landing', { failed: true }); say('<span class="err">The deposit failed on chain. Nothing was lost but its network fee.</span>'); return; }
      st.landed = true;
    }
    say('The relay is proving your note, about a minute…'); paintSteps('proving');
    await settle({ built: st.built, hash: st.hash });
    S.stuck = null; paintSteps(null, { all: true });
    say(`<span class="ok">Done.</span> ${esc(fmtUnits(st.wei, 18, 8))} tETH is private now.`);
    loadHeldUntil((h) => !(h.pending || []).length);
  } catch (e) { paintSteps(st.landed ? 'proving' : 'landing', { failed: true }); say(stuckText(e, st)); }
  finally { S.busy = false; lockTicket(); renderGo(); }
}
async function runFinish() {
  if (S.busy || !key.unlocked) return;
  const p = D.held?.pending || [];
  if (!p.length) return;
  S.busy = true; S.steps = [['proving', 'The relay proves your note, about a minute']]; lockTicket(); renderGo(); renderWaiting(); say(''); paintSteps('proving');
  const kept = 'It is still in the Tacit pool: press Finish again, or finish it on tacit.finance\'s Private ETH tab with the same key. There is no need to send it again.';
  try {
    const { done, err } = await finish({ priv: () => key.priv(), pending: p });
    paintSteps(null);
    if (err) say(`${done ? `${done} settled; another did not: ` : ''}${esc(relayWords(err))} ${kept}`, true);
    else say('<span class="ok">Done.</span> They are private now.');
  } catch (e) { paintSteps(null); say(`${esc(relayWords(e))} ${kept}`, true); }
  finally { S.busy = false; lockTicket(); renderGo(); await loadHeldUntil((h) => !(h.pending || []).length); }
}

// ── use tETH: where it goes next, each a link that opens it ready on tacit.finance ──
function useLinks() {
  const a = parseUnits(S.useAmt, 8), amt = a ? `&amt=${plain(a, 8)}` : '';                     // as the front page's own regex reads an amount
  const tac = D.rows.find((r) => r.other === 'TAC'), fee = D.floor ? `about ${fmtUnits(D.floor, 18, 5)} ETH` : 'small';
  return [
    ['/#private/send', 'Send it privately', 'To a Tacit address or a name. The chain does not show how much or to whom.'],
    [`/#card=swap:eth:tac${amt}`, 'Swap it for TAC', tac?.per ? `Inside the pool, privately. The pool says 1 tETH = ${sig(tac.per, 4)} TAC.` : 'Inside the pool, privately.'],
    ['#farm', 'Farm TAC with it', 'The private farms pair it for you, so tETH alone is enough.', 'scroll'],
    ['/#private/bitcoin', 'Bridge it to Bitcoin', 'Burn it here, hold it at your own Bitcoin address, bring it back when you ask. 0.01 to 0.5 tETH a bridge, a few hours.'],
    [`/#card=shield:eth:wallet${amt}`, 'Back to ETH', `One for one, to your wallet or any address. The relay's fee is ${fee}.`],
    ['/#private/bitcoin', 'Bring tETH back from Bitcoin', 'What you bridged, returned to Ethereum as private tETH. It is the same bridge, on its other side.'],
  ];
}
function renderUse() {
  const h = D.held, mine = key.unlocked && h?.pub === key.key.pubHex;
  $('#held').innerHTML = !key.unlocked
    ? `<div class="held"><span class="mute">Your private balance shows once you sign in.</span><button class="linkbtn" type="button" id="signin">Sign in</button></div>`
    : mine && h.value != null ? `<div class="held"><span><b class="num">${esc(fmtUnits(h.value * E10, 18, 8))}</b> <span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-teth"/></svg>tETH, private</span></span><button class="linkbtn" type="button" id="held-re">refresh</button><button class="linkbtn" type="button" id="held-lock">Lock</button></div>${h.partial ? '<p class="note err">Part of your balance could not be read. Refresh to try again.</p>' : ''}`
    : mine && h.err ? `<div class="held"><span class="err">${esc(h.err)}</span><button class="linkbtn" type="button" id="held-re">retry</button></div>`
    : `<div class="held"><span class="mute">Reading your private balance…</span></div>`;
  const cur = $('#use-amt')?.value ?? S.useAmt;
  $('#uses').innerHTML = `<div class="lbl"><span>Amount</span><span class="mute">optional</span></div><div class="amt"><input id="use-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="tETH to use" value="${esc(cur)}"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-teth"/></svg>tETH</span></div>`
    + `<div id="use-rows">${useRowsHtml()}</div>`;
  $('#use-note').textContent = 'These open tacit.finance. Swap and Back to ETH come with your amount filled in; the bridge asks for its own. Sign in there with the same wallet or passkey: it is the same key.';
}
const useRowsHtml = () => useLinks().map(([href, t, sub, kind]) => `<a class="use" href="${esc(href)}"${kind === 'scroll' ? ' data-scroll' : ''}><b>${esc(t)}</b><span>${esc(sub)}</span><i aria-hidden="true">→</i></a>`).join('');

function setMode(m) {
  S.mode = m;
  $('#mode-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('#get').hidden = m !== 'get'; $('#use').hidden = m !== 'use';
  if (m === 'use') { renderUse(); if (key.unlocked && !D.held) loadHeld(); }
  $('#stick-go').textContent = m === 'use' ? 'Use your tETH' : 'Make ETH private';
  keepInHash();
}
function renderTicketAll() { renderChips(); renderBalance(); renderQuote(); renderGo(); renderUse(); renderWaiting(); }

// ── the farms: the pools that pair tETH, as the front page's Farm sheet lists them ──
// Each row says what the sheet's does: the pool, how deep it is, what it pays a day and the APR now, and (with a key open) what the key has in it.
// Joining, harvesting and exiting are the sheet's: each farm opens there, where the notes are cut, swapped and bonded step by step.
function renderFarm() {
  const p = D.program, e = p?.epoch, rows = D.rows, px = ethUsd(), tacUsd = D.rates.tacEth && px ? D.rates.tacEth * px : null;
  if (!p) { $('#fm-stats').innerHTML = '<p class="note">Reading the farms…</p>'; return; }
  if (!e?.active || !rows.length) { $('#fm-stats').innerHTML = `<p class="note">The private farms are between reward periods. They open here when the next one starts.</p>`; $('#pools').innerHTML = ''; $('#fm-note').textContent = ''; return; }
  const aprs = rows.map((r) => r.apr).filter((a) => a != null), day = Number(e.ratePerDayTac), end = programEnds(p);
  const cell = (k, v, s = '') => `<div><span class="k">${k}</span><b class="num">${v}</b>${s ? `<span class="s">${s}</span>` : ''}</div>`;
  $('#fm-stats').innerHTML = cell('Best APR now', aprs.length ? aprTxt(Math.max(...aprs)) : '—', 'paid in TAC, swap fees on top')
    + cell('Rewards', `<svg class="tk xs inl" aria-hidden="true"><use href="#tk-tac"/></svg>${Math.round(day).toLocaleString('en-US')} TAC`, `a day${tacUsd ? ` · about ${usd(day * tacUsd)}` : ''}`)
    + cell('Farms', `${rows.length}`, 'pair tETH · shielded positions')
    + cell('Stream ends', end ? new Date(end * 1000).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const icon = (k) => `<svg class="tk sm" aria-hidden="true"><use href="#tk-${k}"/></svg>`;
  const mine = key.unlocked && D.held?.pub === key.key.pubHex ? positionsIn(rows, D.held.positions) : new Map();
  const dp = (r) => (r.other === 'cBTC' ? 6 : 2), amt = (x, d) => (x < 0.01 && x > 0 ? 'under 0.01' : grp(x, d));
  $('#pools').innerHTML = rows.map((r) => {
    const m = mine.get(r.pid);
    return `<a class="pf" href="/#farm/private-${r.pid}"><span class="nm"><span class="pairtk">${icon('teth')}${icon(r.other.toLowerCase())}</span>${esc(r.name)}${m ? '<span class="tag">yours</span>' : ''}</span><span class="rt num">${esc(aprTxt(r.apr))}<small>${r.perDay > 0 ? `${Math.round(r.perDay).toLocaleString('en-US')} TAC a day` : 'no reward now'}</small></span><i aria-hidden="true">→</i>`
      + `<span class="sb">${esc(r.depthEth < 0.01 ? 'under 0.01' : grp(r.depthEth, 2))} ETH deep${r.bondedPct != null ? ` · ${Math.round(r.bondedPct * 100)}% farmed` : ''} · ${esc(amt(r.tethSide, 2))} tETH + ${esc(amt(r.otherSide, dp(r)))} ${esc(r.other)} in the pool</span>`
      + (m ? `<span class="sb mine">Yours: ${esc(amt(m.teth, 4))} tETH + ${esc(amt(m.other, dp(r)))} ${esc(r.other)} · ${esc(grp(m.earned, 2))} TAC earned${m.perDay > 0 ? ` · about ${esc(m.perDay >= 10 ? grp(m.perDay, 0) : m.perDay.toFixed(2))} TAC a day` : ''}</span>` : '') + '</a>';
  }).join('');
  const heldHere = key.unlocked && D.held?.pub === key.key.pubHex;
  $('#fm-note').innerHTML = `Each farm opens on tacit.finance, which adds from tETH alone (the pool pairs it for you) or from both sides, and harvests or exits. Positions are shielded: who farms and how much stays private. ${!key.unlocked ? '<button class="linkbtn" type="button" id="fm-signin">Sign in to see yours</button>' : heldHere && D.held.loading ? 'Reading your positions…' : heldHere && D.held.positions == null && !D.held.err ? 'Your positions could not be read just now.' : ''}`;
}

// ── what moved: every ETH movement into and out of the pool ──
function renderMoves() {
  const H = D.hist, body = $('#moves tbody');
  if (!H) return;
  const px = ethUsd(), rows = recentMoves(H.pts, 10);
  body.innerHTML = rows.length ? rows.map((m) => { const inn = m.wei > 0n, v = inn ? m.wei : -m.wei; return `<tr><td title="${esc(new Date(m.t * 1000).toLocaleString())}">${esc(ago(m.t))}</td><td class="${inn ? 'in' : 'out'}">${inn ? 'ETH in' : 'ETH out'}</td><td class="r num" ${px ? `title="${esc(usd(toEth(v) * px))}"` : ''}>${inn ? '+' : '−'}${esc(fmtUnits(v, 18, v < 10n ** 16n ? 4 : 3))}</td></tr>`; }).join('') : '<tr><td colspan="3" class="mute">Nothing has moved yet.</td></tr>';
  const d = movedSince(H.pts, 86400), w = movedSince(H.pts, 7 * 86400);
  $('#mv-sum').textContent = `24h ${ethTxt(d.in)} in, ${ethTxt(d.out)} out · 7d ${ethTxt(w.in)} in, ${ethTxt(w.out)} out`;
  $('#moves-note').textContent = 'Each line is ETH moving into or out of the pool contract, read from the chain: deposits, withdrawals and public swaps. What happens inside the pool is private, and these lines say nothing of whose it is.';
}

// ── about ──
function renderAbout() {
  const P = D.pool, link = (a, t) => `<a href="${SCAN}address/${a}" target="_blank" rel="noopener noreferrer">${t || `${a.slice(0, 8)}…${a.slice(-6)}`}</a>`;
  $('#about').innerHTML = `<p><b>tETH</b> is ETH made private. Put ETH in the Tacit pool and you hold the same amount as tETH, one for one. After that, how much you hold and who you pay is not shown on the chain. You can take it out to ETH again, one for one, less the relay's fee.</p>
    <p>Hold it, send it to anyone, swap it for TAC, farm with it, or bridge it to your own Bitcoin address and bring it back. <a href="/weld/stats/">The pool's figures →</a></p>`;
  const fee = D.floor ? fmtUnits(D.floor, 18, 5) : null;
  const main = [
    ['On Ethereum', `${P ? `${esc(grp(toEth(P.held), 2))} ETH is held in ${grp(P.deposits, 0)} deposits${P.wallets ? ` from ${grp(P.wallets, 0)} wallets` : ''} · ` : ''}the pool is ${link(POOL)}`],
    ['On Bitcoin', 'A bridge burns tETH on Ethereum and the same amount, less the relay fee, arrives at your own Bitcoin address in a few hours, sometimes up to a day. It cannot be undone once it is burned, and it comes back to Ethereum as private tETH once Bitcoin\'s proof there has recorded it. 0.01 to 0.5 tETH a bridge. <a href="/#private/bitcoin">Bridge →</a>'],
    ['What it costs', `Making ETH private pays the relay's tip, shown before you confirm, and the network fee for the transaction${fee ? '. Sending, swapping and taking out cost the relay\'s fee, about ' + esc(fee) + ' ETH at least, and swaps the pool\'s fee' : ''}.`],
  ];
  const pools = D.rows.map((r) => `${esc(r.name)} (${esc(r.depthEth < 0.01 ? 'under 0.01' : grp(r.depthEth, 2))} ETH deep)`).join(' · ');
  const more = [
    ['The pool', `${link(POOL)} · holds the ETH behind every tETH; a settle proves each private move`],
    ['Wrap forwarder', `${link(WRAP_TIP)} · pays the deposit into the pool and the tip to the relay in one transaction`],
    ['Private pools', pools || 'Reading the pools…'],
    ['More', '<a href="/#private">Private ETH in the app</a> · <a href="/#farm">Farms</a> · <a href="/weld/stats/">Stats</a>'],
  ];
  const li = ([k, v]) => `<li><b>${esc(k)}</b><span>${v}</span></li>`;
  $('#facts').innerHTML = main.map(li).join('');
  $('#facts-more').innerHTML = more.map(li).join('');
}

// ── reading ──
async function loadFront() { const p = await readPool(false); if (p) D.pool = p; }
async function loadWhole() {
  const p = await readPool(true);
  if (!p?.flows) return;
  D.pool = { ...(D.pool || {}), ...p, flows: null };
  D.hist = heldHistory(p.flows, p.held);
  D.hist.pts = D.hist.pts;
}
async function loadRates() { D.rates = { ...D.rates, ...(await readRates()) }; }
async function loadFarms() { const p = await readProgram(); if (p?.epoch) D.program = p; D.rows = poolRows(D.program, D.rates); }
// A read that lost the listings or the bids does not replace a book that had them: it is shown as it was until a read gets both again.
async function loadMarket() {
  const m = await readMarket(), was = D.btc;
  if (m) D.btc = (!m.book || !m.bidsRead) && was?.book && was.bidsRead ? { ...m, book: was.book, bidsRead: true } : m;
  D.btcFailed = !D.btc;
}
async function loadFloor() { try { D.floor = (await wrapQuote(10n ** 17n)).floor; } catch { /* the line says "small" */ } }
function paintAll() { renderHead(); renderLanes(); renderChart(); renderBtc(); renderFarm(); renderMoves(); renderAbout(); if (S.mode === 'use') renderUse(); renderQuote(); renderGo(); }

// ── wiring ──
$('#amt').addEventListener('input', (e) => { S.amt = e.target.value; renderGo(); clearTimeout(amtTimer); amtTimer = setTimeout(() => { requote(); keepInHash(); }, 250); $('.p-ticket').classList.add('stale'); renderChips(); });
$('#amt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#go').disabled) $('#go').click(); });
$('#amt').addEventListener('focus', () => { getUx().catch(() => {}); }, { once: true });                 // the pool module takes a moment to load: start it while the amount is typed
$('#chips').addEventListener('click', (e) => { const b = e.target.closest('[data-amt]'); if (!b || S.busy) return; S.amt = b.dataset.amt; $('#amt').value = S.amt; renderChips(); requote(); keepInHash(); });
$('#in-bal').addEventListener('click', () => {
  const have = spendable();
  if (have == null || S.busy) return;
  const v = have > GAS_RESERVE ? ((have - GAS_RESERVE) / E10) * E10 : 0n;
  S.amt = v ? plain(v) : ''; $('#amt').value = S.amt; renderChips(); requote(); keepInHash();
});
$('#go').addEventListener('click', () => { say(''); press(); });
$('#mode-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b && !S.busy) setMode(b.dataset.mode); });
$('#status').addEventListener('click', (e) => {
  if (e.target.id === 'retry') retry();
  const g = e.target.closest('[data-mode-go]'); if (g) { e.preventDefault(); setMode(g.dataset.modeGo); }
});
$('#waiting').addEventListener('click', (e) => { if (e.target.id === 'finish') runFinish(); });
$('#use').addEventListener('click', (e) => {
  const id = e.target.id;
  if (id === 'signin') signIn().then(() => loadHeld()).catch(() => {});
  else if (id === 'held-re') loadHeld();
  else if (id === 'held-lock' && !S.busy) lockKey();
  const a = e.target.closest('[data-scroll]');
  if (a) { e.preventDefault(); $('#farm').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
});
$('#use').addEventListener('input', (e) => { if (e.target.id !== 'use-amt') return; S.useAmt = e.target.value; $('#use-rows').innerHTML = useRowsHtml(); });
$('#btc').addEventListener('click', (e) => {
  if (e.target.closest('[data-more]')) { S.btcAll = !S.btcAll; renderBtc(); return; }
  const k = e.target.closest('[data-btc]');
  if (!k) return;
  const v = k.dataset.btc;
  openBitcoin(v === 'open' ? null : v === 'list' ? bookPrime(D.btc, 'list') : D.btc?.book ? bookPrime(D.btc, v, Number(k.dataset.i)) : null);
});
$('#fm-note').addEventListener('click', (e) => { if (e.target.id === 'fm-signin') signIn().then(() => loadHeld()).catch(() => {}); });
$('.p-chart').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.chart) { S.chart = b.dataset.chart; S.range = null; } else if (b.dataset.unit) { if (kindNow() === 'btc') S.bunit = b.dataset.unit; else S.unit = b.dataset.unit; } else if (b.dataset.range != null) S.range = Number(b.dataset.range); else return;
  renderChart();
});
document.addEventListener('click', (e) => { const h = $('#hints'); if (h.open && !h.contains(e.target)) h.open = false; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#hints').open) { $('#hints').open = false; $('#hints summary').focus(); } });
{
  const stick = $('#stick'), ticket = $('.p-ticket');
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { stick.hidden = e.isIntersecting; }, { rootMargin: '0px 0px -40px 0px' }).observe(ticket);
  $('#stick-go').addEventListener('click', () => ticket.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

renderChips(); renderQuote(); renderGo(); renderAbout(); renderLanes(); renderBtc();
Promise.allSettled([loadMarket().then(() => { renderBtc(); renderLanes(); renderChart(); }), loadFront().then(renderHead), loadRates().then(() => { renderHead(); renderLanes(); renderQuote(); return loadFarms(); }).then(paintAll), loadFloor().then(() => { renderAbout(); renderUse(); })]).then(() => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (params.get('mode') === 'use') setMode('use');
  S.ready = true;
  if (params.get('amount') && S.mode === 'get') { S.amt = params.get('amount'); $('#amt').value = S.amt; renderChips(); requote(); } else keepInHash();
  paintAll();
  loadWhole().catch(() => {}).then(() => { S.histFailed = !D.hist; paintAll(); });                 // the whole reading is large: after the page is up
});
setInterval(() => { if (!document.hidden && !S.busy) { loadFront().then(renderHead).catch(() => {}); loadRates().then(() => loadFarms()).then(paintAll).catch(() => {}); loadMarket().then(paintAll).catch(() => {}); if (W.account) readBalances().then(() => { renderBalance(); renderGo(); }).catch(() => {}); } }, 60e3);
