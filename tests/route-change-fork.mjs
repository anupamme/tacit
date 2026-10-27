#!/usr/bin/env node
// A private swap from a note larger than the amount, in ONE proof, end to end on a mainnet fork with the real pool module and the LIVE pool and
// AMM: the settle guest's route takes a note that exceeds the amount and returns the remainder as change in the start asset, so no note has to be
// cut to size first (a transfer proof of about 50 s and a relay fee of its own). The 0.02 tETH note is wrapped and settled, then 0.01 tETH of it is
// swapped for TAC by one route op through the job queue, the pinned SETTLE GUEST in SP1 execute mode and pool.settle(); the key then holds the TAC
// note and a 0.01 tETH change note. Then the same swap proved AHEAD of its press (a prove-only job), its proof posted at the press for the relay
// to send, and a proof posted after its note was spent refused with nothing sent. Only the pool's SP1 verifier is replaced.
//
//   node tests/route-change-fork.mjs        (FORK=<rpc url>; EXEC=<the exec-stdin binary>, built from tests/exec-stdin when not given)
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

const procs = [], tmp = mkdtempSync(join(tmpdir(), 'routechange-'));
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
const settleAbi = parseAbi(['function settle(bytes publicValues, bytes proof, bytes[] memos)']);
const settleData = (pv, pf, memos) => encodeFunctionData({ abi: settleAbi, functionName: 'settle', args: [pv, pf, (memos || []).map((m) => (String(m).startsWith('0x') ? m : `0x${m}`))] });
// a posted proof is checked as the relay checks it: the pool must take its settle now
const verifyPosted = async ({ publicValues, proof, memos }) => {
  try { await rpcA('eth_estimateGas', [{ from: SETTLER, to: POOL, data: settleData(publicValues, proof, memos) }]); return { ok: true }; }
  catch (e) { return { ok: false, error: why(e) }; }
};
const settler = makeConfidentialSettler({ storage: store, hash: (str) => keccak256(`0x${Buffer.from(str).toString('hex')}`), sleep: async () => {}, verifyPosted });
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
async function runJob({ jobId: id, type, op, memos: jm, mode }) {
  try {
    const body = { type, op: JSON.parse(JSON.stringify(op)), memos: jm || [] };
    if (process.env.MUTATE === 'share-value' && type === 'wrap') body.op.value = String(BigInt(body.op.value) + 1n);
    const memoHashes = body.memos.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
    const f = join(tmp, `${id.slice(2, 14)}.stdin`), out = join(tmp, `${id.slice(2, 14)}.pv`);
    writeFileSync(f, stdinFor(type, { ...body.op, memoHashes }));
    const t = Date.now(), r = await execGuest({ ...process.env, STDIN: f, OUT: out });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('EXECUTE_OK')) || '';
    if (r.status !== 0 || !existsSync(out)) throw new Error(`the settle guest rejected the op: ${((r.stderr || '') + (r.stdout || '')).split('\n').filter((l) => /panick|assert|error|failed/i.test(l)).slice(0, 3).join(' | ').slice(0, 300)}`);
    log.push(`${type}${mode === 'prove' ? ' (prove only)' : ''}: ${line} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    if (mode === 'prove') { await settler.ackJob(id, { publicValues: `0x${readFileSync(out, 'utf8').trim()}`, proof: '0x' + '11'.repeat(32) }); return; }
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
    try { r = await settler.submitJob({ type: body.type, op: body.op, memos: body.memos, mode: body.mode || 'settle', feeAsset: body.feeAsset || null, exit: body.exit || null,
      publicValues: body.publicValues || null, proof: body.proof || null, early: body.mode === 'prove' && body.ahead === true }); }
    catch (e) { return json(400, { error: String(e.message || e) }); }
    if (body.mode === 'preproven') {
      // a posted proof sits on the open board; the relay takes it and sends its settle
      if (!r.deduped) queue = queue.then(async () => {
        const o = await settler.nextOpen({ id: r.jobId });
        if (!o) return;
        try { const s = await send(SETTLER, POOL, settleData(o.publicValues, o.proof, o.memos)); await settler.ackJob(o.jobId, { txHash: s.hash }); log.push(`posted ${o.type}: sent`); }
        catch (e) { await settler.ackJob(o.jobId, { error: String(e.message || e).slice(0, 300) }); }
      });
    } else queue = queue.then(async () => { const claimed = await settler.nextJob(); if (claimed) await runJob(claimed); });
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
setActiveNetwork('mainnet');
const mkUx = () => makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => globalThis.fetch(u, o), network: 'mainnet' });
const ux = mkUx();
const priv = crypto.getRandomValues(new Uint8Array(32));
ux.identity(priv);
const wait = { timeoutMs: 15 * 60e3, intervalMs: 1000, sleep: (t) => sleep(Math.min(t, 1000)) };
const fmtTac = (u) => (Number(BigInt(u ?? 0)) / 1e8).toFixed(4);
const t0 = Date.now();
const WRAP_TIP = '0x000000D218B03db5837943b0b05DeA2965AE956e', TIPTO = '0x00000000000000000000000000000000000071F0';
const word = (h, i) => BigInt('0x' + String(h).replace(/^0x/, '').slice(i * 64, i * 64 + 64));
const depositStatus = async (id) => word(await rpcA('eth_call', [{ to: POOL, data: '0x7da9874f' + String(id).slice(2).padStart(64, '0') }, 'latest']), 0);
const tac = String(ux.assetByTicker.cTAC.assetId).toLowerCase(), teth = String(ux.assetByTicker.cETH.assetId).toLowerCase();
const notesOf = async (asset) => (await ux.balance(priv, { bridge: false })).notes.filter((n) => String(n.asset).toLowerCase() === asset);
let feeBps = null;
for (const f of [30, 5, 100, 1]) { const lo = BigInt(teth) < BigInt(tac); const r = await ux.poolReserves(ux.routePoolId(lo ? teth : tac, lo ? tac : teth, f)).catch(() => null); if (r && BigInt(r.reserveA) > 0n) { feeBps = f; break; } }
ok(feeBps != null, `the live tETH/TAC pool is found (${feeBps} bps)`);

// ── 1. a 0.02 tETH note: wrapped, then settled ──
const ETH2 = 2n * 10n ** 16n, UNITS = ETH2 / 10n ** 10n, SPEND = UNITS / 2n;
let note;
{
  const index = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
  const built = ux.buildWrap({ walletPriv: priv, amountWei: ETH2, ticker: 'cETH', index });
  await send(FROM, WRAP_TIP, '0xfc24c435' + built.commit.slice(2).padStart(64, '0') + ETH2.toString(16).padStart(64, '0') + TIPTO.slice(2).toLowerCase().padStart(64, '0'), hex(ETH2));
  const r = await ux.submitWrapSettle({ built, waitOpts: wait }).catch((e) => ({ error: e }));
  note = (await notesOf(teth)).find((n) => BigInt(n.value) === UNITS);
  ok(!r.error && await depositStatus(built.depositId) === 2n && note, `a ${UNITS} unit (0.02 tETH) note is in the key's balance (${r.error ? r.error.message : 'settled'})`);
}

// ── 2. half of it swapped for TAC, one route proof, the other half returned as change ──
{
  const path = [{ assetNext: tac, feeBps }], fee = BigInt(await ux.quoteOpFee('cETH', 'route'));
  const q = await ux.quoteRoute({ asset0: teth, amountIn: SPEND, path, fee });
  const minOut = (q.amountOut * 99n) / 100n;
  const r = await ux.route({ walletPriv: priv, inNote: note, amountIn: SPEND, path, minOut, fee, waitOpts: wait }).catch((e) => ({ error: e }));
  const tacNotes = await notesOf(tac), tethNotes = await notesOf(teth);
  ok(!r.error, `the route from the larger note settles in one proof, its relay fee ${fee} units bound in (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
  ok(tacNotes.some((n) => BigInt(n.value) >= minOut), `the key holds the TAC note: ${tacNotes.map((n) => fmtTac(n.value)).join(', ')} TAC (at least ${fmtTac(minOut)})`);
  ok(tethNotes.some((n) => BigInt(n.value) === UNITS - SPEND) && !tethNotes.some((n) => BigInt(n.value) === UNITS), `and a ${UNITS - SPEND} unit tETH change note; the 0.02 note is spent (${tethNotes.map((n) => n.value).join(', ')})`);
}

// ── 3. the same swap proved AHEAD: the key's 0.01 tETH change note, 0.003 of it swapped, its proof made first and posted at the press ──
let change;
{
  const path = [{ assetNext: tac, feeBps }], fee = BigInt(await ux.quoteOpFee('cETH', 'route')), SPEND2 = 300_000n;
  change = (await notesOf(teth)).find((n) => BigInt(n.value) === UNITS - SPEND);
  const q = await ux.quoteRoute({ asset0: teth, amountIn: SPEND2, path, fee }), minOut = (q.amountOut * 99n) / 100n;
  const tac0 = (await notesOf(tac)).length;
  const a = await ux.routeAhead({ walletPriv: priv, inNote: change, amountIn: SPEND2, path, minOut, fee, waitOpts: wait }).catch((e) => ({ error: e }));
  ok(!a.error && a.proven?.publicValues && a.hops.length === 1 && a.out === q.amountOut && a.fee === fee,
    `the route is proved ahead as a prove-only job, its public values made by the guest, pinning the pool's reserves and the relay's fee (${a.error ? a.error.message : `${String(a.proven.publicValues).length / 2 - 1} bytes of public values`})`);
  ok((await notesOf(teth)).some((n) => BigInt(n.value) === UNITS - SPEND) && (await notesOf(tac)).length === tac0, 'proving it ahead settles nothing: the change note is still held and no TAC note is added');
  const r = await ux.routeAheadSend(a, { waitOpts: wait }).catch((e) => ({ error: e }));
  const tacNotes = await notesOf(tac), tethNotes = await notesOf(teth);
  ok(!r.error && r.txHash && tacNotes.length === tac0 + 1 && tacNotes.some((n) => BigInt(n.value) >= minOut),
    `posted at the press, the relay sends it: one settle, a TAC note of at least ${fmtTac(minOut)} TAC (${r.error ? r.error.message : r.txHash.slice(0, 12)}; ${log.slice(-1)[0] || ''})`);
  ok(tethNotes.some((n) => BigInt(n.value) === UNITS - SPEND - SPEND2) && !tethNotes.some((n) => BigInt(n.value) === UNITS - SPEND), `and the change is the rest of the note (${tethNotes.map((n) => n.value).join(', ')})`);
}

// ── 4. a proof posted after its note was spent: refused when it is posted, nothing sent ──
{
  const path = [{ assetNext: tac, feeBps }], fee = BigInt(await ux.quoteOpFee('cETH', 'route')), amt = 200_000n;
  const now = (await notesOf(teth)).find((n) => BigInt(n.value) === UNITS - SPEND - 300_000n);
  const q = await ux.quoteRoute({ asset0: teth, amountIn: amt, path, fee }), minOut = (q.amountOut * 99n) / 100n;
  const a = await ux.routeAhead({ walletPriv: priv, inNote: now, amountIn: amt, path, minOut, fee, waitOpts: wait }).catch((e) => ({ error: e }));
  const spent = await ux.route({ walletPriv: priv, inNote: now, amountIn: 100_000n, path, minOut: 1n, fee, waitOpts: wait }).catch((e) => ({ error: e }));
  const tac1 = (await notesOf(tac)).length, sent0 = log.filter((l) => l.startsWith('posted')).length;
  const r = await ux.routeAheadSend(a, { waitOpts: wait }).catch((e) => ({ error: e }));
  ok(!a.error && !spent.error && r.error && r.error.notPosted === true && (await notesOf(tac)).length === tac1 && log.filter((l) => l.startsWith('posted')).length === sent0,
    `after another swap spent its note the proof made ahead is refused when posted (notPosted), and nothing is sent (${a.error ? a.error.message : spent.error ? spent.error.message : r.error ? r.error.message.slice(0, 140) : 'it was taken'})`);
}

if (fails) console.error(log.join('\n'));
console.log(`\n${n} passed, ${fails} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
stop();
process.exit(fails ? 1 : 0);
