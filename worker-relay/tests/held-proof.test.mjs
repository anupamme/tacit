// A proof bought for a batch is kept and reused for that same batch (src/lib/held-proof.js).
// node --test tests/held-proof.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHeldProof } from '../src/lib/held-proof.js';

const proof = { publicValues: '0xaa', proofBytes: '0xbb' };

test('the proof comes back for the same batch, whatever the case of its digest', () => {
  const h = makeHeldProof();
  h.keep('0xABCDEF', proof);
  assert.equal(h.take('0xabcdef'), proof);
  assert.equal(h.take('0xAbCdEf'), proof);
});

test('a different batch gets no proof', () => {
  const h = makeHeldProof();
  h.keep('0x01', proof);
  assert.equal(h.take('0x02'), null);
  assert.equal(h.take(''), null);
});

test('nothing is held until a proof is kept, and clear drops it', () => {
  const h = makeHeldProof();
  assert.equal(h.take('0x01'), null);
  h.keep('0x01', proof);
  h.clear();
  assert.equal(h.take('0x01'), null);
});

test('keeping a proof for a new batch replaces the old one', () => {
  const h = makeHeldProof();
  h.keep('0x01', proof);
  h.keep('0x02', { publicValues: '0xcc', proofBytes: '0xdd' });
  assert.equal(h.take('0x01'), null);
  assert.equal(h.take('0x02').publicValues, '0xcc');
});

test('a proof is not reused past its time limit', () => {
  let t = 1_000_000;
  const h = makeHeldProof({ now: () => t, ttlMs: 60_000 });
  h.keep('0x01', proof);
  t += 59_000;
  assert.equal(h.take('0x01'), proof);
  t += 2_000;
  assert.equal(h.take('0x01'), null);
});
