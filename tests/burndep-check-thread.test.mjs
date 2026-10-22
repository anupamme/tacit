// POST /reflection/burndep/check off the main thread: the route hands the check to env.burnDepositCheckOffThread when the
// server provides one (server/burndep-check-thread.mjs) and answers with what comes back, the check's own refusals still
// come inline without one, and the thread gate lets one check run with a short queue behind it.
// Run: node --test tests/burndep-check-thread.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { burnDepositCheckOutcome } from '../worker/src/index.js';
import { EventEmitter } from 'node:events';
import { makeGate, runBurnDepositCheck, checkLimitMs, hopsOf, CHECK_CEILING_MS } from '../server/burndep-check-thread.mjs';
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

// A burn reveal as the page builds it: one input (the burn address), one output, and the 161-byte burn envelope in the script the
// input's witness reveals. `sig` stands for the signature, which a page draws fresh each time it signs.
const burnHex = ({ prev = 'ab'.repeat(32), nullifier = 'cd'.repeat(32), sig = '11' }) => {
  const env = '544143495401' + '2b' + '33'.repeat(32) + '00'.repeat(32) + nullifier + '44'.repeat(32) + '55'.repeat(32);   // the TACIT frame, then the burn
  const pushes = env.match(/.{1,150}/g).map((c) => (c.length / 2).toString(16).padStart(2, '0') + c).join('');
  const script = '20' + '22'.repeat(32) + 'ac' + '0063' + pushes + '68';
  const varint = (n) => (n < 0xfd ? n.toString(16).padStart(2, '0') : 'fd' + (n & 0xff).toString(16).padStart(2, '0') + (n >> 8).toString(16).padStart(2, '0'));
  return '0x02000000' + '0001' + '01' + prev.match(/../g).reverse().join('') + '00000000' + '00' + 'fdffffff'
    + '01' + '2202000000000000' + '22' + '5120' + '66'.repeat(32)
    + '03' + '40' + sig.repeat(64) + varint(script.length / 2) + script + '21' + 'c0' + '77'.repeat(32) + '00000000';
};

test('a burn signed again is the same check: the key is what the burn names, not its bytes', async () => {
  let runs = 0, finish;
  const env = {
    REGISTRY_KV: kv(),
    burnDepositCheckOffThread: () => { runs++; return new Promise((resolve) => { finish = () => resolve({ status: 200, body: { ok: true, admitted: true } }); }); },
  };
  const ask = (body) => worker.fetch(new Request('https://api.tacit.finance/reflection/burndep/check?network=mainnet', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify(body) }), env);
  const bundle = { burned: { cx: '0x' + '44'.repeat(32), cy: '0x' + '55'.repeat(32) } };
  const first = burnHex({ sig: '11' }), again = burnHex({ sig: '99' });
  assert.notEqual(first, again, 'the two burns differ in their signature');
  const a = ask({ bundle, assetId: '0x' + '33'.repeat(32), burnTxHex: first }), b = ask({ bundle, assetId: '0x' + '33'.repeat(32), burnTxHex: again });
  await new Promise((r) => setTimeout(r, 50));
  finish();
  assert.equal((await a).status, 200); assert.equal((await b).status, 200);
  assert.equal(runs, 1, 'one check ran for both');
  const later = await ask({ bundle, assetId: '0x' + '33'.repeat(32), burnTxHex: burnHex({ sig: '55' }) });
  assert.equal(later.status, 200);
  assert.equal(runs, 1, 'a burn signed a third time reads the kept answer');
  const other = ask({ bundle, assetId: '0x' + '33'.repeat(32), burnTxHex: burnHex({ nullifier: 'ee'.repeat(32) }) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs, 2, 'a burn naming another nullifier is another check');
  const elsewhere = ask({ bundle, assetId: '0x' + '33'.repeat(32), burnTxHex: burnHex({ prev: 'ef'.repeat(32) }) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs, 3, 'and so is a burn spending another outpoint');
  finish(); await other; await elsewhere;
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
    assert.equal(runs, 1, 'a check still in line after half an hour is still in line: the queue ahead of it may hold four long checks');
    skew = 106 * 60_000;
    await Promise.race([post(env, body), new Promise((r) => setTimeout(r, 5500))]);
    assert.equal(runs, 2, 'an entry pending past the longest honest wait no longer holds its asker');
  } finally { Date.now = real; }
});

