// TacitAmmRoute at its earlier address (sent by another account) is credited to the account that sent it, by the points service's own code reading the real transaction
// from the chain: the `amm-route-v1` step is credited once, the open `amm-route` job is not touched, and the step pays what any other step of the job pays.
//   anvil --fork-url <mainnet rpc> --port 8546 --chain-id 1 &
//   FORK_RPC=http://127.0.0.1:8546 node worker-relay/tests/tasks-amm-route-v1-claim.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { openStore } from '../src/lib/points-store.js';
import { createTasks } from '../src/lib/points-tasks-service.js';
import { checkJob } from '../src/lib/points-tasks.js';

const FORK = process.env.FORK_RPC;
if (!FORK) { console.log('skipped - set FORK_RPC to an anvil mainnet fork'); process.exit(0); }
const TAC = 10n ** 18n;
const TX = '0x1b2ffc8538c2ecaba2d460d24f39dbd8c1b54e1b4fa8e5e8193f47dcbbef7150', SENDER = '0x1307143d6cff54b2c6daf7d5619420f78e364bad';
const dir = mkdtempSync(join(tmpdir(), 'tasks-v1-claim-'));
try {
  const all = JSON.parse(readFileSync(new URL('../src/lib/points-tasks-jobs.json', import.meta.url), 'utf8')).jobs;
  const jobs = ['amm-route', 'amm-route-v1'].map((id) => checkJob(all.find((j) => j.id === id)));
  const client = createPublicClient({ chain: mainnet, transport: http(FORK) });
  const rc = await client.getTransactionReceipt({ hash: TX });
  const at = Number((await client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  assert.ok(at >= jobs[1].opensAt, 'the transaction was sent after the job opened');
  const store = openStore(join(dir, 'points.db'));
  for (const dt of [-7200, -3600, -600, 0, 600]) store.saveTaskQuote({ t: at + dt, venue: 'precision', tacPerEth: 10_550n * TAC, gasPrice: 300_000_000n }, 0);
  const tasks = createTasks({
    store, jobs, client, log: () => {}, quote: async (a) => [{ venue: 'precision', amountIn: a, amountOut: a * 10_550n }],
    cfg: { budgetWei: 2_500n * TAC, endSec: 4_000_000_000, tipBps: 10_000n, floorWei: 150n * TAC, capWei: 2_500n * TAC, reserveDays: 2, sampleEverySecs: 1 << 30 },
    budgetFor: () => 1111n * TAC, graceSecs: 1800, fundingInputs: async () => ({ heldWei: 50_000n * TAC, claimedWei: 0n, nextDay: 20_000 }),
  });
  const r = await tasks.claim({ txHashes: [TX] }, { client: 'test' });
  assert.equal(r.status, 200, `the claim is taken: ${JSON.stringify(r.body).slice(0, 200)}`);
  const pending = store.pendingTaskClaims();
  assert.equal(pending.length, 1, 'one step is recorded');
  assert.equal(pending[0].address, SENDER, 'for the account that sent the transaction');
  assert.ok(pending[0].wei >= 30n * TAC && pending[0].wei <= 200n * TAC, `at what the step pays, between its least and most (${Number(pending[0].wei) / 1e18} TAC)`);
  await tasks.cycle();
  const credited = store.creditedWithPrefix('task:');
  assert.equal(String(credited), store.rewardFor(SENDER), 'credited to that account');
  assert.ok(store.creditedWithPrefix('task:amm-route:') === 0n, 'and nothing to the open job, the fixed copy of the contract');
  const view = tasks.view({});
  const v1 = view.jobs.find((j) => j.id === 'amm-route-v1'), open = view.jobs.find((j) => j.id === 'amm-route');
  assert.ok(v1.steps[0].claim && !open.steps[0].claim, 'the first copy shows as claimed and the fixed copy is still open for someone else');
  const again = await tasks.claim({ txHashes: [TX] }, { client: 'test' });
  await tasks.cycle();
  assert.equal(String(store.creditedWithPrefix('task:')), String(credited), 'naming the transaction again credits nothing more');
  console.log(`ok - ${SENDER} is credited ${Number(credited) / 1e18} TAC for the first copy; the fixed copy's step is untouched (a second claim: ${again.status})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
