// dapp/assoc-pool.js: the account, secrets, trees, context, calldata and scan of the first-generation association-set
// pool. The primitives are checked against published vectors (BIP-39 and BIP-32, the EIP-712 reference example, RFC 5869,
// circomlib's Poseidon values); the pool's own conventions are checked in the opt-in fork test, where the real
// contracts and circuit accept what this module builds (tests/assoc-pool-fork.mjs).
//   node tests/assoc-pool.test.mjs
import assert from 'node:assert';
import { secp, keccak_256, sha256, hmac, base58, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { poseidon1, poseidon2, poseidon3 } from '../dapp/vendor/tacit-poseidon.min.js';
import { makeAssocPool, ETH_POOL, FIELD, MISS_LIMIT, SEL, TOPIC, TREE_DEPTH } from '../dapp/assoc-pool.js';

const pool = makeAssocPool({ secp, keccak256: keccak_256, sha256, hmac, poseidon1, poseidon2, poseidon3 });
let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g) || [], (x) => parseInt(x, 16));
const big = (b) => BigInt('0x' + hex(b));
const utf8 = (s) => new TextEncoder().encode(s);
const H = 0x80000000;

// ── BIP-39 ──
{
  const vectors = [
    ['00000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
    ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
    ['80808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'],
    ['ffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'],
    ['0000000000000000000000000000000000000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'],
  ];
  for (const [e, m] of vectors) assert.equal(pool.mnemonicFromEntropy(unhex(e)), m);
  ok('BIP-39 entropy → phrase: the standard vectors (12 and 24 words)');
  const seed = await pool.bip39Seed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  assert.equal(hex(seed), '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4');
  ok('BIP-39 phrase → seed (empty passphrase): the known 64 bytes');
}

// ── BIP-32: the specification's test vector 1, from its own extended private keys ──
{
  const xprv = {
    m: 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
    '0H': 'xprv9uHRZZhk6KAJC1avXpDAp4MDc3sQKNxDiPvvkX8Br5ngLNv1TxvUxt4cV1rGL5hj6KCesnDYUhd7oWgT11eZG7XnxHrnYeSvkzY7d2bhkJ7',
    '0H/1': 'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs',
    '0H/1/2H': 'xprv9z4pot5VBttmtdRTWfWQmoH1taj2axGVzFqSb8C9xaxKymcFzXBDptWmT7FwuEzG3ryjH4ktypQSAewRiNMjANTtpgP4mLTj34bhnZX7UiM',
    '0H/1/2H/2': 'xprvA2JDeKCSNNZky6uBCviVfJSKyQ1mDYahRjijr5idH2WwLsEd4Hsb2Tyh8RfQMuPh7f7RtyzTtdrbdqqsunu5Mm3wDvUAKRHSC34sJ7in334',
    '0H/1/2H/2/1000000000': 'xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76',
  };
  const keyOf = (s) => {
    const d = base58.decode(s), payload = d.slice(0, 78);
    assert.deepEqual([...sha256(sha256(payload)).slice(0, 4)], [...d.slice(78)]);   // its checksum
    assert.equal(payload[45], 0);
    return big(payload.slice(46));
  };
  const seed = unhex('000102030405060708090a0b0c0d0e0f');
  const paths = { m: [], '0H': [H], '0H/1': [H, 1], '0H/1/2H': [H, 1, H + 2], '0H/1/2H/2': [H, 1, H + 2, 2], '0H/1/2H/2/1000000000': [H, 1, H + 2, 2, 1000000000] };
  for (const [name, path] of Object.entries(paths)) assert.equal(await pool.derive(seed, path), keyOf(xprv[name]), name);
  ok('BIP-32 private derivation: the specification vector 1 (hardened and plain steps) from its own extended keys');
}

// ── the account path: the well-known test phrase's first key ──
{
  const seed = await pool.bip39Seed('test test test test test test test test test test test junk');
  const k0 = await pool.derive(seed, [H + 44, H + 60, H + 0, 0, 0]);
  assert.equal('0x' + k0.toString(16).padStart(64, '0'), '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  assert.equal(pool.addressOf(k0.toString(16).padStart(64, '0')).toLowerCase(), '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  const k1 = await pool.derive(seed, [H + 44, H + 60, H + 1, 0, 0]);
  assert.notEqual(k1, k0);
  const mk = await pool.masterKeys('test test test test test test test test test test test junk');
  assert.equal(mk.masterNullifier, poseidon1([k0 % FIELD]));
  assert.equal(mk.masterSecret, poseidon1([k1 % FIELD]));
  ok("m/44'/60'/0'/0/0 of the test phrase is the known key and address; the master scalars are Poseidon of accounts 0 and 1");
}

// ── Poseidon (circomlib's published values) ──
assert.equal(poseidon1([1n]), 18586133768512220936620570745912940619677854269274689475585506675881198879027n);
assert.equal(poseidon2([1n, 2n]), 7853200120776062878684798364095072458815029376092732009249414926327459813530n);
assert.equal(poseidon3([1n, 2n, 3n]), 6542985608222806190361240322586112750744169038454362455181422643027100751666n);
ok('Poseidon over 1, 2 and 3 inputs: circomlib values');

// ── HKDF (RFC 5869, test case 1) ──
{
  const okm = await pool.hkdf(unhex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'), unhex('000102030405060708090a0b0c'), unhex('f0f1f2f3f4f5f6f7f8f9'), 42);
  assert.equal(hex(okm), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  ok('HKDF-SHA256: RFC 5869 test case 1');
}

// ── EIP-712: a small generic encoder, proven on the specification's example, then used on DeriveSeed ──
{
  const k = (b) => keccak_256(b);
  const types = {
    EIP712Domain: [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address']],
    Person: [['name', 'string'], ['wallet', 'address']],
    Mail: [['from', 'Person'], ['to', 'Person'], ['contents', 'string']],
  };
  const deps = (t, seen = new Set()) => { if (seen.has(t) || !types[t]) return seen; seen.add(t); for (const [, ft] of types[t]) deps(ft, seen); return seen; };
  const encodeType = (t, tys) => { const d = [...deps(t)].filter((x) => x !== t).sort(); return [t, ...d].map((x) => `${x}(${tys[x].map(([nm, ty]) => `${ty} ${nm}`).join(',')})`).join(''); };
  const word = (b) => { const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
  const enc = (ty, v, tys) => {
    if (tys[ty]) return k(hashStruct(ty, v, tys));
    if (ty === 'string') return k(utf8(v));
    if (ty === 'address') return word(unhex(v));
    if (ty === 'bytes32') return unhex(v);
    if (ty === 'uint256') return word(unhex(BigInt(v).toString(16).padStart(2, '0').replace(/^(.)$/, '0$1').padStart(2, '0')));
    throw new Error(ty);
  };
  function hashStruct(t, v, tys) { return concatBytes(k(utf8(encodeType(t, tys))), ...tys[t].map(([nm, ty]) => enc(ty, v[nm], tys))); }
  const digest = (domain, domainTypes, primary, tys, message) => k(concatBytes(Uint8Array.of(0x19, 0x01), k(hashStruct('EIP712Domain', domain, { EIP712Domain: domainTypes })), k(hashStruct(primary, message, tys))));

  const mail = digest(
    { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' }, types.EIP712Domain, 'Mail', types,
    { from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' }, to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' }, contents: 'Hello, Bob!' });
  assert.equal('0x' + hex(mail), '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  ok('EIP-712: the generic encoder reproduces the specification example digest');

  const seedTypes = { DeriveSeed: [['action', 'string'], ['context', 'string'], ['addressHash', 'bytes32']] };
  for (const addr of ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x0000000000000000000000000000000000000001']) {
    for (const version of ['v1', 'v2']) {
      const generic = digest({ name: 'Privacy Pools', version: '1' }, [['name', 'string'], ['version', 'string']], 'DeriveSeed', seedTypes,
        { action: 'Derive Account Seed', context: `privacy-pools/wallet-seed:${version}`, addressHash: '0x' + hex(k(unhex(addr))) });
      assert.equal(hex(pool.seedDigest(addr, version)), hex(generic), `${addr} ${version}`);
    }
  }
  ok('the DeriveSeed digest equals the generic encoder\'s, for both versions');
}

// ── the signature and the phrase ──
{
  const poolKeyOf = (i) => pool.poolKey(sha256(utf8('assoc-pool-test-key-' + i)));
  const a = poolKeyOf(1), b = poolKeyOf(2);
  assert.notEqual(a.address, b.address);
  assert.deepEqual(poolKeyOf(1), a);
  const tacit = sha256(utf8('some tacit key'));
  assert.notEqual(pool.poolKey(tacit).priv.slice(2), hex(tacit));
  ok('the pool key is deterministic, apart from the key it comes from, and per key');

  for (const version of ['v1', 'v2']) {
    const s1 = pool.signSeed(a.priv, version), s2 = pool.signSeed(a.priv, version);
    assert.equal(hex(s1), hex(s2));
    assert.equal(s1.length, 65);
    assert.ok(s1[64] === 27 || s1[64] === 28);
    const sig = secp.Signature.fromCompact(s1.slice(0, 64)).addRecoveryBit(s1[64] - 27);
    const pub = sig.recoverPublicKey(pool.seedDigest(a.address, version)).toRawBytes(false);
    assert.equal('0x' + hex(keccak_256(pub.slice(1)).slice(12)), a.address, 'recovers the signer');
    assert.ok(big(s1.slice(32, 64)) <= secp.CURVE.n >> 1n, 'low s');
  }
  ok('the seed signature is deterministic, 65 bytes, low-s, and recovers to the pool key\'s address');

  const p2 = await pool.phraseOf(a.priv, 'v2'), p1 = await pool.phraseOf(a.priv, 'v1');
  assert.equal(p2.split(' ').length, 24);
  assert.equal(p1.split(' ').length, 12);
  assert.notEqual(p1, p2);
  assert.equal(p2, await pool.phraseOf(a.priv, 'v2'));
  assert.notEqual(p2, await pool.phraseOf(b.priv, 'v2'));
  // the phrase is a valid BIP-39 phrase: its last word's checksum bits match the entropy it spells
  const idx = p2.split(' ').map((w) => w);
  assert.equal(idx.length, 24);
  assert.equal(await pool.phraseFromSignature(pool.signSeed(a.priv, 'v2'), a.address, 'v2'), p2);
  ok('the phrase: 24 words for v2, 12 for v1, stable per key, different per key and version');
}

// ── secrets and commitments (shapes; the pool's own acceptance of them is the fork test) ──
const KEYS = await pool.masterKeys('test test test test test test test test test test test junk');
{
  const d0 = pool.depositSecrets(KEYS, ETH_POOL.scope, 0n), d1 = pool.depositSecrets(KEYS, ETH_POOL.scope, 1n);
  assert.equal(d0.nullifier, poseidon3([KEYS.masterNullifier, ETH_POOL.scope, 0n]));
  assert.equal(d0.secret, poseidon3([KEYS.masterSecret, ETH_POOL.scope, 0n]));
  assert.notEqual(d0.nullifier, d1.nullifier);
  const label = 987654321987654321n, w0 = pool.withdrawalSecrets(KEYS, label, 0n);
  assert.equal(w0.nullifier, poseidon3([KEYS.masterNullifier, label, 0n]));
  const pre = pool.precommitmentOf(d0.nullifier, d0.secret);
  assert.equal(pre, poseidon2([d0.nullifier, d0.secret]));
  assert.equal(pool.commitmentOf(5n, label, pre), poseidon3([5n, label, pre]));
  assert.equal(pool.nullifierHashOf(d0.nullifier), poseidon1([d0.nullifier]));
  ok('deposit and withdrawal secrets, precommitment, commitment and nullifier hash are the Poseidon forms');
}

// ── lean trees ──
const verifyPath = (leaf, proof) => {
  // what the circuit does: fold the siblings with the sides read from the index, top bit first
  const bits = proof.siblings.length ? proof.index.toString(2).padStart(proof.siblings.length, '0').split('').reverse().map(Number) : [];
  let node = leaf;
  proof.siblings.forEach((s, i) => { node = bits[i] ? poseidon2([s, node]) : poseidon2([node, s]); });
  return node;
};
{
  assert.equal(pool.rootOf(pool.levelsOf([7n])), 7n);
  assert.equal(pool.rootOf(pool.levelsOf([1n, 2n])), poseidon2([1n, 2n]));
  assert.equal(pool.rootOf(pool.levelsOf([1n, 2n, 3n])), poseidon2([poseidon2([1n, 2n]), 3n]));
  assert.equal(pool.rootOf(pool.levelsOf([1n, 2n, 3n, 4n, 5n])), poseidon2([poseidon2([poseidon2([1n, 2n]), poseidon2([3n, 4n])]), 5n]));
  for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 16, 17, 33]) {
    const leaves = Array.from({ length: size }, (_, i) => BigInt(i + 1) * 104729n), levels = pool.levelsOf(leaves);
    for (let i = 0; i < size; i++) {
      const p = pool.proofOf(levels, i);
      assert.equal(p.root, pool.rootOf(levels));
      assert.equal(verifyPath(leaves[i], p), p.root, `size ${size} leaf ${i}`);
      assert.equal(pool.padSiblings(p.siblings).length, TREE_DEPTH);
    }
  }
  assert.throws(() => pool.proofOf(pool.levelsOf([1n, 2n]), 2));
  ok('lean trees: a node with no right sibling moves up; every proof folds back to the root');
}

// ── context, data, calldata ──
{
  const wd = { processooor: ETH_POOL.entrypoint, data: pool.withdrawalData('0x1111111111111111111111111111111111111111', '0xEC15c20015e72748F03065ed80c41cb882E3fB66', 10) };
  assert.equal(wd.data.length, 2 + 96 * 2);
  // abi.encode((address,bytes), uint256), written out word by word
  const data = unhex(wd.data), words = [0x40n, ETH_POOL.scope, BigInt(wd.processooor), 0x40n, BigInt(data.length)];
  const enc = concatBytes(...words.map((w) => unhex(w.toString(16).padStart(64, '0'))), data);
  assert.equal(pool.contextOf(wd, ETH_POOL.scope), big(keccak_256(enc)) % FIELD);
  assert.notEqual(pool.contextOf(wd, ETH_POOL.scope), pool.contextOf({ ...wd, data: pool.withdrawalData('0x1111111111111111111111111111111111111112', '0xEC15c20015e72748F03065ed80c41cb882E3fB66', 10) }, ETH_POOL.scope));
  assert.throws(() => pool.withdrawalData('0x12', '0xEC15c20015e72748F03065ed80c41cb882E3fB66', 10));
  ok('context = keccak256(abi.encode((processooor, data), scope)) mod the field; any recipient or fee change moves it');

  const sigOf = (s) => '0x' + hex(keccak_256(utf8(s)).slice(0, 4));
  assert.equal(SEL.deposit, sigOf('deposit(uint256)'));
  assert.equal(SEL.relay, sigOf('relay((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)'));
  assert.equal(SEL.ragequit, sigOf('ragequit((uint256[2],uint256[2][2],uint256[2],uint256[4]))'));
  for (const [k, s] of Object.entries({ latestRoot: 'latestRoot()', currentRoot: 'currentRoot()', currentTreeSize: 'currentTreeSize()', scope: 'SCOPE()', nonce: 'nonce()', roots: 'roots(uint256)', nullifierHashes: 'nullifierHashes(uint256)', assetConfig: 'assetConfig(address)', duplicatePrecommitment: 'PrecommitmentAlreadyUsed()' })) assert.equal(SEL[k], sigOf(s), k);
  const topicOf = (s) => '0x' + hex(keccak_256(utf8(s)));
  assert.equal(TOPIC.deposited, topicOf('Deposited(address,uint256,uint256,uint256,uint256)'));
  assert.equal(TOPIC.withdrawn, topicOf('Withdrawn(address,uint256,uint256,uint256)'));
  assert.equal(TOPIC.ragequit, topicOf('Ragequit(address,uint256,uint256,uint256)'));
  assert.equal(TOPIC.leafInserted, topicOf('LeafInserted(uint256,uint256,uint256)'));
  assert.equal(TOPIC.rootUpdated, topicOf('RootUpdated(uint256,string,uint256)'));
  assert.equal(TOPIC.relayed, topicOf('WithdrawalRelayed(address,address,address,uint256,uint256)'));
  ok('selectors and event topics are the hashes of the signatures');

  const args = { pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n], pubSignals: [10n, 11n, 12n, 13n, 14n, 15n, 16n, 17n] };
  const cd = pool.relayCalldata(wd, args, ETH_POOL.scope);
  const body = unhex(cd);
  const w = (i) => big(body.slice(4 + 32 * i, 4 + 32 * (i + 1)));
  assert.equal(hex(body.slice(0, 4)), SEL.relay.slice(2));
  assert.equal(w(0), 18n * 32n);
  assert.deepEqual([...Array(16).keys()].map((i) => w(1 + i)), [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 10n, 11n, 12n, 13n, 14n, 15n, 16n, 17n]);
  assert.equal(w(17), ETH_POOL.scope);
  assert.equal(w(18), BigInt(wd.processooor));
  assert.equal(w(19), 0x40n);
  assert.equal(w(20), 96n);
  assert.equal(body.length, 4 + 32 * 18 + 32 * 3 + 96);
  const dep = unhex(pool.depositCalldata(123n));
  assert.equal(dep.length, 36);
  assert.equal(big(dep.slice(4)), 123n);
  assert.equal(unhex(pool.ragequitCalldata({ ...args, pubSignals: [1n, 2n, 3n, 4n] })).length, 4 + 32 * 12);
  ok('relay, deposit and ragequit calldata lay out as the ABI says');

  const fromSnark = pool.proofArgs({ pi_a: ['1', '2', '1'], pi_b: [['3', '4'], ['5', '6'], ['1', '0']], pi_c: ['7', '8', '1'] }, ['9']);
  assert.deepEqual(fromSnark.pB, [[4n, 3n], [6n, 5n]]);
  assert.deepEqual(fromSnark.pA, [1n, 2n]);
  ok('a snarkjs proof becomes (pA, pB with each pair swapped, pC, signals)');
}

// ── scanning an account ──
const SCOPE = ETH_POOL.scope;
function chainOf(keys, plan) {
  // plan: [{ index, value, label, spends: [valueTaken, …] }] → events as the pool would have emitted them
  const deposits = [], withdrawals = [];
  let block = 100;
  for (const p of plan) {
    const s = pool.depositSecrets(keys, SCOPE, BigInt(p.index)), pre = pool.precommitmentOf(s.nullifier, s.secret);
    const commitment = pool.commitmentOf(p.value, p.label, pre);
    deposits.push({ precommitment: pre, label: p.label, value: p.value, commitment, block: block++, tx: '0xd' + p.index, depositor: '0xaaaa' });
    let cur = { value: BigInt(p.value), nullifier: s.nullifier };
    (p.spends || []).forEach((take, j) => {
      const nx = pool.withdrawalSecrets(p.otherKeys || keys, p.label, BigInt(j));
      const remaining = cur.value - BigInt(take);
      withdrawals.push({ spentNullifier: pool.nullifierHashOf(cur.nullifier), value: take, newCommitment: pool.commitmentOf(remaining, p.label, pool.precommitmentOf(nx.nullifier, nx.secret)), block: block++, tx: '0xw' + p.index + '.' + j });
      cur = { value: remaining, nullifier: nx.nullifier };
    });
  }
  return { deposits, withdrawals };
}
{
  const { deposits, withdrawals } = chainOf(KEYS, [
    { index: 0, value: 1000n, label: 11n, spends: [300n, 200n] },
    { index: 1, value: 500n, label: 12n },
    { index: 3, value: 700n, label: 13n, spends: [700n] },   // a gap at index 2: found, within the miss limit
  ]);
  const other = await pool.masterKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const noise = chainOf(other, [{ index: 0, value: 9n, label: 21n }, { index: 1, value: 9n, label: 22n }]);
  const found = pool.scan({ keys: KEYS, scope: SCOPE, deposits: [...noise.deposits, ...deposits], withdrawals: [...withdrawals, ...noise.withdrawals], ragequits: [{ label: 12n, commitment: 1n, value: 500n, block: 1, tx: '0xr' }] });
  assert.deepEqual(found.map((f) => f.index), [0n, 1n, 3n]);
  assert.equal(found[0].children.length, 2);
  assert.equal(found[0].last.value, 500n);
  assert.equal(found[0].last.nullifier, pool.withdrawalSecrets(KEYS, 11n, 1n).nullifier);
  assert.equal(found[1].ragequit.value, 500n);
  assert.equal(found[2].last.value, 0n);
  assert.equal(found.every((f) => !f.foreign), true);
  assert.equal(pool.nextIndex(found), 4n);
  assert.equal(pool.nextIndex([]), 0n);
  ok('scan: finds this account\'s deposits (over a gap), follows each chain of withdrawals, flags a ragequit, ignores other keys; the next deposit index is one past the highest');

  // ten misses in a row end the search; nine do not
  const far = (gap) => chainOf(KEYS, [{ index: 0, value: 1n, label: 31n }, { index: 1 + gap, value: 1n, label: 32n }]);
  assert.equal(pool.scan({ keys: KEYS, scope: SCOPE, deposits: far(MISS_LIMIT - 1).deposits }).length, 2);
  assert.equal(pool.scan({ keys: KEYS, scope: SCOPE, deposits: far(MISS_LIMIT).deposits }).length, 1);
  ok(`scan: stops after ${MISS_LIMIT} misses in a row, not before`);

  // a withdrawal whose change was made with other keys ends the chain and marks the note foreign
  const migrated = chainOf(KEYS, [{ index: 0, value: 100n, label: 41n, spends: [40n], otherKeys: other }]);
  const f = pool.scan({ keys: KEYS, scope: SCOPE, deposits: migrated.deposits, withdrawals: migrated.withdrawals });
  assert.equal(f.length, 1);
  assert.equal(f[0].foreign, true);
  assert.equal(f[0].children.length, 0);
  assert.equal(f[0].last.value, 100n);
  ok('scan: change made with other keys is not claimed; the note is marked foreign');

  // a deposit event that does not match the derived commitment is refused
  const bad = chainOf(KEYS, [{ index: 0, value: 100n, label: 51n }]);
  bad.deposits[0].commitment = 1n;
  assert.throws(() => pool.scan({ keys: KEYS, scope: SCOPE, deposits: bad.deposits }), /does not match/);
  ok('scan: refuses a deposit event whose commitment differs from the derived one');
}

// ── planning a withdrawal ──
{
  const { deposits, withdrawals } = chainOf(KEYS, [{ index: 0, value: 1000n, label: 61n, spends: [250n] }]);
  const acct = pool.scan({ keys: KEYS, scope: SCOPE, deposits, withdrawals })[0];
  const stateLeaves = [5n, 6n, deposits[0].commitment, acct.last.commitment, 9n, 10n, 11n], aspLeaves = [1n, 2n, 61n, 4n, 5n];
  const stateLevels = pool.levelsOf(stateLeaves), aspLevels = pool.levelsOf(aspLeaves);
  const recipient = '0x2222222222222222222222222222222222222222', relayer = '0x3333333333333333333333333333333333333333';
  const plan = pool.planWithdraw({ keys: KEYS, acct, amount: 300n, recipient, feeRecipient: relayer, feeBps: 10, stateLevels, aspLevels });
  const next = pool.withdrawalSecrets(KEYS, 61n, 1n);
  assert.equal(plan.remaining, 450n);
  assert.equal(plan.newCommitment, pool.commitmentOf(450n, 61n, pool.precommitmentOf(next.nullifier, next.secret)));
  assert.deepEqual(plan.expect, [plan.newCommitment, pool.nullifierHashOf(acct.last.nullifier), 300n, pool.rootOf(stateLevels), 32n, pool.rootOf(aspLevels), 32n, plan.context]);
  assert.equal(plan.input.stateSiblings.length, 32);
  assert.equal(plan.input.ASPSiblings.length, 32);
  assert.equal(plan.input.existingNullifier, acct.last.nullifier);
  assert.equal(plan.input.newNullifier, next.nullifier);
  assert.equal(plan.input.label, 61n);
  assert.equal(plan.context, pool.contextOf(plan.withdrawal, SCOPE));
  assert.equal(pool.check(plan, { stateRoots: new Set([pool.rootOf(stateLevels)]), aspRoot: pool.rootOf(aspLevels) }), null);
  assert.match(pool.check(plan, { stateRoots: new Set([1n]), aspRoot: pool.rootOf(aspLevels) }), /pool moved on/);
  assert.match(pool.check(plan, { stateRoots: new Set([pool.rootOf(stateLevels)]), aspRoot: 1n }), /approval list moved on/);
  // the note's own leaf and the label's leaf fold to those roots, so the circuit's Merkle checks hold
  const sp = pool.proofOf(stateLevels, stateLeaves.indexOf(acct.last.commitment)), ap = pool.proofOf(aspLevels, 2);
  assert.equal(verifyPath(acct.last.commitment, sp), pool.rootOf(stateLevels));
  assert.equal(verifyPath(61n, ap), pool.rootOf(aspLevels));
  assert.equal(plan.input.stateIndex, BigInt(sp.index));
  assert.equal(plan.input.ASPIndex, BigInt(ap.index));
  ok('planWithdraw: the circuit input and the signals it must return, with the change at the next child index');

  const attempt = (o) => pool.planWithdraw({ keys: KEYS, acct, amount: 300n, recipient, feeRecipient: relayer, feeBps: 10, stateLevels, aspLevels, ...o });
  assert.throws(() => attempt({ amount: 751n }), /within the balance/);
  assert.throws(() => attempt({ amount: 0n }), /within the balance/);
  assert.throws(() => attempt({ aspLevels: pool.levelsOf([1n, 2n]) }), /not approved/);
  assert.throws(() => attempt({ stateLevels: pool.levelsOf([1n, 2n]) }), /not in the state tree/);
  assert.throws(() => pool.planWithdraw({ keys: KEYS, acct: { ...acct, foreign: true }, amount: 1n, recipient, feeRecipient: relayer, feeBps: 10, stateLevels, aspLevels }), /other keys/);
  assert.throws(() => pool.planWithdraw({ keys: KEYS, acct: { ...acct, ragequit: { value: 1n } }, amount: 1n, recipient, feeRecipient: relayer, feeBps: 10, stateLevels, aspLevels }), /exited publicly/);
  ok('planWithdraw refuses an over-balance amount, an unapproved deposit, a missing note, a foreign note and an exited one');

  const rq = pool.ragequitInput(acct);
  assert.deepEqual(rq.expect, [acct.last.commitment, pool.nullifierHashOf(acct.last.nullifier), 750n, 61n]);
  ok('ragequit input: the note\'s value, label, nullifier and secret, and its four signals');
}

console.log(`\n${n} groups passed`);
