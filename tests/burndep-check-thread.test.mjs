// POST /reflection/burndep/check off the main thread: the route hands the check to env.burnDepositCheckOffThread when the
// server provides one (server/burndep-check-thread.mjs) and answers with what comes back, the check's own refusals still
// come inline without one, and the thread gate lets one check run with a short queue behind it.
// Run: node --test tests/burndep-check-thread.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { burnDepositCheckOutcome } from '../worker/src/index.js';
import { makeGate } from '../server/burndep-check-thread.mjs';
import { maxRequestBytes, BURNDEP_MAX_BYTES, DEFAULT_MAX_ANON_REQUEST_BYTES } from '../server/harness.mjs';

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

test('the same check asked again joins the one running, then reads its answer, and neither spends a rate-limit token', async () => {
  let runs = 0, finish;
  const env = {
    REGISTRY_KV: kv(), BURNDEP_CHECK_RL_BURST: '1',
    burnDepositCheckOffThread: () => { runs++; return new Promise((resolve) => { finish = () => resolve({ status: 200, body: { ok: true, admitted: true } }); }); },
  };
  const ask = (body) => worker.fetch(new Request('https://api.tacit.finance/reflection/burndep/check?network=mainnet', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  const body = { bundle: { burned: { cx: '0x' + '44'.repeat(32), cy: '0x' + '55'.repeat(32) } }, burnTxHex: '0x' + '66'.repeat(40) };
  const first = ask(body), second = ask(body);
  await new Promise((r) => setTimeout(r, 50));
  finish();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(runs, 1, 'one check ran for both asks');
  const third = await ask(body);
  assert.equal(third.status, 200); assert.equal((await third.json()).admitted, true);
  assert.equal(runs, 1, 'a later ask reads the kept answer');
  const other = await ask({ ...body, burnTxHex: '0x' + '77'.repeat(40) });
  assert.equal(other.status, 429, 'a new check is still rate limited');
  assert.match((await other.json()).error, /too many check requests/);
});

test('a busy or failed check is not kept: the next ask starts it again', async () => {
  const outs = [{ status: 429, body: { ok: false, error: 'the check is busy with other lineages; retry in a moment', retryAfter: 15 }, retryAfter: 15 }, { status: 200, body: { ok: true, admitted: true } }];
  let runs = 0;
  const env = { REGISTRY_KV: kv(), burnDepositCheckOffThread: async () => outs[runs++] };
  const body = { bundle: { burned: { cx: '0x' + '88'.repeat(32), cy: '0x' + '99'.repeat(32) } }, burnTxHex: '0x' + 'aa'.repeat(40) };
  assert.equal((await post(env, body)).status, 429);
  await new Promise((r) => setTimeout(r, 0));
  const r = await post(env, body);
  assert.equal(r.status, 200); assert.equal(runs, 2);
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

test('a ticket is told how many checks stand before it, and one owner cannot hold more than its share of places', async () => {
  const g = makeGate({ max: 3, perOwner: 2 });
  const a = { owner: '203.0.113.1' }, b = { owner: '203.0.113.1' }, c = { owner: '203.0.113.1' }, d = { owner: '203.0.113.2' }, e = { owner: '203.0.113.3' };
  const ra = await g.enter(a); assert.equal(g.ahead(a), 0, 'the running check has nothing ahead');
  const pb = g.enter(b), pd = g.enter(d), pe = g.enter(e);
  assert.equal(g.ahead(b), 1); assert.equal(g.ahead(d), 2); assert.equal(g.ahead(e), 3);
  assert.equal(await g.enter(c), null, 'a third place for the same owner is refused');
  assert.equal(await g.enter({ owner: 'anon' }), null, 'the queue is full for anyone');
  ra();
  const rb = await pb; assert.equal(g.ahead(d), 1);
  const pc = g.enter(c);
  assert.equal(await g.enter({ owner: '203.0.113.1' }), null, 'running and waiting, the owner is at its share again');
  rb();
  const rd = await pd; rd();
  const re = await pe; re();
  const rc = await pc; assert.equal(typeof rc, 'function', 'a place the owner freed is its to ask for again'); rc();
  assert.equal(g.busy, false);
});

test('a pending answer says where the check stands, and a check pending past the longest honest wait is started afresh', async () => {
  let runs = 0, snap = { state: 'queued', ahead: 2, queuedSec: 40, runningSec: 0 };
  const env = {
    REGISTRY_KV: kv(), BURNDEP_CHECK_ANSWER_MS: '5000',
    burnDepositCheckOffThread: (_network, _body, progress) => { runs++; progress.snapshot = () => snap; return new Promise(() => {}); },
  };
  const body = { bundle: { burned: { cx: '0x' + 'ab'.repeat(32), cy: '0x' + 'cd'.repeat(32) } }, burnTxHex: '0x' + 'ee'.repeat(40) };
  const real = Date.now; let skew = 0; Date.now = () => real() + skew;
  try {
    const first = await Promise.race([post(env, body), new Promise((r) => setTimeout(() => r(null), 6000))]);
    assert.equal(first.status, 202);
    const j = await first.json();
    assert.equal(j.pending, true);
    assert.deepEqual(j.progress, { state: 'queued', ahead: 2, queuedSec: 40, runningSec: 0 });
    snap = { state: 'running', ahead: 0, queuedSec: 40, runningSec: 12 };
    assert.equal(runs, 1);
    skew = 31 * 60_000;
    await Promise.race([post(env, body), new Promise((r) => setTimeout(r, 5500))]);
    assert.equal(runs, 2, 'an entry pending for over half an hour no longer holds its asker');
  } finally { Date.now = real; }
});

test('the registration and the check take a bundle far above the anonymous ceiling, and other routes keep it', () => {
  const req = (url) => ({ url, headers: {} });
  assert.equal(maxRequestBytes({}, req('/reflection/burndep/check?network=mainnet')), BURNDEP_MAX_BYTES);
  assert.equal(maxRequestBytes({}, req('/reflection/burndep?network=mainnet')), BURNDEP_MAX_BYTES);
  assert.equal(maxRequestBytes({}, req('/reflection/burndep/trace?network=mainnet')), DEFAULT_MAX_ANON_REQUEST_BYTES);
  assert.equal(maxRequestBytes({}, req('/confidential/submit')), DEFAULT_MAX_ANON_REQUEST_BYTES);
  assert.ok(BURNDEP_MAX_BYTES >= 4 * DEFAULT_MAX_ANON_REQUEST_BYTES);
});
