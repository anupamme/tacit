// Range proofs checked together (bpRangeVerifyBatch, bppRangeVerifyBatch) must say what checking them one by one says: accept a set
// of proofs that all hold, refuse a set holding any that does not. The burn-deposit admission checks a history's proofs this way
// (dapp/burn-deposit-bitcoin.js verifiedHops), where one by one costs seconds a hop.
//   node --test tests/range-batch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bpRangeVerify, bpRangeVerifyBatch } from '../dapp/bulletproofs.js';
import * as bpp from '../dapp/bulletproofs-plus.js';

const here = dirname(fileURLToPath(import.meta.url));
const fxDir = join(here, '../contracts/sp1/confidential/fixtures/classic_bp');
const h2b = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const load = (name) => JSON.parse(readFileSync(join(fxDir, name), 'utf8'));
const item = (fx) => ({ commitments: fx.commitments.map(h2b), proof: h2b(fx.proof) });
const copy = (it) => ({ commitments: it.commitments.slice(), proof: Uint8Array.from(it.proof) });

const files = readdirSync(fxDir);
const valid = files.filter((f) => f.startsWith('valid_')).sort().map((f) => item(load(f)));
const tampered = files.filter((f) => f.startsWith('tamper_')).sort().map((f) => ({ name: f, ...item(load(f)) }));

test('classic: the fixtures that hold one by one hold together, whatever their sizes', () => {
  assert.ok(valid.length >= 12);
  for (const v of valid) assert.equal(bpRangeVerify(v.commitments, v.proof), true);
  assert.equal(bpRangeVerifyBatch(valid), true);
  assert.equal(bpRangeVerifyBatch([valid[0]]), true);
  assert.equal(bpRangeVerifyBatch([]), true);
});

test('classic: any one of the proofs failing refuses the set', () => {
  assert.ok(tampered.length >= 11);
  for (const t of tampered) {
    assert.equal(bpRangeVerifyBatch([t]), false, `${t.name} alone`);
    assert.equal(bpRangeVerifyBatch([...valid.slice(0, 3), t, ...valid.slice(3, 6)]), false, `${t.name} among valid proofs`);
  }
});

test('classic: a proof set to another proof’s commitments, a flipped byte in any part, or a short proof refuses the set', () => {
  const [a, b, c] = valid;
  assert.equal(bpRangeVerifyBatch([{ ...a, commitments: b.commitments.length === a.commitments.length ? b.commitments : a.commitments.slice().reverse() }, c]), false);
  for (const at of [0, 40, 100, 150, a.proof.length - 40, a.proof.length - 1]) {
    const bad = copy(a); bad.proof[at] ^= 1;
    assert.equal(bpRangeVerifyBatch([bad, b, c]), false, `byte ${at}`);
    assert.equal(bpRangeVerifyBatch([b, c, bad]), false, `byte ${at} last`);
  }
  const short = copy(a); short.proof = short.proof.slice(0, -1);
  assert.equal(bpRangeVerifyBatch([b, short]), false);
});

test('BP+: proofs of every size hold together, and any one failing refuses the set', () => {
  const items = [];
  for (const m of [1, 2, 4, 8, 2, 1]) {
    const values = [], blindings = [];
    for (let j = 0; j < m; j++) { values.push(BigInt(500 + 17 * j + m)); blindings.push(bpp.randomScalar()); }
    const { commitments, proof } = bpp.bppRangeProve(values, blindings);
    assert.equal(bpp.bppRangeVerify(commitments, proof), true);
    items.push({ commitments, proof });
  }
  assert.equal(bpp.bppRangeVerifyBatch(items), true);
  assert.equal(bpp.bppRangeVerifyBatch([items[3]]), true);
  assert.equal(bpp.bppRangeVerifyBatch([]), true);
  for (let k = 0; k < items.length; k++) {
    const bad = items.map(copy);
    bad[k].proof[100] ^= 1;
    assert.equal(bpp.bppRangeVerifyBatch(bad), false, `proof ${k} flipped`);
  }
  const other = items.map(copy);
  other[2] = { commitments: items[1].commitments, proof: items[2].proof };
  assert.equal(bpp.bppRangeVerifyBatch(other), false, 'a proof under another proof’s commitments');
});

test('BP+: a value out of range, proved anyway, refuses the set', () => {
  const ok = bpp.bppRangeProve([7n, 9n], [bpp.randomScalar(), bpp.randomScalar()]);
  const big = bpp.bppRangeProve([1n << 64n], [bpp.randomScalar()], true);
  assert.equal(bpp.bppRangeVerify(big.commitments, big.proof), false);
  assert.equal(bpp.bppRangeVerifyBatch([ok, big]), false);
});
