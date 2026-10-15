#!/usr/bin/env node
// Prints the `forge verify-contract` commands for the deployed TAC vaults, from the manifest. Nothing is sent.
//
//   node tools/tac-vaults-etherscan.mjs [contracts/deployments/tac-vaults.json]   (run the output from contracts/)
//
// The vault family is built with solc 0.8.37 and the pool and router with 0.8.36; both with via-IR, optimizer runs 1,
// EVM prague. Set ETHERSCAN_API_KEY.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(process.argv[2] || join(ROOT, 'contracts/deployments/tac-vaults.json'), 'utf8'));
const FILE = { TacitEvmPool: 'TacitEvmPool', TacitEvmPoolRouter: 'TacitEvmPoolRouter' };
for (const c of manifest.contracts) {
  const old = c.contract in FILE;
  console.log(`forge verify-contract ${c.address} src/${c.contract}.sol:${c.contract} --chain mainnet --verifier etherscan --compiler-version ${old ? '0.8.36' : '0.8.37'} --num-of-optimizations 1 --via-ir --evm-version prague --constructor-args ${c.constructorArgs} --watch   # ${c.name}`);
}
