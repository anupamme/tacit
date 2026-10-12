#!/usr/bin/env node
// dapp/zboards.js: zSwap's order boards read as an order book for one token, planned and filled. Synthetic board answers are encoded by
// `cast abi-encode` (foundry) so the decoders read what the chain will send; the transactions are compared byte for byte with `cast calldata`.
// tests/zboards-fork.mjs runs the same reads and fills against mainnet state with real orders.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { ZB, decOrderViews, decBidRows, readBook, planBuy, planSell, refine, buildFill, _internal } from '../dapp/zboards.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const cast = (...args) => execFileSync('cast', args, { encoding: 'utf8' }).trim();
const E18 = 10n ** 18n, ZERO = '0x0000000000000000000000000000000000000000';
const TOKEN = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', OTHER = '0xE9b1cFEA55BAA219e34301f2F31b9FD0921664ED';
const M1 = '0x1111111111111111111111111111111111111111', M2 = '0x2222222222222222222222222222222222222222', ME = '0x3333333333333333333333333333333333333333';
const NOW = 1_800_000_000;

// ── what the views return, as the chain encodes it ──
const OV = '(uint256,address,bool,uint64,bool,bool,address,address,uint256,string,uint8,address,uint256,string,uint8,address)';
const BR = '(uint256,address,address,address,bool,bool,uint256[],uint128,uint128,uint256,uint256,uint40,uint40,uint8,uint8,string,string)';
// decimals 0 on purpose for the ETH side: the views report 0 for a token the board never snapshotted, so the page does not read decimals from them
const orderView = (o) => `(${o.id},${o.maker || M1},${!!o.partial},${o.expiry || 0},false,false,${o.counterparty || ZERO},${o.tokenA},${o.amountA},${o.symbolA || 'A'},${o.decimalsA ?? 0},${o.tokenB},${o.amountB},${o.symbolB || 'B'},${o.decimalsB ?? 0},${o.board})`;
const encViews = (rows, next = 0) => cast('abi-encode', `f(${OV}[],uint256)`, `[${rows.map(orderView).join(',')}]`, String(next));
const bidRow = (b) => `(${b.id},${b.bidder || M1},${b.token || TOKEN},${ZB.WETH},false,false,[],${b.remaining},${b.initial || b.remaining},${b.price || b.proceeds},${b.proceeds},${b.startTime || NOW - 100},${b.expiry || 0},${b.tokenDecimals ?? 18},${b.quoteDecimals ?? 0},TAC,WETH)`;
const encBids = (rows, next = 0) => cast('abi-encode', `f(${BR}[],uint256)`, `[${rows.map(bidRow).join(',')}]`, String(next));

