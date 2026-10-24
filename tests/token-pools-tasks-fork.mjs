#!/usr/bin/env node
// The token pools' task jobs (worker-relay/scripts/tasks-token-pools.mjs), audited on a mainnet fork, token by token:
//   - the job's payload passes the page's own check against the job (dapp/tasks/verify.js) and is the deployment dapp/evm-pool-tokens.js derives;
//   - sent from a fresh account, it deploys the pool and its router where the job says, and the points service credits both steps from the
//     receipts (stepsCompleted); a pool opened in one transaction instead (the swap page's, Multicall3 calling CreateX twice) is credited the same;
//   - the code deployed is the live TAC pool's, router's and box template's but for their immutables (the token, its asset field, the pool,
//     the router, the box template), and every constructor setting reads back;
//   - a deposit through the router and a withdrawal sent by the user (real proofs) move each token exactly.
//
//   node tests/token-pools-tasks-fork.mjs        (FORK=<archive rpc url>)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//') && !spec.startsWith('/Users/')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const snarkjs = require('snarkjs');
const { createPublicClient, http } = require('viem');
const { keccak_256 } = await import('@noble/hashes/sha3');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc, routerDeposit } = await import('../dapp/evm-pool-wallet.js');
const { makeEvmPoolZk, poolAsset } = await import('../dapp/evm-pool-zk.js');
const { makeTokenPools, poolState, SERVED, FIXED, VERIFIER, ZROUTER, PERMIT2, V1, POSEIDON4 } = await import('../dapp/evm-pool-tokens.js');
const { checkPayload } = await import('../dapp/tasks/verify.js');
const { stepsCompleted } = await import('../worker-relay/src/lib/points-tasks.js');
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');

