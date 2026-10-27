// The quick first read of a key's balance (confidential-pool-ux.js `recent`): with nothing kept for the key on a device, only the newest leaves are
// opened with it, so a note it has just been paid is found in a moment and the older ones wait for the full read behind it; the quick read keeps
// no checkpoint (so the full read still opens every older leaf), and with a checkpoint the option changes nothing. Run on a chain of 160 leaves
// whose memos are sealed to other keys, with one note sealed to the key near the start and one at the end.
//   node --test tests/scan-quick.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
const encodeLeavesInserted = (leaves, memos) => {
  const lv = [w32(leaves.length), ...leaves.map((l) => String(l).replace(/^0x/, '').padStart(64, '0'))].join('');
  const bodies = memos.map((m) => { const h = String(m).replace(/^0x/, ''); const len = h.length / 2; return w32(len) + h.padEnd(Math.ceil(len / 32) * 64, '0'); });
  let off = 32 * memos.length; const heads = [];
  for (const b of bodies) { heads.push(w32(off)); off += b.length / 2; }
  return '0x' + w32(64) + w32(64 + lv.length / 2) + lv + (w32(memos.length) + heads.join('') + bodies.join(''));
};
const TOPIC = '0x' + Buffer.from(keccak_256(new TextEncoder().encode('LeavesInserted(uint256,bytes32[],bytes[])'))).toString('hex');

const store = new Map();
const prior = globalThis.localStorage;
globalThis.localStorage = {
  get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
};

// the chain: one LeavesInserted event of 160 leaves, memos sealed to other keys except two to the key under test
const N = 160, OLD = 7, NEW = N - 3;
let ux, mine, leavesHex, memosHex;
const build = () => {
  const deps = { secp, keccak256: keccak_256, sha256, network: 'mainnet', logStore: null };
  const boot = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => { throw new Error('no network'); } });
  const priv = '0x' + '5a'.repeat(32);
  const id = boot.identity(priv);
  const asset = boot.assetByTicker.cETH.assetId;
  const note = (value, seed) => {
    const blinding = BigInt('0x' + sha256(new TextEncoder().encode('b' + seed)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')) % secp.CURVE.n;
    const nk = '0x' + w32(BigInt('0x' + sha256(new TextEncoder().encode('n' + seed)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')) % secp.CURVE.n);
    const owner = boot.pool.nkToOwner(nk), { cx, cy } = boot.pool.commitXY(value, '0x' + w32(blinding));
    return { value, blinding: '0x' + w32(blinding), secret: nk, asset, owner, cx, cy };
  };
  const leaves = [], memos = [];
  let e = 1n;
  const rand = () => (e = (e * 6364136223846793005n + 1442695040888963407n) % secp.CURVE.n) || 1n;
  for (let i = 0; i < N; i++) {
    const n = note(1000 + i, i);
    const stranger = secp.ProjectivePoint.BASE.multiply(BigInt(i + 2)).toHex(true);
    const to = i === OLD || i === NEW ? id.pubHex : '0x' + stranger;
    leaves.push(boot.pool.leaf(asset, n.cx, n.cy, n.owner));
    memos.push(boot.memo.encodeMemo(boot.memo.sealMemo(to, n, rand)));
  }
  mine = { priv, pub: id.pubHex };
  leavesHex = leaves; memosHex = memos;
  const log = { address: boot.cfg.pool, topics: [TOPIC, '0x' + w32(0)], data: encodeLeavesInserted(leaves, memos), blockNumber: '0x' + (boot.cfg.deployBlock + 1).toString(16), transactionHash: '0x' + 'cd'.repeat(32), logIndex: '0x0' };
  ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const obj = body && body.method === 'eth_blockNumber' ? { result: '0x' + (boot.cfg.deployBlock + 200).toString(16) }
      : body && body.method === 'eth_getLogs' ? { result: [log] } : { result: '0x0' };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  } });
};

test('a quick first read finds the newest note only, keeps no checkpoint, and says it is still reading', async () => {
  build();
  const t = Date.now();
  const r = await ux.balance(mine.priv, { cbtc: false, bridge: false, recent: 20 });
  const found = r.notes.map((n) => Number(n.leafIndex)).sort((a, b) => a - b);
  assert.deepEqual(found, [NEW], `only the newest leaves are opened (took ${Date.now() - t} ms)`);
  assert.equal(r.reading, true, 'the result says it is a quick read');
  assert.ok(![...store.keys()].some((k) => k.startsWith('tacit-memo-ck-v1:')), 'a quick read keeps no checkpoint');
});

test('the full read after it finds both and keeps the checkpoint', async () => {
  const r = await ux.balance(mine.priv, { cbtc: false, bridge: false });
  assert.deepEqual(r.notes.map((n) => Number(n.leafIndex)).sort((a, b) => a - b), [OLD, NEW], 'every leaf is opened');
  assert.equal(r.reading, false);
  assert.ok([...store.keys()].some((k) => k.startsWith('tacit-memo-ck-v1:')), 'the full read keeps its checkpoint');
});

test('with a checkpoint, `recent` changes nothing', async () => {
  const r = await ux.balance(mine.priv, { cbtc: false, bridge: false, recent: 20 });
  assert.deepEqual(r.notes.map((n) => Number(n.leafIndex)).sort((a, b) => a - b), [OLD, NEW], 'the older note stays in the balance');
  assert.equal(r.reading, false, 'it is not a quick read');
});

test('a fresh device after the quick read still finds the older note in the full read', async () => {
  store.clear();
  build();
  await ux.balance(mine.priv, { cbtc: false, bridge: false, recent: 20 });
  const r = await ux.balance(mine.priv, { cbtc: false, bridge: false });
  assert.deepEqual(r.notes.map((n) => Number(n.leafIndex)).sort((a, b) => a - b), [OLD, NEW], 'nothing was marked covered by the quick read');
  globalThis.localStorage = prior;
});
