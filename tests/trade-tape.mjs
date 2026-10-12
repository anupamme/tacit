#!/usr/bin/env node
// dapp/trade/tape.js against the TAC/ETH Precision pool's real tape (tests/fixtures/precision-tape-2026-10-12.json, as
// `tape(period, 256)` returned it on mainnet), the float decoding against an independent encoder, and the candle maths.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  TAPE_FINE, TAPE_COARSE, unpackFloat, decodeBar, decodeTape, invert, scale, rollup, chartBars, tradePrices, candlesFromTrades, ethLaneUsd, btcLaneUsd, gap, closeAt,
} from '../dapp/trade/tape.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const fx = JSON.parse(readFileSync(new URL('./fixtures/precision-tape-2026-10-12.json', import.meta.url)));

// The contract's own encoder (PriceTape.pack): msb, keep 24 bits.
const pack = (v) => { v = BigInt(v); if (v === 0n) return 0; const msb = v.toString(2).length - 1; if (msb < 24) return Number(v); const sh = msb - 23; return Number((BigInt(sh) << 24n) | (v >> BigInt(sh))); };
const encode = (bucket, o, h, l, c, v, count) => BigInt(bucket) | (BigInt(pack(o)) << 32n) | (BigInt(pack(h)) << 64n) | (BigInt(pack(l)) << 96n) | (BigInt(pack(c)) << 128n) | (BigInt(pack(v)) << 160n) | (BigInt(count) << 192n);

// ── floats and one bar ──
{
  assert.equal(unpackFloat(0), 0n);
  assert.equal(unpackFloat(1), 1n);
  assert.equal(unpackFloat(0xffffff), 0xffffffn, 'exponent 0 is exact');
  assert.equal(unpackFloat((8 << 24) | 0x800000), 0x800000n << 8n);
  for (const v of [1n, 12345n, 0xffffffn, 10n ** 18n, 13373n * 10n ** 18n, 7n * 10n ** 40n + 12345n]) {
    const back = unpackFloat(pack(v));
    assert.ok(back <= v && (v - back) * 8000000n <= v, `${v} → ${back}: truncates, and within 2^-23`);
  }
  const bar = decodeBar(encode(123456, 13000n * 10n ** 18n, 13500n * 10n ** 18n, 12900n * 10n ** 18n, 13373n * 10n ** 18n, 25n * 10n ** 17n, 7));
  assert.equal(bar.bucket, 123456); assert.equal(bar.count, 7);
  for (const [k, want] of [['open', 13000n], ['high', 13500n], ['low', 12900n], ['close', 13373n]]) {
    const got = Number(bar[k]) / 1e18, w = Number(want);
    assert.ok(Math.abs(got - w) / w < 2e-7 && got <= w, `${k} ${got} vs ${w}`);
  }
  assert.ok(Math.abs(Number(bar.volume) / 1e18 - 2.5) < 1e-6);
  ok('floats unpack to what the contract packed (truncated, within 2^-23) and a bar word decodes field by field');
}

// ── the real tape ──
const coarse = decodeTape(fx.coarse, TAPE_COARSE), fine = decodeTape(fx.fine, TAPE_FINE);
{
  assert.equal(coarse.length, 80, 'the 4-hour tape had 80 bars with trades when read');
  assert.equal(fine.length, 14);
  assert.ok(coarse.every((b, i) => i === 0 || b.t > coarse[i - 1].t), 'oldest first, strictly increasing');
  assert.ok(coarse.every((b) => b.t % TAPE_COARSE === 0) && fine.every((b) => b.t % TAPE_FINE === 0));
  assert.equal(new Date(coarse[0].t * 1000).toISOString(), '2026-09-22T16:00:00.000Z', 'the first bar is the pool\'s first day');
  assert.ok(coarse.every((b) => b.low > 0 && b.low <= b.open && b.low <= b.close && b.high >= b.open && b.high >= b.close && b.n > 0 && b.vol >= 0), 'every bar is a well-formed candle');
  const trades = coarse.reduce((a, b) => a + b.n, 0), eth = coarse.reduce((a, b) => a + b.vol, 0);
  assert.ok(trades >= 650 && trades <= 700, `trades ${trades}`);
  assert.ok(eth > 29 && eth < 32, `volume ${eth} ETH`);
  const lo = Math.min(...coarse.map((b) => b.low)), hi = Math.max(...coarse.map((b) => b.high));
  assert.ok(lo > 3400 && lo < 3600 && hi > 25000 && hi < 26500, `range ${lo}-${hi} TAC per ETH (read with cast: 3492-25884)`);
  const last = coarse.at(-1).close;
  assert.ok(last > 13000 && last < 13800, `last 4-hour close ${last}`);
  assert.ok(fine.at(-1).t >= coarse.at(-1).t, 'the fine tape reaches past the coarse one');
  ok('the real 4-hour tape: 80 bars from 2026-09-22 16:00Z, ~660 trades, ~30 ETH, 3,492 to 25,884 TAC per ETH; the 5-minute tape has 14');
}

