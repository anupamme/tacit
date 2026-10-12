// The keeper history feed's lag figures: how far behind in time, and when that is worth a warning. node --test tests/feed-lag.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockSecOf, feedLagSec, feedLagLevel, FEED_LAG_WARN_SEC, FEED_LAG_CRIT_SEC } from '../src/lib/feed-lag.js';

test('seconds per block come from two timestamps a span apart', () => {
  assert.equal(blockSecOf(2000, 0, 1000), 2);
  assert.equal(blockSecOf(12_000, 0, 1000), 12);
  assert.ok(Math.abs(blockSecOf(100, 0, 1000) - 0.1) < 1e-12);
  assert.equal(blockSecOf(0, 0, 1000), null, 'no time between them is not a block time');
  assert.equal(blockSecOf(5, 10, 1000), null, 'nor is a negative one');
  assert.equal(blockSecOf('x', 0, 1000), null);
});

test('the lag is the blocks past the feed at the chain\'s block time', () => {
  assert.equal(feedLagSec({ through: 900, head: 1000, blockSec: 2 }), 200);
  assert.equal(feedLagSec({ through: 1000, head: 1000, blockSec: 2 }), 0);
  assert.equal(feedLagSec({ through: 1010, head: 1000, blockSec: 2 }), 0, 'a feed ahead of a node that lags is not behind');
  const base = feedLagSec({ through: 52_341_373, head: 52_508_016, blockSec: 2 });
  assert.ok(base > 3.8 * 86400 && base < 3.9 * 86400, `Base on 2026-10-12 was about 3.9 days behind (${(base / 86400).toFixed(2)} d)`);
});

test('a missing or odd figure gives no lag, never a zero', () => {
  assert.equal(feedLagSec({ through: null, head: 1000, blockSec: 2 }), null);
  assert.equal(feedLagSec({ through: NaN, head: 1000, blockSec: 2 }), null);
  assert.equal(feedLagSec({ through: 900, head: 1000, blockSec: null }), null);
  assert.equal(feedLagSec({ through: 900, head: 1000, blockSec: 0 }), null);
  assert.equal(feedLagLevel(null), null);
});

test('under an hour is fine, an hour is a warning, six hours is critical', () => {
  assert.equal(feedLagLevel(0), 'ok');
  assert.equal(feedLagLevel(FEED_LAG_WARN_SEC - 1), 'ok');
  assert.equal(feedLagLevel(FEED_LAG_WARN_SEC), 'warning');
  assert.equal(feedLagLevel(FEED_LAG_CRIT_SEC - 1), 'warning');
  assert.equal(feedLagLevel(FEED_LAG_CRIT_SEC), 'critical');
  assert.equal(feedLagLevel(4 * 86400), 'critical');
  assert.equal(feedLagLevel(30, { warn: 10, crit: 60 }), 'warning', 'the limits can be set');
});
