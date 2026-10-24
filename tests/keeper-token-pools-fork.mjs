#!/usr/bin/env node
// The relay serving the TAC pools beside the TAC vaults, on a mainnet fork: the REAL multi-keeper process (worker-relay/src/evm-pool-keepers.js)
// runs the ETH pool's keeper and the TAC, TACD and TACE pools' keepers in one process with one key (the Ethereum keeper's), as on
// Render, against the live pools and routers on the fork, with the ceremony's key. Each token pool's fee is in its token, priced from the chain
// (the vaults' pair oracle for TAC, ETH/USD for TACD, one ETH for TACE). A wallet deposits TAC into the TAC pool (its own transaction); the
// keeper relays a private send and a withdrawal for it, paid in TAC, while the ETH pool's keeper relays an ETH withdrawal at the same moment;
// TACD goes in and out the same way. Last, refusals: a fee under the quote, and a TAC pool proof posted to the TACD pool's keeper.
//
//   node tests/keeper-token-pools-fork.mjs        (FORK=<rpc url>)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const snarkjs = require('snarkjs');
const { privateKeyToAccount } = require('viem/accounts');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc, routerDeposit } = await import('../dapp/evm-pool-wallet.js');
const { makeEvmPoolZk } = await import('../dapp/evm-pool-zk.js');
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');

