// The API's side of finishing a bridge mint for a holder, through the real routes: a stale mint is renewed at the door and for a queued job,
// and a mint armed at burn time is queued by the relay's poll once its burn is recorded on the root the pool holds.
//   node --test tests/bridge-armed-route.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialBridgeMint, destValueFor, txidInternal } from '../dapp/confidential-bridge-mint.js';
import { admitBridgeMint } from '../worker/src/bridgemint-admit.js';

const worker = await import('../worker/src/index.js');
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const bm = makeConfidentialBridgeMint({ pool, ct });
const ASSET = '0x' + 'a5'.repeat(32), CB = '0x' + '7c'.repeat(32), AUTH = '0x' + '00'.repeat(31) + 'b7';
const DEST_OWNER = pool.nkToOwner('0x' + 'c5'.repeat(32)), TX = txidInternal('33'.repeat(31) + '44');
const BOX = 'box-token-for-the-test-0123456789';

// A burned note is in the reflected note tree from the moment it is made, as a tracked note is before it is burned.
const TREE = [];
function burn(vout) {
  const burned = { value: 1_000_000n, blinding: randomScalar(), owner: AUTH };
  const dest = { value: destValueFor({ burnValue: burned.value }), blinding: randomScalar(), owner: DEST_OWNER };
  const parts = bm.bridgeMintParts({ chainBinding: CB, asset: ASSET, spentTxid: TX, spentVout: vout, sourceClass: 2, burned, dest });
  TREE.push(parts.srcLeaf);
  return { parts, memos: ['0x' + 'ab'.repeat(40)] };
}
function memKv() {
  const m = new Map();
  return { get: async (k, t) => { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }), _m: m };
}
// The world: which burns the reflected record holds, the root the pool holds, and which burns have minted.
const W = { burns: [], poolRoot: null, minted: new Set() };
const state = () => {
  const acc = pool.makeUtxoAccumulator();
  for (const b of W.burns) acc.insert(b.parts.burnId, b.parts.destLeaf);
  return { snapshot: { noteLeaves: ['0x' + '01'.repeat(32), ...TREE], burnNodes: acc.nodes() }, root: acc.root() };
};
const kv = memKv();
const publish = ({ chain = true } = {}) => { const s = state(); kv._m.set('reflection:scan:mainnet', JSON.stringify({ snapshot: s.snapshot, attestedHeight: 1000 + W.burns.length, tipHeight: 1000 })); if (chain) W.poolRoot = s.root; };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  if (body && body.method === 'eth_getStorageAt') {
    const slot = body.params[1];
    if (slot === '0x50') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: W.poolRoot }), { status: 200 });
    const hit = [...W.minted].some((id) => slot === '0x' + Buffer.from(keccak_256(Buffer.from(id.slice(2) + (76).toString(16).padStart(64, '0'), 'hex'))).toString('hex'));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: hit ? '0x' + '00'.repeat(31) + '01' : '0x' + '00'.repeat(32) }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
