// tacit.finance/trade/teth: tETH, private ETH. The pool's totals and its ETH history, the private farms that pair tETH and what a tETH is worth in
// each, and the one thing the page does itself: make ETH private. A wallet pays the deposit and the relay's tip in one transaction; a Tacit key
// (opened here from the wallet's signature or a passkey, never stored) builds the note; the relay proves it. What happens to tETH after that
// (send, swap, farm, bridge to Bitcoin, take out) is done on tacit.finance with the same key, and each button here opens it ready, with the amount.
//
// It reads the chain and the API with no wallet, as /trade/tac/ does, and holds no key it was not given: the key lives in this visit's memory.
import { mountChart, fmtLocalStamp, fmtLocalTime } from '/trade/chart.js?cb=97813823';
import { makeConnect, UserStopped } from '/trade/connect.js?cb=b9f00573';
import { makeKeySession, signInSheet, Cancelled } from '/trade/key.js?cb=ad559513';
import { readPool, heldHistory, heldBars, rangesFor, barSize, recentMoves, movedSince, readRates, readProgram, poolRows, positionsIn, programEnds, wrapQuote, shown, POOL, WRAP_TIP } from '/trade/teth/read.js?cb=34fe5a19';
import { wrapEth, settle, readHeld, finish, wrapIssue, relayWords, selfable, selfFinish, settleCost, proveOwn, ownWords, ownable, relayState, relayStopped, forgetUx, getUx } from '/trade/teth/wrap.js?cb=e5e662b7';
import { ownPref, setOwnPref, proverFor, readCredit, proofsFor, fundFromWallet, quoteEth, quoteEthFor, fundWithEth, loadSelfProver, tokenBalance } from '/trade/teth/prover.js?cb=3040333f';
import { overlay } from '/trade/sheet.js?cb=84cda8f2';
import { mountDepth } from '/trade/depth.js?cb=5aaa8a95';
import { candlesFromTrades, closeAt } from '/trade/tape.js?cb=a4aefafb';
import { readMarket, isActive, bookState, refSats, premium, satsTxt, ladders, idle, bookPrime, summary, fillBars, BTC_ID } from '/trade/teth/market.js?cb=3ff5bcec';
import { $, esc, now, rpc, fmtUnits, plain, parseUnits, grp, sig, usd, pct, ago, short, E10, E18 } from '/trade/util.js?cb=c3dc39b3';

const ETHBLUE = '#627eea', ORANGE = '#f7931a';
const SCAN = 'https://etherscan.io/';
const GAS_RESERVE = 4n * 10n ** 15n;                                                              // ETH kept back for the network fee when a deposit takes the whole balance
const PRESETS = [['0.01 ETH', '0.01'], ['0.05 ETH', '0.05'], ['0.25 ETH', '0.25']];

// ── the state of the page ──
const D = { pool: null, hist: null, rates: {}, program: null, rows: [], floor: null, held: null, bal: null, btc: null, btcFailed: false };
let amtTimer = 0;
const S = { mode: 'get', amt: '', useAmt: '', quote: null, seq: 0, busy: false, range: null, unit: 'eth', chart: 'held', bunit: 'usd', btcAll: false, stuck: null, left: null, cost: null, steps: null, ready: false, ownOnce: null };