// ── inversion, roll-up, merging ──
{
  const b = coarse[10], inv = invert(b);
  assert.ok(Math.abs(inv.close * b.close - 1) < 1e-12 && inv.high === 1 / b.low && inv.low === 1 / b.high && inv.low <= inv.open && inv.high >= inv.close);
  assert.deepEqual(scale(b, 2).close, b.close * 2);
  const r = rollup(coarse, 86400);
  assert.equal(r.reduce((a, x) => a + x.n, 0), coarse.reduce((a, x) => a + x.n, 0), 'a roll-up keeps every trade');
  assert.ok(Math.abs(r.reduce((a, x) => a + x.vol, 0) - coarse.reduce((a, x) => a + x.vol, 0)) < 1e-9);
  for (const day of r) {
    const inside = coarse.filter((x) => x.t >= day.t && x.t < day.t + 86400);
    assert.equal(day.open, inside[0].open); assert.equal(day.close, inside.at(-1).close);
    assert.equal(day.high, Math.max(...inside.map((x) => x.high))); assert.equal(day.low, Math.min(...inside.map((x) => x.low)));
  }
  assert.equal(rollup([{ t: 0, open: 1, high: 2, low: 0, close: 2, vol: 1, n: 1 }, { t: 300, open: 2, high: 3, low: 1.5, close: 3, vol: 1, n: 1 }], 3600)[0].low, 1.5, 'a zero low (an underflowed price) never pins a roll-up');
  const hour = chartBars({ fine, coarse }, 3600);
  assert.ok(hour.length > 0 && hour.every((x) => x.t % 3600 === 0) && hour.length <= fine.length);
  assert.deepEqual(chartBars({ fine, coarse }, 450), [], 'a period that is not a whole number of 5-minute bars has no chart');
  const four = chartBars({ fine, coarse }, TAPE_COARSE), lastCoarseEnd = coarse.at(-1).t + TAPE_COARSE;
  assert.ok(four.length >= coarse.length - 0, 'the 4-hour chart is the 4-hour tape');
  assert.equal(four.at(-1).t, Math.floor(fine.at(-1).t / TAPE_COARSE) * TAPE_COARSE);
  if (fine.at(-1).t >= lastCoarseEnd) assert.ok(four.at(-1).t >= lastCoarseEnd, 'the live edge is covered by the 5-minute bars the 4-hour tape has not folded yet');
  ok('inversion, roll-ups (every trade kept, open/close/extremes right) and the merge of the two tapes at the live edge');
}

// ── the Bitcoin lane ──
{
  const T = (price_sats, amount, ts) => ({ price_sats, amount: String(amount), ts, fill_count: 1 });
  const trades = [T(20000, 10000000000, 1000090), T(15000, 10000000000, 1000050), T(900000, 100000000, 1000040), T(14000, 10000000000, 1000000), T(15500, 10000000000, 999000)];
  const pts = tradePrices(trades);
  assert.deepEqual(pts.map((x) => x.price), [155, 140, 150, 200].map((x) => x), 'sats per TAC (price_sats × 1e8 / amount), oldest first, the off-market fill dropped');
  const c = candlesFromTrades(trades, 600);
  assert.equal(c.length, 2); assert.equal(c[1].open, 140); assert.equal(c[1].close, 200); assert.equal(c[1].high, 200); assert.equal(c[1].low, 140); assert.equal(c[1].n, 3); assert.equal(c[1].vol, 300);
  assert.equal(candlesFromTrades([], 3600).length, 0); assert.equal(tradePrices([T(0, 5, 1), T(5, 0, 2), T(5, 5, 'x')]).length, 0);
  ok('trades into sats-per-TAC candles; fills far from the median, zero and malformed trades are left out');
}

// ── comparing the lanes ──
{
  const ethBar = { t: 0, open: 13300, high: 13500, low: 13200, close: 13400, vol: 1, n: 1 };
  const eth = ethLaneUsd(ethBar, 2549), btc = btcLaneUsd({ t: 0, open: 150, high: 160, low: 140, close: 150, vol: 1, n: 1 }, 83438);
  assert.ok(Math.abs(eth.close - 2549 / 13400) < 1e-12 && eth.high >= eth.low, 'ETH lane: dollars per TAC = ETH/USD ÷ TAC per ETH');
  assert.ok(Math.abs(btc.close - 150 * 83438 / 1e8) < 1e-12, 'Bitcoin lane: dollars per TAC = sats × BTC/USD ÷ 1e8');
  assert.ok(Math.abs(gap(eth.close, btc.close) - (btc.close / eth.close - 1)) < 1e-12 && gap(0, 1) === null);
  const bars = [{ t: 100, close: 1 }, { t: 200, close: 2 }, { t: 300, close: 3 }];
  assert.equal(closeAt(bars, 250), 2); assert.equal(closeAt(bars, 300), 3); assert.equal(closeAt(bars, 50), null); assert.equal(closeAt(bars, 9999), 3);
  ok('both lanes in dollars at today\'s rates, the gap between them, and the last close at a time');
}

console.log(`\n${n} trade-tape checks passed`);
