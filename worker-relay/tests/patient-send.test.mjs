// The patient send: the cheap offer first, raised only when nobody takes it, and a landed earlier offer is never an error.
// node --test tests/patient-send.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { tipLadder, sendPatient, raised } from '../src/lib/patient-send.js';

test('the ladder climbs by clear raises from the cheap offer to the market, and never past the cap', () => {
  assert.deepEqual(tipLadder({ patient: 1_000_000n, market: 50_000_000n }), [1_000_000n, 25_500_000n, 50_000_000n]);
  const l = tipLadder({ patient: 1_000_000n, market: 50_000_000n });
  for (let i = 1; i < l.length; i++) assert.ok(l[i] >= raised(l[i - 1]) - 1n, 'a replacement must clear the 10% a node asks');
  assert.deepEqual(tipLadder({ patient: 1_000_000n, market: 50_000_000n, capWei: 10_000_000n }), [1_000_000n, 5_500_000n, 10_000_000n]);
});

test('a market at or near the cheap offer, or none, is one offer', () => {
  assert.deepEqual(tipLadder({ patient: 1_000_000n, market: 1_000_000n }), [1_000_000n]);
  assert.deepEqual(tipLadder({ patient: 1_000_000n, market: 500_000n }), [1_000_000n], 'a market under the cheap offer never lowers it');
  assert.deepEqual(tipLadder({ patient: 1_000_000n, market: 1_100_000n }), [1_000_000n], 'a raise too small for a node is not offered');
  assert.deepEqual(tipLadder({ patient: 50_000_000n, market: 50_000_000n }), [50_000_000n]);
});

test('when the cheap offer lands there is one send and no replacement', async () => {
  const sent = [];
  const r = await sendPatient({
    send: async (o) => { sent.push(o); return '0xaa'; }, wait: async (h) => ({ transactionHash: h, status: 'success' }),
    nonceOf: async () => { throw new Error('not needed'); }, found: async () => null, tips: [1n, 50n, 100n], waitMs: 1000,
  });
  assert.equal(sent.length, 1); assert.equal(sent[0].tip, 1n); assert.equal(sent[0].nonce, undefined);
  assert.equal(r.raises, 0); assert.equal(r.tip, 1n);
});

test('an offer nobody takes is replaced at the same nonce with the next, and the one that lands is returned', async () => {
  const sent = []; let n = 0;
  const r = await sendPatient({
    send: async (o) => { sent.push(o); return `0x${++n}`; },
    wait: async (h) => (h === '0x2' ? { transactionHash: h, status: 'success' } : null),
    nonceOf: async (h) => { assert.equal(h, '0x1'); return 41; }, found: async () => null, tips: [1n, 50n, 100n], waitMs: 5,
  });
  assert.deepEqual(sent.map((s) => [s.tip, s.nonce]), [[1n, undefined], [50n, 41]]);
  assert.equal(r.hash, '0x2'); assert.equal(r.raises, 1); assert.equal(r.tip, 50n);
});

test('the last offer is waited on until it lands, and an earlier offer that lands instead ends it', async () => {
  let calls = 0, n = 0;
  const r = await sendPatient({
    send: async () => `0x${++n}`, wait: async () => { calls++; return null; },
    nonceOf: async () => 7,
    found: async (hashes) => (calls > 6 && hashes.includes('0x1') ? { hash: '0x1', receipt: { status: 'success', transactionHash: '0x1' } } : null),
    tips: [1n, 50n], waitMs: 1,
  });
  assert.equal(r.hash, '0x1'); assert.ok(calls > 6, `waited in slices (${calls})`);
});

test('a replacement a node refuses because the earlier offer just landed is a success, any other refusal is thrown', async () => {
  const landed = { hash: '0x1', receipt: { status: 'success', transactionHash: '0x1' } };
  let first = true;
  const r = await sendPatient({
    send: async (o) => { if (o.nonce != null) throw new Error('nonce too low'); return '0x1'; },
    wait: async () => null, nonceOf: async () => 3,
    found: async () => { if (first) { first = false; return null; } return landed; }, tips: [1n, 50n], waitMs: 1,
  });
  assert.equal(r.hash, '0x1', 'the earlier offer landed while the replacement was signed');
  await assert.rejects(sendPatient({
    send: async (o) => { if (o.nonce != null) throw new Error('insufficient funds'); return '0x1'; }, wait: async () => null,
    nonceOf: async () => 3, found: async () => null, tips: [1n, 50n], waitMs: 1,
  }), /insufficient funds/);
});
