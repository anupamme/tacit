// The open reflection batch: the batch the relayer is served is held open, byte for byte, for anyone to prove; reading it
// changes nothing; a copy landed by someone else is adopted from the API's own stash (POST /reflection/landed), its
// eth-state candidate is confirmed even when the pending slot moved on meanwhile, and the token routes are unchanged.
// Offline (mocked esplora and Ethereum RPC, in-memory KV): node tests/reflection-open.test.mjs
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { createHash } from 'node:crypto';
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d !== undefined ? ' - ' + JSON.stringify(d) : '')); fail++; } };

globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });
const { buildEnv, createCtxFactory, createTacitServer } = await import('../server/harness.mjs');
const worker = await import('../worker/src/index.js');

const TOKEN = 'box-token-0123456789abcdef';
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const EMPTY = '0x27ae5ba08d7291c96c8cbddcc148bf48a6d68c7974b94356f53754ef6171d757';
const D = (b) => '0x' + b.toString(16).padStart(2, '0').repeat(32);

const fresh = (extra = {}) => buildEnv(createMemDriver(), { extra: { CONFIDENTIAL_BOX_TOKEN: TOKEN, REFLECTION_ATTEST: '1', REFLECTION_GENESIS_HEIGHT: '99', ALLOWED_ORIGINS: 'https://tacit.finance', ...extra } });
const call = (env, path, { method = 'GET', body, auth = false, ip = '198.51.100.7', origin } = {}) => worker.default.fetch(new Request('https://api.test' + path, {
  method,
  headers: { 'CF-Connecting-IP': ip, ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}), env, { waitUntil() {} });
const kvJson = async (env, k) => { const v = await env.REGISTRY_KV.get(k); return v ? JSON.parse(v) : null; };
// Every non-meter record, to show a read left the state alone.
const stateOf = async (env) => {
  const out = {};
  const { keys } = await env.REGISTRY_KV.list({ prefix: '' });
  for (const { name } of keys) if (!name.startsWith('cps:')) out[name] = await env.REGISTRY_KV.get(name);
  return JSON.stringify(out);
};

// Esplora: two empty blocks at 100 and 101. Ethereum: the pool's attestedReflectionDigest() is whatever `poolDigest` says.
let poolDigest = null, rpcCalls = 0;
const hdr = (h) => h.toString(16).padStart(2, '0').repeat(80);
globalThis.fetch = async (url, init) => {
  const u = String(url);
  let m;
  if (/publicnode|mevblocker|merkle/.test(u)) {
    rpcCalls++;
    const req = JSON.parse(init.body);
    if (req.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x64' }));
    if (req.method === 'eth_call' && req.params[0].data === '0xb909cdaf' && poolDigest) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: poolDigest }));
    return new Response('no', { status: 500 });
  }
  if ((m = /\/block-height\/(\d+)$/.exec(u))) return new Response('ab'.repeat(31) + Number(m[1]).toString(16).padStart(2, '0'));
  if ((m = /\/block\/([0-9a-f]{64})\/header$/.exec(u))) return new Response(hdr(parseInt(m[1].slice(-2), 16)));
  if ((m = /\/block\/([0-9a-f]{64})\/raw$/.exec(u))) return new Response(Buffer.from(hdr(parseInt(m[1].slice(-2), 16)) + '00', 'hex'));
  throw new Error('offline: ' + u);
};

const ethPvOf = (n) => pool.buildEthPv(pool.imtEmptyRoot(), EMPTY, 0, 0, n ? '0x' + n.toString(16).padStart(40, '0') : null);
const publishEth = (env, ethPv, blob = 'eth-proof') => call(env, '/reflection/eth-state?network=mainnet', { method: 'POST', auth: true, body: { ethPv, crossouts: [], consumeds: [], ethCompressedProof: Buffer.from(blob).toString('base64'), lastBlock: 10, execBlock: 10 } });

// ── the relayer's batch is held open, byte for byte ──
const env = fresh();
await env.REGISTRY_KV.put('reflection:tip:mainnet', '101');
const E1 = (await (await publishEth(env, ethPvOf(0), 'eth-proof-one')).json()).contentHash;
ok('the open route answers with nothing before any batch is assembled', (await (await call(env, '/reflection/open?network=mainnet')).json()).job === null);

const jr = await call(env, '/reflection/job?network=mainnet', { auth: true });
const laneText = await jr.text();
const lane = JSON.parse(laneText);
ok('the relayer is served its batch as before', jr.status === 200 && lane.jobId && lane.input && lane.input.modeB === 1 && lane.attestedTo === 101 && lane.blocks === 2);

