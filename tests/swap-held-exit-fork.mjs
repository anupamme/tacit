#!/usr/bin/env node
// What a private pool already holds for a key, swapped (or paid) out to an address: the Swap card's Pay pool as a side (dapp/swap/later.js adopt, then
// the same confirmed price and the same relayed withdrawal as any private swap's second half), end to end on a mainnet fork with the REAL multi-keeper
// process and real proofs. A user deposits into the ETH pool, the USDC pool and the TAC pool (as a payment to them would leave a balance), then,
// with nothing deposited by the swap itself, each is taken out: USDC for ETH, USDC itself, ETH for USDC, TAC for ETH. The relay sends every one,
// paid in the pool's coin, to a fresh address, never naming the wallet that deposited; a balance that cannot cover the swap and the relay's fee
// twice is refused before anything is sent, and so is a destination that is no address.
//
//   node tests/swap-held-exit-fork.mjs        (FORK=<rpc url>, QUOTE_RPC=<rpc url for zQuoter at the fork's block>; both an archive node)
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
const { keccak_256 } = await import('@noble/hashes/sha3');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc, routerDeposit } = await import('../dapp/evm-pool-wallet.js');
const { makeEvmPoolZk } = await import('../dapp/evm-pool-zk.js');
const { makeTokenPools } = await import('../dapp/evm-pool-tokens.js');
const { makeLater, heldSwapMax } = await import('../dapp/swap/later.js');
const { makeEvmTradeVenues } = await import('../dapp/evm-trade-venues.js');
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');

