// lib/batch-window.js: the wait a lone op gets for company follows the arrival rate, never past maxWait, never when quiet.
// Run: node --test worker-relay/tests/batch-window.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBatchWindow } from '../src/lib/batch-window.js';

const clockAt = (t0) => { let t = t0; return { now: () => t, tick: (ms) => { t += ms; } }; };

test('a quiet queue holds nobody: no rate yet, or arrivals too far apart for the wait', () => {
  const c = clockAt(1_000_000_000);
  const w = makeBatchWindow({ maxWaitMs: 90_000, now: c.now });
  assert.equal(w.wait({ pending: 1 }), 0, 'nothing seen yet');
  w.seen('a'); c.tick(6 * 60_000); w.seen('b'); c.tick(6 * 60_000); w.seen('c');   // ~10 an hour
  assert.ok(w.ratePerHour() > 8 && w.ratePerHour() < 20, String(w.ratePerHour()));
  assert.equal(w.wait({ pending: 1 }), 0, 'the next op is minutes away: do not hold this one');
  assert.equal(w.wait({ pending: 0 }), 0);
  assert.equal(w.wait({ pending: 16, batchMax: 16 }), 0, 'a full batch goes at once');
});

test('busy: the wait is the expected gap, less what the oldest op already waited, halved once two are queued, capped at maxWait', () => {
  const c = clockAt(2_000_000_000);
  const w = makeBatchWindow({ maxWaitMs: 90_000, now: c.now });
  for (let i = 0; i < 20; i++) { w.seen(`j${i}`); c.tick(30_000); }           // one every 30 s
  const rate = w.ratePerHour();
  assert.ok(rate > 100 && rate < 130, String(rate));
  const gap = 3_600_000 / rate;
  assert.equal(w.wait({ pending: 1, oldestPendingSec: 0 }), Math.round(gap));
  assert.equal(w.wait({ pending: 1, oldestPendingSec: 10 }), Math.round(gap - 10_000));
  assert.equal(w.wait({ pending: 1, oldestPendingSec: 60 }), 0, 'waited long enough');
  assert.equal(w.wait({ pending: 2, oldestPendingSec: 0 }), Math.round(gap / 2), 'company already there: half the window');
  const fast = makeBatchWindow({ maxWaitMs: 20_000, now: c.now });
  for (let i = 0; i < 20; i++) { fast.seen(`k${i}`); c.tick(30_000); }
  assert.equal(fast.wait({ pending: 1 }), 0, 'a 30 s gap is past a 20 s cap: no wait');
  const cap = makeBatchWindow({ maxWaitMs: 90_000, now: c.now });
  for (let i = 0; i < 100; i++) { cap.seen(`m${i}`); c.tick(5_000); }          // one every 5 s
  assert.equal(cap.wait({ pending: 1 }), Math.round(3_600_000 / cap.ratePerHour()));
  assert.ok(cap.wait({ pending: 1 }) <= 90_000);
});

test('arrivals older than the horizon fall out, and a job counts once', () => {
  const c = clockAt(3_000_000_000);
  const w = makeBatchWindow({ maxWaitMs: 90_000, horizonMs: 60 * 60_000, now: c.now });
  for (let i = 0; i < 10; i++) { w.seen(`a${i}`); w.seen(`a${i}`); c.tick(20_000); }
  assert.equal(w.size(), 10);
  c.tick(2 * 60 * 60_000);
  assert.equal(w.ratePerHour(), 0, 'all out of the horizon');
  w.seen('fresh');
  assert.equal(w.size(), 1, 'the old ones were dropped');
});
