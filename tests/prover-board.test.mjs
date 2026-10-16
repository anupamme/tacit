// The prover board (worker/src/prover-board.js) and its routes: the relay posts and reads jobs with the box token, a worker
// claims and answers with its own token for its classes, a lease that lapses re-opens the job, a cancelled job ignores a
// late result, the summary carries no inputs. Run: node --test tests/prover-board.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProverBoard, parseWorkerTokens, workerOf, PROVER_BOARD } from '../worker/src/prover-board.js';
import worker from '../worker/src/index.js';

const store = () => {
  const m = new Map(); let pend = [], ws = {};
  return { getPending: async () => pend.slice(), putPending: async (ids) => { pend = ids.slice(); }, getJob: async (id) => (m.has(id) ? JSON.parse(m.get(id)) : null), putJob: async (id, j) => { m.set(id, JSON.stringify(j)); }, getWorkers: async () => JSON.parse(JSON.stringify(ws)), putWorkers: async (w) => { ws = JSON.parse(JSON.stringify(w)); } };
};
const stdin = Buffer.from('program input bytes').toString('base64');
let t = 1_000_000;
const now = () => t;
const tacit = { name: 'tacit-a5000', classes: ['private', 'public'] };
const guest = { name: 'alice', classes: ['public'] };

test('tokens: name:token[:classes]; short tokens are ignored; a bearer names its worker', () => {
  const raw = 'tacit-a5000:aaaaaaaaaaaaaaaaaaaa:private+public, alice:bbbbbbbbbbbbbbbbbbbb, bad:short, eve:cccccccccccccccccccc:secret';
  assert.deepEqual(parseWorkerTokens(raw), [{ name: 'tacit-a5000', token: 'aaaaaaaaaaaaaaaaaaaa', classes: ['private', 'public'] }, { name: 'alice', token: 'bbbbbbbbbbbbbbbbbbbb', classes: ['public'] }, { name: 'eve', token: 'cccccccccccccccccccc', classes: ['public'] }]);
  assert.deepEqual(workerOf('Bearer bbbbbbbbbbbbbbbbbbbb', raw), { name: 'alice', classes: ['public'] });
  assert.equal(workerOf('Bearer bbbbbbbbbbbbbbbbbbbc', raw), null);
  assert.equal(workerOf('', raw), null);
  assert.equal(workerOf('Bearer aaaaaaaaaaaaaaaaaaaa', ''), null);
});

test('post, claim by class, result, status; the same input is one job; a worker without the class never sees it', async () => {
  const b = makeProverBoard({ storage: store(), now });
  const { jobId, status } = await b.post({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600, label: 'wrap' });
  assert.equal(status, 'queued');
  assert.deepEqual(await b.post({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 }), { jobId, status: 'queued', deduped: true });
  assert.equal(await b.claim({ worker: guest, classes: ['public'] }), null, 'a public-only worker is not offered a private job');
  assert.equal(await b.claim({ worker: guest, classes: ['private'] }), null, 'nor can it ask for the class');
  const job = await b.claim({ worker: tacit, classes: ['private', 'public'] });
  assert.equal(job.jobId, jobId); assert.equal(job.stdin, stdin); assert.equal(job.label, 'wrap'); assert.equal(job.leaseUntil, now() + PROVER_BOARD.leaseMs);
  assert.equal((await b.status(jobId)).status, 'claimed');
  assert.equal(await b.claim({ worker: tacit, classes: ['private'] }), null, 'nothing else is queued');
  const r = await b.result({ worker: guest, jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) });
  assert.equal(r.ok, false, 'another worker cannot answer for it');
  assert.deepEqual(await b.result({ worker: tacit, jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) }), { ok: true, status: 'proved' });
  const st = await b.status(jobId);
  assert.equal(st.status, 'proved'); assert.equal(st.worker, 'tacit-a5000'); assert.equal(st.proof, '0x' + '22'.repeat(260)); assert.equal(st.stdin, undefined, 'the status never carries the input');
  const sum = await b.summary();
  assert.equal(sum.proved, 1); assert.equal(sum.workers[0].name, 'tacit-a5000'); assert.equal(sum.workers[0].proved, 1);
  assert.equal(JSON.stringify(sum).includes(stdin), false);
  assert.deepEqual(await b.post({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 }), { jobId, status: 'queued' }, 'once finished, the same input can be posted again');
});