const ROOT = new URL('../', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', UP = process.env.QUOTE_RPC || 'https://mainnet.gateway.tenderly.co';
const PORT = 26100 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, KPORT = PORT + 400, K = `http://127.0.0.1:${KPORT}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ETH_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', ETHUSD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const TAC_POOL = { pool: '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe', router: '0x000000fA029Eaf69840C1490Bf9AA6C094794D5a', from: 26201971 };
const PAIR = '0x000000cE58D7d49319252DaFB0ABdB3F02101271', TAC_HOLDER = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const keyA = '0x' + 'a3'.repeat(32), A = privateKeyToAccount(keyA).address;
const USER = '0x00000000000000000000000000000000000de951';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (v) => '0x' + BigInt(v).toString(16);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const rpcA = (m, p = []) => post(RPC, m, p);
const bal = async (tok, who) => (tok === ZERO ? BigInt(await rpcA('eth_getBalance', [who, 'latest'])) : BigInt(await rpcA('eth_call', [{ to: tok, data: '0x70a08231' + pad(who) }, 'latest'])));
const receipt = async (h) => { for (let i = 0; i < 300; i++) { const r = await rpcA('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(100); } return null; };
const getJson = async (path) => { const r = await fetch(K + path); return { status: r.status, body: await r.json().catch(() => ({})) }; };

const head = BigInt(await post(FORK, 'eth_blockNumber', [])) - 2n, BLOCK = '0x' + head.toString(16);
const procs = [], tmp = mkdtempSync(join(tmpdir(), 'held-exit-'));
process.on('exit', () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); });
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
await rpcA('anvil_setBalance', [USER, hx(10n ** 21n)]); await rpcA('anvil_setBalance', [A, hx(10n ** 18n)]);
await rpcA('anvil_impersonateAccount', [USER]);
await rpcA('anvil_dealERC20', [USER, USDC, hx(5_000n * 10n ** 6n)]);
await rpcA('anvil_impersonateAccount', [TAC_HOLDER]); await rpcA('anvil_setBalance', [TAC_HOLDER, hx(10n ** 18n)]);
await receipt(await rpcA('eth_sendTransaction', [{ from: TAC_HOLDER, to: TAC, data: '0xa9059cbb' + pad(USER) + pad(hx(20_000n * 10n ** 18n)), gas: '0x30000' }]));

const code = JSON.parse(readFileSync(join(ROOT, 'dapp/evm-pool/token-pool-code.json'), 'utf8'));
const tp = makeTokenPools({ code, keccak256: keccak_256 }), P = tp.poolOf(USDC);
const ethCall = (to, data) => rpcA('eth_call', [{ to, data }, 'latest']);
const ART = join(ROOT, 'dapp/evm-pool/'), SD = '_' + P.id.toUpperCase().replace(/-/g, '_');
const env = {
  ...process.env, PORT: String(KPORT), EVM_POOL_CHAINS: '1,1-tac', EVM_POOL_ADDR: ETH_POOL, EVM_POOL_ROUTER_ADDR: ETH_ROUTER, EVM_POOL_KEEPER_DB: join(tmp, 'keeper.db'),
  EVM_POOL_RPC_URL_1: RPC, EVM_POOL_KEEPER_SEND_RPC_URLS_1: RPC, EVM_POOL_KEEPER_PRIV_1: keyA, EVM_POOL_START_BLOCK_1: '26069245', EVM_POOL_KEEPER_MIN_FEES_1: 'eth:1000',
  EVM_POOL_CONFIRMATIONS: '0', EVM_POOL_KEEPER_POLL_SECS: '1', EVM_POOL_LOG_CHUNK: '50000', EVM_POOL_KEEPER_FACTS: '0', EVM_POOL_KEEPER_POINTS: '0',
  EVM_POOL_TOKEN_POOLS_1: '26264000', EVM_POOL_TOKEN_POOLS_SECS: '2',
  [`EVM_POOL_KEEPER_RATE_FEED${SD}`]: `usd:${ETHUSD}`, [`EVM_POOL_KEEPER_POLL_SECS${SD}`]: '1',
  EVM_POOL_ADDR_1_TAC: TAC_POOL.pool, EVM_POOL_ROUTER_ADDR_1_TAC: TAC_POOL.router, EVM_POOL_START_BLOCK_1_TAC: String(TAC_POOL.from), EVM_POOL_KEEPER_PRIV_1_TAC: keyA,
  EVM_POOL_KEEPER_RATE_FEED_1_TAC: `tac:${PAIR}`,
  EVM_POOL_WASM: ART + 'transact.wasm', EVM_POOL_ZKEY: ART + 'transact_final.zkey', EVM_POOL_VK: ART + 'transact_vk.json',
};
const klog = [];
const keeper = spawn('node', ['src/evm-pool-keepers.js'], { cwd: join(ROOT, 'worker-relay'), env, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(keeper);
keeper.stdout.on('data', (d) => klog.push(String(d))); keeper.stderr.on('data', (d) => klog.push(String(d)));
for (let i = 0; ; i++) {
  try { if ((await fetch(`${K}/health`)).ok) break; } catch {}
  if (i > 900) { console.error(klog.join('').split('\n').slice(-30).join('\n')); throw new Error('the keepers did not become ready'); }
  await sleep(500);
}
await rpcA('anvil_mine', ['0x5']);
let listed = null;
for (let i = 0; i < 120 && !listed; i++) { listed = ((await getJson('/chains')).body.chains || []).find((c) => c.id === P.id); if (!listed) await sleep(1000); }
ok(!!listed && listed.pool === P.pool, `the keeper serves the USDC pool at /${P.id}/`);

const Pz = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => Pz[xs.length](xs) });
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey'), times = [];
const prove = async (input) => { const t = Date.now(), r = await proveTransact(input, { wasm, zkey, snarkjs }); times.push(Date.now() - t); return r; };
const rpc = jsonRpc([RPC]);
const privHex = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'), privBytes = Uint8Array.from(Buffer.from(privHex, 'hex'));
const keys = evmPoolKeys(zk, privBytes), userSend = async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: USER, to, data, value: hx(value || 0), gas: '0x7A1200' }]);
const mk = (keeperUrl, chain) => { const w = makeEvmPoolWallet({ zk, keys, keeper: keeperUrl, store: null, feed: true, prove, chain: { chainId: 1, rpc, confirmations: 1, logChunk: 50000, relayer: A, ...chain } }); w.connect({ address: USER, rpc, send: userSend }); return w; };

// the balances held, as a payment to the key's pool addresses (or its own deposits) would leave them: nothing here is a swap's deposit
const WE = mk(`${K}/1/evm-pool/keeper`, { pool: ETH_POOL, router: ETH_ROUTER, deployBlock: 26069245, maxRelayFee: 10n ** 18n });
const WU = mk(`${K}/${P.id}/evm-pool/keeper`, { pool: P.pool, router: P.router, token: USDC, deployBlock: 26264051, maxRelayFee: 10n ** 12n });
const WT = mk(`${K}/1-tac/evm-pool/keeper`, { pool: TAC_POOL.pool, router: TAC_POOL.router, token: TAC, deployBlock: TAC_POOL.from, maxRelayFee: 10n ** 30n });
const approve = async (tok, spender, amt) => receipt(await rpcA('eth_sendTransaction', [{ from: USER, to: tok, data: '0x095ea7b3' + pad(spender) + pad(hx(amt)), gas: '0x30000' }]));
await WE.deposit({ amount: 2n * 10n ** 17n });
await approve(USDC, P.router, 1_000n * 10n ** 6n);
await WU.deposit({ amount: 1_000n * 10n ** 6n, selfCall: (tx) => routerDeposit(P.router, tx, { kind: 'allowance' }) });
await approve(TAC, TAC_POOL.router, 5_000n * 10n ** 18n);
await WT.deposit({ amount: 5_000n * 10n ** 18n, selfCall: (tx) => routerDeposit(TAC_POOL.router, tx, { kind: 'allowance' }) });
ok(WE.summary().balance === 2n * 10n ** 17n && WU.summary().balance === 1_000n * 10n ** 6n && WT.summary().balance === 5_000n * 10n ** 18n, 'the key holds 0.2 ETH, 1,000 USDC and 5,000 TAC in the three pools');
// someone else deposits into the USDC pool after the key's own deposit: the wait for a held balance counts it
{
  const other = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, crypto.getRandomValues(new Uint8Array(32))), keeper: `${K}/${P.id}/evm-pool/keeper`, store: null, feed: true, prove, chain: { chainId: 1, rpc, confirmations: 1, logChunk: 50000, relayer: A, pool: P.pool, router: P.router, token: USDC, deployBlock: 26264051, maxRelayFee: 10n ** 12n } });
  other.connect({ address: USER, rpc, send: userSend });
  await approve(USDC, P.router, 50n * 10n ** 6n);
  await other.deposit({ amount: 50n * 10n ** 6n, selfCall: (tx) => routerDeposit(P.router, tx, { kind: 'allowance' }) });
}

// the page's flow, as the card runs it: the key's wallets are found again by sync from the chain, with no memory of the deposits above
const dl = () => BigInt(Number(BigInt(Date.now()) / 1000n) + 1200);
const ZQ = '0x000000bd2db80567c23e353ca95a251c573cbf9b';
const pageCall = (to, data, block, o = {}) => (to.toLowerCase() === ZQ ? post(UP, 'eth_call', [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, BLOCK]) : rpcA('eth_call', [{ to, data }, 'latest']));
const venues = makeEvmTradeVenues({ ethCall: pageCall, keccak256: keccak_256 });
const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const signer = { address: USER, rpc, ready: async () => {}, receipt, send: userSend };
const L = makeLater({ keyHex: async () => privHex, signer, ethCall: pageCall, venues, store, prove, tokens: tp,
  chain: { chainId: 1, rpc: [RPC], keeper: `${K}/1/evm-pool/keeper`, keepers: K, tokenRelayer: A, deployBlock: 26069245, confirmations: 1, logChunk: 50000 } });
const fmt = (v, d) => (Number(v) / 10 ** d).toPrecision(6);
const coins = { eth: { token: ZERO, sym: 'ETH', dec: 18 }, usdc: { token: USDC, sym: 'USDC', dec: 6 }, tac: { token: TAC, sym: 'TAC', dec: 18 } };

const exit = async ({ from, out, swap, dest, since }) => {
  const label = `${coins[from].sym} pool → ${coins[out].sym}`;
  try {
    const hop = from === 'eth' ? null : await L.hopOf(coins[from].token);
    const w = from === 'eth' ? WE : from === 'usdc' ? WU : WT;
    await w.sync();
    const before = w.summary().balance;
    const feeWei = BigInt((await getJson(`${from === 'eth' ? '/1/evm-pool/keeper' : hop.keeper.replace(K, '')}/quote?gas=${from === 'eth' ? 920000 : 1420000}`)).body.fee || 0);
    if (feeWei <= 0n) throw new Error('no fee from the relay');
    const plan = await L.adopt({ swapWei: swap, token: coins[out].token, sym: coins[out].sym, dec: coins[out].dec, to: dest, hop, pay: hop ? coins[from] : null, feeWei });
    ok(plan.state === 'waiting' && plan.held === true && !plan.depositTx && (!!plan.hop === (from !== 'eth')), `${label}: the balance is adopted as a plan with its deposit done (nothing sent)`);
    const mix = await L.blend(plan);
    ok(since === 'later' ? mix.since >= 2 : mix.since === 0, `${label}: the wait is read from the latest note: ${mix.since} leaves since it (${since === 'later' ? 'another deposit came after' : 'nothing came after'})`);
    const shown = await L.offer(plan, { slippageBps: 100 });
    const b0 = await bal(coins[out].token, dest);
    const done = await L.swapOut(plan, { shown, slippageBps: 100, via: 'relay' });
    const got = (await bal(coins[out].token, dest)) - b0, tx = await rpcA('eth_getTransactionByHash', [done.swapTx]);
    ok(done.state === 'done' && got >= shown.min && got > 0n && tx.from.toLowerCase() === A.toLowerCase(), `${label}: the relay sends ${fmt(swap, coins[from].dec)} ${coins[from].sym} out as ${fmt(got, coins[out].dec)} ${coins[out].sym} at a fresh address (at least ${fmt(shown.min, coins[out].dec)}, ${shown.name})`);
    ok(!tx.input.toLowerCase().includes(USER.slice(2).toLowerCase()), `${label}: the withdrawal does not name the wallet that deposited`);
    for (let i = 0; i < 40 && w.summary().balance >= before; i++) { await sleep(500); await w.sync(); }
    const charged = before - swap - w.summary().balance;
    ok(charged > 0n && charged <= 2n * feeWei, `${label}: the relay's fee came out of the pool: ${fmt(charged, coins[from].dec)} ${coins[from].sym}, within the ${fmt(2n * feeWei, coins[from].dec)} set aside`);
    ok(w.summary().balance > 0n, `${label}: what is left stays private in the pool (${fmt(w.summary().balance, coins[from].dec)} ${coins[from].sym})`);
  } catch (e) { ok(false, `${label}: ${String(e?.message || e).slice(0, 400)}`); }
};
await exit({ from: 'usdc', out: 'eth', swap: 200n * 10n ** 6n, dest: '0x00000000000000000000000000000000000de961', since: 'later' });
await exit({ from: 'usdc', out: 'usdc', swap: 100n * 10n ** 6n, dest: '0x00000000000000000000000000000000000de962', since: 'none' });
await exit({ from: 'eth', out: 'usdc', swap: 5n * 10n ** 16n, dest: '0x00000000000000000000000000000000000de963', since: 'none' });
await exit({ from: 'tac', out: 'eth', swap: 1_500n * 10n ** 18n, dest: '0x00000000000000000000000000000000000de964', since: 'none' });

