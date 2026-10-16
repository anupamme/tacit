#!/usr/bin/env node
// Confidential settle relay — job-queue unit test (worker/src/confidential-settle.js).
// In-memory storage + injected clock; exercises submit/dedup, FIFO claim, claim-lock against
// double-prove, stale-claim reclaim, ack (settled + failed), and status. No network/KV/box.
//
// Run: node tests/confidential-settle.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialSettler } from '../worker/src/confidential-settle.js';
import assert from 'node:assert';

const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
let t = 1000; const now = () => t; // controllable clock
const instantSleep = () => Promise.resolve(); // skip the real claim-verify wait — no real concurrency in these tests
function freshStore() {
  const jobs = new Map(); let pending = [];
  return {
    getPending: async () => pending.slice(),
    putPending: async (ids) => { pending = ids.slice(); },
    getJob: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null),
    putJob: async (id, job) => { jobs.set(id, JSON.parse(JSON.stringify(job))); },
  };
}
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const swapOp = { reserveAPre: 1000, reserveBPre: 1000, intents: [{ amountIn: 100 }] };
const lpOp = { reserveAPre: 1000, reserveBPre: 2000, dShares: 100 };
const routeOp = { asset0: 'aa', assetFinal: 'bb', hops: [{ reserveAPre: '1000', reserveBPre: '1000' }] };

// ───────────────── 1. submit enqueues a pending job, dedups on resubmit ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const a = await q.submitJob({ type: 'swap', op: swapOp, memos: ['0x01'] });
  assert.strictEqual(a.status, 'pending');
  assert.strictEqual(await q.pendingCount(), 1);
  const b = await q.submitJob({ type: 'swap', op: swapOp, memos: ['0x01'] }); // identical → same id
  assert.strictEqual(b.jobId, a.jobId, 'same witness → same jobId');
  assert.ok(b.deduped, 'resubmit is deduped');
  assert.strictEqual(await q.pendingCount(), 1, 'no duplicate enqueue');
  ok('submit enqueues; an identical resubmit dedups to the same job');
}

// ───────────────── 2. unknown type is rejected ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  await assert.rejects(() => q.submitJob({ type: 'bridge', op: {} }), /unknown type/);
  await assert.rejects(() => q.submitJob({ type: 'swap' }), /type \+ op required/);
  const r = await q.submitJob({ type: 'route', op: routeOp });
  assert.strictEqual(r.status, 'pending', 'route op type is accepted');
  ok('submit rejects unknown op types + missing op, and accepts route ops');
}

// ───────────────── 3. FIFO claim + claim-lock prevents double-prove ─────────────────
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep });
  const j1 = await q.submitJob({ type: 'swap', op: swapOp });
  const j2 = await q.submitJob({ type: 'lp', op: lpOp });
  const first = await q.nextJob();
  assert.strictEqual(first.jobId, j1.jobId, 'FIFO: first submitted claimed first');
  assert.strictEqual(first.type, 'swap');
  const second = await q.nextJob();
  assert.strictEqual(second.jobId, j2.jobId, 'a second poll skips the claimed job, returns the next');
  const third = await q.nextJob();
  assert.strictEqual(third, null, 'both claimed → nothing left to claim (no double-prove)');
  ok('claims are FIFO and locked — a claimed job is not handed out again');
}

// ───────────────── 3b. a claim can ask for one mode: prove-only jobs go through while settle jobs wait ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const settle = await q.submitJob({ type: 'swap', op: swapOp });
  const prove = await q.submitJob({ type: 'lp', op: lpOp, mode: 'prove' });
  const p1 = await q.nextJob({ mode: 'prove' });
  assert.strictEqual(p1.jobId, prove.jobId, 'the prove-only job is handed out ahead of an older settle job');
  assert.strictEqual(p1.mode, 'prove');
  assert.strictEqual(await q.nextJob({ mode: 'prove' }), null, 'no other prove-only job: the settle job is not taken');
  assert.strictEqual((await q.jobStatus(settle.jobId)).status, 'pending', 'the settle job stays queued');
  const s1 = await q.nextJob();
  assert.strictEqual(s1.jobId, settle.jobId, 'an unfiltered claim still takes it');
  ok('a claim filtered to prove mode takes only prove-only jobs; settle jobs stay queued');
}

