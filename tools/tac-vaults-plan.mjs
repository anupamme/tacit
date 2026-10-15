#!/usr/bin/env node
// Plans the public TAC vaults deployment: builds every contract's init code, mines a CreateX CREATE2 salt for each
// that puts it at an address with leading zero bytes, and writes what anyone needs to deploy exactly this system.
//
//   node tools/tac-vaults-plan.mjs [--out contracts/out] [--config contracts/deployments/tac-vaults.config.json]
//                                  [--miner tools/vanity-create2/target/release/vanity-create2] [--payload <file>] [--force]
//
// A contract whose init code hash is the one already in the manifest keeps its salt and address, so planning again
// changes nothing unless a contract or a setting changed; --force mines everything afresh.
//
// Each contract is deployed with CreateX.deployCreate2(salt, initCode) and a salt tied to the chain (20 zero bytes, then
// 0x01) but not to a sender, so anyone may send the transactions. The address is
// CREATE2(CreateX, keccak256(abi.encode(chainId, salt)), keccak256(initCode)): it commits to the init code, constructor
// arguments included, so only this exact system can land at these addresses, and only on this chain. Later contracts take
// earlier addresses as arguments, so they are mined in order, and a change to the config or the code mines again.
//
// Writes contracts/deployments/tac-vaults.json (the manifest), contracts/script/TacVaultsDeployment.sol (the same
// constants for the deploy script) and, with --payload, the transactions with their init code and calldata.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(opt('--out', join(ROOT, 'contracts/out')));
const CONFIG = resolve(opt('--config', join(ROOT, 'contracts/deployments/tac-vaults.config.json')));
const MINER = resolve(opt('--miner', join(ROOT, 'tools/vanity-create2/target/release/vanity-create2')));
const PAYLOAD = opt('--payload', null);
const FORCE = argv.includes('--force');
const MANIFEST = join(ROOT, 'contracts/deployments/tac-vaults.json');

const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
const X = cfg.external, O = cfg.oracle, V = cfg.vault;
const owner = cfg.owner, feeTo = cfg.feeTo || owner, tacSink = cfg.tacSink || owner;
const MAX = (1n << 256n) - 1n;

const creation = (file, name) => {
  const j = JSON.parse(readFileSync(join(OUT, `${file}.sol`, `${name}.json`), 'utf8'));
  return j.bytecode.object.replace(/^0x/, '');
};
const encode = (sig, ...args) => cast('abi-encode', sig, ...args.map(String)).replace(/^0x/, '');

const vaultSig = 'f((address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address,string,string))';
const vaultArgs = (v, oracle, feed) => `(${X.tac},${oracle},${feed},${owner},${V.mintRatioBps},${V.liqRatioBps},${V.liqBonusBps},${V.auctionDuration},${V.ownerWindow},${v.minDebt},${V.feedMaxStaleness},${V.debtCeiling ?? MAX},${V.depthBps},${V.redemptionFeeBps},${V.borrowFeeBps},${feeTo},${tacSink},${v.name},${v.symbol})`;

let previous = [];
try { previous = JSON.parse(readFileSync(MANIFEST, 'utf8')).contracts; } catch {}
const found = new Map(); // name -> { address, salt, ... }
const steps = [];
const addr = (n) => found.get(n).address;

