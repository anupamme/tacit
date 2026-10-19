
const ZERO = '0x0000000000000000000000000000000000000000';
export const ZB = Object.freeze({
  V1: '0x000000fF3D7A2d373615141d7489Ca66683DbecF', V2: '0x000000dA7bb4B2A9E3e80e9A4D4157E26CA6189b',
  DUTCH: '0x000000a213b430D14Bae6062c176289B05e04489', FLOOR: '0x00000080198137F790DA4C52bb902cf87c276748',
  VIEW: '0x000000E0b25449F32f7D9259aC449bA88E78dFCE', FLOOR_VIEW: '0x0000004E376e9dB5D9EC28E6711E1a64997C6ba7',
  SWAPBOL: '0x00000087A6dc5071779Ed1F8274A39230768B976', ZROUTER: '0x000000000000FB114709235f1ccBFfb925F600e4',
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
});
const SEL = {
  candidatesFrom: '5f452988', dutchCandidatesFrom: 'eb33e466', floorCandidatesFrom: 'c587d927', areFillableBy: '4377ef87',
  fillPlan: 'c277f67c', checkpoint: 'a972985e', snwap: '5f3bd1c8', multicall: 'ac9650d8', permit: '7ac2ff7b', agg3: '82ad56cb',
  v2QuoteFill: 'f325beda', dutchTakeFor: 'ed25cb25', floorQuoteHit: '7ee77dae',
};
export const BOARD_NAMES = { v1: 'Swapboard v1', v2: 'Swapboard v2', dutch: 'Dutchboard', floor: 'Floorboard' };

const strip = (h) => String(h || '').replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
const boolWord = (b) => (b ? '1' : '0').padStart(64, '0');
const wordAt = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, (i + 1) * 64) || '0'));
const addrAt = (hex, i) => '0x' + strip(hex).slice(i * 64 + 24, i * 64 + 64);
const padRight = (h) => h.padEnd(Math.ceil(h.length / 64) * 64, '0');
const lc = (a) => String(a).toLowerCase();

function encAggregate3(calls) {
  let head = '', tail = '', off = calls.length * 32;
  for (const c of calls) {
    const d = strip(c.data), body = addrWord(c.to) + boolWord(true) + word(96) + word(d.length / 2) + padRight(d);
    head += word(off); tail += body; off += body.length / 2;
  }
  return '0x' + SEL.agg3 + word(32) + word(calls.length) + head + tail;
}
function decAggregate3(hex, n) {
  const h = strip(hex), out = [];
  for (let i = 0; i < n; i++) {
    const w = 2 + Number(wordAt(h, 2 + i)) / 32, ok = wordAt(h, w) === 1n, lw = w + Number(wordAt(h, w + 1)) / 32, len = Number(wordAt(h, lw));
    out.push(ok && len ? '0x' + h.slice((lw + 1) * 64, (lw + 1) * 64 + len * 2) : null);
  }
  return out;
}