const open = await (await call(env, '/reflection/open?network=mainnet')).json();
ok('the open summary names that batch', open.job && open.job.jobId === lane.jobId && open.job.priorDigest === lane.priorDigest && open.job.attestedTo === 101 && open.job.from === 100 && open.job.blocks === 2);
ok('and its Ethereum candidate and size', open.job.modeB === 1 && open.job.ethContentHash === E1 && open.job.bytes === laneText.length);
ok('and the pool it lands on', /^0x[0-9a-fA-F]{40}$/.test(open.pool || ''));

const before = await stateOf(env);
const oj = await call(env, `/reflection/open/job?network=mainnet&jobId=${lane.jobId.toUpperCase().replace('0X', '0x')}`);
const ojText = await oj.text();
ok('the open job body is byte for byte what the relayer was served', oj.status === 200 && ojText === laneText);
ok('reading the open batch changes nothing', (await stateOf(env)) === before);
const stash = await kvJson(env, `reflection:pending:mainnet:${lane.jobId.slice(2)}`);
ok('the batch is stashed under its own digest, with the candidate it folded', stash && stash.ethContentHash === E1 && stash.ethCandidate && stash.ethCandidate.contentHash === E1 && stash.attestedTo === 101);

ok('the body needs a jobId', (await call(env, '/reflection/open/job?network=mainnet', { ip: '198.51.100.8' })).status === 400);
{
  const r = await call(env, `/reflection/open/job?network=mainnet&jobId=${D(0x11)}`, { ip: '198.51.100.9' });
  ok('a jobId that is not held open is refused, naming the one that is', r.status === 404 && (await r.json()).jobId === lane.jobId);
}

const eproof = await call(env, `/reflection/eth-state/proof?network=mainnet&contentHash=${E1}`);
ok('the Ethereum proof the batch recurses is public', eproof.status === 200 && Buffer.from((await eproof.json()).ethCompressedProofB64, 'base64').toString() === 'eth-proof-one');
ok('an unknown candidate still is not served', (await call(env, `/reflection/eth-state/proof?network=mainnet&contentHash=${D(0x22)}`)).status === 404);

{
  // Serving the same batch again does not rewrite it.
  const at = open.job.at;
  const again = await call(env, '/reflection/job?network=mainnet', { auth: true });
  ok('the same batch served again is the same body', (await again.text()) === laneText);
  ok('and is not written again', (await (await call(env, '/reflection/open?network=mainnet')).json()).job.at === at);
}

// ── someone else lands it; the pending slot moved on meanwhile ──
{
  const p1 = await kvJson(env, 'reflection:ethstate:pending:mainnet');
  await env.REGISTRY_KV.put('reflection:ethstate:pending:mainnet', JSON.stringify({ ...p1, publishedAt: 1 }));
  const E2 = (await (await publishEth(env, ethPvOf(7), 'eth-proof-two')).json()).contentHash;
  ok('(a fresh candidate replaced the aged one)', E2 && E2 !== E1 && (await kvJson(env, 'reflection:ethstate:pending:mainnet')).contentHash === E2);

  poolDigest = null;
  const r0 = await (await call(env, '/reflection/landed', { method: 'POST', body: { network: 'mainnet' } })).json();
  ok('landed before the pool shows the batch adopts nothing', r0.ok && r0.adopted === false && !(await kvJson(env, 'reflection:scan:mainnet')));

  env.REFLECTION_LANDED_GAP_MS = '0';
  poolDigest = lane.jobId;
  const r1 = await (await call(env, '/reflection/landed', { method: 'POST', body: { network: 'mainnet' } })).json();
  ok('landed adopts the batch from the stash once the pool holds it', r1.adopted === true && r1.attestedTo === 101 && r1.jobId === lane.jobId);
  ok('the cursor is at the batch', (await kvJson(env, 'reflection:scan:mainnet')).attestedHeight === 101);
  ok('the stash is consumed', !(await env.REGISTRY_KV.get(`reflection:pending:mainnet:${lane.jobId.slice(2)}`)));
  ok('the candidate the batch folded is confirmed though it had left the pending slot', (await kvJson(env, 'reflection:ethstate:confirmed:mainnet')).contentHash === E1);
  ok('the pending candidate built beside it is dropped', !(await env.REGISTRY_KV.get('reflection:ethstate:pending:mainnet')));
  ok('the spent batch is no longer held open', (await (await call(env, '/reflection/open?network=mainnet')).json()).job === null);
  const r2 = await (await call(env, '/reflection/landed', { method: 'POST', body: { network: 'mainnet' } })).json();
  ok('a second landed call adopts nothing more', r2.ok && r2.adopted === false);
  const next = await call(env, '/reflection/job?network=mainnet', { auth: true });
  ok('the relayer then sees it caught up, with no drift to refuse', next.status === 200 && (await next.text()) === '{}');
}

