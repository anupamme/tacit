// node --test tests/prove-floor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXIT_TYPES, proveFloorWei } from '../src/lib/prove-floor.js';

const P = (n) => BigInt(n) * 10n ** 18n;
const floors = { reserveWei: P(40), exitWei: P(20) };

test('the exits are held to the lower floor, everything else to the full reserve', () => {
  assert.equal(proveFloorWei('unwrap', floors), P(20));
  assert.equal(proveFloorWei('sendunwrap', floors), P(20));
  for (const t of ['wrap', 'transfer', 'swap', 'wraptransfer', 'farmharvest', 'bridgemint', undefined]) assert.equal(proveFloorWei(t, floors), P(40), String(t));
});

test('the exit floor is never above the reserve, and a reserve of zero holds nothing', () => {
  assert.equal(proveFloorWei('unwrap', { reserveWei: P(10), exitWei: P(20) }), P(10));
  assert.equal(proveFloorWei('unwrap', { reserveWei: 0n, exitWei: P(20) }), 0n);
  assert.equal(proveFloorWei('unwrap', { reserveWei: P(40), exitWei: 0n }), 0n);
});

test('the API and the relay name the same exit types', () => {
  const api = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../worker/src/index.js'), 'utf8');
  const m = /\[((?:'[a-z]+',?\s*)+)\]\.includes\(body\.type\) && Number\.isFinite\(exitMin\)/.exec(api);
  assert.ok(m, 'the API no longer tests the exit types where the prove-mode reserve is applied');
  const types = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(types.sort(), [...EXIT_TYPES].sort());
});
