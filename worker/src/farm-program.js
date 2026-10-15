// GET /farm/program and GET /farm/health: the launch farms' emission schedule and a solvency verdict, read straight from the
// FarmManager on chain. Public and cached, so a dapp or a status page can poll them without an RPC key.
//
// One upstream read serves every caller. An answer past its few seconds is still served at once (up to two minutes old) while the next is read
// behind it, and the next is read ahead of time while callers keep asking, so nobody waits for the chain. When the chain cannot be read the last
// good answer is served (marked stale) until it is two minutes old and then a plain 503: a dashboard that keeps showing a two-hour-old treasury is
// worse than one that says it cannot tell.
import { makeRpc, readFarmRaw, buildProgram, publicProgram, farmHealth, FARM_MANAGER_MAINNET, FARM_RPCS_MAINNET } from '../../worker-relay/src/lib/farm-health.js';

export const FARM_TTL_MS = 15000;      // an answer this young is served as it is
export const FARM_STALE_MS = 120000;   // one this old is the last good answer: served at once while the next is read behind it, and marked stale if that read fails
export const FARM_WARM_MS = 45000;     // while callers are asking, the next answer is read this often, so none of them waits for the chain (a slow node cost one 26 s)
export const FARM_IDLE_MS = 600000;    // and the reading stops when nobody has asked for this long

const cache = new Map(); // network -> { at, value, failed }
const inflight = new Map();
const warmers = new Map(); // network -> { timer, asked }
let loader = load;

export function _resetFarmCache() { cache.clear(); inflight.clear(); for (const w of warmers.values()) clearInterval(w.timer); warmers.clear(); loader = load; }
export function _setFarmLoader(fn) { loader = fn; }

async function load(network, env) {
  const manager = env.FARM_MANAGER_ADDR || FARM_MANAGER_MAINNET;
  const raw = await readFarmRaw(makeRpc(FARM_RPCS_MAINNET), manager);
  const program = raw.codeMissing ? raw : buildProgram(raw, { network });
  return { program, health: farmHealth(program), updatedAt: new Date().toISOString() };
}

// One read at a time per network, shared by everyone who asks while it runs.
function refresh(network, env) {
  let p = inflight.get(network);
  if (!p) {
    p = loader(network, env).then((value) => { cache.set(network, { at: Date.now(), value }); return value; }).finally(() => inflight.delete(network));
    inflight.set(network, p);
  }
  return p;
}

// While the page is being asked for, read the next answer before the last one runs out. Stops itself when the asking stops.
function keepWarm(network, env) {
  let w = warmers.get(network);
  if (w) { w.asked = Date.now(); return; }
  if (typeof setInterval !== 'function') return;
  const warmMs = Number(env?.FARM_WARM_MS) || FARM_WARM_MS, idleMs = Number(env?.FARM_IDLE_MS) || FARM_IDLE_MS;   // settable, so a deployment (or a test) can set the cadence
  w = { asked: Date.now(), timer: null };
  w.timer = setInterval(() => {
    if (Date.now() - w.asked > idleMs) { clearInterval(w.timer); if (warmers.get(network) === w) warmers.delete(network); return; }
    const hit = cache.get(network);
    if (!hit || Date.now() - hit.at >= warmMs * 0.9) refresh(network, env).catch(() => {});
  }, warmMs);
  w.timer?.unref?.();
  warmers.set(network, w);
}

// `swr`: serve an answer past its few seconds at once and read the next behind it (the dapp's /farm/program). /farm/health does not: a verdict on the
// farm's solvency waits for a fresh read and fails closed when there is none.
async function current(network, env, swr) {
  keepWarm(network, env);
  const hit = cache.get(network), age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < FARM_TTL_MS) return { value: hit.value, stale: false };
  if (swr && hit && age < FARM_STALE_MS) {
    // A good answer is in hand: it is served now and the next is read behind it. If that read fails the answer is marked stale until one succeeds.
    refresh(network, env).catch(() => { hit.failed = true; });
    return { value: hit.value, stale: !!hit.failed };
  }
  try { return { value: await refresh(network, env), stale: false }; }
  catch (e) {
    if (hit && Date.now() - hit.at < FARM_STALE_MS) return { value: hit.value, stale: true };
    return { error: e?.message || String(e) };
  }
}

// `json(obj, status, headers)` is the worker's own response helper, passed in so this module stays free of its internals.
export async function handleFarm(kind, url, env, cors, json) {
  const network = url.searchParams.get('network') === 'signet' ? 'signet' : 'mainnet';
  const noStore = { ...cors, 'Cache-Control': 'no-store' };
  if (network !== 'mainnet') return json({ error: 'no farm program on this network' }, 404, noStore);
  const health = kind === 'health';
  const r = await current(network, env, !health);
  if (r.error) {
    const body = health
      ? { status: 'critical', checks: [{ name: 'rpc', status: 'critical', detail: `farm state unreadable: ${r.error}` }] }
      : { error: 'farm program unavailable', detail: r.error };
    return json(body, 503, { ...noStore, 'Retry-After': '15' });
  }
  const { program, health: h, updatedAt } = r.value;
  const headers = { ...cors, 'Cache-Control': 'public, max-age=15', ...(r.stale ? { 'X-Farm-Stale': '1' } : {}) };
  if (health) return json({ ...h, stale: r.stale, updatedAt }, 200, headers);
  if (program.codeMissing) return json({ error: 'farm program unavailable', detail: `no contract code at ${program.manager}` }, 503, noStore);
  return json({ ...publicProgram(program), stale: r.stale, updatedAt }, 200, headers);
}