const tn = (s) => esc(s).replace(/\b(tETH|cBTC|cUSD)\b/g, '<span class="tn">$1</span>');   // a token's own spelling inside an uppercase label
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
  const px = ethUsd(), rows = D.rows, cards = [{ name: 'Pool rate', sw: ETHBLUE, v: px, s: '1 ETH', g: 'one for one' },
    ...rows.map((r) => ({ name: `In the ${r.other} pool`, sw: r.other === 'TAC' ? '#f7931a' : r.other === 'cUSD' ? '#16a34a' : '#f7931a', v: r.usd, s: `${sig(r.per, 3)} ${r.other}`, gap: r.gap, g: r.gap != null ? `${pct(r.gap)} vs ETH${Math.abs(r.gap) >= 0.01 ? ' · apart' : ''}` : 'reading' }))];
  const usds = rows.map((r) => r.usd).filter((x) => x != null), apart = Math.max(0, ...rows.map((r) => (r.gap == null ? 0 : Math.abs(r.gap))));
  const m = D.btc, ref = refSats(px, btcUsd());
  const best = m?.book ? m.book.bestAsk ?? m.book.bestBid : null, bestWord = m?.book?.bestAsk != null ? 'cheapest ask' : 'best bid';
  if (m) cards.push(bookState(m) === 'unread' ? { name: 'On Bitcoin', sw: ORANGE, v: null, s: '', g: 'book not read just now', idle: true }
    : isActive(m) && !m.mark && best ? { name: 'On Bitcoin', sw: ORANGE, v: btcUsd() ? best * btcUsd() / 1e8 : null, s: `${satsTxt(best)} sats`, gap: premium(best, ref), g: `${bestWord} · no trades yet` }
    : isActive(m) && m.mark ? { name: 'On Bitcoin', sw: ORANGE, v: btcUsd() ? m.mark * btcUsd() / 1e8 : null, s: `${satsTxt(m.mark)} sats`, gap: premium(m.mark, ref), g: ref ? `${pct(premium(m.mark, ref))} vs ETH${Math.abs(premium(m.mark, ref)) >= 0.01 ? ' · apart' : ''}` : 'last trade' }
    : { name: 'On Bitcoin', sw: ORANGE, v: null, s: ref ? `ETH is ≈ ${satsTxt(ref)} sats` : '', g: 'not listed yet', idle: true });
  $('#hints-sum').innerHTML = px != null
    ? `<span>Pool rate <b>${usd(px)}</b></span>${usds.length ? `<span>· in private pools <b>${usd(Math.min(...usds))}${Math.min(...usds) === Math.max(...usds) ? '' : ` to ${usd(Math.max(...usds))}`}</b></span>` : ''}${m && isActive(m) && m.mark && btcUsd() ? `<span>· on Bitcoin <b>${usd(m.mark * btcUsd() / 1e8)}</b></span>` : ''}${apart >= 0.01 ? `<span class="apart">· up to ${Math.round(apart * 100)}% apart</span>` : ''}`
    : 'Where tETH sits';
  $('#lanes').innerHTML = cards.map((c) => `<div class="lane"><span class="k"><i class="sw" style="background:${c.sw}"></i>${tn(c.name)}</span><span class="v num">${c.idle ? '—' : c.v == null && c.name !== 'Pool rate' ? '<i class="sk"></i>' : usd(c.v)}</span><span class="s num">${esc(c.s || '')}</span><span class="g ${c.gap != null && Math.abs(c.gap) >= 0.01 ? 'dev' : ''}">${esc(c.g || '')}</span></div>`).join('');
  $('#gapnote').textContent = apart >= 0.01 ? 'Each private pool prices tETH from its own reserves, so a small one can sit away from ETH. Swaps happen at its price.' : '';
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
  $('#chart-name').innerHTML = kind === 'btc' ? tn('tETH price on Bitcoin') : 'ETH held in the pool';
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
    $('#chart-note').textContent = `Trades of tETH on the Bitcoin order book${m.trades.length ? ` (${m.trades.length}; a fill far from the rest is left out)` : ''}. A stretch with no trades repeats the last price. The blue mark is ETH's price, so the gap is what Bitcoin pays for tETH over or under ETH.`;
    return;
  }
  const tf = barSize(range, span), k = unit === 'usd' ? ethUsd() : 1;
  const raw = heldBars(H.pts, { tf, since, spot: D.pool?.held ?? null });
  const bars = raw.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k, vol: b.vol * k }));
  const f = fmtOf('held', unit);
  chart.update({ series: [{ id: 'held', name: 'ETH held', color: ETHBLUE, kind: 'line', area: true, bars, fmt: f, volFmt: (v) => `${grp(v / (k || 1), 2)} ETH` }], tags: bars.length ? [{ y: bars.at(-1).close, label: 'Now', color: ETHBLUE }] : [], empty: 'Nothing to draw for this range yet.', period: tf, label: `ETH held in the Tacit pool, ${range ? RANGE_WORDS[range] : 'all time'}` });
  S.view = { bars, unit, range, kind };
  paintRead();
  $('#chart-note').textContent = `The ETH held by the Tacit pool, from every deposit, withdrawal and public swap. A quiet stretch repeats the last figure, and the right edge is the balance now.${H.exact ? '' : ' The history does not add up exactly, so the last point is the balance.'}`;
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
    lead.innerHTML = '<b>No tETH is listed on Bitcoin yet.</b>';
    dep.hidden = true; setHtml(acts, '');
    setHtml(box, idle(m, { ref }));
    setHtml(facts, lines.join(''));
    note.innerHTML = 'A listing is a signed sale anyone can take; a bid is a signed offer anyone can fill. The tETH and the sats change hands in the same transaction. Get tETH to Bitcoin with the bridge: <a href="/#private/bitcoin">Bridge →</a>';
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
  const bidsTxt = !m.bidsRead ? 'Could not read the bids.' : b?.bids.length ? `${b.bids.length} bid${b.bids.length === 1 ? '' : 's'} (${grp(Number(want) / 1e8, 2)} tETH) settle when the bidder is online.` : 'No bids.';
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
    bitcoin ||= (await import('/trade/btc.js?cb=332419e8')).makeBitcoin({ notify, onTraded: () => loadMarket().then(paintAll).catch(() => {}),
      asset: { id: BTC_ID, title: 'tETH on Bitcoin', after: 'tETH reaches Bitcoin through the bridge: <a href="/#private/bitcoin">Bridge →</a>' } });
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
  // Proved with the holder's own credit: no relay tip, so nothing to ask the relay. The settle's network fee is said once read.
  if (ownOn()) { S.quote = { wei, tip: 0n, to: NO_TIP, own: true, floor: D.floor }; renderQuote(); renderGo(); if (!S.cost) fillCost(); return; }
  // The relay's state is read with its tip: one that proves but is not sending ('held') leaves the settle to the wallet, and the quote says so.
  // Its tip is then the relay's for a proof alone, since the wallet pays the settle's network fee itself.
  S.quote = { wei, loading: true }; renderQuote(); renderGo();
  try {
    const [q, rs] = await Promise.all([wrapQuote(wei), relayState()]);
    if (my !== S.seq) return;
    const held = rs?.state === 'held';
    S.quote = { wei, ...q, held, ...(held ? { tip: q.proveTip } : {}) };
    if (S.quote.held && !S.cost) fillCost();
  } catch (e) { if (my !== S.seq) return; S.quote = { wei, err: e.message || 'The relay could not quote right now.' }; }
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
  // The wallet sends the settle too where the holder proves it, or the relay proves it and is not sending: its network fee is said once read.
  const thenSettle = () => `, then the settle<span class="mute self-cost-fee">${S.cost ? ` · network fee about ${esc(fmtUnits(S.cost, 18, 5))} ETH` : ''}</span>`;
  if (q.own) {
    box.innerHTML = `<div class="kv"><span>Relay tip</span><b>none: you prove it yourself</b></div>
    <div class="kv"><span>Your wallet sends</span><b>${esc(fmtUnits(q.wei, 18, 6))} ETH${thenSettle()}</b></div>
    <div class="kv"><span>Private to</span><b>${esc(ownerText())}</b></div>`;
    $('#tk-note').innerHTML = noteHtml();
    return;
  }
  const total = q.wei + q.tip, share = q.wei > 0n ? Number(q.tip) / Number(q.wei) : 0;
  box.innerHTML = `<div class="kv"><span title="Paid to Tacit's relay, ${esc(short(q.to, 4))}, in the same transaction">Relay tip</span><b>${esc(fmtUnits(q.tip, 18, 6))} ETH${ethUsd() ? ` <span class="mute">· ${usd(toEth(q.tip) * ethUsd())}${share >= 0.0005 ? `, ${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%` : ''}</span>` : ''}</b></div>
    <div class="kv"><span>Your wallet sends</span><b>${esc(fmtUnits(total, 18, 6))} ETH${q.held ? thenSettle() : ''}</b></div>
    <div class="kv"><span>Private to</span><b>${esc(ownerText())}</b></div>
    ${q.held ? '<p class="note">The relay can\'t send this one right now, so your wallet sends the settle and pays its network fee.</p>' : ''}
    ${q.floor && q.wei < 3n * q.floor ? `<p class="note">Sending or taking out an amount this small later costs about ${esc(fmtUnits(q.floor, 18, 6))} ETH in relay fees.</p>` : ''}`;
  $('#tk-note').innerHTML = noteHtml();
}
// Whose key the note will be made for, said before the wallet is asked: the wallet that pays need not be the one that opened the key.
const ownerText = () => (key.unlocked ? (key.key.address ? `the key of ${short(key.key.address, 4)}` : key.key.label ? `your passkey “${key.key.label}”` : `the key ${short(key.key.pubHex, 4)}`) : 'the Tacit key you open next');
const noteHtml = () => (S.quote?.own
  ? 'Your wallet sends the deposit, your Tacit account\'s PROVE credit pays Succinct\'s prover for the proof, and your wallet sends the settle. Deposits count toward <a href="/#points">TAC points</a>.'
  : 'One transaction pays the deposit and a small tip to Tacit\'s relay. Deposits count toward <a href="/#points">TAC points</a>.');
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
  if (q.own && creditShort()) { go.textContent = 'Add PROVE to prove it yourself'; return; }
  go.textContent = key.unlocked ? 'Make ETH private' : 'Sign in to make ETH private';
}
// The steps of a deposit, as they happen. `now` names the one running; those before it are done.
const STEPS = [['key', 'Open your Tacit wallet'], ['prepare', 'Prepare the deposit, about half a minute'], ['confirm', 'Confirm the deposit in your wallet'], ['landing', 'The deposit lands on Ethereum'], ['proving', 'The relay finishes it, about a minute']];
// Proved with the holder's own credit: the deposit, then the private input, Succinct's prover, and the settle from the wallet.
const OWN_STEPS = [...STEPS.slice(0, 4), ['input', 'Prepare the input for Succinct\'s prover'], ['asked', 'Succinct\'s prover proves it, about half a minute'], ['settle', 'Confirm the settle in your wallet'], ['settling', 'The settle lands on Ethereum']];
const OWN_FINISH = OWN_STEPS.slice(4);
// The relay proves it and the wallet sends the settle, for a relay that is not sending settles just now.
const HELD_STEPS = [...STEPS.slice(0, 4), ['proving', 'The relay proves your note'], ['check', 'The settle is checked before it is sent'], ['settle', 'Confirm the settle in your wallet'], ['settling', 'The settle lands on Ethereum']];
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
  key.lock(); forgetUx(); D.held = null; heldP = null; S.stuck = null; S.left = null; S.askedPending = null; S.ownOnce = null;   // what a retry holds (the note's secrets) goes with the key
  forgetProver();
  paintSteps(null); say(''); renderTicketAll(); renderFarm();
}
key.onChange(() => {
  renderGo(); renderUse(); renderFarm(); renderQuote(); renderWaiting(); if (key.unlocked && D.held?.pub !== key.key.pubHex) loadHeld();
  if (!key.unlocked || O.pub !== key.key.pubHex) forgetProver();
  if (ownOn()) refreshCredit();
  if (!S.busy && S.quote && !!S.quote.own !== ownOn()) requote();                                   // a key that proves with its own credit quotes no tip
  renderOwn();
});   // a key just opened is read at once: what it already holds, and any deposit waiting
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

