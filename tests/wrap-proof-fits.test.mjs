// dapp/confidential-pool-ux.js wrapProofFits: a wrap's proof is used only when it consumes exactly this note's deposit and inserts exactly
// its leaf, so a prover elsewhere cannot hand back a valid proof of another pending deposit for the router to settle in this one's place.
// The case is a real mainnet wrap proved on a device and accepted by the live verifier (tests/fixtures/wrap-proof/).
//
// Run: node --test tests/wrap-proof-fits.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/wrap-proof/wrap.json', import.meta.url), 'utf8'));
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256: (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest()), network: 'mainnet', fetchImpl: async () => { throw new Error('offline'); } });
const built = { depositId: fx.depositId, leaf: fx.leaf };

test('the proof of this wrap fits it', () => {
  assert.equal(ux.wrapProofFits(built, { publicValues: fx.publicValues }), true);
});

test('a proof of another deposit, or of another leaf, does not', () => {
  const flip = (h) => h.slice(0, -1) + (h.at(-1) === '0' ? '1' : '0');
  assert.equal(ux.wrapProofFits({ ...built, depositId: flip(fx.depositId) }, { publicValues: fx.publicValues }), false);
  assert.equal(ux.wrapProofFits({ ...built, leaf: flip(fx.leaf) }, { publicValues: fx.publicValues }), false);
  const pv = fx.publicValues.toLowerCase().replace(fx.depositId.slice(2).toLowerCase(), flip(fx.depositId.slice(2).toLowerCase()));
  assert.equal(ux.wrapProofFits(built, { publicValues: pv }), false);
});

test('anything that is not PublicValues does not', () => {
  for (const publicValues of ['0x', '0x' + '01'.repeat(32), 'nonsense', null]) assert.equal(ux.wrapProofFits(built, { publicValues }), false);
});
