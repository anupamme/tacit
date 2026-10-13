// holding-claim.js run the way the page's worker runs it: Poseidon from the page's own vendor bundles (widths 2 to 5 and 7 from
// tacit-poseidon.min.js, 8 from tacit-poseidon8.min.js), not circomlibjs. The claim's signature message hashes eight inputs, and
// the page's bundle had no such width: every claim threw in the page while every test passed against circomlibjs.
//   node holding-claim-page.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildPoseidon } from 'circomlibjs';
import { makeEvmPoolZk } from '../../evm-pool-zk.js';
import { mulB8, L_BJJ, P_FR } from '../../btc-pool-zk.js';
import { holdingClaims, spentSet } from '../../holding-claim.js';
import * as v from '../../vendor/tacit-poseidon.min.js';
import { poseidon8 } from '../../vendor/tacit-poseidon8.min.js';

const PO = { 2: v.poseidon2, 3: v.poseidon3, 4: v.poseidon4, 5: v.poseidon5, 7: v.poseidon7, 8: poseidon8 };
const pageZk = makeEvmPoolZk({ poseidon: (xs) => PO[xs.length](xs) });
const P = await buildPoseidon();
const refZk = makeEvmPoolZk({ poseidon: (xs) => P.F.toObject(P(xs.map(BigInt))) });
const rnd = (m) => { let x = 0n; while (x === 0n) x = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % m; return x; };
const ETH = 10n ** 18n, asset = 12345n, chainId = 8453, epoch = 20800;
const plain = (o) => JSON.parse(JSON.stringify(o, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));

// The page's bundle now hashes eight inputs, and agrees with circomlib on them.
{
  for (const xs of [[1, 2, 3, 4, 5, 6, 7, 8], Array.from({ length: 8 }, () => rnd(P_FR))]) assert.equal(PO[8](xs.map(BigInt)), P.F.toObject(P(xs.map(BigInt))));
  assert.equal(typeof v.poseidon8, 'undefined', 'the shared bundle every pool page loads stays as it was');
  console.log('ok - the width-8 Poseidon is its own bundle and agrees with circomlib');
}

// A snapshot of ten leaves holding two of the wallet's notes, a spent set, and the claims built with each Poseidon.
{
  const note = (val) => { const sk = rnd(L_BJJ), nk = rnd(L_BJJ), rho = rnd(P_FR); return { sk, nk, rho, v: val, leaf: refZk.leafOf(asset, val, refZk.npkOf(mulB8(sk), mulB8(nk)), rho) }; };
  const notes = Array.from({ length: 10 }, (_, i) => note(i === 3 ? 3n * ETH / 2n : i === 7 ? ETH / 5n : BigInt(i + 1) * ETH / 100n));
  const leaves = notes.map((n) => n.leaf);
  const nfs = [0, 5].map((i) => refZk.nullifier(notes[i].nk, notes[i].leaf, BigInt(i)));
  const snapshot = { root: refZk.tree(leaves).root, nfRoot: spentSet(nfs, refZk.H).root, size: leaves.length };
  const mine = [3, 7, 5].map((i) => ({ index: i, leaf: String(notes[i].leaf), v: String(notes[i].v), rho: String(notes[i].rho), sk: String(notes[i].sk), nk: String(notes[i].nk) }));
  const args = { asset, chainId, epoch, snapshot, leaves: leaves.map(String), nullifiers: nfs.map(String), notes: mine, buckets: [ETH / 100n, ETH / 10n, ETH], claimAddress: '0x' + 'ab'.repeat(20) };
  const a = holdingClaims({ zk: refZk, ...args }), b = holdingClaims({ zk: pageZk, ...args });
  assert.deepEqual(a.map((c) => c.index), [3, 7], 'the spent note and nothing else is left out');
  assert.deepEqual(b.map((c) => plain(c)), a.map((c) => plain(c)), 'the page\'s Poseidon builds exactly the inputs circomlib\'s does');
  console.log('ok - claims built with the page\'s own Poseidon bundles are the ones circomlib builds');
}

// Cost at the size of a real pool: the spent set is built once (not per note) and the whole snapshot is a few tens of seconds
// of hashing, in a worker.
{
  const N = Number(process.env.LEAVES || 16088), NF = Number(process.env.NULLIFIERS || 8000);
  const leaves = Array.from({ length: N }, () => rnd(P_FR)), nfs = Array.from({ length: NF }, () => rnd(P_FR));
  let t = Date.now();
  const tree = pageZk.tree(leaves);
  const tTree = Date.now() - t; t = Date.now();
  const set = spentSet(nfs, pageZk.H);
  const tSet = Date.now() - t; t = Date.now();
  for (let i = 0; i < 5; i++) set.exclusion(rnd(P_FR));
  const tPaths = Date.now() - t;
  console.log(`   ${N} leaves: tree ${(tTree / 1000).toFixed(1)} s; ${NF} nullifiers: spent set ${(tSet / 1000).toFixed(1)} s, then ${(tPaths / 5).toFixed(0)} ms for each note's path`);
  assert.ok(tPaths / 5 < 50, 'a note\'s path is read from the built set, not rebuilt');
  assert.ok(tree.root > 0n);
  console.log('ok - at the size of a real pool the set is hashed once and each note\'s path is read from it');
}
process.exit(0);
