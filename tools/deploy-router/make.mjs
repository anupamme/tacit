#!/usr/bin/env node
// Writes the router's init code (the compiled creation code from Foundry's artifact plus the two vaults as constructor arguments) and its hash into
// index.html, between the INIT markers. Build the router first, with the project's settings:  cd contracts && forge build
//   node tools/deploy-router/make.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('../../', import.meta.url).pathname;
const art = JSON.parse(readFileSync(`${root}contracts/out/TacVaultRouter.sol/TacVaultRouter.json`, 'utf8'));
const dep = readFileSync(`${root}contracts/script/TacVaultsDeployment.sol`, 'utf8');
const addr = (name) => new RegExp(`${name} = (0x[0-9a-fA-F]{40});`).exec(dep)?.[1];
const [usd, eth, tac, createx] = ['USD_VAULT', 'ETH_VAULT', 'TAC', 'CREATEX'].map(addr);
if (!usd || !eth || !tac || !createx) throw new Error('an address is missing from contracts/script/TacVaultsDeployment.sol');
const word = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const init = art.bytecode.object + word(usd) + word(eth);
const hash = execFileSync('cast', ['keccak', init], { encoding: 'utf8' }).trim();
const page = `${root}tools/deploy-router/index.html`;
let html = readFileSync(page, 'utf8');
const block = `/* INIT:begin */
const CREATE_X = '${createx}';
const VAULT_A = '${usd}', VAULT_B = '${eth}';
const TAC = '${tac}';
const INIT_CODE = '${init}';
const EXPECTED_INIT_HASH = '${hash}';
/* INIT:end */`;
html = html.replace(/\/\* INIT:begin \*\/[\s\S]*?\/\* INIT:end \*\//, () => block);
writeFileSync(page, html);
console.log(`init code ${(init.length - 2) / 2} bytes, hash ${hash}`);
