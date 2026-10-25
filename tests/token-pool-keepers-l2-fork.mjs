#!/usr/bin/env node
// Token pools on Base and Robinhood Chain served by the REAL multi-keeper process (worker-relay/src/evm-pool-keepers.js), on a fork of each
// chain: the chain's ETH pool keeper runs as Render runs it (seeded from the live keepers' feed), EVM_POOL_TOKEN_POOLS_<chainId> and
// _ALLOW_<chainId> turn on its token pools, and a kit's opening transaction (dapp/admin/token-pools/kits.json) opens one. The keeper finds
// it in CreateX's logs and serves it at /<chainId>-x…/, priced by the kit's feed (a dollar from the chain's ETH/USD feed; Robinhood's,
// written once a day, named with its age); a wallet deposits by the token's permit or Permit2, and the keeper relays a withdrawal to a fresh address, paid in
// the token. POST /token-pools names the chain it means. Real proofs.
//
//   node tests/token-pool-keepers-l2-fork.mjs [chainId …]      (default 8453; FORK_<chainId>: the node to fork)
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
const { parseSignature } = require('viem');
const { keccak_256 } = await import('@noble/hashes/sha3');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc, routerDeposit } = await import('../dapp/evm-pool-wallet.js');
const { makeEvmPoolZk } = await import('../dapp/evm-pool-zk.js');
const { PERMIT2 } = await import('../dapp/evm-pool-tokens.js');
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');

const ROOT = new URL('../', import.meta.url).pathname, ART = join(ROOT, 'dapp/evm-pool/');
const KITS = JSON.parse(readFileSync(join(ROOT, 'dapp/admin/token-pools/kits.json'), 'utf8'));
const ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ETH_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
// each chain: its node to fork, its ETH pool's first block, and the kit served here
const RUN = {
  // `opened`: the block the kit's pool was opened at on the chain itself (2026-10-26); a fork after it finds the pool there already
  8453: { fork: 'https://base.gateway.tenderly.co', start: 51864014, sym: 'USDC', opened: 53088422 },
  4663: { fork: 'https://rpc.mainnet.chain.robinhood.com', start: 73991661, sym: 'USDe', opened: 97923247 },
};
const chains = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [8453];
const keyA = '0x' + 'a3'.repeat(32), A = privateKeyToAccount(keyA).address;
const user = privateKeyToAccount('0x' + 'b8'.repeat(32)), USER = user.address;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (v) => '0x' + BigInt(v).toString(16);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sel = (s) => '0x' + Array.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4), (x) => x.toString(16).padStart(2, '0')).join('');
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const Pz = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => Pz[xs.length](xs) });
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const prove = (input) => proveTransact(input, { wasm, zkey, snarkjs });

const procs = [];
const tmp = mkdtempSync(join(tmpdir(), 'token-pool-keepers-l2-'));
process.on('exit', () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); });

