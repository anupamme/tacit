// Client side of the first generation of the association-set pool on Ethereum (the ETH pool): the account, its
// deposits and their approval, and withdrawals paid to any address. Everything here is byte-aligned to that pool's own
// SDK and app, so an account made here is read by them and the other way round:
//
//   key        pool key = sha256("tacit-assoc-pool-key-v1" ‖ tacit key): a plain secp256k1 EOA. It makes the deposits, so a
//              ragequit needs nothing else, and any wallet that imports it reaches the same account in the pool's own app.
//   signature  the pool app's wallet-based key generation: the key signs the EIP-712 DeriveSeed message; r is the HKDF
//              input, the key's address the salt (v2: 32 bytes, a 24-word phrase; v1: 16 bytes, 12 words).
//   phrase     BIP-39 → m/44'/60'/{0,1}'/0/0 → two scalars → Poseidon → the master nullifier and secret.
//   secrets    deposit i: Poseidon(master, scope, i); child j of a deposit: Poseidon(master, label, j).
//   discovery  deposits are found by hashing the secrets of index 0, 1, … into precommitments and matching the pool's
//              Deposited events, stopping after 10 misses in a row; each deposit's withdrawals follow its nullifiers.
//
// Pure: no network. Deps injected so the page and Node share it: { secp, keccak256, sha256, hmac, poseidon1, poseidon2,
// poseidon3 } and WebCrypto (HKDF, PBKDF2 and HMAC-SHA512 are not in the page's hash bundle).

import { BIP39_ENGLISH, BIP39_ENGLISH_SHA256 } from './bip39-english.js';

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const TREE_DEPTH = 32;
export const MISS_LIMIT = 10;
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// The ETH pool and its entrypoint. `scope` is the pool's SCOPE() (the label and context salt); `entryBlock` is the
// entrypoint's deploy block, below every event the pool has emitted.
export const ETH_POOL = {
  chainId: 1,
  pool: '0xF241d57C6DebAe225c0F2e6eA1529373C9A9C9fB',
  entrypoint: '0x6818809EefCe719E480a7526D76bD3e561526b46',
  asset: NATIVE,
  scope: 4916574638117198869413701114161172350986437430914933850166949084132905299523n,
  entryBlock: 22153713,
};

// The pool's circuit files by the sha256 its own SDK pins for them, and the host that publishes them. A page fetches
// them from there and takes only bytes with these hashes; the fork test proves with the same files.
export const CIRCUITS = {
  base: 'https://v1.privacypools.com/artifacts/',
  withdraw: {
    wasm: { file: 'withdraw.wasm', sha256: '36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10', bytes: 2607967 },
    zkey: { file: 'withdraw.zkey', sha256: '2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677', bytes: 17793015 },
    vkey: { file: 'withdraw.vkey', sha256: '666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e', bytes: 4208 },
  },
  commitment: {
    wasm: { file: 'commitment.wasm', sha256: '254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8', bytes: 2380442 },
    zkey: { file: 'commitment.zkey', sha256: '494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3', bytes: 901233 },
    vkey: { file: 'commitment.vkey', sha256: '7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8', bytes: 3477 },
  },
};

export const TOPIC = {
  deposited: '0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549', // Deposited(address,uint256 commitment,uint256 label,uint256 value,uint256 precommitment)
  withdrawn: '0x75e161b3e824b114fc1a33274bd7091918dd4e639cede50b78b15a4eea956a21', // Withdrawn(address,uint256 value,uint256 spentNullifier,uint256 newCommitment)
  ragequit: '0xd2b3e868ae101106371f2bd93abc8d5a4de488b9fe47ed122c23625aa7172f13', // Ragequit(address,uint256 commitment,uint256 label,uint256 value)
  leafInserted: '0xcb249c8292372bd11f567786635483fca9e635030baafca55ff1a8940141d221',
  rootUpdated: '0xf43641373d5bc20fddfffcd0496fd39bde41e1aa0ce326d8899b7e658261ac02', // entrypoint
  relayed: '0xe9b67844a7bb6e6ac95e8a0de02e4448dbb0c9460be9194348e4bbac6d13c2cf', // entrypoint WithdrawalRelayed
};
export const SEL = {
  deposit: '0xb6b55f25', // Entrypoint.deposit(uint256 precommitment) payable
  relay: '0x8a44121e', // Entrypoint.relay((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)
  ragequit: '0x71235b34', // pool.ragequit((uint256[2],uint256[2][2],uint256[2],uint256[4]))
  latestRoot: '0xd7b0fef1', currentRoot: '0xfdab463d', currentTreeSize: '0xa8f0f95a', scope: '0x33d09200', nonce: '0xaffed0e0', roots: '0xc2b40ae4', nullifierHashes: '0x1f79a1e9', assetConfig: '0xd6dbaf58', duplicatePrecommitment: '0xda85277b', // the entrypoint's PrecommitmentAlreadyUsed()
};