// held ETH becomes held USDC with no public stop: the swap out of the ETH pool pays a deposit box of the USDC pool for this key, which that
// pool's relay completes; what the box holds above its floor is refundable to an address only the key knows
{
  const label = 'ETH pool → USDC pool';
  try {
    await WU.sync(); await WE.sync();
    const u0 = WU.summary().balance, e0 = WE.summary().balance, swap = 4n * 10n ** 16n, REFUND = '0x00000000000000000000000000000000000de971';
    const hopU = await L.hopOf(USDC);
    const feeWei = BigInt((await getJson('/1/evm-pool/keeper/quote?gas=920000')).body.fee);
    const plan = await L.adopt({ swapWei: swap, token: USDC, sym: 'USDC', dec: 6, feeWei, into: { hop: hopU, refund: REFUND } });
    ok(plan.held && plan.into?.hop?.pool === P.pool && plan.to === REFUND, `${label}: the balance is adopted as a plan into the USDC pool`);
    const shown = await L.offer(plan, { slippageBps: 100 });
    ok(!!shown.intoBox?.box && shown.callData.toLowerCase().includes(shown.intoBox.box.slice(2).toLowerCase()) && shown.arrives > 0n && shown.intoBox.amount <= shown.min, `${label}: priced paying a deposit box for the key, which holds at most the floor (${fmt(shown.intoBox.amount, 6)} USDC of at least ${fmt(shown.min, 6)}, arrives ${fmt(shown.arrives, 6)} after the relay)`);
    const done = await L.swapOut(plan, { shown, slippageBps: 100, via: 'relay' });
    ok(done.state === 'done' && done.intoBox === shown.intoBox.box, `${label}: the relay sends the swap out of the ETH pool to the box`);
    for (let i = 0; i < 90 && WU.summary().balance < u0 + shown.arrives; i++) { await sleep(1000); await rpcA('anvil_mine', ['0x1']); await WU.sync(); }
    ok(WU.summary().balance - u0 === shown.arrives, `${label}: the USDC pool's relay completes the deposit: ${fmt(WU.summary().balance - u0, 6)} USDC are held privately now, no public stop`);
    const tx = await rpcA('eth_getTransactionByHash', [done.swapTx]);
    ok(!tx.input.toLowerCase().includes(USER.slice(2).toLowerCase()), `${label}: and the withdrawal does not name the wallet that deposited`);
    for (let i = 0; i < 30 && WE.summary().balance >= e0; i++) { await sleep(500); await WE.sync(); }
    ok(e0 - WE.summary().balance > swap, `${label}: the ETH left the ETH pool (${fmt(e0 - WE.summary().balance, 18)} ETH with the relay's fee)`);
  } catch (e) { ok(false, `${label}: ${String(e?.message || e).slice(0, 400)}`); }
}

