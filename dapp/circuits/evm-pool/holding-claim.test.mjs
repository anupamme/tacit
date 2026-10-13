// The wallet side of the holding reward (dapp/holding-claim.js): the spent-set exclusion witness is circomlib's, the claim
// binding is the points service's, and a wallet's notes become claims whose real proofs the service accepts: only for notes
// in the tree and unspent at the snapshot, at the largest size each holds. Needs the circuit built as holding.test.mjs says.
//   node holding-claim.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildPoseidon, newMemEmptyTrie } from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import { mulB8, L_BJJ, P_FR } from '../../btc-pool-zk.js';
import { makeEvmPoolZk } from '../../evm-pool-zk.js';
import { holdingClaimHash, holdingClaimKey, smtRoot, smtExclusion, holdingClaims, proveHoldingClaim, bucketFor } from '../../holding-claim.js';
import { runHolding } from '../../holding-run.js';
import { claimHashOf, DEFAULT_BUCKETS_WEI } from '../../../worker-relay/src/lib/holding-epoch.js';
import { verifyHoldingClaim } from '../../../worker-relay/src/lib/holding-claims.js';

const WASM = process.env.WASM || 'build/holding_js/holding.wasm', ZKEY = process.env.ZKEY || 'build/holding_dev.zkey';
const P = await buildPoseidon();
const poseidon = (xs) => P.F.toObject(P(xs.map(BigInt)));
const zk = makeEvmPoolZk({ poseidon });
const H = zk.H;
const rnd = (m) => { let x = 0n; while (x === 0n) x = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % m; return x; };
const ETH = 10n ** 18n;

// The exclusion witness, against circomlibjs's own trie.
{
  const sets = [[], [rnd(P_FR)], [rnd(P_FR), rnd(P_FR)], Array.from({ length: 50 }, () => rnd(P_FR)), Array.from({ length: 300 }, () => rnd(P_FR))];
  const near = rnd(P_FR) & ~0xffn;
  sets.push([near, near | 1n, near | 4n, near | 0x80n]);                                 // keys that share long prefixes
  let checked = 0;
  for (const keys of sets) {
    const trie = await newMemEmptyTrie();
    for (const k of keys) await trie.insert(k, 1n);
    const F = (x) => trie.F.toObject(x);
    assert.equal(smtRoot(keys, H), F(trie.root), 'the spent-set root is circomlib\'s');
    const probes = [rnd(P_FR), rnd(P_FR), near | 2n, near | 0x81n, ...keys.slice(0, 3)];
    for (const key of probes) {
      const mine = smtExclusion(keys, key, H);
      const r = await trie.find(key);
      if (r.found) { assert.equal(mine, null, 'a key in the set has no exclusion'); continue; }
      const sib = r.siblings.map(F);
      while (sib.length < 40) sib.push(0n);
      assert.deepEqual(mine.smtSiblings, sib);
      assert.equal(mine.smtIsOld0, r.isOld0 ? 1n : 0n);
      assert.equal(mine.smtOldKey, r.isOld0 ? 0n : F(r.notFoundKey));
      assert.equal(mine.smtOldValue, r.isOld0 ? 0n : F(r.notFoundValue));
      checked += 1;
    }
  }
  console.log(`ok - the exclusion witness matches circomlib's for ${checked} keys over sets of 0 to 300, shared prefixes included`);
}

