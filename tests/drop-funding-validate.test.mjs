// dapp/tacit.js validateOutpoint on T_DCLAIM and T_DROP reclaim outputs — network-free.
//
// Builds real T_DROP / T_DCLAIM / reclaim envelopes over a real CETCH note and runs them through the dapp validator
// with the worker's answers stubbed:
//   - a claim or reclaim is credited only against a drop whose reveal spent validated notes of its asset that open
//     to its cap (kernel over Σ C_in − cap·H): an unfunded, over-declared or wrong-asset drop pays nothing;
//   - a claim waits for the worker's credited set: an unreachable worker leaves it pending, not credited;
//   - a reclaim is credited once: it must be the reclaim the worker recorded, under the depositor's key.
//
// Run: node tests/drop-funding-validate.test.mjs

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { randomBytes } from 'node:crypto';
import { pointToBytes, randomScalar, _bpGens, bpRangeAggProve, pedersenCommit } from './bulletproofs.mjs';
import { assetIdFor, encodeCEtchPayload } from './composition.mjs';
import { encodeEnvelopeScript } from './indexer.mjs';

const store = new Map();
const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el(), readyState: 'complete' };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', hash: '', search: '', pathname: '/', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true, language: 'en' }, configurable: true }); } catch {}
globalThis.addEventListener = () => {};
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.__TACIT_WORKER_BASE__ = 'https://worker.test';
store.set('tacit-network-v1', 'signet');

// Worker stub: the credited claim set and the drop record (with its recorded reclaim) per drop id.
const W = { credited: new Map(), drops: new Map(), down: false };
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://worker.test') throw new TypeError('offline');
  if (W.down) throw new TypeError('Failed to fetch');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const m = u.pathname.match(/^\/drops-onchain\/([0-9a-f]{64})(\/claims)?$/);
  if (m && m[2]) return json({ credited_txids: W.credited.get(m[1]) || [], cursor: null, truncated: false, list_complete: true, scanned_height: 200 });
  if (m) return W.drops.has(m[1]) ? json(W.drops.get(m[1])) : json({ error: 'not found' }, 404);
  return json({ error: 'not found' }, 404);
};

const dapp = await import('../dapp/tacit.js');
_bpGens();

const PRIV = randomBytes(32);
const PUB = secp.getPublicKey(PRIV, true);
dapp.wallet.priv = PRIV;
dapp.wallet.pub = PUB;
try { localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(PUB), '1'); } catch {}

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};

let counter = 0;
const nextTxid = () => { const b = new Uint8Array(32); new DataView(b.buffer).setUint32(28, ++counter, false); b[0] = 0x6d; return bytesToHex(b); };
const txs = new Map();
const fetchTx = async (id) => txs.get(id) || null;
const witnessFor = (script) => [bytesToHex(new Uint8Array(64)), bytesToHex(script), bytesToHex(new Uint8Array(33))];
const confirmed = (h = 100) => ({ confirmed: true, block_height: h });
const N = secp.CURVE.n;
const b32 = (x) => hexToBytes((((x % N) + N) % N).toString(16).padStart(64, '0'));
const P2WPKH = '0014' + '11'.repeat(20);