// What the pool's own app signs and hashes to make an account from a wallet. These strings are inputs to its derivation,
// so they are copied exactly.
const WIRE = { domainName: 'Privacy Pools', domainVersion: '1', action: 'Derive Account Seed', context: (v) => `privacy-pools/wallet-seed:${v}` };
const HARD = 0x80000000;

export function makeAssocPool({ secp, keccak256, sha256, hmac, poseidon1, poseidon2, poseidon3, subtle = globalThis.crypto?.subtle }) {
  if (!subtle) throw new Error('assoc-pool: WebCrypto is required');
  const te = new TextEncoder();
  const utf8 = (s) => te.encode(s);
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const unhex = (h) => { const s = String(h).replace(/^0x/, ''); if (s.length % 2) throw new Error('assoc-pool: odd hex'); return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16)); };
  const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const big = (b) => BigInt('0x' + (hex(b) || '0'));
  const be = (n, len = 32) => { const h = BigInt(n).toString(16); if (h.length > len * 2) throw new Error('assoc-pool: value too wide'); return unhex(h.padStart(len * 2, '0')); };
  const addrWord = (a) => { if (!/^0x[0-9a-fA-F]{40}$/.test(String(a))) throw new Error('assoc-pool: bad address'); return be(BigInt(a), 32); };
  const N = secp.CURVE.n;
  if (!secp.etc.hmacSha256Sync) secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
  if (hex(sha256(utf8(BIP39_ENGLISH.join(' ')))) !== BIP39_ENGLISH_SHA256) throw new Error('assoc-pool: the word list is damaged');

  // ──────────────────── key, signature, phrase ────────────────────

  // The pool key: one scalar from the Tacit key, apart from every other key made from it.
  function poolKey(tacitPriv) {
    const tp = tacitPriv instanceof Uint8Array ? tacitPriv : be(BigInt(tacitPriv), 32);
    let s = big(sha256(cat(utf8('tacit-assoc-pool-key-v1'), tp))) % N;
    if (s === 0n) s = big(sha256(cat(utf8('tacit-assoc-pool-key-v1'), tp, Uint8Array.of(1)))) % N || 1n;
    const priv = be(s, 32);
    return { priv: '0x' + hex(priv), address: addressOf(priv) };
  }
  function addressOf(priv) {
    const p = priv instanceof Uint8Array ? priv : unhex(priv);
    return '0x' + hex(keccak256(secp.getPublicKey(p, false).slice(1)).slice(12));
  }

  // EIP-712 digest of DeriveSeed(action, context, keccak256(address)) under the domain {name, version}.
  function seedDigest(address, version = 'v2') {
    const domain = keccak256(cat(keccak256(utf8('EIP712Domain(string name,string version)')), keccak256(utf8(WIRE.domainName)), keccak256(utf8(WIRE.domainVersion))));
    const struct = keccak256(cat(keccak256(utf8('DeriveSeed(string action,string context,bytes32 addressHash)')), keccak256(utf8(WIRE.action)), keccak256(utf8(WIRE.context(version))), keccak256(unhex(address))));
    return keccak256(cat(Uint8Array.of(0x19, 0x01), domain, struct));
  }
  // The 65-byte signature a wallet holding `priv` returns for that message (RFC 6979, low-s: the same bytes every time).
  function signSeed(priv, version = 'v2') {
    const p = priv instanceof Uint8Array ? priv : unhex(priv), address = addressOf(p);
    const sig = secp.sign(seedDigest(address, version), p, { lowS: true });
    return cat(be(sig.r, 32), be(sig.s, 32), Uint8Array.of(27 + sig.recovery));
  }

  async function hkdf(ikm, salt, info, len) {
    const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
  }
  function mnemonicFromEntropy(e) {
    if (![16, 20, 24, 28, 32].includes(e.length)) throw new Error('assoc-pool: entropy must be 16 to 32 bytes');
    const bits = [...e].map((b) => b.toString(2).padStart(8, '0')).join('') + [...sha256(e)].map((b) => b.toString(2).padStart(8, '0')).join('').slice(0, e.length / 4);
    const words = [];
    for (let i = 0; i + 11 <= bits.length; i += 11) words.push(BIP39_ENGLISH[parseInt(bits.slice(i, i + 11), 2)]);
    return words.join(' ');
  }
  // The phrase the pool's app derives from a wallet's signature: r is the input, the address the salt.
  async function phraseFromSignature(sig, address, version = 'v2') {
    if (sig.length !== 65) throw new Error('assoc-pool: a signature is 65 bytes');
    const entropy = await hkdf(sig.slice(0, 32), unhex(address.toLowerCase()), utf8(WIRE.context(version)), version === 'v1' ? 16 : 32);
    return mnemonicFromEntropy(entropy);
  }
  async function phraseOf(priv, version = 'v2') { return phraseFromSignature(signSeed(priv, version), addressOf(priv), version); }

  const hmac512 = async (key, data) => new Uint8Array(await subtle.sign('HMAC', await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']), data));
  async function bip39Seed(phrase) {
    const k = await subtle.importKey('raw', utf8(phrase.normalize('NFKD')), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: utf8('mnemonic'), iterations: 2048 }, k, 512));
  }
  // BIP-32 private derivation along `path` (hardened steps carry HARD).
  async function derive(seed, path) {
    let I = await hmac512(utf8('Bitcoin seed'), seed), k = big(I.slice(0, 32)), c = I.slice(32);
    if (k === 0n || k >= N) throw new Error('assoc-pool: unusable seed');
    for (const i of path) {
      I = await hmac512(c, i >= HARD ? cat(Uint8Array.of(0), be(k, 32), be(i, 4)) : cat(secp.getPublicKey(be(k, 32), true), be(i, 4)));
      const il = big(I.slice(0, 32));
      k = (il + k) % N;
      if (il >= N || k === 0n) throw new Error('assoc-pool: unusable child key');
      c = I.slice(32);
    }
    return k;
  }
  // The two master scalars: accounts 0 and 1 of the phrase's m/44'/60'/a'/0/0 keys, each hashed to a field element.
  async function masterKeys(phrase) {
    const seed = await bip39Seed(phrase);
    const k0 = await derive(seed, [HARD + 44, HARD + 60, HARD + 0, 0, 0]);
    const k1 = await derive(seed, [HARD + 44, HARD + 60, HARD + 1, 0, 0]);
    return { masterNullifier: poseidon1([k0 % FIELD]), masterSecret: poseidon1([k1 % FIELD]) };
  }

  // ──────────────────── secrets and commitments ────────────────────

  const depositSecrets = (keys, scope, index) => ({ nullifier: poseidon3([keys.masterNullifier, BigInt(scope), BigInt(index)]), secret: poseidon3([keys.masterSecret, BigInt(scope), BigInt(index)]) });
  const withdrawalSecrets = (keys, label, index) => ({ nullifier: poseidon3([keys.masterNullifier, BigInt(label), BigInt(index)]), secret: poseidon3([keys.masterSecret, BigInt(label), BigInt(index)]) });
  const precommitmentOf = (nullifier, secret) => poseidon2([nullifier, secret]);
  const commitmentOf = (value, label, precommitment) => poseidon3([BigInt(value), BigInt(label), precommitment]);
  const nullifierHashOf = (nullifier) => poseidon1([nullifier]);

  // ──────────────────── lean incremental trees ────────────────────
  // A node with no right sibling moves up unchanged. levels[0] are the leaves, the last level holds the root.

  function levelsOf(leaves) {
    const levels = [leaves.map(BigInt)];
    while (levels[levels.length - 1].length > 1) {
      const cur = levels[levels.length - 1], next = [];
      for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? poseidon2([cur[i], cur[i + 1]]) : cur[i]);
      levels.push(next);
    }
    return levels;
  }
  const rootOf = (levels) => levels[levels.length - 1][0];
  // The siblings a lean tree has (levels without one are skipped), and the index read from the sides taken at those levels,
  // top level first. The circuit takes 32 siblings: pad with zeros.
  function proofOf(levels, leafIndex) {
    if (!(leafIndex >= 0 && leafIndex < levels[0].length)) throw new Error('assoc-pool: leaf not in the tree');
    const siblings = [], sides = [];
    let i = leafIndex;
    for (let l = 0; l < levels.length - 1; l++) {
      const right = i & 1, sib = levels[l][right ? i - 1 : i + 1];
      if (sib !== undefined) { sides.push(right); siblings.push(sib); }
      i >>= 1;
    }
    return { root: rootOf(levels), index: sides.length ? parseInt(sides.reverse().join(''), 2) : 0, siblings };
  }
  const padSiblings = (s) => [...s, ...Array(TREE_DEPTH - s.length).fill(0n)];

  // ──────────────────── withdrawal data, context, calldata ────────────────────

  // The entrypoint's RelayData: recipient, fee recipient and the relay fee in basis points.
  const withdrawalData = (recipient, feeRecipient, feeBps) => '0x' + hex(cat(addrWord(recipient), addrWord(feeRecipient), be(BigInt(feeBps), 32)));
  // keccak256(abi.encode((processooor, data), scope)) mod the field: what a proof is bound to.
  function contextOf(withdrawal, scope) {
    const data = unhex(withdrawal.data);
    return big(keccak256(cat(be(0x40), be(BigInt(scope)), addrWord(withdrawal.processooor), be(0x40), be(data.length), data, new Uint8Array((32 - (data.length % 32)) % 32)))) % FIELD;
  }
  // snarkjs proof → the contract's (pA, pB, pC, pubSignals): pB's inner pairs swapped.
  const proofArgs = (proof, publicSignals) => ({
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    pB: [[BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])], [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
    pubSignals: publicSignals.map(BigInt),
  });
  const words = (xs) => cat(...xs.map((x) => be(x, 32)));
  const depositCalldata = (precommitment) => '0x' + SEL.deposit.slice(2) + hex(be(precommitment, 32));
  function relayCalldata(withdrawal, args, scope) {
    const data = unhex(withdrawal.data);
    const head = cat(be(18 * 32), words([...args.pA, ...args.pB.flat(), ...args.pC, ...args.pubSignals]), be(BigInt(scope)));
    const tail = cat(addrWord(withdrawal.processooor), be(0x40), be(data.length), data, new Uint8Array((32 - (data.length % 32)) % 32));
    return '0x' + SEL.relay.slice(2) + hex(cat(head, tail));
  }
  const ragequitCalldata = (args) => '0x' + SEL.ragequit.slice(2) + hex(words([...args.pA, ...args.pB.flat(), ...args.pC, ...args.pubSignals]));

  // ──────────────────── scanning an account ────────────────────

  // The same precommitment on several deposits (early ones reused an index) resolves to the earliest, as the pool's SDK
  // does: they share a nullifier, so at most one of them can ever be spent.
  const earlier = (a, b) => a.block - b.block || (a.logIndex ?? Infinity) - (b.logIndex ?? Infinity) || (a.tx < b.tx ? -1 : a.tx > b.tx ? 1 : 0);

  // deposits:    [{ precommitment, label, value, commitment, block, tx, depositor }]   the pool's Deposited events
  // withdrawals: [{ spentNullifier, value, newCommitment, block, tx }]                 its Withdrawn events
  // ragequits:   [{ label, commitment, value, block, tx }]
  // → one entry per deposit of this account, with the chain of its withdrawals. `last` is what a next spend consumes.
  function scan({ keys, scope, deposits, withdrawals = [], ragequits = [] }) {
    const byPre = new Map();
    for (const d of deposits) { const k = BigInt(d.precommitment), had = byPre.get(k); if (!had || earlier(d, had) < 0) byPre.set(k, d); }
    const byNf = new Map(withdrawals.map((w) => [BigInt(w.spentNullifier), w]));
    const byLabel = new Map(ragequits.map((r) => [BigInt(r.label), r]));
    const found = [];
    for (let index = 0n, misses = 0; misses < MISS_LIMIT; index++) {
      const { nullifier, secret } = depositSecrets(keys, scope, index);
      const ev = byPre.get(precommitmentOf(nullifier, secret));
      if (!ev) { misses++; continue; }
      misses = 0;
      const label = BigInt(ev.label), value = BigInt(ev.value);
      const deposit = { value, label, nullifier, secret, commitment: commitmentOf(value, label, precommitmentOf(nullifier, secret)), block: ev.block, tx: ev.tx, depositor: ev.depositor };
      if (deposit.commitment !== BigInt(ev.commitment)) throw new Error('assoc-pool: a deposit event does not match its derived commitment');
      const acct = { index, label, deposit, children: [], last: deposit, foreign: false, ragequit: byLabel.get(label) || null };
      for (let j = 0n; ; j++) {
        const w = byNf.get(nullifierHashOf(acct.last.nullifier));
        if (!w) break;
        const remaining = acct.last.value - BigInt(w.value);
        const next = withdrawalSecrets(keys, label, j);
        const commitment = commitmentOf(remaining, label, precommitmentOf(next.nullifier, next.secret));
        // A child made with other keys cannot be spent from these: the chain stops there.
        if (commitment !== BigInt(w.newCommitment)) { acct.foreign = true; break; }
        const child = { value: remaining, label, nullifier: next.nullifier, secret: next.secret, commitment, block: w.block, tx: w.tx, withdrawn: BigInt(w.value) };
        acct.children.push(child);
        acct.last = child;
      }
      found.push(acct);
    }
    return found;
  }

  // The index the next deposit takes: one past the highest this account has used. Only valid when the scan saw every
  // deposit event of the pool; an incomplete history would hand back an index already in use.
  const nextIndex = (found) => (found.length ? found.reduce((m, a) => (a.index > m ? a.index : m), 0n) + 1n : 0n);

  // ──────────────────── a withdrawal ────────────────────

  // The circuit input and the public signals it must produce for taking `amount` out of `acct.last` to `recipient`,
  // through a relayer paid `feeBps` at `feeRecipient`. stateLevels / aspLevels come from levelsOf; their roots must be the
  // pool's current root and the entrypoint's latest root (see check below). The change goes to child number
  // acct.children.length, so the account finds it again.
  function planWithdraw({ keys, acct, amount, recipient, feeRecipient, feeBps, scope = ETH_POOL.scope, entrypoint = ETH_POOL.entrypoint, stateLevels, aspLevels }) {
    const cur = acct.last, amt = BigInt(amount);
    if (acct.foreign) throw new Error('assoc-pool: this note was moved with other keys');
    if (acct.ragequit) throw new Error('assoc-pool: this deposit was exited publicly');
    if (!(amt > 0n && amt <= cur.value)) throw new Error('assoc-pool: the amount is not within the balance');
    const withdrawal = { processooor: entrypoint, data: withdrawalData(recipient, feeRecipient, feeBps) };
    const ctx = contextOf(withdrawal, scope);
    const next = withdrawalSecrets(keys, acct.label, acct.children.length);
    const si = stateLevels[0].indexOf(cur.commitment), ai = aspLevels[0].indexOf(acct.label);
    if (si < 0) throw new Error('assoc-pool: the note is not in the state tree');
    if (ai < 0) throw new Error('assoc-pool: the deposit is not approved yet');
    const sp = proofOf(stateLevels, si), ap = proofOf(aspLevels, ai);
    const newCommitment = commitmentOf(cur.value - amt, acct.label, precommitmentOf(next.nullifier, next.secret));
    const input = {
      withdrawnValue: amt, stateRoot: sp.root, stateTreeDepth: BigInt(TREE_DEPTH), ASPRoot: ap.root, ASPTreeDepth: BigInt(TREE_DEPTH), context: ctx,
      label: acct.label, existingValue: cur.value, existingNullifier: cur.nullifier, existingSecret: cur.secret, newNullifier: next.nullifier, newSecret: next.secret,
      stateSiblings: padSiblings(sp.siblings), stateIndex: BigInt(sp.index), ASPSiblings: padSiblings(ap.siblings), ASPIndex: BigInt(ap.index),
    };
    const expect = [newCommitment, nullifierHashOf(cur.nullifier), amt, sp.root, BigInt(TREE_DEPTH), ap.root, BigInt(TREE_DEPTH), ctx];
    return { withdrawal, context: ctx, input, expect, newCommitment, remaining: cur.value - amt };
  }

  // The proof's roots against the chain's: the state root must be one the pool still holds, the approval root the
  // entrypoint's latest. `chain` = { stateRoots: Set of bigint (the pool's root history), aspRoot: bigint }.
  function check(plan, chain) {
    const [, , , stateRoot, , aspRoot] = plan.expect;
    if (!chain.stateRoots.has(stateRoot)) return 'the pool moved on: read its tree again';
    if (aspRoot !== chain.aspRoot) return 'the approval list moved on: read it again';
    return null;
  }

  // The inputs a ragequit's circuit takes, and the signals it returns, for a note's current commitment.
  const ragequitInput = (acct) => ({ input: { value: acct.last.value, label: acct.label, nullifier: acct.last.nullifier, secret: acct.last.secret }, expect: [acct.last.commitment, nullifierHashOf(acct.last.nullifier), acct.last.value, acct.label] });

  return {
    poolKey, addressOf, seedDigest, signSeed, hkdf, phraseFromSignature, phraseOf, mnemonicFromEntropy, bip39Seed, derive, masterKeys,
    depositSecrets, withdrawalSecrets, precommitmentOf, commitmentOf, nullifierHashOf,
    levelsOf, rootOf, proofOf, padSiblings,
    withdrawalData, contextOf, proofArgs, depositCalldata, relayCalldata, ragequitCalldata,
    scan, nextIndex, planWithdraw, check, ragequitInput,
  };
}