// The claim binding and the claim address.
{
  const a = '0x' + 'ab'.repeat(20);
  for (const [chainId, epoch] of [[1, 20800], [8453, 20801], [4663, 1]]) assert.equal(holdingClaimHash({ chainId, epoch, claimAddress: a }), claimHashOf({ chainId, epoch, claimAddress: a }));
  assert.equal(holdingClaimHash({ chainId: 1, epoch: 5, claimAddress: a.toUpperCase().replace('0X', '0x') }), claimHashOf({ chainId: 1, epoch: 5, claimAddress: a }));
  const keys = { zkWallet: { a: rnd(L_BJJ) } };
  const k0 = holdingClaimKey(keys), k0b = holdingClaimKey(keys), k1 = holdingClaimKey(keys, 1);
  assert.match(k0.address, /^0x[0-9a-f]{40}$/);
  assert.equal(k0.address, k0b.address, 'the same keys give the same claim address');
  assert.notEqual(k0.address, k1.address);
  assert.notEqual(k0.address, holdingClaimKey({ zkWallet: { a: rnd(L_BJJ) } }).address);
  assert.throws(() => holdingClaimKey({ v: 1n }), /spend key/, 'a view-only key cannot make one');
  assert.equal(bucketFor(ETH * 3n / 2n, DEFAULT_BUCKETS_WEI), ETH);
  console.log('ok - the claim binding is the service\'s, and the claim address comes from the spend key alone');
}

