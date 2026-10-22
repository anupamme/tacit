// dapp/btc-borrow.js, a loan of cUSD against cBTC as every page builds it: the open arguments from a cBTC note, what is remembered once it is in,
// the loan's leaf, the repay arguments and what is forgotten after, and the next position key (chain, this browser, and the cap between them).
// The pool module is a stand-in that records what it is asked: its own maths is tested elsewhere.
//   node tests/btc-borrow.test.mjs
import assert from 'node:assert/strict';
import { makeLoans, exactNotes } from '../dapp/btc-borrow.js';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const L = makeLoans({ sha256: null, hmac: null, secp: null, bytesToHex: null, hexToBytes: null, pubHex: () => 'pub1' });
const t = {
  pool: { nativeNu: (o, nk, leaf) => `nu(${o},${nk},${leaf})`, leaf: (a, cx, cy, o) => `leaf(${a},${cx},${cy},${o})` },
  deriveOutput: (priv, anchor, kind, i) => ({ blindingHex: `b(${priv},${anchor},${kind},${i})`, nk: `nk(${priv},${anchor},${kind},${i})` }),
  cdp: {
    debtAssetId: (c) => `0xUSD-${c}`, basketLeg: (a, v) => `${a}:${v}`, basketRoot: (legs) => `root[${legs.join(',')}]`,
    positionLeaf: (...a) => `pos(${a.map(String).join('|')})`, positionNullifier: (leaf) => `null(${leaf})`,
  },
  recoverCdpPositions: async () => t.recovered,
};

// ── opening against a note ──
const note = { asset: '0xCBTC', cx: '1', cy: '2', value: '5000000', blinding: 'bl', leafIndex: 7, path: ['p'], owner: 'own', secret: 'sec', root: '0xroot' };
const { leg, anchor, args } = L.openArgs(t, 'PRIV', { note, debtValue: 900n, controller: '0xC', rate: '0xrate', positionOwner: '0xOWNER' });
assert.deepEqual(leg, { asset: '0xCBTC', cx: '1', cy: '2', value: '5000000', blinding: 'bl', leafIndex: 7, path: ['p'], owner: 'own', nk: 'sec' }, 'the note as the collateral leg, its secret as the nk');
assert.equal(anchor, 'nu(own,sec,leaf(0xCBTC,1,2,own))', 'the debt anchor is the note\'s nullifier');
assert.deepEqual(args, { controller: '0xC', debtValue: 900n, rateSnapshot: '0xrate', fee: 0n, collateral: [leg], spendRoot: '0xroot', debtBlinding: `b(PRIV,${anchor},cdpDebt,0)`, positionOwner: '0xOWNER', debtNk: `nk(PRIV,${anchor},cdpDebt,0)` }, 'the openCdp arguments');

let added = null;
const ps = { add: async (priv, rec) => { added = [priv, rec]; }, remove: (f) => { ps.kept = ps.kept.filter((x) => !f(x)); }, list: () => ps.kept, kept: [] };
await L.opened(ps, 'PRIV', { controller: '0xC', debtValue: 900n, keyNonce: 3, positionOwner: '0xOWNER', rate: '0xrate', anchor, basket: [{ asset: '0xCBTC', value: '5000000' }], txHash: '0xtx' });
assert.deepEqual(added, ['PRIV', { controller: '0xC', debtValue: '900', nonce: '0x' + '0'.repeat(64), keyNonce: 3, positionOwner: '0xOWNER', rateSnapshot: '0xrate', debtAnchor: anchor, basket: [{ asset: '0xCBTC', value: '5000000' }], openedAt: '0xtx' }], 'what is remembered once it is in');
await L.opened({ add: async () => { throw new Error('quota'); } }, 'PRIV', { controller: '0xC', debtValue: 1n, keyNonce: 0, positionOwner: 'o', rate: 'r', anchor: 'a', basket: [] });   // a store that fails does not fail the loan

