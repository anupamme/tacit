// Runs one POST /reflection/burndep/check on a worker thread (burnDepositCheckOutcome in worker/src/index.js). The check
// verifies every hop of a note's lineage in plain JavaScript, tens of seconds of CPU for a deep one, which on the main
// thread holds every other request and the platform's health check (five seconds) with it. The thread opens its own
// Postgres pool, so it needs DATABASE_URL, as server/reflection-job-thread.mjs does.
//
// One check runs at a time and a few may wait behind it; past that the caller is told to retry, since each thread loads
// the lineage's blocks (hundreds of MB at the deepest) and the instance has 2 GB.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const THREAD_TIMEOUT_MS = Number(process.env.BURNDEP_CHECK_TIMEOUT_MS) || 6 * 60_000;
export const CHECK_QUEUE_MAX = Number(process.env.BURNDEP_CHECK_QUEUE_MAX) || 3;

if (!isMainThread) {
  const { createCacheStorage } = await import('./cache-mem.mjs');
  globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });   // the worker module expects caches.default
  const { createPgDriver } = await import('./driver-pg.mjs');
  const { buildEnv } = await import('./harness.mjs');
  const driver = await createPgDriver(process.env.DATABASE_URL, { max: 2 });
  try {
    const { burnDepositCheckOutcome } = await import('../worker/src/index.js');
    const out = await burnDepositCheckOutcome(buildEnv(driver), workerData.network, workerData.body);
    parentPort.postMessage({ out });
  } catch (e) {
    parentPort.postMessage({ error: String(e?.message || e) });
  } finally {
    await driver.close();
  }
}

// A gate of one, with a short queue: `enter()` resolves with a release function, or null when the queue is full.
export function makeGate({ max = CHECK_QUEUE_MAX } = {}) {
  let running = false;
  const waiting = [];
  const next = () => {
    const w = waiting.shift();
    if (!w) { running = false; return; }
    w();
  };
  return {
    enter() {
      if (!running) { running = true; return Promise.resolve(() => next()); }
      if (waiting.length >= max) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(() => resolve(() => next())));
    },
    get waiting() { return waiting.length; },
    get busy() { return running; },
  };
}
const gate = makeGate();

// → { status, body, retryAfter? }, never a rejection: a thread that fails, is killed or runs out of time answers as the
// check would for a bundle it could not judge.
export async function runBurnDepositCheck(network, body) {
  const release = await gate.enter();
  if (!release) return { status: 429, body: { ok: false, error: 'the check is busy with other lineages; retry in a moment', retryAfter: 15 }, retryAfter: 15 };
  const t0 = Date.now();
  try {
    return await new Promise((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { network, body } });
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => { worker.terminate(); done({ status: 504, body: { ok: false, error: `the check took longer than ${Math.round(THREAD_TIMEOUT_MS / 1000)} s and was stopped` } }); }, THREAD_TIMEOUT_MS);
      worker.on('message', (m) => {
        console.log(`[burndep-check-thread] ${network} ${m.error ? 'failed' : `${m.out?.status}`} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        if (m.error) done({ status: 502, body: { ok: false, error: `check failed: ${m.error}` } }); else done(m.out);
      });
      worker.on('error', (e) => done({ status: 502, body: { ok: false, error: `check failed: ${e?.message || e}` } }));
      worker.on('exit', (code) => done({ status: 502, body: { ok: false, error: `the check stopped (${code}) before answering` } }));
    });
  } finally {
    release();
  }
}