for (const chainId of chains) {
  const run = RUN[chainId], kit = KITS.kits.find((k) => k.chainId === chainId && k.sym === run.sym);
  console.log(`\n${KITS.chains[chainId].name}: the ${kit.sym} pool, served by the keepers`);
  const FORK = process.env[`FORK_${chainId}`] || run.fork;
  const PORT = 26500 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, KPORT = PORT + 400, K = `http://127.0.0.1:${KPORT}`;
  const rpcA = (m, p = []) => post(RPC, m, p);
  const head = BigInt(await post(FORK, 'eth_blockNumber', [])) - 2n;
  const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', String(chainId), '--silent', '--gas-limit', '300000000', '--no-rate-limit', '--block-time', '1'], { stdio: 'ignore' });
  procs.push(anvil);
  for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
  for (const a of [USER, A]) await rpcA('anvil_setBalance', [a, hx(10n ** 18n)]);
  await rpcA('anvil_impersonateAccount', [USER]);
  const receipt = async (h) => { for (let i = 0; i < 600; i++) { const r = await rpcA('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(100); } return null; };
  const send = async (tx) => receipt(await rpcA('eth_sendTransaction', [{ from: USER, to: tx.to, data: tx.data, value: hx(tx.value || 0), gas: hx(tx.gas || 8_000_000) }]));
  const uint = async (to, sig, args = '') => BigInt(await rpcA('eth_call', [{ to, data: sel(sig) + args }, 'latest']));
  const getJson = async (path) => { const r = await fetch(K + path); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const postJson = async (path, body) => { const r = await fetch(K + path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  // The pool open on the chain already (forked after its opening): the keeper looks for it from just before that block, as
  // Render's keeper does, and finds the real opening; else the kit opens it on the fork, below.
  const live = (await rpcA('eth_getCode', [kit.pool, 'latest'])).length > 2 && (await rpcA('eth_getCode', [kit.router, 'latest'])).length > 2;
  // the keepers: this chain's ETH pool as Render runs it, and its token pools on, for the kit's token alone
  const S = '_' + kit.keeper.id.toUpperCase().replace(/-/g, '_'), feed = kit.keeper.rateFeed;
  const env = {
    ...process.env, PORT: String(KPORT), EVM_POOL_CHAINS: String(chainId), EVM_POOL_KEEPER_DB: join(tmp, `keeper-${chainId}.db`),
    [`EVM_POOL_ADDR_${chainId}`]: ETH_POOL, [`EVM_POOL_ROUTER_ADDR_${chainId}`]: ETH_ROUTER, [`EVM_POOL_RPC_URL_${chainId}`]: RPC, [`EVM_POOL_KEEPER_SEND_RPC_URLS_${chainId}`]: RPC,
    [`EVM_POOL_KEEPER_PRIV_${chainId}`]: keyA, [`EVM_POOL_START_BLOCK_${chainId}`]: String(run.start), [`EVM_POOL_KEEPER_MIN_FEES_${chainId}`]: 'eth:5000000000000',
    [`EVM_POOL_SEED_FEED_${chainId}`]: `https://tacit-evm-pool-keepers.onrender.com/${chainId}/evm-pool/keeper`, [`EVM_POOL_LOG_CHUNK_${chainId}`]: '100000',
    EVM_POOL_CONFIRMATIONS: '0', EVM_POOL_KEEPER_POLL_SECS: '1', EVM_POOL_KEEPER_FACTS: '0', EVM_POOL_KEEPER_POINTS: '0',
    [`EVM_POOL_TOKEN_POOLS_${chainId}`]: String(live ? run.opened - 10 : head), [`EVM_POOL_TOKEN_POOLS_ALLOW_${chainId}`]: kit.token, EVM_POOL_TOKEN_POOLS_SECS: '2',
    [`EVM_POOL_KEEPER_RATE_FEED${S}`]: feed, [`EVM_POOL_KEEPER_POLL_SECS${S}`]: '1',
    EVM_POOL_WASM: ART + 'transact.wasm', EVM_POOL_ZKEY: ART + 'transact_final.zkey', EVM_POOL_VK: ART + 'transact_vk.json',
  };
  const klog = [];
  const keeper = spawn('node', ['src/evm-pool-keepers.js'], { cwd: join(ROOT, 'worker-relay'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(keeper);
  keeper.stdout.on('data', (d) => klog.push(String(d))); keeper.stderr.on('data', (d) => klog.push(String(d)));
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${K}/health`)).ok) break; } catch {}
    if (i > 1200 || keeper.exitCode !== null) { console.error(klog.join('').split('\n').slice(-30).join('\n')); throw new Error('the keepers did not become ready'); }
    await sleep(500);
  }
  ok(true, `the ${KITS.chains[chainId].name} keeper runs, watching CreateX for its token pools`);
  ok((await postJson('/token-pools', { token: kit.token })).status === 404, 'a token named with no chain means Ethereum, whose token pools are not on here');

  // the kit, sent as the admin page sends it
  let openedAt = run.opened;
  if (live) ok(true, `the ${kit.sym} pool is open on ${KITS.chains[chainId].name} already (block ${run.opened}): the keeper is to find its real opening`);
  else { const ro = await send(kit.open); ok(ro?.status === '0x1', `the kit opens the ${kit.sym} pool (${BigInt(ro?.gasUsed || 0)} gas)`); openedAt = Number(BigInt(ro.blockNumber)); }
  let listed = null;
  for (let i = 0; i < 180 && !listed; i++) { listed = ((await getJson('/chains')).body.chains || []).find((c) => c.id === kit.keeper.id); if (!listed) await sleep(1000); }
  ok(!!listed && listed.pool === kit.pool && listed.router === kit.router && listed.asset.toLowerCase() === kit.token.toLowerCase() && listed.keeper === A,
    `the keeper finds it in CreateX's logs and serves it at /${kit.keeper.id}/ from the chain keeper's key (${listed ? 'listed' : klog.join('').split('\n').filter((l) => /token-pools|-x/.test(l)).slice(-3).join(' | ')})`);
  const q = (await getJson(`/${kit.keeper.id}/evm-pool/keeper/quote`)).body;
  ok(q.relayer === A && q.asset?.toLowerCase() === kit.token.toLowerCase() && BigInt(q.fee || 0) > 0n && BigInt(q.fee) <= BigInt(kit.keeper.maxRelayFee),
    `its quote is in ${kit.sym}: ${Number(q.fee) / 10 ** kit.dec} ${kit.sym} a relay, under the kit's ceiling of ${Number(kit.keeper.maxRelayFee) / 10 ** kit.dec}`);
  const named = await postJson('/token-pools', { token: kit.token, chainId });
  ok(named.status === 200 && named.body.status === 'served' && named.body.id === kit.keeper.id && named.body.serving === true, `named on chain ${chainId}, it is one the relay serves (${JSON.stringify(named.body)})`);
  const listing = (await getJson(`/token-pools?chainId=${chainId}`)).body;
  ok(listing.chainId === chainId && listing.pools?.some((p) => p.id === kit.keeper.id && p.named === false), `GET /token-pools?chainId=${chainId} lists it, on no allowance`);

  // a deposit, then a relayed withdrawal paid in the token
  const amount = 30n * 10n ** BigInt(kit.dec);
  await rpcA('anvil_dealERC20', [USER, kit.token, hx(amount)]);
  const now = BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp);
  let pull;
  if (kit.permit) {
    const name = Buffer.from((await rpcA('eth_call', [{ to: kit.token, data: sel('name()') }, 'latest'])).slice(130).replace(/(00)+$/, ''), 'hex').toString('utf8');
    const sig = parseSignature(await user.signTypedData({ domain: { name, version: kit.permit, chainId, verifyingContract: kit.token },
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Permit', message: { owner: USER, spender: kit.router, value: amount, nonce: await uint(kit.token, 'nonces(address)', pad(USER)), deadline: now + 3600n } }));
    pull = { kind: 'permit', value: amount, deadline: now + 3600n, v: Number(sig.v ?? 27n + BigInt(sig.yParity)), r: sig.r, s: sig.s };
  } else {
    await send({ to: kit.token, data: '0x095ea7b3' + pad(PERMIT2) + 'f'.repeat(64), gas: 100_000 });
    const permitSingle = { details: { token: kit.token, amount, expiration: now + 86400n, nonce: 0n }, spender: kit.router, sigDeadline: now + 3600n };
    pull = { kind: 'permit2', permitSingle, sig: await user.signTypedData({ domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2 },
      types: { PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
        PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
      primaryType: 'PermitSingle', message: permitSingle }) };
  }
  const rpc = jsonRpc([RPC]);
  const W = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, crypto.getRandomValues(new Uint8Array(32))), keeper: `${K}/${kit.keeper.id}/evm-pool/keeper`, store: null, feed: true, prove,
    chain: { chainId, pool: kit.pool, router: kit.router, token: kit.token, deployBlock: openedAt, rpc, confirmations: 1, logChunk: 50000, relayer: A, maxRelayFee: BigInt(kit.keeper.maxRelayFee) } });
  W.connect({ address: USER, rpc, send: async ({ to, data, value }) => rpcA('eth_sendTransaction', [{ from: USER, to, data, value: hx(value || 0), gas: '0x7A1200' }]) });
  const hd = await W.deposit({ amount, selfCall: (tx) => routerDeposit(kit.router, tx, pull) });
  ok((await receipt(hd))?.status === '0x1' && W.summary().balance === amount, `a wallet deposits ${Number(amount) / 10 ** kit.dec} ${kit.sym} by ${pull.kind}, a private note`);
  const DEST = '0x00000000000000000000000000000000000de9' + String(chainId % 100).padStart(2, '0');
  const f0 = await uint(kit.token, 'balanceOf(address)', pad(A)), out = 10n * 10n ** BigInt(kit.dec);
  const hw = await W.withdraw({ to: DEST, amount: out });
  const rw = await receipt(hw), tw = await rpcA('eth_getTransactionByHash', [hw]);
  ok(rw?.status === '0x1' && tw.from.toLowerCase() === A.toLowerCase() && (await uint(kit.token, 'balanceOf(address)', pad(DEST))) === out, `the keeper relays a withdrawal of ${Number(out) / 10 ** kit.dec} ${kit.sym} to a fresh address`);
  const paid = (await uint(kit.token, 'balanceOf(address)', pad(A))) - f0;
  ok(paid > 0n, `and is paid in ${kit.sym} (${Number(paid) / 10 ** kit.dec})`);

  keeper.kill('SIGKILL'); anvil.kill('SIGKILL');
  await Promise.all([keeper, anvil].map((p) => new Promise((r) => (p.exitCode !== null || p.signalCode ? r() : p.once('exit', r)))));
}
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
