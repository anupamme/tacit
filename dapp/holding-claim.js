// A wallet's claims for the holding reward (dapp/circuits/evm-pool/holding.circom, checked by the points service in
// worker-relay/src/lib/holding-claims.js): for a day's snapshot of one chain's EVM pool, each owned note that was in the
// pool's tree and unspent at the snapshot, proven at the largest size it holds, paying the points to a claim address.
//
// The snapshot is the points service's (/holding/nullifiers/<chain>/<day>: root, spent-set root, and the leaves and
// nullifiers as of the snapshot). Every part a proof is made from is checked against it here first: the leaves rebuild the
// root, the nullifiers rebuild the spent-set root, and the note's own leaf sits at its index.
//
// The claim address is derived from the wallet's spend key, so it is recoverable from the keys alone and unlinked to any
// public address the wallet uses; the TAC it earns is collected from it (it needs gas for that, which a relayed withdrawal
// from the pool can provide without linking it).

import { secp, keccak_256, concatBytes } from './vendor/tacit-deps.min.js';
import { mulB8, P_FR } from './btc-pool-zk.js';

export const TAG_RET = 0x686f6c645f726574n;
export const TAG_SIG = 0x686f6c645f736967n;
export const SMT_LEVELS = 40;
const N_SECP = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const te = new TextEncoder();
const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const toBig = (b) => BigInt('0x' + (Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') || '0'));
const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// keccak(abi.encode("tacit-holding-claim", chainId, epoch, address)) mod p: what a claim's signature binds about its payout.
export function holdingClaimHash({ chainId, epoch, claimAddress }) {
  const a = String(claimAddress).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error('holding-claim: not an address');
  const s = te.encode('tacit-holding-claim');
  const tail = new Uint8Array(Math.ceil(s.length / 32) * 32);
  tail.set(s);
  const enc = concatBytes(be(128n, 32), be(chainId, 32), be(epoch, 32), be(BigInt(a), 32), be(s.length, 32), tail);
  return toBig(keccak_256(enc)) % P_FR;
}

// The wallet's claim address number `index`: a secp256k1 key derived from the shielded spend key.
const TAG_CLAIM = te.encode('tacit-holding-claim-key-v1');
export function holdingClaimKey(keys, index = 0) {
  const a = keys?.zkWallet?.a;
  if (typeof a !== 'bigint') throw new Error('holding-claim: wallet keys without a spend key');
  for (let i = 0; ; i++) {
    const k = toBig(keccak_256(concatBytes(TAG_CLAIM, be(a, 32), be(index, 4), be(i, 4)))) % N_SECP;
    if (k === 0n) continue;
    const priv = be(k, 32);
    const pub = secp.getPublicKey(priv, false);
    return { priv, address: hex(keccak_256(pub.subarray(1)).subarray(12)) };
  }
}

// The largest size a note of `value` can claim, or null below the smallest.
export function bucketFor(value, buckets) {
  let best = null;
  for (const b of buckets.map(BigInt)) if (BigInt(value) >= b) best = b;
  return best;
}

// The sparse tree of a set of keys (each a leaf of value 1), built once: its root and the non-membership witness of any key
// cost the hashes of the tree and of one path, not of the whole set again for each key. Its root is circomlib's SMT root, as
// the points service builds it. `hash` takes an array of field elements.
export function spentSet(keys, hash) {
  const ks = [...new Set(keys.map(BigInt))];
  const set = new Set(ks);
  // A node is null (empty, hash 0), a leaf { key, h } (a lone key: no further levels), or { l, r, h }.
  const grow = (list, level) => {
    if (list.length === 0) return null;
    if (list.length === 1) return { key: list[0], h: hash([list[0], 1n, 1n]) };
    if (level > 253) throw new Error('holding-claim: two keys agree on every bit');
    const l = [], r = [];
    for (const k of list) ((k >> BigInt(level)) & 1n ? r : l).push(k);
    const a = grow(l, level + 1), b = grow(r, level + 1);
    return { l: a, r: b, h: hash([a ? a.h : 0n, b ? b.h : 0n]) };
  };
  const top = grow(ks, 0);
  const root = top ? top.h : 0n;
  return {
    root, size: ks.length,
    // What circomlib's SMTVerifier needs to show `key` is NOT in the set: the siblings down the key's path to where it ends (an
    // empty subtree, or one holding another key), padded to `levels`. null when the key is in the set. The verifier can use
    // levels - 1 of them, so a path that needs all of them cannot be proven.
    exclusion(key, levels = SMT_LEVELS) {
      const k = BigInt(key);
      if (set.has(k)) return null;
      const siblings = [];
      let node = top, level = 0;
      while (node && !node.key) {
        const right = (k >> BigInt(level)) & 1n;
        const other = right ? node.l : node.r;
        siblings.push(other ? other.h : 0n);
        node = right ? node.r : node.l;
        level += 1;
      }
      if (siblings.length >= levels) throw new Error('holding-claim: the spent set is too deep at this note to prove');
      while (siblings.length < levels) siblings.push(0n);
      return node
        ? { smtSiblings: siblings, smtOldKey: node.key, smtOldValue: 1n, smtIsOld0: 0n }
        : { smtSiblings: siblings, smtOldKey: 0n, smtOldValue: 0n, smtIsOld0: 1n };
    },
  };
}

// The same two things for a one-off call.
export const smtRoot = (keys, hash) => spentSet(keys, hash).root;
export const smtExclusion = (keys, key, hash, levels = SMT_LEVELS) => spentSet(keys, hash).exclusion(key, levels);

// The claims a wallet can make against one snapshot: one per owned note in the tree at the snapshot, unspent then, of at
// least the smallest size, each with the circuit input that proves it.
//   zk: makeEvmPoolZk({ poseidon }). asset: the pool's ASSET_FIELD on this chain. snapshot: { root, nfRoot, size } as the
//   service states it; leaves / nullifiers: as the service lists them for it. notes: the wallet's notes ({ index, leaf, v,
//   rho, sk, nk }), including any spent since the snapshot. buckets: the sizes the service takes, in wei.
export function holdingClaims({ zk, asset, chainId, epoch, snapshot, leaves, nullifiers, notes, buckets, claimAddress }) {
  const H = zk.H;
  const L = leaves.map(BigInt), nfs = nullifiers.map(BigInt);
  if (L.length !== Number(snapshot.size)) throw new Error('holding-claim: the leaves are not the snapshot\'s');
  const T = zk.tree(L);
  if (T.root !== BigInt(snapshot.root)) throw new Error('holding-claim: the leaves do not give the snapshot\'s root');
  const spentTree = spentSet(nfs, H);
  if (spentTree.root !== BigInt(snapshot.nfRoot)) throw new Error('holding-claim: the nullifiers do not give the snapshot\'s spent-set root');
  const spent = new Set(nfs);
  const claimHash = holdingClaimHash({ chainId, epoch, claimAddress });
  const out = [];
  for (const n of notes) {
    const index = Number(n.index), v = BigInt(n.v);
    if (index >= L.length) continue;                                                     // not in the pool yet at the snapshot
    const bucketMin = bucketFor(v, buckets);
    if (bucketMin === null) continue;
    const sk = BigInt(n.sk), nk = BigInt(n.nk), rho = BigInt(n.rho);
    const ak = mulB8(sk);
    const leaf = zk.leafOf(BigInt(asset), v, zk.npkOf(ak, mulB8(nk)), rho);
    if (leaf !== L[index]) continue;                                                     // not this chain's note, or not where it says
    const nf = zk.nullifier(nk, leaf, BigInt(index));
    if (spent.has(nf)) continue;                                                         // spent by the snapshot
    const exclusion = spentTree.exclusion(nf);
    if (!exclusion) continue;
    const retNf = H([TAG_RET, nk, leaf, BigInt(epoch)]);
    const msg = H([TAG_SIG, BigInt(asset), BigInt(epoch), T.root, BigInt(snapshot.nfRoot), bucketMin, claimHash, retNf]);
    const sig = zk.sign(sk, msg);
    out.push({
      index, bucketWei: bucketMin, retNf,
      input: {
        root: T.root, nfRoot: BigInt(snapshot.nfRoot), asset: BigInt(asset), epoch: BigInt(epoch), bucketMin, claimHash, retNf,
        v, rho, nk, ak, index: BigInt(index), path: T.path(index), sigR8: sig.R8, sigS: sig.S, ...exclusion,
      },
    });
  }
  return out;
}

const str = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

// A Groth16 proof of one claim's input, and the body the points service takes for it.
export async function proveHoldingClaim({ claim, chainId, epoch, claimAddress, wasm, zkey, snarkjs }) {
  const s = snarkjs ?? (await import('./vendor/tacit-mixer.min.js')).snarkjs;
  const { proof, publicSignals } = await s.groth16.fullProve(str(claim.input), wasm, zkey);
  if (publicSignals.length !== 7) throw new Error('holding-claim: unexpected public signal count');
  return { chainId: Number(chainId), epoch: Number(epoch), claimAddress, proof, publicSignals };
}
