// The visualizer's feed (worker/src/flow-feed.js): real events only, a counter history that shows what moved, a payload small enough for a
// widget, and nothing private. Offline: node --test tests/flow-feed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlow, appendSeries, flowPoint, recentTimes, FLOW_SERIES_MAX, FLOW_SERIES_MIN_GAP_SEC, FLOW_WINDOW_SEC, FLOW_EVENTS_MAX } from '../worker/src/flow-feed.js';

const NOW = 1_791_800_000;
const h = (hours) => NOW - hours * 3600;
const reading = {
  link: { tip: 970_926, btcTip: 970_957, attestedHeight: 970_902, crossOuts: 9, status: { bridgeBurns: 43, bridgeMinted: 32, attestedHeight: 970_902, burnDeposits: 1 },
    times: { attests: [h(30), h(20), h(2), h(0.5)], settles: [h(25), h(10), h(1), h(0.1)] } },
  eth: { series: { ins: [[h(40), { $n: '1' }], [h(3), { $n: '2' }]] } },
  dev: [{ chain: 1, series: { ins: [[h(5), { $n: '3' }]] } }, { chain: 8453, series: { ins: [] } }, { chain: 4663 }],
  tac: { supply: { $n: '2499974665590930000000000' }, times: { out: [h(6), h(5), h(50)], in: [h(4)] } },
};
const status = { bridgeBurns: 43, bridgeMinted: 32, attestedHeight: 970_902, burnDeposits: 1 };

test('only the last day of events is carried, oldest first, from every source that has them', () => {
  const f = buildFlow({ reading, status, series: [], now: NOW });
  assert.deepEqual(f.events.attests, [h(20), h(2), h(0.5)], 'the attestation 30 h old is outside the window');
  assert.deepEqual(f.events.settles, [h(10), h(1), h(0.1)]);
  assert.deepEqual(f.events.deposits, [h(5), h(3)], 'the main pool and the device pools together, oldest first, the old one dropped');
  assert.deepEqual(f.events.tacOut, [h(6), h(5)]);
  assert.deepEqual(f.events.tacIn, [h(4)]);
});

test('the counters now come from the live status, and a missing part is null, never zero', () => {
  const f = buildFlow({ reading, status, series: [], now: NOW });
  assert.deepEqual(f.now, { btc: 970_957, relay: 970_926, attested: 970_902, burns: 43, minted: 32, crossOuts: 9, burnDeposits: 1, tacSupply: '2499974665590930000000000' });
  const bare = buildFlow({ reading: {}, status: null, series: null, now: NOW });
  assert.equal(bare.now.burns, null); assert.equal(bare.now.minted, null); assert.equal(bare.now.btc, null); assert.equal(bare.now.tacSupply, null);
  assert.deepEqual(bare.events, { attests: [], settles: [], deposits: [], tacOut: [], tacIn: [] });
  assert.deepEqual(bare.series, []);
});

test('events in the future, and garbage in an event list, are not drawn', () => {
  const f = buildFlow({ reading: { link: { times: { attests: [NOW + 3600, 'x', null, NaN, h(1)], settles: 'nope' } } }, status: null, series: [], now: NOW });
  assert.deepEqual(f.events.attests, [h(1)]);
  assert.deepEqual(f.events.settles, []);
  assert.deepEqual(recentTimes([[h(1), 5], h(2), null], h(3), NOW), [h(2), h(1)], 'a pair reads as its time');
});

test('nothing private rides the feed: no address, no transaction, no amount of a flow', () => {
  const rich = { ...reading, dev: [{ chain: 1, series: { ins: [[h(5), { $n: '3' }]] }, addr: '0x' + 'ab'.repeat(20) }], tac: { ...reading.tac, who: ['0x' + 'cd'.repeat(20)] } };
  const text = JSON.stringify(buildFlow({ reading: rich, status, series: [], now: NOW }));
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(text), 'no address');
  assert.ok(!/0x[0-9a-fA-F]{64}/.test(text), 'no transaction hash');
  assert.deepEqual(Object.keys(buildFlow({ reading, status, series: [], now: NOW }).events), ['attests', 'settles', 'deposits', 'tacOut', 'tacIn'], 'events are times only');
});

