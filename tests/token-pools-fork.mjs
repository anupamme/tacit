#!/usr/bin/env node
// A private pool for any ERC-20 (dapp/evm-pool-tokens.js), end to end on a mainnet fork: a user opens the USDC pool with the page's one
// transaction (Multicall3 calling CreateX twice), the REAL multi-keeper process (worker-relay/src/evm-pool-keepers.js, the ETH pool's
// keeper and its key) finds it in CreateX's logs and starts serving it; the user deposits USDC (their own transaction), and the keeper
// relays a withdrawal to a fresh address and a withdrawal that swaps USDC for WBTC on zRouter to another, each paid in USDC; a DAI pool named
// to the relay (POST /token-pools) is kept and served on a day's allowance of gas, which its relays are charged to. Then the page's
// own flow (later.js) swaps privately through a token's pool to each kind of output its routes build: USDC for WBTC and for ETH (zQuoter's
// routes), USDC for TAC (into the Precision pool), and through the TAC pool (served beside it) TAC for ETH and for USDC. Real proofs.
// USDC is priced here as a dollar (EVM_POOL_KEEPER_RATE_FEED usd:…): zQuoter's scans are too slow for a fork; the zq feed has a test of its own.
//
//   node tests/token-pools-fork.mjs        (FORK=<rpc url>, QUOTE_RPC=<rpc url for zQuoter at the fork's block>)
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
const { callIntent, callEscrowAddress } = await import('../dapp/evm-pool-gateway.js');
const { makeTokenPools, poolState } = await import('../dapp/evm-pool-tokens.js');
const { bestRoute } = await import('../dapp/swap/aggregate.js');
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');