test('a history longer than the door takes is refused at once: no place in line, no token, and the thread is never asked', async () => {
  let runs = 0;
  const env = { REGISTRY_KV: kv(), BURNDEP_CHECK_RL_BURST: '1', burnDepositCheckOffThread: () => { runs++; return new Promise(() => {}); } };
  const burned = { cx: '0x' + '12'.repeat(32), cy: '0x' + '34'.repeat(32) };
  const rec = { blockHash: '56'.repeat(32), tx: '00' };
  for (const field of ['cxfers', 'cmints']) {
    const r = await post(env, { bundle: { burned, [field]: Array.from({ length: 257 }, () => rec) }, burnTxHex: '0x' + 'ab'.repeat(40) });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, `bundle.${field} has 257 hops (max 256)`);
  }
  const out = await burnDepositCheckOutcome({ REGISTRY_KV: kv() }, 'mainnet', { bundle: { burned, cxfers: Array.from({ length: 300 }, () => rec) }, burnTxHex: '0x' + 'ab'.repeat(40) });
  assert.equal(out.status, 400); assert.match(out.body.error, /300 hops \(max 256\)/);
  assert.equal(runs, 0, 'nothing reached the thread');
  const fine = await Promise.race([post(env, { bundle: { burned, cxfers: Array.from({ length: 256 }, () => rec) }, burnTxHex: '0x' + 'ac'.repeat(40) }), new Promise((r) => setTimeout(() => r({ status: 'pending' }), 150))]);
  assert.equal(fine.status, 'pending', 'the most the door takes is checked, and spent no token on the refusals before it');
  assert.equal(runs, 1);
});

test('a check is given time for its history: the least, more for a deeper one, and never past the ceiling', () => {
  const l = { floor: 360_000, base: 90_000, perHop: 4_000, ceiling: 1_500_000 };
  assert.equal(checkLimitMs(0, l), 360_000);
  assert.equal(checkLimitMs(18, l), 360_000, 'a short history keeps the old six minutes');
  assert.equal(checkLimitMs(132, l), 90_000 + 132 * 4_000, 'a hundred and thirty-one transfers (the etch counted) get over nine minutes, not six');
  assert.equal(checkLimitMs(257, l), 1_118_000);
  assert.equal(checkLimitMs(5_000, l), 1_500_000, 'nothing runs past the ceiling');
  assert.equal(checkLimitMs('x', l), 360_000);
  assert.ok(CHECK_CEILING_MS >= 25 * 60_000 - 1 || process.env.BURNDEP_CHECK_CEILING_MS);
  assert.equal(hopsOf({ bundle: { etch: {}, cxfers: [1, 2, 3], cmints: [4] } }), 5);
  assert.equal(hopsOf({}), 0);
});