export function decOrderViews(raw) {
  if (!raw || strip(raw).length < 128) return { rows: [], next: 0n };
  const arr = Number(wordAt(raw, 0)) / 32, n = Number(wordAt(raw, arr)), rows = [];
  for (let i = 0; i < n; i++) {
    const b = arr + 1 + Number(wordAt(raw, arr + 1 + i)) / 32;
    rows.push({ id: wordAt(raw, b), maker: addrAt(raw, b + 1), partialFill: wordAt(raw, b + 2) === 1n, expiry: Number(wordAt(raw, b + 3)), nftA: wordAt(raw, b + 4) === 1n, nftB: wordAt(raw, b + 5) === 1n,
      counterparty: addrAt(raw, b + 6), tokenA: addrAt(raw, b + 7), amountA: wordAt(raw, b + 8), tokenB: addrAt(raw, b + 11), amountB: wordAt(raw, b + 12), board: addrAt(raw, b + 15) });
  }
  return { rows, next: wordAt(raw, 1) };
}
export function decBidRows(raw) {
  if (!raw || strip(raw).length < 128) return { rows: [], next: 0n };
  const arr = Number(wordAt(raw, 0)) / 32, n = Number(wordAt(raw, arr)), rows = [];
  for (let i = 0; i < n; i++) {
    const b = arr + 1 + Number(wordAt(raw, arr + 1 + i)) / 32;
    rows.push({ id: wordAt(raw, b), bidder: addrAt(raw, b + 1), token: addrAt(raw, b + 2), quote: addrAt(raw, b + 3), isNFT: wordAt(raw, b + 4) === 1n, anyId: wordAt(raw, b + 5) === 1n,
      remaining: wordAt(raw, b + 7), initial: wordAt(raw, b + 8), price: wordAt(raw, b + 9), proceeds: wordAt(raw, b + 10), startTime: Number(wordAt(raw, b + 11)), expiry: Number(wordAt(raw, b + 12)) });
  }
  return { rows, next: wordAt(raw, 1) };
}

const encCandidates = (board, isV2, tokenIn, tokenOut, taker, cursor, maxScan) => '0x' + SEL.candidatesFrom + addrWord(board) + boolWord(isV2) + addrWord(tokenIn) + addrWord(tokenOut) + addrWord(taker) + word(cursor) + word(maxScan);
const encDutch = (tokenIn, tokenOut, taker, cursor, maxScan) => '0x' + SEL.dutchCandidatesFrom + addrWord(ZB.DUTCH) + addrWord(tokenIn) + addrWord(tokenOut) + addrWord(taker) + word(cursor) + word(maxScan);
const encFloor = (tokenIn, tokenOut, cursor, scan) => '0x' + SEL.floorCandidatesFrom + addrWord(ZB.FLOOR) + addrWord(tokenIn) + addrWord(tokenOut) + word(cursor) + word(scan) + word(scan);
const encAreFillable = (ids, taker) => '0x' + SEL.areFillableBy + word(64) + addrWord(taker) + word(ids.length) + ids.map(word).join('');
const decBools = (raw, n) => (raw ? Array.from({ length: n }, (_, i) => wordAt(raw, 2 + i) === 1n) : null);

const ratio = (q, b, qd, bd) => (b > 0n ? (Number(q) / 10 ** qd) / (Number(b) / 10 ** bd) : 0);

function normalize(r, { base, baseDecimals, now }) {
  const isAsk = lc(r.tokenA) === lc(base), isBid = lc(r.tokenB) === lc(base);
  if (r.nftA || r.nftB || (!isAsk && !isBid) || (isAsk && isBid)) return null;
  if (r.expiry && r.expiry < now) return null;
  const baseAmt = isAsk ? r.amountA : r.amountB, quoteAmt = isAsk ? r.amountB : r.amountA;
  if (baseAmt <= 0n) return null;
  const kind = lc(r.board) === lc(ZB.V1) ? 'v1' : lc(r.board) === lc(ZB.V2) ? 'v2' : 'dutch';
  return { key: `${kind}:${r.id}`, board: kind, id: r.id, maker: r.maker, side: isAsk ? 'ask' : 'bid', base: baseAmt, quote: quoteAmt, price: ratio(quoteAmt, baseAmt, 18, baseDecimals),
    partial: kind === 'v1' ? false : r.partialFill, expiry: r.expiry, counterparty: r.counterparty, quoteIsNative: lc(r.tokenB) === ZERO || lc(r.tokenA) === ZERO };
}
const normalizeFloor = (r, { baseDecimals, now }) => {
  if (r.isNFT || r.anyId || r.remaining <= 0n || (r.expiry && r.expiry < now)) return null;
  return { key: `floor:${r.id}`, board: 'floor', id: r.id, maker: r.bidder, side: 'bid', base: r.remaining, quote: r.proceeds, price: ratio(r.proceeds, r.remaining, 18, baseDecimals),
    partial: true, expiry: r.expiry, counterparty: ZERO, quoteIsNative: false, floor: { startTime: r.startTime, initial: r.initial } };
};

