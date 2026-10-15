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
  return { build };
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
const env = { CONFIDENTIAL_SETTLE: '1', REGISTRY_KV: kv, CONFIDENTIAL_KV: kv, FREE_RELAY_CAP_ONBOARD: '12', PROVE_RL_BURST: '1000' };
let ipSeq = 0;
const submit = async (op) => {
  const res = await worker.default.fetch(new Request('https://api.test/confidential/submit', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `203.0.113.${++ipSeq}` }, body: JSON.stringify({ type: 'bridgemint', op, memos: [] }) }), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
};
const onboardUsed = () => Number(kv._m.get(`cps:budget:free:onboard:${new Date().toISOString().slice(0, 10)}`) || 0);

test('junk posted as a bridge mint is refused and uses none of the day\'s free settles', async () => {
  const m = mint();
  poolRoot = m.root;
  for (const op of [{}, { ...m.op, output: { ...m.op.output, owner: '0x' + 'dd'.repeat(32) } }, { ...m.op, spentVout: 9 }]) {
    const r = await submit(op);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'not_a_burn');
  }
  assert.equal(onboardUsed(), 0);
});

test('a mint built on an older burn set is turned back as stale, also without costing a settle', async () => {
  const m = mint();
  poolRoot = '0x' + 'ab'.repeat(32);
  const r = await submit(m.op);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'stale_root');
  assert.equal(onboardUsed(), 0);
});

test('the mint of a recorded burn is taken and spends one free settle; one burn takes a few a day, never the whole allowance', async () => {
  const b = burn(2), first = b.build();
  poolRoot = first.root;
  const r = await submit(first.op);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(onboardUsed(), 1);
  // The same burn rebuilt (a new op each time) takes its few, then is told to send it from its own account.
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await submit(b.build().op)).status);
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200], `a burn's retries are taken (${codes})`);
  assert.equal(codes[3], 429, `then it is told its free settles for the day are used (${codes})`);
  const over = await submit(b.build().op);
  assert.equal(over.body.code, 'free_budget');
  assert.equal(onboardUsed(), 4, 'and it used four of the day\'s twelve, not the day');
  // Another burn is not held back by it.
  const other = burn(3).build();
  poolRoot = other.root;
  assert.equal((await submit(other.op)).status, 200);
});

test.after(() => { globalThis.fetch = realFetch; });
