#!/usr/bin/env node
// A job record in the relay's KV (cps:job:<id>) is written with a thirty-day lifetime; the queue lists are not.
//   node tests/confidential-job-retention.test.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { buildConfidentialSettler, makeConfidentialSettler } from '../worker/src/confidential-settle.js';

const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };

const writes = [];
const store = new Map();
const KV = { get: async (k) => (store.has(k) ? store.get(k) : null), put: async (k, v, o) => { writes.push({ k, o }); store.set(k, String(v)); } };
const settler = buildConfidentialSettler({ REGISTRY_KV: KV }, { hash });
const r = await settler.submitJob({ type: 'swap', op: { reserveAPre: 1000, reserveBPre: 1000, intents: [{ amountIn: 100 }] } });
ok(r && r.jobId, 'a job is accepted');
const job = writes.filter((w) => w.k.startsWith('cps:job:'));
ok(job.length > 0 && job.every((w) => w.o && w.o.expirationTtl === 30 * 86400), `every job write carries a thirty-day lifetime (${job.length} writes)`);
const lists = writes.filter((w) => w.k === 'cps:pending' || w.k === 'cps:open');
ok(lists.length > 0 && lists.every((w) => !w.o), 'the queue lists are written without one');
// A job closed by a settle sent outside the relay keeps its id, memos and transaction, and not its witness or a sealed input's ciphertext.
{
  const jobs = new Map();
  const storage = { getPending: async () => [], putPending: async () => {}, getOpen: async () => ['a', 'b'], putOpen: async () => {},
    getJob: async (id) => (jobs.has(id) ? JSON.parse(jobs.get(id)) : null), putJob: async (id, j) => jobs.set(id, JSON.stringify(j)) };
  const base = { type: 'swap', status: 'proven', publicValues: '0xAB', proof: '0x01', memos: ['0x07'], op: { nk: '0x11', leafIndex: 3, path: ['0x22'] }, sealed: { worker: 'w', ct: 'deadbeef', epk: '02' } };
  jobs.set('a', JSON.stringify({ ...base })); jobs.set('b', JSON.stringify({ ...base, status: 'open', openSince: 1 }));
  const q = makeConfidentialSettler({ storage, hash, sleep: () => Promise.resolve() });
  const r = await q.landedJob('a', '0xBEEF', async () => ({ ok: true }));
  ok(r && r.status === 'settled', 'the job is closed by the landed settle');
  for (const id of ['a', 'b']) {
    const j = await storage.getJob(id);
    ok(j.status === 'settled' && j.txHash === '0xbeef' && j.memos.length === 1 && j.publicValues === '0xAB', `${id}: its id, memos, public values and transaction stay`);
    ok(!('op' in j) && j.sealed && j.sealed.worker === 'w' && !('ct' in j.sealed) && !('epk' in j.sealed), `${id}: its witness and sealed ciphertext are gone`);
  }
}
console.log(`${n} checks`);