export async function readBook({ ethCall, base, baseDecimals = 18, now = Math.floor(Date.now() / 1000), maxPages = 6, block = 'latest' }) {
  const WETH = ZB.WETH, scan = 256, taker = ZERO;
  const batch = async (calls) => {
    const raw = await ethCall(ZB.MULTICALL3, encAggregate3(calls), block).catch(() => null);
    return raw ? decAggregate3(raw, calls.length) : calls.map(() => null);
  };
  const plan = [
    { k: 'ask-v1', to: ZB.VIEW, enc: (c) => encCandidates(ZB.V1, false, WETH, base, taker, c, scan), dec: decOrderViews },
    { k: 'ask-v2', to: ZB.VIEW, enc: (c) => encCandidates(ZB.V2, true, WETH, base, taker, c, scan), dec: decOrderViews },
    { k: 'ask-dutch-eth', to: ZB.VIEW, enc: (c) => encDutch(ZERO, base, taker, c, scan), dec: decOrderViews },
    { k: 'ask-dutch-weth', to: ZB.VIEW, enc: (c) => encDutch(WETH, base, taker, c, scan), dec: decOrderViews },
    { k: 'bid-v1', to: ZB.VIEW, enc: (c) => encCandidates(ZB.V1, false, base, WETH, taker, c, scan), dec: decOrderViews },
    { k: 'bid-v2', to: ZB.VIEW, enc: (c) => encCandidates(ZB.V2, true, base, WETH, taker, c, scan), dec: decOrderViews },
    { k: 'bid-dutch', to: ZB.VIEW, enc: (c) => encDutch(base, WETH, taker, c, scan), dec: decOrderViews },
    { k: 'bid-floor', to: ZB.FLOOR_VIEW, enc: (c) => encFloor(base, WETH, c, scan), dec: decBidRows, floor: true },
  ];
  const cursors = plan.map(() => 0n), rows = plan.map(() => []), done = plan.map(() => false), answered = plan.map(() => false);
  let pages = 0, partial = false;
  while (pages < maxPages && done.some((d) => !d)) {
    const live = plan.map((p, i) => i).filter((i) => !done[i]);
    const got = await batch(live.map((i) => ({ to: plan[i].to, data: plan[i].enc(cursors[i]) })));
    live.forEach((i, j) => {
      const r = plan[i].dec(got[j]);
      if (got[j]) answered[i] = true;
      rows[i].push(...r.rows);
      if (!got[j] || r.next === 0n) done[i] = true; else cursors[i] = r.next;
    });
    pages++;
  }
  if (done.some((d) => !d)) partial = true;
  const orders = [];
  plan.forEach((p, i) => { for (const r of rows[i]) { const o = p.floor ? normalizeFloor(r, { baseDecimals, now }) : normalize(r, { base, baseDecimals, now }); if (o && (p.k.startsWith('ask') ? o.side === 'ask' : o.side === 'bid')) orders.push(o); } });
  const v2 = orders.filter((o) => o.board === 'v2');
  if (v2.length) {
    const [r] = await batch([{ to: ZB.V2, data: encAreFillable(v2.map((o) => o.id), taker) }]);
    const ok = decBools(r, v2.length);
    if (ok) v2.forEach((o, i) => { o.fillable = ok[i]; });
  }
  const live = orders.filter((o) => o.fillable !== false);
  const byPrice = (dir) => (a, b) => dir * (a.price - b.price);
  return { asks: live.filter((o) => o.side === 'ask').sort(byPrice(1)), bids: live.filter((o) => o.side === 'bid').sort(byPrice(-1)), at: now, pages, partial, answered: answered.filter(Boolean).length };
}

const cmpPrice = (a, b) => { const l = a.quote * b.base, r = b.quote * a.base; return l < r ? -1 : l > r ? 1 : 0; };

