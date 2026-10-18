// tacit.finance/vault: borrow TAC Dollar or TAC Ether against TAC.
//
// Every figure here is read from the vault contracts (one Multicall3 batch for both vaults and the account), and the page's arithmetic is the
// contract's own (math.js): what it shows as the room to borrow, the limit for this account, the amount to add to reach 400% and the price a vault is
// liquidated at are the numbers the contract will test, rounded the safe way. A person's vault is the chain's, not this browser's: nothing about it
// is kept here, so the same account shows the same vault anywhere. The wallet never gives up a key; each action is tested once with eth_call before it is sent.
import { DEPLOYMENTS } from '/vault/deployments.js?cb=174de1c7';
import * as M from '/vault/math.js?cb=ac1ed53e';
import {
  makeRpc, RPCS, ARCHIVE, HISTORY, makeReader, staticCalls, parseStatic, dynamicCalls, parseDynamic, timestampCall, refusal, decString, SEL, wordAt, addrWord, QUEUE_EXPIRY,
  encDeposit, encWithdraw, encBorrow, encRepay, encCancel, encApprove, encPermit, encMulticall,
} from '/vault/chain.js?cb=446cc436';
import { makeFeed, RECORD_GAS, PER_TX, encBatch, MULTICALL3 } from '/vault/feed.js?cb=03954743';
import { makeWallet, UserStopped } from '/trade/wallet.js?cb=7b4ab128';
import { overlay } from '/trade/sheet.js?cb=84cda8f2';
import { announceWalletConnect, wcSheets, WC_PROJECT_ID } from '/walletconnect.js?cb=92886522';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Math.floor(Date.now() / 1000);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const KIND = { usd: { name: 'TAC Dollar', sym: 'TACD', dp: 2, price: (t) => `$${t}` }, eth: { name: 'TAC Ether', sym: 'TACE', dp: 4, price: (t) => `${t} ETH` } };
const ACTS = [['deposit', 'Deposit'], ['borrow', 'Borrow'], ['repay', 'Repay'], ['withdraw', 'Withdraw']];

