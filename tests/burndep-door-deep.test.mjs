#!/usr/bin/env node
// A history as long as the reflection guest folds (256 transfers) is registered; one more is refused at the door. A trace that
// runs past its time answers 202 with how far it got, keeping what it read, instead of running into the gateway's timeout.
//   node tests/burndep-door-deep.test.mjs
import { readFileSync } from 'node:fs';
import worker from '../worker/src/index.js';

const realFetch = globalThis.fetch;
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
function makeKv() { const m = new Map(); return { m, async get(k, t) { return m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; }
const post = (env, path, body) => worker.fetch(new Request(`https://api.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.9' }, body: JSON.stringify(body) }), env, { waitUntil() {} });

try {
  // ── the door ──
  {
    const hops = (k) => ({ etch: { blockHeight: 948242 }, cxfers: Array.from({ length: k }, () => ({ blockHeight: 950000 })) });
    const at256 = await post({ REGISTRY_KV: makeKv() }, '/reflection/burndep?network=mainnet', { burnTxidDisplay: 'ab'.repeat(32), bundle: hops(256) });
    ok(at256.status === 200, `a 256-transfer history is registered (${at256.status})`);
    const at257 = await post({ REGISTRY_KV: makeKv() }, '/reflection/burndep?network=mainnet', { burnTxidDisplay: 'ab'.repeat(32), bundle: hops(257) });
    const why = await at257.json();
    ok(at257.status === 400 && /has 257 hops \(max 256\)/.test(why.error), `257 is refused, naming the guest's limit (${why.error})`);
  }
  // ── the trace's time budget: the explorer answers slowly, so the first request runs out of its 5 s and says how far it got ──
  {
    const FIX = JSON.parse(readFileSync(new URL('./fixtures/burndep-listing-purchase-2026-10-16.json', import.meta.url), 'utf8'));
    const id = (p) => Object.keys(FIX).find((k) => k.startsWith(p));
    const PURCHASE = id('c654294c'), SPLIT_NOTE = id('57829e14'), TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
    const kv = makeKv();
    await kv.put(`asset:mainnet:${TAC}`, JSON.stringify({ asset_id: TAC, etch_txid: SPLIT_NOTE, etch_vout: 0, etched_at_height: 948242 }));
    let asked = 0;
    globalThis.fetch = async (url) => {
      const m = /\/tx\/([0-9a-f]{64})(\/hex)?$/.exec(new URL(String(url)).pathname);
      const rec = m && FIX[m[1]];
      if (!rec) return new Response('not found', { status: 404 });
      asked++;
      await new Promise((r) => setTimeout(r, 6_000)); // slower than the whole budget: the walk stops after its first part
      return new Response(m[2] ? rec.hex : rec.json, { status: 200 });
    };
    const env = { REGISTRY_KV: kv, BURNDEP_TRACE_BUDGET_MS: '5000', MAINNET_API: 'https://esplora.test/api' };
    const t0 = Date.now();
    const res = await post(env, '/reflection/burndep/trace?network=mainnet', { note: { txid: PURCHASE, vout: 0 }, assetId: TAC, maxDepth: 256 });
    const body = await res.json();
    ok(res.status === 202 && body.pending === true && Number.isInteger(body.read) && body.read >= 1 && body.retryAfter > 0,
      `a trace past its budget answers 202 with how far it got (${res.status} ${JSON.stringify(body).slice(0, 140)})`);
    ok(Date.now() - t0 < 30_000, 'and answers well inside a gateway timeout');
    ok([...kv.m.keys()].some((k) => k === `burndepshallow:mainnet:${PURCHASE}`), 'what it read is kept for the next request');
    ok(asked >= 1, `the explorer was asked (${asked})`);
  }
  // ── the check's time budget: a first check of a deep history reading its blocks answers 202 and goes on ──
  {
    let finished = false;
    const env = {
      REGISTRY_KV: makeKv(), BURNDEP_CHECK_ANSWER_MS: '5000',
      burnDepositCheckOffThread: () => new Promise((resolve) => setTimeout(() => { finished = true; resolve({ status: 200, body: { ok: true, admitted: true } }); }, 7_000)),
    };
    const t0 = Date.now();
    const res = await post(env, '/reflection/burndep/check?network=mainnet', { bundle: {}, burnTxHex: '0x00' });
    const body = await res.json();
    ok(res.status === 202 && body.pending === true && res.headers.get('retry-after') === '20' && Date.now() - t0 < 7_000 && !finished,
      `a check still running past its budget answers 202 before it is done (${res.status} ${JSON.stringify(body)})`);
    await new Promise((r) => setTimeout(r, 2_500));
    ok(finished, 'and the check itself runs on to the end');
    const quick = await post({ ...env, burnDepositCheckOffThread: async () => ({ status: 200, body: { ok: true, admitted: true } }) }, '/reflection/burndep/check?network=mainnet', { bundle: {}, burnTxHex: '0x00' });
    ok(quick.status === 200 && (await quick.json()).admitted === true, 'a check that answers in time answers as before');
  }
} finally {
  globalThis.fetch = realFetch;
}
console.log(`\n${n} burndep door/trace checks${process.exitCode ? ' (some FAILED)' : ' passed'}`);
