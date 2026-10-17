// What the relay earns, spends and gives to the TAC buyback, for the public page (GET /relay/economics). Three sources, none of them private:
//   - the settle relay's own books (worker-relay/src/lib/income-ledger.js), which ride its heartbeat, checked here for shape before they are kept;
//   - what is on chain: the two relay wallets' balances, the buyback contract's balance and every buy it has made, the wrap tips of the
//     last thirty days, and a splitter if one is set;
//   - nothing else. No job, address of a user, amount of a user's, or reason for a price is in it.
// The chain reads take an injected `rpc(method, params)` that returns the result or null, so the tests run with none.

import { decodeShares, percent } from '../../dapp/splitter/abi.js';

export const TOPIC = {
  bought: '0x8089060226a94c767e83bd34cc64c57b8d2b05e3c0d6e716b3e56a516e217a37',          // Bought(uint8,uint256,uint256)
  wrappedWithTip: '0xf2ca716f2e7369f22bd6309917a4043cb9811e4b21ecb0c349a5a47fd1b7a042',  // WrappedWithTip(bytes32,uint256,uint256,address)
};
export const DEFAULTS = {
  settle: '0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331',
  relay: '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7',
  prove: '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29',
  buyback: '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250',
  tipForwarder: '0x000000D218B03db5837943b0b05DeA2965AE956e',
  buybackFromBlock: 26_000_000,
};
const SEL = { balanceOf: '0x70a08231', shares: '0x03314efa' };
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const word = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hexNum = (h) => parseInt(String(h), 16);
const eth = (wei) => Number(BigInt(wei) / 10n ** 9n) / 1e9;

// ── the heartbeat's ledger, copied field by field: anything not named here is dropped ──
const DAY_NUM = ['settled', 'priced', 'unpriced', 'proveOnly', 'gasEth', 'proveIn', 'buybackEth', 'splitterSends'];
const FEE_KINDS = ['eth', 'converted', 'tac', 'other'];
const finite = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 1e12 ? x : 0);
export function sanitizeLedger(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  const out = { since: typeof l.since === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(l.since) ? l.since : null, owedEth: finite(l.owedEth), cfg: {}, days: {} };
  const c = l.cfg && typeof l.cfg === 'object' ? l.cfg : {};
  for (const k of ['buybackBps', 'buybackKeepEth', 'buybackMinSendEth', 'buybackSurplusBps', 'replenishMin']) out.cfg[k] = finite(c[k]);
  for (const k of ['splitter', 'buyback']) out.cfg[k] = isAddr(c[k]) ? c[k] : null;
  const days = l.days && typeof l.days === 'object' ? Object.keys(l.days).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-10) : [];
  for (const d of days) {
    const b = l.days[d] || {}, row = {};
    for (const k of DAY_NUM) row[k] = finite(b[k]);
    row.feeUsd = {};
    for (const k of FEE_KINDS) row.feeUsd[k] = finite(b.feeUsd && b.feeUsd[k]);
    out.days[d] = row;
  }
  return out;
}

// What the relay takes back when it restarts: the same books, with the exact buyback owed and the income not yet taxed. Never served to
// the public (buildEconomics does not see it); a separate key, so a heartbeat that leaves the ledger out cannot erase it.
export function sanitizeBooks(l) {
  const out = sanitizeLedger(l);
  if (!out) return null;
  // A relay from before the exact figure was posted only has owedEth; it is good to a billionth of an ETH, which is all the carry needs.
  out.owedWei = /^\d{1,30}$/.test(String(l.owedWei ?? '')) ? String(l.owedWei) : l.owedWei == null && out.owedEth > 0 ? String(BigInt(Math.round(out.owedEth * 1e9)) * 10n ** 9n) : '0';
  out.pendingUsd = finite(l.pendingUsd);
  return out;
}

export function sumDays(days, last = 7) {
  const keys = Object.keys(days || {}).sort().slice(-last);
  const t = { days: keys.length, settled: 0, priced: 0, unpriced: 0, proveOnly: 0, gasEth: 0, proveIn: 0, buybackEth: 0, splitterSends: 0, feeUsd: { eth: 0, converted: 0, tac: 0, other: 0 } };
  for (const k of keys) {
    const b = days[k];
    for (const f of DAY_NUM) t[f] += b[f] || 0;
    for (const f of FEE_KINDS) t.feeUsd[f] += (b.feeUsd && b.feeUsd[f]) || 0;
  }
  const r = (x, p) => Math.round(x * 10 ** p) / 10 ** p;
  t.gasEth = r(t.gasEth, 6); t.proveIn = r(t.proveIn, 2); t.buybackEth = r(t.buybackEth, 6);
  for (const f of FEE_KINDS) t.feeUsd[f] = r(t.feeUsd[f], 2);
  t.feeUsd.convertible = r(t.feeUsd.eth + t.feeUsd.converted, 2);
  return t;
}