// ───────────────── 3c. a proven job hands back the memos its proof commits to ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const memos = ['0xaa01', '0xbb02'];
  const j = await q.submitJob({ type: 'lp', op: lpOp, memos, mode: 'prove' });
  assert.strictEqual((await q.jobStatus(j.jobId)).memos, null, 'no memos before it is proven');
  const again = await q.submitJob({ type: 'lp', op: lpOp, memos: ['0xcc03'], mode: 'prove' });
  assert.strictEqual(again.jobId, j.jobId, 'the same op asked again joins the same job');
  await q.nextJob({ mode: 'prove' });
  await q.ackJob(j.jobId, { publicValues: '0x01', proof: '0x02' });
  const st = await q.jobStatus(j.jobId);
  assert.strictEqual(st.status, 'proven');
  assert.deepStrictEqual(st.memos, memos, 'the proven job returns the memos it was proved with, not the second press\'s');
  ok('a proven job returns the memos its proof commits to');

  // A prove job whose deposit was settled from elsewhere first is acked as settled by that transaction: done, not
  // failed. (A bare txHash on a prove job still fails closed: tests/confidential-relay.mjs.)
  const w = await q.submitJob({ type: 'wrap', op: { asset: '0x01', value: '5', cx: '0x02', cy: '0x03', owner: '0x04' }, memos: ['0xdd04'], mode: 'prove' });
  await q.nextJob({ mode: 'prove' });
  await q.ackJob(w.jobId, { txHash: '0xfeed', settledBy: '0xfeed' });
  const ws = await q.jobStatus(w.jobId);
  assert.strictEqual(ws.status, 'settled');
  assert.strictEqual(ws.txHash, '0xfeed');
  assert.strictEqual(ws.memos, null);
  ok('a prove job whose deposit was already settled reads as settled, with that transaction');
}

// ───────────────── 4. stale claim is reclaimable (box crash) ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const j = await q.submitJob({ type: 'swap', op: swapOp });
  const claimed = await q.nextJob();
  assert.strictEqual(claimed.jobId, j.jobId);
  assert.strictEqual(await q.nextJob(), null, 'freshly claimed → not reclaimable yet');
  t += 15 * 60 * 1000; // a proof still inside the relay's own 15-minute limit is not handed to a second prover
  assert.strictEqual(await q.nextJob(), null, 'a claim inside the relay job timeout is not reclaimable');
  t += 2 * 60 * 1000; // past CLAIM_TTL_MS (16 min)
  const reclaimed = await q.nextJob();
  assert.strictEqual(reclaimed.jobId, j.jobId, 'after the TTL a crashed claim is reclaimable');
  t -= 17 * 60 * 1000;
  ok('a stale (crashed-box) claim is reclaimable after the TTL, and not while the relay may still be proving it');
}

// ───────────────── 5. ack settles, drains the queue, is idempotent ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const j = await q.submitJob({ type: 'lp', op: lpOp });
  await q.nextJob();
  const r = await q.ackJob(j.jobId, { txHash: '0xdeadbeef' });
  assert.strictEqual(r.status, 'settled');
  assert.strictEqual(await q.pendingCount(), 0, 'settled job leaves the pending queue');
  const st = await q.jobStatus(j.jobId);
  assert.strictEqual(st.status, 'settled');
  assert.strictEqual(st.txHash, '0xdeadbeef');
  const again = await q.ackJob(j.jobId, { txHash: '0xother' }); // idempotent
  assert.strictEqual(again.txHash, '0xdeadbeef', 'second ack is a no-op, keeps the first tx');
  ok('ack settles + drains the queue + records the tx; re-ack is idempotent');
}

