// tacit.finance/vault: borrow TAC Dollar or TAC Ether against TAC.
//
// Every figure here is read from the vault contracts (one Multicall3 batch for both vaults and the account), and the page's arithmetic is the
// contract's own (math.js): what it shows as the room to borrow, the limit for this account, the amount to add to reach 400% and the price a vault is
// liquidated at are the numbers the contract will test, rounded the safe way. A person's vault is the chain's, not this browser's: nothing about it
// is kept here, so the same account shows the same vault anywhere. The wallet never gives up a key; each action is tested once with eth_call before it is sent.
import { DEPLOYMENTS } from '/vault/deployments.js?cb=5ea12fed';
import * as M from '/vault/math.js?cb=8726aaa5';
import {
  makeRpc, makeReader, staticCalls, parseStatic, dynamicCalls, parseDynamic, timestampCall, refusal, decString, SEL, wordAt, addrWord,
  encDeposit, encWithdraw, encBorrow, encRepay, encCancel, encApprove, encPermit, encMulticall,
} from '/vault/chain.js?cb=4c85c232';
import { makeWallet, UserStopped } from '/trade/wallet.js?cb=0cba8a63';
import { overlay } from '/trade/sheet.js?cb=84cda8f2';
import { announceWalletConnect, wcSheets, WC_PROJECT_ID } from '/walletconnect.js?cb=14fe38b6';

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

