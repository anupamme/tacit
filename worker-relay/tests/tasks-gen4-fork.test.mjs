// The anon-wei-4 job against anvil forks of Ethereum and Base: the builder makes the job files from the page build and the registry's init
// code, every chunk and the registry on both chains are sent exactly as the payload says (from an ordinary account), and the points
// service's own code (real clients, not stubs) reads each transaction on the chain it names, finds its step by CreateX's own log under the
// job's salts, prices it and credits the sender. The registry's own post is covered by the admin page's test and the unit tests.
//   node worker-relay/tests/tasks-gen4-fork.test.mjs
//   env: PAGE=<tacit-pay folder with out/ and manifest.json>  REGISTRY_INIT=<init code file>  REGISTRY_SALT / REGISTRY_ADDRESS
//        (or SALTS=<checkpoints-salts.json>)  FORK_1 / FORK_8453 to fork from other nodes
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, keccak256 } from 'viem';
import { mainnet } from 'viem/chains';
import { openStore } from '../src/lib/points-store.js';
import { createTasks } from '../src/lib/points-tasks-service.js';
import { checkJob } from '../src/lib/points-tasks.js';

net.setDefaultAutoSelectFamily?.(false);
const PAGE = process.env.PAGE || '/Users/z/dapps-gen4/tacit-pay';
const INIT_FILE = process.env.REGISTRY_INIT;
const SALTS = process.env.SALTS || '/Users/z/tacit-wt-points/contracts/script/checkpoints-salts.json';
if (!INIT_FILE) { console.log('skipped - set REGISTRY_INIT to the registry init code file (and PAGE, SALTS)'); process.exit(0); }
const init = readFileSync(INIT_FILE, 'utf8').trim();
const salts = JSON.parse(readFileSync(SALTS, 'utf8'));
const { salt: REG_SALT, address: REG_ADDR } = process.env.REGISTRY_SALT ? { salt: process.env.REGISTRY_SALT, address: process.env.REGISTRY_ADDRESS } : salts[keccak256(init)];
assert.ok(REG_SALT && REG_ADDR, 'a salt for this init code');

