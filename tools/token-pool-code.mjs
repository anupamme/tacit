#!/usr/bin/env node
// Writes dapp/evm-pool/token-pool-code.json: the creation code of TacitEvmPool and TacitEvmPoolRouter as the live pools were built (solc
// 0.8.36, the repo's default profile), which dapp/evm-pool-tokens.js derives every token's pool and router address from and opens them with.
// It is written only if it rebuilds the live TAC pool's and TAC router's init-code hashes exactly (contracts/script/TacVaultsDeployment.sol).
//
//   (cd contracts && forge build src/TacitEvmPool.sol src/TacitEvmPoolRouter.sol) && node tools/token-pool-code.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { keccak256, encodeAbiParameters, concat } = require('viem');
const out = (p) => JSON.parse(readFileSync(new URL(`../contracts/out/${p}`, import.meta.url), 'utf8'));
const pool = out('TacitEvmPool.sol/TacitEvmPool.json').bytecode.object, router = out('TacitEvmPoolRouter.sol/TacitEvmPoolRouter.json').bytecode.object;
const addrs = (xs) => encodeAbiParameters(xs.map(() => ({ type: 'address' })), xs);
// the live TAC pool and router: their constructor arguments and init-code hashes (TacVaultsDeployment.sol SALT/HASH_TAC_POOL, _ROUTER)
const VERIFIER = '0x000000b1c0e84CEc8AdF8278B90c4d6400DfB153', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', TAC_POOL = '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe';
const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3', V1 = '0x000000000Ed1eabD231Be41d93b719056F7febFC', POSEIDON4 = '0x555333f3f677Ca3930Bf7c56ffc75144c51D9767';
const HASH_TAC_POOL = '0x68a0d4470a94c14908bf8d39640bbbf3d162170e4d13b701ca4950c262d4e0e6', HASH_TAC_ROUTER = '0x3f00ebf57de7a9e0332b26782fb5f47f1336471784affa8434231fbf126c80a2';
const ph = keccak256(concat([pool, addrs([VERIFIER, TAC])])), rh = keccak256(concat([router, addrs([TAC_POOL, ZROUTER, PERMIT2, V1, POSEIDON4])]));
if (ph !== HASH_TAC_POOL || rh !== HASH_TAC_ROUTER) { console.error(`the built code does not rebuild the live TAC pool (${ph}) and router (${rh}): build with the pinned compiler`); process.exit(1); }
const file = new URL('../dapp/evm-pool/token-pool-code.json', import.meta.url);
writeFileSync(file, JSON.stringify({ pool, router, check: { asset: TAC, poolInitHash: HASH_TAC_POOL, pool: TAC_POOL, routerInitHash: HASH_TAC_ROUTER } }) + '\n');
console.log(`wrote ${file.pathname}: pool ${(pool.length - 2) / 2} B, router ${(router.length - 2) / 2} B of creation code; both rebuild the live TAC contracts`);
