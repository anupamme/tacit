// The size of the reflection job the lane asks for (src/lib/block-cap.js): halved when the prover network refuses a batch it
// cannot execute, raised one block at a time while batches prove at the full ask, never moved by a failure that is not that.
// node --test tests/block-cap.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextBlockCap, isUnexecutable, BLOCK_CAP_MAX } from '../src/lib/block-cap.js';

test('a refused batch halves the ask, down to one block', () => {
  assert.equal(nextBlockCap(null, { unexecutable: true, blocks: 20 }), 10);
  assert.equal(nextBlockCap(10, { unexecutable: true, blocks: 10 }), 5);
  assert.equal(nextBlockCap(5, { unexecutable: true, blocks: 5 }), 2);
  assert.equal(nextBlockCap(2, { unexecutable: true, blocks: 2 }), 1);
  assert.equal(nextBlockCap(3, { unexecutable: true, blocks: 3 }), 1);
});

test('the halving follows the batch that failed, not the old ask', () => {
  // The lane was nearly caught up and the job held 3 blocks under an ask of 8.
  assert.equal(nextBlockCap(8, { unexecutable: true, blocks: 3 }), 1);
});

test('a refusal at one block is not about size, so the ask does not move', () => {
  assert.equal(nextBlockCap(null, { unexecutable: true, blocks: 1 }), null);
  assert.equal(nextBlockCap(1, { unexecutable: true, blocks: 1 }), 1);
});

test('a failure that is not a refusal leaves the ask alone', () => {
  assert.equal(nextBlockCap(4, { blocks: 4 }), 4);
  assert.equal(nextBlockCap(null, { blocks: 20 }), null);
});

test('a batch proved at the full ask raises it by one', () => {
  assert.equal(nextBlockCap(2, { proved: true, blocks: 2 }), 3);
  assert.equal(nextBlockCap(6, { proved: true, blocks: 6 }), 7);
});

test('a smaller job than the ask teaches nothing, and no ask stays no ask', () => {
  assert.equal(nextBlockCap(6, { proved: true, blocks: 2 }), 6);
  assert.equal(nextBlockCap(null, { proved: true, blocks: 20 }), null);
});

test('the ask is dropped once it reaches the ceiling', () => {
  assert.equal(nextBlockCap(BLOCK_CAP_MAX - 1, { proved: true, blocks: BLOCK_CAP_MAX - 1 }), null);
});

test('a refuse / grow sequence settles near the size the limit allows', () => {
  // A limit that fits 4 blocks: the ask halves from the API cap, then climbs until it is refused again.
  const fits = (n) => n <= 4;
  let cap = null, refused = 0;
  for (let i = 0; i < 40; i++) {
    const asked = cap ?? 20;
    if (fits(asked)) cap = nextBlockCap(cap ?? asked, { proved: true, blocks: asked });
    else { refused++; cap = nextBlockCap(cap, { unexecutable: true, blocks: asked }); }
  }
  assert.ok(cap === null || cap <= 5, `ask ended at ${cap}`);
  assert.ok(refused >= 1 && refused <= 14, `${refused} refusals in 40 cycles`);
});

test('isUnexecutable reads the network refusal off stderr and nothing else', () => {
  assert.equal(isUnexecutable("thread 'main' panicked at src/bin/bitcoin_prove.rs:105:98:\ngroth16 proof failed: Proof request 0xb50868ef5b0a is unexecutable"), true);
  assert.equal(isUnexecutable('groth16 proof failed: Proof request 0xabc is unfulfillable'), true);
  assert.equal(isUnexecutable('peak memory 861MB'), false);
  assert.equal(isUnexecutable('ENOENT: no such file or directory'), false);
  assert.equal(isUnexecutable(undefined), false);
});
