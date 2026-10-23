// Which pending bridge burns still lack a registered proof bundle (worker/src/pending-burns.js).
// node tests/pending-burns.test.mjs
import assert from 'node:assert/strict';
import { burnsAwaitingBundle } from '../worker/src/pending-burns.js';

const rec = (id, height, completed = false) => ({ burnTxidDisplay: id, height, completed });
let n = 0; const ok = (label, fn) => { fn(); n++; console.log('  PASS ', label); };

ok('only open records without a bundle count, and the oldest height is reported', () => {
  const r = burnsAwaitingBundle([rec('0xAA', 10), rec('bb', 5), rec('cc', 7, true), rec('dd', 20)], ['bb', '0xdd']);
  assert.deepEqual(r, { count: 1, oldestHeight: 10 });
});
ok('the case and 0x prefix of a registered txid do not matter', () => {
  assert.equal(burnsAwaitingBundle([rec('0xABCD', 3)], ['abcd']).count, 0);
  assert.equal(burnsAwaitingBundle([rec('abcd', 3)], new Set(['0xABCD'])).count, 0);
});
ok('nothing awaiting gives a zero count and no height', () => {
  assert.deepEqual(burnsAwaitingBundle([rec('aa', 1, true)], []), { count: 0, oldestHeight: null });
  assert.deepEqual(burnsAwaitingBundle([], []), { count: 0, oldestHeight: null });
});
ok('missing or malformed input is read as nothing pending', () => {
  assert.deepEqual(burnsAwaitingBundle(undefined, undefined), { count: 0, oldestHeight: null });
  assert.deepEqual(burnsAwaitingBundle([null, {}, { completed: false }], []), { count: 0, oldestHeight: null });
});
ok('a record with no readable height still counts, without moving the oldest height', () => {
  const r = burnsAwaitingBundle([rec('aa', undefined), rec('bb', 9)], []);
  assert.deepEqual(r, { count: 2, oldestHeight: 9 });
});
console.log(`\n${n} passed`);