test('the payload stays small: a busy day is a few kilobytes, not the stats reading\'s 800', () => {
  const many = Array.from({ length: 3000 }, (_, i) => h(i / 150));
  const f = buildFlow({ reading: { link: { times: { attests: many, settles: many } }, tac: { times: { out: many, in: many } } }, status, series: [], now: NOW });
  const kb = JSON.stringify(f).length / 1024;
  assert.ok(kb < 40, `${kb.toFixed(1)} KB`);
  for (const k of Object.keys(f.events)) assert.ok(f.events[k].length <= FLOW_EVENTS_MAX, k);
});

test('past the cap the newest events are the ones kept', () => {
  const f = buildFlow({ reading: { link: { times: { attests: Array.from({ length: FLOW_EVENTS_MAX + 50 }, (_, i) => h(20) + i * 10) } } }, status: null, series: [], now: NOW });
  assert.equal(f.events.attests.length, FLOW_EVENTS_MAX);
  assert.equal(f.events.attests.at(-1), h(20) + (FLOW_EVENTS_MAX + 49) * 10);
  assert.equal(f.events.attests[0], h(20) + 50 * 10, 'the 50 oldest fell away');
});

test('the counter history keeps a point when a counter moved, or when an hour has passed, and never out of order', () => {
  const p = (t, over = {}) => ({ t, burns: 40, minted: 30, out: 9, att: 970_000, relay: 970_024, btc: 970_050, ...over });
  let s = appendSeries([], p(1000));
  assert.equal(s.length, 1);
  s = appendSeries(s, p(1900));
  assert.equal(s.length, 1, 'unchanged and recent: dropped');
  s = appendSeries(s, p(1900, { minted: 31 }));
  assert.equal(s.length, 2, 'a counter moved: kept');
  s = appendSeries(s, p(1900 + FLOW_SERIES_MIN_GAP_SEC + 1, { minted: 31 }));
  assert.equal(s.length, 3, 'an hour of no change still leaves a point');
  assert.equal(appendSeries(s, p(500, { burns: 99 })).length, 3, 'an older point is refused');
  assert.equal(appendSeries(s, p(1900 + FLOW_SERIES_MIN_GAP_SEC + 1, { burns: 41 })).length, 3, 'a point at or before the last time is refused');
});

test('the history is capped, oldest first to go, and survives a corrupt entry', () => {
  let s = [];
  for (let i = 0; i < FLOW_SERIES_MAX + 25; i++) s = appendSeries(s, { t: 1000 + i * 4000, burns: i, minted: 0, out: 0, att: 0, relay: 0, btc: 0 });
  assert.equal(s.length, FLOW_SERIES_MAX);
  assert.equal(s[0].burns, 25);
  assert.equal(appendSeries([null, { t: 'x' }, { t: 5, burns: 1 }], { t: 9000, burns: 2 }).length, 2, 'a corrupt entry is dropped, the rest kept');
});

test('the feed carries the history inside the window and a little before it, so the picture starts from a known value', () => {
  const series = [{ t: h(60), burns: 1 }, { t: h(24.5), burns: 2 }, { t: h(10), burns: 3 }, { t: h(1), burns: 4 }];
  const f = buildFlow({ reading, status, series, now: NOW });
  assert.deepEqual(f.series.map((p) => p.burns), [2, 3, 4]);
  assert.equal(f.windowSec, FLOW_WINDOW_SEC);
});

test('an explicit null is absent, not zero: an unreadable minted count must not read as nothing minted', () => {
  const p = flowPoint({ reading: {}, status: { bridgeBurns: 43, bridgeMinted: null, attestedHeight: null, burnDeposits: null }, now: NOW });
  assert.equal(p.burns, 43); assert.equal(p.minted, null); assert.equal(p.att, null);
  const f = buildFlow({ reading: { link: { crossOuts: null } }, status: { bridgeMinted: null, burnDeposits: '' }, series: [], now: NOW });
  assert.equal(f.now.minted, null); assert.equal(f.now.crossOuts, null); assert.equal(f.now.burnDeposits, null);
  assert.equal(flowPoint({ reading: {}, status: { bridgeMinted: 0 }, now: NOW }).minted, 0, 'a real zero is still zero');
});

test('a point reads the reflection status first and falls back to the reading\'s copy of it', () => {
  assert.equal(flowPoint({ reading, status: { bridgeBurns: 50, bridgeMinted: 40 }, now: NOW }).burns, 50);
  const p = flowPoint({ reading, status: null, now: NOW });
  assert.equal(p.burns, 43); assert.equal(p.minted, 32); assert.equal(p.out, 9); assert.equal(p.btc, 970_957);
  assert.equal(flowPoint({ reading: {}, status: null, now: NOW }).burns, null);
});