const TAC = 10n ** 18n, GWEI = 10n ** 9n;
const kids = [];
process.on('exit', () => kids.forEach((k) => k.kill('SIGKILL')));
const port = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const forks = {};
for (const [id, url] of [[1, process.env.FORK_1 || 'https://ethereum-rpc.publicnode.com'], [8453, process.env.FORK_8453 || 'https://base.gateway.tenderly.co']]) {
  const p = await port();
  kids.push(spawn('anvil', ['--fork-url', url, '--port', String(p), '--chain-id', String(id), '--silent'], { stdio: 'ignore' }));
  forks[id] = `http://127.0.0.1:${p}`;
}
const rpc = async (chain, method, params = []) => {
  const r = await (await fetch(forks[chain], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
for (const id of Object.keys(forks)) for (let i = 0; i < 100; i++) { try { await rpc(id, 'eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }

const dir = mkdtempSync(join(tmpdir(), 'tasks-gen4-'));
try {
  // The builder, with gas read from the forks (and from the live nodes of the two chains that are not forked).
  execFileSync('node', [new URL('../scripts/tasks-gen4.mjs', import.meta.url).pathname, '--page', PAGE, '--registry-init', INIT_FILE, '--registry-salt', REG_SALT, '--registry-address', REG_ADDR,
    '--min-base', '2', '--min-robinhood', '2', '--opens', '1', '--rpc-1', forks[1], '--rpc-8453', forks[8453], '--out', dir], { stdio: 'inherit' });
  const { jobs } = JSON.parse(readFileSync(join(dir, 'service-jobs.json'), 'utf8'));
  const job = checkJob(jobs.find((j) => j.id === 'anon-wei-4'));
  const payload = JSON.parse(readFileSync(join(dir, 'payload.json'), 'utf8'));
  const page = JSON.parse(readFileSync(join(dir, 'page-jobs.json'), 'utf8')).jobs[0];
  assert.equal(payload.steps.length, job.steps.length);
  assert.deepEqual(page.steps.map((s) => s.id), job.steps.map((s) => s.id), 'the page and the service list the same steps');
  const chunkFiles = readdirSync(`${PAGE}/out`).filter((f) => /^TacitPay8244\.chunk\d+\.creation\.txt$/.test(f)).length;
  assert.equal(job.steps.filter((s) => s.id.includes('-chunk-')).length, chunkFiles, 'a step for every chunk of the page');
  console.log(`ok - the builder made ${job.steps.length} steps (${job.steps.filter((s) => s.kind === 'createx' && s.bound !== false).length} chunks)`);

  // Sent as the payload says, from an ordinary account, on the chains that are forked.
  const sent = [];
  for (const [i, s] of job.steps.entries()) {
    const chain = s.chainId ?? 1, tx = payload.steps[i];
    if (!forks[chain] || s.kind === 'post') continue;
    const [from] = await rpc(chain, 'eth_accounts');
    const hash = await rpc(chain, 'eth_sendTransaction', [{ from, to: tx.to, data: tx.data, value: '0x0' }]);
    let rc = null;
    for (let i = 0; i < 50 && !rc; i++) { rc = await rpc(chain, 'eth_getTransactionReceipt', [hash]); if (!rc) await new Promise((r) => setTimeout(r, 200)); }
    assert.equal(rc.status, '0x1', `${s.id} landed`);
    const code = await rpc(chain, 'eth_getCode', [s.expected, 'latest']);
    assert.ok(code !== '0x', `${s.id}: code at the planned address ${s.expected}`);
    const used = Number(BigInt(rc.gasUsed));
    assert.ok(s.gas >= used * 0.9 && s.gas <= used * 1.6, `${s.id}: the job's gas ${s.gas} is near what it used, ${used}`);
    sent.push({ step: s, chain, hash, from });
  }
  const regOnBase = await rpc(8453, 'eth_call', [{ to: REG_ADDR, data: '0x52bfe789' }, 'latest']);
  assert.equal(BigInt(regOnBase), 0n, 'the registry is there and holds no point yet');
  assert.equal(await rpc(1, 'eth_getCode', [REG_ADDR, 'latest']), await rpc(8453, 'eth_getCode', [REG_ADDR, 'latest']), 'the same code at the same address on both chains');
  console.log(`ok - ${sent.length} steps sent on two chains; each is at its planned address, the registry at ${REG_ADDR} on both`);

  // The service, reading them as the points service would.
  for (const id of [1, 8453]) await rpc(id, 'anvil_mine', ['0x20']);
  const clientOf = (id) => createPublicClient({ chain: { ...mainnet, id }, transport: http(forks[id]) });
  const stub = (id) => ({ getChainId: async () => id });
  const store = openStore(join(dir, 'points.db'));
  const now = Number((await clientOf(1).getBlock()).timestamp);
  for (const dt of [-7200, -3600, -600, 0, 600]) store.saveTaskQuote({ t: now + dt, venue: 'precision', tacPerEth: 9_772n * TAC, gasPrice: 120n * 10n ** 6n }, 0);
  const lowGas = { floor: 1000n, cap: 2n * GWEI };
  const tasks = createTasks({
    store, jobs: [{ ...job, opensAt: 1 }], client: clientOf(1), clients: { 8453: clientOf(8453), 4663: stub(4663), 4326: stub(4326) }, log: () => {}, quote: async (a) => [{ venue: 'precision', amountIn: a, amountOut: a * 9_772n }],
    cfg: { budgetWei: 5_000n * TAC, endSec: 4_000_000_000, tipBps: 10_000n, floorWei: 150n * TAC, capWei: 2_500n * TAC, reserveDays: 2, sampleEverySecs: 1 << 30,
      chains: { 8453: { confirmations: 12, minAgeSecs: 0, gas: lowGas }, 4663: { gas: lowGas }, 4326: { gas: lowGas } } },
    budgetFor: () => 1111n * TAC, graceSecs: 1800, fundingInputs: async () => ({ heldWei: 50_000n * TAC, claimedWei: 0n, nextDay: 20_000 }),
  });
  let total = 0n;
  const paid = [];
  for (const x of sent) {
    const r = (await tasks.claim({ txHashes: [x.hash], ...(x.chain === 1 ? {} : { chainId: x.chain }) }, { client: x.hash })).body.results[0];
    assert.equal(r.status, 'ok', `${x.step.id}: ${r.status}`);
    assert.deepEqual(r.steps.map((s) => s.step), [x.step.id], `${x.step.id} is the one step its transaction completed`);
    const wei = BigInt(r.steps[0].wei);
    assert.ok(wei >= BigInt(x.step.minWei) && wei <= BigInt(x.step.maxWei), `${x.step.id}: ${wei} within its least and most`);
    assert.equal(r.steps[0].address.toLowerCase(), x.from.toLowerCase());
    total += wei; paid.push([x.step.id, Number(wei) / 1e18]);
  }
  // A transaction named on the wrong chain is not found there; named again it is the same claim, not a second one.
  const baseTx = sent.find((x) => x.chain === 8453);
  assert.equal((await tasks.claim({ txHashes: [baseTx.hash] }, { client: 'w' })).body.results[0].status, 'not found', 'a Base transaction named as an Ethereum one is not found');
  assert.equal((await tasks.claim({ txHashes: [baseTx.hash], chainId: 8453 }, { client: 'v' })).body.results[0].steps[0].status, 'queued', 'named again, the same claim');
  await tasks.cycle();
  assert.equal(store.creditedWithPrefix('task:'), total, 'every claim is credited');
  console.log(`ok - the service read ${sent.length} steps on their own chains and credited ${Number(total) / 1e18} TAC to the sender`);
  console.log(paid.map(([id, w]) => `    ${id}: ${w.toFixed(2)} TAC`).join('\n'));
} finally {
  rmSync(dir, { recursive: true, force: true });
  kids.forEach((k) => k.kill('SIGKILL'));
}