// ── within the gap, landed calls share one reading ──
{
  const e = fresh({ REFLECTION_LANDED_GAP_MS: '60000' });
  poolDigest = D(0x33);
  await call(e, '/reflection/landed', { method: 'POST', body: { network: 'mainnet' }, ip: '203.0.113.1' });
  const n = rpcCalls;
  await call(e, '/reflection/landed', { method: 'POST', body: { network: 'mainnet' }, ip: '203.0.113.2' });
  ok('a landed call inside the gap reuses the last reading', rpcCalls === n);
  e.REFLECTION_LANDED_GAP_MS = '0';
  let last;
  for (let i = 0; i < 7; i++) last = await call(e, '/reflection/landed', { method: 'POST', body: { network: 'mainnet' }, ip: '203.0.113.3' });
  ok('landed is metered per caller', last.status === 429 && last.headers.get('retry-after'));
}

// ── ack promotion, case by case ──
{
  const att = (advanced) => ({ ackJob: async () => ({ advanced, attestedHeight: 200 }) });
  const rec = (h, n) => ({ ethPv: '0x' + n, crossouts: [], consumeds: [], contentHash: h, lastBlock: n, publishedAt: n });
  const H1 = D(0xa1), H2 = D(0xa2), H0 = D(0xa0);
  const setup = async ({ pending, confirmed }) => {
    const e = fresh();
    if (pending) await e.REGISTRY_KV.put('reflection:ethstate:pending:mainnet', JSON.stringify(pending));
    if (confirmed) await e.REGISTRY_KV.put('reflection:ethstate:confirmed:mainnet', JSON.stringify(confirmed));
    return e;
  };
  const stashOf = (withCandidate = true) => ({ newSnapshot: {}, ethContentHash: H1, ethCandidate: withCandidate ? rec(H1, 1) : null, attestedTo: 200 });
  const st = async (e) => [(await kvJson(e, 'reflection:ethstate:confirmed:mainnet'))?.contentHash ?? null, (await kvJson(e, 'reflection:ethstate:pending:mainnet'))?.contentHash ?? null];

  let e = await setup({ pending: rec(H1, 1), confirmed: rec(H0, 0) });
  await worker.applyReflectionAck(e, 'mainnet', att(true), D(0xb1), stashOf(), 200);
  ok('a folded candidate still pending is promoted and its slot freed', JSON.stringify(await st(e)) === JSON.stringify([H1, null]));

  e = await setup({ pending: rec(H2, 2), confirmed: rec(H0, 0) });
  await worker.applyReflectionAck(e, 'mainnet', att(false), D(0xb1), stashOf(), 200);
  ok('a duplicate ack leaves both records alone', JSON.stringify(await st(e)) === JSON.stringify([H0, H2]));

  e = await setup({ pending: rec(H2, 2), confirmed: rec(H1, 1) });
  await worker.applyReflectionAck(e, 'mainnet', att(true), D(0xb1), stashOf(), 200);
  ok('a candidate already confirmed keeps the pending one built on it', JSON.stringify(await st(e)) === JSON.stringify([H1, H2]));

  e = await setup({ pending: rec(H2, 2), confirmed: rec(H0, 0) });
  await worker.applyReflectionAck(e, 'mainnet', att(true), D(0xb1), stashOf(false), 200);
  ok('a stash without the candidate record changes neither', JSON.stringify(await st(e)) === JSON.stringify([H0, H2]));

  e = await setup({ confirmed: rec(H0, 0) });
  await worker.applyReflectionAck(e, 'mainnet', att(true), D(0xb1), stashOf(), 200);
  ok('with the pending slot empty the folded candidate is confirmed', JSON.stringify(await st(e)) === JSON.stringify([H1, null]));
  ok('the promoted record is the folded one', (await kvJson(e, 'reflection:ethstate:confirmed:mainnet')).lastBlock === 1);

  // The open batch follows the cursor.
  const held = async (e) => (await kvJson(e, 'reflection:open:mainnet'))?.jobId ?? null;
  const job = (id, prior) => ({ jobId: id, priorDigest: prior, input: { modeB: 0 }, attestedTo: 5, blocks: 1 });
  e = fresh();
  await worker.publishOpenReflectionJob(e, 'mainnet', job(D(0xc2), D(0xc1)), '{"x":1}');
  await worker.applyReflectionAck(e, 'mainnet', att(false), D(0xc9), { newSnapshot: {} }, 5);
  ok('an ack that does not advance keeps the open batch', (await held(e)) === D(0xc2));
  await worker.applyReflectionAck(e, 'mainnet', att(true), D(0xc2), { newSnapshot: {} }, 5);
  ok('an advancing ack drops a batch built on the old prior', (await held(e)) === null && !(await e.REGISTRY_KV.get('reflection:open:job:mainnet')));
  await worker.publishOpenReflectionJob(e, 'mainnet', job(D(0xc3), D(0xc2)), '{"x":2}');
  await worker.applyReflectionAck(e, 'mainnet', att(true), D(0xc2), { newSnapshot: {} }, 5);
  ok('and keeps one built on the new cursor', (await held(e)) === D(0xc3));
}

