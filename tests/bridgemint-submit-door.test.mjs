// POST /confidential/submit for a bridge mint: the relay takes only the mint of a recorded burn built on the burn set the pool holds,
// and spends a free settle only on that, so junk cannot use up the day's onboarding allowance.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialBridgeMint, destValueFor, txidInternal } from '../dapp/confidential-bridge-mint.js';

const worker = await import('../worker/src/index.js');
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const bm = makeConfidentialBridgeMint({ pool, ct });
const ASSET = '0x' + 'a5'.repeat(32), CHAIN_BINDING = '0x' + '7c'.repeat(32), AUTH_KEY = '0x' + '00'.repeat(31) + 'b7';
const DEST_OWNER = pool.nkToOwner('0x' + 'c5'.repeat(32)), SPENT_TXID = txidInternal('33'.repeat(31) + '44');

// A recorded burn: `build()` makes a mint for it, a new op each time (its kernel and range proof are random), as a client does on a retry.
function burn(vout = 1) {
  const burned = { value: 1_000_000n, blinding: randomScalar(), owner: AUTH_KEY };
  const dest = { value: destValueFor({ burnValue: burned.value }), blinding: randomScalar(), owner: DEST_OWNER };
  const { cx, cy } = pool.commitXY(burned.value, burned.blinding);
  const srcLeaf = bm.sourceLeaf({ sourceClass: 2, asset: ASSET, cx, cy, owner: AUTH_KEY, spentTxid: SPENT_TXID, spentVout: vout, chainBinding: CHAIN_BINDING });
  const d = pool.commitXY(dest.value, dest.blinding);
  const destLeaf = pool.leaf(ASSET, d.cx, d.cy, DEST_OWNER);
  const burnId = pool.bridgeBurnId(1, SPENT_TXID, vout, srcLeaf, CHAIN_BINDING);
  const burns = pool.makeUtxoAccumulator();
  burns.insert(burnId, destLeaf);
  const snapshot = { noteLeaves: ['0x' + '01'.repeat(32), srcLeaf], burnNodes: burns.nodes() };
  const build = () => { const built = bm.buildBridgeMintOp({ chainBinding: CHAIN_BINDING, asset: ASSET, spentTxid: SPENT_TXID, spentVout: vout, sourceClass: 2, burned, dest, snapshot }); return { op: JSON.parse(JSON.stringify(built.op)), root: built.op.bitcoinBurnRoot }; };
  return { build, burnId };
}
const mint = (vout = 1) => burn(vout).build();

function memKv() {
  const m = new Map();
  return { get: async (k, t) => { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }), _m: m };
}