const ROOT = new URL('../', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', UP = process.env.QUOTE_RPC || 'https://mainnet.gateway.tenderly.co';
const PORT = 25700 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, KPORT = PORT + 400, K = `http://127.0.0.1:${KPORT}`;
const ZERO = '0x0000000000000000000000000000000000000000', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4';
const ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ETH_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', ETHUSD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const TAC_POOL = { pool: '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe', router: '0x000000fA029Eaf69840C1490Bf9AA6C094794D5a', from: 26201971 };
const PAIR = '0x000000cE58D7d49319252DaFB0ABdB3F02101271', TAC_HOLDER = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const keyA = '0x' + 'a3'.repeat(32), A = privateKeyToAccount(keyA).address;
const USER = '0x00000000000000000000000000000000000de931', DEST = '0x00000000000000000000000000000000000de941', DEST2 = '0x00000000000000000000000000000000000de942';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (v) => '0x' + BigInt(v).toString(16);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { revert: /revert/i.test(j.error.message) }); return j.result; };
const rpcA = (m, p = []) => post(RPC, m, p);
const bal = async (tok, who) => (tok === ZERO ? BigInt(await rpcA('eth_getBalance', [who, 'latest'])) : BigInt(await rpcA('eth_call', [{ to: tok, data: '0x70a08231' + pad(who) }, 'latest'])));
const receipt = async (h) => { for (let i = 0; i < 300; i++) { const r = await rpcA('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(100); } return null; };
const getJson = async (path) => { const r = await fetch(K + path); return { status: r.status, body: await r.json().catch(() => ({})) }; };

const head = BigInt(await post(FORK, 'eth_blockNumber', [])) - 2n, BLOCK = '0x' + head.toString(16);
const procs = [], tmp = mkdtempSync(join(tmpdir(), 'token-pools-'));
process.on('exit', () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); });
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
for (const a of [USER, A]) await rpcA('anvil_setBalance', [a, hx(10n ** 18n)]);
await rpcA('anvil_impersonateAccount', [USER]);
await rpcA('anvil_dealERC20', [USER, USDC, hx(5_000n * 10n ** 6n)]);

const code = JSON.parse(readFileSync(join(ROOT, 'dapp/evm-pool/token-pool-code.json'), 'utf8'));
const tp = makeTokenPools({ code, keccak256: keccak_256 }), P = tp.poolOf(USDC);
const ethCall = (to, data) => rpcA('eth_call', [{ to, data }, 'latest']);
// the USDC pool was opened on Ethereum (block 26264051): on a fork from after that it is there already, found from its real creation
const LIVE = JSON.stringify(await poolState(tp, USDC, ethCall)) === JSON.stringify({ pool: true, router: true });
ok(LIVE || JSON.stringify(await poolState(tp, USDC, ethCall)) === JSON.stringify({ pool: false, router: false }), LIVE ? `the USDC pool is open on Ethereum already, at ${P.pool}` : `no USDC pool yet at ${P.pool}`);
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F', PD = tp.poolOf(DAI), SD = '_' + PD.id.toUpperCase().replace(/-/g, '_');

// the keepers: the ETH pool's on its knobs, watching CreateX from the fork's head for token pools, priced USDC as a dollar here
const ART = join(ROOT, 'dapp/evm-pool/');
const env = {
  ...process.env, PORT: String(KPORT), EVM_POOL_CHAINS: '1,1-tac', EVM_POOL_ADDR: ETH_POOL, EVM_POOL_ROUTER_ADDR: ETH_ROUTER, EVM_POOL_KEEPER_DB: join(tmp, 'keeper.db'),
  EVM_POOL_RPC_URL_1: RPC, EVM_POOL_KEEPER_SEND_RPC_URLS_1: RPC, EVM_POOL_KEEPER_PRIV_1: keyA, EVM_POOL_START_BLOCK_1: '26069245', EVM_POOL_KEEPER_MIN_FEES_1: 'eth:1000',
  EVM_POOL_CONFIRMATIONS: '0', EVM_POOL_KEEPER_POLL_SECS: '1', EVM_POOL_LOG_CHUNK: '50000', EVM_POOL_KEEPER_FACTS: '0', EVM_POOL_KEEPER_POINTS: '0',
  EVM_POOL_TOKEN_POOLS_1: LIVE ? '26264000' : String(head), EVM_POOL_TOKEN_POOLS_SECS: '2',
  // a pool named on request (DAI's, below): priced as a dollar here too, its own loop quick
  [`EVM_POOL_KEEPER_RATE_FEED${SD}`]: `usd:${ETHUSD}`, [`EVM_POOL_KEEPER_POLL_SECS${SD}`]: '1', [`EVM_POOL_KEEPER_RATE_FEED${'_' + P.id.toUpperCase().replace(/-/g, '_')}`]: `usd:${ETHUSD}`,
  [`EVM_POOL_KEEPER_POLL_SECS${'_' + P.id.toUpperCase().replace(/-/g, '_')}`]: '1',
  // the TAC pool, as Render serves it: its own addresses, first block and price, the ETH pool's key
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
ok(true, 'the keeper runs, watching CreateX for token pools');

// open the pool: the page's one transaction, from the user (on a fork from before it was opened on Ethereum)
let ro = { blockNumber: hx(26264051) };
if (!LIVE) {
  const open = tp.openTx(USDC);
  ro = await receipt(await rpcA('eth_sendTransaction', [{ from: USER, to: open.to, data: open.data, gas: hx(open.gas) }]));
  ok(ro?.status === '0x1' && JSON.stringify(await poolState(tp, USDC, ethCall)) === JSON.stringify({ pool: true, router: true }), `one transaction opens the USDC pool and its router (${BigInt(ro.gasUsed)} gas, under the ${open.gas} the page asks)`);
}
ok(tp.openTx(USDC, await poolState(tp, USDC, ethCall)) === null, 'and the page then has nothing more to open');
await rpcA('anvil_mine', ['0x5']);                              // the blocks a quiet fork does not make by itself, for the scan's confirmations

// the keeper finds it and serves it at the route the token names
let listed = null;
for (let i = 0; i < 120 && !listed; i++) { listed = ((await getJson('/chains')).body.chains || []).find((c) => c.id === P.id); if (!listed) await sleep(1000); }
ok(!!listed && listed.pool === P.pool && listed.router === P.router && listed.asset.toLowerCase() === USDC.toLowerCase() && listed.keeper === A, `the keeper finds it in CreateX's logs and serves it at /${P.id}/ from the ETH pool's key (${listed ? 'listed' : klog.join('').split('\n').filter((l) => /token-pools|1-x/.test(l)).slice(-3).join(' | ')})`);
const q = (await getJson(`/${P.id}/evm-pool/keeper/quote`)).body;
ok(q.relayer === A && q.asset?.toLowerCase() === USDC.toLowerCase() && BigInt(q.fee || 0) > 0n, `its quote is in USDC: ${Number(q.fee) / 1e6} USDC for a relay`);

// any other token's pool, named to the relay (POST /token-pools): DAI's, opened here, kept once it is on chain and served on a day's
// allowance of gas
const tpost = async (token) => (await fetch(`${K}/token-pools`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token }) })).json();
ok((await tpost(DAI)).status === 'not-open', 'named before it is open, a token pool is not kept');
ok((await tpost(USDC)).status === 'served', 'a listed token is served already');
const od = tp.openTx(DAI), rd = await receipt(await rpcA('eth_sendTransaction', [{ from: USER, to: od.to, data: od.data, gas: hx(od.gas) }]));
const nd = await tpost(DAI);
ok(rd?.status === '0x1' && nd.status === 'added' && nd.id === PD.id, `the DAI pool opened and named, it is kept (${JSON.stringify(nd)})`);
let dk = null;
for (let i = 0; i < 120 && !dk; i++) { dk = ((await getJson('/token-pools')).body.pools || []).find((x) => x.id === PD.id); if (!dk) await sleep(1000); }
ok(!!dk && dk.named === true && dk.pool === PD.pool && BigInt(dk.gasLeftWei || 0) > 0n, `and served at /${PD.id}/ on a day's allowance of gas (${dk ? Number(dk.gasLeftWei) / 1e18 : '?'} ETH left)`);

