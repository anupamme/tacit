#!/usr/bin/env node
// tools/community-runner.mjs against the real contracts on mainnet forks (anvil), each mode once dry and once live, sent to the fork only:
//   headers  a fork from about two hours back, where the relay is behind Bitcoin: real headers from the explorer go to advanceTip, the
//            relay's tip on the fork reaches Bitcoin's tip less 2, and the next pass has nothing to send
//   attest   a fork from the block before a real attestBitcoinStateProven landed, its proof published by a stand-in API: the runner
//            lands it, the pool's digest becomes the proof's new digest, and the next pass finds it on chain
//   settles  a fork from the block before a real settle that paid a 0.0062 ETH tETH fee, on a stand-in board: the runner sends it,
//            is paid the fee (its balance moves by the fee less the gas), reports the landing, and passes over it next time
// A dry pass on each fork sends nothing. Nothing reaches mainnet: reads and sends go to the fork; the stand-in API is local.
//
//   node tests/community-runner-fork.mjs [headers,attest,settles]       FORK_URL=<an archive RPC> (default https://eth.drpc.org)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { makeRunner, readConfig, makeSigner, throwawayKey } from '../tools/community-runner.mjs';
import { POOL, SEL_ATTESTED_DIGEST, ethFeeWei } from '../dapp/community-ops.js';

const FORK_URL = process.env.FORK_URL || 'https://eth.drpc.org';
// A fresh key, funded on each fork: anvil's well-known accounts carry EIP-7702 delegations on mainnet, whose code takes the ETH a fee pays.
const KEY = throwawayKey(), RUNNER = makeSigner(KEY).address;
const HEADER_RELAY = '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0';
const ATTEST_TX = '0x9b76182a0f08f0ed41a918303fca4a3135e54214c9a929fbb6a7886bd0231ab8';    // block 26270536, Tacit's prover
const SETTLE_TX = '0xf1e7eb479d4602a6f512066c2c794c458f257ab49a7b4bb53de1f6b5879733c6';    // block 26247159, a 620,000-unit tETH fee
const want = (process.argv[2] || 'headers,attest,settles').split(',');

