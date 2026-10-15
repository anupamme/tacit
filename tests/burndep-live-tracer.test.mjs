// worker/src/burndep-live-tracer.js reads each hop's inputs the way the reflection guest does. An atomic settlement (what the taker
// of a Bitcoin order-book listing signs) lays its vins out as [the taker's commit, the seller's note, the taker's sats], so its
// kernel covers vin[1..1+count] and the funding follows the note; any other transfer takes every vin after its leading funding.
// The fixture is real mainnet: the purchase c654294c… (block 970,179, 1 asset input at vin 1, funding at vin 0 and vin 2), the
// split 683798fa… that made the seller's note (a leading funding input, then one note), and the funding transaction before it.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeLiveBurnDepositTracer, traceBurnDepositProvenance } from '../worker/src/burndep-live-tracer.js';
import { makeBurnDepositTracer } from '../dapp/burn-deposit-tracer.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/burndep-listing-purchase-2026-10-16.json', import.meta.url), 'utf8'));
const id = (prefix) => Object.keys(FIX).find((k) => k.startsWith(prefix));
const PURCHASE = id('c654294c'), SPLIT = id('683798fa'), SPLIT_FUNDING = id('9981c2ea'), SPLIT_NOTE = id('57829e14');
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

// An esplora that serves the fixture, with `patch` replacing a transaction's vin list; any other txid is a failed read.
function tracer({ patch = {}, kv = null } = {}) {
  const asked = [];
  const apiText = async (env, path) => {
    const m = /^\/tx\/([0-9a-f]{64})(\/hex)?$/.exec(path);
    const rec = m && FIX[m[1]];
    if (!rec) throw new Error(`no such transaction: ${path}`);
    asked.push(m[1]);
    if (m[2]) return rec.hex;
    const j = JSON.parse(rec.json);
    return JSON.stringify(patch[m[1]] ? { ...j, vin: patch[m[1]] } : j);
  };
  const t = makeLiveBurnDepositTracer({
    env: kv ? { REGISTRY_KV: kv } : {}, apiText, apiRawBytes: async () => { throw new Error('no blocks'); },
    network: 'mainnet', outpointKey: pool.outpointKey, sha256, fullBlockWitness: false,
  });
  return { t, asked };
}
const hopOf = async ({ t }, txid, vout) => t.getCxferByOutput(t.seed(txid, vout));
const vin = (txid, vout) => ({ txid, vout });

test('a listing purchase: the kernel covers the seller\'s note at vin 1, the skip is 1, and the taker\'s funding is never read', async () => {
  const x = tracer();
  const hop = await hopOf(x, PURCHASE, 0);
  assert.equal(hop.inputSkip, 1);
  assert.equal(hop.inputs.length, 1);
  assert.equal(hop.inputs[0].prevTxid, '0x' + SPLIT);
  assert.equal(hop.inputs[0].prevVout, 1);
  assert.match(hop.inputs[0].commitment, /^0x0[23][0-9a-f]{64}$/);
  // vin 0 (the commit) and vin 2 (the taker's sats) share one funding transaction, which a purchase's trace has no use for.
  assert.ok(!x.asked.includes(id('884ff6a7')), 'the funding transaction was read');
  assert.ok(x.asked.includes(SPLIT));
});

test('an ordinary transfer still skips its leading funding and carries every later input', async () => {
  const hop = await hopOf(tracer(), SPLIT, 3);
  assert.equal(hop.inputSkip, 1);
  assert.deepEqual(hop.inputs.map((i) => [i.prevTxid, i.prevVout]), [['0x' + SPLIT_NOTE, 0]]);
});

test('a listing purchase whose "asset input" is plain sats is refused', async () => {
  const x = tracer({ patch: { [PURCHASE]: [vin(SPLIT_FUNDING, 0), vin(SPLIT_FUNDING, 1), vin(SPLIT_FUNDING, 0)] } });
  await assert.rejects(hopOf(x, PURCHASE, 0), /atomic settlement whose asset input 1 .* is not a confidential note/);
});

test('a listing purchase that names more asset inputs than it has is refused', async () => {
  const x = tracer({ patch: { [PURCHASE]: [vin(SPLIT_FUNDING, 0)] } });
  await assert.rejects(hopOf(x, PURCHASE, 0), /naming 1 asset input\(s\) but has only 1 input/);
});

test('an ordinary transfer with funding after a note is still refused (the guest takes every input after the leading ones)', async () => {
  const x = tracer({ patch: { [SPLIT]: [vin(SPLIT_NOTE, 0), vin(SPLIT_FUNDING, 0)] } });
  await assert.rejects(hopOf(x, SPLIT, 3), /non-confidential input at index 1/);
});

test('a hop cached before the settlement shape was tracked reads the same as a fresh one', async () => {
  // The shallow record a deployed worker holds for the purchase has no assetInputCount.
  const fresh = tracer();
  const rec = await fresh.t.resolveShallow(PURCHASE);
  const { assetInputCount, ...old } = rec;
  assert.equal(assetInputCount, undefined);
  const kv = { get: async (k) => (k === `burndepshallow:mainnet:${PURCHASE}` ? old : null), put: async () => {} };
  const hop = await hopOf(tracer({ kv }), PURCHASE, 0);
  assert.equal(hop.inputSkip, 1);
  assert.deepEqual(hop.inputs.map((i) => [i.prevTxid, i.prevVout]), [['0x' + SPLIT, 1]]);
});

// maxDepth bounds the transfers in a lineage, not the outpoints the walk visits: the purchase, the split that made the seller's note, and
// the supply leaf (standing in for the etch) are three outpoints but two hops.
async function walk(maxDepth) {
  return traceBurnDepositProvenance({
    env: {}, network: 'mainnet', outpointKey: pool.outpointKey, sha256, maxDepth,
    trace: makeBurnDepositTracer({ outpointKey: pool.outpointKey }).trace,
    apiText: (env, path) => FIXTURE_API(path), apiRawBytes: async () => { throw new Error('no blocks'); },
    note: { txid: PURCHASE, vout: 0 }, leaves: [{ txid: SPLIT_NOTE, vout: 0 }],
  });
}
const FIXTURE_API = async (path) => {
  const m = /^\/tx\/([0-9a-f]{64})(\/hex)?$/.exec(path);
  const rec = m && FIX[m[1]];
  if (!rec) throw new Error(`no such transaction: ${path}`);
  return m[2] ? rec.hex : rec.json;
};
test('a lineage of two hops traces under a limit of two, and is refused under a limit of one', async () => {
  const res = await walk(2);
  assert.equal(res.cxfers.length, 2);
  assert.deepEqual(res.cxfers.map((c) => c.inputSkip), [1, 1]);
  await assert.rejects(walk(1), /exceeded maxDepth \(1\)/);
});