// The whole of it, from the press: the key if it is not open, then the note, the deposit and the relay's proof. `anyway`: the deposit goes to a
// relay that is not proving, to wait for it.
async function press({ anyway = false } = {}) {
  if (!W.account) { await connect.connect(); return; }
  const q = S.quote;
  if (S.busy || S.stuck) return;
  if (!q || q.wei !== getWei() || q.tip == null) { clearTimeout(amtTimer); requote(); return; }   // pressed while the amount was still being typed: quote it first
  if (q.own && creditShort()) { openProverSheet(); return; }
  const from = W.account, hadKey = key.unlocked;
  S.busy = true; S.steps = (q.own ? OWN_STEPS : STEPS).slice(hadKey ? 1 : 0);
  lockTicket(); renderGo(); renderChips(); renderWaiting(); say('');
  let at = null, settled = null, held = false;
  const relayStep = (k, hash) => { at = k === 'sent' ? 'landing' : k; paintSteps(at); if (hash && k === 'sent') say(`Deposit sent ${txLink(hash)}. Waiting for it to land…`); else if (k === 'proving') say(`${hash ? `Deposited ${txLink(hash)}. ` : ''}The relay is finishing it, about a minute…`); else if (k === 'confirm') say('Confirm the deposit in your wallet.'); else if (k === 'prepare') say('Preparing the deposit, about half a minute…'); };
  // A relay that proves but is not sending (HELD_STEPS): the deposit as above, then the relay's proof, sent from the wallet.
  const heldStep = (k, d) => {
    const s = { proving: 'proving', 'settle-check': 'check', 'settle-confirm': 'settle', 'settle-sent': 'settling' }[k];
    if (!s) { relayStep(k, d); return; }
    at = s; paintSteps(at);
    if (k === 'proving') say(`${d ? `Deposited ${txLink(d)}. ` : ''}The relay is proving it, then your wallet sends the settle…`);
    else if (k === 'settle-check') say('Proved. Checking the settle before it is sent…');
    else if (k === 'settle-confirm') say(`Proved. Confirm the settle in your wallet. ${esc(walletName())} pays the network fee${esc(costTxt())}.`);
    else { settled = d; say(`Settle sent ${txLink(d)}. Waiting for it to land…`); }
  };
  const step = q.own ? ownSteps((k) => { at = k; }, (h) => { settled = h; }) : (k, d) => (held ? heldStep : relayStep)(k, d);
  try {
    if (!hadKey) {
      paintSteps('key'); at = 'key'; await signIn();
      // A key just opened is read before it is given a second note: a deposit of its that never finished is the first thing to see.
      const h = await loadHeld();
      if (h?.pending?.length && S.askedPending !== h.pub) { S.askedPending = h.pub; paintSteps(null); say('A deposit of yours is waiting to become private. Press Finish above to complete it, or press the button again to make a new one.'); return; }
      // The key just opened proves its own notes, or no longer does: what was shown (a relay tip, or none) is not what would be sent.
      if (!!q.own !== ownOn()) { paintSteps(null); requote(); say(ownOn() ? 'This Tacit wallet proves with its own PROVE credit, so the deposit carries no relay tip. Check the amounts and press again.' : 'This Tacit wallet is set to let the relay prove. Check the amounts and press again.'); return; }
    }
    if (W.account !== from) throw new Error('The wallet\'s account changed. Nothing was sent; try again.');
    // What the relay can do, read before the deposit. One that is not proving is said first, with the holder's own credit or the deposit anyway; one
    // that proves but is not sending has the wallet send the settle, as the quote said (a quote that did not say so is read again first).
    if (!q.own) {
      const rs = await relayState();
      if (relayStopped(rs) && !anyway) { paintSteps(null); say(PAUSED_CHOICE); return; }
      held = rs?.state === 'held';
      if (held && !q.held) { paintSteps(null); requote(); say('The relay can\'t send this one right now, so your wallet sends the settle and pays its network fee. Check the amounts and press again.'); return; }
      if (held) S.steps = HELD_STEPS.slice(hadKey ? 1 : 0);
    }
    // Its own credit is read before the deposit: one it cannot prove is not made.
    let prover = null;
    if (q.own) {
      prover = await ensureProver();
      const c = await readCredit(prover);
      setCredit(c);
      if (c.credit == null || c.need == null) { paintSteps(null); say('Your prover credit could not be read just now, so nothing was sent. Try again in a moment.', true); return; }
      if (c.credit < c.need) { paintSteps(null); say(`${esc(ownWords({ code: 'prover_credit', have: c.credit, need: c.need }))} Nothing was sent. <button class="linkbtn" type="button" id="ps-open">Add PROVE</button>`, true); return; }
    }
    await wrapEth({ priv: () => key.priv(), wei: q.wei, tip: q.tip, to: q.to, from, wallet, say: step, own: prover, self: held });
    S.ownOnce = null;
    paintSteps(null, { all: true });
    say(`<span class="ok">Done.</span> ${esc(fmtUnits(q.wei, 18, 8))} tETH is private now, in your balance and ready to send, swap, farm or bridge.${q.own && settled ? ` Proved with your own credit${S.pubInput ? ' (its input went public: Succinct\'s network was not taking private inputs)' : ''} and settled from your wallet ${txLink(settled)}.` : held && settled ? ` Settled from your wallet ${txLink(settled)}.` : ''} <a href="#" data-mode-go="use">What next →</a>`);
    S.amt = ''; $('#amt').value = ''; S.quote = null; S.seq++; renderQuote(); keepInHash();
    const before = D.held?.pub === key.key.pubHex ? D.held.value ?? null : null;
    loadHeldUntil((h) => (before != null ? (h.value ?? 0n) >= before + q.wei / E10 : !(h.pending || []).length));
  } catch (e) { if (e?.deposit) S.ownOnce = null; fail(e, at, q); }
  finally { S.busy = false; lockTicket(); renderGo(); renderChips(); renderWaiting(); renderOwn(); readBalances().then(() => { renderBalance(); renderGo(); }).catch(() => {}); if (q.own) refreshCredit(); }
}
// A relay that is not proving, said before the deposit: this wrap is proved with the holder's own credit, or the deposit goes anyway and waits for it.
const PAUSED_CHOICE = 'The relay isn\'t proving right now. <button class="linkbtn" type="button" id="own-now">Prove it with your own credit</button>, or <button class="linkbtn" type="button" id="anyway">wrap anyway</button>: it goes through once the relay is back, or you finish it from your wallet.';
// "Prove it with your own credit": this wrap only goes the holder's own way (no relay tip, and the wallet sends the settle), after the fund sheet when
// the credit is short. The switch in the sheet keeps the choice for later wraps.
async function ownNow() {
  if (S.busy || !key.unlocked) return;
  S.ownOnce = key.key.pubHex; say(''); renderOwn(); requote();
  await refreshCredit();
  if (!ownOn() || S.busy) return;
  if (O.credit == null || creditShort()) openProverSheet(); else press();
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
  // A settle stopped in the wallet after the deposit landed leaves the deposit waiting, as any other failure of its settle does.
  const dep = e?.deposit, stopped = e instanceof UserStopped || !!e?.userStopped;
  if (stopped && !dep?.landed) { paintSteps(null); say(esc(e.message), false); return; }
  paintSteps(at, { failed: true });
  if (dep) {
    // A deposit made to be proved with the holder's own credit stays so before it has landed too: it carries no relay tip.
    const own = !!dep.own || !!q?.own;
    S.stuck = { ...dep, wei: q.wei, open: e.open || null, self: !own && !!dep.landed && (stopped || selfable(e)), own };
    S.amt = ''; $('#amt').value = ''; S.quote = null; S.seq++; renderQuote(); renderChips(); keepInHash();
    say(stuckText(e, S.stuck));
    if (S.stuck.self) fillCost();
    if (key.unlocked) setTimeout(() => { if (key.unlocked) loadHeld(true); }, dep.landed ? 0 : 20000);
    return;
  }
  say(q?.own ? `${esc(ownWords(e))}${e?.code === 'prover_credit' ? ' <button class="linkbtn" type="button" id="ps-open">Add PROVE</button>' : ''}` : esc(relayWords(e)), true);
}
// What a deposit that is in, but not yet a note, can do next. A proof of the holder's own that failed offers another (and Add PROVE when the credit
// was short) or the relay; a relay that could not prove offers the holder's own credit; a relay that would not send offers the wallet. A relay that
// is not proving offers the holder's own credit first, and the wallet only where it still proves.
const OWN_OFFER = ' Or <button class="linkbtn" type="button" id="own">prove it with your own PROVE credit</button>.';
function stuckText(e, st) {
  const amt = esc(fmtUnits(st.wei, 18, 6));
  if (!st.landed) return `<span class="err">${esc(relayWords(e))}</span><br>Your ${amt} ETH deposit was sent ${txLink(st.hash)} but is not confirmed yet. There is no need to send it again: <button class="linkbtn" type="button" id="retry">Check again</button>, or once it lands, finish it on tacit.finance's Private ETH tab with the same key.`;
  const where = `Your ${amt} ETH is in the Tacit pool, but it is not private yet.`;
  if (st.own) {
    const again = e?.code === 'prover_credit' ? '<button class="linkbtn" type="button" id="ps-open">Add PROVE</button>, then <button class="linkbtn" type="button" id="own">try again with your credit</button>' : '<button class="linkbtn" type="button" id="own">Try again with your credit</button>';
    return `<span class="err">${esc(ownWords(e))}</span><br>${where} There is no need to send it again. ${again}, or <button class="linkbtn" type="button" id="retry" data-relay="1">let the relay prove this one</button>.`;
  }
  if (e?.code === 'relay_paused') return `<span class="err">${esc(relayWords(e))}</span><br>${where} There is no need to send it again. <button class="linkbtn" type="button" id="own">Try again with your credit</button>${st.self ? `, or ${selfOffer('finish it from your wallet', 'self')}` : '.'} Or finish it later on tacit.finance's Private ETH tab with the same key.`;
  const own = ownable(e) ? OWN_OFFER : '';
  if (st.self) return `<span class="err">${esc(relayWords(e))}</span><br>${where} There is no need to send it again. ${selfOffer('Finish it from your wallet', 'self')} Or <button class="linkbtn" type="button" id="retry" data-relay="1">ask the relay again</button>, or finish it later on tacit.finance's Private ETH tab with the same key.${own}`;
  return `<span class="err">${esc(relayWords(e))}</span><br>${where} There is no need to send it again: <button class="linkbtn" type="button" id="retry">Finish it now</button>, or finish it on tacit.finance's Private ETH tab with the same key.${own}`;
}
// Finishing from the wallet: settle() is open to any account, so the connected wallet can send the relay's proof itself and pay the network fee.
// The fee is said before it is asked for: a wrap's settle gas at the price now, filled in once read.
const walletName = () => (W.account && W.name ? W.name : 'Your wallet');
const costTxt = () => (S.cost ? ` (about ${fmtUnits(S.cost, 18, 5)} ETH)` : '');
const selfOffer = (label, id) => `<button class="linkbtn" type="button" id="${id}">${esc(label)}</button>: ${esc(walletName())} pays the network fee<span class="self-cost">${esc(costTxt())}</span>.`;
function fillCost() { settleCost().then((c) => { if (c) S.cost = c; for (const el of document.querySelectorAll('.self-cost')) el.textContent = costTxt(); if (S.quote?.own || S.quote?.held) renderQuote(); }); }
const SELF_STEPS = [['proving', 'The relay proves your note'], ['check', 'The settle is checked before it is sent'], ['confirm', 'Confirm the settle in your wallet'], ['landing', 'It lands on Ethereum']];
function selfSteps(set) {
  return (k, hash) => {
    const at = k === 'sent' ? 'landing' : k;
    set(at); paintSteps(at);
    if (k === 'proving') say('Waiting for the relay\'s proof of your note…');
    else if (k === 'check') say('Checking the settle before it is sent…');
    else if (k === 'confirm') say(`Confirm the settle in your wallet. ${esc(walletName())} pays the network fee${esc(costTxt())}.`);
    else if (k === 'sent') say(`Settle sent ${txLink(hash)}. Waiting for it to land…`);
  };
}
// A deposit sent but not yet confirmed is waited on again before anything else. → true once it has landed.
async function landing(st) {
  if (st.landed) return true;
  S.busy = true; S.steps = STEPS.slice(3); lockTicket(); renderGo();
  try {
    say('Waiting for the deposit to land…'); paintSteps('landing');
    const rc = await wallet.receipt(st.hash);
    if (rc.status !== '0x1') { S.stuck = null; paintSteps('landing', { failed: true }); say('<span class="err">The deposit failed on chain. Nothing was lost but its network fee.</span>'); return false; }
    return (st.landed = true);
  } catch (e) { paintSteps('landing', { failed: true }); say(stuckText(e, st)); return false; }
  finally { S.busy = false; lockTicket(); renderGo(); }
}
// Check again, or Finish it now: the deposit settled the way it was made. One made to be proved with the holder's own credit (it carries no relay
// tip), or any while the switch is on, is proved that way (runOwn); the relay is asked only when it was named (`relay`) or proves the rest.
async function retry({ relay = false } = {}) {
  const st = S.stuck;
  if (!st || S.busy || !(await landing(st))) return;
  if (!relay && (st.own || ownOn())) { runOwn(); return; }
  S.busy = true; S.steps = STEPS.slice(3); lockTicket(); renderGo();
  try {
    say('The relay is finishing it, about a minute…'); paintSteps('proving');
    await settle({ built: st.built, hash: st.hash });
    S.stuck = null; paintSteps(null, { all: true });
    say(`<span class="ok">Done.</span> ${esc(fmtUnits(st.wei, 18, 8))} tETH is private now.`);
    loadHeldUntil((h) => !(h.pending || []).length);
  } catch (e) {
    st.open = e.open || null; st.jobId = e.deposit?.jobId || st.jobId || null; st.self = selfable(e); st.own = false;
    paintSteps('proving', { failed: true }); say(stuckText(e, st));
    if (st.self) fillCost();
  }
  finally { S.busy = false; lockTicket(); renderGo(); }
}
// The relay's proof, sent from the connected wallet: the job it holds if it has proved it, or a proof asked for now.
async function runSelf() {
  const st = S.stuck;
  if (!st?.landed || S.busy) return;
  if (!W.account && !(await connect.connect())) return;
  S.busy = true; S.steps = SELF_STEPS; lockTicket(); renderGo();
  let at = 'proving';
  try {
    const r = await selfFinish({ built: st.built, hash: st.hash, jobId: st.jobId || null, open: st.open, wallet, from: W.account, say: selfSteps((k) => { at = k; }) });
    S.stuck = null; paintSteps(null, { all: true });
    say(`<span class="ok">Done.</span> ${esc(fmtUnits(st.wei, 18, 8))} tETH is private now.${r.txHash && !r.already ? ` Settled from your wallet ${txLink(r.txHash)}.` : ''}`);
    loadHeldUntil((h) => !(h.pending || []).length);
  } catch (e) {
    if (e?.open) st.open = e.open;
    if (e?.code === 'prove_budget' || (e?.code === 'relay_paused' && !e.proving)) st.self = false;
    if (e instanceof UserStopped || e?.userStopped) paintSteps(null); else paintSteps(at, { failed: true });
    say(stuckText(e, st));
  }
  finally { S.busy = false; lockTicket(); renderGo(); }
}
// The deposit proved on the holder's own credit and its settle sent from the wallet: offered where a proof of its own failed, and where the relay
// could not prove it.
async function runOwn() {
  const st = S.stuck;
  if (!st?.landed || S.busy || !key.unlocked) return;
  if (!W.account && !(await connect.connect())) return;
  S.busy = true; S.steps = OWN_FINISH; lockTicket(); renderGo();
  let at = 'input', settled = null;
  try {
    const prover = await ensureProver();
    await proveOwn({ built: st.built, hash: st.hash, wallet, from: W.account, prover, say: ownSteps((k) => { at = k; }, (h) => { settled = h; }) });
    S.stuck = null; paintSteps(null, { all: true });
    say(`<span class="ok">Done.</span> ${esc(fmtUnits(st.wei, 18, 8))} tETH is private now.${settled ? ` Proved with your own credit${S.pubInput ? ' (its input went public: Succinct\'s network was not taking private inputs)' : ''} and settled from your wallet ${txLink(settled)}.` : ''}`);
    loadHeldUntil((h) => !(h.pending || []).length);
  } catch (e) {
    st.own = true; st.self = false;
    if (e instanceof UserStopped || e?.userStopped) paintSteps(null); else paintSteps(at, { failed: true });
    say(stuckText(e, st));
  }
  finally { S.busy = false; lockTicket(); renderGo(); refreshCredit(); }
}
// Finish: each waiting deposit settled again, by the relay, or proved with the holder's own credit and sent from the wallet when that is on.
async function runFinish({ relay = false } = {}) {
  if (S.busy || !key.unlocked) return;
  const p = S.left && relay ? S.left : D.held?.pending || [];
  if (!p.length) return;
  const own = !relay && ownOn();
  if (own && !W.account && !(await connect.connect())) return;
  if (!own && await relayAside(p)) return;
  S.busy = true; S.steps = own ? OWN_FINISH : [['proving', 'The relay finishes it, about a minute']]; lockTicket(); renderGo(); renderWaiting(); say(''); paintSteps(own ? 'input' : 'proving');
  let at = own ? 'input' : 'proving';
  try {
    const prover = own ? await ensureProver() : null;
    const { done, err, left } = await finish({ priv: () => key.priv(), pending: p, ...(own ? { own: { prover, wallet, from: W.account }, say: ownSteps((k) => { at = k; }) } : {}) });
    S.left = left.length ? left : null;
    if (err) { if (own && !(err instanceof UserStopped || err?.userStopped)) paintSteps(at, { failed: true }); else paintSteps(null); finishFailed(done, err, own ? 'own' : 'relay'); }
    else { paintSteps(null, { all: own }); say('<span class="ok">Done.</span> They are private now.'); }
  } catch (e) { paintSteps(null); say(`${esc(own ? ownWords(e) : relayWords(e))} ${KEPT}`, true); }
  finally { S.busy = false; lockTicket(); renderGo(); if (own) refreshCredit(); await loadHeldUntil((h) => !(h.pending || []).length); }
}
// A relay that is not proving, read before Finish would wait on it: the holder's own credit is offered instead, and the wallet where the relay still
// proves. True when it was said.
async function relayAside(p) {
  S.busy = true; lockTicket(); renderGo(); renderWaiting();
  const rs = await relayState();
  S.busy = false; lockTicket(); renderGo(); renderWaiting();
  if (!relayStopped(rs)) return false;
  S.left = p; paintSteps(null);
  say(`${rs.proving ? 'The relay can\'t send this one right now.' : 'The relay isn\'t proving right now.'} <button class="linkbtn" type="button" id="own-pending">Prove it with your own credit</button>${rs.proving ? `, or ${selfOffer('finish it from your wallet', 'self-pending')}` : ', or press Finish again once the relay is back.'}`);
  if (rs.proving) fillCost();
  return true;
}
const KEPT = 'It is still in the Tacit pool: press Finish again, or finish it on tacit.finance\'s Private ETH tab with the same key. There is no need to send it again.';
// What Finish could not do, and what is offered for the rest. `via` is how it was tried: 'relay', 'wallet' (the relay's proof, sent from the
// wallet) or 'own' (proved on the holder's own credit). A refusal the wallet can end offers the wallet; after a try from the wallet that stays unless
// the relay has no proofs left today; where the relay could not prove, the holder's own credit is offered; after a proof of its own failed, another
// (Add PROVE first when the credit was short) or the relay.
function finishFailed(done, err, via = 'relay') {
  const lead = `${done ? `${done} settled; another did not: ` : ''}`;
  if (via === 'own') {
    const again = err?.code === 'prover_credit' ? '<button class="linkbtn" type="button" id="ps-open">Add PROVE</button>, then <button class="linkbtn" type="button" id="own-pending">try again with your credit</button>' : '<button class="linkbtn" type="button" id="own-pending">Try again with your credit</button>';
    say(`<span class="err">${lead}${esc(ownWords(err))} ${KEPT}</span> ${S.left ? `${again}, or <button class="linkbtn" type="button" id="finish-relay">let the relay prove it</button>.` : ''}`);
    return;
  }
  const own = S.left && ownable(err) ? ' Or <button class="linkbtn" type="button" id="own-pending">prove it with your own PROVE credit</button>.' : '';
  const wallet = S.left && (via === 'wallet' ? err?.code !== 'prove_budget' : selfable(err));
  say(`<span class="err">${lead}${esc(relayWords(err))} ${KEPT}</span>${wallet ? ` ${selfOffer('Finish from your wallet', 'self-pending')}` : ''}${own}`);
  if (!wallet && !own) S.left = null;
  if (wallet) fillCost();
}
// What Finish left, proved on the holder's own credit and sent from the wallet.
async function runOwnPending() {
  const left = S.left;
  if (!left?.length || S.busy || !key.unlocked) return;
  if (!W.account && !(await connect.connect())) return;
  S.busy = true; S.steps = OWN_FINISH; lockTicket(); renderGo(); renderWaiting(); say(''); paintSteps('input');
  let at = 'input';
  try {
    const prover = await ensureProver();
    const { done, err, left: still } = await finish({ priv: () => key.priv(), pending: left, own: { prover, wallet, from: W.account }, say: ownSteps((k) => { at = k; }) });
    S.left = still.length ? still : null;
    if (err) { if (err instanceof UserStopped || err?.userStopped) paintSteps(null); else paintSteps(at, { failed: true }); finishFailed(done, err, 'own'); }
    else { paintSteps(null, { all: true }); say('<span class="ok">Done.</span> They are private now.'); }
  } catch (e) { paintSteps(null); say(`${esc(ownWords(e))} ${KEPT}`, true); }
  finally { S.busy = false; lockTicket(); renderGo(); renderWaiting(); refreshCredit(); await loadHeldUntil((h) => !(h.pending || []).length); }
}
// What Finish left, settled from the connected wallet: each deposit rebuilt from the key, with the relay's proof of it sent by the wallet.
async function runSelfPending() {
  const left = S.left;
  if (!left?.length || S.busy || !key.unlocked) return;
  if (!W.account && !(await connect.connect())) return;
  S.busy = true; S.steps = SELF_STEPS; lockTicket(); renderGo(); renderWaiting();
  let at = 'proving';
  try {
    const { done, err, left: still } = await finish({ priv: () => key.priv(), pending: left, self: { wallet, from: W.account }, say: selfSteps((k) => { at = k; }) });
    S.left = still.length ? still : null;
    if (err) { if (err instanceof UserStopped || err?.userStopped) paintSteps(null); else paintSteps(at, { failed: true }); finishFailed(done, err, 'wallet'); }
    else { paintSteps(null, { all: true }); say('<span class="ok">Done.</span> They are private now.'); }
  } catch (e) { paintSteps(null); say(`${esc(relayWords(e))} ${KEPT}`, true); }
  finally { S.busy = false; lockTicket(); renderGo(); renderWaiting(); await loadHeldUntil((h) => !(h.pending || []).length); }
}