function plan(name, contract, file, argsHex) {
  const initCode = creation(file, contract) + argsHex;
  const initHash = cast('keccak', '0x' + initCode);
  const kept = FORCE ? null : previous.find((p) => p.name === name && p.initCodeHash === initHash && p.address.startsWith('0x' + '00'.repeat(cfg.zeroBytes)));
  const raw = kept ? JSON.stringify({ salt: kept.salt, address: kept.address })
    : execFileSync(MINER, ['mine', '--factory', cfg.factory, '--init-hash', initHash, '--chain-id', '1', '--zeros', String(cfg.zeroBytes), '--tag', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (kept) console.error(`${name.padEnd(22)} ${kept.address} (kept)`);
  const { salt, address } = JSON.parse(raw);
  const back = execFileSync(MINER, ['address', '--factory', cfg.factory, '--init-hash', initHash, '--chain-id', '1', '--salt', salt], { encoding: 'utf8' }).trim();
  if (back !== address) throw new Error(`${name}: the miner disagrees with itself`);
  const row = { name, contract, address, salt, initCodeHash: initHash, constructorArgs: '0x' + argsHex, initCode };
  found.set(name, row);
  steps.push(row);
  return row;
}

// 1-4: the oracles and the ETH feed take only constants.
plan('PRECISION_ORACLE', 'TacBlockOracle', 'TacBlockOracle', encode('f(address,address,uint256,uint256,uint256,uint256,uint256)', X.precisionPool, X.tac, O.step, O.shortWindow, O.window, O.maxWindow, O.coverageBps));
plan('AMM_ORACLE', 'TacAmmOracle', 'TacAmmOracle', encode('f(address,bytes32,bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint256)', X.confidentialPool, X.ammPoolId, X.ethAsset, X.tacAsset, X.tac, X.poolsSlot, O.step, O.shortWindow, O.window, O.maxWindow, O.coverageBps));
plan('PAIR_ORACLE', 'TacPairOracle', 'TacPairOracle', encode('f(address,address)', addr('PRECISION_ORACLE'), addr('AMM_ORACLE')));
plan('ETH_FEED', 'FixedFeed', 'FixedFeed', '');
// 5-6: the vaults; a synth is the vault's first CREATE.
plan('USD_VAULT', 'TacVault', 'TacVault', encode(vaultSig, vaultArgs(cfg.usd, addr('PAIR_ORACLE'), X.ethUsd)));
plan('ETH_VAULT', 'TacVault', 'TacVault', encode(vaultSig, vaultArgs(cfg.eth, addr('PAIR_ORACLE'), addr('ETH_FEED'))));
const synth = { USD: cast('compute-address', addr('USD_VAULT'), '--nonce', '1').split(': ').pop(), ETH: cast('compute-address', addr('ETH_VAULT'), '--nonce', '1').split(': ').pop() };
// 7-12: a pool and router for TAC and for each synth.
const poolArgs = (asset) => encode('f(address,address)', X.verifier, asset);
const routerArgs = (pool) => encode('f(address,address,address,address,address)', pool, X.zRouter, X.permit2, X.confidentialPool, X.poseidon4);
for (const [tag, asset] of [['TAC', X.tac], ['USD', synth.USD], ['ETH', synth.ETH]]) {
  plan(`${tag}_POOL`, 'TacitEvmPool', 'TacitEvmPool', poolArgs(asset));
  plan(`${tag}_ROUTER`, 'TacitEvmPoolRouter', 'TacitEvmPoolRouter', routerArgs(addr(`${tag}_POOL`)));
}
// 13-14: the zaps.
plan('USD_ZAP', 'TacVaultZap', 'TacVaultZap', encode('f(address,address)', addr('USD_VAULT'), addr('USD_ROUTER')));
plan('ETH_ZAP', 'TacVaultZap', 'TacVaultZap', encode('f(address,address)', addr('ETH_VAULT'), addr('ETH_ROUTER')));

// The synths' ids in the confidential pool: sha256("tacit-evm-token-v1", uint64 chainid, token).
const assetId = (token) => '0x' + execFileSync('python3', ['-c', 'import hashlib,sys;print(hashlib.sha256(b"tacit-evm-token-v1"+(1).to_bytes(8,"big")+bytes.fromhex(sys.argv[1][2:])).hexdigest())', token], { encoding: 'utf8' }).trim();
const ids = { USD: assetId(synth.USD), ETH: assetId(synth.ETH) };
const pairs = [[X.tacAsset, ids.USD], [X.tacAsset, ids.ETH], [X.ethAsset, ids.ETH], [ids.USD, ids.ETH], [ids.USD, X.cusdAsset]];

const manifest = {
  factory: cfg.factory,
  zeroBytes: cfg.zeroBytes,
  owner, feeTo, tacSink,
  contracts: steps.map(({ name, contract, address, salt, initCodeHash, constructorArgs }) => ({ name, contract, address, salt, initCodeHash, constructorArgs })),
  synths: { USD: synth.USD, ETH: synth.ETH },
  confidentialPool: { assets: ids, pairs },
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

// The same constants for the deploy script. It rebuilds each init code from the compiled contracts and these values and
// refuses to send one whose hash or address differs.
const L = [];
L.push('// SPDX-License-Identifier: MIT', 'pragma solidity ^0.8.28;', '', '// Generated by tools/tac-vaults-plan.mjs from contracts/deployments/tac-vaults.config.json. Do not edit.', 'library TacVaultsDeployment {');
L.push(`    address internal constant CREATEX = ${cfg.factory};`, `    address internal constant OWNER = ${owner};`, `    address internal constant FEE_TO = ${feeTo};`, `    address internal constant TAC_SINK = ${tacSink};`);
for (const [k, v] of Object.entries({ TAC: X.tac, PRECISION_POOL: X.precisionPool, CONFIDENTIAL_POOL: X.confidentialPool, ETH_USD: X.ethUsd, VERIFIER: X.verifier, ZROUTER: X.zRouter, PERMIT2: X.permit2, POSEIDON4: X.poseidon4 })) L.push(`    address internal constant ${k} = ${v};`);
for (const [k, v] of Object.entries({ AMM_POOL_ID: X.ammPoolId, ETH_ASSET: X.ethAsset, TAC_ASSET: X.tacAsset, CUSD_ASSET: X.cusdAsset })) L.push(`    bytes32 internal constant ${k} = ${v};`);
L.push(`    uint256 internal constant POOLS_SLOT = ${X.poolsSlot};`);
for (const [k, v] of Object.entries({ ORACLE_STEP: O.step, ORACLE_SHORT_WINDOW: O.shortWindow, ORACLE_WINDOW: O.window, ORACLE_MAX_WINDOW: O.maxWindow, ORACLE_COVERAGE_BPS: O.coverageBps, MINT_RATIO_BPS: V.mintRatioBps, LIQ_RATIO_BPS: V.liqRatioBps, LIQ_BONUS_BPS: V.liqBonusBps, AUCTION_DURATION: V.auctionDuration, OWNER_WINDOW: V.ownerWindow, FEED_MAX_STALENESS: V.feedMaxStaleness, DEPTH_BPS: V.depthBps, REDEMPTION_FEE_BPS: V.redemptionFeeBps, BORROW_FEE_BPS: V.borrowFeeBps, USD_MIN_DEBT: cfg.usd.minDebt, ETH_MIN_DEBT: cfg.eth.minDebt })) L.push(`    uint256 internal constant ${k} = ${v};`);
L.push(`    uint256 internal constant DEBT_CEILING = ${V.debtCeiling ?? 'type(uint256).max'};`);
L.push(`    string internal constant USD_NAME = "${cfg.usd.name}";`, `    string internal constant USD_SYMBOL = "${cfg.usd.symbol}";`, `    string internal constant ETH_NAME = "${cfg.eth.name}";`, `    string internal constant ETH_SYMBOL = "${cfg.eth.symbol}";`);
for (const s of steps) {
  L.push(`    bytes32 internal constant SALT_${s.name} = ${s.salt};`, `    bytes32 internal constant HASH_${s.name} = ${s.initCodeHash};`, `    address internal constant ${s.name} = ${s.address};`);
}
L.push('}', '');
const LIB = join(ROOT, 'contracts/script/TacVaultsDeployment.sol');
writeFileSync(LIB, L.join('\n'));
execFileSync('forge', ['fmt', LIB], { stdio: 'ignore' });

if (PAYLOAD) {
  const iface = ['function deployCreate2(bytes32 salt, bytes initCode) returns (address)'];
  void iface;
  const txs = steps.map((s, i) => ({
    step: i + 1, name: s.name, contract: s.contract, to: cfg.factory, value: '0x0',
    data: cast('calldata', 'deployCreate2(bytes32,bytes)', s.salt, '0x' + s.initCode),
    expectedAddress: s.address, initCodeHash: s.initCodeHash,
  }));
  const reg = [
    ...['USD', 'ETH'].map((t) => ({ name: `REGISTER_${t}`, to: X.confidentialPool, data: cast('calldata', 'registerWrappedAuto(address,bytes32)', synth[t], '0x' + '00'.repeat(32)), skipIf: `assets(${ids[t]}) is registered` })),
    ...pairs.map((p, i) => ({ name: `PAIR_${i + 1}`, to: X.confidentialPool, data: cast('calldata', 'createPair(bytes32,bytes32,uint32,uint8,bytes32,uint32)', p[0], p[1], '30', '0', '0x' + '00'.repeat(32), '0'), skipIf: 'the pair exists' })),
  ];
  mkdirSync(dirname(resolve(PAYLOAD)), { recursive: true });
  writeFileSync(PAYLOAD, JSON.stringify({ chainId: 1, factory: cfg.factory, deployments: txs, registry: reg }, null, 1) + '\n');
}

console.log(`\n${steps.length} contracts, ${cfg.zeroBytes} leading zero bytes`);
for (const s of steps) console.log(`  ${s.name.padEnd(18)} ${s.address}`);
console.log(`  USD synth          ${synth.USD}\n  ETH synth          ${synth.ETH}`);
