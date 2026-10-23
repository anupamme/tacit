#!/usr/bin/env node
// "Swap privately" with the relay's path (dapp/swap/later.js, via 'relay') on a mainnet fork: the REAL keeper (worker-relay/src/evm-pool-keeper.js,
// run as its own process against the fork, with the live pool's ceremony verifying key) takes the withdrawal into the swap. A wallet deposits the
// swap's ETH and an extra with the live pool and router; the card's wait and price run; then swapOut proves on this machine, asks the keeper for its
// quote, posts the proof to its /relay and the keeper sends router.withdrawAndCall from its own address. The token lands at a fresh address, at
// least the price shown; the pool pays the keeper's fee out of the note; the transaction names neither the depositor nor the destination wallet.
// A second plan exits ETH to an address the same way (withdraw, no call). Last, the keeper refuses the same relay again, a call intent that is not the one proven, and a made-up proof.
//
//   node tests/swap-later-keeper-fork.mjs        (FORK=<rpc url>, QUOTE_RPC=<rpc url for zQuoter at the fork's block>)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const snarkjs = require('snarkjs');
const { privateKeyToAccount } = require('viem/accounts');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { makeLater, depositFor, POOL, ROUTER, CHAIN } = await import('../dapp/swap/later.js');

const ROOT = new URL('../', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', UP = process.env.QUOTE_RPC || 'https://mainnet.gateway.tenderly.co';
const PORT = 24900 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, KPORT = PORT + 400;
const KEEPER = `http://127.0.0.1:${KPORT}/evm-pool/keeper`;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ZERO = '0x0000000000000000000000000000000000000000';
const FROM = '0x00000000000000000000000000000000000dE911', DEST = '0x00000000000000000000000000000000000De581', DEST_ETH = '0x00000000000000000000000000000000000De582';
const keeperKey = '0x' + '5b'.repeat(32), keeperAddr = privateKeyToAccount(keeperKey).address;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const rpcA = (method, params = []) => post(RPC, method, params);
const bal = async (tok, who) => (tok === ZERO ? BigInt(await rpcA('eth_getBalance', [who, 'latest'])) : BigInt(await rpcA('eth_call', [{ to: tok, data: '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest'])));
const hex = (v) => '0x' + BigInt(v).toString(16);

const head = BigInt(await post(UP, 'eth_blockNumber', [])) - 2n, BLOCK = '0x' + head.toString(16);
const procs = [], tmp = mkdtempSync(join(tmpdir(), 'swap-later-keeper-'));
const stop = () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', stop);
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
for (const a of [FROM, keeperAddr]) await rpcA('anvil_setBalance', [a, hex(10n ** 18n)]);
await rpcA('anvil_impersonateAccount', [FROM]);

// the keeper: its own process, the live pool and router on the fork, the ceremony's key; it sends to the fork's node (no private endpoint)
const ART = join(ROOT, 'dapp/evm-pool/');
const klog = [];
const keeper = spawn('node', ['src/evm-pool-keeper.js'], {
  cwd: join(ROOT, 'worker-relay'),
  env: {
    ...process.env, EVM_POOL_ADDR: POOL, EVM_POOL_ROUTER_ADDR: ROUTER, EVM_POOL_RPC_URL: RPC, EVM_POOL_CHAIN_ID: '1', EVM_POOL_KEEPER_PRIV: keeperKey,
    EVM_POOL_KEEPER_DB: join(tmp, 'keeper.db'), PORT: String(KPORT), EVM_POOL_START_BLOCK: String(CHAIN.deployBlock), EVM_POOL_LOG_CHUNK: '50000',
    EVM_POOL_CONFIRMATIONS: '0', EVM_POOL_KEEPER_POLL_SECS: '1', EVM_POOL_KEEPER_MIN_FEES: 'eth:1000', EVM_POOL_KEEPER_SEND_RPC_URLS: RPC,
    EVM_POOL_KEEPER_POINTS: '0', EVM_POOL_KEEPER_FACTS: '0',
    EVM_POOL_WASM: ART + 'transact.wasm', EVM_POOL_ZKEY: ART + 'transact_final.zkey', EVM_POOL_VK: ART + 'transact_vk.json',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
procs.push(keeper);
keeper.stdout.on('data', (d) => klog.push(String(d))); keeper.stderr.on('data', (d) => klog.push(String(d)));
const t0 = Date.now();
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://127.0.0.1:${KPORT}/health`)).ok) break; } catch {}
  if (i > 600) { console.error(klog.join('').split('\n').slice(-20).join('\n')); throw new Error('the keeper did not become ready'); }
  await sleep(500);
}
ok(true, `the keeper runs against the fork's pool and is ready (${Math.round((Date.now() - t0) / 1000)} s)`);
const q = await (await fetch(`${KEEPER}/quote?gas=1000000`)).json();
ok(q.relayer?.toLowerCase() === keeperAddr.toLowerCase() && BigInt(q.fee) > 0n && q.pool?.toLowerCase() === POOL.toLowerCase(), `its quote names its own address and the live pool, fee ${q.fee} wei for 1M gas`);

// the wallet the card builds, pointed at the local keeper and the fork's node
const times = [];
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const prove = async (input) => { const t = Date.now(), r = await proveTransact(input, { wasm, zkey, snarkjs }); times.push(Date.now() - t); return r; };
const upCall = (to, data, block, o = {}) => post(UP, 'eth_call', [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, BLOCK]);
const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { jsonRpc } = await import('../dapp/evm-pool-wallet.js');
const rpc = jsonRpc([RPC]);
const sg = { address: FROM, rpc, ready: async () => {}, send: async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: FROM, to, data, value: hex(value || 0), gas: '0x7A1200' }]) };
const posted = [], realFetch = globalThis.fetch;                // the relay posts the wallet makes, kept to replay and tamper with below
globalThis.fetch = async (url, init) => { if (String(url).endsWith('/relay') && init?.body) posted.push(JSON.parse(init.body)); return realFetch(url, init); };
const privHex = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const chain = { chainId: 1, rpc: [RPC], keeper: KEEPER, deployBlock: CHAIN.deployBlock, confirmations: 0, logChunk: 50000 };
const L = makeLater({ keyHex: async () => privHex, signer: sg, ethCall: upCall, store, chain, prove });

const fee = BigInt(q.fee) * 3n / 2n;                          // a deposit's allowance for the relay's fee, a little over the quote
const swap = 2n * 10n ** 16n, { depositWei, extraWei } = depositFor({ swapWei: swap, feeWei: fee, pct: 40 });
const plan = await L.start({ swapWei: swap, extraWei, token: USDC, sym: 'USDC', dec: 6, to: DEST, depositWei });
ok(plan.state === 'waiting', `the deposit is made with the live pool (${plan.state})`);
const shown = await L.offer(plan, { slippageBps: 100 });
ok(shown.min > 0n && shown.callData, `a price is shown: at least ${shown.min} via ${shown.name}`);

const u0 = await bal(USDC, DEST), k0 = await bal(ZERO, keeperAddr);
const steps = [];
const done = await L.swapOut(plan, { shown, slippageBps: 100, via: 'relay', onStep: (s) => steps.push(s) });
ok(done.state === 'done' && /^0x[0-9a-f]{64}$/.test(done.swapTx), `the swap out is relayed (${done.state}; ${steps.join(' > ')})`);
const rc = await rpcA('eth_getTransactionReceipt', [done.swapTx]), tx = await rpcA('eth_getTransactionByHash', [done.swapTx]);
ok(rc?.status === '0x1' && rc.to?.toLowerCase() === ROUTER.toLowerCase() && rc.from.toLowerCase() === keeperAddr.toLowerCase(), `it was sent by the keeper's address to the router (${BigInt(rc?.gasUsed || 0)} gas)`);
const got = (await bal(USDC, DEST)) - u0;
ok(got >= shown.min, `the fresh address got ${Number(got) / 1e6} USDC, at least the ${Number(shown.min) / 1e6} shown`);
ok(!tx.input.toLowerCase().includes(FROM.slice(2).toLowerCase()), 'the relayed transaction does not name the wallet that deposited');
ok(tx.from.toLowerCase() !== FROM.toLowerCase(), 'and was not sent from it');
const after = await L.blend(done);
ok(after.balance < depositWei - swap && after.balance > extraWei / 2n, `the pool paid the keeper's fee from the note: ${after.balance} wei is left of ${depositWei - swap} (extra ${extraWei})`);
const k1 = await bal(ZERO, keeperAddr);
const gasCost = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
ok(k1 - k0 > 0n, `the keeper is paid more than its gas: +${k1 - k0} wei against ${gasCost} wei of gas`);
console.log(`  proofs: ${times.map((t) => `${(t / 1000).toFixed(1)} s`).join(', ')}`);

// a second plan: ETH out to an address (a private send): withdraw, no call
{
  const to0 = await bal(ZERO, DEST_ETH);
  const p2 = await L.start({ swapWei: swap, extraWei, token: ZERO, sym: 'ETH', dec: 18, to: DEST_ETH, depositWei });
  const d2 = await L.swapOut(p2, { shown: await L.offer(p2, { slippageBps: 100 }), slippageBps: 100, via: 'relay' });
  const paid = (await bal(ZERO, DEST_ETH)) - to0;
  ok(d2.state === 'done' && paid === swap, `an ETH exit is relayed too and pays the address exactly ${paid} wei`);
  const r2 = await rpcA('eth_getTransactionReceipt', [d2.swapTx]);
  ok(r2.from.toLowerCase() === keeperAddr.toLowerCase(), 'sent by the keeper');
}

// the keeper refuses what it should: the same spend again, a call intent that is not the one proven, a proof for no pool spend
{
  const relay = (body) => fetch(`${KEEPER}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const call = posted.find((b) => b.call), again = await relay(call);
  ok(again.status >= 400 && again.status < 500, `the same relay posted again is refused (${again.status}: ${again.text.slice(0, 100)})`);
  const swapped = JSON.parse(JSON.stringify(call)); swapped.call.calls[0].target = DEST;
  const bent = await relay(swapped);
  ok(bent.status === 400 && /escrow/.test(bent.text), `a call intent that is not the proven one is refused (${bent.text.slice(0, 100)})`);
  const forged = await relay({ tx: { pA: ['1', '2'], pB: [['1', '2'], ['3', '4']], pC: ['1', '2'], publicInputs: Array(11).fill('1'), extAmount: '-1', recipient: DEST, relayer: keeperAddr, fee: '0', memo0: '0x', memo1: '0x' } });
  ok(forged.status >= 400 && forged.status < 500, `a made-up proof with no fee is refused (${forged.status}: ${forged.text.slice(0, 90)})`);
  ok((await bal(USDC, DEST)) - u0 === got, 'and nothing more reached the address');
}

if (fails) console.error(klog.join('').split('\n').slice(-25).join('\n'));
console.log(`\n${n} passed, ${fails} failed`);
stop();
process.exit(fails ? 1 : 0);
