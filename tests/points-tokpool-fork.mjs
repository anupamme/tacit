#!/usr/bin/env node
// The token pools' campaign (worker-relay/src/lib/points-tokpool-service.js) against the live pools on a mainnet fork: real deposits into the
// USDC pool and the TAC pool through their routers (real proofs), a withdrawal the depositor sends itself, and the service reading them with
// a real client: the pools' Transact events, each pool's token and decimals, TAC's price from the oracle and the ETH feed, who each deposit
// credits and why one does not count, and the day's credits in the store.
//
//   node tests/points-tokpool-fork.mjs        (FORK=<archive rpc url>; Tenderly by default)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const snarkjs = require('snarkjs');
const { createPublicClient, http } = require('viem');
const { mainnet } = require('viem/chains');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc, routerDeposit } = await import('../dapp/evm-pool-wallet.js');
const { makeEvmPoolZk } = await import('../dapp/evm-pool-zk.js');
const { SERVED, FIXED } = await import('../dapp/evm-pool-tokens.js');
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');
const { openStore } = await import('../worker-relay/src/lib/points-store.js');
const { parseLpSchedule } = await import('../worker-relay/src/lib/points-lp.js');
const { createTokPool } = await import('../worker-relay/src/lib/points-tokpool-service.js');
const { parseTokPools, dayId, WAD } = await import('../worker-relay/src/lib/points-tokpool.js');

const ROOT = new URL('../', import.meta.url).pathname, ART = join(ROOT, 'dapp/evm-pool/');
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co';
const PORT = 26100 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const PU = SERVED[USDC.toLowerCase()], PT = FIXED[TAC.toLowerCase()];
const ORACLE = '0x000000cE58D7d49319252DaFB0ABdB3F02101271', FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', RELAY = '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0';
const ALICE = '0x00000000000000000000000000000000000de951', BOB = '0x00000000000000000000000000000000000de952';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (v) => '0x' + BigInt(v).toString(16);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const rpcA = (m, p = []) => post(RPC, m, p);
const receipt = async (h) => { for (let i = 0; i < 300; i++) { const r = await rpcA('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(100); } return null; };

const head = BigInt(await post(FORK, 'eth_blockNumber', [])) - 2n;
const procs = [], tmp = mkdtempSync(join(tmpdir(), 'tokpool-fork-'));
process.on('exit', () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); });
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
for (const a of [ALICE, BOB]) { await rpcA('anvil_setBalance', [a, hx(10n ** 18n)]); await rpcA('anvil_impersonateAccount', [a]); }
await rpcA('anvil_dealERC20', [ALICE, USDC, hx(3_000n * 10n ** 6n)]);
await rpcA('anvil_dealERC20', [BOB, TAC, hx(20_000n * WAD)]);
const blockTs = async () => Number(BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp));
const T0 = await blockTs(), DAY0 = Math.floor(T0 / 86400);

const Pz = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => Pz[xs.length](xs) });
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const prove = (input) => proveTransact(input, { wasm, zkey, snarkjs });
const rpc = jsonRpc([RPC]);
function wallet(who, token, p, dec) {
  const W = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, crypto.getRandomValues(new Uint8Array(32))), keeper: null, store: null, feed: false, prove,
    chain: { chainId: 1, pool: p.pool, router: p.router, token, deployBlock: Number(head) - 20, rpc, confirmations: 0, logChunk: 50000, relayer: RELAY, maxRelayFee: 10n ** BigInt(dec + 3) } });
  W.connect({ address: who, rpc, send: async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: who, to, data, value: hx(value || 0), gas: '0x7A1200' }]) });
  return W;
}
const approve = async (who, token, spender, amt) => receipt(await rpcA('eth_sendTransaction', [{ from: who, to: token, data: '0x095ea7b3' + pad(spender) + pad(hx(amt)), gas: '0x30000' }]));
const deposit = async (W, router, amount) => (await receipt(await W.deposit({ amount, selfCall: (tx) => routerDeposit(router, tx, { kind: 'allowance' }) })))?.status === '0x1';