// ───────────────── 6. a failed prove leaves the queue but can be resubmitted ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const j = await q.submitJob({ type: 'swap', op: swapOp });
  await q.nextJob();
  await q.ackJob(j.jobId, { error: 'groth16 proof failed' });
  assert.strictEqual((await q.jobStatus(j.jobId)).status, 'failed');
  assert.strictEqual(await q.pendingCount(), 0, 'failed job drains the pending queue');
  const re = await q.submitJob({ type: 'swap', op: swapOp }); // failed → resubmittable
  assert.strictEqual(re.status, 'pending', 'a failed job can be resubmitted');
  assert.ok(!re.deduped);
  ok('a failed prove leaves the queue + is resubmittable (not dedup-locked)');
}

// ───────────────── 7. feeGate: awaited (an async gate, reading live gas price, must be supported), only
// gates mode:'settle', and a rejection doesn't enqueue or lock out a later, better-fee resubmit ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, feeGate: async ({ op }) => op.fee >= 100 });
  await assert.rejects(
    () => q.submitJob({ type: 'transfer', op: { fee: 10 } }),
    /below the current floor/,
    'a settle job below the gate is rejected before it is ever enqueued',
  );
  assert.strictEqual(await q.pendingCount(), 0, 'the rejected submit never touched the queue');
  const passed = await q.submitJob({ type: 'transfer', op: { fee: 100 } });
  assert.strictEqual(passed.status, 'pending', 'a fee clearing the gate enqueues normally');
  ok('feeGate: an async gate is awaited; a rejection never enqueues, a clearing fee is unaffected');
}

// ───────────────── 8. feeGate: a SYNCHRONOUS gate (returns a plain boolean, not a Promise) still works —
// `await` on a non-Promise resolves immediately, so this must not require every gate to be async ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, feeGate: ({ op }) => op.fee >= 100 });
  await assert.rejects(() => q.submitJob({ type: 'transfer', op: { fee: 0 } }), /below the current floor/);
  const passed = await q.submitJob({ type: 'transfer', op: { fee: 500 } });
  assert.strictEqual(passed.status, 'pending');
  ok('feeGate: a plain synchronous gate function still works under await');
}

// ───────────────── 9. feeGate only applies to mode:'settle' — a prove-only job is user-sent (the user pays
// gas), so it is never gated even at fee=0 ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, feeGate: () => false }); // gate rejects EVERYTHING
  const proved = await q.submitJob({ type: 'transfer', op: { fee: 0 }, mode: 'prove' });
  assert.strictEqual(proved.status, 'pending', 'prove-only bypasses the fee gate entirely');
  ok('feeGate: mode:\'prove\' is never gated, even against a gate that rejects everything');
}

// ───────────────── 10. concurrent claim race: a second poller's write landing during the verify wait
// is detected and backed off from, rather than both pollers proving the same job ─────────────────
{
  const store = freshStore();
  const jobA = await makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep })
    .submitJob({ type: 'swap', op: swapOp });
  // A `sleep` that simulates a second poller's claim landing on THIS job during the wait window —
  // exercises the exact mechanism nextJob() relies on (re-read after the wait, compare the nonce),
  // deterministically, rather than racing real Promise scheduling.
  const rival = makeConfidentialSettler({ storage: store, hash, now, sleep: async () => {
    const rec = await store.getJob(jobA.jobId);
    rec.claimNonce = 'rival-poller-nonce';
    rec.claimedAt = now();
    await store.putJob(jobA.jobId, rec);
  } });
  const lost = await rival.nextJob();
  assert.strictEqual(lost, null, 'a claim overwritten by a rival poller during the verify wait is not returned');
  const rec = await store.getJob(jobA.jobId);
  assert.strictEqual(rec.claimNonce, 'rival-poller-nonce', 'the rival\'s claim is the one left standing');
  ok('nextJob: a claim raced out from under it during the verify wait backs off instead of also proving it');
}

// ───────────────── 11. nextBatch applies the same race-narrowing, in one shared wait for the batch ─────────────────
{
  const store = freshStore();
  const jobA = await makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep })
    .submitJob({ type: 'transfer', op: { spendRoot: '0xroot', chainBinding: '0xcb', fee: 0 } });
  let waits = 0;
  const rival = makeConfidentialSettler({ storage: store, hash, now, sleep: async () => {
    waits++;
    const rec = await store.getJob(jobA.jobId);
    rec.claimNonce = 'rival-batch-nonce';
    await store.putJob(jobA.jobId, rec);
  } });
  const picked = await rival.nextBatch({ types: ['transfer'] });
  assert.strictEqual(picked.length, 0, 'the only candidate lost its race and is excluded from the batch');
  assert.strictEqual(waits, 1, 'one shared wait for the whole batch, not one per claimed job');
  ok('nextBatch: race-narrowing applies per-batch with a single shared wait, not per-job');
}