// ── which vaults ──
// The addresses are the deployments module's. A page on this computer (localhost) may be pointed at vaults of a local chain with #vusd= and #veth=
// (tests only): on the real host the address bar chooses nothing but the vault shown, the account looked at and the action.
const params = () => new URLSearchParams(location.hash.replace(/^#/, ''));
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const VS = (() => {
  let list = DEPLOYMENTS.vaults.filter((v) => KIND[v.key] && ADDR.test(v.vault)).map((v) => ({ key: v.key, addr: v.vault }));
  if (LOCAL) {
    const p = params(), over = ['usd', 'eth'].filter((k) => ADDR.test(p.get(`v${k}`) || '')).map((k) => ({ key: k, addr: p.get(`v${k}`) }));
    if (over.length) list = over;
  }
  return list.map((v) => ({ ...v, s: null, d: null }));
})();

const S = { v: VS[0]?.key, t: 'deposit', amt: '', view: null, busy: false, seq: 0, chainT: 0, chainAt: 0, loaded: false, failed: false, more: false };
const MORE_KEY = 'tacit-vault-more';                                                                // whether the board shows its further figures, kept in this browser
try { S.more = localStorage.getItem(MORE_KEY) === '1'; } catch { /* storage is a convenience */ }
// The connected wallet's own node. An injected wallet on Ethereum answers reads from the provider it already has, so it is asked first for the old headers and proofs the
// price feed needs (which the public nodes ration) and last for everything else. A WalletConnect session is left out: it would send each read on to the phone.
const WALLET_READS = new Set(['eth_call', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getProof', 'eth_getTransactionReceipt', 'eth_gasPrice']);
let walletNow = null;                                                                               // the wallet's state, once it exists
const walletNode = (order) => ({
  id: 'wallet', timeout: 8e3, ...order,
  usable: (m) => !!walletNow?.prov && !walletNow.prov.isWalletConnect && walletNow.chain === '0x1' && WALLET_READS.has(m),
  send: (m, p) => walletNow.prov.request({ method: m, params: p }),
});
const rpc = makeRpc([...RPCS, walletNode({ last: true })]);
const { ethCall, batch } = makeReader(rpc);
const cur = () => VS.find((v) => v.key === S.v) || null;
// Time on the chain's clock: a computer whose clock is off would otherwise send a permit that has already expired.
const chainNow = () => (S.chainT ? S.chainT + (now() - S.chainAt) : now());
const chainDeadline = (s) => BigInt(chainNow() + s);

// ── the wallet ──
const sheets = wcSheets((title, onClose) => overlay({ title, top: true, onClose }));
const WC = announceWalletConnect({
  projectId: WC_PROJECT_ID, chains: [1], rpcMap: { 1: 'https://ethereum-rpc.publicnode.com' },
  metadata: { name: 'tacit borrow', description: 'Borrow against TAC', url: location.origin, icons: [`${location.origin}/tac-logo.png`] },
  onPair: sheets.onPair, onAsk: sheets.onAsk,
});
const wallet = makeWallet({ rpc, leave: (p) => (p?.isWalletConnect ? WC.disconnect() : null) });
const W = wallet.state;
walletNow = W;
const sameAddr = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
// The account whose vault is shown: the one in the address bar (read only), else the connected wallet's.
const who = () => S.view || W.account || null;
const canAct = () => !!W.account && sameAddr(W.account, who());
// A time on the chain's clock as a reader's date, for an announcement that lands days away.
const onDay = (t) => new Date(t * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).replace(',', '') + ' UTC';
const txLink = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}…↗</a>`;
const say = (t, kind = 'trade') => { const s = $('#status'); s.innerHTML = t; s.dataset.kind = kind; };

function pickWallet(list) {
  return new Promise((resolve) => {
    const o = overlay({ title: 'Choose a wallet', top: true, onClose: () => resolve(null) });
    o.body.innerHTML = `<div class="picker">${list.map((w, i) => `<button class="way" type="button" data-i="${i}"><span class="way-t">${/^data:image\//.test(w.info?.icon || '') ? `<img src="${esc(w.info.icon)}" alt="" width="20" height="20">` : ''}${esc(w.info?.name || 'Wallet')}</span></button>`).join('')}</div>`;
    o.body.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { resolve(Number(b.dataset.i)); o.close(); }; });
  });
}
async function connectWallet() {
  const list = wallet.available();
  if (!list.length) { say('No wallet was found in this browser. Open this page in a wallet app’s browser, or use tacit.finance.'); return; }
  try {
    let w = list[0];
    if (list.length > 1) { const i = await pickWallet(list); if (i == null) return; w = list[i]; }
    await wallet.connect(w);
  } catch (e) { say(esc(e instanceof UserStopped ? 'Not connected.' : (e.message || 'The wallet did not connect.'))); }
}
function renderChip() {
  const on = !!W.account, wrong = on && W.chain && W.chain !== '0x1';
  $('#wallet-dot').classList.toggle('on', on && !wrong); $('#wallet-dot').classList.toggle('warn', !!wrong);
  $('#wallet-label').textContent = on ? short(W.account) : 'Connect';
  $('#wallet-chip').setAttribute('aria-label', on ? `Wallet ${W.account}${wrong ? ', on another network' : ''}` : 'Connect a wallet');
  $('#wallet-chip').title = wrong ? 'Your wallet is on another network. It is asked to switch to Ethereum when you send.' : '';
}
function walletSheet() {
  const o = overlay({ title: 'Wallet', top: true });
  const wrong = W.chain && W.chain !== '0x1';
  o.body.innerHTML = `<div class="kv"><span>Connected with</span><b>${esc(W.name)}</b></div><div class="kv"><span>Account</span><b class="addr-s">${esc(W.account)}</b></div>${wrong ? '<div class="kv"><span>Network</span><b>Not Ethereum <button class="linkbtn" type="button" data-switch>Switch</button></b></div>' : ''}<div class="bsheet-actions" style="margin-top:14px"><button class="btn ghost" type="button" data-copy>Copy address</button><button class="btn" type="button" data-leave${S.busy ? ' disabled' : ''}>Disconnect</button></div>${S.busy ? '<p class="note">A transaction is in progress; disconnect when it ends.</p>' : ''}`;
  const addr = W.account;
  o.body.querySelector('[data-switch]')?.addEventListener('click', (e) => { e.target.disabled = true; wallet.ensureMainnet().then(() => { o.close(); renderChip(); }, () => { e.target.disabled = false; }); });
  o.body.querySelector('[data-copy]').onclick = (e) => navigator.clipboard?.writeText(addr).then(() => { e.target.textContent = 'Copied'; }, () => { e.target.textContent = 'Could not copy'; });
  o.body.querySelector('[data-leave]').onclick = async () => { o.close(); await wallet.disconnect(); renderChip(); renderAll(); };
}
$('#wallet-chip').addEventListener('click', () => { if (W.account) walletSheet(); else connectWallet(); });

// ── reading the vaults ──
// Both vaults and the account in one batch. A view that has no price to give fails inside the batch and comes back null, which is how
// "prices are not recorded yet" reaches the page.
async function load() {
  if (!VS.length) return;
  const my = ++S.seq, who0 = who();
  const fresh = VS.filter((v) => !v.s);
  if (fresh.length) {
    const n = staticCalls('0x').length, res = await batch(fresh.flatMap((v) => staticCalls(v.addr)));
    if (my !== S.seq) return;
    fresh.forEach((v, i) => { v.s = parseStatic(res.slice(i * n, (i + 1) * n)); });
  }
  const live = VS.filter((v) => v.s);
  for (const v of live) { v.tac = v.s.tac; v.synth = v.s.synth; v.oracle = v.s.oracle; v.feed = v.s.feed; }
  // The terms (the ratios, the owner window, the share of depth) can be changed by the owner, so they are read again each time.
  const nS = staticCalls('0x').length;
  const calls = [timestampCall(), ...live.flatMap((v) => staticCalls(v.addr)), ...live.flatMap((v) => dynamicCalls(v, who0))];
  const res = await batch(calls);
  if (my !== S.seq || who0 !== who()) return;                                                       // the account changed while this was read
  const ts = res[0] ? Number(wordAt(res[0], 0)) : 0;
  if (ts) { S.chainT = ts; S.chainAt = now(); }
  live.forEach((v, k) => { const s = parseStatic(res.slice(1 + k * nS, 1 + (k + 1) * nS)); if (s && s.tac === v.tac && s.synth === v.synth) { v.s = s; v.oracle = s.oracle; v.feed = s.feed; } });
  let i = 1 + live.length * nS;
  for (const v of live) { const n = dynamicCalls(v, who0).length; v.d = parseDynamic(v, who0, res.slice(i, i + n)); v.d.who = who0; i += n; }
  S.loaded = VS.some((v) => v.d); S.failed = !S.loaded;
  if (S.loaded) S.readAt = now();
}

// ── what the numbers mean ──
// Everything one vault shows, from what was read (null until it is).
function derive(V) {
  const s = V.s;
  if (!s || !V.d) return null;
  // What was read for another account (the wallet has changed since) is not this account's vault.
  const mine = (V.d.who || '').toLowerCase() === (who() || '').toLowerCase();
  const d = mine ? V.d : { ...V.d, me: null, recovered: null, onOffer: null, tacBal: null, tacAllow: null, synBal: null, synAllow: null };
  const k = KIND[V.key], me = d.me || { collateral: 0n, debt: 0n, auctionStart: 0 };
  const room = d.depthCeiling != null && d.debtCeiling != null && d.totalDebt != null ? M.sharedRoom({ debtCeiling: d.debtCeiling, depthCeiling: d.depthCeiling, totalDebt: d.totalDebt }) : null;
  const x = { V, s, d, k, me, room, sym: /^[A-Za-z0-9]{2,12}$/.test(d.symbol || '') ? d.symbol : k.sym, safe: 2n * s.liq };
  x.paused = d.pB == null || room == null || d.feeBps == null;                                       // borrowing needs a price, the depth and the fee
  x.auction = me.auctionStart !== 0;
  x.pauseEnd = d.pausedUntil != null ? Number(d.pausedUntil) : 0;
  x.auctionsPaused = x.pauseEnd > chainNow();                                                        // the owner has paused liquidations, outside bids and redemptions
  x.value = d.pL != null ? M.valueOf(me.collateral, d.pL) : null;
  x.zone = d.pL != null ? M.zoneOf({ collateral: me.collateral, debt: me.debt, price: d.pL, liq: s.liq }) : null;
  x.ratio = x.value != null && me.debt > 0n ? M.ratioBps(x.value, me.debt) : null;
  x.borrow = x.paused ? null : M.borrowLimit({ collateral: me.collateral, debt: me.debt, pB: d.pB, mint: s.mint, feeBps: d.feeBps, room, minDebt: s.minDebt });
  x.wpaused = me.debt > 0n && d.pB == null;                                                          // taking TAC out with a debt needs the borrow price
  x.wmax = x.wpaused ? 0n : M.withdrawLimit({ collateral: me.collateral, debt: me.debt, pB: d.pB, mint: s.mint });
  x.rep = M.repayLimit({ debt: me.debt, balance: d.synBal ?? 0n, minDebt: s.minDebt });
  x.top = d.pL != null && me.debt > 0n ? M.topUp({ collateral: me.collateral, debt: me.debt, price: d.pL, bps: x.safe }) : 0n;
  x.liqPrice = M.liquidationPriceOf(me.collateral, me.debt, s.liq);
  x.line = Number(M.borrowLineBps({ mint: s.mint, pL: d.pL, pB: d.pB }));
  // The TAC price now (the oracle's lower venue) in the vault's token, converted as the vault converts: ETH per TAC × the feed's answer.
  x.px = d.spot != null && d.feed && d.feed.answer > 0n ? d.spot * d.feed.answer / 10n ** BigInt(d.feed.decimals) : null;
  // The dollar feed (TAC Dollar only: TAC Ether's is a fixed 1.0) and whether the vault would refuse its answer as too old.
  x.feedAge = V.key === 'usd' && d.feed ? Math.max(0, chainNow() - d.feed.updatedAt) : null;
  x.stale = x.feedAge != null && x.feedAge > s.staleness;
  x.cap = d.debtCeiling != null && d.depthCeiling != null ? (d.debtCeiling < d.depthCeiling ? d.debtCeiling : d.depthCeiling) : null;
  x.ownerCap = x.cap != null && d.debtCeiling < d.depthCeiling;                                      // the owner's ceiling, not the pools' depth, is what limits lending
  x.backing = d.held != null && d.pL != null && d.totalDebt > 0n ? M.ratioBps(M.valueOf(d.held, d.pL), d.totalDebt) : null;
  return x;
}

// ── writing figures ──
const tac = (v) => M.fmtAmount(v, 2);
const syn = (x, v) => M.fmtAmount(v, x.k.dp);
const pctOf = (bps) => `${Math.floor(Number(bps) / 100).toLocaleString('en-US')}%`;
const feeText = (bps) => `${Number(bps) / 100}%`;
const priceText = (x, p, dir) => x.k.price(M.fmtUnits(M.sigTo(p, 3, dir), 18, 18));
const zoneName = { liquidation: 'Liquidation', redemption: 'Redemption', safe: 'Safe' };

// ── the vault picker, the room ──
function renderPick() {
  $('#pick-w').hidden = VS.length < 2;
  $('#pick').innerHTML = VS.map((v) => `<button type="button" data-v="${v.key}" aria-pressed="${v.key === S.v}"${S.busy ? ' disabled' : ''}>${esc(KIND[v.key].name)}<small>${esc(KIND[v.key].sym)}</small></button>`).join('');
}
const setHtml = (el, h) => { if (el.__h !== h) { el.__h = h; el.innerHTML = h; } };
// ── the status board ──
// One table for both vaults: whether each can be borrowed from now, the room left and the figures that decide it, with what is needed
// when it cannot. Everything is read from the contracts; "now" is the last read, which the page repeats every half minute.
const GROUP = (list) => { const m = new Map(); for (const [x, t] of list) { const k = JSON.stringify(t); if (!m.has(k)) m.set(k, { names: [], t }); m.get(k).names.push(x.k.name); } return [...m.values()]; };
// The oracle's announced change of a term, if there is one still to be made: { value, eta }.
const announcedTerm = (x, id) => { const n = chainNow(), a = (x.d.announced || []).find((q) => q.id === id && q.eta > 0 && q.eta + QUEUE_EXPIRY > n); return a ? { value: BigInt(a.value), eta: a.eta } : null; };
// What the room and the smallest debt would be once the announced changes of the pools' share and the smallest debt are made, at today's depth.
function afterAnnounced(x) {
  const depth = announcedTerm(x, 0), min = announcedTerm(x, 6);
  if ((!depth && !min) || x.d.depthCeiling == null || x.d.debtCeiling == null || x.d.totalDebt == null) return null;
  const ceil = depth ? x.d.depthCeiling * depth.value / x.s.depthBps : x.d.depthCeiling, cap = ceil < x.d.debtCeiling ? ceil : x.d.debtCeiling;
  return { room: cap > x.d.totalDebt ? cap - x.d.totalDebt : 0n, minDebt: min ? min.value : x.s.minDebt, eta: Math.max(depth?.eta || 0, min?.eta || 0) };
}
// Can this vault be borrowed from, and if not, why and what changes it.
function statusOf(x) {
  const f = feedOf(x.V);
  if (x.paused) {
    if (x.stale) return { state: 'paused', short: 'ETH/USD price old', why: `The ETH/USD price is ${M.span(x.feedAge)} old; borrowing needs one under ${M.span(x.s.staleness)}.`, next: 'It clears with the feed’s next update.' };
    if (f && !f.ready) return { state: 'paused', short: 'prices not recorded', why: `Borrowing waits for ${f.missing} price${f.missing === 1 ? '' : 's'} to be recorded.`, next: 'Anyone can record them, <a href="#feed" data-tofeed>below</a>.' };
    if (!f && !F.tried) return { state: 'paused', short: 'checking prices', why: 'Checking prices…', next: '' };
    return { state: 'paused', short: 'prices unreadable', why: 'Could not read the prices. Try again in a moment.', next: '' };
  }
  if (x.room < x.s.minDebt) {
    const ceil = x.d.debtCeiling, g = (v) => `${syn(x, v)} ${x.sym}`;
    if (x.ownerCap && ceil === 0n) return { state: 'thin', short: 'switched off', why: 'The owner has switched borrowing off.', next: '' };
    if (x.ownerCap) return { state: 'thin', short: 'cap reached', why: `The owner caps borrowing at ${g(ceil)}; ${g(x.room)} is left, under the smallest debt (${g(x.s.minDebt)}).`, next: '' };
    const after = afterAnnounced(x), why = x.room === 0n ? `All ${g(x.cap)} is borrowed.` : `Room (${g(x.room)}) is under the smallest debt (${g(x.s.minDebt)}).`;
    if (after && after.room >= after.minDebt && after.room > 0n) return { state: 'thin', short: 'room too small', why, next: `The announced change makes the room ${g(after.room)} (smallest debt ${g(after.minDebt)}): borrowing opens from ${onDay(after.eta)}.` };
    return { state: 'thin', short: 'room too small', why, next: 'More liquidity in the TAC pools adds room. <a href="/trade/tac/#farm">Add liquidity →</a>' };
  }
  return { state: 'open', short: '', why: '', next: '' };
}
function boardRows(xs) {
  const cell = (fn) => xs.map((x) => `<td class="num">${fn(x)}</td>`).join('');
  const dash = '—';
  // [label, what a vault shows, whether it waits behind "More figures"]
  const rows = [
    ['Borrowing', (x) => { const st = x.status; return `<span class="st s-${st.state}"><i class="sd"></i>${st.state === 'open' ? 'Open' : 'Not open'}</span>${st.short && !x.hideShort ? `<small>${esc(st.short)}</small>` : ''}`; }],
    ['Room to borrow', (x) => (x.room != null ? `<b>${esc(syn(x, x.room))}</b> ${esc(x.sym)}` : dash)],
    ['Smallest debt', (x) => `${esc(syn(x, x.s.minDebt))} ${esc(x.sym)}`],
    ['Fee', (x) => (x.d.feeBps != null ? esc(feeText(x.d.feeBps)) : dash)],
    ['Borrowed so far', (x) => (x.d.totalDebt != null ? `${esc(syn(x, x.d.totalDebt))} ${esc(x.sym)}` : dash)],
    ['TAC deposited', (x) => (x.d.held != null ? `${esc(tac(x.d.held))} TAC` : dash), true],
    ['Collateral ratio', (x) => (x.backing != null ? esc(pctOf(x.backing)) : dash), true],
    ['Pools’ depth', (x) => {
      const f = feedOf(x.V), d = x.d;
      if (d.depthCeiling != null && x.s.depthBps > 0n) return `${esc(syn(x, d.depthCeiling * 10000n / x.s.depthBps))} ${esc(x.sym)}<small>lowest in 8 h</small>`;
      if (f?.depth != null && d.feed && d.feed.answer > 0n) return `${esc(syn(x, f.depth * d.feed.answer / 10n ** BigInt(d.feed.decimals)))} ${esc(x.sym)}<small>lowest so far</small>`;
      return dash;
    }, true],
    ['Share of depth lent', (x) => `${esc(String(Number(x.s.depthBps) / 100))}%`, true],
    ['TAC price', (x) => (x.px != null ? esc(priceText(x, x.px, 'down')) : dash), true],
    ...(xs.some((x) => x.feedAge != null) ? [['ETH/USD price', (x) => (x.feedAge != null ? `<span class="${x.stale ? 'z-liquidation' : ''}">${esc(M.span(x.feedAge))} old</span><small>${x.stale ? 'too old to use' : `limit ${esc(M.span(x.s.staleness))}`}</small>` : dash), true]] : []),
    ['Borrow / liquidate at', (x) => `${esc(pctOf(x.s.mint))} · ${esc(pctOf(x.s.liq))}`, true],
  ];
  return rows.filter((r) => S.more || !r[2]).map(([label, fn]) => `<tr><th scope="row">${esc(label)}</th>${cell(fn)}</tr>`).join('');
}
function renderBoard() {
  const el = $('#board'), xs = VS.map((v) => derive(v)).filter(Boolean);
  const head = `<p class="eyebrow" id="board-h"><span>Vault status</span><span class="who">${S.readAt ? `read <span data-ago="${S.readAt}">${agoText(now() - S.readAt)}</span> · ` : ''}<button class="linkbtn" type="button" data-refresh>Refresh</button></span></p>`;
  el.classList.toggle('loading', !xs.length && !S.failed);
  if (!xs.length) { setHtml(el, `${head}<p class="verdict off">${S.failed ? 'Could not read the vaults.' : 'Reading the vaults…'}</p>${S.failed ? '<p class="note">Try again in a moment.</p>' : '<div class="sk" aria-hidden="true">' + '<i></i>'.repeat(9) + '</div>'}`); return; }
  for (const x of xs) x.status = statusOf(x);
  const open = xs.filter((x) => x.status.state === 'open');
  const verdict = open.length === xs.length ? (xs.length > 1 ? 'Borrowing is open on both vaults' : `Borrowing is open on ${xs[0].k.name}`) : open.length ? `Borrowing is open on ${open.map((x) => x.k.name).join(' and ')}` : 'Borrowing is not open yet';
  // What each closed vault needs, said once (and without a name) when every vault needs the same.
  const need = GROUP(xs.filter((x) => x.status.state !== 'open').map((x) => [x, { why: x.status.why, next: x.status.next }]));
  const shared = need.length === 1 && need[0].names.length === xs.length;                         // one reason for every vault is said once, above the table
  for (const x of xs) x.hideShort = shared;
  const needs = need.map((g) => `<li>${g.names.length === xs.length ? '' : `<b>${esc(g.names.join(' and '))}:</b> `}${g.t.why}${g.t.next ? ` ${g.t.next}` : ''}</li>`).join('');
  const notices = xs.filter((x) => x.auctionsPaused).map((x) => pauseBox(x, xs.length > 1)).join('') + changesNotice(xs);
  setHtml(el, `${head}<p class="verdict ${open.length ? 'on' : 'off'}"><i class="sd"></i><span>${esc(verdict)}</span></p>
    ${needs ? `<ul class="needs">${needs}</ul>` : ''}
    <div class="bt-wrap"><table class="bt"><thead><tr><td></td>${xs.map((x) => `<th scope="col">${esc(x.k.name)}<small>${esc(x.sym)}</small></th>`).join('')}</tr></thead><tbody>${boardRows(xs)}</tbody></table></div>
    <button class="linkbtn more" type="button" data-more aria-expanded="${!!S.more}">${S.more ? 'Fewer figures' : 'More figures'}</button>
    ${notices}`);
}
const agoText = (s) => (s < 5 ? 'just now' : s < 60 ? `${Math.round(s)} s ago` : `${M.span(s)} ago`);

// ── how borrowing works, from the vault's own terms ──
function renderHow() {
  const el = $('#how');
  el.hidden = !VS.length;
  const V = cur(), x = V && derive(V);
  if (!x) return;
  const sym = esc(x.sym), fee = x.d.feeBps != null ? `${feeText(x.d.feeBps)} fee to borrow` : 'One fee to borrow', redeem = `${feeText(x.s.redemptionFee)} to ${feeText(x.s.redemptionFee * 4n)}`;
  setHtml($('#how-body'), `<ol>
    <li><b>Deposit TAC, borrow ${sym}.</b> Up to your TAC’s value over ${pctOf(x.s.mint)}. ${fee}, no interest.</li>
    <li><b>Prices move slowly.</b> They come from the TAC pools over hours, so a brief dip does not liquidate you.</li>
    <li><b>Under ${pctOf(x.s.liq)}, a vault can be auctioned.</b> Bids repay its debt for its TAC at a bonus that grows over ${esc(M.span(x.s.auctionDuration))}; only the vault’s owner can bid for the first ${esc(M.span(x.s.ownerWindow))}. Repaying or adding TAC ends it.</li>
    <li><b>${pctOf(x.s.liq)} to ${pctOf(x.safe)}, it can be redeemed against.</b> A ${sym} holder swaps it for the vault’s TAC at its price (${redeem} fee), which lowers the debt.</li>
    <li><b>Repay any time.</b> The debt left must be zero or at least ${esc(syn(x, x.s.minDebt))} ${sym}.</li>
  </ol>
  <p>The owner can lower the cap, set fees (up to 5% to borrow, 2.5% to redeem) and pause auctions for up to 12 hours. Other changes are announced here 2 to 3 days ahead.</p>`);
}

// ── a person's vault ──
function healthBar(x) {
  const p2 = M.barPos(Number(x.s.liq)), p4 = M.barPos(Number(x.safe)), pl = M.barPos(x.line), pm = M.barPos(Number(x.ratio));
  const pc = (f) => `${(f * 100).toFixed(2)}%`, edge = pm < 0.1 ? ' l' : pm > 0.9 ? ' r' : '';
  const z = (name, w) => `<i class="hb-z ${name}${x.zone === name ? ' on' : ''}" style="width:${pc(w)}"></i>`;
  const label = `Ratio ${pctOf(x.ratio)}: ${x.zone === 'liquidation' ? 'liquidation' : x.zone === 'redemption' ? 'open to redemption' : 'safe'}. Liquidation under ${pctOf(x.s.liq)}, safe from ${pctOf(x.safe)}; you can borrow or withdraw down to ${pctOf(x.s.mint)}.`;
  return `<div class="hb" role="img" aria-label="${esc(label)}">
    <div class="hb-top"><span style="left:${pc(pl)}">${pctOf(x.s.mint)} borrowing line</span></div>
    <div class="hb-bar">${z('liquidation', p2)}${z('redemption', p4 - p2)}${z('safe', 1 - p4)}<i class="hb-tick" style="left:${pc(pl)}"></i><i class="hb-pin" style="left:${pc(pm)}"></i></div>
    <div class="hb-nums"><span style="left:${pc(p2)}">${pctOf(x.s.liq)}</span><span style="left:${pc(p4)}">${pctOf(x.safe)}</span></div>
    <div class="hb-bot"><span class="hb-val${edge}" style="left:${pc(pm)}">${pctOf(x.ratio)}</span></div>
    <div class="hb-key">${['liquidation', 'redemption', 'safe'].map((k) => `<span class="${x.zone === k ? 'on' : ''}"><i class="${k}"></i>${zoneName[k]}</span>`).join('')}</div></div>`;
}
function zoneLine(x) {
  if (x.zone === 'liquidation') return `Under ${pctOf(x.s.liq)}: this vault can be auctioned.`;
  if (x.zone === 'redemption') return `Open to redemption: a ${esc(x.sym)} holder can swap it for your TAC at its price, and your debt falls by as much.`;
  return 'Safe: nothing can be redeemed or auctioned against this vault.';
}
function pauseBox(x, named = false) {
  return `<div class="callout"><span class="t"><b>Auctions paused${named ? ` on ${esc(x.k.name)}` : ''}</b> for <b data-cd="${x.pauseEnd}">${M.clock(x.pauseEnd - chainNow())}</b>: no liquidations, outside bids or redemptions. Everything else works.</span></div>`;
}
// What the owner has announced and not yet made, in one notice for every vault. Only a change that tightens is one to act ahead of; a new price
// source or minter is neither way, so it counts as one.
const TERM_NAMES = ['Share of depth lent', 'Borrowing line', 'Liquidation ratio', 'Bid bonus', 'Vault owner’s bidding window', 'Auction length', 'Smallest debt'];
// Which way a term's change falls for someone borrowing: 1 where a larger number is the easier one, -1 where a smaller one is, 0 where neither is.
const EASIER_WHEN_LARGER = [1, -1, -1, -1, 1, 0, -1];
// What each term is now, in the same units as an announcement; null where the page does not read it, which counts as a change to act on.
const CURRENT_TERM = [(x) => x.s.depthBps, (x) => x.s.mint, (x) => x.s.liq, () => null, (x) => x.s.ownerWindow, (x) => x.s.auctionDuration, (x) => x.s.minDebt];
function termText(x, id, v) {
  if (id === 0) return `${Number(v) / 100}%`;
  if (id === 1 || id === 2) return pctOf(v);
  if (id === 3) return feeText(v);
  if (id === 4 || id === 5) return M.span(Number(v));
  return `${syn(x, v)} ${x.sym}`;
}
function changesNotice(xs) {
  const now = chainNow(), live = (eta) => eta > 0 && eta + QUEUE_EXPIRY > now, many = xs.length > 1;
  const when = (eta) => (eta > now ? `from ${onDay(eta)} (in ${M.span(eta - now)})` : 'can be made now');
  const lines = [];
  let tightens = false;
  for (const x of xs) {
    const pre = many ? `${esc(x.k.name)}: ` : '';
    for (const a of (x.d.announced || []).filter((q) => live(q.eta))) {
      lines.push(`${pre}${TERM_NAMES[a.id]} → ${termText(x, a.id, a.value)} · ${when(a.eta)}`);
      const dir = EASIER_WHEN_LARGER[a.id], was = CURRENT_TERM[a.id]?.(x);
      if (was == null || !dir || dir * (BigInt(a.value) > BigInt(was) ? 1 : BigInt(a.value) < BigInt(was) ? -1 : 0) < 0) tightens = true;
    }
    if (live(x.d.oracleEta)) { lines.push(`${pre}New price source · ${when(x.d.oracleEta)}`); tightens = true; }
    if (live(x.d.minterEta)) { lines.push(`${pre}Another contract may mint ${esc(x.sym)} · ${when(x.d.minterEta)}`); tightens = true; }
  }
  if (!lines.length) return '';
  const head = tightens ? '<b>Changes announced by the owner.</b> They tighten borrowing: repay or withdraw before then if you would rather not take them.' : '<b>Changes announced by the owner.</b> They make borrowing easier; nothing to do.';
  return `<div class="callout${tightens ? '' : ' soft'}"><span class="t">${head}${lines.map((l) => `<span class="sub">${l}</span>`).join('')}</span></div>`;
}

// The clock auctions run on (`auctionStart` is a reading of it): the chain's time less the time spent paused, so it stands still while
// auctions are paused. From the reading in `d` it runs on from the later of the reading and the end of the pause.
const auctionNow = (d) => (d.auctionTime == null ? chainNow() : d.auctionTime + Math.max(0, chainNow() - Math.max(S.chainT, Number(d.pausedUntil || 0))));
function auctionBox(x) {
  const left = x.me.auctionStart + x.s.ownerWindow - auctionNow(x.d);
  const owner = x.auctionsPaused ? `Bids from others are paused for <b data-cd="${x.pauseEnd}">${M.clock(x.pauseEnd - chainNow())}</b>; the vault’s owner can still bid.` : left > 0 ? `Only the vault’s owner can bid for <b data-cd="${chainNow() + left}">${M.clock(left)}</b>, then anyone.` : 'Anyone can bid now.';
  const offer = x.d.pO != null ? `<span class="sub">The offer is ${esc(priceText(x, x.d.pO, 'down'))} per TAC${x.d.onOffer != null ? `; a bid for all the debt takes ${esc(tac(x.d.onOffer))} TAC` : ''}.</span>` : '';
  const way = x.d.recovered ? 'The vault has recovered: ending the auction restores borrowing and withdrawing.' : 'Repay, or add TAC, to end it. It ends once the vault is back above ' + pctOf(x.s.liq) + '.';
  return `<div class="callout red"><span class="t"><b>An auction is running.</b> ${owner}${offer}<span class="sub">${way}</span></span>${x.d.recovered && canAct() ? '<button class="pillbtn" type="button" data-cancel>End the auction</button>' : ''}</div>`;
}
function renderPos() {
  const V = cur(), x = V && derive(V), el = $('#pos');
  const viewing = S.view ? `<span class="who">${esc(short(S.view))}</span>` : '';
  const head = `<p class="eyebrow" id="pos-h"><span>${x ? `${esc(x.k.name)} vault` : 'Your vault'}</span>${viewing}</p>`;
  if (!x) { setHtml(el, `${head}<p class="empty">${S.failed ? 'Not read yet.' : 'Reading the vault…'}</p>`); return; }
  if (!who()) { setHtml(el, `${head}<p class="empty"><button class="linkbtn" type="button" data-connect>Connect a wallet</button> to see your vault.</p>`); return; }
  const m = x.me;
  if (m.collateral === 0n && m.debt === 0n) {
    setHtml(el, `${head}<p class="empty">${S.view ? 'This account has nothing in the vault.' : `Nothing deposited yet. Deposit TAC to borrow ${esc(x.sym)} against it.`}</p>${S.view ? '<p class="note"><a href="#" data-mine>Use my wallet</a></p>' : ''}`);
    return;
  }
  const rows = [];
  rows.push(`<div class="kv"><span>Collateral</span><b class="num">${esc(tac(m.collateral))} TAC${x.value != null ? `<small>${esc(syn(x, x.value))} ${esc(x.sym)}</small>` : ''}</b></div>`);
  rows.push(`<div class="kv"><span>Debt</span><b class="num">${esc(syn(x, m.debt))} ${esc(x.sym)}</b></div>`);
  if (x.ratio != null) rows.push(`<div class="kv"><span>Ratio</span><b class="num z-${x.zone}">${esc(pctOf(x.ratio))}</b></div>`);
  if (x.borrow) rows.push(`<div class="kv"><span>You can borrow</span><b class="num">${esc(syn(x, x.borrow.amount))} ${esc(x.sym)}${x.borrow.binding === 'room' ? '<small>limited by the room left to borrow</small>' : ''}</b></div>`);
  if (x.liqPrice != null && x.d.pL != null) {
    const below = Math.floor((1 - Number(x.liqPrice) / Number(x.d.pL)) * 100);
    rows.push(`<div class="kv"><span>Liquidation price</span><b class="num">${esc(priceText(x, x.liqPrice, 'up'))}<small>${below > 0 ? `${below}% below TAC’s price` : 'TAC is at or below it'}</small></b></div>`);
  }
  let body = `<div class="rows flat">${rows.join('')}</div>`;
  if (x.ratio == null && m.debt > 0n) body += '<p class="zline">The ratio shows once prices are recorded.</p>';
  if (x.ratio != null) {
    body += healthBar(x) + `<p class="zline">${zoneLine(x)}</p>`;
    if (x.zone !== 'safe' && x.top > 0n && !x.auction && canAct()) body += `<div class="callout"><span class="t">Add <b class="num">${esc(tac(x.top))} TAC</b> to reach ${esc(pctOf(x.safe))}</span><button class="pillbtn" type="button" data-fill="${M.plain(x.top)}">Add it</button></div>`;
  }
  if (x.auction) body += auctionBox(x);
  if (x.auction && x.top > 0n && canAct()) body += `<div class="callout"><span class="t">Add <b class="num">${esc(tac(x.top))} TAC</b> to reach ${esc(pctOf(x.safe))}</span><button class="pillbtn" type="button" data-fill="${M.plain(x.top)}">Add it</button></div>`;
  setHtml(el, head + body + (S.view ? '<p class="note"><a href="#" data-mine>Use my wallet</a></p>' : ''));
}

// ── the ticket ──
// What the typed amount would do: whether it can be sent, what it says about itself, and what the transaction takes.
function planOf() {
  const V = cur(), x = V && derive(V), t = S.t;
  if (!x) return { ok: false, cta: 'Reading the vault…', rows: [], hint: '' };
  const amt = M.parseUnits(S.amt, 18), m = x.me, d = x.d, sym = x.sym, mint = pctOf(x.s.mint);
  const P = { kind: t, x, amt, ok: false, cta: '', rows: [], hint: '', err: false, max: 0n, maxText: '' };
  const after = (collateral, debt) => (d.pL != null && debt > 0n ? M.ratioBps(M.valueOf(collateral, d.pL), debt) : null);
  const ratioRow = (collateral, debt) => { const r = after(collateral, debt), z = d.pL != null ? M.zoneOf({ collateral, debt, price: d.pL, liq: x.s.liq }) : null; return r != null ? [['Ratio after', `<span class="z-${z}">${esc(pctOf(r))}</span>`]] : []; };
  const fill = (n) => `<button class="linkbtn" type="button" data-fill="${M.plain(n)}">Add ${esc(tac(n))} TAC</button>`;
  const typed = S.amt.trim() !== '';
  if (typed && amt == null) { P.hint = 'Cannot read that amount. Write 1500 or 0.05 (1,500 alone is ambiguous).'; P.err = true; P.cta = 'Enter an amount'; return P; }
  const none = !amt;

  if (t === 'deposit') {
    const bal = d.tacBal ?? 0n; P.max = bal; P.maxText = who() ? `Balance ${tac(bal)} · Max` : '';
    if (none) { P.cta = 'Enter an amount'; return P; }
    if (amt > bal) { P.cta = 'Not enough TAC'; return P; }
    P.ok = true; P.cta = 'Deposit TAC'; P.amount = amt;
    P.rows = [['Collateral after', `${esc(tac(m.collateral + amt))} TAC`], ...ratioRow(m.collateral + amt, m.debt)];
    return P;
  }
  if (t === 'borrow') {
    P.max = x.borrow?.amount ?? 0n; P.maxText = x.borrow && who() ? `Up to ${syn(x, P.max)} · Max` : '';
    if (x.auction) { P.cta = 'In an auction'; P.hint = 'Borrowing waits until the auction ends. Repay, or add TAC, to end it.'; return P; }
    if (x.paused) { P.cta = 'Borrowing is paused'; P.hint = 'Borrowing waits until prices are recorded.'; return P; }
    if (none) { P.cta = 'Enter an amount'; return P; }
    const c = M.checkBorrow({ amount: amt, collateral: m.collateral, debt: m.debt, pB: d.pB, mint: x.s.mint, feeBps: d.feeBps, room: x.room, minDebt: x.s.minDebt });
    P.cta = `Borrow ${sym}`;
    if (!c.ok) {
      P.err = true;
      if (c.why === 'min') P.hint = `Smallest debt is ${syn(x, x.s.minDebt)} ${sym}: borrow at least ${syn(x, M.ceilTo(c.least, x.k.dp))}.`;
      else if (c.why === 'own') {
        const add = M.addToBorrow({ collateral: m.collateral, owe: c.owe, pB: d.pB, mint: x.s.mint });
        P.hint = `You can borrow up to ${syn(x, c.limit)} ${sym} now${add > 0n ? `, or ${fill(add)} to borrow this` : ''}.`;
      } else P.hint = `Only ${syn(x, c.limit)} ${sym} is left to borrow.`;
      return P;
    }
    P.ok = true; P.amount = amt; P.feeBps = d.feeBps;
    const owe = c.owe, r = after(m.collateral, owe);
    P.rows = [[`Fee (${feeText(d.feeBps)})`, `${esc(syn(x, c.fee))} ${esc(sym)}`], ['You receive', `${esc(syn(x, amt))} ${esc(sym)}`], ['You owe after', `${esc(syn(x, owe))} ${esc(sym)}`], ...ratioRow(m.collateral, owe)];
    if (r != null && d.pL != null && M.zoneOf({ collateral: m.collateral, debt: owe, price: d.pL, liq: x.s.liq }) !== 'safe') {
      const add = M.topUp({ collateral: m.collateral, debt: owe, price: d.pL, bps: x.safe });
      P.hint = `That leaves the vault at ${pctOf(r)}, open to redemption. ${fill(add)} to stay at ${pctOf(x.safe)} or more.`;
    }
    return P;
  }
  if (t === 'repay') {
    const bal = d.synBal ?? 0n; P.max = x.rep.max; P.maxText = who() ? `You hold ${syn(x, bal)} · Max` : '';
    if (m.debt === 0n) { P.cta = 'Nothing to repay'; return P; }
    if (bal < m.debt) P.hint = `You hold ${syn(x, bal)} of the ${syn(x, m.debt)} ${sym} you owe.`;
    if (none) { P.cta = 'Enter an amount'; return P; }
    const c = M.checkRepay({ amount: amt, debt: m.debt, balance: bal, minDebt: x.s.minDebt });
    P.cta = c.all ? `Repay all ${sym}` : `Repay ${sym}`;
    if (!c.ok) {
      P.err = true;
      if (c.why === 'balance') P.hint = bal < m.debt ? `You hold ${syn(x, bal)} of the ${syn(x, m.debt)} ${sym} you owe.${x.rep.max > 0n ? ` You can repay up to ${syn(x, x.rep.max)}.` : ''}` : `You hold ${syn(x, bal)} ${sym}.`;
      else P.hint = `Debt left must be zero or at least ${syn(x, x.s.minDebt)} ${sym}. Repay ${m.debt > x.s.minDebt ? `up to ${syn(x, M.floorTo(m.debt - x.s.minDebt, x.k.dp))}, or ` : ''}all ${syn(x, m.debt)}.`;
      if (c.why === 'balance') P.cta = 'Not enough ' + sym;
      return P;
    }
    P.ok = true; P.all = c.all; P.paid = c.paid; P.amount = c.all ? M.MAX_UINT : amt;
    P.rows = [['You owe', `${esc(syn(x, m.debt))} ${esc(sym)}`], ['Owed after', `${esc(syn(x, c.left))} ${esc(sym)}`], ...(c.left > 0n ? ratioRow(m.collateral, c.left) : [])];
    return P;
  }
  // withdraw
  P.max = x.wmax; P.maxText = who() ? `Up to ${tac(x.wmax)} · Max` : '';
  if (x.auction) { P.cta = 'In an auction'; P.hint = 'Withdrawing waits until the auction ends. Repay, or add TAC, to end it.'; return P; }
  if (x.wpaused) { P.cta = 'Withdrawing is paused'; P.hint = 'With a debt, withdrawing waits until prices are recorded.'; return P; }
  if (m.collateral === 0n) { P.cta = 'Nothing to withdraw'; return P; }
  if (none) { P.cta = 'Enter an amount'; return P; }
  P.cta = 'Withdraw TAC';
  if (amt > x.wmax) {
    P.err = true;
    P.hint = m.debt === 0n ? `You have ${tac(m.collateral)} TAC in the vault.` : x.wmax > 0n ? `You can withdraw up to ${tac(x.wmax)} TAC and stay at ${mint}.` : `Every TAC here is needed to keep the vault at ${mint}. Repay some ${sym} first.`;
    return P;
  }
  P.ok = true; P.all = m.debt === 0n && amt >= m.collateral; P.amount = P.all ? M.MAX_UINT : amt;
  P.rows = [['Collateral after', `${esc(tac(m.collateral - amt))} TAC`], ...ratioRow(m.collateral - amt, m.debt)];
  return P;
}

function renderTicket() {
  const V = cur(), x = V && derive(V), P = planOf(), t = S.t;
  const sym = x?.sym || KIND[S.v]?.sym || '', isTac = t === 'deposit' || t === 'withdraw';
  setHtml($('#acts'), ACTS.map(([k, l]) => `<button type="button" data-t="${k}" aria-pressed="${k === t}"${S.busy ? ' disabled' : ''}>${l}</button>`).join(''));
  $('#tk-h').textContent = x ? `${x.k.name} vault` : 'Vault';
  $('#amt-lbl').textContent = isTac ? `TAC to ${t}` : `${sym} to ${t}`;
  $('#unit').textContent = isTac ? 'TAC' : sym;
  $('#amt').setAttribute('aria-label', isTac ? `TAC to ${t}` : `${sym} to ${t}`);
  const bal = $('#bal'); bal.hidden = !P.maxText || !x; bal.textContent = P.maxText; bal.disabled = S.busy;
  setHtml($('#chips'), [25, 50, 75, 100].map((p) => `<button type="button" data-pct="${p}"${S.busy || !(P.max > 0n) ? ' disabled' : ''}>${p === 100 ? 'Max' : `${p}%`}</button>`).join(''));
  setHtml($('#info'), P.rows.map(([l, v]) => `<div class="kv"><span>${esc(l)}</span><b class="num">${v}</b></div>`).join(''));
  $('#info').hidden = !P.rows.length;
  const h = $('#hint'); setHtml(h, P.hint); h.classList.toggle('err', !!P.err);
  const go = $('#go');
  go.title = '';
  if (!W.account) { go.textContent = 'Connect wallet'; go.disabled = false; }
  else if (!canAct()) { go.textContent = 'Viewing another account'; go.disabled = true; }
  else if (S.busy) { go.textContent = 'Working…'; go.disabled = true; }
  else { go.textContent = P.cta; go.disabled = !P.ok; }
  $('#amt').disabled = S.busy;
}
// An amount for the box: a share of the most that goes through (rounded down, so it still does), or all of it.
function setAmount(pct) {
  const P = planOf();
  if (!(P.max > 0n)) return;
  const unit = (S.t === 'deposit' || S.t === 'withdraw') ? 4 : (S.v === 'eth' ? 6 : 4);
  S.amt = pct === 100 ? M.plain(P.max) : M.plain(M.floorTo(P.max * BigInt(pct) / 100n, unit));
  $('#amt').value = S.amt; renderTicket();
}

// ── the actions ──
// The call, tested once as the account before anything is signed or sent.
async function simulate(to, data, from) {
  try { await ethCall(to, data, { from }); return { ok: true }; } catch (e) { return { ok: false, e }; }
}
const WHY = {
  limit: (x) => `That would take the vault under ${pctOf(x.s.mint)}.`, room: () => 'There is less room to borrow than that.', auction: () => 'This vault is in an auction.',
  amount: (x) => `That amount is not accepted: a vault’s debt is zero or at least ${syn(x, x.s.minDebt)} ${x.sym}.`, fee: () => 'The borrow fee changed.', paused: () => 'Borrowing waits until prices are recorded.',
  noauction: () => 'There is no auction on this vault.', unhealthy: () => 'The vault has not recovered yet.', healthy: () => 'The vault is healthy.', ownerwindow: () => 'Only the vault’s owner can bid for now.',
  access: (x, kind) => `The ${kind === 'repay' ? x.sym : 'TAC'} was not available to the vault.`, balance: (x, kind) => `Not enough ${kind === 'repay' ? x.sym : 'TAC'}.`,
};
const failText = (x, kind, e) => { const w = refusal(e); return `${w && WHY[w] ? WHY[w](x, kind) : 'This would fail.'} Nothing was sent; the figures above are current.`; };
const errText = (e) => esc(e instanceof UserStopped ? e.message : String(e?.message || e).slice(0, 220));

// The token the call spends, made available to the vault: a permit signed in the wallet (no gas, one transaction) where there is no allowance,
// else an exact approval sent first. A permit the vault does not accept falls back to the approval.
async function withAccess({ V, token, amount, allowance, from, make }) {
  if (allowance >= amount) return { data: make(null) };
  try {
    say('Sign the permit in your wallet. The signature costs nothing.');
    const [name, nonce] = await Promise.all([ethCall(token, SEL.name), ethCall(token, SEL.nonces + addrWord(from))]);
    const dl = chainDeadline(1200);
    const sig = await wallet.signPermit({ token, name: decString(name), spender: V.addr, value: amount, deadline: dl, nonce: wordAt(nonce, 0), owner: from });
    const data = make({ value: amount, deadline: dl, ...sig });
    say('Checking it first…');
    const sim = await simulate(V.addr, data, from);
    if (sim.ok) return { data };
    const why = refusal(sim.e);
    if (why && why !== 'access') throw Object.assign(new Error(why), { sim: sim.e });
  } catch (e) { if (e instanceof UserStopped || e.sim) throw e; }
  say('Approve in your wallet. It lets the vault take exactly this amount.');
  const h = await wallet.sendTx({ to: token, data: encApprove(V.addr, amount), from });
  say(`Waiting for the approval ${txLink(h)}`);
  if ((await wallet.receipt(h)).status !== '0x1') throw new Error('The approval did not go through.');
  return { data: make(null), approved: true };
}

async function run(kindOverride) {
  if (S.busy) return;
  if (!W.account) { connectWallet(); return; }
  const V = cur();
  if (!V || !canAct()) return;
  const from = W.account;                                                                           // everything below is for this account, and the wallet is asked for no other
  const cancel = kindOverride === 'cancel';
  const typed = S.amt, shown = cancel ? null : planOf();                                          // what the person is looking at: the amount, and for a borrow the fee
  if (!cancel && !shown.ok) return;
  S.busy = true; lockAll(); renderTicket();
  try {
    say('Reading the vault again…');
    await load();
    const P = cancel ? { kind: 'cancel', x: derive(V) } : planOf();
    if (S.amt !== typed) throw new Error('The amount changed. Nothing was sent.');
    if (!cancel && !P.ok) { say(`<span class="err">${esc(P.hint || 'That is no longer possible.')} Nothing was sent; the figures above are current.</span>`); return; }
    const x = P.x, owner = from;
    // A borrow is for the fee on the screen: a fee read now that is higher stops it, and the fee shown is the most the vault may take.
    if (P.kind === 'borrow' && P.feeBps > shown.feeBps) { say(`<span class="err">The borrow fee is now ${esc(feeText(P.feeBps))}. Nothing was sent; the figures above are current.</span>`); return; }
    let data, acc = {};
    if (cancel) data = encCancel(owner);
    else if (P.kind === 'deposit') {
      acc = await withAccess({ V, token: x.s.tac, amount: P.amount, allowance: x.d.tacAllow ?? 0n, from, make: (p) => (p ? encMulticall([encPermit('permitTac', p), encDeposit(P.amount)]) : encDeposit(P.amount)) });
    } else if (P.kind === 'borrow') acc = { data: encBorrow(P.amount, shown.feeBps) };
    else if (P.kind === 'repay') {
      acc = await withAccess({ V, token: x.s.synth, amount: P.paid, allowance: x.d.synAllow ?? 0n, from, make: (p) => { const call = encRepay(owner, P.amount); return p ? encMulticall([encPermit('permitSynth', p), call]) : call; } });
    } else acc = { data: encWithdraw(P.amount) };
    data ||= acc.data;
    say('Checking it first…');
    let sim = await simulate(V.addr, data, from);
    // A node that is a block behind has not seen the approval yet: asked again shortly.
    for (let i = 0; i < 3 && !sim.ok && acc.approved && refusal(sim.e) === 'access'; i++) { await new Promise((r) => setTimeout(r, 1500)); sim = await simulate(V.addr, data, from); }
    if (!sim.ok) { say(`<span class="err">${esc(failText(x, P.kind, sim.e))}</span>`); load().then(renderAll).catch(() => {}); return; }
    say('Confirm the transaction in your wallet.');
    const hash = await wallet.sendTx({ to: V.addr, data, from });
    say(`Sent ${txLink(hash)}. Waiting for it to land…`);
    const rc = await wallet.receipt(hash);
    if (rc.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`);
    S.amt = ''; $('#amt').value = '';
    await load().catch(() => {});
    const x2 = derive(V), said = { deposit: `Deposited ${tac(P.amount ?? 0n)} TAC.`, borrow: `Borrowed ${P.amount != null ? syn(x2, P.amount) : ''} ${x2.sym}. You owe ${syn(x2, x2.me.debt)}.`, repay: x2.me.debt === 0n ? `Repaid. Nothing owed now.` : `Repaid. You owe ${syn(x2, x2.me.debt)} ${x2.sym}.`, withdraw: 'Withdrawn.', cancel: 'The auction has ended.' }[P.kind];
    say(`<span class="ok">${esc(said)}</span> ${txLink(hash)}`);
    setTimeout(() => { if (!S.busy) load().then(renderAll).catch(() => {}); }, 5000);                 // a node a little behind has caught up
  } catch (e) {
    const x = derive(V);
    say(`<span class="err">${e.sim ? esc(failText(x, S.t, e.sim)) : errText(e)}</span>`);
  } finally { S.busy = false; lockAll(); renderAll(); }
}
const lockAll = () => { renderPick(); };

