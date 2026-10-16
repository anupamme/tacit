// dapp/verify.html's Ethereum constants against the repository: its selectors are the keccak of the signatures they
// name, its token, pool and wTAC addresses are the deployment's, and its code pin is the SHA-256 of the
// CanonicalBridgedERC20 build with the build's own immutable ranges zeroed (when contracts/out is built).
//
// Run: node tests/verify-page-pins.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';

const ROOT = new URL('..', import.meta.url).pathname;
const page = readFileSync(ROOT + 'dapp/verify.html', 'utf8');
const constant = (name) => {
  const m = page.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(m, `verify.html defines ${name}`);
  return Function(`return (${m[1]});`)();
};
let n = 0;
const ok = (label) => { console.log(`  ok - ${label}`); n++; };

const SEL = constant('SEL');
const SIGS = { minter: 'MINTER()', assetId: 'ASSET_ID()', decimals: 'decimals()', totalSupply: 'totalSupply()', balanceOf: 'balanceOf(address)', canonicalTokenFor: 'canonicalTokenFor(bytes32)', assets: 'assets(bytes32)', wtacTac: 'TAC()' };
for (const [k, sig] of Object.entries(SIGS)) assert.equal(SEL[k], Buffer.from(keccak_256(Buffer.from(sig))).toString('hex').slice(0, 8), sig);
assert.deepEqual(Object.keys(SEL).sort(), Object.keys(SIGS).sort());
ok('every selector is the keccak of its signature');

const manifest = JSON.parse(readFileSync(ROOT + 'contracts/deployments/1.json', 'utf8'));
assert.equal(constant('TAC_TOKEN'), manifest.tacToken.toLowerCase());
assert.equal(constant('TAC_POOL'), manifest.pool.toLowerCase());
assert.equal(constant('CANON_ASSET_ID'), manifest.tacAssetId.replace(/^0x/, '').toLowerCase());
const deployments = readFileSync(ROOT + 'docs/DEPLOYMENTS.md', 'utf8');
assert.match(deployments, new RegExp(`WrappedTac[^\\n]*${constant('WTAC')}`, 'i'), 'wTAC is the address docs/DEPLOYMENTS.md lists');
ok('the token, pool, asset id and wTAC are the deployment\'s');

const artifact = ROOT + 'contracts/out/CanonicalBridgedERC20.sol/CanonicalBridgedERC20.json';
if (existsSync(artifact)) {
  const built = JSON.parse(readFileSync(artifact, 'utf8')).deployedBytecode;
  const refs = Object.values(built.immutableReferences).flat().map((r) => [r.start, r.length]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(constant('TOKEN_IMMUTABLES'), refs, 'immutable ranges are the build\'s');
  const code = Buffer.from(built.object.replace(/^0x/, ''), 'hex');
  for (const [start, len] of refs) code.fill(0, start, start + len);
  assert.equal(constant('TOKEN_CODE_SHA256'), createHash('sha256').update(code).digest('hex'));
  ok('the code pin is the build of CanonicalBridgedERC20 with its immutables zeroed');
} else {
  console.log('  skip - contracts/out is not built (cd contracts && forge build) — code pin not compared');
}

console.log(`\n${n} verify-page pin checks passed`);
