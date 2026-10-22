// Runs one POST /reflection/burndep/check on a worker thread (burnDepositCheckOutcome in worker/src/index.js). The check
// verifies every hop of a note's lineage in plain JavaScript, tens of seconds of CPU for a deep one, which on the main
// thread holds every other request and the platform's health check (five seconds) with it. The thread opens its own
// Postgres pool, so it needs DATABASE_URL, as server/reflection-job-thread.mjs does.
//
// One check runs at a time and a few may wait behind it; past that the caller is told to retry, since each thread loads
// the lineage's blocks (hundreds of MB at the deepest) and the instance has 2 GB.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// How long one check may run. A check reads one Bitcoin block per transfer of the history (each kept for good once read, so a
// check stopped part way leaves what it read for the next) and then verifies every transfer in plain JavaScript. Verifying took 1 to 3
// s a transfer on this instance, nearly all of it the range proofs checked one at a time, so a history of a hundred and thirty
// transfers needed over six minutes, and the deepest the door takes (256) over twelve. The proofs are now checked together
// (verifiedHops in dapp/burn-deposit-bitcoin.js): a hundred and nineteen transfers took 364 s one by one and 4 s together on a
// laptop, which leaves reading a history for the first time as the longer part. A flat limit stopped every slow check at the same
// point and the asker began it again from nothing, for as long as it kept asking, each pass holding the one lane. The limit now
// grows with the history, and a check that is reading is also stopped when it has read nothing new for a while.
const THREAD_TIMEOUT_MS = Number(process.env.BURNDEP_CHECK_TIMEOUT_MS) || 6 * 60_000;       // the least any check is given
const BASE_MS = Number(process.env.BURNDEP_CHECK_BASE_MS) || 90_000;
const PER_HOP_MS = Number(process.env.BURNDEP_CHECK_MS_PER_HOP) || 4_000;
export const CHECK_CEILING_MS = Math.max(THREAD_TIMEOUT_MS, Number(process.env.BURNDEP_CHECK_CEILING_MS) || 25 * 60_000);
const STALL_MS = Number(process.env.BURNDEP_CHECK_STALL_MS) || 3 * 60_000;
export const CHECK_QUEUE_MAX = Number(process.env.BURNDEP_CHECK_QUEUE_MAX) || 3;
export const CHECK_PER_OWNER = Number(process.env.BURNDEP_CHECK_PER_OWNER) || 2;

// The transactions a body's history holds (the etch, every transfer and every mint), from the request alone.
export function hopsOf(body) {
  const b = body && body.bundle;
  if (!b) return 0;
  return (b.etch ? 1 : 0) + (Array.isArray(b.cxfers) ? b.cxfers.length : 0) + (Array.isArray(b.cmints) ? b.cmints.length : 0);
}
export const checkLimitMs = (hops, limits = {}) => {
  const { floor = THREAD_TIMEOUT_MS, base = BASE_MS, perHop = PER_HOP_MS, ceiling = CHECK_CEILING_MS } = limits;
  return Math.min(Math.max(ceiling, floor), Math.max(floor, base + Math.max(0, Number(hops) || 0) * perHop));
};

if (!isMainThread) {
  const { createCacheStorage } = await import('./cache-mem.mjs');
  globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });   // the worker module expects caches.default
  const { createPgDriver } = await import('./driver-pg.mjs');
  const { buildEnv } = await import('./harness.mjs');
  const driver = await createPgDriver(process.env.DATABASE_URL, { max: 2 });
  try {
    const { burnDepositCheckOutcome } = await import('../worker/src/index.js');
    const out = await burnDepositCheckOutcome(buildEnv(driver), workerData.network, workerData.body, { phase: (phase, info) => parentPort.postMessage({ progress: { phase, ...info } }) });
    parentPort.postMessage({ out });
  } catch (e) {
    parentPort.postMessage({ error: String(e?.message || e) });
  } finally {
    await driver.close();
  }
}

// A gate of one, with a short queue: `enter()` resolves with a release function, or null when the queue is full or the
// ticket's owner already holds `perOwner` places (running or waiting), so one holder cannot take the whole lane. A waiter
// passes a ticket so `ahead(ticket)` can say how many checks stand before it.
export function makeGate({ max = CHECK_QUEUE_MAX, perOwner = CHECK_PER_OWNER } = {}) {
  let current = null;
  let running = false;
  const waiting = [];
  const next = () => {
    const w = waiting.shift();
    if (!w) { running = false; current = null; return; }
    current = w.ticket;
    w.wake();
  };
  const holds = (owner) => (current && current.owner === owner ? 1 : 0) + waiting.filter((w) => w.ticket && w.ticket.owner === owner).length;
  return {
    enter(ticket = null) {
      const owner = ticket && ticket.owner && ticket.owner !== 'anon' ? ticket.owner : null;
      if (owner && perOwner > 0 && holds(owner) >= perOwner) return Promise.resolve(null);
      if (!running) { running = true; current = ticket; return Promise.resolve(() => next()); }
      if (waiting.length >= max) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push({ ticket, wake: () => resolve(() => next()) }));
    },
    ahead(ticket) {
      const i = waiting.findIndex((w) => w.ticket === ticket);
      return i < 0 ? 0 : i + (running ? 1 : 0);
    },
    get waiting() { return waiting.length; },
    get busy() { return running; },
  };
}
const gate = makeGate();

