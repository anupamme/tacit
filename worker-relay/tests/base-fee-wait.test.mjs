// When a ready batch of headers waits for a cheaper block: only above the recent norm, only for a bounded time, never on no data.
// node --test tests/base-fee-wait.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { percentileOf, headerTimeSec, baseFeeWait } from '../src/lib/base-fee-wait.js';

const G = 1_000_000_000n;
const flat = (g, n = 200) => Array.from({ length: n }, () => BigInt(Math.round(g * 1e9)));

test('a percentile is read from the sorted list, as a bigint, and an empty list has none', () => {
  assert.equal(percentileOf([5n, 1n, 3n, 2n, 4n], 0), 1n);
  assert.equal(percentileOf([5n, 1n, 3n, 2n, 4n], 50), 3n);
  assert.equal(percentileOf([5n, 1n, 3n, 2n, 4n], 100), 5n);
  assert.equal(percentileOf(['10', 20, 30n], 50), 20n, 'strings and numbers read as numbers');
  assert.equal(percentileOf([], 40), null);
  assert.equal(percentileOf(null, 40), null);
  assert.equal(percentileOf([1n, null, 3n], 100), 3n, 'a missing entry is left out');
});

test('a header\'s time is its bytes 68..72, little-endian', () => {
  const h = '00'.repeat(68) + '80d35b67' + '00'.repeat(8);          // 0x675bd380 = 1734333312
  assert.equal(h.length, 160);
  assert.equal(headerTimeSec(h), 0x675bd380);
  assert.equal(headerTimeSec('0x' + h), 0x675bd380);
  assert.equal(headerTimeSec('ab'), null);
  assert.equal(headerTimeSec(null), null);
});

test('above the recent norm, a ready batch waits; at or under it, it goes', () => {
  const history = [...flat(0.06, 120), ...flat(0.2, 80)];            // 40th percentile is 0.06 gwei
  assert.deepEqual(baseFeeWait({ history, nextBase: 3n * G / 10n, readyAgeSec: 600 }), { wait: true, ref: 60_000_000n, why: 'above what recent blocks paid' });
  assert.equal(baseFeeWait({ history, nextBase: 60_000_000n, readyAgeSec: 600 }).wait, false, 'equal to the norm goes');
  assert.equal(baseFeeWait({ history, nextBase: 50_000_000n, readyAgeSec: 600 }).wait, false);
});

test('the wait is bounded: a batch that has been ready long enough goes at any price', () => {
  const history = flat(0.06);
  assert.equal(baseFeeWait({ history, nextBase: 5n * G, readyAgeSec: 7199 }).wait, true);
  const late = baseFeeWait({ history, nextBase: 5n * G, readyAgeSec: 7200 });
  assert.equal(late.wait, false); assert.equal(late.why, 'waited long enough');
  assert.equal(baseFeeWait({ history, nextBase: 5n * G, readyAgeSec: 90, maxWaitSec: 60 }).wait, false, 'the bound can be set');
});

test('no reading never holds a batch', () => {
  assert.equal(baseFeeWait({ history: [], nextBase: 5n * G, readyAgeSec: 10 }).wait, false);
  assert.equal(baseFeeWait({ history: flat(0.06, 10), nextBase: 5n * G, readyAgeSec: 10 }).wait, false, 'ten blocks is not a norm');
  assert.equal(baseFeeWait({ history: null, nextBase: 5n * G, readyAgeSec: 10 }).wait, false);
  assert.equal(baseFeeWait({ history: flat(0.06), nextBase: null, readyAgeSec: 10 }).wait, false);
  assert.equal(baseFeeWait({ history: flat(0.06), nextBase: 5n * G, readyAgeSec: NaN }).wait, false, 'an age that cannot be read is not a reason to wait');
});

test('the ratio and percentile move the line', () => {
  const history = [...flat(0.06, 120), ...flat(0.2, 80)];
  assert.equal(baseFeeWait({ history, nextBase: 70_000_000n, readyAgeSec: 10, ratio: 1.2 }).wait, false, '0.07 is under 1.2 x 0.06');
  assert.equal(baseFeeWait({ history, nextBase: 70_000_000n, readyAgeSec: 10, ratio: 1 }).wait, true);
  assert.equal(baseFeeWait({ history, nextBase: 70_000_000n, readyAgeSec: 10, percentile: 90 }).wait, false, 'a high percentile is a high line');
});