const env = { CONFIDENTIAL_SETTLE: '1', REGISTRY_KV: kv, CONFIDENTIAL_KV: kv, CONFIDENTIAL_BOX_TOKEN: BOX, PROVE_RL_BURST: '1000', BRIDGE_REFLECTION_TTL_MS: '0', ARMED_SWEEP_GAP_MS: '0', FREE_RELAY_GAS_TTL_MS: '0' };
let ip = 0;
const call = (path, init = {}) => worker.default.fetch(new Request(`https://api.test${path}`, { ...init, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `198.51.100.${++ip % 250}`, ...(init.headers || {}) } }), env, { waitUntil() {} });
const post = async (path, body, headers) => { const r = await call(path, { method: 'POST', body: JSON.stringify(body), headers }); return { status: r.status, body: await r.json() }; };
const get = async (path, headers) => { const r = await call(path, { headers }); return { status: r.status, body: await r.json() }; };
const claim = () => get('/confidential/job', { Authorization: `Bearer ${BOX}` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a mint armed before its burn is recorded is queued by the relay\'s poll once it is, on the root the pool holds', async () => {
  const b = burn(1);
  W.burns = [burn(9)]; publish();
  const arm = await post('/confidential/arm', { type: 'bridgemint', op: b.parts.op, memos: b.memos });
  assert.equal(arm.status, 200, JSON.stringify(arm.body));
  assert.equal(arm.body.status, 'armed');
  assert.equal((await get(`/confidential/armed?dest=${b.parts.destLeaf}`)).body.status, 'armed');
  // The reflection records the burn but the pool has not taken the root: the mint waits.
  W.burns.push(b); publish({ chain: false });
  await claim(); await wait(50);
  assert.equal((await get(`/confidential/armed?dest=${b.parts.destLeaf}`)).body.status, 'armed', 'a root the pool does not hold yet is not used');
  W.poolRoot = state().root;
  await claim(); await wait(300);
  const st = (await get(`/confidential/armed?dest=${b.parts.destLeaf}`)).body;
  assert.equal(st.status, 'queued', JSON.stringify(st));
  assert.match(st.jobId, /^0x[0-9a-f]{64}$/);
  const job = await claim();
  assert.equal(job.body.jobId, st.jobId);
  assert.equal(job.body.type, 'bridgemint');
  assert.equal(admitBridgeMint({ pool, op: job.body.op, knownRoot: W.poolRoot }).ok, true, 'the job carries a mint the pool takes on its root');
  assert.deepEqual(job.body.memos, b.memos, 'with the holder\'s memos');
  W.minted.add(b.parts.burnId);
  await claim(); await wait(300);
  assert.equal((await get(`/confidential/armed?dest=${b.parts.destLeaf}`)).body.status, 'minted');
});

test('arming is refused for a mint that does not verify, and answers for a destination it does not know', async () => {
  const b = burn(2), o = burn(3);
  const bad = await post('/confidential/arm', { type: 'bridgemint', op: { ...b.parts.op, rangeProof: o.parts.op.rangeProof }, memos: b.memos });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad_proof');
  assert.equal((await post('/confidential/arm', { type: 'swap', op: b.parts.op, memos: b.memos })).status, 400);
  assert.equal((await get('/confidential/armed?dest=' + '0x' + '00'.repeat(32))).body.status, 'unknown');
});

test('a mint on a root the pool has moved past is made current at the door instead of turned back', async () => {
  const b = burn(4), later = burn(5);
  W.burns = [b]; publish();
  const mine = bm.completeBridgeMintOp(b.parts.op, state().snapshot).op;
  W.burns.push(later); publish();                                              // the pool's root moves past `mine`
  assert.equal(admitBridgeMint({ pool, op: mine, knownRoot: W.poolRoot }).code, 'stale_root');
  const r = await post('/confidential/submit', { type: 'bridgemint', op: mine, memos: b.memos });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const job = await claim();
  assert.equal(job.body.jobId, r.body.jobId);
  assert.equal(admitBridgeMint({ pool, op: job.body.op, knownRoot: W.poolRoot }).ok, true, 'it was queued on the root the pool holds');
  assert.deepEqual(job.body.op.kernel, mine.kernel, 'with the holder\'s half as it was made');
});

test('a mint the relay holds, on a root the pool has moved past, is made current when the relay asks', async () => {
  const b = burn(6), later = burn(7);
  W.burns = [b]; publish();
  const mine = bm.completeBridgeMintOp(b.parts.op, state().snapshot).op;
  const r = await post('/confidential/submit', { type: 'bridgemint', op: mine, memos: b.memos });
  assert.equal(r.status, 200);
  W.burns.push(later); publish();                                              // while it waited in the queue
  assert.equal((await post('/confidential/refresh', { jobId: r.body.jobId })).status, 404, 'only the relay may ask');
  const ref = await post('/confidential/refresh', { jobId: r.body.jobId }, { Authorization: `Bearer ${BOX}` });
  assert.equal(ref.body.ok, true, JSON.stringify(ref.body).slice(0, 200));
  assert.equal(admitBridgeMint({ pool, op: ref.body.op, knownRoot: W.poolRoot }).ok, true);
  const job = await claim();
  assert.equal(job.body.jobId, r.body.jobId);
  assert.equal(job.body.op.bitcoinBurnRoot, W.poolRoot, 'and the job keeps the renewed op');
  // A reflection that is not the pool\'s yet is not used to renew.
  const c = burn(8);
  W.burns.push(c); publish();
  const mine2 = bm.completeBridgeMintOp(c.parts.op, state().snapshot).op;
  const q = await post('/confidential/submit', { type: 'bridgemint', op: mine2, memos: c.memos });
  W.burns.push(burn(10)); publish({ chain: false });
  const stale = await post('/confidential/refresh', { jobId: q.body.jobId }, { Authorization: `Bearer ${BOX}` });
  assert.equal(stale.body.ok, false);
  assert.equal(stale.body.code, 'reflection_not_current');
  assert.equal((await post('/confidential/refresh', { jobId: '0x' + '12'.repeat(32) }, { Authorization: `Bearer ${BOX}` })).body.ok, false);
});

test.after(() => { globalThis.fetch = realFetch; });