// ───────────────── 12. nextBatch({ mixed }) claims any board-eligible type whose roots agree; the plain batch stays transfer-only ─────────────────
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep });
  const cb = '0xcb', root = '0xr1';
  const wrap = await q.submitJob({ type: 'wrap', op: { chainBinding: cb, value: '1' } });                       // no roots of its own
  const xfer = await q.submitJob({ type: 'transfer', op: { chainBinding: cb, spendRoot: root, fee: 0 } });
  const cdp = await q.submitJob({ type: 'cdpclose', op: { chainBinding: cb, spendRoot: root, cdpPositionRoot: '0xp1' } });
  const other = await q.submitJob({ type: 'transfer', op: { chainBinding: cb, spendRoot: '0xr2', fee: 1 } });    // another spend root
  const cdp2 = await q.submitJob({ type: 'cdptopup', op: { chainBinding: cb, spendRoot: root, cdpPositionRoot: '0xp2' } }); // another position root
  const exit = await q.submitJob({ type: 'unwrap', op: { chainBinding: cb, spendRoot: root } });
  { const rec = await store.getJob(exit.jobId); rec.exit = { exitedAsset: '0x' + '11'.repeat(32) }; await store.putJob(exit.jobId, rec); } // a relayed exit, activated after its own settle
  const embedded = await q.submitJob({ type: 'wraptransfer', op: { chainBinding: cb, spendRoot: root } });        // not a plain pool.settle
  const proveOnly = await q.submitJob({ type: 'unwrap', op: { chainBinding: cb, spendRoot: root, value: '2' }, mode: 'prove' });
  const picked = await q.nextBatch({ max: 8, mixed: true });
  assert.deepEqual(picked.map((j) => j.jobId), [wrap.jobId, xfer.jobId, cdp.jobId], 'the wrap, the transfer and the close share roots; the rest wait');
  assert.deepEqual(picked.map((j) => j.type), ['wrap', 'transfer', 'cdpclose']);
  for (const left of [other, cdp2, exit, embedded, proveOnly]) assert.strictEqual((await store.getJob(left.jobId)).status, 'pending', `${left.jobId} is left in the queue`);
  // The next mixed round takes what agrees with the first job it reaches.
  const next = await q.nextBatch({ max: 8, mixed: true });
  assert.deepEqual(next.map((j) => j.jobId), [other.jobId], 'the other spend root leads its own batch; nothing else agrees with it');
  ok('nextBatch mixed: board-eligible types with agreeing roots travel together; exits, embedded proofs and prove-only jobs do not');
}
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  await q.submitJob({ type: 'wrap', op: { chainBinding: '0xcb', value: '1' } });
  const t1 = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0 } });
  const t2 = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 1 } });
  await q.submitJob({ type: 'cdpclose', op: { chainBinding: '0xcb', spendRoot: '0xr', cdpPositionRoot: '0xp' } });
  const picked = await q.nextBatch({ max: 8 });
  assert.deepEqual(picked.map((j) => j.jobId), [t1.jobId, t2.jobId], 'without mixed: transfers only, as the transfer batch binary expects');
  ok('nextBatch: the plain batch is still transfers that share a spend root');
}

// ───────────────── 14. a settle's ack carries where its proof was made; the status reports it; junk is dropped ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const a = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n: 'a' } });
  await q.nextJob();
  await q.ackJob(a.jobId, { txHash: '0xtx1', lane: 'board' });
  assert.strictEqual((await q.jobStatus(a.jobId)).lane, 'board');
  const b = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n: 'b' } });
  await q.nextJob();
  await q.ackJob(b.jobId, { txHash: '0xtx2', lane: 'somewhere-else' });
  const sb = await q.jobStatus(b.jobId);
  assert.strictEqual(sb.status, 'settled'); assert.strictEqual(sb.lane, null, 'an unknown lane is not kept');
  ok('ack: the proof\'s lane (board / network-private / network-public) rides on the settled job\'s status');
}

