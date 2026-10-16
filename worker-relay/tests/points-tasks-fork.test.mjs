// The task rewards against a real mainnet fork (an anvil fork, FORK_RPC=http://127.0.0.1:8546): the TAC vault package's twenty-one
// steps are sent, some by one account and some by another, and the service claims and credits each to the account that sent it.
//   anvil --fork-url <archive mainnet rpc> --fork-block-number 26201023 --port 8546 --chain-id 1 &   (a block before the live deployment, whose addresses now hold code)
//   FORK_RPC=http://127.0.0.1:8546 PAYLOAD=<dapp/tasks/tac-vaults-payload.json> node worker-relay/tests/points-tasks-fork.test.mjs
// Without FORK_RPC it does nothing, so it can sit with the other tests.

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { openStore } from '../src/lib/points-store.js';
import { createTasks } from '../src/lib/points-tasks-service.js';
import { checkJob, jobGas } from '../src/lib/points-tasks.js';

const FORK = process.env.FORK_RPC;
if (!FORK) { console.log('skipped - set FORK_RPC to an anvil mainnet fork'); process.exit(0); }

const TAC = 10n ** 18n;
const rpc = async (method, params = []) => {
  const r = await (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const receipt = async (hash) => { for (let i = 0; i < 60; i++) { const r = await rpc('eth_getTransactionReceipt', [hash]); if (r) return r; await new Promise((x) => setTimeout(x, 200)); } throw new Error('no receipt'); };

const jobs = JSON.parse(readFileSync(new URL('../src/lib/points-tasks-jobs.json', import.meta.url), 'utf8')).jobs.map(checkJob);
const job = { ...jobs[0], opensAt: 1 };
const payload = JSON.parse(readFileSync(process.env.PAYLOAD ?? new URL('../../dapp/tasks/tac-vaults-payload.json', import.meta.url), 'utf8'));
assert.equal(payload.steps.length, job.steps.length);

const [a0, a1] = await rpc('eth_accounts');
const snap = await rpc('evm_snapshot');
const dir = mkdtempSync(join(tmpdir(), 'tasks-fork-'));
try {
  // The steps, the first ten from one account and the rest from another.
  const sent = [];
  for (const [i, s] of payload.steps.entries()) {
    const from = i < 10 ? a0 : a1;
    const hash = await rpc('eth_sendTransaction', [{ from, to: s.to, data: s.data, value: '0x0' }]);
    const rc = await receipt(hash);
    assert.equal(rc.status, '0x1', `${s.id} succeeds on the fork`);
    sent.push({ id: s.id, from: from.toLowerCase(), hash, block: BigInt(rc.blockNumber) });
  }
  // A second call of a pair that now exists reverts, and is mined as a failure.
  const again = await rpc('eth_sendTransaction', [{ from: a0, to: payload.steps[16].to, data: payload.steps[16].data, value: '0x0', gas: '0x7a120' }]);
  assert.equal((await receipt(again)).status, '0x0', 'the same pair cannot be made twice');
  const plain = await rpc('eth_sendTransaction', [{ from: a0, to: a1, value: '0x1' }]);
  await receipt(plain);

  const client = createPublicClient({ chain: mainnet, transport: http(FORK) });
  const store = openStore(join(dir, 'points.db'));
  const blockTime = Number((await client.getBlock({ blockNumber: sent[0].block })).timestamp);
  for (const dt of [-300, -60, 60, 300]) store.saveTaskQuote({ t: blockTime + dt, venue: 'precision', tacPerEth: 10_000n * TAC, gasPrice: 66_000_000n }, 0);
  const tasks = createTasks({
    store, jobs: [job], client, log: () => {},
    quote: async (amountIn) => [{ venue: 'precision', amountIn, amountOut: (amountIn * 10_000n) }],
    cfg: { budgetWei: 2_500n * TAC, endSec: 4_000_000_000, tipBps: 10_000n, floorWei: 150n * TAC, capWei: 2_500n * TAC, reserveDays: 2, sampleEverySecs: 1 << 30 },
    budgetFor: () => 1111n * TAC, graceSecs: 1800,
    fundingInputs: async () => ({ heldWei: 50_000n * TAC, claimedWei: 0n, nextDay: 20_000 }),
  });
  assert.ok(tasks.enabled);

  // Too soon: the last step has no confirmations yet.
  const soon = await tasks.claim({ txHashes: [sent.at(-1).hash] }, { client: 'a' });
  assert.equal(soon.body.results[0].status, 'confirming', 'a step is credited only once it has confirmations behind it');
  await rpc('anvil_mine', ['0x14']);

  const hashes = sent.map((s) => s.hash);
  const claimed = [];
  for (let i = 0; i < hashes.length; i += 12) {
    const r = await tasks.claim({ txHashes: hashes.slice(i, i + 12) }, { client: `b${i}` });
    assert.equal(r.status, 200);
    claimed.push(...r.body.results);
  }
  for (const [i, r] of claimed.entries()) {
    assert.equal(r.status, 'ok', `${sent[i].id} is a step`);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].address, sent[i].from, `${sent[i].id} is credited to the account that sent it`);
    assert.equal(r.steps[0].status, 'queued');
    assert.ok(BigInt(r.steps[0].wei) > 0n);
  }
  const owed = claimed.reduce((n, r) => n + BigInt(r.steps[0].wei), 0n);
  console.log(`ok - ${claimed.length} steps verified; owed ${Number(owed) / 1e18} TAC`);

  // The failed repeat, the plain transfer and an unknown hash each name no step.
  const odd = await tasks.claim({ txHashes: [again, plain, `0x${'12'.repeat(32)}`] }, { client: 'c' });
  assert.deepEqual(odd.body.results.map((r) => r.status), ['failed', 'no step', 'not found']);

  await tasks.cycle();
  const credited = store.creditedWithPrefix('task:');
  assert.equal(credited, owed, 'every claim is credited, for exactly what it was recorded with');
  assert.equal(BigInt(store.rewardFor(a0)) + BigInt(store.rewardFor(a1)), owed);
  assert.ok(BigInt(store.rewardFor(a0)) > 0n && BigInt(store.rewardFor(a1)) > 0n);

  const replay = await tasks.claim({ txHashes: hashes.slice(0, 3) }, { client: 'd' });
  assert.ok(replay.body.results.every((r) => r.steps[0].status === 'credited'));
  await tasks.cycle();
  assert.equal(store.creditedWithPrefix('task:'), owed, 'a claim named twice is credited once');
  const view = tasks.view();
  assert.equal(view.budget.creditedWei, String(owed));
  console.log('ok - credited once to the sender of each step; failures, transfers and unknown hashes name no step');
  console.log(`  job gas ${jobGas(job)}; a ${view.jobs[0].steps.length}-step view estimate: ${view.jobs[0].estimateWei === null ? 'no fresh quote' : `${Number(view.jobs[0].estimateWei) / 1e18} TAC`}`);
} finally {
  await rpc('evm_revert', [snap]).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
