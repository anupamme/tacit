// node --test tests/ledger-restore.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLedger } from '../src/lib/income-ledger.js';
import { makeBooksRestorer } from '../src/lib/ledger-restore.js';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const books = { since: new Date(T0 - 3600e3).toISOString(), owedWei: '7', pendingUsd: 0, days: { '2026-10-15': { settled: 4 } } };
const quick = { sleep: async () => {}, tries: 3 };

test('the books come back on the first answer, and the heartbeat may then carry the ledger', async () => {
  const ledger = makeLedger({ now: () => T0 });
  const r = makeBooksRestorer({ ledger, fetchBooks: async () => ({ ledger: books }), ...quick });
  assert.equal(r.ready(), false, 'not before it has asked');
  assert.equal(await r.start(), true);
  assert.equal(r.ready(), true);
  assert.equal(ledger.snapshot().days['2026-10-15'].settled, 4);
});

test('nothing stored, or a worker without the route, counts as answered', async () => {
  const ledger = makeLedger({ now: () => T0 });
  const r = makeBooksRestorer({ ledger, fetchBooks: async () => ({}), ...quick });
  assert.equal(await r.start(), true);
  assert.equal(r.ready(), true);
  assert.deepEqual(ledger.snapshot().days, {});
});

test('a worker that cannot be asked is tried again a few times, then in the background, and the ledger stays out meanwhile', async () => {
  const ledger = makeLedger({ now: () => T0 });
  let calls = 0, later = null;
  const r = makeBooksRestorer({ ledger, fetchBooks: async () => (++calls < 5 ? null : { ledger: books }), ...quick, schedule: (fn) => { later = fn; } });
  assert.equal(await r.start(), false);
  assert.equal(calls, 3);
  assert.equal(r.ready(), false, 'the heartbeat leaves the ledger out, so the stored books are not overwritten');
  await later(); assert.equal(r.ready(), false); assert.equal(calls, 4);
  await later(); assert.equal(r.ready(), true); assert.equal(calls, 5);
  assert.equal(ledger.snapshot().days['2026-10-15'].settled, 4, 'and they are added to what was counted meanwhile');
  later = null; await r.start(); assert.equal(calls, 5, 'once ready it does not ask again');
});

test('a fetch that throws is the same as one that could not be asked, and nothing escapes', async () => {
  const ledger = makeLedger({ now: () => T0 });
  const r = makeBooksRestorer({ ledger, fetchBooks: async () => { throw new Error('boom'); }, ...quick, schedule: () => {} });
  assert.equal(await r.start(), false);
  assert.equal(r.ready(), false);
});
