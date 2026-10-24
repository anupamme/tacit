// Picking the endpoint a single-URL binary is handed (src/lib/rpc-pick.js).
//   node worker-relay/tests/rpc-pick.test.mjs

import assert from 'node:assert/strict';
import { pickRpc, hostOf } from '../src/lib/rpc-pick.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

// A fake network: each host answers per `behave[host](method)` with a result, a JSON-RPC error, an HTTP status
// or a thrown transport error, and every call is recorded.
function net(behave) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host, { method } = JSON.parse(init.body);
    calls.push(`${host} ${method}`);
    const b = behave[host](method);
    if (b === 'down') throw new TypeError('fetch failed');
    if (typeof b === 'number') return new Response('rate limited', { status: b });
    if (b && b.error) return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: b.error } });
    return Response.json({ jsonrpc: '2.0', id: 1, result: b });
  };
  return { fetchImpl, calls };
}
const ok = () => () => '0x1';
const probe = async (rpc) => { await rpc('eth_getLogs', []); await rpc('eth_getProof', []); };

await test('the first endpoint that answers the whole probe is picked', async () => {
  const { fetchImpl, calls } = net({ 'a.example': ok(), 'b.example': ok() });
  const r = await pickRpc(['https://a.example', 'https://b.example'], probe, { fetchImpl });
  assert.equal(r.url, 'https://a.example');
  assert.deepEqual(r.failures, []);
  assert.deepEqual(calls, ['a.example eth_getLogs', 'a.example eth_getProof']);
});

await test('a rate-limited, down or refusing endpoint is passed over', async () => {
  const { fetchImpl } = net({
    'limited.example': () => 429,
    'down.example': () => 'down',
    'archive.example': (m) => (m === 'eth_getLogs' ? { error: 'Archive requests require a personal token' } : '0x1'),
    'good.example': ok(),
  });
  const r = await pickRpc(['https://limited.example', 'https://down.example', 'https://archive.example', 'https://good.example'], probe, { fetchImpl });
  assert.equal(r.url, 'https://good.example');
  assert.equal(r.failures.length, 3);
  assert.match(r.failures[2], /^archive\.example \(eth_getLogs: Archive requests/);
});

await test('when nothing answers, the first URL is handed on as before', async () => {
  const { fetchImpl } = net({ 'a.example': () => 429, 'b.example': () => 'down' });
  const r = await pickRpc(['https://a.example', 'https://b.example'], probe, { fetchImpl });
  assert.equal(r.url, 'https://a.example');
  assert.equal(r.failures.length, 2);
});

await test('an access key in a URL never reaches the failures', async () => {
  const { fetchImpl } = net({ 'gw.example': () => 429, 'b.example': ok() });
  const r = await pickRpc(['https://gw.example/SECRETKEY123', 'https://b.example'], probe, { fetchImpl });
  assert.equal(r.url, 'https://b.example');
  assert.ok(!r.failures.join(' ').includes('SECRETKEY123'));
  assert.equal(hostOf('https://gw.example/SECRETKEY123'), 'gw.example');
});

await test('blank and repeated entries are dropped', async () => {
  const { fetchImpl, calls } = net({ 'a.example': () => 429, 'b.example': ok() });
  const r = await pickRpc(['', 'https://a.example', 'https://a.example', null, 'https://b.example'], probe, { fetchImpl });
  assert.equal(r.url, 'https://b.example');
  assert.equal(calls.filter((c) => c.startsWith('a.example')).length, 1);
});

console.log(`${n} passed`);