test('a lapsed lease re-opens the job for the next claim; a cancelled job takes no late result; a bad proof counts against its worker', async () => {
  const b = makeProverBoard({ storage: store(), now });
  const { jobId } = await b.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 3600 });
  assert.equal((await b.claim({ worker: guest, classes: ['public'] })).jobId, jobId);
  t += PROVER_BOARD.leaseMs + 1;
  assert.equal((await b.status(jobId)).status, 'queued', 'read as queued once the lease lapsed');
  const again = await b.claim({ worker: tacit, classes: ['public'] });
  assert.equal(again.jobId, jobId);
  assert.equal((await b.result({ worker: guest, jobId, error: 'late' })).ok, false, 'the worker that lost the lease cannot answer');
  assert.deepEqual(await b.cancel({ jobId, reason: 'bad' }), { ok: true, status: 'cancelled' });
  assert.equal((await b.result({ worker: tacit, jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(100) })).ok, false);
  const sum = await b.summary();
  assert.equal(sum.workers.find((w) => w.name === 'tacit-a5000').bad, 1);
  assert.equal((await b.status(jobId)).lapsed, 1);
  // A job past its deadline is expired, not offered.
  const late = await b.post({ class: 'public', stdin: Buffer.from('other').toString('base64'), cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 + 1 });
  t += 2000;
  assert.equal(await b.claim({ worker: guest, classes: ['public'] }), null);
  assert.equal((await b.status(late.jobId)).status, 'expired');
  await assert.rejects(b.post({ class: 'secret', stdin, cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 + 10 }), /class must be/);
  await assert.rejects(b.post({ class: 'public', stdin: 'not base64!', cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 + 10 }), /base64/);
  await assert.rejects(b.post({ class: 'public', stdin, cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 - 10 }), /deadline/);
});

test('routes: box token for posting and reading, worker tokens for claiming and answering, the summary open to any page', async () => {
  const kv = () => { const m = new Map(); return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };
  const env = { REGISTRY_KV: kv(), CONFIDENTIAL_BOX_TOKEN: 'box-token-box-token-box', PROVER_WORKER_TOKENS: 'gpu1:worker-token-worker-tok:private+public,alice:alice-token-alice-token' };
  const call = (path, init = {}) => worker.fetch(new Request(`https://api.tacit.finance${path}`, { ...init, headers: { Origin: 'https://some-page.example', ...(init.headers || {}) } }), env, { waitUntil() {} });
  const json = (o) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
  const box = { Authorization: 'Bearer box-token-box-token-box' };
  let r = await call('/prover/jobs', json({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(Date.now() / 1000) + 600 }));
  assert.equal(r.status, 404, 'posting needs the box token');
  r = await call('/prover/jobs', { ...json({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(Date.now() / 1000) + 600, label: 'wrap' }), headers: { 'content-type': 'application/json', ...box } });
  const posted = await r.json();
  assert.equal(r.status, 200); assert.equal(posted.ok, true); assert.equal(posted.status, 'queued');
  r = await call('/prover/claim', json({ classes: ['private'] }));
  assert.equal(r.status, 404, 'claiming needs a worker token');
  r = await call('/prover/claim', { ...json({ classes: ['private', 'public'] }), headers: { 'content-type': 'application/json', Authorization: 'Bearer alice-token-alice-token' } });
  assert.deepEqual(await r.json(), {}, 'a public-only worker gets nothing for a private job');
  r = await call('/prover/claim', { ...json({ classes: ['private', 'public'] }), headers: { 'content-type': 'application/json', Authorization: 'Bearer worker-token-worker-tok' } });
  const { job } = await r.json();
  assert.equal(job.jobId, posted.jobId); assert.equal(job.stdin, stdin);
  r = await call(`/prover/jobs?id=${posted.jobId}`, { headers: box });
  assert.equal((await r.json()).status, 'claimed');
  r = await call('/prover/result', { ...json({ jobId: job.jobId, publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(260) }), headers: { 'content-type': 'application/json', Authorization: 'Bearer worker-token-worker-tok' } });
  assert.deepEqual(await r.json(), { ok: true, status: 'proved' });
  r = await call(`/prover/jobs?id=${posted.jobId}`, { headers: box });
  const st = await r.json();
  assert.equal(st.status, 'proved'); assert.equal(st.proof, '0x' + 'cd'.repeat(260)); assert.equal(st.worker, 'gpu1'); assert.equal('stdin' in st, false);
  r = await call('/prover/board');
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), '*'); assert.equal(r.headers.get('cache-control'), 'max-age=10');
  const sum = await r.json();
  assert.equal(sum.proved, 1); assert.equal(sum.workers[0].name, 'gpu1');
  r = await call('/prover/jobs/cancel', { ...json({ jobId: posted.jobId }), headers: { 'content-type': 'application/json', ...box } });
  assert.deepEqual(await r.json(), { ok: true, status: 'cancelled' });
  r = await call('/prover/jobs?id=nope', { headers: box });
  assert.equal(r.status, 404);
});
