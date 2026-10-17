// The relay page: what the relay earned and spent over the last days, how much of its fee income went to the TAC buyback, what the buyback
// has bought, and where wrap tips went. One read of the API's /relay/economics; nothing is kept in the browser. Wallet balances are not
// shown here: this page is about flows, and the operator's own page (/splitter/) is where balances are watched.
//
// Two things a visitor can do with a wallet: send a settle the relay has proved and holds for a sender (#open, open.js), and pay for proofs by
// sending PROVE, or ETH swapped to PROVE, to the prover account (#prove, prove.js). Only the visitor's own balances are read for those.
import { makeConnect } from '/trade/connect.js?cb=b0beb322';
import { mountOpen } from '/relay/open.js?cb=04b9888a';
import { mountProve } from '/relay/prove.js?cb=2255ef3f';

const API = 'https://api.tacit.finance';
const SPLITTER_LABELS = new Map([
  ['0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', 'Prover account'],
  ['0x7a0f0511e1dcf399c2f7bbe8414b6a0d1abc4331', 'Settle wallet'],
  ['0x6919cbef0e70affa02ae02c86c532a137154f250', 'TAC buyback'],
  ['0x006cd14f36f65ecbb29b2519ccbe63a0dc8549f2', 'Ops multisig'],
]);
const nameOf = (a) => SPLITTER_LABELS.get(String(a).toLowerCase()) || `${String(a).slice(0, 8)}…${String(a).slice(-4)}`;

const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : v); }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
const mount = (el, ...kids) => el.replaceChildren(...kids.flat().filter((x) => x != null && x !== false));
const scan = (path, text) => h('a', { href: `https://etherscan.io/${path}`, target: '_blank', rel: 'noopener' }, text);
const num = (x, dp = 2) => Number(x).toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: 0 });
const eth = (x) => (x == null ? '–' : x === 0 ? '0' : x < 0.0001 ? x.toPrecision(2) : num(x, 4));
const usd = (x) => (x == null ? '–' : `$${num(x, x < 10 ? 2 : 0)}`);
const ago = (blocks) => { const s = blocks * 12; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} minutes ago` : s < 86400 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`; };
const kv = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('b', { class: 'num' }, v));

function paintBuyback(j) {
  const b = j.chain && j.chain.buyback, l = j.ledger, cfg = (l && l.cfg) || {}, week = l && l.week;
  if (!b) { mount($('#p-buyback'), h('p', { class: 'eyebrow' }, 'TAC buyback'), h('p', { class: 'mute' }, 'The chain did not answer just now. Try again in a moment.')); return; }
  const pct = cfg.buybackBps ? `${num(cfg.buybackBps / 100, 1)}%` : null;
  mount($('#p-buyback'),
    h('p', { class: 'eyebrow' }, h('span', {}, 'TAC buyback'), scan(`address/${b.address}`, `${b.address.slice(0, 8)}…${b.address.slice(-4)}`)),
    h('p', { class: 'big num' }, num(b.tacBought, b.tacBought < 100 ? 2 : b.tacBought < 1000 ? 1 : 0), h('small', {}, 'TAC bought')),
    h('p', { class: 'note' }, `${b.buys} ${b.buys === 1 ? 'buy' : 'buys'} for ${eth(b.ethSpent)} ETH${b.lastBuyBlock && j.chain.head ? `, the last ${ago(j.chain.head - b.lastBuyBlock)}` : ''}. The TAC goes straight to the protocol reserve.`),
    b.complete ? null : h('p', { class: 'stale' }, 'Still reading the contract’s full history; the figures above can only grow.'),
    h('div', { class: 'rows' },
      kv('Commitment', pct ? `${pct} of the relay’s fee income` : 'not set'),
      week ? kv(`Sent in the last ${week.days} ${week.days === 1 ? 'day' : 'days'}`, `${eth(week.buybackEth)} ETH`) : null,
      l && l.owedEth > 0 ? kv('Carried to the next pass', `${eth(l.owedEth)} ETH`) : null,
      kv('Waiting in the contract', `${eth(b.ethHeld)} ETH`)),
    h('p', { class: 'note' }, 'The relay keeps a small float for its next settles, so a share it cannot spare yet is carried and paid as soon as it can. The contract buys at most once every six hours, in small amounts, so ETH waits there between buys.'));
}

