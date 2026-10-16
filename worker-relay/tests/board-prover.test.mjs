// lib/board-prover.js: the relay's board lane, with the API and the chain stood in for.
// Run: node --test worker-relay/tests/board-prover.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardProver } from '../src/lib/board-prover.js';

function fakeBoard({ script = [], verifyOk = true, postOk = true } = {}) {
  const calls = { post: [], cancel: [], verify: [] };
  let i = 0;
  let t = 0;
  const api = {
    post: async (b) => { calls.post.push(b); return postOk ? { ok: true, jobId: '0xjob1234567890', status: 'queued' } : { ok: false, error: 'the board is full' }; },
    status: async () => script[Math.min(i++, script.length - 1)] || { status: 'queued' },
    cancel: async (jobId, reason) => { calls.cancel.push({ jobId, reason }); return { ok: true }; },
    verify: async (a) => { calls.verify.push(a); return verifyOk; },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    waitMs: 30_000, pollMs: 1000,
  };
  return { api, calls };
}
const stdin = new Uint8Array([1, 2, 3, 4]);
const PV = '0x' + 'aa'.repeat(64), PROOF = '0x' + 'bb'.repeat(260);

test('posts the input with its class and limits, follows the job, verifies the proof and returns it', async () => {
  const { api, calls } = fakeBoard({ script: [{ status: 'queued' }, { status: 'claimed', worker: 'gpu1' }, { status: 'proved', worker: 'gpu1', publicValues: PV, proof: PROOF }] });
  const lane = makeBoardProver(api);
  const r = await lane.prove({ stdin, cycleLimit: 256_000_000n, gasLimit: 1_000_000_000n, cls: 'private', label: 'wrap', memos: ['0x01'] });
  assert.deepEqual(r, { publicValues: PV, proof: PROOF, worker: 'gpu1', jobId: '0xjob1234567890' });
  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].class, 'private'); assert.equal(calls.post[0].stdin, Buffer.from(stdin).toString('base64'));
  assert.equal(calls.post[0].cycleLimit, 256_000_000); assert.equal(calls.post[0].gasLimit, 1_000_000_000);
  assert.equal(calls.post[0].deadline, 30 + 60, 'the deadline is a minute past the wait');
  assert.deepEqual(calls.verify, [{ publicValues: PV, proof: PROOF, memos: ['0x01'] }]);
  assert.equal(calls.cancel.length, 0);
});

test('a proof the pool refuses is cancelled as bad and misses; a failed, expired or unposted job misses', async () => {
  let f = fakeBoard({ script: [{ status: 'proved', worker: 'eve', publicValues: PV, proof: PROOF }], verifyOk: false });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'board_miss' && /did not pass/.test(e.message) && e.worker === 'eve');
  assert.deepEqual(f.calls.cancel, [{ jobId: '0xjob1234567890', reason: 'bad' }]);
  f = fakeBoard({ script: [{ status: 'failed', worker: 'gpu1', error: 'CUDA died' }] });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'board_miss' && /CUDA died/.test(e.message));
  f = fakeBoard({ script: [{ status: 'expired' }] });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'board_miss' && /expired/.test(e.message));
  f = fakeBoard({ postOk: false });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'board_miss' && /the board is full/.test(e.message));
  await assert.rejects(makeBoardProver(f.api).prove({ stdin: 'nope', cycleLimit: 1, gasLimit: 1 }), /input bytes/);
});

test('nobody in time: the job is cancelled and the miss says who had claimed it; a shorter job timeout bounds the wait', async () => {
  const f = fakeBoard({ script: [{ status: 'claimed', worker: 'gpu1' }] });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1, timeoutMs: 10_000 }), (e) => e.code === 'board_miss' && /within 10 s/.test(e.message) && /gpu1 had claimed it/.test(e.message));
  assert.deepEqual(f.calls.cancel, [{ jobId: '0xjob1234567890', reason: 'timeout' }]);
  assert.equal(f.calls.post[0].deadline, 10 + 60);
});

test('with no worker seen lately the job is not posted at all', async () => {
  const f = fakeBoard({ script: [{ status: 'queued' }] });
  await assert.rejects(makeBoardProver({ ...f.api, alive: async () => false }).prove({ stdin, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'board_miss' && /no worker/.test(e.message));
  assert.equal(f.calls.post.length, 0);
  const g = fakeBoard({ script: [{ status: 'proved', worker: 'gpu1', publicValues: PV, proof: PROOF }] });
  const r = await makeBoardProver({ ...g.api, alive: async () => { throw new Error('unreadable'); } }).prove({ stdin, cycleLimit: 1, gasLimit: 1 });
  assert.equal(r.worker, 'gpu1', 'an unreadable liveness read does not hold the job back');
});