export function planBuy(asks, quoteBudget, { skip = () => false } = {}) {
  const fills = [];
  let left = BigInt(quoteBudget), pay = 0n, get = 0n;
  for (const o of [...asks].filter((x) => !skip(x)).sort(cmpPrice)) {
    if (left <= 0n) break;
    if (o.quote <= left) { fills.push({ order: o, pay: o.quote, get: o.base, whole: true }); left -= o.quote; pay += o.quote; get += o.base; continue; }
    if (!o.partial) continue;
    const take = (left * o.base) / o.quote;
    if (take <= 0n) continue;
    fills.push({ order: o, pay: left, get: take, whole: false }); pay += left; get += take; left = 0n;
  }
  return { fills, pay, get };
}
export function planSell(bids, baseAmount, { skip = () => false } = {}) {
  const fills = [];
  let left = BigInt(baseAmount), pay = 0n, get = 0n;
  for (const o of [...bids].filter((x) => !skip(x)).sort((a, b) => -cmpPrice(a, b))) {
    if (left <= 0n) break;
    if (o.base <= left) { fills.push({ order: o, pay: o.base, get: o.quote, whole: true }); left -= o.base; pay += o.base; get += o.quote; continue; }
    if (!o.partial) continue;
    const proceeds = (left * o.quote) / o.base;
    if (proceeds <= 0n) continue;
    fills.push({ order: o, pay: left, get: proceeds, whole: false }); pay += left; get += proceeds; left = 0n;
  }
  return { fills, pay, get };
}

export async function refine({ ethCall, plan, block = 'latest' }) {
  const calls = plan.fills.map((f) => {
    const o = f.order;
    if (o.board === 'v2') return { to: ZB.V2, data: '0x' + SEL.v2QuoteFill + word(o.id) + word(f.pay) };
    if (o.board === 'dutch') return { to: ZB.DUTCH, data: '0x' + SEL.dutchTakeFor + word(o.id) + word(f.pay) };
    if (o.board === 'floor') return { to: ZB.FLOOR, data: '0x' + SEL.floorQuoteHit + word(o.id) + word(f.pay) };
    return null;
  });
  const real = calls.map((c, i) => ({ c, i })).filter((x) => x.c);
  const raw = real.length ? await ethCall(ZB.MULTICALL3, encAggregate3(real.map((x) => x.c)), block).then((r) => decAggregate3(r, real.length), () => null) : [];
  if (!raw) return null;
  const fills = plan.fills.map((f) => ({ ...f }));
  for (const [j, x] of real.entries()) {
    const r = raw[j], f = fills[x.i], o = f.order;
    if (!r) return null;
    if (o.board === 'v2') {
      const out = wordAt(r, 0), paid = wordAt(r, 1);
      if (out <= 0n || paid <= 0n) return null;
      f.get = out; f.pay = paid;
      f.whole = paid >= (o.side === 'ask' ? o.quote : o.base);
    } else if (o.board === 'dutch') {
      const take = wordAt(r, 0), cost = wordAt(r, 1);
      if (take <= 0n) return null;
      f.get = take; f.pay = cost;
      f.whole = take >= (o.side === 'ask' ? o.base : o.quote);
    } else {
      const ok = wordAt(r, 0) !== 0n, proceeds = wordAt(r, 1);
      if (!ok || proceeds <= 0n) return null;
      f.get = proceeds; f.whole = f.pay >= o.base;
    }
  }
  return { fills, pay: fills.reduce((a, f) => a + f.pay, 0n), get: fills.reduce((a, f) => a + f.get, 0n) };
}

