// The creation code the splitter page deploys (dapp/splitter/bytecode.js) is the contract's, built the way contracts/foundry.toml builds
// it. This compiles contracts/src/EthSplitter.sol in a scratch Foundry project with those same settings and compares. Skipped (and says so)
// when `forge` or solady is not there: set CONTRACTS_LIB to a directory holding solady/ and forge-std/ (contracts/lib in a full checkout).
//
// Run: node tests/splitter-bytecode.test.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SPLITTER_INITCODE } from '../dapp/splitter/bytecode.js';

const here = new URL('..', import.meta.url).pathname;
const lib = [process.env.CONTRACTS_LIB, join(here, 'contracts/lib')].filter(Boolean).find((p) => existsSync(join(p, 'solady/src/auth/Ownable.sol')));
let forge = true;
try { execFileSync('forge', ['--version'], { stdio: 'ignore' }); } catch { forge = false; }
if (!forge || !lib) { console.log(`skipped: ${!forge ? 'forge is not installed' : 'solady not found (set CONTRACTS_LIB)'}`); process.exit(0); }

const src = readFileSync(join(here, 'contracts/src/EthSplitter.sol'), 'utf8');
const pragma = /pragma solidity (\S+);/.exec(src)?.[1];
const tomlText = readFileSync(join(here, 'contracts/foundry.toml'), 'utf8');
const setting = (k) => new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm').exec(tomlText)?.[1].trim();
const dir = mkdtempSync(join(tmpdir(), 'splitter-'));
try {
  mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'lib'));
  copyFileSync(join(here, 'contracts/src/EthSplitter.sol'), join(dir, 'src/EthSplitter.sol'));
  for (const l of ['solady', 'forge-std']) if (existsSync(join(lib, l))) symlinkSync(resolve(lib, l), join(dir, 'lib', l));
  writeFileSync(join(dir, 'foundry.toml'), `[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\nvia_ir = ${setting('via_ir')}\noptimizer = ${setting('optimizer')}\noptimizer_runs = ${setting('optimizer_runs')}\nbytecode_hash = ${setting('bytecode_hash')}\ncbor_metadata = ${setting('cbor_metadata')}\n`);
  execFileSync('forge', ['build', '--root', dir], { stdio: 'ignore' });
  const built = execFileSync('forge', ['inspect', '--root', dir, 'EthSplitter', 'bytecode'], { encoding: 'utf8' }).trim();
  const same = built.toLowerCase() === SPLITTER_INITCODE.toLowerCase();
  console.log(same ? `ok - the page's creation code is EthSplitter built with solc ${pragma} and the repo's settings (${(built.length - 2) / 2} bytes)` : 'FAIL - dapp/splitter/bytecode.js is not what contracts/src/EthSplitter.sol builds to; regenerate it');
  process.exit(same ? 0 : 1);
} finally { rmSync(dir, { recursive: true, force: true }); }