// ── chain reads ──
// getLogs over [from, to] in `step`-block ranges, oldest first. A range the nodes refuse (the public ones limit how wide, and how old, a
// range may be) is split in two and each half tried, down to `minStep` blocks; one that still fails stops the scan there. `scanned` is how
// far it got, so the caller never skips a range and calls the result whole.
async function scanRange(rpc, filter, a, b, minStep) {
  const r = await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]);
  if (Array.isArray(r)) return { logs: r, scanned: b, complete: true };
  if (b - a + 1 <= minStep) return { logs: [], scanned: a - 1, complete: false };
  const mid = a + Math.floor((b - a) / 2), left = await scanRange(rpc, filter, a, mid, minStep);
  if (!left.complete) return left;
  const right = await scanRange(rpc, filter, mid + 1, b, minStep);
  return { logs: [...left.logs, ...right.logs], scanned: right.scanned, complete: right.complete };
}
export async function scanLogs(rpc, filter, from, to, step, minStep = 2000) {
  const logs = [];
  let at = from - 1;
  for (let a = from; a <= to; a += step) {
    const r = await scanRange(rpc, filter, a, Math.min(a + step - 1, to), minStep);
    logs.push(...r.logs); at = r.scanned;
    if (!r.complete) return { logs, scanned: at, complete: false };
  }
  return { logs, scanned: at, complete: true };
}
const balanceOf = async (rpc, addr) => { const r = await rpc('eth_getBalance', [addr, 'latest']); return r == null ? null : eth(BigInt(r)); };
const proveOf = async (rpc, token, addr) => { const r = await rpc('eth_call', [{ to: token, data: SEL.balanceOf + word(addr) }, 'latest']); return r == null || r === '0x' ? null : Number(BigInt(r) / 10n ** 14n) / 1e4; };

// Wrap tips of the last thirty days through the tip forwarder: how many, how much, and where they went. Slow (several wide scans against
// nodes that limit them), so the route runs it in the background and keeps the answer for hours.
export async function readTips({ rpc, now = Date.now(), addrs = {} } = {}) {
  const A = { ...DEFAULTS, ...Object.fromEntries(Object.entries(addrs).filter(([, v]) => v)) };
  const head = await rpc('eth_blockNumber', []);
  if (head == null) return null;
  const headN = hexNum(head), s = await scanLogs(rpc, { address: A.tipForwarder, topics: [TOPIC.wrappedWithTip] }, Math.max(0, headN - 30 * 7200), headN, 25_000);
  const byTo = {}; let wei = 0n;
  for (const l of s.logs) { const tip = BigInt('0x' + String(l.data).replace(/^0x/, '').slice(64, 128)), to = '0x' + String(l.topics[2]).slice(26).toLowerCase(); wei += tip; byTo[to] = (byTo[to] || 0n) + tip; }
  return { at: now, days: 30, wraps: s.logs.length, eth: eth(wei), byRecipient: Object.entries(byTo).sort((x, y) => Number(y[1] - x[1])).slice(0, 4).map(([to, v]) => ({ to, eth: eth(v) })), complete: s.complete };
}