// ── proving it yourself ──
// The holder's Tacit account can pay for its own proofs with PROVE credit on Succinct's prover network (prover.js): the deposit's note then goes as a
// private input to Succinct's own prover only, and the wallet sends the settle. A switch per key turns it on; a sheet shows the prover account, its
// credit, and adds PROVE from the connected wallet.
const NO_TIP = '0x0000000000000000000000000000000000000000';                                         // a deposit with no tip names no recipient
const O = { pub: null, prover: null, unavailable: null, loading: false, err: null, credit: null, need: null, held: null, waiting: 0, sheet: null,
  f: { mode: 'prove', amt: '2', quote: null, seq: 0, timer: 0, wprove: null, msg: '' } };
const ownOn = () => key.unlocked && (ownPref(key.key.pubHex) || S.ownOnce === key.key.pubHex);   // the switch, or this wrap only (ownNow)
const fmtP = (wei, d = 2) => fmtUnits(wei, 18, d);
const creditShort = () => O.pub === key.key?.pubHex && O.credit != null && O.need != null && O.credit < O.need;
function forgetProver() { O.pub = null; O.prover = null; O.credit = O.need = O.held = null; O.err = null; O.waiting = 0; O.f.quote = null; O.sheet?.close(); }
async function ensureProver() {
  if (!key.unlocked) throw new Error('Open your Tacit wallet first.');
  const pub = key.key.pubHex;
  if (O.prover && O.pub === pub) return O.prover;
  try {
    const p = await proverFor({ ux: await getUx(), keyPriv: () => key.priv() });
    if (key.key?.pubHex !== pub) throw new Error('Your Tacit wallet changed. Nothing was sent; try again.');
    O.unavailable = null; O.pub = pub; O.prover = p;
    return p;
  } catch (e) { if (e?.code === 'unavailable') O.unavailable = e.message; throw e; }
}
function setCredit(c) { if (O.pub === key.key?.pubHex) { O.credit = c.credit; O.need = c.need; O.held = c.held; } }
let creditP = null;
function refreshCredit() {
  if (!key.unlocked) return Promise.resolve();
  return (creditP ||= (async () => {
    O.loading = true; renderOwn();
    try {
      const c = await readCredit(await ensureProver()); setCredit(c); O.err = c.credit == null ? 'Your credit could not be read just now.' : null;
      if (O.waiting && O.credit != null && O.credit > (O.waitFrom ?? 0n)) O.waiting = 0;                   // the new credit has shown
    }
    catch (e) { O.err = e.message || 'Your prover account could not be read just now.'; }
    finally { O.loading = false; creditP = null; renderOwn(); renderGo(); }
  })());
}
// New credit shows on the network a few minutes after its deposit: read it again every 20 seconds, for up to six minutes or until it has grown.
function pollCredit(before) {
  const until = Date.now() + 6 * 60e3, pub = O.pub;
  O.waiting = until; O.waitFrom = before; renderOwn();
  const tick = async () => {
    if (O.pub !== pub || !key.unlocked) return;
    await refreshCredit();
    if (!O.waiting) return;
    if (Date.now() < until) setTimeout(tick, 20e3); else { O.waiting = 0; renderOwn(); }
  };
  setTimeout(tick, 20e3);
}
// The progress of a proof of the holder's own, in the steps of OWN_STEPS. `set(at)` follows the step; `onSettle(hash)` gets the settle's hash.
function ownSteps(set, onSettle = () => {}) {
  S.pubInput = false;                                                         // this run's proof went with a public input
  return (k, d) => {
    const at = { prepare: 'prepare', confirm: 'confirm', sent: 'landing', proving: 'input', input: 'input', stage: String(d || '').split(':')[0] === 'proved' ? 'settle' : 'asked', 'settle-check': 'settle', 'settle-confirm': 'settle', 'settle-sent': 'settling' }[k];
    if (at) { set(at); paintSteps(at); }
    if (k === 'prepare') say('Preparing the deposit, about half a minute…');
    else if (k === 'confirm') say('Confirm the deposit in your wallet.');
    else if (k === 'sent') say(`Deposit sent ${txLink(d)}. Waiting for it to land…`);
    else if (k === 'proving' || k === 'input') say('Preparing the private input…');
    else if (k === 'stage') {
      // 'stage:public': Succinct's network was refusing private inputs, so the input went as a public one (self-prover.js).
      const [s, pub] = String(d || '').split(':');
      if (pub) S.pubInput = true;
      if (pub && s === 'uploading') say('Succinct\'s network isn\'t taking private inputs right now, so this one goes with a public input, which anyone can read…');
      else say(`${s === 'requested' ? 'Asked Succinct\'s prover. It proves it in about half a minute…' : s === 'assigned' ? 'Succinct\'s prover is proving it…' : s === 'proved' ? 'Proved.' : 'Preparing the private input…'}${pub ? ' (public input)' : ''}`);
    }
    else if (k === 'settle-check') say('Proved. Checking the settle before it is sent…');
    else if (k === 'settle-confirm') say(`Proved. Confirm the settle in your wallet. ${esc(walletName())} pays the network fee${esc(costTxt())}.`);
    else if (k === 'settle-sent') { onSettle(d); say(`Settle sent ${txLink(d)}. Waiting for it to land…`); }
  };
}
// The line in the ticket that says who proves the deposit, and opens the sheet.
function renderOwn() {
  const on = ownOn(), n = on && O.pub === key.key?.pubHex ? proofsFor(O.prover?.sp, O.credit, O.need) : null;
  $('#prover-line').innerHTML = `<div class="kv"><span>Proved by</span><b>${on ? `your own PROVE credit${creditShort() ? ' <span class="warn">(not enough for a proof)</span>' : n != null ? `, enough for about ${grp(n, 0)} proof${n === 1 ? '' : 's'}` : ''}` : 'Tacit\'s relay'} · <button class="linkbtn" type="button" id="ps-open">${on ? 'Change' : 'Prove it yourself'}</button></b></div>`;
  if (O.sheet && !O.sheet.closed) renderSheet();
}
function openProverSheet() {
  if (O.sheet && !O.sheet.closed) return;
  const o = overlay({ title: 'Prove it yourself', top: true, onClose: () => { O.sheet = null; } });
  O.sheet = o; O.f.msg = '';
  o.body.innerHTML = `<p class="note" style="margin-top:0">Your Tacit account can pay for its own proofs with PROVE credit on Succinct's prover network. The deposit's private details go to Succinct's own prover as a private input, passing through Tacit's API without being kept. While Succinct's network isn't taking private inputs, they go as a public input instead, which anyone can read, and the steps say so. Your wallet sends the settle and pays its network fee, and the deposit carries no relay tip.</p>
    <div id="ps-acct"></div>
    <label class="ps-switch"><input type="checkbox" id="ps-on"><span>Prove with my own credit</span></label>
    <h3 class="ps-h">Add PROVE</h3>
    <div class="seg" id="ps-mode" role="group" aria-label="Add from"><button type="button" data-ps-mode="prove" aria-pressed="true">PROVE in your wallet</button><button type="button" data-ps-mode="eth" aria-pressed="false">Pay with ETH</button></div>
    <div class="lbl"><span id="ps-lbl">PROVE to add</span><button class="linkbtn" type="button" id="ps-bal" hidden></button></div>
    <div class="amt"><input id="ps-amt" inputmode="decimal" autocomplete="off" aria-label="Amount to add" value="${esc(O.f.amt)}"><span class="u" id="ps-unit">PROVE</span></div>
    <p class="ps-size" id="ps-size" hidden></p>
    <div id="ps-quote"></div>
    <button class="btn" type="button" id="ps-go">Add PROVE</button>
    <div class="status" id="ps-status" role="status"></div>
    <p class="note">A proof spends about 0.4 PROVE of credit. New credit shows on the network within about 5 minutes of a deposit. If Succinct's prover does not take a request in time, nothing is sent and the network keeps its base fee, about 0.39 PROVE.</p>`;
  o.body.addEventListener('click', (e) => {
    const m = e.target.closest('[data-ps-mode]');
    if (m && !S.busy && m.dataset.psMode !== O.f.mode) { O.f.mode = m.dataset.psMode; O.f.amt = m.dataset.psMode === 'eth' ? '' : '2'; o.body.querySelector('#ps-amt').value = O.f.amt; O.f.quote = null; O.f.msg = ''; renderSheet(); return; }
    const z = e.target.closest('[data-ps-size]');
    if (z) { if (!S.busy && O.f.mode === 'eth') sizeFill(Number(z.dataset.psSize)); return; }
    if (e.target.id === 'ps-signin') signIn().then(() => { refreshCredit(); readWalletProve(); }).catch(() => {});
    else if (e.target.id === 'ps-bal' && O.f.mode === 'prove' && O.f.wprove) { O.f.amt = plain(O.f.wprove); o.body.querySelector('#ps-amt').value = O.f.amt; renderSheet(); }
    else if (e.target.id === 'ps-go') runFund();
  });
  o.body.addEventListener('change', (e) => {
    if (e.target.id !== 'ps-on' || !key.unlocked || S.busy) return;
    S.ownOnce = null; setOwnPref(key.key.pubHex, e.target.checked);
    if (e.target.checked) refreshCredit();
    requote(); renderOwn();
  });
  o.body.addEventListener('input', (e) => {
    if (e.target.id !== 'ps-amt') return;
    O.f.amt = e.target.value; O.f.msg = '';
    clearTimeout(O.f.timer);
    if (O.f.mode === 'eth') { O.f.quote = null; O.f.timer = setTimeout(requoteEth, 350); }
    renderSheet();
  });
  renderSheet();
  if (key.unlocked) { refreshCredit(); readWalletProve(); }
  loadSelfProver().catch((e) => { O.unavailable = e.message; renderSheet(); });
}
const psAmt = () => parseUnits(O.f.amt, 18) || 0n;
async function readWalletProve() {
  const who = W.account;
  if (!who) { O.f.wprove = null; return; }
  try { const sp = await loadSelfProver(); const v = await tokenBalance(sp, who); if (W.account === who) { O.f.wprove = v; renderSheet(); } } catch { /* the balance line stays empty */ }
}
// Quick sizes for the ETH route: the ETH that makes the credit enough for 1, 5 or 20 proofs, worked out from zQuoter's price. Only the sizes the
// credit does not already cover are offered. A first request needs `need` on hand and each one after it spends about PROVE_PER_PROOF.
const SIZES = [1, 5, 20];
const proveFor = (sp, need, n) => { const per = BigInt(Math.round((sp?.PROVE_PER_PROOF || 0.4) * 1e18)); return (need ?? per) + BigInt(n - 1) * per; };
const proofsWord = (n) => `${grp(n, 0)} proof${n === 1 ? '' : 's'}`;
function sizeButtons(sp) {
  const have = O.credit ?? 0n, sizes = SIZES.filter((n) => proveFor(sp, O.need, n) > have);
  return sizes.length ? `Add enough for ${sizes.map((n) => `<button type="button" class="linkbtn" data-ps-size="${n}">${proofsWord(n)}</button>`).join(' · ')}` : '';
}
async function sizeFill(n) {
  const my = ++O.f.seq;
  psSay('Working out the ETH…');
  try {
    const prover = await ensureProver(), add = proveFor(prover.sp, O.need, n) - (O.credit ?? 0n);
    if (add <= 0n) { if (my === O.f.seq) psSay(''); return; }
    const q = await quoteEthFor({ prover, want: add });
    if (my !== O.f.seq) return;
    O.f.amt = plain(q.wei, 18); O.f.quote = q; O.f.msg = '';
    O.sheet.body.querySelector('#ps-amt').value = O.f.amt;
  } catch (e) { if (my === O.f.seq) O.f.msg = `<span class="err">${esc(e.message || 'Could not read a quote just now.')}</span>`; }
  renderSheet();
}
async function requoteEth() {
  const wei = psAmt(), my = ++O.f.seq;
  if (O.f.mode !== 'eth' || !wei) { O.f.quote = null; renderSheet(); return; }
  O.f.quote = { wei, loading: true }; renderSheet();
  try { const q = await quoteEth({ prover: await ensureProver(), wei }); if (my === O.f.seq) O.f.quote = q; }
  catch (e) { if (my === O.f.seq) O.f.quote = { wei, err: e.message || 'Could not read a quote just now.' }; }
  renderSheet();
}
function renderSheet() {
  const o = O.sheet;
  if (!o || o.closed) return;
  const b = o.body, $s = (sel) => b.querySelector(sel), sp = O.prover?.sp, mine = key.unlocked && O.pub === key.key.pubHex;
  const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
  if (!key.unlocked) $s('#ps-acct').innerHTML = `<p class="note">Open your Tacit wallet to see your prover account and its credit.</p><div class="bsheet-actions"><button class="btn ghost" type="button" id="ps-signin">Open your Tacit wallet</button></div>`;
  else if (O.unavailable) $s('#ps-acct').innerHTML = `<p class="note err">${esc(O.unavailable)}</p>`;
  else {
    const n = mine ? proofsFor(sp, O.credit, O.need) : null;
    const credit = !mine || (O.credit == null && O.loading) ? '<span class="mute">reading…</span>' : O.credit == null ? `<span class="err">${esc(O.err || 'could not be read just now')}</span>`
      : `${esc(fmtP(O.credit))} PROVE · enough for about ${grp(n, 0)} proof${n === 1 ? '' : 's'}`;
    $s('#ps-acct').innerHTML = (mine && O.prover ? kv('Prover account', `<a class="addr-s" href="${SCAN}address/${esc(O.prover.address)}" target="_blank" rel="noopener noreferrer">${esc(short(O.prover.address, 6))}↗</a> <span class="mute">your Tacit account</span>`) : kv('Prover account', '<span class="mute">reading…</span>'))
      + kv('Credit', credit)
      + (mine && O.held > 0n ? kv('In the account, not yet credit', `${esc(fmtP(O.held))} PROVE`) : '')
      + (O.waiting ? '<p class="note">New credit shows on the network within about 5 minutes of its deposit. This reads it again until it does.</p>' : '')
      + (creditShort() ? `<p class="note warn">A proof needs about ${esc(fmtP(O.need))} PROVE on hand. Add PROVE to prove with your own credit.</p>` : '');
  }
  const sw = $s('#ps-on');
  sw.checked = ownOn(); sw.disabled = !key.unlocked || S.busy || !!O.unavailable;
  b.querySelectorAll('[data-ps-mode]').forEach((x) => { x.setAttribute('aria-pressed', String(x.dataset.psMode === O.f.mode)); x.disabled = S.busy; });
  const eth = O.f.mode === 'eth', wei = psAmt(), lack = !eth && O.held != null ? (wei > O.held ? wei - O.held : 0n) : wei;
  $s('#ps-lbl').textContent = eth ? 'ETH to pay' : 'PROVE to add';
  $s('#ps-unit').textContent = eth ? 'ETH' : 'PROVE';
  $s('#ps-amt').disabled = S.busy;
  const bal = eth ? spendable() : O.f.wprove;
  $s('#ps-bal').hidden = bal == null;
  $s('#ps-bal').textContent = bal == null ? '' : eth ? `Wallet ${fmtUnits(bal, 18, 4)} ETH` : `Wallet ${fmtP(bal, 4)} PROVE · Max`;
  const sizes = eth && sp && key.unlocked ? sizeButtons(sp) : '';
  $s('#ps-size').hidden = !sizes; $s('#ps-size').innerHTML = sizes;
  $s('#ps-size').querySelectorAll('button').forEach((x) => { x.disabled = S.busy; });
  const q = O.f.quote, box = $s('#ps-quote');
  if (!eth) box.innerHTML = wei && O.held > 0n && lack < wei ? `<p class="note">Your Tacit account already holds ${esc(fmtP(O.held))} PROVE, so ${lack ? `your wallet sends ${esc(fmtP(lack, 4))} and then the deposit` : 'your wallet sends only the deposit'}.</p>` : '';
  else if (!wei) box.innerHTML = '';
  else if (!q || q.loading || q.wei !== wei) box.innerHTML = kv('You get', '<span class="mute">reading…</span>');
  else if (q.err) box.innerHTML = `<p class="note err">${esc(q.err)}</p>`;
  else box.innerHTML = kv('You get about', `${esc(fmtP(q.amountOut))} PROVE`) + kv('At least', `${esc(fmtP(q.amountLimit))} PROVE · 1% slippage guard`) + kv('Your credit then covers', `about ${proofsWord(proofsFor(sp, (O.credit ?? 0n) + q.amountLimit, O.need))}`);
  const go = $s('#ps-go');
  go.disabled = false;
  if (!key.unlocked) { go.textContent = 'Open your Tacit wallet first'; go.disabled = true; }
  else if (O.unavailable) { go.textContent = 'Add PROVE'; go.disabled = true; }
  else if (!W.account) go.textContent = 'Connect wallet';
  else if (S.busy) { go.textContent = 'Working…'; go.disabled = true; }
  else if (!wei) { go.textContent = 'Enter an amount'; go.disabled = true; }
  else if (!eth && sp && wei < sp.MIN_DEPOSIT_WEI) { go.textContent = `At least ${Number(sp.MIN_DEPOSIT_WEI) / 1e18} PROVE`; go.disabled = true; }
  else if (!eth && O.f.wprove != null && lack > O.f.wprove) { go.textContent = 'Not enough PROVE in your wallet'; go.disabled = true; }
  else if (eth && bal != null && wei > bal) { go.textContent = 'Not enough ETH'; go.disabled = true; }
  else if (eth && (!q || q.loading || q.wei !== wei)) { go.textContent = 'Reading the quote…'; go.disabled = true; }
  else if (eth && q.err) go.textContent = 'Try again';
  else go.textContent = eth ? 'Swap and add' : 'Add PROVE';
  $s('#ps-status').innerHTML = O.f.msg;
}
const psSay = (html, err = false) => { O.f.msg = !html ? '' : err ? `<span class="err">${html}</span>` : html; renderSheet(); };
// PROVE into the Tacit account's credit from the connected wallet (prover.js): from its PROVE, or ETH swapped to PROVE. Each transaction is tried
// first; the credit is read again until the network shows it.
async function runFund() {
  if (!W.account) { await connect.connect(); readWalletProve(); return; }
  if (!key.unlocked || S.busy) return;
  const eth = O.f.mode === 'eth', wei = psAmt(), q = O.f.quote;
  if (!wei) return;
  if (eth && (!q || q.err || q.wei !== wei || Date.now() - q.at > 60e3)) { await requoteEth(); if (q && !q.err) psSay('The quote was read again. Check it and press once more.'); return; }
  const from = W.account;
  S.busy = true; lockTicket(); renderGo(); psSay('Checking it first…');
  let phase = '', lack = 0n;
  const step = (k, d) => {
    if (k === 'transfer' || k === 'deposit' || k === 'swap') { phase = k; if (k === 'transfer') lack = d; return; }
    if (k === 'confirm') psSay(phase === 'transfer' ? `Confirm in your wallet: ${esc(fmtP(lack, 4))} PROVE to your Tacit account, then the deposit into its credit.` : phase === 'swap' ? 'Confirm the swap in your wallet: ETH to PROVE, for your Tacit account.' : 'Your Tacit account signed the deposit. Confirm it in your wallet: it moves the PROVE into your credit.');
    else if (k === 'sent') psSay(`Sent ${txLink(d)}. Waiting for it to land…`);
  };
  try {
    const prover = await ensureProver(), before = O.credit;
    const r = eth ? await fundWithEth({ prover, wallet, from, quote: q, say: step }) : await fundFromWallet({ prover, wallet, from, amountWei: wei, say: step });
    psSay(`<span class="ok">Added.</span> ${txLink(r.hashes.at(-1))} The network shows it as credit within about 5 minutes; this updates when it does.`);
    O.f.quote = null; pollCredit(before);
  } catch (e) { psSay(esc(e instanceof UserStopped || e?.userStopped ? e.message : (e?.message || 'It could not be added.')), true); }
  finally { S.busy = false; lockTicket(); renderGo(); readWalletProve(); refreshCredit(); readBalances().then(() => { renderBalance(); renderSheet(); }).catch(() => {}); }
}
document.addEventListener('click', (e) => {
  const id = e.target.id;
  if (id === 'ps-open') { e.preventDefault(); openProverSheet(); }
  else if (id === 'own') runOwn();
  else if (id === 'own-pending') runOwnPending();
  else if (id === 'finish-relay') runFinish({ relay: true });
});

