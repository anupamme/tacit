#!/usr/bin/env node
// POST /reflection/burndep keeps a registration until a bundle that passes admission replaces it: an identical bundle is a
// no-op, a different one that does not pass leaves the stored one alone, and one that passes takes its place.
//   node tests/burndep-register-replace.test.mjs
import assert from 'node:assert';
import worker from '../worker/src/index.js';

const TXID = 'ab'.repeat(32);
const realFetch = globalThis.fetch;
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };

function makeKv() { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; }
const bundle = (tag) => ({ etch: { blockHeight: 100 }, tag });
const keyOf = `reflection:burndep:mainnet:${TXID}`;

// The explorer answers the burn's hex (the check itself is stubbed through the worker-thread hook).
function explorer(found = true) {
  globalThis.fetch = async (url) => (String(url).endsWith('/hex') && found
    ? new Response('00'.repeat(20), { status: 200 })
    : new Response('not found', { status: 404 }));
}
async function register(env, b, ip = null) {
  const headers = { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) };
  return worker.fetch(new Request('https://api.test/reflection/burndep?network=mainnet', { method: 'POST', headers, body: JSON.stringify({ burnTxidDisplay: TXID, bundle: b }) }), env, { waitUntil() {} });
}
const envWith = (admitted, kv = makeKv()) => {
  const calls = [];
  return { env: { REGISTRY_KV: kv, burnDepositCheckOffThread: async (network, body) => { calls.push(body); return { status: 200, body: { ok: true, admitted } }; } }, kv, calls };
};

try {
  explorer();
  // First registration is stored as given, and the same bundle again is a no-op without a check.
  {
    const { env, kv, calls } = envWith(false);
    ok((await register(env, bundle('a'))).status === 200, 'a first registration is stored');
    ok((await register(env, bundle('a'))).status === 200 && calls.length === 0, 'the same bundle again is accepted without a check');
    ok(kv.m.get(keyOf) === JSON.stringify(bundle('a')), 'the stored bundle is the one registered');
  }
  // A different bundle that does not pass admission leaves the stored one in place.
  {
    const { env, kv, calls } = envWith(false);
    await register(env, bundle('stored'));
    const res = await register(env, bundle('other'));
    ok(res.status === 409, 'a different bundle that is not admitted is refused');
    ok(kv.m.get(keyOf) === JSON.stringify(bundle('stored')), 'the stored bundle is unchanged');
    ok(calls.length === 1 && typeof calls[0].burnTxHex === 'string' && calls[0].burnTxHex.startsWith('0x'), 'the check ran on the burn read from the explorer');
  }
  // A bundle that passes admission replaces one that was stored first.
  {
    const { env, kv } = envWith(true);
    await register(env, bundle('stored'));
    const res = await register(env, bundle('admitted'));
    ok(res.status === 200, 'a bundle that passes admission is accepted over the stored one');
    ok(kv.m.get(keyOf) === JSON.stringify(bundle('admitted')), 'the admitted bundle is now the stored one');
  }
  // The burn is not visible on the explorer yet: nothing is replaced.
  {
    explorer(false);
    const { env, kv } = envWith(true);
    await register(env, bundle('stored'));
    const res = await register(env, bundle('other'));
    ok(res.status === 409 && kv.m.get(keyOf) === JSON.stringify(bundle('stored')), 'without the burn on the explorer the stored bundle stands');
    explorer();
  }
  // Replacement checks are rate limited per client.
  {
    const { env } = envWith(false);
    await register(env, bundle('stored'), '203.0.113.7');
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await register(env, bundle(`x${i}`), '203.0.113.7')).status);
    ok(codes.slice(0, 3).every((c) => c === 409) && codes.slice(3).every((c) => c === 429), `replacement checks are limited per client (${codes.join(',')})`);
  }
} finally { globalThis.fetch = realFetch; }
console.log(`${n} checks`);