// ── drawing ──
function renderAll() {
  const live = VS.length > 0;
  $('#soon').hidden = live; $('#app').hidden = !live; $('#wallet-chip').hidden = !live;
  $('#sub').hidden = !live;
  if (!live) return;
  renderChip(); renderPick(); renderBoard(); renderPos(); renderFeed(); renderTicket(); renderHow();
}

// ── the price feed ──
// Lending needs every ten-minute price of the last eight hours from both venues. When they have not been recorded (a keeper stopped, or none runs), anyone can
// record them from here: the page builds each record from an archive node and sends them ten at a time through Multicall3, each batch tested first.
// The headers and proofs of blocks hours old come from many nodes, each asked in turn, so that none is asked for more than a few of them; one that says it is busy rests.
const busyNote = (ms) => { if (F.busy) setFeed(`The public nodes are busy. Trying again in ${Math.ceil(ms / 1000)} s…`); };
const feed = makeFeed({
  rpc,
  headerRpc: makeRpc([walletNode({ prefer: true }), ...HISTORY], { spread: true, onWait: busyNote }),
  proofRpc: makeRpc([walletNode({ prefer: true }), ...ARCHIVE], { spread: true, onWait: busyNote }),
});
const F = { by: {}, busy: false, note: '', bad: false, gas: null, at: 0, stop: null };   // by: what each vault's venues have recorded (vaults on one oracle share a read); stop: ends the wait for the wallet
const ALREADY = '0x103b4afe';                                                         // the oracle's AlreadyRecorded
const WALLET_HINT_MS = 20e3;                                                          // how long the wallet may stay quiet before the person is offered a way out
class StopWaiting extends Error { constructor() { super('Stopped waiting. If your wallet still shows the request, reject it there, then record again.'); } }
const feedOf = (V) => (V ? F.by[V.key] || null : null);
const oracleOf = (V) => V.oracle || V.addr;
// A read of the venues, kept for every vault that prices from the same oracle.
const keepFeed = (V, st) => { for (const m of VS) if (oracleOf(m) === oracleOf(V)) F.by[m.key] = st; };
const VENUE = ['Precision pool', 'Tacit pool'];
const setFeed = (note, bad = false) => { F.note = note; F.bad = bad; const el = $('#feed-status'); if (el) { el.innerHTML = note; el.className = `status${bad ? ' err' : ''}`; } };
async function loadFeed() {
  if (!VS.length || F.busy) return;
  const firsts = [...new Map(VS.map((v) => [oracleOf(v), v])).values()];
  await Promise.all(firsts.map(async (V) => { try { keepFeed(V, await feed.read(V.addr)); F.at = now(); } catch (e) { console.warn('price feed read:', e?.message || e); } }));
  try { F.gas = BigInt(await rpc('eth_gasPrice', [])); } catch { /* the cost line is only a convenience */ }
  F.tried = true;                                                  // a vault without a read after this one could not be read
  renderFeed();
  renderBoard();                                                   // the board says what the feed lacks, so it follows the feed
}
function renderFeed() {
  const el = $('#feed'), st = feedOf(cur());
  if (!VS.length || !st || (st.ready && !F.busy && !F.note)) { el.hidden = true; return; }       // up to date, nothing to say: the board already says lending is open
  el.hidden = false;
  const cost = F.gas != null && st.missing ? `, for about ${(Number(BigInt(st.missing * RECORD_GAS) * F.gas) / 1e18).toFixed(4)} ETH` : '';
  const rows = st.venues.map((v, i) => `<div class="kv"><span>${esc(VENUE[i] || `Venue ${i + 1}`)}</span><b class="num">${v.counted} of ${v.points}</b></div>`).join('');
  setHtml(el, `<p class="eyebrow" id="feed-h"><span>Price feed</span><span class="who">${st.ready ? 'up to date' : `${st.missing} to record`}</span></p>
    <div class="rows flat">${rows}</div>
    ${st.missing ? `<p class="note">Anyone can record the ${st.missing} missing price${st.missing === 1 ? '' : 's'}${cost}.</p>
    <button class="btn" id="feed-go" type="button"${F.busy ? ' disabled' : ''}>${F.busy ? 'Recording…' : W.account ? `Record ${st.missing} price${st.missing === 1 ? '' : 's'}` : 'Connect wallet'}</button>` : ''}
    <div class="status${F.bad ? ' err' : ''}" id="feed-status" role="status">${F.note}</div>`);
  const go = $('#feed-go');
  if (go) go.onclick = pokeFeed;
}
// A wallet that never answers (a request it did not show, a phone nobody picked up) must not lock the panel for good: after a while the person can stop waiting.
// What the wallet was asked stays with the wallet; if it is confirmed there later, it lands and the next read counts it.
function askWallet(send, round) {
  const hint = setTimeout(() => setFeed(`Waiting for your wallet to confirm batch ${round}. Open it to answer, or <button class="linkbtn" type="button" data-feed-stop>stop waiting</button>.`), WALLET_HINT_MS);
  const stopped = new Promise((_, no) => { F.stop = () => no(new StopWaiting()); });
  return Promise.race([send(), stopped]).finally(() => { clearTimeout(hint); F.stop = null; });
}
async function pokeFeed() {
  if (F.busy) return;
  if (!W.account) { await connectWallet(); return; }
  F.busy = true; renderFeed();
  try {
    for (let round = 1; round <= 12; round++) {
      const V = cur(), st = await feed.read(V.addr);
      keepFeed(V, st);
      renderFeed();                                                  // the counts follow each batch
      if (!st.missing) break;
      const part = feed.nextBatch(st);
      setFeed(`Building ${part.length} record${part.length === 1 ? '' : 's'} (batch ${round})…`);
      const recs = await feed.build(part);
      const pack = () => encBatch(recs.map((r) => ({ to: r.to, data: r.data })));
      let data = pack(), sim = await simulate(MULTICALL3, data, W.account);
      // A record that fails is one someone else has recorded in the meantime (read again without it) or one a node gave a wrong proof for: that one is built again, from the
      // next node and not the one that failed, twice at most.
      for (let again = 1; !sim.ok && again <= 2; again++) {
        const each = await Promise.all(recs.map((r) => simulate(r.to, r.data, W.account)));
        const bad = each.flatMap((r, i) => (!r.ok && !String(r.e?.data || '').startsWith(ALREADY) ? [i] : []));
        if (!bad.length) break;
        setFeed(`Building ${bad.length} record${bad.length === 1 ? '' : 's'} again…`);
        const fresh = await Promise.all(bad.map((i) => feed.buildRecord(...part[i], undefined, again)));
        bad.forEach((i, j) => { recs[i] = fresh[j]; });
        data = pack(); sim = await simulate(MULTICALL3, data, W.account);
      }
      if (!sim.ok) {
        const each = await Promise.all(recs.map((r) => simulate(r.to, r.data, W.account)));
        const bad = each.find((r) => !r.ok && !String(r.e?.data || '').startsWith(ALREADY));
        if (bad) throw new Error(`A record would fail (${String(bad.e?.message || 'refused').slice(0, 120)}). Nothing was sent.`);
        setFeed('Someone else is recording too; reading again…');
        continue;
      }
      setFeed(`Confirm batch ${round} of ${round - 1 + Math.ceil(st.missing / PER_TX)} in your wallet (${part.length} record${part.length === 1 ? '' : 's'}).`);
      const hash = await askWallet(() => wallet.sendTx({ to: MULTICALL3, data, from: W.account }), round);
      setFeed(`Sent ${txLink(hash)}. Waiting for it to land…`);
      const rc = await wallet.receipt(hash);
      if (rc.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing more was sent.`);
      setFeed(`Batch ${round} recorded ${txLink(hash)}.`);
    }
    F.busy = false; await loadFeed();
    setFeed(feedOf(cur())?.ready ? 'The price feed is up to date.' : 'Recorded what could be. Some newer prices still need adding: record again.');
  } catch (e) {
    F.busy = false;
    setFeed(errText(e), !(e instanceof UserStopped || e instanceof StopWaiting));
  } finally { F.busy = false; await loadFeed(); refresh(); }
}

// ── the address bar ──
// #v= the vault, #t= the action, #a= an account to look at (read only). Anything else in it (the test addresses) stays.
function readHash() {
  const p = params(), v = p.get('v'), t = p.get('t'), a = p.get('a');
  if (v && VS.some((x) => x.key === v)) S.v = v;
  if (ACTS.some(([k]) => k === t)) S.t = t;
  S.view = ADDR.test(a || '') ? a : null;
}
function keepInHash() {
  const p = params();
  if (VS.length > 1 && S.v !== VS[0].key) p.set('v', S.v); else p.delete('v');
  if (S.t !== 'deposit') p.set('t', S.t); else p.delete('t');
  const h = p.toString() ? `#${p}` : '';
  if (h !== location.hash) history.replaceState(null, '', location.pathname + location.search + h);
}
const refresh = () => load().catch((e) => { console.warn('vault read:', e?.message || e); if (!S.loaded) S.failed = true; }).then(renderAll);

// ── wiring ──
$('#pick').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b || S.busy || b.dataset.v === S.v) return; S.v = b.dataset.v; S.amt = ''; $('#amt').value = ''; say('', ''); keepInHash(); renderAll(); });
$('#acts').addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (!b || S.busy || b.dataset.t === S.t) return; S.t = b.dataset.t; S.amt = ''; $('#amt').value = ''; say('', ''); keepInHash(); renderTicket(); });
$('#amt').addEventListener('input', (e) => { S.amt = e.target.value; if ($('#status').dataset.kind === 'trade') say('', ''); renderTicket(); });
$('#amt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#go').disabled) $('#go').click(); });
$('#chips').addEventListener('click', (e) => { const b = e.target.closest('[data-pct]'); if (b && !S.busy) setAmount(Number(b.dataset.pct)); });
$('#bal').addEventListener('click', () => { if (!S.busy) setAmount(100); });
$('#go').addEventListener('click', () => run());
// What a prompt fills: the deposit box, with the amount to add.
document.addEventListener('click', (e) => {
  const f = e.target.closest('[data-fill]');
  if (f && !S.busy) { S.t = 'deposit'; S.amt = f.dataset.fill; $('#amt').value = S.amt; say('', ''); keepInHash(); renderTicket(); $('#ticket').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); return; }
  if (e.target.closest('[data-more]')) { S.more = !S.more; try { localStorage.setItem(MORE_KEY, S.more ? '1' : '0'); } catch { /* storage is a convenience */ } renderBoard(); return; }
  if (e.target.closest('[data-refresh]')) { if (!S.busy) { refresh(); loadFeed(); } return; }
  if (e.target.closest('[data-feed-stop]')) { F.stop?.(); return; }
  const feedLink = e.target.closest('[data-tofeed]');
  if (feedLink) { e.preventDefault(); $('#feed')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }   // the hash carries the page's own state, so this scrolls rather than links
  if (e.target.closest('[data-connect]')) { connectWallet(); return; }
  if (e.target.closest('[data-cancel]')) { run('cancel'); return; }
  const m = e.target.closest('[data-mine]');
  if (m) { e.preventDefault(); const p = params(); p.delete('a'); history.replaceState(null, '', location.pathname + (p.toString() ? `#${p}` : '')); S.view = null; refresh(); }
});
addEventListener('hashchange', () => { readHash(); refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.busy) refresh(); });   // a tab left open reads the vault again when it is looked at
wallet.onChange(() => { renderChip(); if (S.busy) return; if (!S.view) { refresh(); } else renderAll(); });   // a transaction in flight keeps the account it was made for: the wallet module refuses to send for another
wallet.restore().catch(() => {});

// The countdown of an auction's owner-only window runs on the chain's clock.
setInterval(() => {
  const els = document.querySelectorAll('[data-cd]');
  els.forEach((el) => { const left = Number(el.dataset.cd) - chainNow(); el.textContent = M.clock(left); if (left <= 0 && !S.busy) renderPos(); });
  document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = agoText(now() - Number(el.dataset.ago)); });
}, 1000);
setInterval(() => { if (!document.hidden && !S.busy) refresh(); }, 30e3);
setInterval(() => { if (!document.hidden && !S.busy && !F.busy) loadFeed(); }, 60e3);

readHash();
renderAll();
if (VS.length) refresh().then(() => loadFeed());                                                    // the feed is read for the oracle each vault names, which the first read has found
