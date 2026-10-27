#!/usr/bin/env node
// A week of farming, then the reward sent on as wTAC, end to end on a mainnet fork, with the real pool module and the LIVE pool, router, AMM
// and farm: 0.1 ETH is zapped into a tETH/TAC share note and bonded to the farm (the relay's sponsored moves, no fee), a week passes, the
// position is harvested with no fee into a private wTAC note, part of it is sent to another key by a stealth lock (its split paying the relay
// in wTAC, valued as TAC), that key claims it (its fee in wTAC too) and finds the wTAC note in its balance, and the rest is sent by the relay
// to an outside address as wTAC, which that address turns into TAC one for one. Each op runs through the worker's job queue, the pinned
// SETTLE GUEST in SP1 execute mode and pool.settle(); only the pool's SP1 verifier is replaced.
//
//   node tests/farm-reward-send-fork.mjs        (FORK=<rpc url>; EXEC=<the exec-stdin binary>, built from tests/exec-stdin when not given)
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

const procs = [], tmp = mkdtempSync(join(tmpdir(), 'reward-send-'));
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
const fmtTac = (u) => (Number(BigInt(u ?? 0)) / 1e8).toFixed(4);
const word = (h, i) => BigInt('0x' + String(h).replace(/^0x/, '').slice(i * 64, i * 64 + 64));
const depositStatus = async (id) => word(await rpcA('eth_call', [{ to: POOL, data: '0x7da9874f' + String(id).slice(2).padStart(64, '0') }, 'latest']), 0);
const t0 = Date.now();
// the chain is moved a week on below; the module's deadlines follow it
let skew = 0;
{ const real = Date.now.bind(Date); Date.now = () => real() + skew; }
const p = POOLS[0], WTAC = '0x2018139a8fdd3666855be3315c7683b4d6ab7aef', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', OUT = '0x00000000000000000000000000000000000aBcD1';
const erc20 = (token, who) => rpcA('eth_call', [{ to: token, data: '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest']).then((r) => BigInt(r));
const rwd = String(ux.cfg.farm.rewardAsset).toLowerCase();
const rwdNotes = async (k, x) => (await x.balance(k, { bridge: false })).notes.filter((n) => String(n.asset).toLowerCase() === rwd);

// ── 1. 0.1 ETH zapped into a tETH/TAC share note: one transaction, then the relay settles the deposit into the note ──
let share;
{
  const res = await ux.poolReserves(p.poolId);
  const plan = zapPlan({ eth: 10n ** 17n, ra: res.reserveA, rb: res.reserveB, total: res.totalShares, feeBps: BigInt(res.feeBps ?? 30) });
  const index = ux.nextShareIndex({ walletPriv: priv, poolId: p.poolId, owned: [] });
  const built = ux.buildShareWrap({ walletPriv: priv, poolId: p.poolId, shares: plan.shares, index });
  const data = zapCalldata({ plan, router: ROUTER, amm: AMM, tokenB: p.token, assetA: res.assetA, assetB: res.assetB, feeBps: Number(res.feeBps ?? 30), deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), commit: built.commit });
  const s = await send(FROM, ROUTER, data, hex(plan.value));
  const r = await ux.submitWrapSettle({ built, waitOpts: wait, depositTx: s.hash }).catch((e) => ({ error: e }));
  share = (await ux.balance(priv, { bridge: false })).notes.find((x) => String(x.asset).toLowerCase() === String(built.note.asset).toLowerCase());
  ok(!r.error && share && BigInt(share.value) === plan.shares, `0.1 ETH zapped into ${p.name}: a ${share?.value} share note (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
}

// ── 2. bonded to the farm, with no fee ──
let pos;
{
  const r = await ux.farmBond({ walletPriv: priv, lpNote: share, waitOpts: wait }).catch((e) => ({ error: e }));
  pos = (await ux.farmPositions({ walletPriv: priv }).catch(() => [])).find((x) => BigInt(x.shares) === BigInt(share.value));
  ok(!r.error && !!pos, `bonded to the farm: a position of ${pos?.shares} shares (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
}

// ── 3. a week on, the position has earned, and is harvested with no fee into a private wTAC note ──
let reward;
{
  const week = 7 * 86400;
  await rpcA('evm_increaseTime', [week]); await rpcA('evm_mine', []);
  skew = week * 1000;
  [pos] = await ux.refreshFarmPending([pos]);
  const r = await ux.farmHarvest({ walletPriv: priv, position: pos, fee: 0n, waitOpts: wait }).catch((e) => ({ error: e }));
  reward = (await rwdNotes(priv, ux))[0];
  ok(!r.error && reward && BigInt(reward.value) === BigInt(r.net), `a week on it had earned ${fmtTac(pos.pendingUnits)} TAC; harvested with no fee into a private ${fmtTac(reward?.value)} wTAC note (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
}

// ── 4. a third of it to another key, privately: the split pays the relay in wTAC, the stealth lock carries no fee ──
const rpriv = crypto.getRandomValues(new Uint8Array(32)), rid = ux.identity(rpriv), part = BigInt(reward.value) / 3n;
{
  const fee = await ux.quoteOpFee('cTAC', 'transfer');
  const r = await ux.stealthSend({ walletPriv: priv, recipientPubHex: rid.pubHex, notes: [reward], amount: part, waitOpts: wait }).catch((e) => ({ error: e }));
  const left = (await rwdNotes(priv, ux)).reduce((a, n) => a + BigInt(n.value), 0n);
  ok(!r.error && left === BigInt(reward.value) - part - BigInt(fee), `${fmtTac(part)} wTAC locked to the other key's stealth address, the split's relay fee ${fmtTac(fee)} wTAC, ${fmtTac(left)} wTAC left (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
}

// ── 5. the other key finds the payment and claims it, its claim's relay fee in wTAC ──
const rux = mkUx();
{
  const { mine, lockSetRoot } = await rux.scanStealthLocks({ walletPriv: rpriv });
  const lock = (mine || []).find((l) => String(l.asset).toLowerCase() === rwd && !l.spent);
  const fee = BigInt(await rux.quoteOpFee('cTAC', 'stealthclaim'));
  ok(!!lock && BigInt(lock.amount) === part, `the other key finds a ${lock ? fmtTac(lock.amount) : 'no'} wTAC payment`);
  const r = lock ? await rux.stealthClaim({ walletPriv: rpriv, lockRecord: lock, lockSetRoot, fee, waitOpts: wait }).catch((e) => ({ error: e })) : { error: new Error('no lock') };
  const got = await rwdNotes(rpriv, rux);
  ok(!r.error && got.length === 1 && BigInt(got[0].value) === part - fee, `and claims it, the relay fee ${fmtTac(fee)} wTAC: its balance holds a private ${fmtTac(got[0]?.value)} wTAC note (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
}

// ── 6. the rest, less a little, sent by the relay to an outside address as wTAC, which that address turns into TAC ──
{
  const note = (await rwdNotes(priv, ux)).sort((a, b) => (BigInt(a.value) > BigInt(b.value) ? -1 : 1))[0], amount = BigInt(note.value) * 9n / 10n;
  const w0 = await erc20(WTAC, OUT), t0b = await erc20(TAC, OUT);
  const r = await ux.sendUnwrap({ note, walletPriv: priv, recipient: OUT, amount, waitOpts: wait }).catch((e) => ({ error: e }));
  const got = (await erc20(WTAC, OUT)) - w0, scale = BigInt(ux.cfg.farm.unitScale || 10n ** 10n), fee = r.error ? 0n : amount - got / scale;
  ok(!r.error && got > 0n && fee > 0n && fee < amount / 10n, `${fmtTac(amount)} wTAC sent by the relay to ${OUT.slice(0, 8)}…: ${fmtTac(got / scale)} wTAC there, the relay fee ${fmtTac(fee)} out of it (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
  await rpcA('anvil_impersonateAccount', [OUT]); await rpcA('anvil_setBalance', [OUT, hex(10n ** 18n)]);
  const w = await send(OUT, WTAC, '0x00f714ce' + got.toString(16).padStart(64, '0') + OUT.slice(2).toLowerCase().padStart(64, '0')).catch((e) => ({ error: e }));
  const tac = (await erc20(TAC, OUT)) - t0b;
  ok(!w.error && tac === got && (await erc20(WTAC, OUT)) === w0, `that address turns it into ${fmtTac(tac / scale)} TAC, one for one (${w.error ? w.error.message : BigInt(w.rc.gasUsed) + ' gas'})`);
}

if (fails || process.env.SHOW_LOG) (fails ? console.error : console.log)(log.join('\n'));
console.log(`\n${n} passed, ${fails} failed (${Math.round((Date.now() - t0 - skew) / 1000)} s)`);
stop();
process.exit(fails ? 1 : 0);