// the user's deposit, then the keeper's relays
const Pz = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => Pz[xs.length](xs) });
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey'), times = [];
const prove = async (input) => { const t = Date.now(), r = await proveTransact(input, { wasm, zkey, snarkjs }); times.push(Date.now() - t); return r; };
const rpc = jsonRpc([RPC]);
const W = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, crypto.getRandomValues(new Uint8Array(32))), keeper: `${K}/${P.id}/evm-pool/keeper`, store: null, feed: true, prove,
  chain: { chainId: 1, pool: P.pool, router: P.router, token: USDC, deployBlock: Number(BigInt(ro.blockNumber)), rpc, confirmations: 1, logChunk: 50000, relayer: A, maxRelayFee: 10n ** 9n } });
W.connect({ address: USER, rpc, send: async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: USER, to, data, value: hx(value || 0), gas: '0x7A1200' }]) });
const dep = 1_500n * 10n ** 6n;
await receipt(await rpcA('eth_sendTransaction', [{ from: USER, to: USDC, data: '0x095ea7b3' + pad(P.router) + pad(hx(dep)), gas: '0x30000' }]));
const held0 = await bal(USDC, P.pool);
const hd = await W.deposit({ amount: dep, selfCall: (tx) => routerDeposit(P.router, tx, { kind: 'allowance' }) });
ok((await receipt(hd))?.status === '0x1' && W.summary().balance === dep && (await bal(USDC, P.pool)) - held0 === dep, `the user deposits 1,500 USDC into the USDC pool, a private note (${Number(W.summary().balance) / 1e6})`);

const f0 = await bal(USDC, A);
const hw = await W.withdraw({ to: DEST, amount: 400n * 10n ** 6n });
const rw = await receipt(hw), tw = await rpcA('eth_getTransactionByHash', [hw]);
ok(rw?.status === '0x1' && tw.from.toLowerCase() === A.toLowerCase() && (await bal(USDC, DEST)) === 400n * 10n ** 6n, 'the keeper relays a withdrawal of 400 USDC to a fresh address');
ok((await bal(USDC, A)) - f0 > 0n, `and is paid in USDC (${Number((await bal(USDC, A)) - f0) / 1e6} USDC)`);