// ── holding a batch open never fails the relayer's job ──
{
  const e = fresh();
  const kv = e.REGISTRY_KV;
  e.REGISTRY_KV = { ...kv, get: kv.get.bind(kv), list: kv.list.bind(kv), delete: kv.delete.bind(kv), getWithMetadata: kv.getWithMetadata.bind(kv),
    put: async (k, v, o) => { if (k.startsWith('reflection:open')) throw new Error('value too large'); return kv.put(k, v, o); } };
  await kv.put('reflection:tip:mainnet', '101');
  const body = await worker.assembleReflectionJobBody(e, 'mainnet', {});
  ok('a failed open write still returns the batch, stashed', !!body && !!(await kv.get(`reflection:pending:mainnet:${JSON.parse(body).jobId.slice(2)}`)));
}

// ── metering ──
{
  const e = fresh({ REFLECTION_OPEN_JOB_ALL_RL_BURST: '5' });
  await worker.publishOpenReflectionJob(e, 'mainnet', { jobId: D(0xd1), priorDigest: D(0xd0), input: { modeB: 0 }, attestedTo: 9, blocks: 1 }, '{"big":true}');
  const get = (ip, auth) => call(e, `/reflection/open/job?network=mainnet&jobId=${D(0xd1)}`, { ip, auth });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await get('192.0.2.1')).status);
  ok('the body is metered per caller', codes.join() === '200,200,200,429', codes);
  const r429 = await get('192.0.2.1');
  ok('with a Retry-After', r429.status === 429 && Number(r429.headers.get('retry-after')) > 0);
  ok('another caller is served', (await get('192.0.2.2')).status === 200);
  ok('until the total allowance is spent', (await get('192.0.2.3')).status === 200 && (await get('192.0.2.4')).status === 429);
  ok('the box token is not metered', (await get('192.0.2.5', true)).status === 200 && (await get('192.0.2.5', true)).status === 200);
  await e.REGISTRY_KV.delete('reflection:open:job:mainnet');
  const cached = await get('192.0.2.6', true);
  ok('a batch already read is served from the response cache', cached.status === 200 && (await cached.text()) === '{"big":true}');
  await worker.publishOpenReflectionJob(e, 'mainnet', { jobId: D(0xd2), priorDigest: D(0xd1), input: { modeB: 0 }, attestedTo: 10, blocks: 1 }, '{"next":true}');
  ok('a replaced batch is refused even while cached', (await get('192.0.2.6', true)).status === 404);
  e.memGuard = { snapshot: () => ({ rssMb: 900, limitMb: 1000, softMb: 750, hardMb: 900 }) };
  const busy = await call(e, `/reflection/open/job?network=mainnet&jobId=${D(0xd2)}`, { auth: true });
  ok('a body not yet cached is refused over the soft memory mark', busy.status === 503 && busy.headers.get('retry-after') === '30');
  delete e.memGuard;
  e.REFLECTION_OPEN_MAX_MB = '0.00001';
  await worker.publishOpenReflectionJob(e, 'mainnet', { jobId: D(0xd3), priorDigest: D(0xd2), input: { modeB: 0 }, attestedTo: 11, blocks: 1 }, '{"tooLarge":"' + 'x'.repeat(40) + '"}');
  ok('a body over the size cap is not held, and the batch before it is let go', (await (await call(e, '/reflection/open?network=mainnet', { ip: '192.0.2.10' })).json()).job === null);
  delete e.REFLECTION_OPEN_MAX_MB;

  const pv = ethPvOf(3);
  const h = (await (await publishEth(e, pv)).json()).contentHash;
  const ec = [];
  for (let i = 0; i < 5; i++) ec.push((await call(e, `/reflection/eth-state/proof?network=mainnet&contentHash=${h}`, { ip: '192.0.2.9' })).status);
  ok('the Ethereum proof is metered for callers without the token', ec.join() === '200,200,200,200,429', ec);
  ok('and not for the relayer', (await call(e, `/reflection/eth-state/proof?network=mainnet&contentHash=${h}`, { ip: '192.0.2.9', auth: true })).status === 200);
}

