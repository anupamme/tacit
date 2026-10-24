// Builds the task jobs that open the token pools the relay serves (dapp/evm-pool-tokens.js SERVED: USDC and USDT): one job a token, two
// CreateX deployments each (the pool, then its router, whose constructor reads the pool), merging them into
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices
//   dapp/tasks/jobs.json                          what the /tasks page shows
//   dapp/tasks/token-pool-<token>-payload.json    the transactions a visitor sends
//
//   node worker-relay/scripts/tasks-token-pools.mjs [--opens <unix secs>] [--fork <node>] [--out <dir>]
//
// The deployments are dapp/evm-pool-tokens.js's (deploySteps): open salts (20 zero bytes and the flag 0x00, which CreateX guards as
// keccak256(salt) alone), so any account can send them and each address is fixed by the contract's exact code; the code is the live TAC
// pool's and router's, which token-pool-code.json is checked against. A pool opened in one transaction instead (the swap page's, Multicall3
// calling CreateX twice) shows the same two CreateX logs, so its sender is credited the same way.
//
// Gas is what each step used on a fork of `--fork` (anvil, started here): the router cannot be estimated before its pool is there. Each step
// names its least and most, in TAC (below).
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { writeJobs, readJobs } from './tasks-merge.mjs';
import { makeTokenPools, SERVED, CREATEX } from '../../dapp/evm-pool-tokens.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = arg('out');
const SERVICE_OUT = out ? `${out}/service-jobs.json` : `${root}worker-relay/src/lib/points-tasks-jobs.json`;
const PAGE_OUT = out ? `${out}/page-jobs.json` : `${root}dapp/tasks/jobs.json`;
const payloadOut = (id) => (out ? `${out}/${id}-payload.json` : `${root}dapp/tasks/${id}-payload.json`);

// What a step pays at least and at most, in TAC. At an ordinary price the gas is a few TAC (the pool about 0.83M, its router about 3.6M, as
// the router deploys its box template too), so the least is the effort: a person finds the job, connects a wallet, pays the gas up front and
// waits for two blocks, as the swap route's job (30 TAC for one step of 358k). The most covers each step's gas to about 5 gwei, so a spike
// does not leave the sender out of pocket; the tip (twice the gas) reaches it from about 2.5 gwei.
const TAC = 10n ** 18n, BOUNDS = { pool: [20n, 70n], router: [30n, 280n] };
const LABEL = { pool: 'Deploy the pool', router: 'Deploy its router' };
const FORK = arg('fork', 'https://mainnet.gateway.tenderly.co');
const tp = makeTokenPools({ code: JSON.parse(readFileSync(`${root}dapp/evm-pool/token-pool-code.json`, 'utf8')), keccak256: keccak_256 });
const idOf = (sym) => `token-pool-${sym.toLowerCase()}`;

// Each step sent on a fork, in order, for the gas it used (rounded up to a thousand).
async function measure() {
  const port = 28100 + Math.floor(Math.random() * 300), rpc = `http://127.0.0.1:${port}`;
  const anvil = spawn('anvil', ['--port', String(port), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
  const post = async (method, params = []) => { const j = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
  try {
    for (let i = 0; ; i++) { try { await post('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 200)); } }
    const from = '0x00000000000000000000000000000000000dE9a5';
    await post('anvil_setBalance', [from, '0xde0b6b3a7640000']); await post('anvil_impersonateAccount', [from]);
    const gas = {};
    for (const t of Object.keys(SERVED)) {
      for (const s of tp.deploySteps(t)) {
        if ((await post('eth_getCode', [s.expected, 'latest'])) !== '0x') throw new Error(`${SERVED[t].sym} ${s.kind} is on chain already at ${s.expected}`);
        const h = await post('eth_sendTransaction', [{ from, to: s.to, data: s.data, gas: '0x7a1200' }]);
        let rc = null;
        for (let i = 0; i < 100 && !rc; i++) { rc = await post('eth_getTransactionReceipt', [h]); if (!rc) await new Promise((r) => setTimeout(r, 100)); }
        if (rc?.status !== '0x1' || (await post('eth_getCode', [s.expected, 'latest'])) === '0x') throw new Error(`${SERVED[t].sym} ${s.kind} did not deploy on the fork`);
        gas[`${t}:${s.kind}`] = Math.ceil(Number(BigInt(rc.gasUsed)) / 1000) * 1000;
      }
    }
    return gas;
  } finally { anvil.kill('SIGKILL'); }
}

// a token taken off the served list takes its job with it (nothing was sent for it)
const served = new Set(Object.values(SERVED).map((v) => idOf(v.sym)));
for (const path of [SERVICE_OUT, PAGE_OUT]) {
  const jobs = readJobs(path), kept = jobs.filter((j) => !j.id.startsWith('token-pool-') || served.has(j.id));
  if (kept.length !== jobs.length) writeFileSync(path, `${JSON.stringify({ jobs: kept }, null, 2)}\n`);
}

const gas = await measure();
const opensAt = Number(arg('opens', Math.floor(Date.now() / 1000)));
for (const [t, v] of Object.entries(SERVED)) {
  const id = idOf(v.sym), steps = tp.deploySteps(t);
  const kept = steps.map((s, i) => ({ id: `0${i + 1}-${s.kind}`, kind: 'createx', to: CREATEX, gas: gas[`${t}:${s.kind}`], expected: s.expected, salt: s.salt,
    initCodeHash: s.initCodeHash, bound: false, minWei: String(BOUNDS[s.kind][0] * TAC), maxWei: String(BOUNDS[s.kind][1] * TAC) }));
  const job = { id, chainId: 1, opensAt, steps: kept };
  const COPY = {
    title: `Open the private ${v.sym} pool`,
    tagline: `Two contracts for ${v.sym}’s private pool: 2 transactions, from any wallet.`,
    about: [
      { h: 'What it does', p: `Gives ${v.sym} its own private pool, proved on your device. Swap privately from ${v.sym} goes through it, and the relay serves it.` },
      { h: 'Who can send it', p: 'Anyone. Neither contract has an owner, and their addresses are fixed by their code.' },
    ],
    links: [],
    verified: false,
    created: [],
    payloadUrl: `/tasks/${id}-payload.json`,
  };
  writeJobs(SERVICE_OUT, job);
  writeJobs(PAGE_OUT, { ...job, ...COPY, steps: kept.map((s, i) => ({ ...s, label: LABEL[steps[i].kind] })) });
  writeFileSync(payloadOut(id), `${JSON.stringify({ chainId: 1, factory: CREATEX, steps: steps.map((s, i) => ({ id: kept[i].id, to: s.to, data: s.data })) })}\n`);
  console.log(`${id}: ${kept.map((s) => `${s.id} ${s.gas} gas → ${s.expected}`).join(', ')}`);
}
const lo = Object.values(BOUNDS).reduce((n, [a]) => n + a, 0n), hi = Object.values(BOUNDS).reduce((n, [, b]) => n + b, 0n), k = BigInt(Object.keys(SERVED).length);
console.log(`${k} jobs, 2 steps each; opens ${opensAt}; each job pays between ${lo} and ${hi} TAC, all of them between ${lo * k} and ${hi * k}`);