// the named pool: a deposit and a relayed withdrawal, which the keeper's allowance pays for
{
  const WD = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, crypto.getRandomValues(new Uint8Array(32))), keeper: `${K}/${PD.id}/evm-pool/keeper`, store: null, feed: true, prove,
    chain: { chainId: 1, pool: PD.pool, router: PD.router, token: DAI, deployBlock: Number(BigInt(rd.blockNumber)), rpc, confirmations: 1, logChunk: 50000, relayer: A, maxRelayFee: 10n ** 30n } });
  WD.connect({ address: USER, rpc, send: async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: USER, to, data, value: hx(value || 0), gas: '0x7A1200' }]) });
  await rpcA('anvil_dealERC20', [USER, DAI, hx(1_000n * 10n ** 18n)]);
  await receipt(await rpcA('eth_sendTransaction', [{ from: USER, to: DAI, data: '0x095ea7b3' + pad(PD.router) + pad(hx(300n * 10n ** 18n)), gas: '0x30000' }]));
  await receipt(await WD.deposit({ amount: 300n * 10n ** 18n, selfCall: (tx) => routerDeposit(PD.router, tx, { kind: 'allowance' }) }));
  const left0 = BigInt(((await getJson('/token-pools')).body.pools || []).find((x) => x.id === PD.id).gasLeftWei), DEST4 = '0x00000000000000000000000000000000000de944';
  const hw2 = await WD.withdraw({ to: DEST4, amount: 100n * 10n ** 18n });
  const rw2 = await receipt(hw2), tw2 = await rpcA('eth_getTransactionByHash', [hw2]);
  const left1 = BigInt(((await getJson('/token-pools')).body.pools || []).find((x) => x.id === PD.id).gasLeftWei);
  ok(rw2?.status === '0x1' && tw2.from.toLowerCase() === A.toLowerCase() && (await bal(DAI, DEST4)) === 100n * 10n ** 18n, 'the keeper relays a withdrawal of 100 DAI out of the named pool, paid in DAI');
  ok(left1 < left0, `and charges it to the pool's allowance (${Number(left0 - left1) / 1e18} ETH of gas)`);
}