const secs = (ms) => Math.round(ms / 1000);

// → { status, body, retryAfter? }, never a rejection: a thread that fails, is killed or runs out of time answers as the
// check would for a bundle it could not judge. `progress` is filled in for the caller: `snapshot()` says where the check
// stands, waiting for its turn with so many ahead of it, or running for so long and how far it has read or what it is
// doing. `spawn(network, body)` makes the worker (a test passes its own), `limits` overrides the time limits.
export async function runBurnDepositCheck(network, body, progress = {}, { spawn = null, limits = {} } = {}) {
  const queuedAt = Date.now();
  progress.state = 'queued';
  progress.snapshot = () => ({
    state: progress.state,
    ahead: progress.state === 'queued' ? gate.ahead(progress) : 0,
    queuedSec: secs((progress.startedAt || Date.now()) - queuedAt),
    runningSec: progress.startedAt ? secs(Date.now() - progress.startedAt) : 0,
    ...(progress.state === 'running' && progress.phase ? { phase: progress.phase, done: progress.done || 0, total: progress.total || 0 } : {}),
  });
  const release = await gate.enter(progress);
  if (!release) {
    progress.state = 'refused';
    return { status: 429, body: { ok: false, error: 'the check is busy with other lineages; retry in a moment', retryAfter: 15 }, retryAfter: 15 };
  }
  const t0 = progress.startedAt = Date.now();
  progress.state = 'running';
  const waited = secs(t0 - queuedAt);
  const limit = checkLimitMs(hopsOf(body), limits), stall = limits.stall ?? STALL_MS, watch = limits.watch ?? 2_000;
  const said = (what, extra = '') => console.log(`[burndep-check-thread] ${network} ${what} in ${((Date.now() - t0) / 1000).toFixed(1)}s${waited ? `, after ${waited}s in line` : ''}${extra}`);
  // Where it was when it stopped, for the server's log: the phase, and for the reading phase how many transactions it had read.
  const where = () => (progress.phase ? `; ${progress.phase}${progress.phase === 'reading' && progress.total ? ` ${progress.done || 0} of ${progress.total}` : ''}` : '');
  try {
    return await new Promise((resolve) => {
      const worker = spawn ? spawn(network, body) : new Worker(new URL(import.meta.url), { workerData: { network, body } });
      let settled = false, lastAt = Date.now();
      const done = (v) => { if (settled) return; settled = true; clearInterval(timer); resolve(v); };
      const stop = (why, error) => {
        worker.terminate();
        said('stopped', ` (${why}${where()})`);
        done({ status: 504, body: { ok: false, error } });
      };
      const timer = setInterval(() => {
        const age = Date.now() - t0;
        if (age >= limit) stop(`limit ${secs(limit)}s for ${hopsOf(body)} transactions`, `the check took longer than ${secs(limit)} s and was stopped`);
        else if (progress.phase === 'reading' && Date.now() - lastAt >= stall) stop(`no transaction read for ${secs(Date.now() - lastAt)}s`, 'the check was stopped: Bitcoin’s blocks were not coming in');
      }, watch);
      worker.on('message', (m) => {
        if (m && m.progress) {
          const p = m.progress;
          if (p.phase !== progress.phase || (Number.isFinite(p.done) && p.done !== progress.done)) lastAt = Date.now();
          progress.phase = p.phase;
          if (Number.isFinite(p.done)) progress.done = p.done;
          if (Number.isFinite(p.total)) progress.total = p.total;
          return;
        }
        const t = m.out?.timing;
        said(m.error ? 'failed' : `${m.out?.status}`, t ? ` (${t.hops} hops: read ${t.enrichMs} ms, headers ${t.headersMs} ms, verify ${t.admitMs} ms)` : '');
        if (m.error) done({ status: 502, body: { ok: false, error: `check failed: ${m.error}` } }); else done(m.out);
      });
      worker.on('error', (e) => { said('errored', `: ${e?.message || e}`); done({ status: 502, body: { ok: false, error: `check failed: ${e?.message || e}` } }); });
      worker.on('exit', (code) => { if (!settled) said('exited', ` (code ${code}) before answering`); done({ status: 502, body: { ok: false, error: `the check stopped (${code}) before answering` } }); });
    });
  } finally {
    progress.state = 'done';
    release();
  }
}