let failed = 0;
const ok = (c, m, extra = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}${extra ? ` (${extra})` : ''}`); if (!c) failed++; };
async function rpcAt(url, method, params) {
  const j = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
// The arguments of a call with dynamic `bytes` arguments (and settle's bytes[] memos), read back from its calldata.
function args(input) {
  const h = input.replace(/^0x/, '').slice(8);
  const w = (i) => Number(BigInt('0x' + h.slice(i * 64, i * 64 + 64)));
  const bytesAt = (off) => { const n = w(off / 32); return '0x' + h.slice(off * 2 + 64, off * 2 + 64 + n * 2); };
  return { w, bytesAt };
}

async function anvilAt(block) {
  const port = 8600 + Math.floor(Math.random() * 300), url = `http://127.0.0.1:${port}`;
  const proc = spawn('anvil', ['--fork-url', FORK_URL, '--fork-block-number', String(block), '--port', String(port), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try {
      await rpcAt(url, 'eth_blockNumber', []);
      await rpcAt(url, 'anvil_setBalance', [RUNNER, '0xde0b6b3a7640000']);   // 1 ETH for gas
      return { url, stop: () => proc.kill() };
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  proc.kill();
  throw new Error('anvil did not start');
}
// Tacit's API as the runner reads it, answering from `api`; the landings it is told of are kept.
async function standIn(api) {
  const landed = [];
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const send = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname === '/reflection/status') return send(api.status);
    if (u.pathname === '/reflection/proof') return send({ ok: true, proof: api.proof || null });
    if (u.pathname === '/confidential/open') return send({ pool: POOL, jobs: api.jobs || [] });
    if (u.pathname === '/confidential/landed') { landed.push(JSON.parse(body)); return send({ ok: true, status: 'settled' }); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, landed, close: () => server.close() };
}
async function runner(fork, api, env, lines) {
  const cfg = readConfig({ RPC_URL: fork.url, SEND_RPC_URL: fork.url, API_BASE: api.base, ONCE: '1', MAX_GAS_GWEI: '0', ...env }, []);
  const r = makeRunner(cfg, { log: (...a) => { const l = a.join(' '); lines.push(l); console.log('     ', l.slice(0, 200)); } });
  await r.start();
  return r;
}
const nonce = (fork) => rpcAt(fork.url, 'eth_getTransactionCount', [RUNNER, 'latest']).then(Number);

if (want.includes('headers')) {
  console.log('== headers');
  const latest = Number(await rpcAt(FORK_URL, 'eth_blockNumber', []));
  const fork = await anvilAt(latest - 600);
  const tip = async () => Number(BigInt(await rpcAt(fork.url, 'eth_call', [{ to: HEADER_RELAY, data: '0x1fd4827a' }, 'latest'])));
  const before = await tip();
  const btcTip = Number(await fetch('https://blockstream.info/api/blocks/tip/height').then((r) => r.text()));
  // The proofs stand where the relay's confirmed tip is, so the next one waits on headers.
  const api = await standIn({ status: { attestedHeight: before - 24, confirmations: 24 } });
  try {
    ok(btcTip - 2 - before >= 3, `the fork's relay is behind Bitcoin (relay ${before}, Bitcoin ${btcTip})`);
    const lines = [], n0 = await nonce(fork);
    const dry = await runner(fork, api, { DRY_RUN: '1' }, lines);
    await dry.passes.headers();
    ok(lines.some((l) => /DRY_RUN would send advanceTip/.test(l)) && (await tip()) === before && (await nonce(fork)) === n0, 'a dry pass simulates the batch and sends nothing');
    const live = await runner(fork, api, { RUNNER_KEY: KEY }, lines);
    ok(await live.passes.headers(), 'a live pass sends');
    const after = await tip();
    ok(after >= btcTip - 2 - 1 && after > before, `the relay's tip moved to Bitcoin's tip less 2`, `${before} → ${after}`);
    ok((await nonce(fork)) === n0 + Math.ceil((after - before) / 40), 'from the runner’s key, one transaction a batch');
    lines.length = 0;
    ok(!(await live.passes.headers()) && (await nonce(fork)) === n0 + Math.ceil((after - before) / 40), 'the next pass has nothing to send', lines.at(-1));
  } finally { fork.stop(); api.close(); }
}

if (want.includes('attest')) {
  console.log('== attest');
  const tx = await rpcAt(FORK_URL, 'eth_getTransactionByHash', [ATTEST_TX]);
  const fork = await anvilAt(Number(tx.blockNumber) - 1);
  const { w, bytesAt } = args(tx.input);
  const publicValues = bytesAt(w(0)), proof = bytesAt(w(1));
  const pvWord = (i) => '0x' + publicValues.slice(2 + i * 64, 2 + i * 64 + 64);
  const digest = () => rpcAt(fork.url, 'eth_call', [{ to: POOL, data: SEL_ATTESTED_DIGEST }, 'latest']);
  const relayTip = Number(BigInt(await rpcAt(fork.url, 'eth_call', [{ to: HEADER_RELAY, data: '0x1fd4827a' }, 'latest'])));
  const prior = await digest();
  const rec = { priorDigest: prior, newDigest: pvWord(6), attestedTo: Number(BigInt(pvWord(5))), publicValues, proof, at: Date.now() - 10 * 60_000 };
  const api = await standIn({ status: { attestedHeight: relayTip - 24, confirmations: 24 }, proof: rec });
  try {
    ok(pvWord(1) === prior, 'the real proof builds on the fork’s digest');
    const lines = [], n0 = await nonce(fork);
    const dry = await runner(fork, api, { DRY_RUN: '1' }, lines);
    await dry.passes.attest();
    ok(lines.some((l) => /DRY_RUN would send attestBitcoinStateProven/.test(l)) && (await digest()) === prior && (await nonce(fork)) === n0, 'a dry pass simulates the attest and sends nothing');
    const live = await runner(fork, api, { RUNNER_KEY: KEY }, lines);
    ok(await live.passes.attest(), 'a live pass lands it', lines.at(-1));
    ok((await digest()) === rec.newDigest, 'the pool’s digest is the proof’s new digest', rec.newDigest.slice(0, 18));
    lines.length = 0;
    ok(!(await live.passes.attest()) && (await nonce(fork)) === n0 + 1 && lines.some((l) => /on chain, or the pool has moved past it/.test(l)), 'the next pass finds it on chain and sends nothing');
  } finally { fork.stop(); api.close(); }
}

if (want.includes('settles')) {
  console.log('== settles');
  const tx = await rpcAt(FORK_URL, 'eth_getTransactionByHash', [SETTLE_TX]);
  const fork = await anvilAt(Number(tx.blockNumber) - 1);
  const { w, bytesAt } = args(tx.input);
  const memosOff = w(2), count = w(memosOff / 32);
  const memos = Array.from({ length: count }, (_, i) => bytesAt(memosOff + 32 + w(memosOff / 32 + 1 + i)));
  const job = { jobId: '0x' + '5e'.repeat(32), type: 'transfer', status: 'open', posted: false, publicValues: bytesAt(w(0)), proof: bytesAt(w(1)), memos, openSince: Date.now() - 60_000, expiresAt: 0, feeUsd: 20 };
  const fee = ethFeeWei(job.publicValues);
  const api = await standIn({ status: { attestedHeight: 0, confirmations: 24 }, jobs: [job] });
  const balance = () => rpcAt(fork.url, 'eth_getBalance', [RUNNER, 'latest']).then(BigInt);
  try {
    ok(fee === 6_200_000_000_000_000n, 'the real settle pays 0.0062 ETH in tETH');
    const lines = [], n0 = await nonce(fork);
    const dry = await runner(fork, api, { DRY_RUN: '1' }, lines);
    await dry.passes.settles();
    ok(lines.some((l) => /DRY_RUN would send settle 0x5e5e5e5e/.test(l)) && (await nonce(fork)) === n0 && api.landed.length === 0, 'a dry pass simulates the settle and sends nothing');
    const live = await runner(fork, api, { RUNNER_KEY: KEY }, lines);
    const b0 = await balance();
    ok(await live.passes.settles(), 'a live pass sends it');
    if (!api.landed.length) throw new Error('no landing was reported');
    const r = await rpcAt(fork.url, 'eth_getTransactionReceipt', [api.landed[0].txHash]);
    const paid = (await balance()) - b0, gasCost = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
    ok(r.status === '0x1' && r.from.toLowerCase() === RUNNER && r.to.toLowerCase() === POOL.toLowerCase(), 'it landed, from the runner’s key, at the pool');
    ok(paid === fee - gasCost, 'the runner was paid the fee, less its gas', `+${fee} −${gasCost}`);
    ok(api.landed.length === 1 && api.landed[0].jobId === job.jobId, 'and reported the landing');
    lines.length = 0;
    ok((await live.passes.settles()) && lines.some((l) => /would not take it now/.test(l)) && (await nonce(fork)) === n0 + 1, 'the same job again is refused in simulation and not sent');
    ok(!(await live.passes.settles()) && (await nonce(fork)) === n0 + 1, 'and passed over after that');
  } finally { fork.stop(); api.close(); }
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