// a withdrawal that swaps: the escrow approves zRouter for exactly the swap's USDC, the route pays WBTC to the address; the rest refunds privately
const dl = BigInt(Number(BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp)) + 1200);
const upCall = (to, data, block, o = {}) => post(UP, 'eth_call', [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, BLOCK]);
const swapIn = 300n * 10n ** 6n;
const route = await bestRoute({ ethCall: upCall, to: DEST2, refundTo: DEST2, tokenIn: USDC, tokenOut: WBTC, amountIn: swapIn, slippageBps: 100, deadline: dl });
ok(!!route && route.min > 0n, `a route sells 300 USDC for WBTC: at least ${route ? Number(route.min) / 1e8 : '?'} WBTC via ${route?.name}`);
const refund = await W.refundBox();
const intent = callIntent({ calls: [{ target: ZROUTER, value: 0n, token: USDC, amount: swapIn, push: false, data: route.callData }], refund, deadline: dl, nonce: 41n });
const w0 = await bal(WBTC, DEST2), f1 = await bal(USDC, A);
const hc = await W.withdrawAndCall({ intent, amount: swapIn, gas: 900_000 });
const rc = await receipt(hc), tc = await rpcA('eth_getTransactionByHash', [hc]);
const got = (await bal(WBTC, DEST2)) - w0;
ok(rc?.status === '0x1' && tc.from.toLowerCase() === A.toLowerCase() && got >= route.min, `the keeper relays a withdrawal that swaps 300 USDC to ${Number(got) / 1e8} WBTC at a fresh address, at least the floor`);
ok((await bal(USDC, callEscrowAddress(intent, P.router))) === 0n && (await bal(USDC, A)) > f1, 'nothing is left in the escrow, and the keeper is paid in USDC');
ok(!tc.input.toLowerCase().includes(USER.slice(2)), 'the swap does not name the user');
const fees = (await bal(USDC, A)) - f0;
// the wallet's view settles once the node it reads has the change note (a read straight after the relay can come before it)
for (let i = 0; i < 20 && W.summary().balance !== dep - 400n * 10n ** 6n - swapIn - fees; i++) { await sleep(500); await W.sync(); }
ok(W.summary().balance === dep - 400n * 10n ** 6n - swapIn - fees, `what is left is private, the deposit less both and the fees (${Number(W.summary().balance) / 1e6} USDC)`);
// ── the page's own flow (dapp/swap/later.js): a USDC holder swaps privately through the USDC pool: the deposit by a permit signed for the
// pool's router, a price for WBTC with a stand-in, and the swap out relayed by the keeper to a fresh address ──
{
  const { makeLater, depositFor, TOKEN_POOLS_KEY } = await import('../dapp/swap/later.js');
  const { makeEvmTradeVenues } = await import('../dapp/evm-trade-venues.js');
  const acct = privateKeyToAccount('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')), DEST3 = '0x00000000000000000000000000000000000de943';
  await rpcA('anvil_impersonateAccount', [acct.address]); await rpcA('anvil_setBalance', [acct.address, hx(10n ** 18n)]);
  await rpcA('anvil_dealERC20', [acct.address, USDC, hx(1_000n * 10n ** 6n)]);
  const steps = [];
  const big = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, big(x)])) : v);
  const signer = { address: acct.address, rpc, ready: async () => {}, receipt,
    send: async ({ to, data, value }) => { steps.push(`send:${to.toLowerCase()}`); return rpcA('eth_sendTransaction', [{ from: acct.address, to, data, value: hx(value || 0), gas: '0x7A1200' }]); },
    signTyped: async ({ types, primaryType, domain, message }) => { steps.push(`sign:${primaryType}`); const { EIP712Domain, ...rest } = types; return acct.signTypedData({ domain: { ...domain, chainId: BigInt(domain.chainId) }, types: rest, primaryType, message: big(message) }); } };
  const ZQ = '0x000000bd2db80567c23e353ca95a251c573cbf9b';
  const pageCall = (to, data, block, o = {}) => (to.toLowerCase() === ZQ ? post(UP, 'eth_call', [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, BLOCK]) : rpcA('eth_call', [{ to, data }, 'latest']));
  const venues = makeEvmTradeVenues({ ethCall: pageCall, keccak256: keccak_256 });
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const privHex = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  // one confirmation, as the pages keep three: blocks that recent are read again each time, so a node whose logs trail its head for a moment
  // cannot leave the deposit out of what the wallet keeps
  const L = makeLater({ keyHex: async () => privHex, signer, ethCall: pageCall, venues, store, prove, tokens: tp,
    chain: { chainId: 1, rpc: [RPC], keeper: `${K}/1/evm-pool/keeper`, keepers: K, tokenRelayer: A, deployBlock: 26069245, confirmations: 1, logChunk: 50000 } });
  const hop = await L.hopOf(USDC);
  ok(hop.pool === P.pool && hop.state.pool && hop.state.router && hop.keeper === `${K}/${P.id}/evm-pool/keeper`, 'the page finds the USDC pool open, and its relay');
  const fee = BigInt((await getJson(`/${P.id}/evm-pool/keeper/quote?gas=1420000`)).body.fee), swap = 200n * 10n ** 6n;
  const { depositWei, extraWei } = depositFor({ swapWei: swap, feeWei: fee, pct: 20 });
  const u0 = await bal(USDC, acct.address);
  const plan = await L.start({ swapWei: swap, extraWei, token: WBTC, sym: 'WBTC', dec: 8, to: DEST3, depositWei, pay: { token: USDC, sym: 'USDC', dec: 6 }, hop, onStep: (x) => steps.push(x) });
  ok(plan.state === 'waiting' && plan.hop?.pool === P.pool && u0 - (await bal(USDC, acct.address)) === depositWei, `the deposit of ${Number(depositWei) / 1e6} USDC goes into the USDC pool as it is (${plan.state})`);
  ok(steps.includes('sign:Permit') && steps.filter((x) => /^send:/.test(x)).join() === `send:${P.router.toLowerCase()}`, `by a permit signed for its router, one transaction (${steps.filter((x) => /^send:|^sign:/.test(x)).join(', ')})`);
  ok(JSON.parse(store.getItem(TOKEN_POOLS_KEY) || '[]')[0]?.pool === P.pool, 'and the page keeps the pool for the front page');
  const shown = await L.offer(plan, { slippageBps: 100 });
  ok(shown.min > 0n && shown.callData.toLowerCase().includes(DEST3.slice(2)) && !shown.standData.toLowerCase().includes(DEST3.slice(2)), `a price for the swap out: at least ${Number(shown.min) / 1e8} WBTC (${shown.name}), quoted with a stand-in`);
  const w0 = await bal(WBTC, DEST3);
  const done = await L.swapOut(plan, { shown, slippageBps: 100, via: 'relay' });
  const got = (await bal(WBTC, DEST3)) - w0, tx = await rpcA('eth_getTransactionByHash', [done.swapTx]);
  ok(done.state === 'done' && got >= shown.min && tx.from.toLowerCase() === A.toLowerCase(), `the relay swaps it out: ${Number(got) / 1e8} WBTC at the address, at least the price shown`);
  ok(!tx.input.toLowerCase().includes(acct.address.slice(2).toLowerCase()), 'and the swap out does not name the wallet that deposited');
  const left = (await L.blend(done)).balance;
  ok(left > 0n && left < depositWei - swap, `the rest stays private in the USDC pool (${Number(left) / 1e6} USDC)`);

  // every kind of route a swap out of a token's pool takes: each deposited through the page, priced with a stand-in, sent by the relay from
  // the escrow (an approval of exactly the swap to zRouter), paying a fresh address at least the price shown
  await rpcA('anvil_dealERC20', [acct.address, USDC, hx(2_000n * 10n ** 6n)]);
  await rpcA('anvil_impersonateAccount', [TAC_HOLDER]); await rpcA('anvil_setBalance', [TAC_HOLDER, hx(10n ** 18n)]);
  await receipt(await rpcA('eth_sendTransaction', [{ from: TAC_HOLDER, to: TAC, data: '0xa9059cbb' + pad(acct.address) + pad(hx(5_000n * 10n ** 18n)), gas: '0x30000' }]));
  const fmt = (v, d) => (Number(v) / 10 ** d).toPrecision(6);
  const privately = async ({ pay, out, swap, dest }) => {
    const label = `${pay.sym} pool → ${out.sym}`;
    try {
      const hop = await L.hopOf(pay.token), want = hop.keeper.replace(K, '');
      if (!hop.state.pool || !hop.state.router) throw new Error(`the ${pay.sym} pool is not open`);
      const fee = BigInt((await getJson(`${want}/quote?gas=1420000`)).body.fee || 0);
      if (fee <= 0n) throw new Error(`no fee from ${want}`);
      const { depositWei, extraWei } = depositFor({ swapWei: swap, feeWei: fee, pct: 20 });
      const plan = await L.start({ swapWei: swap, extraWei, token: out.token, sym: out.sym, dec: out.dec, to: dest, depositWei, pay, hop });
      const shown = await L.offer(plan, { slippageBps: 100 });
      const b0 = await bal(out.token, dest), f0 = await bal(pay.token, A);
      const done = await L.swapOut(plan, { shown, slippageBps: 100, via: 'relay' });
      const got = (await bal(out.token, dest)) - b0, paid = (await bal(pay.token, A)) - f0, tx = await rpcA('eth_getTransactionByHash', [done.swapTx]);
      ok(done.state === 'done' && got >= shown.min && got > 0n && tx.from.toLowerCase() === A.toLowerCase() && paid > 0n && paid <= 2n * fee,
        `${label}: the relay swaps ${fmt(swap, pay.dec)} ${pay.sym} for ${fmt(got, out.dec)} ${out.sym} at a fresh address (at least ${fmt(shown.min, out.dec)}, ${shown.name}), paid ${fmt(paid, pay.dec)} ${pay.sym}`);
      ok(!tx.input.toLowerCase().includes(acct.address.slice(2).toLowerCase()), `${label}: the swap out does not name the wallet that deposited`);
    } catch (e) { ok(false, `${label}: ${String(e?.message || e).slice(0, 300)}`); }
  };
  const usdc = { token: USDC, sym: 'USDC', dec: 6 }, tac = { token: TAC, sym: 'TAC', dec: 18 }, eth = { token: ZERO, sym: 'ETH', dec: 18 };
  await privately({ pay: usdc, out: eth, swap: 150n * 10n ** 6n, dest: '0x00000000000000000000000000000000000de944' });
  await privately({ pay: usdc, out: tac, swap: 150n * 10n ** 6n, dest: '0x00000000000000000000000000000000000de945' });
  await privately({ pay: tac, out: eth, swap: 1_500n * 10n ** 18n, dest: '0x00000000000000000000000000000000000de946' });
  await privately({ pay: tac, out: usdc, swap: 1_500n * 10n ** 18n, dest: '0x00000000000000000000000000000000000de947' });
}
console.log(`  proofs: ${times.map((t) => `${(t / 1000).toFixed(1)} s`).join(', ')}`);
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
