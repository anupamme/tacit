#!/usr/bin/env node
// dapp/etch/minter.js: the creation code of FixedSupplyMinter (contracts/src/CanonicalMinters.sol), the contract the etch page deploys to make an Ethereum
// asset with a fixed supply. It is compiled with the settings the factory and the pool were built with (solc 0.8.36, via-IR, optimizer at 1 run, no
// metadata hash), which reproduce the live factory's bytecode byte for byte but for its three immutable slots. `--check` writes nothing and fails when
// the file is not what the source compiles to.
//   node tools/build-etch-minter.mjs [--check]        SOLC=<solc 0.8.36 binary> overrides where the compiler is looked for
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), CONTRACTS = join(ROOT, 'contracts'), OUT = join(ROOT, 'dapp', 'etch', 'minter.js');
const solc = process.env.SOLC || [join(homedir(), 'Library/Application Support/svm/0.8.36/solc-0.8.36'), join(homedir(), '.svm/0.8.36/solc-0.8.36')].find(existsSync);
if (!solc) { console.error('solc 0.8.36 not found: set SOLC to its path (forge installs it under svm)'); process.exit(2); }
if (!existsSync(join(CONTRACTS, 'lib/solady/src'))) { console.error('contracts/lib/solady is missing: link or install the contracts dependencies first'); process.exit(2); }

const out = execFileSync(solc, ['--via-ir', '--optimize', '--optimize-runs', '1', '--metadata-hash', 'none', '--no-cbor-metadata', '--base-path', CONTRACTS, '--allow-paths', CONTRACTS, '--bin',
  'solady/=lib/solady/src/', 'src/CanonicalMinters.sol'], { cwd: CONTRACTS, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });          // the vendored library's warnings go to stderr, and are not ours
const m = /======= src\/CanonicalMinters\.sol:FixedSupplyMinter =======\s*Binary:\s*([0-9a-f]+)/.exec(out);
if (!m) { console.error('FixedSupplyMinter was not in the compiler output'); process.exit(1); }
const want = `// Made by tools/build-etch-minter.mjs from contracts/src/CanonicalMinters.sol (solc 0.8.36, via-IR, optimizer 1 run, no metadata hash): edit the contract, not this.
// FixedSupplyMinter etches an Ethereum asset through the canonical factory and mints its whole supply to one address in its constructor, then does nothing
// ever again: no mint, no burn, no owner. Its constructor takes (address factory, address etcher, bytes32 salt, string symbol, uint8 decimals, bytes32 cid,
// uint256 totalSupply, address recipient).
export const FIXED_SUPPLY_MINTER_INIT = '0x${m[1]}';
`;
const have = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
if (process.argv.includes('--check')) {
  if (have !== want) { console.error('dapp/etch/minter.js is not what contracts/src/CanonicalMinters.sol compiles to: run tools/build-etch-minter.mjs'); process.exit(1); }
  console.log(`dapp/etch/minter.js is current (${m[1].length / 2} bytes of creation code)`);
} else {
  if (have !== want) writeFileSync(OUT, want);
  console.log(`dapp/etch/minter.js ${have === want ? 'is current' : 'written'} (${m[1].length / 2} bytes of creation code)`);
}