// ── use tETH: where it goes next, each a link that opens it ready on tacit.finance ──
function useLinks() {
  const a = parseUnits(S.useAmt, 8), amt = a ? `&amt=${plain(a, 8)}` : '';                     // as the front page's own regex reads an amount
  const tac = D.rows.find((r) => r.other === 'TAC'), fee = D.floor ? `about ${fmtUnits(D.floor, 18, 5)} ETH` : 'small';
  return [
    ['/#private/send', 'Send it privately', 'To a Tacit address or a name. The chain shows neither the amount nor the recipient.'],
    [`/#card=swap:eth:tac${amt}`, 'Swap it for TAC', tac?.per ? `Private, inside the pool. 1 tETH = ${sig(tac.per, 4)} TAC now.` : 'Private, inside the pool.'],
    ['#farm', 'Farm TAC with it', 'The farms pair it for you, so tETH alone is enough.', 'scroll'],
    ['/#private/bitcoin', 'Bridge it to Bitcoin', 'Hold it at your own Bitcoin address, bring it back when you like. 0.01 to 0.5 tETH a bridge, a few hours.'],
    [`/#card=shield:eth:wallet${amt}`, 'Back to ETH', `One for one, to your wallet or any address. Relay fee: ${fee}.`],
    ['/#private/bitcoin', 'Bring tETH back from Bitcoin', 'Return what you bridged to Ethereum as private tETH.'],
  ];
}
function renderUse() {
  const h = D.held, mine = key.unlocked && h?.pub === key.key.pubHex;
  $('#held').innerHTML = !key.unlocked
    ? `<div class="held"><span class="mute">Sign in to see your private balance.</span><button class="linkbtn" type="button" id="signin">Sign in</button></div>`
    : mine && h.value != null ? `<div class="held"><span><b class="num">${esc(fmtUnits(h.value * E10, 18, 8))}</b> <span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-teth"/></svg>tETH, private</span></span><button class="linkbtn" type="button" id="held-re">refresh</button><button class="linkbtn" type="button" id="held-lock">Lock</button></div>${h.partial ? '<p class="note err">Part of your balance could not be read. Refresh to try again.</p>' : ''}`
    : mine && h.err ? `<div class="held"><span class="err">${esc(h.err)}</span><button class="linkbtn" type="button" id="held-re">retry</button></div>`
    : `<div class="held"><span class="mute">Reading your private balance…</span></div>`;
  const cur = $('#use-amt')?.value ?? S.useAmt;
  $('#uses').innerHTML = `<div class="lbl"><span>Amount</span><span class="mute">optional</span></div><div class="amt"><input id="use-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="tETH to use" value="${esc(cur)}"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-teth"/></svg>tETH</span></div>`
    + `<div id="use-rows">${useRowsHtml()}</div>`;
  $('#use-note').textContent = 'These open tacit.finance. Swap and Back to ETH carry your amount. Sign in there with the same wallet or passkey.';
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
  if (!e?.active || !rows.length) { $('#fm-stats').innerHTML = `<p class="note">The farms are between reward periods. They show here when the next one starts.</p>`; $('#pools').innerHTML = ''; $('#fm-note').textContent = ''; return; }
  const aprs = rows.map((r) => r.apr).filter((a) => a != null), day = Number(e.ratePerDayTac), end = programEnds(p);
  const cell = (k, v, s = '') => `<div><span class="k">${k}</span><b class="num">${v}</b>${s ? `<span class="s">${s}</span>` : ''}</div>`;
  $('#fm-stats').innerHTML = cell('Best APR now', aprs.length ? aprTxt(Math.max(...aprs)) : '—', 'paid in TAC, swap fees on top')
    + cell('Rewards', `<svg class="tk xs inl" aria-hidden="true"><use href="#tk-tac"/></svg>${Math.round(day).toLocaleString('en-US')} TAC`, `a day${tacUsd ? ` · about ${usd(day * tacUsd)}` : ''}`)
    + cell('Farms', `${rows.length}`, 'positions are private')
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
  $('#fm-note').innerHTML = `Join, harvest and exit on tacit.finance. ${!key.unlocked ? '<button class="linkbtn" type="button" id="fm-signin">Sign in to see yours</button>' : heldHere && D.held.loading ? 'Reading your positions…' : heldHere && D.held.positions == null && !D.held.err ? 'Your positions could not be read just now.' : ''}`;
}

