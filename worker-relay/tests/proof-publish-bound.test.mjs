// The reflection cron publishes each proof before it submits it, and the submit waits for that call. So the call is bounded: a control plane
// that takes the connection and never answers must cost a few seconds of the attest, not minutes of it, and never its outcome.
// Offline: node --test worker-relay/tests/proof-publish-bound.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// The client reads its settings when it loads: point it at a local control plane before importing it.
let handler = () => {};
const server = createServer((req, res) => handler(req, res)).listen(0);
await new Promise((r) => server.once('listening', r));
process.env.RPC_URL = 'http://127.0.0.1:1';
process.env.RELAY_KEY = '0x' + '11'.repeat(32);
process.env.BOX_TOKEN = 'test-box-token';
process.env.WORKER_BASE = `http://127.0.0.1:${server.address().port}`;
const { reflectionProofPublish, PROOF_PUBLISH_TIMEOUT_MS } = await import('../src/lib/worker-client.js');
const { CFG } = await import('../src/lib/config.js');
test.after(() => { server.closeAllConnections?.(); server.close(); });

const args = { priorDigest: '0x' + 'aa'.repeat(32), newDigest: '0x' + 'bb'.repeat(32), attestedTo: 970_800, publicValues: '0x' + '01'.repeat(8), proof: '0x' + '02'.repeat(8) };

test('the control plane under test is the local one', () => {
  assert.equal(CFG.workerBase, `http://127.0.0.1:${server.address().port}`);
});

test('the bound is a few seconds, not minutes', () => {
  assert.ok(PROOF_PUBLISH_TIMEOUT_MS >= 1000 && PROOF_PUBLISH_TIMEOUT_MS <= 30_000, `bound is ${PROOF_PUBLISH_TIMEOUT_MS} ms`);
});

test('a published proof reports true', async () => {
  let got = null;
  handler = (req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); };
  assert.equal(await reflectionProofPublish(args), true);
  assert.equal(got.url, '/reflection/proof');
  assert.equal(got.auth, 'Bearer test-box-token');
  assert.equal(got.body.attestedTo, 970_800);
});

test('a control plane that takes the connection and never answers is given up on at the bound, and reads as not published', async () => {
  handler = () => { /* accept, say nothing */ };
  const t0 = Date.now();
  assert.equal(await reflectionProofPublish(args, { timeoutMs: 150 }), false);
  const took = Date.now() - t0;
  assert.ok(took >= 120 && took < 2000, `gave up after ${took} ms`);
});

test('a refusal, and an error from the control plane, read as not published and never throw', async () => {
  handler = (_req, res) => { res.writeHead(503); res.end('busy'); };
  assert.equal(await reflectionProofPublish(args, { timeoutMs: 500 }), false);
  handler = (_req, res) => res.destroy();
  assert.equal(await reflectionProofPublish(args, { timeoutMs: 500 }), false);
});
