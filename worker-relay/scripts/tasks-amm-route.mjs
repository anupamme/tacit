// Builds the task job that deploys TacitAmmRoute (the contract that lets the swap page buy tacUSD and tacBTC with any token in one transaction),
// merging it into
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices
//   dapp/tasks/jobs.json                          what the /tasks page shows
//   dapp/tasks/amm-route-payload.json             the transaction a visitor sends
//
//   (cd contracts && forge build) && node worker-relay/scripts/tasks-amm-route.mjs [--opens <unix secs>] [--rpc <node>] [--no-estimate] [--out <dir>]
//
// The job: one CreateX CREATE2 deployment on Ethereum under an open salt (20 zero bytes and the flag 0x00, which CreateX guards as keccak256(salt)
// alone), so any account can send it and the address is fixed by the contract's exact code. The init code, the salt and the address are
// tests/amm-route-deploy.mjs's, which dapp/swap/route.js and the fork tests check against each other.
//
// Gas is read from the node (`eth_estimateGas` on the step's call, which sends nothing), rounded up to a thousand. The step names its least and
// most, in TAC (below).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { writeJobs } from './tasks-merge.mjs';
import { CREATEX, SALT, ammRouteInit, ammRouteDeployTx, ammRouteAddress } from '../../tests/amm-route-deploy.mjs';
import { keccak_256 } from '@noble/hashes/sha3';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = arg('out');
const SERVICE_OUT = out ? `${out}/service-jobs.json` : `${root}worker-relay/src/lib/points-tasks-jobs.json`;
const PAGE_OUT = out ? `${out}/page-jobs.json` : `${root}dapp/tasks/jobs.json`;
const PAYLOAD_OUT = out ? `${out}/payload.json` : `${root}dapp/tasks/amm-route-payload.json`;

// What the step pays at least and at most, in TAC. The gas of the step (358k) is a few TAC at an ordinary price, so the least is the effort: a person finds the
// job, connects a wallet, pays the gas up front and waits for the block, which the anon.wei job puts at 25 TAC for a step of the same weight, plus the gas at
// about 1 to 3 gwei. The most covers the gas of the step to about 50 gwei, so that a spike does not leave the sender out of pocket.
const JOB = 'amm-route', TAC = 10n ** 18n, BOUNDS = [30n, 200n];
const NODE = arg('rpc', 'https://ethereum-rpc.publicnode.com');
const hex = (b) => `0x${Buffer.from(b).toString('hex')}`;

const tx = ammRouteDeployTx();
const initCodeHash = hex(keccak_256(Buffer.from(ammRouteInit().slice(2), 'hex')));
const expected = getAddress(ammRouteAddress());

async function estimate(data) {
  const r = await (await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_estimateGas', params: [{ from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', to: CREATEX, data }] }), signal: AbortSignal.timeout(30e3) })).json();
  if (r.error) throw new Error(`Ethereum: ${r.error.message}`);
  return Math.ceil(Number(BigInt(r.result)) / 1000) * 1000;
}
let gas;
try { gas = JSON.parse(readFileSync(SERVICE_OUT, 'utf8')).jobs.find((j) => j.id === JOB)?.steps[0].gas; } catch { /* none yet */ }
if (!arg('no-estimate') || !gas) gas = await estimate(tx.data);
console.log(`${JOB}: ${gas} gas, deploys to ${expected}`);

const step = { id: '01-amm-route', kind: 'createx', bound: false, to: CREATEX, gas, expected, salt: SALT, initCodeHash, minWei: String(BOUNDS[0] * TAC), maxWei: String(BOUNDS[1] * TAC) };
const COPY = {
  title: 'Deploy the swap route',
  tagline: 'One contract for the swap page: 1 transaction, from any wallet.',
  about: [
    { h: 'What it does', p: 'Lets the swap page buy tacUSD and tacBTC with any token in one transaction.' },
    { h: 'Who can send it', p: 'Anyone. It has no owner, and its address is fixed by its code.' },
  ],
  links: [],
  verified: true,
  created: [],
  payloadUrl: `/tasks/${JOB}-payload.json`,
};

const opensAt = Number(arg('opens', Math.floor(Date.now() / 1000)));
const kept = { id: step.id, kind: step.kind, to: step.to, gas, expected, salt: SALT, initCodeHash, bound: false, minWei: step.minWei, maxWei: step.maxWei };
const job = { id: JOB, chainId: 1, opensAt, steps: [kept] };
writeJobs(SERVICE_OUT, job);
writeJobs(PAGE_OUT, { ...job, ...COPY, steps: [{ ...kept, label: 'Deploy the contract' }] });
writeFileSync(PAYLOAD_OUT, `${JSON.stringify({ chainId: 1, factory: CREATEX, steps: [{ id: step.id, to: CREATEX, data: tx.data }] })}\n`);
console.log(`1 step; opens ${opensAt}; expected pay between ${BOUNDS[0]} and ${BOUNDS[1]} TAC`);

// The same contract at an earlier address, sent by another account (block 26239991, transaction 0x1b2ffc8538c2ecaba2d460d24f39dbd8c1b54e1b4fa8e5e8193f47dcbbef7150).
// Nobody can deploy it again, so it is a job of its own that is closed to new work: it stays so the service can credit the account that sent that transaction like
// any other, and the page shows it as a done tile (`retired` keeps the front page from counting it as a task to do).
const V1 = { id: 'amm-route-v1', opensAt: 1792573720, gas: 358000, salt: '0x000000000000000000000000000000000000000000834270100000000013697a',
  initCodeHash: '0x3d4ea9feef068cc66146e32e7f114dc41a9d56e991abf03797a2c870af396149', expected: getAddress('0x00000015ff76e81b258a75934dd205998f5a00f7') };
const keptV1 = { id: step.id, kind: 'createx', to: CREATEX, gas: V1.gas, expected: V1.expected, salt: V1.salt, initCodeHash: V1.initCodeHash, bound: false, minWei: step.minWei, maxWei: step.maxWei };
const jobV1 = { id: V1.id, chainId: 1, opensAt: V1.opensAt, steps: [keptV1] };
const COPY_V1 = {
  title: 'Deploy the swap route (earlier address)',
  tagline: 'The same contract at an earlier address: 1 transaction, done.',
  about: [
    { h: 'What it is', p: 'The same contract at another address. The swap page uses the one in the job above.' },
    { h: 'Who is paid', p: 'The account that sent it, like any other step.' },
  ],
  links: [],
  verified: false,
  created: [],
  retired: true,
  payloadUrl: `/tasks/${V1.id}-payload.json`,
};
writeJobs(SERVICE_OUT, jobV1);
writeJobs(PAGE_OUT, { ...jobV1, ...COPY_V1, steps: [{ ...keptV1, label: 'Deploy the contract (earlier address)' }] });