const ROOT = new URL('../', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co';
const PORT = 26400 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`;
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', TACP = FIXED[TAC.toLowerCase()];
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (v) => '0x' + BigInt(v).toString(16);
const lc = (s) => String(s).toLowerCase();
const word = (a) => (typeof a === 'bigint' ? a.toString(16) : lc(String(a).replace(/^0x/, ''))).padStart(64, '0');
const post = async (method, params = []) => { const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const call = (to, sig) => post('eth_call', [{ to, data: sig }, 'latest']);
const addr = async (to, sig) => '0x' + (await call(to, sig)).slice(-40);
const num = async (to, sig) => BigInt(await call(to, sig));
const bal = async (tok, who) => BigInt(await call(tok, '0x70a08231' + word(who)));
const receipt = async (h) => { for (let i = 0; i < 300; i++) { const r = await post('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(100); } return null; };
// the views read back, by their selectors
const SEL = Object.fromEntries(['ASSET', 'VERIFIER', 'ASSET_FIELD', 'nextIndex', 'POOL', 'ZROUTER', 'PERMIT2', 'V1', 'POSEIDON4', 'boxImpl']
  .map((k) => [k, '0x' + Buffer.from(keccak_256(new TextEncoder().encode(`${k}()`))).toString('hex').slice(0, 8)]));

const head = BigInt(await (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json().then((j) => j.result)) - 2n;
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) { try { await post('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
const client = createPublicClient({ transport: http(RPC) });

const code = JSON.parse(readFileSync(ROOT + 'dapp/evm-pool/token-pool-code.json', 'utf8'));
const tp = makeTokenPools({ code, keccak256: keccak_256 });
ok(true, 'the creation code rebuilds the live TAC pool and router (makeTokenPools checks their init-code hashes)');
const pageJobs = JSON.parse(readFileSync(ROOT + 'dapp/tasks/jobs.json', 'utf8')).jobs, serviceJobs = JSON.parse(readFileSync(ROOT + 'worker-relay/src/lib/points-tasks-jobs.json', 'utf8')).jobs;

// the live TAC pool, router and box template: what each new one must be but for its immutables
const tac = { pool: lc(TACP.pool), router: lc(TACP.router), field: await num(TACP.pool, SEL.ASSET_FIELD), box: lc(await addr(TACP.router, SEL.boxImpl)) };
const live = { pool: await post('eth_getCode', [TACP.pool, 'latest']), router: await post('eth_getCode', [TACP.router, 'latest']), box: await post('eth_getCode', [tac.box, 'latest']) };
ok(live.pool.length > 2 && live.router.length > 2 && live.box.length > 2, `the live TAC pool, router and box template read from the fork (${(live.pool.length - 2) / 2}, ${(live.router.length - 2) / 2}, ${(live.box.length - 2) / 2} bytes)`);
const swap = (codeHex, pairs) => { let c = lc(codeHex); for (const [a, b] of pairs) { const from = word(a), to = word(b); if (!c.includes(from)) return null; c = c.split(from).join(to); } return c; };

const FROM = '0x00000000000000000000000000000000000dE9a6';
await post('anvil_setBalance', [FROM, hx(10n ** 18n)]); await post('anvil_impersonateAccount', [FROM]);
const send = async (to, data, from = FROM) => { const h = await post('eth_sendTransaction', [{ from, to, data, gas: hx(8_000_000) }]); return { h, rc: await receipt(h) }; };
const credited = async (job, h) => stepsCompleted(job, await client.getTransaction({ hash: h }), await client.getTransactionReceipt({ hash: h }), 1).map((x) => x.step.id).sort().join(',');

// a pool opened in one transaction (the swap page's) is credited both steps the same: USDC, then put back
{
  const t = Object.keys(SERVED)[0], sym = SERVED[t].sym, job = serviceJobs.find((j) => j.id === `token-pool-${sym.toLowerCase()}`);
  const snap = await post('evm_snapshot');
  const o = tp.openTx(t), { h, rc } = await send(o.to, o.data);
  ok(rc?.status === '0x1' && (await credited(job, h)) === '01-pool,02-router', `${sym}: a pool opened in one transaction (Multicall3) is credited both steps (${await credited(job, h)})`);
  await post('evm_revert', [snap]);
  ok(JSON.stringify(await poolState(tp, t, (to, data) => call(to, data))) === JSON.stringify({ pool: false, router: false }), `${sym}: and the fork is put back, with no pool`);
}

const Pz = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => Pz[xs.length](xs) });
const ART = ROOT + 'dapp/evm-pool/', wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey'), times = [];
const prove = async (input) => { const t = Date.now(), r = await proveTransact(input, { wasm, zkey, snarkjs }); times.push(Date.now() - t); return r; };
const rpc = jsonRpc([RPC]);
const MAX = (1n << 256n) - 1n;

for (const [t, v] of Object.entries(SERVED)) {
  const sym = v.sym, id = `token-pool-${sym.toLowerCase()}`, p = tp.poolOf(t), steps = tp.deploySteps(t);
  const page = pageJobs.find((j) => j.id === id), svc = serviceJobs.find((j) => j.id === id);
  const payload = JSON.parse(readFileSync(ROOT + `dapp/tasks/${id}-payload.json`, 'utf8'));
  try {
    // the plan
    ok(!!page && !!svc && page.payloadUrl === `/tasks/${id}-payload.json` && JSON.stringify(page.steps.map(({ label, ...s }) => s)) === JSON.stringify(svc.steps), `${sym}: the page's job and the service's job are the same steps`);
    const verdict = checkPayload(page, payload);
    ok(verdict.ok, `${sym}: the payload passes the page's own check (salts, code, addresses)${verdict.ok ? '' : ` ${JSON.stringify(verdict.problems)}`}`);
    ok(payload.steps.every((s, i) => s.to === steps[i].to && s.data === steps[i].data) && svc.steps.every((s, i) => s.expected === steps[i].expected && s.salt === steps[i].salt && s.initCodeHash === steps[i].initCodeHash),
      `${sym}: it is the deployment evm-pool-tokens.js derives: pool ${p.pool}, router ${p.router}`);
    ok(svc.steps[0].expected === v.pool && svc.steps[1].expected === v.router, `${sym}: at the addresses the page and relay serve (SERVED)`);
    ok(svc.steps.every((s) => /^0x0{42}[0-9a-f]{22}$/.test(s.salt) && s.bound === false), `${sym}: under open salts any account can send`);
    // sent as the page sends it, from a fresh account
    const sent = [];
    for (const s of payload.steps) { const r = await send(s.to, s.data); sent.push(r); }
    ok(sent.every((r) => r.rc?.status === '0x1'), `${sym}: both steps land (${sent.map((r) => BigInt(r.rc.gasUsed)).join(' and ')} gas; the job plans ${svc.steps.map((s) => s.gas).join(' and ')})`);
    ok((await credited(svc, sent[0].h)) === '01-pool' && (await credited(svc, sent[1].h)) === '02-router', `${sym}: the service credits each step from its receipt`);
    // the code: the live TAC contracts' but for their immutables
    const field = poolAsset({ chainId: 1n, pool: p.pool, token: t }), box = lc(await addr(p.router, SEL.boxImpl));
    const [poolCode, routerCode, boxCode] = await Promise.all([p.pool, p.router, box].map((a) => post('eth_getCode', [a, 'latest'])));
    ok(swap(live.pool, [[TAC, t], [tac.field, field]]) === lc(poolCode), `${sym}: the pool's code is the TAC pool's, but for its token and asset field`);
    ok(swap(live.router, [[tac.pool, p.pool], [TAC, t], [tac.box, box], [tac.field, field]]) === lc(routerCode), `${sym}: the router's code is the TAC router's, but for its pool, token, box template and asset field`);
    ok(swap(live.box, [[tac.router, p.router]]) === lc(boxCode), `${sym}: its box template's code is the TAC router's, but for its router`);
    // every constructor setting
    const views = {
      'pool VERIFIER': [await addr(p.pool, SEL.VERIFIER), VERIFIER], 'pool ASSET': [await addr(p.pool, SEL.ASSET), t], 'router POOL': [await addr(p.router, SEL.POOL), p.pool],
      'router ASSET': [await addr(p.router, SEL.ASSET), t], 'router ZROUTER': [await addr(p.router, SEL.ZROUTER), ZROUTER], 'router PERMIT2': [await addr(p.router, SEL.PERMIT2), PERMIT2],
      'router V1': [await addr(p.router, SEL.V1), V1], 'router POSEIDON4': [await addr(p.router, SEL.POSEIDON4), POSEIDON4],
    };
    const wrong = Object.entries(views).filter(([, [a, b]]) => lc(a) !== lc(b)).map(([k]) => k);
    ok(!wrong.length && (await num(p.pool, SEL.ASSET_FIELD)) === field && (await num(p.pool, SEL.nextIndex)) === 0n, `${sym}: every setting reads back (verifier, token, pool, zRouter, Permit2, V1, PoseidonT5, asset field; empty)${wrong.length ? ` wrong: ${wrong}` : ''}`);
    ok(BigInt(await call(t, '0xdd62ed3e' + word(p.router) + word(p.pool))) === MAX || BigInt(await call(t, '0xdd62ed3e' + word(p.router) + word(p.pool))) > 10n ** 50n, `${sym}: the router has the pool's allowance for its deposits`);
    // a deposit and a withdrawal, real proofs, sent by the user
    const USER = '0x00000000000000000000000000000000000De9b' + (Object.keys(SERVED).indexOf(t) + 1), DEST = '0x00000000000000000000000000000000000De9c' + (Object.keys(SERVED).indexOf(t) + 1);
    await post('anvil_setBalance', [USER, hx(10n ** 18n)]); await post('anvil_impersonateAccount', [USER]);
    const unit = 10n ** BigInt(v.dec), dep = 100n * unit, out = 40n * unit;
    await post('anvil_dealERC20', [USER, t, hx(1_000n * unit)]);
    const W = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, crypto.getRandomValues(new Uint8Array(32))), keeper: null, store: null, prove,
      chain: { chainId: 1, pool: p.pool, router: p.router, token: t, deployBlock: Number(BigInt(sent[0].rc.blockNumber)), rpc, confirmations: 1, logChunk: 50000 } });
    W.connect({ address: USER, rpc, send: async ({ to, data, value }) => post('eth_sendTransaction', [{ from: USER, to, data, value: hx(value || 0), gas: hx(8_000_000) }]) });
    await receipt((await send(t, '0x095ea7b3' + word(p.router) + word(hx(dep)), USER)).h);
    const hd = await W.deposit({ amount: dep, selfCall: (tx) => routerDeposit(p.router, tx, { kind: 'allowance' }) });
    ok((await receipt(hd))?.status === '0x1' && (await bal(t, p.pool)) === dep && W.summary().balance === dep, `${sym}: 100 ${sym} deposited through the router, a private note`);
    const hw = await W.withdraw({ to: DEST, amount: out, via: 'self' });
    ok((await receipt(hw))?.status === '0x1' && (await bal(t, DEST)) === out && (await bal(t, p.pool)) === dep - out, `${sym}: 40 ${sym} withdrawn to a fresh address, 60 left in the pool`);
  } catch (e) { ok(false, `${sym}: ${String(e?.message || e).slice(0, 300)}`); }
}
console.log(`  proofs: ${times.map((x) => `${(x / 1000).toFixed(1)} s`).join(', ')}`);
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
