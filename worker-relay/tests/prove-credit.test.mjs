// The prover credit the relay reports and the monitor judges (src/lib/prove-credit.js).
//   node worker-relay/tests/prove-credit.test.mjs
import assert from 'node:assert/strict';
import { creditText, creditField, creditLevel } from '../src/lib/prove-credit.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

test('PROVE wei reads as whole PROVE with two decimals; an unknown credit stays unknown', () => {
  assert.equal(creditText(78_243_193_567_845_357_685n), '78.24');
  assert.equal(creditText(100n * 10n ** 18n), '100.00');
  assert.equal(creditText(0n), '0.00');
  assert.equal(creditText(null), null);
});

test('the API keeps only a plain decimal credit', () => {
  for (const ok of ['0', '78.24', '100', '213.7612']) assert.equal(creditField(ok), ok);
  for (const bad of [78.24, '-1', '1e3', '78.', '.5', '1,000', '78.24 PROVE', '1'.repeat(13), '', null, undefined, {}]) assert.equal(creditField(bad), null, String(bad));
});

const T = { warn: 20, critical: 5 };
test('under the warning line is a warning, under the critical line critical, and anything else is quiet', () => {
  assert.equal(creditLevel('20', T), null);
  assert.equal(creditLevel('78.24', T), null);
  assert.equal(creditLevel('19.99', T), 'warning');
  assert.equal(creditLevel('8.35', T), 'warning');
  assert.equal(creditLevel('5', T), 'warning');
  assert.equal(creditLevel('4.99', T), 'critical');
  assert.equal(creditLevel('0', T), 'critical');
});

test('a credit or threshold that does not read gives no verdict, so a broken read never pages', () => {
  assert.equal(creditLevel('abc', T), null);
  assert.equal(creditLevel(undefined, T), null);
  assert.equal(creditLevel('3', { warn: 0, critical: 5 }), null);
  assert.equal(creditLevel('3', { warn: NaN, critical: 5 }), null);
  assert.equal(creditLevel('3', { warn: 5, critical: 20 }), null);
  assert.equal(creditLevel('3'), null);
});

console.log(`\n${n} passed`);