// ── what moved: every ETH movement into and out of the pool ──
function renderMoves() {
  const H = D.hist, body = $('#moves tbody');
  if (!H) return;
  const px = ethUsd(), rows = recentMoves(H.pts, 10);
  body.innerHTML = rows.length ? rows.map((m) => { const inn = m.wei > 0n, v = inn ? m.wei : -m.wei; return `<tr><td title="${esc(new Date(m.t * 1000).toLocaleString())}">${esc(ago(m.t))}</td><td class="${inn ? 'in' : 'out'}">${inn ? 'ETH in' : 'ETH out'}</td><td class="r num" ${px ? `title="${esc(usd(toEth(v) * px))}"` : ''}>${inn ? '+' : '−'}${esc(fmtUnits(v, 18, v < 10n ** 16n ? 4 : 3))}</td></tr>`; }).join('') : '<tr><td colspan="3" class="mute">Nothing has moved yet.</td></tr>';
  const d = movedSince(H.pts, 86400), w = movedSince(H.pts, 7 * 86400);
  $('#mv-sum').textContent = `24h ${ethTxt(d.in)} in, ${ethTxt(d.out)} out · 7d ${ethTxt(w.in)} in, ${ethTxt(w.out)} out`;
  $('#moves-note').textContent = 'ETH in and out of the pool: deposits, withdrawals and public swaps. Whose it is stays private.';
}

