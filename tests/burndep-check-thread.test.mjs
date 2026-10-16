// POST /reflection/burndep/check off the main thread: the route hands the check to env.burnDepositCheckOffThread when the
// server provides one (server/burndep-check-thread.mjs) and answers with what comes back, the check's own refusals still
// come inline without one, and the thread gate lets one check run with a short queue behind it.
// Run: node --test tests/burndep-check-thread.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { burnDepositCheckOutcome } from '../worker/src/index.js';
import { makeGate } from '../server/burndep-check-thread.mjs';

const kv = () => { const m = new Map(); return { async get(k, t) { if (!m.has(k)) return null; return t === 'json' ? JSON.parse(m.get(k)) : m.get(k); }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };
const post = (env, body) => worker.fetch(new Request('https://api.tacit.finance/reflection/burndep/check?network=mainnet', { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://tacit.finance' }, body: JSON.stringify(body) }), env, { waitUntil() {} });

test('with a thread runner the route hands the body over and answers with its status, body and Retry-After', async () => {
  const seen = [];
  const env = { REGISTRY_KV: kv(), burnDepositCheckOffThread: async (network, body) => { seen.push({ network, body }); return { status: 429, body: { ok: false, error: 'busy', retryAfter: 15 }, retryAfter: 15 }; } };
  const r = await post(env, { bundle: { burned: { cx: '0x' + '11'.repeat(32), cy: '0x' + '22'.repeat(32) } }, note: { txid: 'ab'.repeat(32), vout: 0 }, assetId: '0x' + '33'.repeat(32) });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '15');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { ok: false, error: 'busy', retryAfter: 15 });
  assert.equal(seen.length, 1); assert.equal(seen[0].network, 'mainnet'); assert.equal(seen[0].body.note.vout, 0);
});

test('without a runner the check runs inline: a bad bundle is refused the same way, as a plain outcome too', async () => {
  const env = { REGISTRY_KV: kv() };
  const r = await post(env, { bundle: {} });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /bundle\.burned/);
  const out = await burnDepositCheckOutcome(env, 'mainnet', { bundle: { burned: { cx: '0x' + '11'.repeat(32), cy: '0x' + '22'.repeat(32) } } });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /exactly one of burnTxHex/);
  assert.equal('headers' in out, false);
});

test('the gate runs one check at a time, queues a few, and turns the rest away', async () => {
  const g = makeGate({ max: 2 });
  const a = await g.enter(); assert.equal(typeof a, 'function'); assert.equal(g.busy, true);
  const pb = g.enter(), pc = g.enter();
  assert.equal(g.waiting, 2);
  assert.equal(await g.enter(), null, 'a fourth is turned away');
  a();
  const b = await pb; assert.equal(typeof b, 'function'); assert.equal(g.waiting, 1);
  b();
  const c = await pc; assert.equal(typeof c, 'function'); assert.equal(g.waiting, 0);
  c();
  assert.equal(g.busy, false);
  const d = await g.enter(); assert.equal(typeof d, 'function'); d();
});