// the wallet's own ETH into a private USDC balance in one transaction: its swap pays a deposit box of the USDC pool for the key
{
  const label = 'wallet ETH → USDC pool';
  try {
    await WU.sync();
    const u0 = WU.summary().balance, hopU = await L.hopOf(USDC), w0 = await bal(ZERO, USER);
    const out = await L.swapIntoPool({ swapWei: 3n * 10n ** 16n, token: USDC, into: { hop: hopU }, refund: '0x00000000000000000000000000000000000de972', slippageBps: 100 });
    const rc = await receipt(out.hash), tx = await rpcA('eth_getTransactionByHash', [out.hash]);
    ok(rc?.status === '0x1' && tx.input.toLowerCase().includes(out.box.slice(2).toLowerCase()), `${label}: the wallet's one swap pays the key's deposit box`);
    for (let i = 0; i < 90 && WU.summary().balance < u0 + out.arrives; i++) { await sleep(1000); await rpcA('anvil_mine', ['0x1']); await WU.sync(); }
    ok(WU.summary().balance - u0 === out.arrives, `${label}: the USDC pool's relay completes it: ${fmt(WU.summary().balance - u0, 6)} USDC are held privately`);
    ok(w0 - (await bal(ZERO, USER)) >= 3n * 10n ** 16n, `${label}: and the wallet paid 0.03 ETH`);
  } catch (e) { ok(false, `${label}: ${String(e?.message || e).slice(0, 400)}`); }
}

