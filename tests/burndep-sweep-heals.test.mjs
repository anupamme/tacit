#!/usr/bin/env node
// The ops sweep (sweepPendingBurnDeposits) leaves a burn whose stored registration passes admission for the next fold, and takes up one whose
// stored registration does not: it rebuilds the bundle instead of skipping the burn. Checks of stored registrations are limited to maxCount a call.
// The chain reads and the check are stood in; a rebuild that reaches the asset lookup (absent here) is as far as the test follows it.
//   node tests/burndep-sweep-heals.test.mjs
import assert from 'node:assert';
import { sweepPendingBurnDeposits } from '../worker/src/index.js';

const txid = (n) => n.toString(16).padStart(2, '0').repeat(32);
const records = [1, 2, 3].map((n) => ({ key: '0x' + txid(n + 10), burnedTxid: txid(n + 10), burnedVout: 0, burnTxidDisplay: txid(n), asset: '0x' + txid(99), completed: false }));
const kv = () => {
  const m = new Map([['reflection:scan:mainnet', JSON.stringify({ attestedHeight: 100, snapshot: { pendingDepositRecords: records } })]]);
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } };
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => (String(url).endsWith('/hex') ? new Response('00'.repeat(20), { status: 200 }) : new Response('not found', { status: 404 }));
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };

try {
  // A registered burn whose bundle passes admission is skipped, as before.
  {
    const store = kv(); store.m.set(`reflection:burndep:mainnet:${txid(1)}`, JSON.stringify({ etch: { blockHeight: 1 }, tag: 'good' }));
    const env = { REGISTRY_KV: store, burnDepositCheckOffThread: async () => ({ status: 200, body: { admitted: true } }) };
    const r = await sweepPendingBurnDeposits(env, 'mainnet', { maxCount: 1 });
    ok(r.checked === 1 && r.skipped >= 1 && r.attempted === 1, `an admitted registration is skipped (checked ${r.checked}, skipped ${r.skipped}, attempted ${r.attempted})`);
  }
  // One that does not pass is taken up: the sweep goes on to rebuild it.
  {
    const store = kv(); store.m.set(`reflection:burndep:mainnet:${txid(1)}`, JSON.stringify({ tag: 'unusable' }));
    const env = { REGISTRY_KV: store, burnDepositCheckOffThread: async () => ({ status: 200, body: { admitted: false } }) };
    const r = await sweepPendingBurnDeposits(env, 'mainnet', { maxCount: 1 });
    ok(r.checked === 1 && r.attempted === 1 && r.skipped === 0 && /indexed etch/.test(r.errors[0]?.error || ''), `a registration that is not admitted is rebuilt (attempted ${r.attempted}, then ${r.errors[0]?.error})`);
  }
  // A stored value that is not JSON is replaced too.
  {
    const store = kv(); store.m.set(`reflection:burndep:mainnet:${txid(1)}`, 'not json');
    const env = { REGISTRY_KV: store, burnDepositCheckOffThread: async () => ({ status: 200, body: { admitted: true } }) };
    const r = await sweepPendingBurnDeposits(env, 'mainnet', { maxCount: 1 });
    ok(r.attempted === 1 && r.skipped === 0, 'a stored value that cannot be read is rebuilt');
  }
  // Checks of stored registrations are limited per call: with every burn registered and maxCount 2, two are checked and the third waits.
  {
    const store = kv(); for (const i of [1, 2, 3]) store.m.set(`reflection:burndep:mainnet:${txid(i)}`, JSON.stringify({ tag: `b${i}` }));
    let calls = 0;
    const env = { REGISTRY_KV: store, burnDepositCheckOffThread: async () => { calls++; return { status: 200, body: { admitted: true } }; } };
    const r = await sweepPendingBurnDeposits(env, 'mainnet', { maxCount: 2 });
    ok(calls === 2 && r.checked === 2 && r.skipped === 3 && r.attempted === 0, `checks are limited to maxCount a call (${calls} checks, ${r.skipped} skipped)`);
  }
  // A burn with no registration is built as before (not checked).
  {
    const store = kv(); let calls = 0;
    const env = { REGISTRY_KV: store, burnDepositCheckOffThread: async () => { calls++; return { status: 200, body: { admitted: true } }; } };
    const r = await sweepPendingBurnDeposits(env, 'mainnet', { maxCount: 1 });
    ok(calls === 0 && r.attempted === 1, 'an unregistered burn is built without a check');
  }
} finally { globalThis.fetch = realFetch; }
console.log(`${n} checks`);
