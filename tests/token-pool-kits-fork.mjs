#!/usr/bin/env node
// The token pool kits (tools/token-pool-kits.mjs → dapp/admin/token-pools/kits.json) on forks of their chains. Each kit's opening
// transaction, sent as the admin page sends it, puts the pool and router where the kit says, built as that chain's live ETH router is
// (its zRouter, Permit2, V1 and Poseidon); a half-open kit (the pool alone, sent as CreateX's first step) opens with its router-only
// transaction to the same code. Then a deposit into each new pool from a fresh wallet: by the token's EIP-2612 permit where it has one,
// through Permit2 where it does not, proved for real, the router holding no allowance from it before or after.
//
//   node tests/token-pool-kits-fork.mjs [chainId …]      (FORK_<chainId>: the node to fork; it must serve the state of a recent block)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { join } from 'node:path';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const snarkjs = require('snarkjs');
const { privateKeyToAccount } = require('viem/accounts');
const { parseSignature } = require('viem');
const { keccak_256 } = await import('@noble/hashes/sha3');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc, routerDeposit } = await import('../dapp/evm-pool-wallet.js');
const { makeEvmPoolZk } = await import('../dapp/evm-pool-zk.js');
const { makeTokenPools, poolState, TOKEN_POOL_CHAINS, PERMIT2 } = await import('../dapp/evm-pool-tokens.js');
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');

const ROOT = new URL('../', import.meta.url).pathname;
const KITS = JSON.parse(readFileSync(join(ROOT, 'dapp/admin/token-pools/kits.json'), 'utf8'));
const FORKS = { 1: 'https://mainnet.gateway.tenderly.co', 8453: 'https://base.gateway.tenderly.co', 4663: 'https://rpc.mainnet.chain.robinhood.com' };
const ETH_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const chains = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [1, 8453, 4663];
const user = privateKeyToAccount('0x' + 'b7'.repeat(32)), USER = user.address;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (v) => '0x' + BigInt(v).toString(16);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const lc = (s) => String(s).toLowerCase();
const sel = (s) => '0x' + Array.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4), (x) => x.toString(16).padStart(2, '0')).join('');
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };

const code = JSON.parse(readFileSync(join(ROOT, 'dapp/evm-pool/token-pool-code.json'), 'utf8'));
const Pz = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => Pz[xs.length](xs) });
const ART = join(ROOT, 'dapp/evm-pool/'), wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const prove = (input) => proveTransact(input, { wasm, zkey, snarkjs });

let anvil = null;
process.on('exit', () => { anvil?.kill('SIGKILL'); });