// A wallet's notes, a snapshot, claims, a real proof and the service's check.
{
  const asset = 777n, chainId = 8453, epoch = 20800;
  const note = (v) => { const sk = rnd(L_BJJ), nk = rnd(L_BJJ), rho = rnd(P_FR); return { sk, nk, rho, v, leaf: zk.leafOf(asset, v, zk.npkOf(mulB8(sk), mulB8(nk)), rho) }; };
  // Ten notes; the wallet owns 1 (1.5 ETH), 4 (0.004 ETH: below every size), 6 (spent by the snapshot) and 9 (0.35 ETH, inserted
  // after the snapshot). Others' notes fill the rest.
  const values = [ETH, ETH * 3n / 2n, ETH / 2n, ETH, ETH * 4n / 1000n, ETH, ETH * 2n, ETH, ETH, ETH * 35n / 100n];
  const notes = values.map(note);
  const leavesAll = notes.map((n) => n.leaf);
  const size = 8, snapLeaves = leavesAll.slice(0, size);
  const nfOf = (i) => zk.nullifier(notes[i].nk, notes[i].leaf, BigInt(i));
  const spentIdx = [0, 6];
  const nullifiers = spentIdx.map(nfOf);
  const snapshot = { root: zk.tree(snapLeaves).root, nfRoot: smtRoot(nullifiers, H), size };
  const mine = [1, 4, 6, 9].map((i) => ({ index: i, leaf: String(notes[i].leaf), v: String(notes[i].v), rho: String(notes[i].rho), sk: String(notes[i].sk), nk: String(notes[i].nk) }));
  const claimAddress = holdingClaimKey({ zkWallet: { a: rnd(L_BJJ) } }).address;
  const args = { zk, asset, chainId, epoch, snapshot, leaves: snapLeaves.map(String), nullifiers: nullifiers.map(String), notes: mine, buckets: DEFAULT_BUCKETS_WEI, claimAddress };
  const claims = holdingClaims(args);
  assert.deepEqual(claims.map((c) => [c.index, c.bucketWei]), [[1, ETH]], 'only the unspent note in the tree, above the smallest size, at the largest size it holds');

  assert.throws(() => holdingClaims({ ...args, leaves: [...args.leaves.slice(0, 7), '5'] }), /root/, 'leaves that do not give the root are refused');
  assert.throws(() => holdingClaims({ ...args, leaves: args.leaves.slice(0, 7) }), /snapshot/);
  assert.throws(() => holdingClaims({ ...args, nullifiers: [String(nullifiers[0])] }), /spent-set root/, 'a spent set that is not the snapshot\'s is refused');
  assert.equal(holdingClaims({ ...args, asset: 778n }).length, 0, 'notes of another chain\'s pool are not claimed');

  const body = await proveHoldingClaim({ claim: claims[0], chainId, epoch, claimAddress, wasm: WASM, zkey: ZKEY, snarkjs });
  const vkey = JSON.parse(fs.readFileSync(process.env.VK || 'build/vk.json', 'utf8'));
  const v = await verifyHoldingClaim({ claim: body, snapshot, buckets: DEFAULT_BUCKETS_WEI, poolAsset: asset, vkey, groth16: snarkjs.groth16 });
  assert.equal(v.ok, true, String(v.reason));
  assert.deepEqual([v.bucketWei, v.retNf], [ETH, claims[0].retNf], 'the service credits the size and tag the wallet proved');
  const elsewhere = await verifyHoldingClaim({ claim: { ...body, claimAddress: '0x' + 'cd'.repeat(20) }, snapshot, buckets: DEFAULT_BUCKETS_WEI, poolAsset: asset, vkey, groth16: snarkjs.groth16 });
  assert.equal(elsewhere.ok, false, 'a proof cannot be redirected to another address');
  console.log('ok - a wallet\'s notes become the claims it is owed, and the service accepts their real proof');

  // The daily round against a stand-in service that checks claims as the real one does: it proves and sends what is owed,
  // once, and does nothing while the reward is off.
  const keys = { zkWallet: { a: rnd(L_BJJ) } };
  const credited = new Map(), posts = [];
  let enabled = false;
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fakeFetch = async (url, init) => {
    const path = url.replace('https://points.test', '');
    if (path === '/holding') return json(200, enabled
      ? { enabled: true, buckets: DEFAULT_BUCKETS_WEI.map(String), assets: { [chainId]: String(asset) }, epochs: [{ epoch, chains: [{ chainId, leaves: size, root: String(snapshot.root), nfRoot: String(snapshot.nfRoot) }] }] }
      : { enabled: false });
    if (path === `/holding/nullifiers/${chainId}/${epoch}`) return json(200, { ...snapshot, root: String(snapshot.root), nfRoot: String(snapshot.nfRoot), leaves: snapLeaves.map(String), nullifiers: nullifiers.map(String) });
    if (path === '/holding/claim') {
      const c = JSON.parse(init.body);
      posts.push(c);
      const v = await verifyHoldingClaim({ claim: c, snapshot, buckets: DEFAULT_BUCKETS_WEI, poolAsset: asset, vkey, groth16: snarkjs.groth16 });
      if (!v.ok) return json(422, { error: v.reason });
      const fresh = !credited.has(String(v.retNf));
      credited.set(String(v.retNf), c.claimAddress);
      return json(200, { credited: fresh, bucketWei: String(v.bucketWei) });
    }
    return json(404, {});
  };
  const store = new Map(), kv = { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) };
  const prove = async (input) => snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const round = () => runHolding({ api: 'https://points.test', wallets: { [chainId]: { notes: () => mine } }, keys, zk, prove, kv, fetchImpl: fakeFetch });
  assert.deepEqual(await round(), { enabled: false, sent: [] }, 'off: nothing is read beyond the status, nothing is sent');
  enabled = true;
  const r1 = await round();
  assert.deepEqual(r1.sent.map((x) => [x.status, x.credited, x.bucketWei]), [[200, true, String(ETH)]], JSON.stringify(r1.sent));
  assert.equal(r1.claimAddress, holdingClaimKey(keys).address);
  assert.deepEqual([...credited.values()], [holdingClaimKey(keys).address], 'paid to the key\'s own claim address');
  const r2 = await round();
  assert.equal(r2.sent.length, 0, 'a day already done is not proven again');
  assert.equal(posts.length, 1);
  const empty = await runHolding({ api: 'https://points.test', wallets: { [chainId]: { notes: () => [] } }, keys: { zkWallet: { a: rnd(L_BJJ) } }, zk, prove, kv: { get: () => null, set() {} }, fetchImpl: fakeFetch });
  assert.equal(empty.sent.length, 0, 'a wallet with no note in the snapshot sends nothing');
  console.log('ok - the daily round proves and sends what a key is owed once, to its own claim address, and nothing while the reward is off');
}
process.exit(0);
