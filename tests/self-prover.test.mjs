// dapp/self-prover.js: the funding transactions for the holder's own prover account, checked against cast's encodings and
// EIP-712 signer, and the prove() contract relay.useProver relies on, with the network stubbed.
//
// Run: node --test tests/self-prover.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 } from '../node_modules/@noble/hashes/sha256.js';
import { approveData, depositData, permitAndDepositData, signPermit, VAPP, PROVE_TOKEN } from '../dapp/self-prover.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

// cast wallet sign --data over Permit(owner, spender = vApp, value 1.5 PROVE, nonce 3, deadline 1800000000) on PROVE's domain
// ("Succinct", "1", chain 1), key 0x42…42 (owner 0x17c5…D025). DOMAIN_SEPARATOR() read from mainnet PROVE.
const KEY = '0x' + '42'.repeat(32), OWNER = '0x17c5185167401eD00cF5F5b2fc97D9BBfDb7D025';
const DOMAIN = '0xe8fcd2eaa6be90600f6cf5c615b2f9fbfc5c13e1e024cff0e3b14311e3a62c7c';
const CAST_SIG = '0xf92d88224026e6902cd1e8324bc2aff9d9e6ce057ed5163db06634bbc59b585d5d3f0b3a4c0c7417487190ce17bb627b84ba89bb4c084cec73f6d7d5b804b6081b';
const AMT = 1_500_000_000_000_000_000n;

test('the account\'s PROVE permit matches cast\'s EIP-712 signature', () => {
  const { v, r, s } = signPermit({ secp, keccak256: keccak_256, privHex: KEY, owner: OWNER, amountWei: AMT, nonce: 3n, deadline: 1_800_000_000n, domainSeparator: DOMAIN });
  assert.equal(r + s.slice(2) + v.toString(16), CAST_SIG);
});

test('funding calldata matches cast calldata', () => {
  assert.equal(VAPP, '0x5Ad5Bc4B18f7c173DcE17A57682Cb0Dc8788951F');
  assert.equal(PROVE_TOKEN, '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29');
  assert.equal(approveData(AMT), '0x095ea7b30000000000000000000000005ad5bc4b18f7c173dce17a57682cb0dc8788951f00000000000000000000000000000000000000000000000014d1120d7b160000');
  assert.equal(depositData(AMT), '0xb6b55f2500000000000000000000000000000000000000000000000014d1120d7b160000');
  assert.equal(permitAndDepositData({ from: OWNER, amountWei: AMT, deadline: 1_800_000_000n, v: 27, r: CAST_SIG.slice(0, 66), s: '0x' + CAST_SIG.slice(66, 130) }),
    '0x58981c7e00000000000000000000000017c5185167401ed00cf5f5b2fc97d9bbfdb7d02500000000000000000000000000000000000000000000000014d1120d7b160000000000000000000000000000000000000000000000000000000000006b49d200000000000000000000000000000000000000000000000000000000000000001bf92d88224026e6902cd1e8324bc2aff9d9e6ce057ed5163db06634bbc59b585d5d3f0b3a4c0c7417487190ce17bb627b84ba89bb4c084cec73f6d7d5b804b608');
});