function paintFees(j) {
  const l = j.ledger, el = $('#p-fees');
  if (!l) { mount(el, h('p', { class: 'eyebrow' }, 'Fee income'), h('p', { class: 'mute' }, 'The relay has not reported its books yet.')); return; }
  const w = l.week, f = w.feeUsd;
  mount(el,
    h('p', { class: 'eyebrow' }, h('span', {}, `Fee income, last ${w.days} ${w.days === 1 ? 'day' : 'days'}`)),
    h('p', { class: 'big num' }, usd(f.convertible), h('small', {}, 'in ETH and converted tokens')),
    h('p', { class: 'note' }, 'Fees paid in TAC are kept, not sold, and are not counted here.'),
    h('div', { class: 'rows' },
      kv('Settled for a fee', num(w.priced, 0)),
      kv('Settled with no fee', num(w.unpriced, 0)),
      kv('Proved for the sender to settle', num(w.proveOnly, 0)),
      kv('Paid in ETH', usd(f.eth)),
      kv('Paid in converted tokens', usd(f.converted))),
    l.recent.length ? h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Day', 'Settled', 'Fees', 'Gas', 'Buyback'].map((t) => h('th', {}, t)))),
      h('tbody', {}, [...l.recent].reverse().map((d) => h('tr', {}, h('td', {}, d.date.slice(5)), h('td', {}, num(d.settled, 0)), h('td', {}, usd(d.feeUsd.convertible ?? d.feeUsd.eth + d.feeUsd.converted)), h('td', {}, `${eth(d.gasEth)} ETH`), h('td', {}, `${eth(d.buybackEth)} ETH`)))))) : null,
    h('p', { class: 'stale' }, `Counted from ${new Date(l.since).toISOString().slice(0, 16).replace('T', ' ')} UTC${l.stale ? ' (the relay has not reported for a few minutes)' : ''}.`));
}

const CLASS_WORDS = { onboard: 'Bridge and cBTC mints', farm: 'Farm harvests and unbonds', wrap: 'Wraps with no tip', other: 'Other requests with no fee' };
function sponsorshipRows(j) {
  const sp = j.sponsorship;
  if (!sp) return null;
  return h('div', {},
    h('p', { class: 'eyebrow' }, 'Settles the relay pays for today'),
    h('div', { class: 'rows' }, Object.entries(CLASS_WORDS).map(([k, label]) => { const c = sp.classes[k]; return kv(label, c.cap == null ? `${c.used} so far` : `${c.used} of ${c.cap}`); }),
      sp.prove ? kv('Proofs for requests the sender settles', sp.prove.cap == null ? `${sp.prove.used} so far` : `${sp.prove.used} of ${sp.prove.cap}${sp.prove.perClient ? `, up to ${sp.prove.perClient} per sender` : ''}`) : null),
    h('p', { class: 'note' }, 'Requests that carry a fee, or a tip with the wrap, are not counted. Past a limit the relay still proves the request, and it is settled from the sender’s own account instead; past the proofs’ limit a request goes through the relay with a fee, or is proved locally.'));
}