// `prev` is the last result (kept in KV): the buyback's lifetime totals extend from where the last scan stopped. `addrs` overrides the defaults.
export async function readChain({ rpc, prev = null, now = Date.now(), addrs = {} } = {}) {
  const A = { ...DEFAULTS, ...Object.fromEntries(Object.entries(addrs).filter(([, v]) => v)) };
  const head = await rpc('eth_blockNumber', []);
  const headN = head == null ? null : hexNum(head);
  // A figure that could not be read this time keeps the last one that could, so one failed call never blanks the page.
  const keep = (v, old) => (v == null ? (old == null ? null : old) : v);
  const pw = (prev && prev.wallets) || {};
  const out = { at: now, head: headN == null ? (prev && prev.head) || null : headN };
  const [settleEth, relayEth, relayProve, buybackEth] = await Promise.all([balanceOf(rpc, A.settle), balanceOf(rpc, A.relay), proveOf(rpc, A.prove, A.relay), balanceOf(rpc, A.buyback)]);
  out.wallets = {
    settle: { address: A.settle, eth: keep(settleEth, pw.settle && pw.settle.eth) },
    relay: { address: A.relay, eth: keep(relayEth, pw.relay && pw.relay.eth), prove: keep(relayProve, pw.relay && pw.relay.prove) },
  };
  // Nothing at all answered: say so, so the caller can keep what it has and try again soon instead of calling this a reading.
  out.unread = headN == null && settleEth == null && relayEth == null && buybackEth == null;

  // The buyback's buys, from the block the last scan reached (a scan that fails partway keeps what it got and finishes next time).
  const pb = (prev && prev.buyback) || { scanned: A.buybackFromBlock - 1, buys: 0, ethSpent: 0, tacBought: 0, lastBuyBlock: null };
  const bb = { ...pb, address: A.buyback, ethHeld: keep(buybackEth, pb.ethHeld) };
  if (headN != null && pb.scanned < headN) {
    const s = await scanLogs(rpc, { address: A.buyback, topics: [TOPIC.bought] }, pb.scanned + 1, headN, 100_000);
    for (const l of s.logs) {
      const d = String(l.data).replace(/^0x/, '');
      bb.buys++; bb.ethSpent += eth(BigInt('0x' + d.slice(0, 64))); bb.tacBought += Number(BigInt('0x' + d.slice(64, 128)) / 10n ** 14n) / 1e4; bb.lastBuyBlock = hexNum(l.blockNumber);
    }
    bb.scanned = s.scanned; bb.complete = s.complete;
  } else bb.complete = true;
  bb.ethSpent = Math.round(bb.ethSpent * 1e9) / 1e9; bb.tacBought = Math.round(bb.tacBought * 1e4) / 1e4;
  out.buyback = bb;

  // A splitter, if one is configured: what it holds and who it pays.
  if (isAddr(A.splitter)) {
    const [held, sh] = await Promise.all([balanceOf(rpc, A.splitter), rpc('eth_call', [{ to: A.splitter, data: SEL.shares }, 'latest'])]);
    let shares = null;
    try { if (sh && sh !== '0x') { const d = decodeShares(sh); shares = d.to.map((to, i) => ({ to, weight: String(d.weight[i]), percent: percent(d.weight, i) })); } } catch { shares = null; }
    out.splitter = { address: A.splitter, ethHeld: held, shares };
  } else out.splitter = null;
  return out;
}

// The sponsored-settle allowances for today (UTC): how many the relay has paid for against each limit. A limit that is not set is null.
export function cleanSponsorship(sp) {
  if (!sp || typeof sp !== 'object') return null;
  const one = (x) => ({ used: finite(x && x.used), cap: x && x.cap != null && Number.isFinite(Number(x.cap)) && Number(x.cap) >= 0 ? Math.floor(Number(x.cap)) : null });
  const out = { day: typeof sp.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sp.day) ? sp.day : null, total: one(sp.total), classes: {} };
  for (const k of ['onboard', 'bridge', 'farm', 'wrap', 'other']) out.classes[k] = one(sp.classes && sp.classes[k]);
  // Prove-only jobs the relay pays the proof for (the sender settles): today's count against the day's cap, and one client's cap.
  const p = sp.prove && typeof sp.prove === 'object' ? sp.prove : null;
  out.prove = { ...one(p), perClient: p && p.perClient != null && Number.isFinite(Number(p.perClient)) && Number(p.perClient) >= 0 ? Math.floor(Number(p.perClient)) : null };
  return out;
}

// ── the response ──
export function buildEconomics({ ledger = null, heartbeatAt = null, chain = null, tips = null, prices = null, sponsorship = null, now = Date.now() } = {}) {
  const l = ledger ? { ...ledger, stale: heartbeatAt ? now - heartbeatAt > 10 * 60e3 : true } : null;
  if (l) {
    // The dollar value of a fee paid in TAC (or in a token nothing converts yet) comes from the private price reference, so the public
    // response carries only what is paid in ETH or in what the sweep converts. Those two stay in the stored books for the operator.
    const pub = (f) => ({ eth: f.eth, converted: f.converted, ...(f.convertible != null ? { convertible: f.convertible } : {}) });
    l.recent = Object.entries(l.days).sort().map(([date, b]) => ({ date, ...b, feeUsd: pub(b.feeUsd) }));
    const wk = sumDays(l.days, 7);
    l.week = { ...wk, feeUsd: pub(wk.feeUsd) };
    delete l.days;
  }
  const px = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x * 1e4) / 1e4 : null);
  return { updatedAt: new Date(now).toISOString(), ledger: l, chain: chain ? { ...chain, tips } : chain, prices: prices ? { ethUsd: px(prices.ethUsd), proveUsd: px(prices.proveUsd) } : null, sponsorship: cleanSponsorship(sponsorship) };
}