// ───────────────── 15. a settled job keeps no witness: the op is dropped from its record ─────────────────
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep });
  const a = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, secret: 'witness' } });
  await q.nextJob();
  assert.ok((await store.getJob(a.jobId)).op, 'a claimed job carries its op');
  await q.ackJob(a.jobId, { txHash: '0xtx' });
  const rec = await store.getJob(a.jobId);
  assert.strictEqual(rec.status, 'settled'); assert.strictEqual(rec.op, undefined, 'the witness is gone once settled');
  assert.strictEqual((await q.jobStatus(a.jobId)).txHash, '0xtx');
  const b = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, secret: 'witness' } });
  assert.strictEqual(b.jobId, a.jobId, 'and the same op still dedupes to the same job by id');
  ok('a settled job drops its op (the witness); its id, memos and transaction stay');
}

// ───────────────── 16. a sealed job: no op, the ciphertext for one worker, the fee read later from its proof ─────────────────
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep });
  const sealed = { worker: 'tacit-a5000', epk: '0x02' + 'ab'.repeat(32), iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJD'.repeat(10) };
  const a = await q.submitJob({ type: 'transfer', mode: 'sealed', sealed, memos: ['0x01'] });
  assert.strictEqual(a.status, 'pending');
  const again = await q.submitJob({ type: 'transfer', mode: 'sealed', sealed: { ...sealed, epk: '0x03' + 'cd'.repeat(32) }, memos: ['0x01'] });
  assert.strictEqual(again.jobId, a.jobId, 'the same ciphertext is one job'); assert.ok(again.deduped);
  await assert.rejects(() => q.submitJob({ type: 'transfer', mode: 'sealed', sealed: { ...sealed, ct: 'short' } }), /sealed \{ worker, epk, iv, ct \}/);
  await assert.rejects(() => q.submitJob({ type: 'bridgemint', mode: 'sealed', sealed, memos: [] }), /cannot be sent sealed/);
  await assert.rejects(() => q.submitJob({ type: 'transfer', mode: 'sealed', sealed, memos: [], exit: { to: '0x1' } }), /exit recipe/);
  const st = await q.jobStatus(a.jobId);
  assert.strictEqual(st.sealed, true); assert.strictEqual(st.mode, 'settle');
  const job = await q.nextJob();
  assert.strictEqual(job.jobId, a.jobId); assert.strictEqual(job.op, null); assert.deepStrictEqual(job.sealed, sealed);
  assert.strictEqual(job.feeUsd, null, 'no fee is known before the proof');
  await q.ackJob(a.jobId, { txHash: '0xtx', lane: 'board' });
  const rec = await store.getJob(a.jobId);
  assert.strictEqual(rec.status, 'settled'); assert.deepStrictEqual(rec.sealed, { worker: 'tacit-a5000' }, 'the ciphertext is dropped once settled');
  const done = await q.jobStatus(a.jobId);
  assert.strictEqual(done.sealed, true); assert.strictEqual(done.lane, 'board'); assert.strictEqual(done.txHash, '0xtx');
  const b = await q.submitJob({ type: 'transfer', mode: 'sealed', sealed: { ...sealed, ct: 'REVG'.repeat(10) }, memos: [] });
  await q.nextJob();
  await q.ackJob(b.jobId, { error: 'the sealed prover is not available right now' });
  assert.strictEqual((await q.jobStatus(b.jobId)).status, 'failed');
  const c = await q.submitJob({ type: 'transfer', mode: 'sealed', sealed: { ...sealed, ct: 'REVG'.repeat(10) }, memos: [] });
  assert.strictEqual(c.jobId, b.jobId); assert.strictEqual(c.status, 'pending', 'a failed sealed job can be sent again');
  ok('sealed: queued without an op, deduped by ciphertext, handed to the relay as sealed, ciphertext dropped once settled, resendable once failed');
}

console.log(`\n${n} confidential-settle checks passed.`);