function paintCosts(j) {
  const l = j.ledger, el = $('#p-costs'), px = j.prices || {};
  if (!l) { mount(el, h('p', { class: 'eyebrow' }, 'What it costs'), h('p', { class: 'mute' }, 'The relay has not reported its books yet.')); return; }
  const w = l.week, gasUsd = px.ethUsd ? w.gasEth * px.ethUsd : null, proveUsd = px.proveUsd ? w.proveIn * px.proveUsd : null;
  mount(el,
    h('p', { class: 'eyebrow' }, `What it costs, last ${w.days} ${w.days === 1 ? 'day' : 'days'}`),
    h('div', { class: 'rows' },
      kv('Gas paid to settle', h('span', {}, `${eth(w.gasEth)} ETH`, gasUsd != null ? h('small', { class: 'mute' }, ` · ${usd(gasUsd)}`) : null)),
      kv('PROVE put into the prover', h('span', {}, `${num(w.proveIn, 1)} PROVE`, proveUsd != null ? h('small', { class: 'mute' }, ` · ${usd(proveUsd)}`) : null))),
    h('p', { class: 'note' }, 'Keeping Bitcoin’s state current on Ethereum (headers and attests) is paid from the same wallets and is not in these figures. Fees pay part of all this; the team funds the rest.'),
    sponsorshipRows(j));
}

function paintTips(j) {
  const t = j.chain && j.chain.tips, sp = j.chain && j.chain.splitter, el = $('#p-tips');
  // Said as it is set up now: a splitter is only mentioned once there is one.
  $('#flow-tips').textContent = sp && sp.shares ? 'A wrap’s tip pays for settling it. Tacit’s own pages send it to a splitter, which sends it on to the wallets that keep Bitcoin’s state current and settle requests, and to the buyback; a page that pays the ops multisig directly is counted the same.' : 'A wrap’s tip pays for settling it. It goes to the ops multisig, which funds the relay’s wallets.';
  mount(el,
    h('p', { class: 'eyebrow' }, 'Wrap tips, last 30 days'),
    !t ? h('p', { class: 'mute' }, 'Reading…')
      : h('div', {},
        h('p', { class: 'big num' }, num(t.wraps, 0), h('small', {}, `wraps tipped, ${eth(t.eth)} ETH`)),
        t.byRecipient.length ? h('div', { class: 'rows' }, t.byRecipient.map((r) => kv(`To ${nameOf(r.to)}`, `${eth(r.eth)} ETH`))) : null,
        t.complete ? null : h('p', { class: 'stale' }, 'Read in part: the figures can only grow.')),
    sp && sp.shares ? h('div', {},
      h('p', { class: 'note' }, 'A splitter sends what tips it receives on to:'),
      h('div', { class: 'rows' }, sp.shares.map((s) => kv(nameOf(s.to), `${s.percent}%`))),
      h('p', { class: 'note' }, scan(`address/${sp.address}`, 'The splitter'), ' can be changed by the ops multisig, and anyone can send on what it holds.')) : null);
}

async function load() {
  let j;
  try { j = await (await fetch(`${API}/relay/economics`, { cache: 'no-store', signal: AbortSignal.timeout(20000) })).json(); }
  catch { for (const id of ['#p-buyback', '#p-fees', '#p-costs', '#p-tips']) mount($(id), h('p', { class: 'mute' }, 'Could not read the relay just now. Try again in a moment.')); return; }
  paintBuyback(j); paintFees(j); paintCosts(j); paintTips(j);
}
load();
setInterval(load, 120000);

// ── the wallet, and what it can do here ──
// The wallet's notices go to the status line of the panel last used.
let sayTo = '#open-status', board = null, prove = null;
const sayIn = (sel) => (html, err = false) => { sayTo = sel; const s = $(sel); if (s) s.innerHTML = !html ? '' : err ? `<span class="err">${html}</span>` : html; };
const connect = makeConnect({
  describe: 'Send proved settles, and pay for proofs',
  busy: () => !!(board?.busy() || prove?.busy()),
  say: (html, err) => sayIn(sayTo)(html, err),
  onChange: () => { board?.render(); prove?.onAccount(); },
});
const { wallet, W } = connect;
board = mountOpen({ el: $('#open'), wallet, W, connect, say: sayIn('#open-status') });
prove = mountProve({ el: $('#prove'), wallet, W, connect, say: sayIn('#pv-status') });
// /relay/#open and /relay/#prove: the panel is brought into view again once the board above it has its rows.
if (/^#(open|prove)$/.test(location.hash)) board.ready.then(() => $(location.hash)?.scrollIntoView({ block: 'start' }));