// A stand-in for the worker thread: what it posts, and whether it was stopped.
function fakeThread(script) {
  const w = new EventEmitter();
  w.stopped = false;
  w.terminate = () => { w.stopped = true; };
  setImmediate(() => script(w));
  return w;
}
const quiet = async (fn) => { const real = console.log, lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return await fn(lines); } finally { console.log = real; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { floor: 250, base: 0, perHop: 0, ceiling: 250, watch: 10, stall: 100 };

test('a check that runs says what it is doing, and what it says reaches the caller\'s snapshot', async () => {
  await quiet(async () => {
    const progress = {};
    const seen = [];
    const run = runBurnDepositCheck('mainnet', { bundle: { cxfers: [1, 2] } }, progress, { limits: FAST, spawn: () => fakeThread(async (w) => {
      seen.push(progress.snapshot());
      w.emit('message', { progress: { phase: 'reading', done: 1, total: 3 } });
      seen.push(progress.snapshot());
      await wait(30);
      w.emit('message', { progress: { phase: 'verifying', total: 3 } });
      seen.push(progress.snapshot());
      w.emit('message', { out: { status: 200, body: { ok: true, admitted: true }, timing: { hops: 2, enrichMs: 1, headersMs: 1, admitMs: 1 } } });
    }) });
    const out = await run;
    assert.equal(out.status, 200); assert.equal(out.body.admitted, true);
    assert.deepEqual(seen[0], { state: 'running', ahead: 0, queuedSec: 0, runningSec: 0 }, 'before it says anything there is no phase');
    assert.deepEqual([seen[1].phase, seen[1].done, seen[1].total], ['reading', 1, 3]);
    assert.deepEqual([seen[2].phase, seen[2].done, seen[2].total], ['verifying', 1, 3], 'a phase without a count keeps the last one');
    assert.equal(progress.snapshot().phase, undefined, 'once done it says nothing of a phase');
  });
});

test('a check past its time is stopped, answers 504 and says where it was', async () => {
  await quiet(async (lines) => {
    let thread;
    const t0 = Date.now();
    const out = await runBurnDepositCheck('mainnet', { bundle: { cxfers: [1] } }, {}, { limits: { ...FAST, stall: 10_000 }, spawn: () => (thread = fakeThread((w) => w.emit('message', { progress: { phase: 'verifying', total: 2 } }))) });
    assert.equal(out.status, 504); assert.match(out.body.error, /took longer than/);
    assert.ok(thread.stopped, 'the thread was ended');
    assert.ok(Date.now() - t0 >= 240, 'not before its time');
    assert.ok(lines.some((l) => /stopped .*limit 0s for 1 transactions; verifying/.test(l)), lines.join(' | '));
  });
});

test('a check that is reading and has read nothing new for too long is stopped, one that keeps reading is not, and verifying is not judged by it', async () => {
  await quiet(async (lines) => {
    const long = { ...FAST, floor: 5_000, ceiling: 5_000 };
    let thread;
    const stalled = await runBurnDepositCheck('mainnet', { bundle: { cxfers: [1] } }, {}, { limits: long, spawn: () => (thread = fakeThread((w) => w.emit('message', { progress: { phase: 'reading', done: 4, total: 9 } }))) });
    assert.equal(stalled.status, 504); assert.match(stalled.body.error, /not coming in/);
    assert.ok(thread.stopped);
    assert.ok(lines.some((l) => /stopped .*no transaction read for .*; reading 4 of 9/.test(l)), lines.join(' | '));

    const moving = await runBurnDepositCheck('mainnet', { bundle: { cxfers: [1] } }, {}, { limits: long, spawn: () => fakeThread(async (w) => {
      for (let i = 1; i <= 8; i++) { w.emit('message', { progress: { phase: 'reading', done: i, total: 8 } }); await wait(40); }
      w.emit('message', { out: { status: 200, body: { ok: true, admitted: true } } });
    }) });
    assert.equal(moving.status, 200, 'a check that reads one transaction after another outlasts the stall time');

    const verifying = await runBurnDepositCheck('mainnet', { bundle: { cxfers: [1] } }, {}, { limits: long, spawn: () => fakeThread(async (w) => {
      w.emit('message', { progress: { phase: 'verifying', total: 1 } });
      await wait(350);
      w.emit('message', { out: { status: 200, body: { ok: true, admitted: true } } });
    }) });
    assert.equal(verifying.status, 200, 'verifying is one long step with nothing to report, and is held to the time limit only');
  });
});

test('the registration and the check take a bundle far above the anonymous ceiling, and other routes keep it', () => {
  const req = (url) => ({ url, headers: {} });
  assert.equal(maxRequestBytes({}, req('/reflection/burndep/check?network=mainnet')), BURNDEP_MAX_BYTES);
  assert.equal(maxRequestBytes({}, req('/reflection/burndep?network=mainnet')), BURNDEP_MAX_BYTES);
  assert.equal(maxRequestBytes({}, req('/reflection/burndep/trace?network=mainnet')), DEFAULT_MAX_ANON_REQUEST_BYTES);
  assert.equal(maxRequestBytes({}, req('/confidential/submit')), DEFAULT_MAX_ANON_REQUEST_BYTES);
  assert.ok(BURNDEP_MAX_BYTES >= 4 * DEFAULT_MAX_ANON_REQUEST_BYTES);
});