// ── a fake chain: Multicall3.aggregate3 in, each call answered by selector ──
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
function decodeAggregate3Call(data) {
  const h = data.replace(/^0x/, '').slice(8), word = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
  const cnt = Number(word(1)), subs = [];
  for (let i = 0; i < cnt; i++) {
    const t = 2 + Number(word(2 + i)) / 32, bo = t + Number(word(t + 2)) / 32, len = Number(word(bo));
    subs.push({ to: '0x' + h.slice(t * 64 + 24, t * 64 + 64), data: '0x' + h.slice((bo + 1) * 64, (bo + 1) * 64 + len * 2) });
  }
  return subs;
}
function encReturns(rets) {
  const bodies = rets.map((r) => { const d = r ? r.replace(/^0x/, '') : ''; return w(r ? 1 : 0) + w(64) + w(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0'); });
  let head = '', tail = '', off = rets.length * 32;
  for (const b of bodies) { head += w(off); tail += b; off += b.length / 2; }
  return '0x' + w(32) + w(rets.length) + head + tail;
}
const argWord = (data, i) => BigInt('0x' + data.replace(/^0x/, '').slice(8 + i * 64, 8 + (i + 1) * 64));
const argAddr = (data, i) => '0x' + data.replace(/^0x/, '').slice(8 + i * 64 + 24, 8 + (i + 1) * 64);
// `book` answers: { 'v1.ask': rows, ... } by board and direction; paged when a list has more than `page` rows
function fakeChain(book, { page = 100, fillable = null, calls = [] } = {}) {
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  return async (to, data) => {
    assert(same(to, ZB.MULTICALL3), 'everything goes through Multicall3');
    const subs = decodeAggregate3Call(data);
    calls.push(subs);
    return encReturns(subs.map((s) => {
      const sel = s.data.slice(2, 10);
      if (sel === '5f452988') {                                                  // candidates(board, isV2, tokenIn, tokenOut, taker, cursor, maxScan)
        const board = argAddr(s.data, 0), tokenIn = argAddr(s.data, 2), key = `${same(board, ZB.V1) ? 'v1' : 'v2'}.${same(tokenIn, ZB.WETH) ? 'ask' : 'bid'}`;
        const rows = book[key] || [], c = Number(argWord(s.data, 5)), slice = rows.slice(c, c + page);
        return encViews(slice, c + page < rows.length ? c + page : 0);
      }
      if (sel === 'eb33e466') {                                                  // dutch candidates(board, tokenIn, tokenOut, taker, cursor, maxScan)
        const tokenIn = argAddr(s.data, 1), key = same(tokenIn, ZERO) ? 'dutch.eth' : same(tokenIn, ZB.WETH) ? 'dutch.weth' : 'dutch.bid';
        const rows = book[key] || [], c = Number(argWord(s.data, 4)), slice = rows.slice(c, c + page);
        return encViews(slice, c + page < rows.length ? c + page : 0);
      }
      if (sel === 'c587d927') {                                                  // floor candidates(board, tokenIn, tokenOut, cursor, scan, limit)
        const rows = book['floor.bid'] || [], c = Number(argWord(s.data, 3)), slice = rows.slice(c, c + page);
        return encBids(slice, c + page < rows.length ? c + page : 0);
      }
      if (sel === '4377ef87') {                                                  // areFillableBy(ids, taker)
        const cnt = Number(argWord(s.data, 2));
        return '0x' + w(32) + w(cnt) + Array.from({ length: cnt }, (_, i) => w(fillable ? (fillable(argWord(s.data, 3 + i)) ? 1 : 0) : 1)).join('');
      }
      return null;
    }));
  };
}

const ask = (board, id, baseAmt, quoteAmt, extra = {}) => ({ id, board, tokenA: TOKEN, amountA: baseAmt, tokenB: ZB.WETH, amountB: quoteAmt, decimalsA: 18, decimalsB: 0, ...extra });
const bid = (board, id, baseAmt, quoteAmt, extra = {}) => ({ id, board, tokenA: ZB.WETH, amountA: quoteAmt, tokenB: TOKEN, amountB: baseAmt, decimalsA: 0, decimalsB: 18, ...extra });

// ── decoders ──
{
  const raw = encViews([ask(ZB.V1, 143, 100n * E18, E18)]);
  const { rows, next } = decOrderViews(raw);
  assert.equal(rows.length, 1); assert.equal(next, 0n);
  assert.equal(rows[0].id, 143n); assert.equal(rows[0].amountA, 100n * E18); assert.equal(rows[0].amountB, E18);
  assert.equal(rows[0].tokenA.toLowerCase(), TOKEN.toLowerCase()); assert.equal(rows[0].board.toLowerCase(), ZB.V1.toLowerCase());
  ok('an OrderView row decodes: id, amounts, tokens, board');
  assert.deepEqual(decOrderViews(encViews([])).rows, []); assert.deepEqual(decOrderViews('0x').rows, []); assert.deepEqual(decOrderViews(null).rows, []);
  ok('an empty page, empty data and a failed call decode to no rows');
  const more = decOrderViews(encViews([ask(ZB.V2, 1, E18, E18, { partial: true, expiry: NOW + 5 })], 77));
  assert.equal(more.next, 77n); assert.equal(more.rows[0].partialFill, true); assert.equal(more.rows[0].expiry, NOW + 5);
  ok('the cursor and the partial/expiry fields decode');
  const bids = decBidRows(encBids([{ id: 9, remaining: 50n * E18, proceeds: E18 / 2n, initial: 100n * E18, price: E18, expiry: NOW + 60 }], 3));
  assert.equal(bids.next, 3n); assert.equal(bids.rows[0].id, 9n); assert.equal(bids.rows[0].remaining, 50n * E18); assert.equal(bids.rows[0].proceeds, E18 / 2n);
  assert.equal(bids.rows[0].token.toLowerCase(), TOKEN.toLowerCase()); assert.equal(bids.rows[0].expiry, NOW + 60);
  ok('a BidRow decodes with its dynamic ids and symbols in the way');
}

// ── normalize: a price from the amounts, never from the views' decimals ──
{
  const [r] = decOrderViews(encViews([ask(ZB.V1, 143, 100n * E18, E18)])).rows;
  const o = _internal.normalize(r, { base: TOKEN, baseDecimals: 18, now: NOW });
  assert.equal(o.price, 0.01); assert.equal(o.side, 'ask'); assert.equal(o.key, 'v1:143'); assert.equal(o.partial, false);
  ok('1 ETH for 100 TAC reads 0.01 ETH per TAC even when the view says the ETH side has 0 decimals');
  const [b] = decOrderViews(encViews([bid(ZB.V2, 5, 200n * E18, E18, { partial: true })])).rows;
  const ob = _internal.normalize(b, { base: TOKEN, baseDecimals: 18, now: NOW });
  assert.equal(ob.side, 'bid'); assert.equal(ob.base, 200n * E18); assert.equal(ob.quote, E18); assert.equal(ob.price, 0.005); assert.equal(ob.partial, true);
  ok('a bid reads with the token as its base and the ETH as its quote');
  const [six] = decOrderViews(encViews([ask(ZB.V1, 1, 1_000_000n, E18, { decimalsA: 6 })])).rows;
  assert.equal(_internal.normalize(six, { base: TOKEN, baseDecimals: 6, now: NOW }).price, 1);
  ok('a six-decimal token prices off the decimals the caller gives');
  const stale = decOrderViews(encViews([ask(ZB.V2, 2, E18, E18, { expiry: NOW - 1 })])).rows[0];
  assert.equal(_internal.normalize(stale, { base: TOKEN, baseDecimals: 18, now: NOW }), null);
  const other = decOrderViews(encViews([{ id: 3, board: ZB.V1, tokenA: OTHER, amountA: E18, tokenB: ZB.WETH, amountB: E18 }])).rows[0];
  assert.equal(_internal.normalize(other, { base: TOKEN, baseDecimals: 18, now: NOW }), null);
  const both = decOrderViews(encViews([{ id: 4, board: ZB.V1, tokenA: TOKEN, amountA: E18, tokenB: TOKEN, amountB: E18 }])).rows[0];
  assert.equal(_internal.normalize(both, { base: TOKEN, baseDecimals: 18, now: NOW }), null);
  ok('an expired order, an order for another token and a swap of the token for itself are left out');
}

// ── readBook ──
{
  const calls = [];
  const book = {
    'v1.ask': [ask(ZB.V1, 143, 100n * E18, E18)],
    'v2.ask': [ask(ZB.V2, 7, 1000n * E18, 5n * E18, { partial: true, expiry: NOW + 1000 }), ask(ZB.V2, 8, 10n * E18, E18, { partial: true })],
    'dutch.eth': [ask(ZB.DUTCH, 31, 40n * E18, E18 / 2n, { partial: true, tokenB: ZERO })],
    'v1.bid': [bid(ZB.V1, 12, 300n * E18, E18)],
    'v2.bid': [bid(ZB.V2, 13, 1000n * E18, 3n * E18, { partial: true })],
    'floor.bid': [{ id: 4, remaining: 500n * E18, proceeds: E18 / 4n, initial: 500n * E18, price: E18 / 4n }],
  };
  const b = await readBook({ ethCall: fakeChain(book, { calls }), base: TOKEN, now: NOW });
  assert.deepEqual(b.asks.map((o) => o.key), ['v2:7', 'v1:143', 'dutch:31', 'v2:8'].sort((x, y) => b.asks.findIndex((o) => o.key === x) - b.asks.findIndex((o) => o.key === y)));
  assert.deepEqual(b.asks.map((o) => o.price), [...b.asks.map((o) => o.price)].sort((x, y) => x - y));
  assert.deepEqual(b.asks.map((o) => o.price), [0.005, 0.01, 0.0125, 0.1]);
  assert.deepEqual(b.bids.map((o) => o.price), [...b.bids.map((o) => o.price)].sort((x, y) => y - x));
  assert.deepEqual(b.bids.map((o) => o.key), ['v2:13', 'v1:12', 'floor:4'].sort((x, y) => b.bids.findIndex((o) => o.key === x) - b.bids.findIndex((o) => o.key === y)));
  assert.deepEqual(b.bids.map((o) => o.price), [0.003, 1 / 300, 0.0005].sort((x, y) => y - x));
  ok('all four boards and both sides read; asks cheapest first, bids dearest first, prices from the amounts');
  assert.equal(b.partial, false); assert.equal(b.answered, 8); assert.equal(b.pages, 1);
  assert.equal(calls.length, 2, 'one batch for the views, one for v2 fillability');
  ok('eight view calls in one Multicall3 and one more to ask Swapboard v2 what is fillable');
  const fl = b.bids.find((o) => o.board === 'floor');
  assert.equal(fl.partial, true); assert.equal(fl.base, 500n * E18); assert.equal(fl.quote, E18 / 4n); assert.equal(fl.price, 0.0005);
  ok('a Floorboard bid is a partial bid for what remains');
}
{
  const book = { 'v2.ask': [ask(ZB.V2, 7, E18, E18, { partial: true }), ask(ZB.V2, 8, E18, 2n * E18, { partial: true })] };
  const b = await readBook({ ethCall: fakeChain(book, { fillable: (id) => id !== 7n }), base: TOKEN, now: NOW });
  assert.deepEqual(b.asks.map((o) => o.key), ['v2:8']);
  ok('a Swapboard v2 order the board says is not fillable is dropped');
}
{
  const rows = Array.from({ length: 25 }, (_, i) => ask(ZB.V1, 100 + i, 10n * E18, BigInt(i + 1) * E18 / 10n));
  const b = await readBook({ ethCall: fakeChain({ 'v1.ask': rows }, { page: 10 }), base: TOKEN, now: NOW, maxPages: 6 });
  assert.equal(b.asks.length, 25); assert.equal(b.pages, 3); assert.equal(b.partial, false);
  ok('a board with more orders than a page is read to the end');
  const cut = await readBook({ ethCall: fakeChain({ 'v1.ask': rows }, { page: 10 }), base: TOKEN, now: NOW, maxPages: 2 });
  assert.equal(cut.asks.length, 20); assert.equal(cut.partial, true);
  ok('a read that stops at its page limit says it is partial');
  const down = await readBook({ ethCall: async () => { throw new Error('rpc down'); }, base: TOKEN, now: NOW });
  assert.equal(down.asks.length, 0); assert.equal(down.answered, 0);
  ok('a dead RPC reads as an empty book that nothing answered');
}

// ── planning ──
const mk = (board, id, base, quote, partial, side = 'ask') => ({ key: `${board}:${id}`, board, id: BigInt(id), side, base, quote, partial, price: Number(quote) / Number(base), maker: M1, expiry: 0, counterparty: ZERO });
{
  const asks = [mk('v1', 1, 100n * E18, 2n * E18, false), mk('v2', 2, 100n * E18, E18, true), mk('v2', 3, 100n * E18, 3n * E18, true)];
  const p = planBuy(asks, 4n * E18);
  assert.deepEqual(p.fills.map((f) => f.order.id), [2n, 1n, 3n]);
  assert.equal(p.fills[0].whole, true); assert.equal(p.fills[1].whole, true); assert.equal(p.fills[2].whole, false);
  assert.equal(p.fills[2].pay, E18); assert.equal(p.fills[2].get, 100n * E18 / 3n);
  assert.equal(p.pay, 4n * E18); assert.equal(p.get, 100n * E18 + 100n * E18 + 100n * E18 / 3n);
  ok('a buy takes the cheapest order first, whole while the budget lasts, then a part of the next at that order\'s price');
  const short = planBuy(asks, 5n * E18 / 2n);
  assert.deepEqual(short.fills.map((f) => f.order.id), [2n, 3n]); assert.equal(short.pay, 5n * E18 / 2n);
  ok('a whole-only order that no longer fits the budget is passed over for the next one that does');
  const small = planBuy([mk('v1', 1, 100n * E18, 2n * E18, false)], E18);
  assert.equal(small.fills.length, 0); assert.equal(small.get, 0n);
  ok('an order that can only be taken whole is skipped when the budget is short of it');
  const skipped = planBuy(asks, 10n * E18, { skip: (o) => o.maker === M1 });
  assert.equal(skipped.fills.length, 0);
  ok('orders the caller skips (its own) are never planned');
  const tie = planBuy([mk('v2', 1, 3n * E18, E18, true), mk('v2', 2, 6n * E18, 2n * E18, true), mk('v2', 3, 6n * E18, 2n * E18 + 1n, true)], 100n * E18);
  assert.deepEqual(tie.fills.map((f) => f.order.id).slice(0, 2).sort(), [1n, 2n]); assert.equal(tie.fills[2].order.id, 3n);
  ok('orders are ranked by exact cross-multiplication, not by a rounded float');
  const dust = planBuy([mk('v2', 1, 1n, 10n ** 30n, true)], 5n);
  assert.equal(dust.fills.length, 0);
  ok('a budget that buys nothing of an order plans nothing');
}
{
  const bids = [mk('v1', 1, 100n * E18, E18, false, 'bid'), mk('v2', 2, 100n * E18, 2n * E18, true, 'bid'), mk('v2', 3, 100n * E18, E18 / 2n, true, 'bid')];
  const p = planSell(bids, 250n * E18);
  assert.deepEqual(p.fills.map((f) => f.order.id), [2n, 1n, 3n]);
  assert.equal(p.fills[2].whole, false); assert.equal(p.fills[2].pay, 50n * E18); assert.equal(p.fills[2].get, E18 / 4n);
  assert.equal(p.pay, 250n * E18); assert.equal(p.get, 2n * E18 + E18 + E18 / 4n);
  ok('a sell fills the dearest bid first and a part of the last at its own price');
  const whole = planSell([mk('v1', 1, 100n * E18, E18, false, 'bid')], 50n * E18);
  assert.equal(whole.fills.length, 0);
  ok('a bid that can only be filled whole is skipped for a smaller amount');
}

// ── refine: the board's own figures ──
{
  const plan = planBuy([mk('v1', 1, 100n * E18, E18, false), mk('v2', 2, 100n * E18, E18, true), mk('dutch', 3, 50n * E18, E18, true)], 3n * E18);
  const seen = [];
  const ethCall = async (to, data) => {
    const subs = decodeAggregate3Call(data); seen.push(subs);
    return encReturns(subs.map((s) => {
      const sel = s.data.slice(2, 10);
      if (sel === 'f325beda') return '0x' + w(99n * E18) + w(argWord(s.data, 1));            // v2 quoteFill: a little less than asked
      if (sel === 'ed25cb25') return '0x' + w(49n * E18) + w(argWord(s.data, 1) - 10n);       // dutch takeFor: takes less, costs less
      return null;
    }));
  };
  const r = await refine({ ethCall, plan });
  assert.equal(seen[0].length, 2, 'v1 is not asked: it fills whole at its own price');
  assert.equal(r.fills[1].get, 99n * E18); assert.equal(r.fills[2].get, 49n * E18); assert.equal(r.fills[2].pay, E18 - 10n);
  assert.equal(r.fills[0].get, 100n * E18); assert.equal(r.get, 100n * E18 + 99n * E18 + 49n * E18);
  ok('refine asks v2 and Dutchboard what a fill settles at and keeps v1 at its price');
  const dead = async (to, data) => encReturns(decodeAggregate3Call(data).map(() => null));
  assert.equal(await refine({ ethCall: dead, plan }), null);
  assert.equal(await refine({ ethCall: async () => { throw new Error('x'); }, plan }), null);
  ok('a fill the board will not quote (or a dead RPC) refines to null, so it is never sent');
}

// ── the transactions, byte for byte ──
{
  const FILL = '(uint256,address,uint256,uint256,bool)';
  const FP = `fillPlan(address,address,address,address,uint256,${FILL}[])`;
  const fillArg = (l) => `(${l.id},${l.board},${l.payIn},${l.getOut},${l.partial})`;
  const fillData = (tokenIn, tokenOut, legs, deadline) => cast('calldata', FP, tokenIn, tokenOut, ME, ME, String(deadline), `[${legs.map(fillArg).join(',')}]`);
  const snwap = (tokenIn, amountIn, tokenOut, minOut, data) => cast('calldata', 'snwap(address,uint256,address,address,uint256,address,bytes)', tokenIn, String(amountIn), ME, tokenOut, String(minOut), ZB.SWAPBOL, data);
  const deadline = NOW + 600;

  const plan = { fills: [
    { order: mk('v1', 1, 100n * E18, E18, false), pay: E18, get: 100n * E18, whole: true },
    { order: mk('v2', 2, 100n * E18, E18, true), pay: E18 / 2n, get: 50n * E18, whole: false },
    { order: mk('dutch', 3, 50n * E18, E18, true), pay: E18 / 3n, get: 25n * E18, whole: false },
  ] };
  const buy = buildFill({ plan, side: 'buy', token: TOKEN, account: ME, deadline, slipBps: 50 });
  const legsBuy = [
    { id: 1, board: ZB.V1, payIn: E18, getOut: 0, partial: false },
    { id: 2, board: ZB.V2, payIn: E18 / 2n, getOut: 50n * E18 * 9950n / 10000n, partial: true },
    { id: 3, board: ZB.DUTCH, payIn: E18 / 3n, getOut: 25n * E18, partial: true },
  ];
  const minBuy = 100n * E18 + 50n * E18 * 9950n / 10000n + 25n * E18;
  const wantBuy = snwap(ZERO, E18 + E18 / 2n + E18 / 3n, TOKEN, minBuy, fillData(ZERO, TOKEN, legsBuy, deadline));
  assert.equal(buy.data.toLowerCase(), wantBuy.toLowerCase()); assert.equal(buy.to, ZB.ZROUTER); assert.equal(buy.value, E18 + E18 / 2n + E18 / 3n);
  assert.equal(buy.minOut, minBuy); assert.equal(buy.approval, null);
  ok('a buy is one snwap with the fill list, the ETH sent as value, and a floor that adds up what each board guarantees');

  const sellPlan = { fills: [
    { order: mk('v1', 1, 100n * E18, E18, false, 'bid'), pay: 100n * E18, get: E18, whole: true },
    { order: mk('v2', 2, 100n * E18, 2n * E18, true, 'bid'), pay: 40n * E18, get: 4n * E18 / 5n, whole: false },
    { order: { ...mk('floor', 4, 500n * E18, E18 / 4n, true, 'bid') }, pay: 10n * E18, get: E18 / 200n, whole: false },
  ] };
  const sell = buildFill({ plan: sellPlan, side: 'sell', token: TOKEN, account: ME, deadline, slipBps: 100 });
  const legsSell = [
    { id: 1, board: ZB.V1, payIn: 100n * E18, getOut: 0, partial: false },
    { id: 2, board: ZB.V2, payIn: 40n * E18, getOut: (4n * E18 / 5n) * 9900n / 10000n, partial: true },
    { id: 4, board: ZB.FLOOR, payIn: 10n * E18, getOut: (E18 / 200n) * 9900n / 10000n, partial: true },
  ];
  const minSell = E18 + (4n * E18 / 5n) * 9900n / 10000n + (E18 / 200n) * 9900n / 10000n;
  const total = 150n * E18;
  const checkpoint = snwap(ZERO, 0, ZERO, 0, cast('calldata', 'checkpoint(address)', TOKEN));
  const fillTx = snwap(TOKEN, total, ZERO, minSell, fillData(TOKEN, ZERO, legsSell, deadline));
  const wantSell = cast('calldata', 'multicall(bytes[])', `[${checkpoint},${fillTx}]`);
  assert.equal(sell.data.toLowerCase(), wantSell.toLowerCase()); assert.equal(sell.value, 0n); assert.equal(sell.minOut, minSell);
  assert.deepEqual(sell.approval, { token: TOKEN, spender: ZB.ZROUTER, amount: total });
  ok('a sell is zRouter.multicall([checkpoint, snwap fill]) with the approval to zRouter it needs, and a floor from the boards\' own guarantees');

  const permit = { value: total, deadline: NOW + 900, v: 27, r: '0x' + 'ab'.repeat(32), s: '0x' + 'cd'.repeat(32) };
  const sellP = buildFill({ plan: sellPlan, side: 'sell', token: TOKEN, account: ME, deadline, slipBps: 100, permit });
  const permitLeg = cast('calldata', 'permit(address,uint256,uint256,uint8,bytes32,bytes32)', TOKEN, String(permit.value), String(permit.deadline), '27', permit.r, permit.s);
  const wantP = cast('calldata', 'multicall(bytes[])', `[${permitLeg},${checkpoint},${fillTx}]`);
  assert.equal(sellP.data.toLowerCase(), wantP.toLowerCase()); assert.equal(sellP.approval, null);
  ok('with a signed permit the sell leads with it and needs no approval');
  // a floor from a review is never loosened by a re-read price: the total is at least it, and a lower one changes nothing
  const bound = buildFill({ plan, side: 'buy', token: TOKEN, account: ME, deadline, slipBps: 50, floor: minBuy + 1000n });
  assert.equal(bound.minOut, minBuy + 1000n);
  assert.equal(bound.data.toLowerCase(), snwap(ZERO, E18 + E18 / 2n + E18 / 3n, TOKEN, minBuy + 1000n, fillData(ZERO, TOKEN, legsBuy, deadline)).toLowerCase());
  assert.equal(buildFill({ plan, side: 'buy', token: TOKEN, account: ME, deadline, slipBps: 50, floor: minBuy - 1n }).data.toLowerCase(), wantBuy.toLowerCase());
  ok('a floor above the legs\' own floors becomes the whole transaction\'s floor, and a lower one changes nothing');
  assert.throws(() => buildFill({ plan: { fills: [] }, side: 'buy', token: TOKEN, account: ME, deadline }), /nothing to fill/);
  ok('a plan with no fills builds nothing');

  // the exact selectors this module hard-codes
  const sels = { fillPlan: FP, snwap: 'snwap(address,uint256,address,address,uint256,address,bytes)', checkpoint: 'checkpoint(address)', multicall: 'multicall(bytes[])', permit: 'permit(address,uint256,uint256,uint8,bytes32,bytes32)', agg3: 'aggregate3((address,bool,bytes)[])',
    areFillableBy: 'areFillableBy(uint256[],address)', v2QuoteFill: 'quoteFill(uint256,uint256)', dutchTakeFor: 'takeFor(uint256,uint256)', floorQuoteHit: 'quoteHit(uint256,uint128)' };
  const src = (await import('node:fs')).readFileSync(new URL('../dapp/zboards.js', import.meta.url), 'utf8');
  for (const [k, sig] of Object.entries(sels)) assert(src.includes(`${k}: '${cast('sig', sig).slice(2)}'`), `selector ${k} = ${cast('sig', sig)}`);
  ok('the hard-coded selectors are the ones foundry computes');
}

console.log(`\n${n} checks passed`);