// ── about ──
function renderAbout() {
  const P = D.pool, link = (a, t) => `<a href="${SCAN}address/${a}" target="_blank" rel="noopener noreferrer">${t || `${a.slice(0, 8)}…${a.slice(-6)}`}</a>`;
  $('#about').innerHTML = `<p><b>tETH</b> is private ETH: put ETH in the Tacit pool and hold the same amount as tETH. The chain shows neither what you hold nor who you pay. Take it out any time, less the relay's fee.</p>
    <p>Send it, swap it for TAC, farm it, or bridge it to your own Bitcoin address and back. <a href="/weld/stats/">The pool's figures →</a></p>`;
  const fee = D.floor ? fmtUnits(D.floor, 18, 5) : null;
  const main = [
    ['On Ethereum', `The pool ${link(POOL)} holds the ETH behind every tETH. Its balance, deposits and withdrawals are public; who owns what is not.`],
    ['On Bitcoin', 'The bridge burns tETH on Ethereum; the same amount, less the relay fee, arrives at your Bitcoin address in hours, sometimes a day. A burn cannot be undone. Coming back to Ethereum, it is private again once Bitcoin\'s proof is recorded. 0.01 to 0.5 tETH a bridge. <a href="/#private/bitcoin">Bridge →</a>'],
    ['What it costs', `Making ETH private costs the relay's tip (shown before you confirm) and the network fee${fee ? '. Sending, swapping and taking out cost the relay\'s fee, at least about ' + esc(fee) + ' ETH; swaps add the pool\'s fee' : ''}.`],
  ];
  const pools = D.rows.map((r) => `${esc(r.name)} (${esc(r.depthEth < 0.01 ? 'under 0.01' : grp(r.depthEth, 2))} ETH deep)`).join(' · ');
  const more = [
    ['The pool', `${link(POOL)} · holds the ETH behind every tETH`],
    ['Deposit forwarder', `${link(WRAP_TIP)} · sends the deposit to the pool and the tip to the relay in one transaction`],
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
  if (e.target.id === 'retry') retry({ relay: !!e.target.dataset.relay });
  else if (e.target.id === 'self') runSelf();
  else if (e.target.id === 'self-pending') runSelfPending();
  else if (e.target.id === 'own-now') ownNow();
  else if (e.target.id === 'anyway') { say(''); press({ anyway: true }); }
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

renderChips(); renderQuote(); renderGo(); renderAbout(); renderLanes(); renderBtc(); renderOwn();
// The pool's history is read with the page, not after the farms, the rates and the relay's quote: it is the slowest thing the page waits on and needs none of them.
const whole = loadWhole().catch(() => {});
whole.then(() => { S.histFailed = !D.hist; renderChart(); renderMoves(); renderHead(); });
Promise.allSettled([loadMarket().then(() => { renderBtc(); renderLanes(); renderChart(); }), loadFront().then(renderHead), loadRates().then(() => { renderHead(); renderLanes(); renderQuote(); return loadFarms(); }).then(paintAll), loadFloor().then(() => { renderAbout(); renderUse(); })]).then(() => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (params.get('mode') === 'use') setMode('use');
  S.ready = true;
  if (params.get('amount') && S.mode === 'get') { S.amt = params.get('amount'); $('#amt').value = S.amt; renderChips(); requote(); } else keepInHash();
  paintAll();
  whole.then(() => { S.histFailed = !D.hist; paintAll(); });
});
setInterval(() => { if (!document.hidden && !S.busy) { loadFront().then(renderHead).catch(() => {}); loadRates().then(() => loadFarms()).then(paintAll).catch(() => {}); loadMarket().then(paintAll).catch(() => {}); if (W.account) readBalances().then(() => { renderBalance(); renderGo(); }).catch(() => {}); } }, 60e3);