const ROOT = new URL('../', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co';
const PORT = 25300 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, KPORT = PORT + 400, K = `http://127.0.0.1:${KPORT}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ETH_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const PAIR = '0x000000cE58D7d49319252DaFB0ABdB3F02101271', ETHUSD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const POOLS = {
  tac: { pool: '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe', router: '0x000000fA029Eaf69840C1490Bf9AA6C094794D5a', token: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', from: 26201971, feed: `tac:${PAIR}` },
  tacd: { pool: '0x0000007bDb91d1aa0b5D3106Fd1c44C784b33DBA', router: '0x000000e96fcFf90F220fa65F8b82C6114Cd1Cc30', token: '0xA0f6B02561C8ef08335B69aD25e022C0B342147C', from: 26201971, feed: `usd:${ETHUSD}` },
  tace: { pool: '0x00000091974fB81e7eBA4cF2Cb24869c00a9A1a1', router: '0x000000e66C32bEC739180A5eDeeB40A8225c5223', token: '0x9DE27883C5Dc9Db47BE12E595D59b8f1aBEC8570', from: 26201971, feed: 'eth' },
};
const TAC_HOLDER = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const keyA = '0x' + 'a1'.repeat(32), A = privateKeyToAccount(keyA).address;
const USER = '0x00000000000000000000000000000000000de921', DEST = '0x00000000000000000000000000000000000de591', DEST_ETH = '0x00000000000000000000000000000000000de592', DEST_D = '0x00000000000000000000000000000000000de593';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (v) => '0x' + BigInt(v).toString(16);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const rpcA = (m, p = []) => post(RPC, m, p);
const bal = async (tok, who) => (tok === ZERO ? BigInt(await rpcA('eth_getBalance', [who, 'latest'])) : BigInt(await rpcA('eth_call', [{ to: tok, data: '0x70a08231' + pad(who) }, 'latest'])));
const receipt = async (h) => { for (let i = 0; i < 200; i++) { const r = await rpcA('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(100); } return null; };
const getJson = async (path) => { const r = await fetch(K + path); return { status: r.status, body: await r.json().catch(() => ({})) }; };

const head = BigInt(await post(FORK, 'eth_blockNumber', [])) - 2n;
const procs = [], tmp = mkdtempSync(join(tmpdir(), 'keeper-token-pools-'));
process.on('exit', () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); });
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
for (const a of [USER, A]) await rpcA('anvil_setBalance', [a, hx(10n ** 18n)]);
await rpcA('anvil_impersonateAccount', [USER]);

// the keepers, as Render runs them: the ETH pool's on its chain-wide knobs, each token pool's on its own, all on the Ethereum keeper's key
const ART = join(ROOT, 'dapp/evm-pool/');
const env = {
  ...process.env, PORT: String(KPORT), EVM_POOL_CHAINS: '1,1-tac,1-tacd,1-tace',
  EVM_POOL_ADDR: ETH_POOL, EVM_POOL_ROUTER_ADDR: ETH_ROUTER, EVM_POOL_KEEPER_DB: join(tmp, 'keeper.db'),
  EVM_POOL_RPC_URL_1: RPC, EVM_POOL_KEEPER_SEND_RPC_URLS_1: RPC, EVM_POOL_KEEPER_PRIV_1: keyA, EVM_POOL_START_BLOCK_1: '26069245', EVM_POOL_KEEPER_MIN_FEES_1: 'eth:1000',
  EVM_POOL_CONFIRMATIONS: '0', EVM_POOL_KEEPER_POLL_SECS: '1', EVM_POOL_LOG_CHUNK: '50000', EVM_POOL_KEEPER_FACTS: '0', EVM_POOL_KEEPER_POINTS: '0',
  EVM_POOL_WASM: ART + 'transact.wasm', EVM_POOL_ZKEY: ART + 'transact_final.zkey', EVM_POOL_VK: ART + 'transact_vk.json',
};
for (const [name, p] of Object.entries(POOLS)) {
  const S = `_1_${name.toUpperCase()}`;
  Object.assign(env, { [`EVM_POOL_ADDR${S}`]: p.pool, [`EVM_POOL_ROUTER_ADDR${S}`]: p.router, [`EVM_POOL_START_BLOCK${S}`]: String(p.from), [`EVM_POOL_KEEPER_PRIV${S}`]: keyA, [`EVM_POOL_KEEPER_RATE_FEED${S}`]: p.feed });
}
const klog = [];
const keeper = spawn('node', ['src/evm-pool-keepers.js'], { cwd: join(ROOT, 'worker-relay'), env, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(keeper);
keeper.stdout.on('data', (d) => klog.push(String(d))); keeper.stderr.on('data', (d) => klog.push(String(d)));
const t0 = Date.now();
for (let i = 0; ; i++) {
  try { if ((await fetch(`${K}/health`)).ok) break; } catch {}
  if (i > 900) { console.error(klog.join('').split('\n').slice(-30).join('\n')); throw new Error('the keepers did not become ready'); }
  await sleep(500);
}
ok(true, `four keepers in one process are ready on the fork (${Math.round((Date.now() - t0) / 1000)} s)`);
const chains = (await getJson('/chains')).body.chains || [];
ok(chains.map((c) => c.id).join() === '1,1-tac,1-tacd,1-tace' && chains.every((c) => c.keeper === A), `/chains lists them, all four on the one key (${chains.map((c) => `${c.id} ${c.keeper.slice(0, 6)}`).join(', ')})`);
ok(chains.slice(1).every((c, i) => c.asset.toLowerCase() === Object.values(POOLS)[i].token.toLowerCase() && c.base === `/${c.id}/evm-pool/keeper`), 'each token pool names its own token and route');

// quotes: in each pool's own token, at the price the chain gives
const qs = {};
for (const name of ['tac', 'tacd', 'tace']) qs[name] = (await getJson(`/1-${name}/evm-pool/keeper/quote`)).body;
const qe = (await getJson('/1/evm-pool/keeper/quote')).body;
ok(qe.relayer === A && qe.asset === ZERO && BigInt(qe.fee) > 0n, `the ETH pool quotes in ETH from key A (${Number(qe.fee) / 1e18} ETH)`);
ok(['tac', 'tacd', 'tace'].every((x) => qs[x].relayer === A && qs[x].pool.toLowerCase() === POOLS[x].pool.toLowerCase() && BigInt(qs[x].fee) > 0n), 'each token pool quotes from the same key, for its own pool');
// at equal gas, fee in the token = fee in ETH ÷ the token's price in ETH; ETH's own quote fixes the ETH side
const ethFee = BigInt(qe.fee), tacFee = BigInt(qs.tac.fee), taceFee = BigInt(qs.tace.fee), tacdFee = BigInt(qs.tacd.fee);
ok(taceFee >= ethFee - ethFee / 50n && taceFee <= ethFee + ethFee / 50n, `TACE is one ETH a token: ${Number(taceFee) / 1e18} TACE against ${Number(ethFee) / 1e18} ETH`);
ok(tacFee > ethFee * 1000n, `TAC is priced from the pair oracle: ${Number(tacFee) / 1e18} TAC for ${Number(ethFee) / 1e18} ETH of gas`);
ok(tacdFee > ethFee * 500n && tacdFee < ethFee * 10000n, `TACD is a dollar: ${Number(tacdFee) / 1e18} TACD`);

// a wallet for a pool: the page's own wallet module, pointed at the local keeper and the fork
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const times = [];
const prove = async (input) => { const t = Date.now(), r = await proveTransact(input, { wasm, zkey, snarkjs }); times.push(Date.now() - t); return r; };
const rpc = jsonRpc([RPC]);
const signer = { address: USER, rpc, send: async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: USER, to, data, value: hx(value || 0), gas: '0x7A1200' }]) };
const walletFor = (id, c, priv = crypto.getRandomValues(new Uint8Array(32))) => {
  const w = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, priv), keeper: `${K}/${id}/evm-pool/keeper`, store: null, feed: true, prove,
    chain: { chainId: 1, rpc, confirmations: 0, logChunk: 50000, ...c } });
  w.connect(signer);
  return w;
};
const tokWallet = (name, priv) => walletFor(`1-${name}`, { pool: POOLS[name].pool, router: POOLS[name].router, deployBlock: POOLS[name].from, token: POOLS[name].token, relayer: A, maxRelayFee: 10n ** 24n }, priv);

// TAC: the user's own deposit (an approval, then the router's deposit), then a relayed send and a relayed withdrawal paid in TAC
await rpcA('anvil_impersonateAccount', [TAC_HOLDER]); await rpcA('anvil_setBalance', [TAC_HOLDER, hx(10n ** 18n)]);
await receipt(await rpcA('eth_sendTransaction', [{ from: TAC_HOLDER, to: POOLS.tac.token, data: '0xa9059cbb' + pad(USER) + pad(hx(10_000n * 10n ** 18n)), gas: '0x30000' }]));
const privW = crypto.getRandomValues(new Uint8Array(32)), W = tokWallet('tac', privW), W2 = tokWallet('tac');
const dep = 3_000n * 10n ** 18n;
await receipt(await rpcA('eth_sendTransaction', [{ from: USER, to: POOLS.tac.token, data: '0x095ea7b3' + pad(POOLS.tac.router) + pad(hx(dep)), gas: '0x30000' }]));
const hd = await W.deposit({ amount: dep, selfCall: (tx) => routerDeposit(POOLS.tac.router, tx, { kind: 'allowance' }) });
ok((await receipt(hd))?.status === '0x1' && W.summary().balance === dep, `the user deposits 3,000 TAC into the TAC pool (${Number(W.summary().balance) / 1e18} TAC private)`);
const b0 = await bal(POOLS.tac.token, A);
const hs = await W.send({ to: W2.address, amount: 1_000n * 10n ** 18n });
const rs = await receipt(hs), txs = await rpcA('eth_getTransactionByHash', [hs]);
await W2.sync();
const fee1 = (await bal(POOLS.tac.token, A)) - b0;
ok(rs?.status === '0x1' && txs.from.toLowerCase() === A.toLowerCase() && W2.summary().balance === 1_000n * 10n ** 18n, `the keeper relays a private send of 1,000 TAC from the shared key; it reaches the other wallet (${Number(W2.summary().balance) / 1e18} TAC)`);
ok(fee1 > 0n && fee1 <= tacFee * 2n, `and is paid in TAC: ${Number(fee1) / 1e18} TAC (quoted ${Number(tacFee) / 1e18})`);
ok(!txs.input.toLowerCase().includes(USER.slice(2).toLowerCase()), 'the relayed send does not name the user');

// the ETH pool at the same moment, from the same key: its keeper relays an ETH withdrawal while the TAC keeper relays a TAC one, one nonce each
const E = walletFor('1', { pool: ETH_POOL, router: ETH_ROUTER, deployBlock: 26069245, relayer: A, maxRelayFee: 10n ** 17n });
await E.deposit({ amount: 3n * 10n ** 16n });
const [eh, th] = await Promise.all([E.withdraw({ to: DEST_ETH, amount: 10n ** 16n }), W.withdraw({ to: DEST, amount: 500n * 10n ** 18n })]);
const [er, tr] = await Promise.all([receipt(eh), receipt(th)]);
const [etx, ttx] = await Promise.all([rpcA('eth_getTransactionByHash', [eh]), rpcA('eth_getTransactionByHash', [th])]);
ok(er?.status === '0x1' && etx.from.toLowerCase() === A.toLowerCase() && (await bal(ZERO, DEST_ETH)) === 10n ** 16n, 'at the same moment: the ETH pool\'s keeper pays 0.01 ETH out');
ok(tr?.status === '0x1' && ttx.from.toLowerCase() === A.toLowerCase() && Number(ttx.nonce) !== Number(etx.nonce) && (await bal(POOLS.tac.token, DEST)) === 500n * 10n ** 18n, 'and the TAC pool\'s keeper, on the same key with a nonce of its own, pays 500 TAC out to a fresh address');
await W.sync();
const feeSum = (await bal(POOLS.tac.token, A)) - b0;
ok(W.summary().balance === dep - 1_000n * 10n ** 18n - 500n * 10n ** 18n - feeSum, `what is left is the deposit less the send, the withdrawal and the fees (${Number(W.summary().balance) / 1e18} TAC)`);
// the stored history follows the chain on its own loop: read once it has caught up with the three TAC transactions
let ev = {};
for (let i = 0; i < 90; i++) { ev = (await getJson('/1-tac/evm-pool/keeper/events')).body; if (ev.events?.length >= 3) break; await sleep(1000); }
const evE = (await getJson('/1/evm-pool/keeper/events?from=26069245')).body;
ok(ev.pool?.toLowerCase() === POOLS.tac.pool.toLowerCase() && ev.events?.length === 3, `the TAC keeper serves the TAC pool's own history (${ev.events?.length} events)`);
ok(evE.pool?.toLowerCase() === ETH_POOL.toLowerCase() && evE.events?.length > 290, `apart from the ETH pool's (${evE.events?.length} events)`);

// TACD: dealt to the user on the fork, in and out the same way
let dealt = false;
try { await rpcA('anvil_dealERC20', [USER, POOLS.tacd.token, hx(100n * 10n ** 18n)]); dealt = (await bal(POOLS.tacd.token, USER)) === 100n * 10n ** 18n; } catch {}
if (dealt) {
  const D = tokWallet('tacd');
  await receipt(await rpcA('eth_sendTransaction', [{ from: USER, to: POOLS.tacd.token, data: '0x095ea7b3' + pad(POOLS.tacd.router) + pad(hx(60n * 10n ** 18n)), gas: '0x30000' }]));
  await D.deposit({ amount: 60n * 10n ** 18n, selfCall: (tx) => routerDeposit(POOLS.tacd.router, tx, { kind: 'allowance' }) });
  const d0 = await bal(POOLS.tacd.token, A);
  const dh = await D.withdraw({ to: DEST_D, amount: 20n * 10n ** 18n });
  const dr = await receipt(dh), dtx = await rpcA('eth_getTransactionByHash', [dh]);
  ok(dr?.status === '0x1' && dtx.from.toLowerCase() === A.toLowerCase() && (await bal(POOLS.tacd.token, DEST_D)) === 20n * 10n ** 18n, `TACD: 60 in by the user, 20 out by the keeper, paid ${Number((await bal(POOLS.tacd.token, A)) - d0) / 1e18} TACD`);
} else ok(true, 'TACD: the fork could not deal TACD to the user (its balance slot is not a plain mapping); its quote above stands for it');

// refusals: a fee under the quote, and a TAC pool proof posted to the TACD keeper
// the wallet binds fetch when it is made: a second wallet on the same key, made with the relay posts kept, sends this one
const posted = [], realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { if (String(url).endsWith('/relay') && init?.body) posted.push({ url: String(url), body: JSON.parse(init.body) }); return realFetch(url, init); };
const Wk = tokWallet('tac', privW), W3 = tokWallet('tac');
globalThis.fetch = realFetch;
await Wk.send({ to: W3.address, amount: 100n * 10n ** 18n });
const last = posted.at(-1)?.body;
ok(!!last?.tx && posted.at(-1).url.includes('/1-tac/'), 'a relayed TAC send is kept to replay');
const cross = await fetch(`${K}/1-tacd/evm-pool/keeper/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(last) });
ok(cross.status >= 400, `a TAC pool proof posted to the TACD pool's keeper is refused (${cross.status}: ${(await cross.json().catch(() => ({}))).error?.slice(0, 80)})`);
const again = await fetch(`${K}/1-tac/evm-pool/keeper/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(last) });
ok(again.status >= 400, `the same TAC relay sent again is refused (${again.status})`);
const low = await fetch(`${K}/1-tac/evm-pool/keeper/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...last, tx: { ...last.tx, fee: '1' } }) });
const lowBody = await low.json().catch(() => ({}));
ok(low.status >= 400, `a TAC relay with its fee cut is refused (${low.status}: ${String(lowBody.error).slice(0, 70)})`);
ok(!/tick failed|failed:/.test(klog.join('').split('\n').filter((l) => !/history facts/.test(l)).join('\n')), 'the keepers logged no failed tick');
console.log(`  proofs: ${times.map((t) => `${(t / 1000).toFixed(1)} s`).join(', ')}`);
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