function legFor(f, side, slipBps) {
  const o = f.order, down = (x) => (x * BigInt(10000 - slipBps)) / 10000n, board = ZB[o.board.toUpperCase()];
  if (o.board === 'v1') return { id: o.id, board, payIn: side === 'buy' ? o.quote : o.base, getOut: 0n, partial: false, recv: side === 'buy' ? o.base : o.quote };
  if (o.board === 'v2') { const g = down(f.get); return { id: o.id, board, payIn: f.pay, getOut: g, partial: !f.whole, recv: g }; }
  if (o.board === 'dutch') return { id: o.id, board, payIn: f.pay, getOut: f.get, partial: !f.whole, recv: f.get };
  const g = down(f.get);
  return { id: o.id, board, payIn: f.pay, getOut: g, partial: !f.whole, recv: g };
}
const encFills = (legs) => word(legs.length) + legs.map((l) => word(l.id) + addrWord(l.board) + word(l.payIn) + word(l.getOut) + boolWord(l.partial)).join('');
const encFillPlan = ({ tokenIn, tokenOut, recipient, refundTo, deadline, legs }) => '0x' + SEL.fillPlan + addrWord(tokenIn) + addrWord(tokenOut) + addrWord(recipient) + addrWord(refundTo) + word(deadline) + word(192) + encFills(legs);
const encSnwap = ({ tokenIn, amountIn, recipient, tokenOut, minOut, executor, data }) => { const d = strip(data); return '0x' + SEL.snwap + addrWord(tokenIn) + word(amountIn) + addrWord(recipient) + addrWord(tokenOut) + word(minOut) + addrWord(executor) + word(224) + word(d.length / 2) + padRight(d); };
const encMulticall = (calls) => { let head = '', tail = '', off = calls.length * 32; for (const c of calls) { const d = strip(c), body = word(d.length / 2) + padRight(d); head += word(off); tail += body; off += body.length / 2; } return '0x' + SEL.multicall + word(32) + word(calls.length) + head + tail; };

export function buildFill({ plan, side, token, account, deadline, slipBps = 50, permit = null, floor = 0n }) {
  const legs = plan.fills.map((f) => legFor(f, side, slipBps));
  if (!legs.length) throw new Error('buildFill: nothing to fill');
  const sum = legs.reduce((a, l) => a + l.recv, 0n), minOut = BigInt(floor) > sum ? BigInt(floor) : sum;
  if (side === 'buy') {
    const value = legs.reduce((a, l) => a + l.payIn, 0n);
    const data = encFillPlan({ tokenIn: ZERO, tokenOut: token, recipient: account, refundTo: account, deadline, legs });
    return { to: ZB.ZROUTER, data: encSnwap({ tokenIn: ZERO, amountIn: value, recipient: account, tokenOut: token, minOut, executor: ZB.SWAPBOL, data }), value, approval: null, minOut };
  }
  const total = legs.reduce((a, l) => a + l.payIn, 0n);
  const checkpoint = encSnwap({ tokenIn: ZERO, amountIn: 0n, recipient: account, tokenOut: ZERO, minOut: 0n, executor: ZB.SWAPBOL, data: '0x' + SEL.checkpoint + addrWord(token) });
  const fill = encSnwap({ tokenIn: token, amountIn: total, recipient: account, tokenOut: ZERO, minOut, executor: ZB.SWAPBOL, data: encFillPlan({ tokenIn: token, tokenOut: ZERO, recipient: account, refundTo: account, deadline, legs }) });
  const permitLeg = permit ? '0x' + SEL.permit + addrWord(token) + word(permit.value) + word(permit.deadline) + word(permit.v) + strip(permit.r).padStart(64, '0') + strip(permit.s).padStart(64, '0') : null;
  return { to: ZB.ZROUTER, data: encMulticall([...(permitLeg ? [permitLeg] : []), checkpoint, fill]), value: 0n, approval: permit ? null : { token, spender: ZB.ZROUTER, amount: total }, minOut };
}

export const _internal = { encAggregate3, decAggregate3, encCandidates, encDutch, encFloor, encFillPlan, encSnwap, encMulticall, legFor, normalize, normalizeFloor, cmpPrice, ratio };