let poolRoot = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  if (body && body.method === 'eth_getStorageAt') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: poolRoot || '0x' + '00'.repeat(32) }), { status: 200 });
  return new Response('{}', { status: 404 });
};
const kv = memKv();
const BOX_TOKEN = 'box-token-for-the-test-0123456789';
const env = { CONFIDENTIAL_SETTLE: '1', REGISTRY_KV: kv, CONFIDENTIAL_KV: kv, CONFIDENTIAL_BOX_TOKEN: BOX_TOKEN, FREE_RELAY_CAP_ONBOARD: '12', PROVE_RL_BURST: '1000' };
let ipSeq = 0;
const submit = async (op) => {
  const res = await worker.default.fetch(new Request('https://api.test/confidential/submit', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `203.0.113.${++ipSeq}` }, body: JSON.stringify({ type: 'bridgemint', op, memos: [] }) }), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
};
const day = () => new Date().toISOString().slice(0, 10);
const used = (name) => Number(kv._m.get(`cps:budget:${name}:${day()}`) || 0);
const bridgeUsed = () => used('free:bridge');
// The settle relay's ack, as it fails a job.
const fail = async (jobId, error) => (await worker.default.fetch(new Request('https://api.test/confidential/ack', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${BOX_TOKEN}` }, body: JSON.stringify({ jobId, error }) }), env, { waitUntil() {} })).json();

test('junk posted as a bridge mint is refused and uses none of the day\'s free settles', async () => {
  const m = mint();
  poolRoot = m.root;
  for (const op of [{}, { ...m.op, output: { ...m.op.output, owner: '0x' + 'dd'.repeat(32) } }, { ...m.op, spentVout: 9 }]) {
    const r = await submit(op);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'not_a_burn');
  }
  assert.equal(bridgeUsed(), 0);
});

test('a mint built on an older burn set is turned back as stale, also without costing a settle', async () => {
  const m = mint();
  poolRoot = '0x' + 'ab'.repeat(32);
  const r = await submit(m.op);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'stale_root');
  assert.equal(bridgeUsed(), 0);
});

test('the mint of a recorded burn is taken and spends one free settle; one burn takes a few a day, never the whole allowance', async () => {
  const b = burn(2), first = b.build();
  poolRoot = first.root;
  const r = await submit(first.op);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(bridgeUsed(), 1);
  // The same burn rebuilt (a new op each time) takes its few, then is told to send it from its own account.
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await submit(b.build().op)).status);
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200], `a burn's retries are taken (${codes})`);
  assert.equal(codes[3], 429, `then it is told its free settles for the day are used (${codes})`);
  const over = await submit(b.build().op);
  assert.equal(over.body.code, 'free_budget');
  assert.equal(bridgeUsed(), 4, 'and it used four of the day\'s allowance, not the day');
  // Another burn is not held back by it.
  const other = burn(3).build();
  poolRoot = other.root;
  assert.equal((await submit(other.op)).status, 200);
});

// A bridge mint is the mint of a recorded burn and one burn takes a few a day, so it is bounded by real burns, not by a class allowance
// it would share with cBTC mints: more burns than that allowance are all taken, until a limit is set for them (FREE_RELAY_CAP_BRIDGE).
test('bridge mints are not held to cBTC\'s allowance, and a limit set for them applies', async () => {
  env.FREE_RELAY_CAP_ONBOARD = '2';
  try {
    const before = bridgeUsed(), codes = [];
    for (let v = 20; v < 26; v++) { const m = burn(v).build(); poolRoot = m.root; codes.push((await submit(m.op)).status); }
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 200], `six burns over an allowance of two are all taken (${codes})`);
    assert.equal(bridgeUsed(), before + 6);
    assert.equal(used('free:onboard'), 0, 'and none of it is spent from cBTC\'s allowance');
    env.FREE_RELAY_CAP_BRIDGE = String(bridgeUsed() + 1);
    const a = burn(26).build(); poolRoot = a.root;
    assert.equal((await submit(a.op)).status, 200, 'one more fits under a limit that was set');
    const b = burn(27).build(); poolRoot = b.root;
    const over = await submit(b.op);
    assert.equal(over.status, 429);
    assert.equal(over.body.code, 'free_budget');
    assert.equal(over.body.class, 'bridge');
  } finally { env.FREE_RELAY_CAP_ONBOARD = '12'; delete env.FREE_RELAY_CAP_BRIDGE; }
});

// What a free settle spent is given back when the job ends failed for a reason that was not the holder's, so a relay that fails its jobs
// does not use up the day's allowance.
const spentFor = (b) => ({ free: used('free'), bridge: bridgeUsed(), burn: used(`bridgemint:${b.burnId}`) });

test('a mint the pool moved past while it waited gives its free settle back, once', async () => {
  const b = burn(5), m = b.build(), before = spentFor(b);
  poolRoot = m.root;
  const r = await submit(m.op);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(spentFor(b), { free: before.free + 1, bridge: before.bridge + 1, burn: 1 });
  const done = await fail(r.body.jobId, 'settle reverted: Execution reverted for an unknown reason. (0x8a98f245)');
  assert.equal(done.status, 'failed');
  assert.deepEqual(spentFor(b), before, 'the day, the class and the burn have each their settle back');
  await fail(r.body.jobId, 'settle reverted: Execution reverted for an unknown reason. (0x8a98f245)');
  assert.deepEqual(spentFor(b), before, 'a second ack of the same failure gives nothing more back');
});

test('a mint refused for the holder\'s own reason keeps its settle spent', async () => {
  const b = burn(6), m = b.build();
  poolRoot = m.root;
  const r = await submit(m.op), before = spentFor(b);
  const done = await fail(r.body.jobId, 'feeGate: fee below the current floor');
  assert.equal(done.status, 'failed');
  assert.deepEqual(spentFor(b), before);
});

test('a proof the relay could not make is tried once more, and only its final failure gives the settle back', async () => {
  const b = burn(7), m = b.build(), before = spentFor(b);
  poolRoot = m.root;
  const r = await submit(m.op);
  const spent = spentFor(b);
  assert.equal(spent.bridge, before.bridge + 1);
  const first = await fail(r.body.jobId, 'prove failed: exec:bridgemint produced no proof (code=101): ENOENT');
  assert.equal(first.status, 'pending', 'the first failure of this kind is tried again');
  assert.deepEqual(spentFor(b), spent, 'and the settle stays spent while it is');
  const last = await fail(r.body.jobId, 'prove failed: exec:bridgemint produced no proof (code=101): ENOENT');
  assert.equal(last.status, 'failed');
  assert.deepEqual(spentFor(b), before, 'the second failure is final, and the settle is given back');
});

test.after(() => { globalThis.fetch = realFetch; });
