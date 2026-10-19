// Three things the Make private and Withdraw forms lean on:
//  - a note index reserved for a deposit that was never sent is handed back (recovery from the key stops after 24 unused indexes in a
//    row), and reading the Wrap logs ahead of time reserves nothing;
//  - a note of exactly the amount leaves by plain unwrap at its own (lower) floor, a larger note by send-and-unwrap at the higher one;
//  - a wrap's prove request carries the deposit's transaction, so a tipped deposit counts as paid work.
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
const deps = { secp, keccak256: keccak_256, sha256, network: 'mainnet' };
const RECIPIENT = '0x' + '12'.repeat(20);

// A node answering gas at 1 gwei, a head block of 0 (so no logs are read) and recording what the relay is sent.
function relayStub() {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    let obj;
    if (String(url).includes('/confidential/submit')) { seen.push(body); obj = { jobId: '0xjob' + seen.length, status: 'pending' }; }
    else obj = { jsonrpc: '2.0', id: 1, result: body && body.method === 'eth_gasPrice' ? '0x3b9aca00' : '0x0' };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
  return { seen, fetchImpl };
}

function memoryStorage() {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  return m;
}

function makeNotes(ux, walletPriv, values) {
  const built = values.map((v, index) => ux.buildWrap({ walletPriv, amountWei: (BigInt(v) * 10n ** 10n).toString(), ticker: 'cETH', index }));
  const events = built.map((w, i) => ({ type: 'LeavesInserted', firstLeafIndex: i, leaves: [w.leaf], memos: [w.memo] }));
  const recovered = ux.indexer.recover(events, walletPriv);
  const tree = new ux.pool.Tree();
  const idx = built.map((w) => tree.insert(w.leaf));
  const root = tree.root();
  return recovered.map((n, i) => ({ ...n, root, path: tree.rootAndPath(idx[i]).path, leafIndex: idx[i] }));
}

test('a wrap index handed back is the next one given, and only the newest can be handed back', async () => {
  const store = memoryStorage();
  const { fetchImpl } = relayStub();
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl });
  const walletPriv = '0x' + '71'.repeat(32);
  const a = await ux.nextWrapIndex({ walletPriv }), b = await ux.nextWrapIndex({ walletPriv });
  assert.deepEqual([a, b], [0, 1]);
  const key = [...store.keys()].find((k) => k.startsWith('tacit:next-wrap-index:'));
  assert.equal(store.get(key), '2');
  ux.releaseWrapIndex({ walletPriv, index: b });
  assert.equal(store.get(key), '1', 'the hint steps back');
  assert.equal(await ux.nextWrapIndex({ walletPriv }), 1, 'the declined deposit\'s index is used again');
  ux.releaseWrapIndex({ walletPriv, index: 0 });
  assert.equal(store.get(key), '2', 'an older reservation is not handed back: the hint is the next index to try');
  assert.equal(await ux.nextWrapIndex({ walletPriv }), 2);
  ux.releaseWrapIndex({ walletPriv, index: -1 });
  ux.releaseWrapIndex({ walletPriv, index: 1.5 });
  ux.releaseWrapIndex({ walletPriv, ticker: 'nope', index: 2 });
  delete globalThis.localStorage;
});

test('reading the Wrap logs ahead of time reserves no index', async () => {
  const store = memoryStorage();
  const { fetchImpl } = relayStub();
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl });
  const walletPriv = '0x' + '72'.repeat(32);
  await ux.warmWrapLogs();
  await ux.warmWrapLogs({ ticker: 'nope' });
  assert.equal([...store.keys()].filter((k) => k.startsWith('tacit:next-wrap-index:')).length, 0);
  assert.equal(await ux.nextWrapIndex({ walletPriv }), 0);
  delete globalThis.localStorage;
});

test('an exit of a whole note is priced by unwrap, a part of one by send-and-unwrap', async () => {
  const { seen, fetchImpl } = relayStub();
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl });
  const walletPriv = '0x' + '73'.repeat(32);
  const [n] = makeNotes(ux, walletPriv, [10_000_000]);
  const whole = await ux.quoteOpFee('cETH', 'unwrap'), part = await ux.quoteOpFee('cETH', 'sendunwrap');
  assert.ok(whole < part, `the unwrap floor (${whole}) is under send-and-unwrap's (${part})`);
  const r1 = await ux.sendUnwrap({ note: n, walletPriv, recipient: RECIPIENT, amount: 10_000_000n, wait: false });
  assert.equal(seen[0].type, 'unwrap');
  assert.equal(r1.fee, ux.quoteUnwrapFee(10_000_000n, 'cETH', { minFee: whole }).fee, 'a whole note pays the unwrap floor');
  const r2 = await ux.sendUnwrap({ note: n, walletPriv, recipient: RECIPIENT, amount: 5_000_000n, wait: false });
  assert.equal(seen[1].type, 'sendunwrap');
  assert.equal(r2.fee, ux.quoteUnwrapFee(5_000_000n, 'cETH', { minFee: part }).fee, 'a part of a note pays the send-and-unwrap floor');
});

test('a wrap proved for the paying account carries the deposit transaction, so a tipped deposit counts as paid work', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    let obj = { jsonrpc: '2.0', id: 1, result: '0x0' };
    if (String(url).includes('/confidential/submit')) { seen.push(body); obj = { jobId: 'jp', status: 'proven' }; }
    else if (String(url).includes('/confidential/status')) obj = { jobId: 'jp', mode: 'prove', status: 'proven', publicValues: '0x03', proof: '0x04', memos: seen.at(-1)?.memos };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl });
  const walletPriv = '0x' + '74'.repeat(32);
  const built = ux.buildWrap({ walletPriv, amountWei: (10n ** 16n).toString(), ticker: 'cETH', index: 0 });
  const depositTx = '0x' + 'ab'.repeat(32);
  await ux.submitWrapSettle({ built, depositTx, waitOpts: { viaRelay: true }, selfSettle: async () => ({ txHash: '0x' + 'cd'.repeat(32) }) }).catch(() => {});
  assert.equal(seen[0].mode, 'prove');
  assert.equal(seen[0].depositTx, depositTx);
  const before = seen.length;
  await ux.submitWrapSettle({ built, waitOpts: { viaRelay: true }, selfSettle: async () => ({ txHash: '0x' + 'cd'.repeat(32) }) }).catch(() => {});
  assert.equal(seen[before].depositTx, undefined, 'no deposit transaction known, none sent');
});
