// The reflection request's price cap (src/lib/reflect-price-cap.js): carried while capped requests are filled, dropped for one request
// once they have gone unfilled for the wait, and started over by a fill or by that uncapped try.
// node --test tests/reflect-price-cap.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReflectPriceCap } from '../src/lib/reflect-price-cap.js';

const MIN = 60_000;

test('no cap set: every request goes without one', () => {
  for (const capWei of [0, undefined, -1, 1.5]) assert.equal(makeReflectPriceCap({ capWei }).cap(0), '0');
});

test('capped while filled; unfilled for the wait, the next request goes uncapped, then capped again', () => {
  const p = makeReflectPriceCap({ capWei: 300_000_000, waitSecs: 20 * 60 });
  assert.equal(p.cap(0), '300000000');
  p.settled({ capped: true, filled: true }, 0);
  assert.equal(p.cap(1 * MIN), '300000000');
  // Capped requests go unfilled from minute 1: still capped until the window has run.
  p.settled({ capped: true, filled: false }, 1 * MIN);
  p.settled({ capped: true, filled: false }, 5 * MIN);
  assert.equal(p.cap(20 * MIN), '300000000', 'the window runs from the first miss');
  assert.equal(p.cap(21 * MIN), '0', 'twenty minutes of misses: this one goes uncapped');
  // The uncapped try, filled or not, starts the window over.
  p.settled({ capped: false, filled: false }, 22 * MIN);
  assert.equal(p.cap(23 * MIN), '300000000');
  p.settled({ capped: true, filled: false }, 24 * MIN);
  p.settled({ capped: true, filled: true }, 30 * MIN);
  assert.equal(p.cap(50 * MIN), '300000000', 'a capped fill clears the misses');
});