const S = { v: VS[0]?.key, t: 'deposit', amt: '', view: null, busy: false, seq: 0, chainT: 0, chainAt: 0, loaded: false, failed: false };
const rpc = makeRpc();
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
const sameAddr = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
// The account whose vault is shown: the one in the address bar (read only), else the connected wallet's.
const who = () => S.view || W.account || null;
const canAct = () => !!W.account && sameAddr(W.account, who());
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
  if (!list.length) { say('No wallet was found in this browser. Open this page in a wallet app\'s browser, or use tacit.finance.'); return; }
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
  for (const v of live) { v.tac = v.s.tac; v.synth = v.s.synth; }
  const calls = [timestampCall(), ...live.flatMap((v) => dynamicCalls(v, who0))];
  const res = await batch(calls);
  if (my !== S.seq || who0 !== who()) return;                                                       // the account changed while this was read
  const ts = res[0] ? Number(wordAt(res[0], 0)) : 0;
  if (ts) { S.chainT = ts; S.chainAt = now(); }
  let i = 1;
  for (const v of live) { const n = dynamicCalls(v, who0).length; v.d = parseDynamic(v, who0, res.slice(i, i + n)); v.d.who = who0; i += n; }
  S.loaded = VS.some((v) => v.d); S.failed = !S.loaded;
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
  $('#pick').hidden = VS.length < 2;
  $('#pick').innerHTML = VS.map((v) => `<button type="button" data-v="${v.key}" aria-pressed="${v.key === S.v}"${S.busy ? ' disabled' : ''}>${esc(KIND[v.key].name)}<small>${esc(KIND[v.key].sym)}</small></button>`).join('');
}
const setHtml = (el, h) => { if (el.__h !== h) { el.__h = h; el.innerHTML = h; } };
function renderCap() {
  const V = cur(), x = V && derive(V), el = $('#cap');
  if (!x) { setHtml(el, `<p class="eyebrow" id="cap-h">Room to borrow now</p><p class="room off">${S.failed ? '—' : '…'}</p>${S.failed ? '<p class="paused">The vaults could not be read just now. Try again in a moment.</p>' : ''}`); return; }
  const head = `<p class="eyebrow" id="cap-h">${esc(x.k.name)} · room to borrow now</p>`;
  if (x.paused) {
    setHtml(el, `${head}<p class="room off">—</p><p class="paused">Lending is paused until prices are recorded. You can still add TAC and repay.</p>${x.d.totalDebt != null ? `<div class="rows"><div class="kv"><span>Borrowed so far</span><b class="num">${esc(syn(x, x.d.totalDebt))} ${esc(x.sym)}</b></div></div>` : ''}`);
    return;
  }
  setHtml(el, `${head}<p class="room num">${esc(syn(x, x.room))}<small>${esc(x.sym)}</small></p>
    <div class="rows"><div class="kv"><span>Borrowed so far</span><b class="num">${esc(syn(x, x.d.totalDebt))} ${esc(x.sym)}</b></div><div class="kv"><span>Fee when you borrow</span><b class="num">${esc(feeText(x.d.feeBps))}</b></div></div>
    <p class="note">Room grows as liquidity is added to the TAC pools. <a href="/trade/tac/#farm">Add liquidity</a></p>`);
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
  if (x.zone === 'liquidation') return `Under ${pctOf(x.s.liq)}: this vault can be sold in an auction.`;
  if (x.zone === 'redemption') return `From ${pctOf(x.s.liq)} to ${pctOf(x.safe)}, a holder of ${esc(x.sym)} can swap it for your TAC at its price, less a ${feeText(x.s.redemptionFee)} to ${feeText(x.s.redemptionFee * 4n)} fee. Your debt falls by the same amount.`;
  return `From ${pctOf(x.safe)} up, nothing can be redeemed or sold against this vault.`;
}
function auctionBox(x) {
  const left = x.me.auctionStart + x.s.ownerWindow - chainNow();
  const owner = left > 0 ? `Only the owner can bid for <b data-cd="${x.me.auctionStart + x.s.ownerWindow}">${M.clock(left)}</b>, then anyone.` : 'Anyone can bid now.';
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
    rows.push(`<div class="kv"><span>Liquidation price</span><b class="num">${esc(priceText(x, x.liqPrice, 'up'))}<small>${below > 0 ? `${below}% below TAC's price` : 'TAC is at or below it'}</small></b></div>`);
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
    if (x.paused) { P.cta = 'Lending is paused'; P.hint = 'Lending is paused until prices are recorded.'; return P; }
    if (none) { P.cta = 'Enter an amount'; return P; }
    const c = M.checkBorrow({ amount: amt, collateral: m.collateral, debt: m.debt, pB: d.pB, mint: x.s.mint, feeBps: d.feeBps, room: x.room, minDebt: x.s.minDebt });
    P.cta = `Borrow ${sym}`;
    if (!c.ok) {
      P.err = true;
      if (c.why === 'min') P.hint = `A vault's debt starts at ${syn(x, x.s.minDebt)} ${sym}. Borrow at least ${syn(x, M.ceilTo(c.least, x.k.dp))} ${sym}.`;
      else if (c.why === 'own') {
        const add = M.addToBorrow({ collateral: m.collateral, owe: c.owe, pB: d.pB, mint: x.s.mint });
        P.hint = `You can borrow up to ${syn(x, c.limit)} ${sym} now${add > 0n ? `, or ${fill(add)} to borrow this` : ''}.`;
      } else P.hint = `The market has room for ${syn(x, c.limit)} ${sym} right now.`;
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
      if (c.why === 'balance') P.hint = `You hold ${syn(x, bal)} ${sym}${bal < m.debt ? `, ${syn(x, m.debt)} are owed${x.rep.max > 0n ? `. You can repay up to ${syn(x, x.rep.max)}` : ''}` : ''}.`;
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
  limit: (x) => `That would take the vault under ${pctOf(x.s.mint)}.`, room: () => 'The market has less room to borrow than that right now.', auction: () => 'This vault is in an auction.',
  amount: (x) => `That amount is not accepted: a vault's debt is zero or at least ${syn(x, x.s.minDebt)} ${x.sym}.`, fee: () => 'The borrow fee changed.', paused: () => 'Lending is paused until prices are recorded.',
  noauction: () => 'There is no auction on this vault.', unhealthy: () => 'The vault has not recovered yet.', healthy: () => 'The vault is healthy.', ownerwindow: () => 'Only the owner can bid for now.',
  access: (x, kind) => `The ${kind === 'repay' ? x.sym : 'TAC'} was not available to the vault.`, balance: (x, kind) => `Not enough ${kind === 'repay' ? x.sym : 'TAC'}.`,
};
const failText = (x, kind, e) => { const w = refusal(e); return `${w && WHY[w] ? WHY[w](x, kind) : 'This would fail right now.'} Nothing was sent; the figures above are current.`; };
const errText = (e) => esc(e instanceof UserStopped ? e.message : String(e?.message || e).slice(0, 220));

// The token the call spends, made available to the vault: a permit signed in the wallet (no gas, one transaction) where there is no allowance,
// else an exact approval sent first. A permit the vault does not accept falls back to the approval.
async function withAccess({ V, token, amount, allowance, from, make }) {
  if (allowance >= amount) return { data: make(null) };
  try {
    say('Sign the permit in your wallet. It costs no gas.');
    const [name, nonce] = await Promise.all([ethCall(token, SEL.name), ethCall(token, SEL.nonces + addrWord(from))]);
    const dl = chainDeadline(1200);
    const sig = await wallet.signPermit({ token, name: decString(name), spender: V.addr, value: amount, deadline: dl, nonce: wordAt(nonce, 0), owner: from });
    const data = make({ value: amount, deadline: dl, ...sig });
    say('Testing it first…');
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
    say('Testing it first…');
    let sim = await simulate(V.addr, data, from);
    // A node that is a block behind has not seen the approval yet: asked again shortly.
    for (let i = 0; i < 3 && !sim.ok && acc.approved && refusal(sim.e) === 'access'; i++) { await new Promise((r) => setTimeout(r, 1500)); sim = await simulate(V.addr, data, from); }
    if (!sim.ok) { say(`<span class="err">${esc(failText(x, P.kind, sim.e))}</span>`); load().then(renderAll).catch(() => {}); return; }
    say('Confirm the transaction in your wallet.');
    const hash = await wallet.sendTx({ to: V.addr, data, from });
    say(`Sent ${txLink(hash)}. Waiting for it to land…`);
    const rc = await wallet.receipt(hash);
    if (rc.status !== '0x1') throw new Error(`The transaction failed on chain (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`);
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
  renderChip(); renderPick(); renderCap(); renderPos(); renderTicket();
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
}, 1000);
setInterval(() => { if (!document.hidden && !S.busy) refresh(); }, 30e3);

readHash();
renderAll();
if (VS.length) refresh();