for (const chainId of chains) {
  const kits = KITS.kits.filter((k) => k.chainId === chainId);
  if (!kits.length) continue;
  console.log(`\n${KITS.chains[chainId].name} (${chainId})`);
  const FORK = process.env[`FORK_${chainId}`] || FORKS[chainId];
  const PORT = 26100 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`;
  const rpcA = (m, p = []) => post(RPC, m, p);
  const head = BigInt(await post(FORK, 'eth_blockNumber', [])) - 2n;
  anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', String(chainId), '--silent', '--gas-limit', '300000000', '--no-rate-limit', '--block-time', '1'], { stdio: 'ignore' });
  for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
  await rpcA('anvil_setBalance', [USER, hx(10n ** 18n)]);
  await rpcA('anvil_impersonateAccount', [USER]);
  const receipt = async (h) => { for (let i = 0; i < 600; i++) { const r = await rpcA('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(100); } return null; };
  const send = async (tx) => receipt(await rpcA('eth_sendTransaction', [{ from: USER, to: tx.to, data: tx.data, value: hx(tx.value || 0), gas: hx(tx.gas || 8_000_000) }]));
  const view = async (to, data) => rpcA('eth_call', [{ to, data }, 'latest']);
  const word = async (to, sig, args = '') => '0x' + (await view(to, sel(sig) + args)).slice(-40);
  const uint = async (to, sig, args = '') => BigInt(await view(to, sel(sig) + args));
  const codeAt = (a) => rpcA('eth_getCode', [a, 'latest']);
  const tp = makeTokenPools({ code, keccak256: keccak_256, chain: TOKEN_POOL_CHAINS[chainId] });
  const ethCall = (to, data) => view(to, data);
  // what this chain's live ETH router was built with, which every token router here must match
  const live = {};
  for (const f of ['ZROUTER()', 'PERMIT2()', 'V1()', 'POSEIDON4()', 'boxImpl()']) live[f] = await word(ETH_ROUTER, f);
  const liveRouterCode = await codeAt(ETH_ROUTER), liveBoxCode = await codeAt(live['boxImpl()']);

  for (const kit of kits) {
    const tag = `${kit.sym}:`;
    const p = tp.poolOf(kit.token);
    ok(p.pool === kit.pool && p.router === kit.router, `${tag} the kit's pool and router are the ones the salts give it (${kit.pool}, ${kit.router})`);
    ok((await codeAt(kit.pool)) === '0x' && (await codeAt(kit.router)) === '0x', `${tag} neither is on chain before the kit is sent`);
    // the one transaction, as the page sends it
    const snap = await rpcA('evm_snapshot');
    const ro = await send(kit.open);
    const opened = { pool: await codeAt(kit.pool), router: await codeAt(kit.router) };
    ok(ro?.status === '0x1' && JSON.stringify(await poolState(tp, kit.token, ethCall)) === JSON.stringify({ pool: true, router: true }), `${tag} its opening transaction opens both (${BigInt(ro?.gasUsed || 0)} gas of the ${kit.open.gas} it asks)`);
    // half-open: the pool alone first, then the kit's router-only transaction, which makes the same code
    await rpcA('evm_revert', [snap]);
    const [poolStep] = tp.deploySteps(kit.token);
    const r1 = await send({ to: poolStep.to, data: poolStep.data, gas: 2_000_000 });
    ok(r1?.status === '0x1' && JSON.stringify(await poolState(tp, kit.token, ethCall)) === JSON.stringify({ pool: true, router: false }), `${tag} with the pool alone on chain it reads half-open`);
    const r2 = await send(kit.routerOnly);
    ok(r2?.status === '0x1' && (await codeAt(kit.pool)) === opened.pool && (await codeAt(kit.router)) === opened.router, `${tag} and its router-only transaction finishes it, to the same code (${BigInt(r2?.gasUsed || 0)} gas of the ${kit.routerOnly.gas} it asks)`);
    const openBlock = Number(BigInt(r1.blockNumber));
    // built as the ETH pool is here
    ok(lc(await word(kit.pool, 'ASSET()')) === lc(kit.token) && lc(await word(kit.pool, 'VERIFIER()')) === lc(kit.args.verifier), `${tag} the pool holds the token and proves with the ETH pool's verifier`);
    const got = {};
    for (const f of ['ZROUTER()', 'PERMIT2()', 'V1()', 'POSEIDON4()']) got[f] = await word(kit.router, f);
    ok(lc(await word(kit.router, 'POOL()')) === lc(kit.pool) && ['ZROUTER()', 'PERMIT2()', 'V1()', 'POSEIDON4()'].every((f) => got[f] === live[f]),
      `${tag} the router is built as the live ETH router here (zRouter ${got['ZROUTER()'].slice(0, 10)}, Permit2, V1 ${BigInt(got['V1()']) === 0n ? 'none' : got['V1()'].slice(0, 10)}, Poseidon)`);
    // a box keeps its router's address (an immutable), so its code is the ETH router's box with this router in place of that one
    const boxCode = await codeAt(await word(kit.router, 'boxImpl()'));
    ok(opened.router.length === liveRouterCode.length && boxCode === liveBoxCode.split(lc(ETH_ROUTER).slice(2)).join(lc(kit.router).slice(2)),
      `${tag} its code is the ETH router's size (${(opened.router.length - 2) / 2} B), and its boxes are the ETH router's boxes, naming it`);

    // a deposit from a fresh wallet, by the token's own permit or by Permit2
    const amount = kit.sym === 'wstETH' ? 10n ** 16n : 25n * 10n ** BigInt(kit.dec);
    await rpcA('anvil_dealERC20', [USER, kit.token, hx(amount * 4n)]);
    ok((await uint(kit.token, 'balanceOf(address)', pad(USER))) === amount * 4n, `${tag} the wallet holds ${Number(amount * 4n) / 10 ** kit.dec} ${kit.sym}`);
    const now = BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp);
    let pull;
    if (kit.permit) {
      const name = Buffer.from((await view(kit.token, sel('name()'))).slice(130).replace(/(00)+$/, ''), 'hex').toString('utf8');
      const nonce = await uint(kit.token, 'nonces(address)', pad(USER)), deadline = now + 3600n;
      const sig = await user.signTypedData({ domain: { name, version: kit.permit, chainId, verifyingContract: kit.token },
        types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        primaryType: 'Permit', message: { owner: USER, spender: kit.router, value: amount, nonce, deadline } });
      const s = parseSignature(sig);
      pull = { kind: 'permit', value: amount, deadline, v: Number(s.v ?? 27n + BigInt(s.yParity)), r: s.r, s: s.s };
    } else {
      const ra = await send({ to: kit.token, data: '0x095ea7b3' + pad(PERMIT2) + 'f'.repeat(64), gas: 100_000 });
      ok(ra?.status === '0x1', `${tag} no permit: the wallet lets Permit2 move it (one approval, for every router)`);
      const nonce = BigInt('0x' + (await view(PERMIT2, sel('allowance(address,address,address)') + pad(USER) + pad(kit.token) + pad(kit.router))).slice(2 + 128, 2 + 192));
      const permitSingle = { details: { token: kit.token, amount, expiration: now + 86400n, nonce }, spender: kit.router, sigDeadline: now + 3600n };
      const sig = await user.signTypedData({ domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2 },
        types: { PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
          PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
        primaryType: 'PermitSingle', message: permitSingle });
      pull = { kind: 'permit2', permitSingle, sig };
    }
    ok((await uint(kit.token, 'allowance(address,address)', pad(USER) + pad(kit.router))) === 0n, `${tag} the router has no allowance from the wallet`);
    const rpc = jsonRpc([RPC]);
    const W = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, crypto.getRandomValues(new Uint8Array(32))), keeper: null, store: null, feed: false, prove,
      chain: { chainId, pool: kit.pool, router: kit.router, token: kit.token, deployBlock: openBlock, rpc, confirmations: 1, logChunk: 50000 } });
    W.connect({ address: USER, rpc, send: async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: USER, to, data, value: hx(value || 0), gas: '0x7A1200' }]) });
    const held0 = await uint(kit.token, 'balanceOf(address)', pad(kit.pool)), t0 = Date.now();
    const h = await W.deposit({ amount, selfCall: (tx) => routerDeposit(kit.router, tx, pull) });
    const rd = await receipt(h);
    ok(rd?.status === '0x1' && (await uint(kit.token, 'balanceOf(address)', pad(kit.pool))) - held0 === amount && W.summary().balance === amount,
      `${tag} the wallet deposits ${Number(amount) / 10 ** kit.dec} ${kit.sym} into the new pool by ${pull.kind === 'permit' ? `its EIP-2612 permit (version ${kit.permit})` : 'Permit2'}, a private note (${BigInt(rd?.gasUsed || 0)} gas, proved in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    ok((await uint(kit.token, 'allowance(address,address)', pad(USER) + pad(kit.router))) === 0n, `${tag} and the router holds no allowance from it after`);
  }
  anvil.kill('SIGKILL');
  await new Promise((r) => (anvil.exitCode !== null || anvil.signalCode ? r() : anvil.once('exit', r)));
  anvil = null;
}
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