// Alice deposits 1,000 USDC, withdraws 100 to herself, and deposits 500 more: the second deposit follows a payout to her.
const WA = wallet(ALICE, USDC, PU, 6);
await approve(ALICE, USDC, PU.router, 3_000n * 10n ** 6n);
ok(await deposit(WA, PU.router, 1_000n * 10n ** 6n), 'Alice deposits 1,000 USDC through the USDC pool\'s router');
ok((await receipt(await WA.withdraw({ to: ALICE, amount: 100n * 10n ** 6n, via: 'self' })))?.status === '0x1', 'and withdraws 100 USDC to her own address, sending it herself');
ok(await deposit(WA, PU.router, 500n * 10n ** 6n), 'and deposits 500 USDC again');
// Bob deposits 10,000 TAC into the TAC pool.
const WB = wallet(BOB, TAC, PT, 18);
await approve(BOB, TAC, PT.router, 20_000n * WAD);
ok(await deposit(WB, PT.router, 10_000n * WAD), 'Bob deposits 10,000 TAC through the TAC pool\'s router');

// The service, on the fork's clock: running now (a reading of TAC's price), then after the day is over.
let now = await blockTs();
const store = openStore(join(tmp, 'points.db')), said = [];
const client = createPublicClient({ chain: mainnet, transport: http(RPC) });
const s = createTokPool({
  store, client, budgetFor: () => 1111n * WAD, graceSecs: 1800, nowSec: () => now, log: (...m) => said.push(m.join(' ')),
  fundingInputs: async () => ({ heldWei: 100_000n * WAD, claimedWei: 0n, nextDay: DAY0 }),
  cfg: {
    schedule: parseLpSchedule(`${DAY0}:daily=60,cap=0.006`), pools: parseTokPools(`${PU.pool}/${PU.router}=usd,${PT.pool}/${PT.router}=tac`),
    pocketWei: 3500n * WAD, endSec: T0 + 60 * 86400, fromBlock: Number(head) - 20, minSamples: 1, exclude: [RELAY], tacOracle: ORACLE, ethUsdFeed: FEED, confirmations: 0,
  },
});
await s.cycle();
const v0 = s.view({ address: ALICE });
ok(v0.enabled && v0.pools.length === 2 && v0.mine.depositsToday.length === 2, `the service reads Alice's two deposits from the pool's own events (${JSON.stringify(v0.mine.depositsToday)})`);
const dayEnd = (DAY0 + 1) * 86400 + 1800 + 60;
await rpcA('evm_setNextBlockTimestamp', [hx(dayEnd)]); await rpcA('evm_mine', []);
now = await blockTs();
await s.cycle();
const rec = s.dayRecord(DAY0)?.record;
ok(!!rec, `the day is paid once it is over (${said.slice(-3).join(' | ')})`);
if (rec) {
  const tacUsd = BigInt(rec.tacUsdWei);
  ok(tacUsd > WAD / 100n && tacUsd < WAD, `TAC is priced from the oracle and the ETH feed: $${(Number(tacUsd) / 1e18).toFixed(4)}`);
  const mine = rec.deposits.filter((d) => d.address === ALICE.toLowerCase());
  ok(mine.length === 2 && !mine[0].why && mine[1].why === 'loop', `Alice's first deposit counts; her second, after a payout to her, does not (${mine.map((d) => d.why ?? 'counted').join(', ')})`);
  ok(store.creditedWithPrefix(dayId(DAY0, ALICE)) === 6n * WAD, `Alice is credited 6 TAC for $1,000 (${Number(store.creditedWithPrefix(dayId(DAY0, ALICE))) / 1e18})`);
  const bobUsd = (10_000n * tacUsd);
  const want = (6n * 10n ** 15n * bobUsd) / WAD;
  const got = store.creditedWithPrefix(dayId(DAY0, BOB));
  ok(got === (want < 30n * WAD ? want : 30n * WAD), `Bob is credited ${Number(got) / 1e18} TAC for 10,000 TAC (worth $${(Number(bobUsd) / 1e18).toFixed(2)}), at 0.006 TAC a dollar`);
}
ok(!said.some((m) => /failed/.test(m)), `the service logged no failure${said.some((m) => /failed/.test(m)) ? ': ' + said.filter((m) => /failed/.test(m)).join(' | ') : ''}`);
console.log(fails ? `${fails} failed, ${n} passed` : `all ${n} passed`);
process.exit(fails ? 1 : 0);
