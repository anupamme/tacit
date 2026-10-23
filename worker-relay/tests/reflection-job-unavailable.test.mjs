// The lane asks the API for its next batch. An API that could not put one together (its block sources throttling, a restart) must read
// differently from one with nothing to give: the first is logged and shown in the lane's health, the second is "caught up".
// Offline: node --test worker-relay/tests/reflection-job-unavailable.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let handler = () => {};
const server = createServer((req, res) => handler(req, res)).listen(0);
await new Promise((r) => server.once('listening', r));
process.env.RPC_URL = 'http://127.0.0.1:1';
process.env.RELAY_KEY = '0x' + '11'.repeat(32);
process.env.BOX_TOKEN = 'test-box-token';
process.env.WORKER_BASE = `http://127.0.0.1:${server.address().port}`;
const { reflectionJob, reflectionPending } = await import('../src/lib/worker-client.js');
test.after(() => { server.closeAllConnections?.(); server.close(); });

const reply = (status, body) => (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('a batch is returned as the API sent it', async () => {
  handler = reply(200, { input: { newDigest: '0xaa' }, jobId: '0xaa', attestedTo: 970_700 });
  const job = await reflectionJob();
  assert.equal(job.attestedTo, 970_700);
  assert.equal(job.unavailable, undefined);
});

test('nothing to give reads as an empty answer, caught up', async () => {
  handler = reply(200, {});
  const job = await reflectionJob();
  assert.deepEqual(job, {});
});

test('a refusal carries its status, so it is not read as caught up', async () => {
  handler = reply(500, { error: 'mainnet all sources cooling for 2s' });
  assert.deepEqual(await reflectionJob(), { unavailable: 500 });
  handler = reply(503, {});
  assert.deepEqual(await reflectionJob({ maxBlocks: 4 }), { unavailable: 503 });
});

test('the other routes keep their empty answer on a refusal', async () => {
  handler = reply(500, { error: 'x' });
  assert.deepEqual(await reflectionPending('0x' + 'bb'.repeat(32)), {});
});
