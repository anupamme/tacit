// The line under a bonded cBTC lock that is waiting on the reflection: where its block is, how many Bitcoin blocks remain, and an
// honest fallback when the page could not read Bitcoin. node --test tests/lock-wait-text.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { lockWaitText, LOCK_FOLD_DEPTH } from '../dapp/confidential-defi-tab.js';

test('the fold depth is the 24 confirmations the reflection asks plus the two blocks the relay trails the tip by', () => {
  assert.equal(LOCK_FOLD_DEPTH, 26);
});

test('a lock in a block names it, the blocks and the hours left, then a few minutes for the proof', () => {
  const t = lockWaitText({ attested: 971271, lock: { height: 971295, tip: 971306 } });   // 971295 + 26 - 971306 = 15 blocks
  assert.match(t, /Your lock is in Bitcoin block 971295/);
  assert.match(t, /about 15 more Bitcoin blocks \(about 2\.5 hours\)/);
  assert.match(t, /a few minutes for the proof/);
});

test('short waits are in minutes, one block is singular, and the hours read without a trailing zero', () => {
  assert.match(lockWaitText({ lock: { height: 100, tip: 119 } }), /about 7 more Bitcoin blocks \(about 70 minutes\)/);
  assert.match(lockWaitText({ lock: { height: 100, tip: 125 } }), /about 1 more Bitcoin block \(about 10 minutes\)/);
  assert.match(lockWaitText({ lock: { height: 100, tip: 98 } }), /about 28 more Bitcoin blocks \(about 4\.7 hours\)/);
  assert.match(lockWaitText({ lock: { height: 100, tip: 56 } }), /about 70 more Bitcoin blocks \(about 11\.7 hours\)/);
  assert.match(lockWaitText({ lock: { height: 100, tip: 66 } }), /about 60 more Bitcoin blocks \(about 10 hours\)/);
});

test('a lock deep enough is being folded; an unconfirmed one waits for Bitcoin', () => {
  assert.match(lockWaitText({ lock: { height: 100, tip: 126 } }), /deep enough now: the reflection is folding it/);
  assert.match(lockWaitText({ lock: { height: 100, tip: 400 } }), /deep enough now/);
  assert.match(lockWaitText({ lock: { height: null, tip: 500 } }), /Waiting for the lock to confirm on Bitcoin/);
});

test('without a Bitcoin reading the line is the plain one, with where the reflection is when that is known', () => {
  assert.equal(lockWaitText({ attested: 971271, lock: null }), 'Bonded. Minting opens once the reflection records this lock (it has reached Bitcoin block 971271).');
  assert.equal(lockWaitText({ attested: null, lock: null }), 'Bonded. Minting opens once the reflection records this lock.');
  assert.equal(lockWaitText({ lock: { height: 100, tip: NaN } }), 'Bonded. Minting opens once the reflection records this lock.');
});