function etch(amount, blinding = randomScalar()) {
  const { proof, commitments } = bpRangeAggProve([amount], [blinding]);
  const payload = encodeCEtchPayload({
    ticker: 'TST', decimals: 0, commitment: pointToBytes(commitments[0]), rangeproof: proof,
    encryptedAmount: new Uint8Array(8), mintAuthority: null,
  });
  const txid = nextTxid();
  txs.set(txid, { txid, status: confirmed(90), vin: [{ txid: nextTxid(), vout: 0, witness: witnessFor(encodeEnvelopeScript(randomBytes(32), payload)) }], vout: [{ scriptpubkey: P2WPKH, value: 546 }] });
  return { txid, vout: 0, amount, blinding, assetId: assetIdFor(txid, 0) };
}
// A plain (non-tacit) output: a P2WPKH spend, which can never carry an envelope.
function plainOutput() {
  const txid = nextTxid();
  txs.set(txid, { txid, status: confirmed(90), vin: [{ txid: nextTxid(), vout: 0, witness: [bytesToHex(new Uint8Array(71)), bytesToHex(PUB)], prevout: { scriptpubkey_type: 'v0_p2wpkh' } }], vout: [{ scriptpubkey: P2WPKH, value: 5000 }] });
  return { txid, vout: 0 };
}
// A T_DROP reveal spending `inputs`, its kernel signed with `kernelKey` (Σ r_in for an honest drop).
function drop({ assetId, cap, per, inputs, kernelKey, expiry = 150 }) {
  const assetInputs = inputs.map((n) => ({ txid: n.txid, vout: n.vout }));
  const msg = dapp.dropKernelMsg({ assetId, capAmount: cap, perClaim: per, merkleRoot: new Uint8Array(32), expiryHeight: expiry, assetInputCount: inputs.length, assetInputs });
  const kernelSig = dapp.signSchnorr(msg, b32(kernelKey));
  const payload = dapp.encodeCDropPayload({ assetId, capAmount: cap, perClaim: per, merkleRoot: new Uint8Array(32), expiryHeight: expiry, ticker: 'TST', decimals: 0, assetInputCount: inputs.length, kernelSig });
  const txid = nextTxid();
  txs.set(txid, { txid, status: confirmed(100), vin: [
    { txid: nextTxid(), vout: 0, witness: witnessFor(dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload)) },
    ...inputs.map((n) => ({ txid: n.txid, vout: n.vout, witness: [bytesToHex(new Uint8Array(71)), bytesToHex(PUB)] })),
  ], vout: [{ scriptpubkey: P2WPKH, value: 546 }] });
  const dropId = bytesToHex(dapp.dropIdFromRevealTxid(txid));
  W.drops.set(dropId, { kind: 'drop', drop_reveal_txid: txid, asset_id: bytesToHex(assetId), cap_amount: String(cap), per_claim: String(per), expiry_height: expiry, claim_count: 0, list_complete: true, scanned_height: 200 });
  return { txid, dropId, assetId, cap, per, expiry };
}
function claim(d, h = 110) {
  const b = randomScalar();
  const payload = dapp.encodeCDClaimPayload({ assetId: d.assetId, dropRevealTxid: hexToBytes(d.txid), commitment: pointToBytes(pedersenCommit(d.per, b)), amount: d.per, blinding: b32(b) });
  const txid = nextTxid();
  txs.set(txid, { txid, status: confirmed(h), vin: [{ txid: nextTxid(), vout: 0, witness: witnessFor(dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload)) }], vout: [{ scriptpubkey: P2WPKH, value: 546 }] });
  return txid;
}
function reclaim(d, { signerXonly = dapp.wallet.xonly(), h = 160 } = {}) {
  const meta = W.drops.get(d.dropId);
  const remainder = d.cap - BigInt(meta.claim_count) * d.per;
  const reclaimDropId = hexToBytes(d.dropId);
  const reclaimSig = dapp.signSchnorr(dapp.dropReclaimMsg({ reclaimDropId, assetId: d.assetId, capAmount: remainder }), PRIV);
  const payload = dapp.encodeCDropReclaimPayload({ assetId: d.assetId, capAmount: remainder, reclaimDropId, reclaimSig, capBlinding: b32(randomScalar()) });
  const txid = nextTxid();
  txs.set(txid, { txid, status: confirmed(h), vin: [{ txid: nextTxid(), vout: 0, witness: witnessFor(dapp.encodeEnvelopeScript(signerXonly, payload)) }], vout: [{ scriptpubkey: P2WPKH, value: 546 }] });
  return txid;
}
async function verdict(txid, vout = 0) {
  dapp.clearValidatorCaches();
  const set = new Map(), reasons = new Map();
  const v = await dapp.validateOutpoint(txid, vout, set, fetchTx, 0, null, null, null, reasons);
  return { v, reason: reasons.get(`${txid}:${vout}`) || null };
}