// refused before anything is sent: a balance that does not cover the swap and the fee twice, and a destination that is no address
{
  const hop = await L.hopOf(USDC), feeWei = 700_000n, plans0 = JSON.parse(store.getItem('tacit-swap-later-v1') || '[]').length, u = coins.usdc;
  const refuses = async (args, re, label) => { try { await L.adopt(args); ok(false, `${label}: it was adopted`); } catch (e) { ok(re.test(String(e?.message || e)), `${label}: refused (${String(e?.message || e).slice(0, 90)})`); } };
  await refuses({ swapWei: 5_000n * 10n ** 6n, token: ZERO, sym: 'ETH', dec: 18, to: '0x00000000000000000000000000000000000de965', hop, pay: u, feeWei }, /holds less/, 'more than the pool holds');
  await refuses({ swapWei: 10n ** 6n, token: ZERO, sym: 'ETH', dec: 18, to: 'vitalik', hop, pay: u, feeWei }, /address/, 'a name that is no address');
  await refuses({ swapWei: 0n, token: ZERO, sym: 'ETH', dec: 18, to: '0x00000000000000000000000000000000000de965', hop, pay: u, feeWei }, /amount/, 'nothing');
  ok(JSON.parse(store.getItem('tacit-swap-later-v1') || '[]').length === plans0, 'and no plan was kept by any of them');
  ok(heldSwapMax(1_000n, 100n) === 800n && heldSwapMax(150n, 100n) === 0n, 'the most a balance can swap leaves the relay’s fee twice');
}
console.log(`  proofs: ${times.map((t) => `${(t / 1000).toFixed(1)} s`).join(', ')}`);
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
