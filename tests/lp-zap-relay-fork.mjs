#!/usr/bin/env node
// The ETH → private farm zap end to end on a mainnet fork, with the real pool module (dapp/confidential-pool-ux.js), dapp/lp-zap.js and the
// LIVE pool, router and AMM: the zap (ConfidentialRouter.zapETHIntoShieldedLP) shields exactly the shares a share note commits to; a fresh
// pool module with the key alone (no record from the zap) finds that pending deposit from the chain; the relay settles it into the share note
// (OP_WRAP) and the note is bonded to the farm (OP_FARM_BOND). The relay here is the worker's own job queue (worker/src/confidential-settle.js)
// with a box that builds the guest's input (dapp/sp1-stdin.js), runs the pinned SETTLE GUEST (elf/cxfer-guest, the program the live pool's
// immutable vkey names) in SP1 execute mode and sends pool.settle(); only the pool's SP1 verifier is replaced (by code that accepts any proof),
// so everything the pool checks of the public values is the real contract's. MUTATE=share-value changes the wrap's value by one share before
// the guest sees it, which must fail.
//
//   node tests/lp-zap-relay-fork.mjs        (FORK=<rpc url>; EXEC=<the exec-stdin binary>, built from tests/exec-stdin when not given)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const ELF = join(ROOT, 'contracts/sp1/confidential/elf/cxfer-guest');
const EXEC = process.env.EXEC || join(process.env.CARGO_TARGET_DIR || join(ROOT, 'tests/exec-stdin/target'), 'release/exec-stdin');
if (spawnSync('anvil', ['--version']).status !== 0) { console.log('skip - needs anvil'); process.exit(0); }
if (!existsSync(EXEC)) {
  console.log('building tests/exec-stdin (the settle guest in execute mode)...');
  const b = spawnSync('cargo', ['build', '--release', '--offline', '--manifest-path', join(ROOT, 'tests/exec-stdin/Cargo.toml')], { env: { ...process.env, GUEST_ELF: ELF }, stdio: 'inherit' });
  if (b.status !== 0 || !existsSync(EXEC)) { console.log('skip - the exec-stdin binary could not be built (EXEC=<binary>, or see tests/exec-stdin/Cargo.toml)'); process.exit(0); }
}
const elfSha = createHash('sha256').update(readFileSync(ELF)).digest('hex');
if (elfSha !== 'f7bc327d232ec8d1f693d5a44024c1ee732dc42196d079c5be5e3f3668b922c7') throw new Error(`the guest ELF is not the pinned one (${elfSha})`);

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { encodeFunctionData, parseAbi, keccak256, decodeErrorResult } = require('viem');
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co';
const PORT = 25700 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, RPORT = PORT + 400, RELAY = `http://127.0.0.1:${RPORT}`;
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119';
const SP1_VERIFIER = '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2';
const SETTLER = '0x00000000000000000000000000000000005e771e', FROM = '0x00000000000000000000000000000000000dE922';
const TETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const POOLS = [
  { name: 'tETH/TAC', pid: 0, poolId: '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00', token: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', asset: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', bond: true },
  { name: 'tETH/cBTC', pid: 2, poolId: '0x8359cd1f812e3a9040129e186e1477f60f2188bad1bd6a56e5506b22bf5cd331', token: '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696', asset: '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8', bond: false },
];
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (v) => '0x' + BigInt(v).toString(16);
const realFetch = globalThis.fetch;
const rpcA = async (method, params = []) => {
  const j = await (await realFetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { data: j.error.data });
  return j.result;
};