console.log('T_DCLAIM:');
{
  const note = etch(1000n);
  const d = drop({ assetId: note.assetId, cap: 1000n, per: 100n, inputs: [note], kernelKey: note.blinding });
  const c1 = claim(d);
  W.credited.set(d.dropId, [c1]);
  const r1 = await verdict(c1);
  ok('a claim on a funded drop, in the credited set, validates', r1.v === true, JSON.stringify(r1));

  const c2 = claim(d);
  const r2 = await verdict(c2);
  ok('a claim outside the credited set is not credited', r2.v === false, JSON.stringify(r2));

  W.down = true;
  const r3 = await verdict(c1);
  W.down = false;
  ok('an unreachable worker leaves a claim pending, not credited', r3.v === false && r3.reason === 'fetch-failed', JSON.stringify(r3));

  // The drop's reveal spends no Tacit note at all.
  const plain = plainOutput();
  const unfunded = drop({ assetId: note.assetId, cap: 1000n, per: 100n, inputs: [plain], kernelKey: randomScalar() });
  const c4 = claim(unfunded);
  W.credited.set(unfunded.dropId, [c4]);
  const r4 = await verdict(c4);
  ok('a claim on a drop whose input is not a Tacit note is invalid', r4.v === false && r4.reason === 'invalid', JSON.stringify(r4));

  // The input is real but holds less than the declared cap.
  const small = etch(500n);
  const over = drop({ assetId: small.assetId, cap: 1000n, per: 100n, inputs: [small], kernelKey: small.blinding });
  const c5 = claim(over);
  W.credited.set(over.dropId, [c5]);
  const r5 = await verdict(c5);
  ok('a claim on a drop declaring more than its inputs hold is invalid', r5.v === false && r5.reason === 'invalid', JSON.stringify(r5));

  // A note of another asset funds a drop declared over this asset.
  const other = etch(1000n);
  const wrong = drop({ assetId: note.assetId, cap: 1000n, per: 100n, inputs: [other], kernelKey: other.blinding });
  const c6 = claim(wrong);
  W.credited.set(wrong.dropId, [c6]);
  const r6 = await verdict(c6);
  ok('a claim on a drop funded with another asset is invalid', r6.v === false && r6.reason === 'invalid', JSON.stringify(r6));

  // The kernel is signed by a key other than the inputs' blinding sum.
  const forged = etch(1000n);
  const badKernel = drop({ assetId: forged.assetId, cap: 1000n, per: 100n, inputs: [forged], kernelKey: randomScalar() });
  const c7 = claim(badKernel);
  W.credited.set(badKernel.dropId, [c7]);
  const r7 = await verdict(c7);
  ok('a claim on a drop whose kernel does not sign its inputs is invalid', r7.v === false && r7.reason === 'invalid', JSON.stringify(r7));
}

console.log('\nT_DROP reclaim:');
{
  const note = etch(1000n);
  const d = drop({ assetId: note.assetId, cap: 1000n, per: 100n, inputs: [note], kernelKey: note.blinding });
  const meta = W.drops.get(d.dropId);
  meta.claim_count = 1;

  const first = reclaim(d);
  meta.reclaimed = { reclaim_txid: first };
  const r1 = await verdict(first);
  ok('the recorded reclaim of a funded drop, under the depositor key, validates', r1.v === true, JSON.stringify(r1));

  const second = reclaim(d);
  const r2 = await verdict(second);
  ok('a second reclaim of the same drop is not credited', r2.v === false, JSON.stringify(r2));

  const stranger = secp.getPublicKey(randomBytes(32), true).slice(1);
  const foreign = reclaim(d, { signerXonly: stranger });
  meta.reclaimed = { reclaim_txid: foreign };
  const r3 = await verdict(foreign);
  ok('a reclaim whose envelope is not under the depositor key is not credited', r3.v === false, JSON.stringify(r3));

  delete meta.reclaimed;
  const r4 = await verdict(first);
  ok('a reclaim the worker has not recorded is not credited yet', r4.v === false, JSON.stringify(r4));

  meta.reclaimed = { reclaim_txid: first };
  meta.scanned_height = d.expiry + 1;
  const r4b = await verdict(first);
  ok('a reclaim waits until the claim count past expiry is final', r4b.v === false, JSON.stringify(r4b));
  meta.scanned_height = 200;

  const plain = plainOutput();
  const unfunded = drop({ assetId: note.assetId, cap: 1000n, per: 100n, inputs: [plain], kernelKey: randomScalar() });
  const r5tx = reclaim(unfunded);
  W.drops.get(unfunded.dropId).reclaimed = { reclaim_txid: r5tx };
  const r5 = await verdict(r5tx);
  ok('the reclaim of an unfunded drop is invalid', r5.v === false && r5.reason === 'invalid', JSON.stringify(r5));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
