// dapp/etch/minter.js is what contracts/src/CanonicalMinters.sol compiles to (solc 0.8.36, the settings the factory and the pool were built with). Skipped, and
// said so, where the compiler or the contracts' dependencies are not installed.
//   node tests/etch-minter.test.mjs
import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, [new URL('../tools/build-etch-minter.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
if (r.status === 2) { console.log(`  SKIP  ${r.stderr.trim()}`); process.exit(0); }
console.log(`  ${r.status === 0 ? 'PASS' : 'FAIL'}  ${(r.stdout + r.stderr).trim()}`);
process.exit(r.status === 0 ? 0 : 1);