// ── repaying ──
const p = { controller: '0xC', debtValue: '900', rateSnapshot: '0xrate', positionOwner: '0xOWNER', basket: [{ asset: '0x02', value: '5' }, { asset: '0x01', value: '7' }] };
const pl = L.positionLeaf(t, p);
assert.deepEqual(pl.basket.map((l) => l.asset), ['0x01', '0x02'], 'the basket in asset order');
assert.equal(pl.debtAsset, '0xusd-0xc');
assert.equal(pl.leaf, `pos(0xC|0xusd-0xc|root[0x01:7,0x02:5]|900|0xrate|0xOWNER|0x${'0'.repeat(64)})`, 'the loan\'s leaf, its nonce zero when none is kept');
const tree = { root: '0xtree', pathFor: (i) => ({ path: [`path${i}`] }) };
const debt = { cx: 'a', cy: 'b', value: '900', blinding: 'x', leafIndex: 9, path: ['q'], owner: 'o2', secret: 's2', root: '0xspend' };
const ra = L.repayArgs(t, 'PRIV', { p, ownerPriv: 'OP', basket: pl.basket, tree, index: 4, picked: [debt] });
const nu = `null(${pl.leaf})`;
assert.deepEqual(ra, {
  controller: '0xC', debtValue: 900n, rateSnapshot: '0xrate', positionOwner: '0xOWNER', positionOwnerPriv: 'OP', basket: pl.basket, positionIndex: 4, positionPath: ['path4'],
  spendRoot: '0xspend', cdpPositionRoot: '0xtree', fee: 0n,
  releaseBlindings: [`b(PRIV,${nu},cdpRelease,0)`, `b(PRIV,${nu},cdpRelease,1)`], releaseNks: [`nk(PRIV,${nu},cdpRelease,0)`, `nk(PRIV,${nu},cdpRelease,1)`],
  debtNotes: [{ cx: 'a', cy: 'b', value: '900', blinding: 'x', leafIndex: 9, path: ['q'], owner: 'o2', nk: 's2' }],
}, 'the closeCdp arguments: the collateral comes back to keys from the loan\'s nullifier');
ps.kept = [{ controller: '0xC', positionOwner: '0xOWNER', debtValue: '900' }, { controller: '0xC', positionOwner: '0xOTHER', debtValue: '900' }];
L.repaid(ps, p);
assert.deepEqual(ps.kept, [{ controller: '0xC', positionOwner: '0xOTHER', debtValue: '900' }], 'only the repaid loan is forgotten');

// ── the next position key ──
const ownerOf = (i) => `owner${i}`, K = 'tacit-cdp-next-key-nonce:0xc:pub1';
ps.kept = [];
t.recovered = { nextKeyNonce: 4, skipped: [] };
assert.equal(await L.nextKeyNonce(t, 'PRIV', '0xC', ps, ownerOf), 4, 'the chain\'s next');
assert.equal(mem.get(K), '5', 'and this browser moves past it');
assert.equal(await L.nextKeyNonce(t, 'PRIV', '0xC', ps, ownerOf), 5, 'a key handed out here and not yet on chain is not handed out again');
mem.set(K, '40');
assert.equal(await L.nextKeyNonce(t, 'PRIV', '0xC', ps, ownerOf), 14, 'never more than ten past the chain');
ps.kept = [{ controller: '0xc', keyNonce: 20, positionOwner: 'owner20' }]; mem.delete(K);
t.recovered = { nextKeyNonce: 2, skipped: ['x'] };
assert.equal(await L.nextKeyNonce(t, 'PRIV', '0xC', ps, ownerOf), 21, 'with a partial recovery, the most of it and the loans kept here');
ps.kept = []; mem.delete(K); t.recovered = null;
await assert.rejects(L.nextKeyNonce(t, 'PRIV', '0xC', ps, ownerOf), /Could not read your existing loans/, 'nothing read and nothing kept: refused');
// ── the cUSD notes that repay a loan exactly ──
const nv = (...vs) => vs.map((v, i) => ({ id: i, value: String(v) }));
assert.deepEqual(exactNotes(nv(300, 500, 900), 500n).map((x) => x.value), ['500'], 'a note of exactly the loan');
assert.deepEqual(exactNotes(nv(100, 400, 250, 700), 500n).map((x) => x.value).sort(), ['100', '400'], 'else the fewest notes that add up to it');
assert.deepEqual(exactNotes(nv(100, 150, 200, 50), 500n)?.map((x) => x.value).sort(), ['100', '150', '200', '50'], 'up to four');
assert.equal(exactNotes(nv(100, 100, 100, 100, 100), 500n), null, 'never more than four');
assert.equal(exactNotes(nv(300, 400), 500n), null, 'no exact sum: left for a cut');
assert.equal(exactNotes(nv(200), 500n), null, 'too little');
console.log('btc-borrow: all checks passed');