// ── the bundle listing is public, metered and briefly cached ──
{
  const e = fresh();
  const bundle = (n) => JSON.stringify({ etch: { blockHeight: 948242 }, cxfers: Array.from({ length: n }, () => ({ blockHeight: 950000 })) });
  await e.REGISTRY_KV.put(`reflection:burndep:mainnet:${'e1'.repeat(32)}`, bundle(2));
  const r = await call(e, '/reflection/burndep-list?network=mainnet', { origin: 'https://elsewhere.example' });
  const b = await r.json();
  ok('the bundle listing is served without the token', r.status === 200 && b.count === 1 && b.entries[0].txid === 'e1'.repeat(32) && b.entries[0].missing.length === 0);
  ok('to any origin', r.headers.get('access-control-allow-origin') === '*');
  await e.REGISTRY_KV.put(`reflection:burndep:mainnet:${'e2'.repeat(32)}`, '{"etch":{}}');
  ok('a public read inside a minute is the cached listing', (await (await call(e, '/reflection/burndep-list?network=mainnet')).json()).count === 1);
  const fresh2 = await (await call(e, '/reflection/burndep-list?network=mainnet', { auth: true })).json();
  ok('the relayer reads it fresh, with the missing fields', fresh2.count === 2 && fresh2.entries.find((x) => x.txid === 'e2'.repeat(32)).missing.includes('etch'));
  let last;
  for (let i = 0; i < 31; i++) last = await call(e, '/reflection/burndep-list?network=mainnet', { ip: '192.0.2.77' });
  ok('the public listing is metered', last.status === 429);
}

// ── CORS and the token routes ──
{
  const e = fresh();
  for (const p of ['/reflection/open?network=mainnet', `/reflection/eth-state/proof?network=mainnet&contentHash=${D(1)}`]) {
    const r = await call(e, p, { origin: 'https://elsewhere.example', ip: '192.0.2.200' });
    ok(`${p.split('?')[0]} is open to any origin`, r.headers.get('access-control-allow-origin') === '*');
  }
  const gated = [
    ['/reflection/job?network=mainnet', 'GET'], ['/reflection/eth-state?network=mainnet', 'GET'], ['/reflection/pending?digest=' + D(1), 'GET'],
    ['/reflection/attest-state', 'GET'], ['/reflection/ack', 'POST'], ['/reflection/seed?network=mainnet', 'POST'], ['/reflection/eth-state/clear?network=mainnet', 'POST'],
  ];
  for (const [p, method] of gated) {
    const r = await call(e, p, { method, body: method === 'POST' ? { network: 'mainnet' } : undefined, ip: '192.0.2.201' });
    ok(`${method} ${p.split('?')[0]} still needs the box token`, r.status === 404);
  }
}

// ── the body streams through the Node server ──
{
  const e = fresh();
  const big = JSON.stringify({ jobId: D(0xe1), input: { blob: 'ab'.repeat(300_000) } });
  await worker.publishOpenReflectionJob(e, 'mainnet', { jobId: D(0xe1), priorDigest: D(0xe0), input: { modeB: 0 }, attestedTo: 9, blocks: 1 }, big);
  const realFetch = globalThis.fetch;
  const server = createTacitServer({ workerModule: worker.default, env: e, driver: null, ctxFactory: createCtxFactory() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { request } = await import('node:http');
    const text = await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port: server.address().port, path: `/reflection/open/job?network=mainnet&jobId=${D(0xe1)}` }, (res) => {
        const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve(Buffer.concat(parts).toString()));
      }).on('error', reject).end();
    });
    ok('the Node server returns the whole body', text === big);
  } finally { server.close(); globalThis.fetch = realFetch; }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