const procs = [], tmp = mkdtempSync(join(tmpdir(), 'lp-zap-relay-'));
const stop = () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', stop);
const head = BigInt((await (await realFetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json()).result) - 2n;
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
for (const a of [SETTLER, FROM]) { await rpcA('anvil_impersonateAccount', [a]); await rpcA('anvil_setBalance', [a, hex(100n * 10n ** 18n)]); }
{
  const pin = JSON.parse(readFileSync(join(ROOT, 'contracts/sp1/confidential/elf-vkey-pin.json'), 'utf8'));
  ok((await rpcA('eth_getCode', [POOL, 'latest'])).toLowerCase().includes(pin.program_vkey.slice(2).toLowerCase()) && pin.elf_sha256 === elfSha, `the guest run here is the one the live pool's immutable vkey names (${pin.program_vkey.slice(0, 14)}…)`);
}
await rpcA('anvil_setCode', [SP1_VERIFIER, '0x00']);

// ── the relay: the worker's job queue, the guest in execute mode, pool.settle ──
const { stdinFor } = await import('../dapp/sp1-stdin.js');
const poolAbi = (() => { try { return JSON.parse(readFileSync('/Users/z/tacit/contracts/out/ConfidentialPool.sol/ConfidentialPool.json', 'utf8')).abi; } catch { return []; } })();
const why = (e) => { try { return decodeErrorResult({ abi: poolAbi, data: e.data }).errorName; } catch { return String(e.message || e).slice(0, 160) + (e.data ? ` ${String(e.data).slice(0, 74)}` : ''); } };
const { makeConfidentialSettler } = await import('../worker/src/confidential-settle.js');
const store = (() => { const m = new Map(); let pending = []; return { getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); }, getJob: async (id) => (m.has(id) ? JSON.parse(JSON.stringify(m.get(id))) : null), putJob: async (id, j) => { m.set(id, JSON.parse(JSON.stringify(j))); } }; })();
const settler = makeConfidentialSettler({ storage: store, hash: (str) => keccak256(`0x${Buffer.from(str).toString('hex')}`), sleep: async () => {} });
let queue = Promise.resolve();
const log = [];
async function send(from, to, data, value = '0x0') {
  let gas = 3_000_000n;
  try { gas = (BigInt(await rpcA('eth_estimateGas', [{ from, to, data, value }])) * 13n) / 10n; } catch (e) { throw Object.assign(new Error(`it would revert: ${why(e)}`), { data: e.data }); }
  const h = await rpcA('eth_sendTransaction', [{ from, to, data, value, gas: hex(gas) }]);
  for (let i = 0; i < 1200; i++) { const rc = await rpcA('eth_getTransactionReceipt', [h]); if (rc) { if (rc.status !== '0x1') throw new Error(`reverted ${h}`); return { hash: h, rc }; } await sleep(100); }
  throw new Error('no receipt');
}
const execGuest = (env) => new Promise((resolve) => {
  const c = spawn(EXEC, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});
async function runJob({ jobId: id, type, op, memos: jm }) {
  try {
    const body = { type, op: JSON.parse(JSON.stringify(op)), memos: jm || [] };
    if (process.env.MUTATE === 'share-value' && type === 'wrap') body.op.value = String(BigInt(body.op.value) + 1n);
    const memoHashes = body.memos.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
    const f = join(tmp, `${id.slice(2, 14)}.stdin`), out = join(tmp, `${id.slice(2, 14)}.pv`);
    writeFileSync(f, stdinFor(type, { ...body.op, memoHashes }));
    const t = Date.now(), r = await execGuest({ ...process.env, STDIN: f, OUT: out });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('EXECUTE_OK')) || '';
    if (r.status !== 0 || !existsSync(out)) throw new Error(`the settle guest rejected the op: ${((r.stderr || '') + (r.stdout || '')).split('\n').filter((l) => /panick|assert|error|failed/i.test(l)).slice(0, 3).join(' | ').slice(0, 300)}`);
    log.push(`${type}: ${line} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    const data = encodeFunctionData({ abi: parseAbi(['function settle(bytes publicValues, bytes proof, bytes[] memos)']), functionName: 'settle', args: [`0x${readFileSync(out, 'utf8').trim()}`, '0x', body.memos.map((m) => (m.startsWith('0x') ? m : `0x${m}`))] });
    const s = await send(SETTLER, POOL, data);
    await settler.ackJob(id, { txHash: s.hash });
  } catch (e) { const m = String(e.message || e).slice(0, 400); log.push(`${type} failed: ${m}`); await settler.ackJob(id, { error: m }); }
}
const server = createServer(async (req, res) => {
  const u = new URL(req.url, RELAY);
  const json = (code, b) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); };
  const body = req.method === 'POST' ? JSON.parse(await new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s || '{}')); })) : null;
  if (u.pathname === '/confidential/relay') return json(200, { state: 'ok', proving: true, settling: true, board: false });
  if (u.pathname === '/confidential/quote') return json(200, { recommendedWrapTipWei: '60000000000000', tipSplitter: '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9', gasAwareFloorUnits: '20000', staticFloorUnits: '20000' });
  if (u.pathname === '/confidential/submit' && req.method === 'POST') {
    let r;
    try { r = await settler.submitJob({ type: body.type, op: body.op, memos: body.memos, mode: body.mode || 'settle', feeAsset: body.feeAsset || null, exit: body.exit || null }); }
    catch (e) { return json(400, { error: String(e.message || e) }); }
    queue = queue.then(async () => { const claimed = await settler.nextJob(); if (claimed) await runJob(claimed); });
    return json(200, { ok: true, ...r });
  }
  if (u.pathname === '/confidential/status') { const j = await settler.jobStatus(u.searchParams.get('id')); return j ? json(200, j) : json(404, { error: 'unknown' }); }
  return json(404, { error: 'no such path here' });
}).listen(RPORT);
server.keepAliveTimeout = 120_000;
procs.push({ kill: () => server.close() });
const again = async (go, what) => { for (let i = 0; ; i++) { try { return await go(); } catch (e) { if (i >= 3) { log.push(`fetch to ${what} failed: ${e.cause?.code || e.message}`); throw e; } await sleep(700 * (i + 1)); } } };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/^https:\/\/api\.tacit\.finance\/confidential\//.test(u)) return realFetch(u.replace('https://api.tacit.finance', RELAY), init);
  if (/^https:\/\/api\.tacit\.finance\//.test(u)) return new Response('{}', { status: 404 });
  if (/^https?:\/\/[^/]*(rpc|node|gateway|eth\.|llama|ankr|drpc|merkle|infura|alchemy|cloudflare|1rpc)/i.test(u) && init?.method === 'POST') return again(() => realFetch(RPC, { ...init, signal: AbortSignal.timeout(180_000) }), 'the fork');
  return again(() => realFetch(url, init), new URL(u).host);
};

const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
const { zapPlan, zapCalldata } = await import('../dapp/lp-zap.js');
setActiveNetwork('mainnet');
const mkUx = () => makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => globalThis.fetch(u, o), network: 'mainnet' });
const ux = mkUx();
const priv = crypto.getRandomValues(new Uint8Array(32));
ux.identity(priv);
const wait = { timeoutMs: 15 * 60e3, intervalMs: 1000, sleep: (t) => sleep(Math.min(t, 1000)) };
const word = (h, i) => BigInt('0x' + String(h).replace(/^0x/, '').slice(i * 64, i * 64 + 64));
const depositStatus = async (id) => word(await rpcA('eth_call', [{ to: POOL, data: '0x7da9874f' + String(id).slice(2).padStart(64, '0') }, 'latest']), 0);
const t0 = Date.now(), zaps = [];

// ── 1. the zap: one transaction from the wallet, exactly the committed shares shielded into a pending deposit, some B refunded ──
for (const p of POOLS) {
  const res = await ux.poolReserves(p.poolId);
  const plan = zapPlan({ eth: 5n * 10n ** 16n, ra: res.reserveA, rb: res.reserveB, total: res.totalShares, feeBps: BigInt(res.feeBps ?? 30) });
  const index = ux.nextShareIndex({ walletPriv: priv, poolId: p.poolId, owned: [] });
  const built = ux.buildShareWrap({ walletPriv: priv, poolId: p.poolId, shares: plan.shares, index });
  const data = zapCalldata({ plan, router: ROUTER, amm: AMM, tokenB: p.token, assetA: res.assetA, assetB: res.assetB, feeBps: Number(res.feeBps ?? 30), deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), commit: built.commit });
  const sim = await rpcA('eth_call', [{ from: FROM, to: ROUTER, data, value: hex(plan.value) }, 'latest']);
  ok(word(sim, 1) === plan.shares && '0x' + sim.slice(2, 66) === String(built.depositId).toLowerCase(), `${p.name}: simulated as sent, the zap mints the ${plan.shares} shares the note commits to and makes its deposit`);
  const s = await send(FROM, ROUTER, data, hex(plan.value));
  const refund = s.rc.logs.find((l) => l.address.toLowerCase() === p.token.toLowerCase() && l.topics[1] === '0x' + ROUTER.slice(2).toLowerCase().padStart(64, '0') && l.topics[2] === '0x' + FROM.slice(2).toLowerCase().padStart(64, '0'));
  ok(await depositStatus(built.depositId) === 1n && refund && BigInt(refund.data) >= 10n ** 10n, `${p.name}: sent, the deposit is pending and the router's refund of ${refund ? BigInt(refund.data) : 0n} names the sender (${s.rc.gasUsed} gas)`);
  zaps.push({ p, plan, index, built, tx: s.hash });
}

// ── 2. the key alone finds them: a fresh pool module, no record of the zaps, the sender as one of the key's accounts ──
{
  const fresh = mkUx();
  const found = await fresh.shareDeposits(priv, { router: ROUTER, pools: POOLS.map((p) => ({ pid: p.pid, poolId: p.poolId, token: p.token })), accounts: [FROM], fromBlock: Number(head) - 10 });
  const match = (z) => found.find((f) => f.depositId === String(z.built.depositId).toLowerCase() && f.shares === z.plan.shares && f.index === z.index && f.tx === z.tx && f.poolId === z.p.poolId);
  ok(found.length === zaps.length && zaps.every(match), `a fresh module finds each pending zap from the key and the chain: ${found.map((f) => `${f.shares} shares at index ${f.index}`).join(', ')}`);
  // whoever paid: with no account named, each zap's pull of its token leg from the router into the public AMM names it
  const blind = await fresh.shareDeposits(priv, { router: ROUTER, amm: AMM, pools: POOLS.map((p) => ({ pid: p.pid, poolId: p.poolId, token: p.token })), fromBlock: Number(head) - 10 });
  ok(blind.length === zaps.length && zaps.every((z) => blind.find((f) => f.depositId === String(z.built.depositId).toLowerCase() && f.index === z.index && f.tx === z.tx)), `and with no paying account named, the AMM's side finds each too (${blind.length} of ${zaps.length})`);
  const other = await fresh.shareDeposits(crypto.getRandomValues(new Uint8Array(32)), { router: ROUTER, pools: POOLS.map((p) => ({ pid: p.pid, poolId: p.poolId, token: p.token })), accounts: [FROM], fromBlock: Number(head) - 10 });
  ok(other.length === 0, 'another key sees the same transactions and finds none of them');
  ok(fresh.nextShareIndex({ walletPriv: priv, poolId: POOLS[0].poolId, used: found.filter((f) => f.poolId === POOLS[0].poolId).map((f) => f.index) }) !== zaps[0].index, 'and a zap from that fresh module takes another index than the pending one');
}

// ── 3. the relay settles each deposit into its share note (the same OP_WRAP a wrap takes), through the guest and the pool ──
for (const z of zaps) {
  const r = await ux.submitWrapSettle({ built: z.built, waitOpts: wait, depositTx: z.tx }).catch((e) => ({ error: e }));
  ok(!r.error && await depositStatus(z.built.depositId) === 2n, `${z.p.name}: the share deposit is settled into its note (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
}
const bal = await ux.balance(priv, { bridge: false });
for (const z of zaps) {
  const nt = bal.notes.find((x) => String(x.asset).toLowerCase() === String(z.built.note.asset).toLowerCase());
  ok(nt && BigInt(nt.value) === z.plan.shares && String(nt.owner).toLowerCase() === String(z.built.note.owner).toLowerCase(), `${z.p.name}: the key's balance holds the share note, ${nt?.value} shares (${Math.round((Date.now() - t0) / 1000)} s)`);
  z.note = nt;
}
{
  const left = await mkUx().shareDeposits(priv, { router: ROUTER, pools: POOLS.map((p) => ({ pid: p.pid, poolId: p.poolId, token: p.token })), accounts: [FROM], fromBlock: Number(head) - 10 });
  ok(left.length === 0, 'settled, no zap is pending any more');
}

// ── 4. the share note into the farm (OP_FARM_BOND), and the position the key finds ──
for (const z of zaps.filter((x) => x.p.bond && x.note)) {
  const r = await ux.farmBond({ walletPriv: priv, lpNote: z.note, waitOpts: wait }).catch((e) => ({ error: e }));
  ok(!r.error, `${z.p.name}: the share note is bonded to the farm (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
  const pos = await ux.farmPositions({ walletPriv: priv }).catch((e) => ({ error: e }));
  const mine = Array.isArray(pos) ? pos : pos?.positions || [];
  ok(mine.some((x) => BigInt(x.shares) === z.plan.shares), `${z.p.name}: the key finds its farm position, ${mine.map((x) => x.shares).join(',')} shares`);
}

if (fails) console.error(log.join('\n'));
console.log(`\n${n} passed, ${fails} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
stop();
process.exit(fails ? 1 : 0);
