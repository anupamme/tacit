// dapp/confidential-recovery.js walkBridgeMints: a transaction with more nullifiers than one pass takes is passed over, not a stop, and is
// searched alone when nothing else is left, so the walk always reaches every transaction.
//   node --test tests/bridge-mint-walk.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialRecovery } from '../dapp/confidential-recovery.js';
import { bppGens, G as BPP_G } from '../dapp/bulletproofs-plus.js';

const cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const R = makeConfidentialRecovery({ pool, memo: {}, keccak256: keccak_256, secp, hmac, sha256: nobleSha256, curveOrder: secp.CURVE.n, lockScan: {}, airdrop: {}, cdp: {}, bpp: { H: bppGens().H, G: BPP_G } });

const PRIV = '0x' + '7a'.repeat(32), ASSET = '0x' + 'a5'.repeat(32);
const priv = Uint8Array.from(Buffer.from('7a'.repeat(32), 'hex'));
const nul = (i) => '0x' + i.toString(16).padStart(64, '0');
// The leaf a bridge mint of `value` would insert for this key against burn nullifier `n`.
function mintLeaf(n, value) {
  const b = R.deriveBridgeMintBlinding(priv, n);
  const { cx, cy } = pool.commitXY(BigInt(value), b);
  const dn = pool.deriveNote(priv, ASSET, 0);
  return pool.leaf(ASSET, cx, cy, pool.nkToOwner(dn.secret));
}
const opts = { priv: PRIV, assets: [{ assetId: ASSET }], destIndexes: 1, maxExp: 3 };

test('a transaction over the cap in front of a smaller one does not stop the walk', async () => {
  const mine = mintLeaf(nul(1), 1000);
  const tx = { nullifiersOfTx: new Map([['0xold', [nul(1)]], ['0xbig', Array.from({ length: 20 }, (_, i) => nul(100 + i))]]) };
  const unexplained = new Map([['0xold', [mine]], ['0xbig', ['0x' + 'ee'.repeat(32)]]]);
  const r = await R.walkBridgeMints({ ...opts, tx, unexplained, maxNullifiers: 16 });
  assert.ok(r.searched.has('0xold') && !r.searched.has('0xbig'), 'the older, smaller transaction is searched; the large one waits');
  assert.strictEqual(r.found.length, 1);
  assert.strictEqual(r.found[0].value, 1000n);
});

test('a large transaction left alone is searched whole', async () => {
  const mine = mintLeaf(nul(105), 50);
  const tx = { nullifiersOfTx: new Map([['0xbig', Array.from({ length: 20 }, (_, i) => nul(100 + i))]]) };
  const unexplained = new Map([['0xbig', [mine]]]);
  const r = await R.walkBridgeMints({ ...opts, tx, unexplained, maxNullifiers: 16 });
  assert.ok(r.searched.has('0xbig'));
  assert.strictEqual(r.found.length, 1);
  assert.strictEqual(r.found[0].burnNullifier, nul(105));
});
