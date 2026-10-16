// Task rewards for a job whose steps are on several chains (src/lib/points-tasks.js and points-tasks-service.js): a deployment under
// a salt anyone may use (the same address on every chain), a point posted to the catch-up registry, a step's own least and most,
// and claims read on the chain they name.
//   node worker-relay/tests/points-tasks-chains.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, pad, toHex } from 'viem';
import { openStore } from '../src/lib/points-store.js';
import { createTasks } from '../src/lib/points-tasks-service.js';
import { WAD, CREATEX, CONTRACT_CREATION, POSTED, guardedSalt, unboundSalt, stepReward, stepsCompleted, checkJob, stepChain } from '../src/lib/points-tasks.js';

const TAC = WAD, GWEI = 10n ** 9n;
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const SALT = `0x${'00'.repeat(21)}${'cd'.repeat(11)}`;           // 20 zero bytes and the flag 0x00
const REG = A(0xc0de), PLAN = A(0x1234);
const job = checkJob({
  id: 'gen4', chainId: 1, opensAt: 1000, steps: [
    { id: '01-chunk', kind: 'createx', to: CREATEX, gas: 5_000_000, expected: A(0x99), salt: `0x${'00'.repeat(20)}01${'ab'.repeat(11)}`, initCodeHash: `0x${'11'.repeat(32)}`, minWei: String(8n * TAC), maxWei: String(80n * TAC) },
    { id: '02-registry-eth', kind: 'createx', to: CREATEX, gas: 4_200_000, bound: false, expected: REG, salt: SALT, initCodeHash: `0x${'22'.repeat(32)}`, minWei: String(12n * TAC), maxWei: String(80n * TAC) },
    { id: '03-registry-base', chainId: 8453, kind: 'createx', to: CREATEX, gas: 4_200_000, bound: false, expected: REG, salt: SALT, initCodeHash: `0x${'22'.repeat(32)}`, minWei: String(15n * TAC), maxWei: String(40n * TAC) },
    { id: '04-point-base', chainId: 8453, kind: 'post', to: REG, gas: 1_800_000, minSize: 25_000, minWei: String(25n * TAC), maxWei: String(60n * TAC) },
  ],
});

// ── what shows a step ──
{
  assert.equal(stepChain(job, job.steps[0]), 1);
  assert.equal(stepChain(job, job.steps[2]), 8453, 'a step may name its own chain');
  assert.equal(unboundSalt(SALT), keccak256(SALT), 'a salt of 20 zero bytes and 0x00 is guarded as its own hash');
  assert.notEqual(unboundSalt(SALT), guardedSalt(1, SALT));
  const created = (chain, salt = unboundSalt(SALT)) => ({ address: CREATEX, topics: [CONTRACT_CREATION, pad(REG, { size: 32 }), salt], logIndex: 2 });
  const ids = (chain, logs, tx = { from: A(9), to: CREATEX, input: '0x' }) => stepsCompleted(job, tx, { status: 'success', logs }, chain).map((d) => d.step.id);
  assert.deepEqual(ids(1, [created(1)]), ['02-registry-eth'], 'the same salt and address on Ethereum is the Ethereum step');
  assert.deepEqual(ids(8453, [created(8453)]), ['03-registry-base'], 'and on Base the Base step: one transaction on one chain completes that chain\'s steps only');
  assert.deepEqual(ids(10, [created(10)]), [], 'a chain the job has no step on is nothing');
  assert.deepEqual(ids(1, [created(1, guardedSalt(1, SALT))]), [], 'a salt guarded another way is another deployment');
  const post = (size, addr = REG) => ({ address: addr, topics: [POSTED, pad(toHex(size), { size: 32 }), pad(A(7), { size: 32 })], logIndex: 4 });
  assert.deepEqual(ids(8453, [post(25_480)]), ['04-point-base'], 'a point near the pool\'s head, posted to the registry');
  assert.deepEqual(ids(8453, [post(25_000)]), ['04-point-base'], 'the least size exactly');
  assert.deepEqual(ids(8453, [post(24_998)]), [], 'an early point is not the step');
  assert.deepEqual(ids(8453, [post(25_480, A(0xbeef))]), [], 'nor is an event of another contract');
  assert.deepEqual(ids(1, [post(25_480)]), [], 'nor on another chain');
  assert.throws(() => checkJob({ ...job, steps: [{ ...job.steps[3], minSize: 1 }] }), /minSize/);
  assert.throws(() => checkJob({ ...job, steps: [{ ...job.steps[0], minWei: '5', maxWei: '4' }] }), /minWei and maxWei/);
  assert.throws(() => checkJob({ ...job, steps: [{ ...job.steps[0], chainId: 0 }] }), /chainId/);
  assert.throws(() => checkJob({ ...job, steps: [{ ...job.steps[0], bound: 'no' }] }), /createx fields/);
  console.log('ok - a deployment under an open salt, a posted point, and the chain each is read on');
}

// ── what a step pays ──
{
  const p = { jobGas: 20_000_000, tacPerEth: 10_000n * TAC, tipBps: 10_000n, floorWei: 0n, capWei: 10_000n * TAC };
  const pay = (gas, gasPriceWei, o = {}) => stepReward({ ...p, gas, gasPriceWei, ...o });
  assert.equal(pay(4_200_000, 1000n, { minWei: String(15n * TAC), maxWei: String(40n * TAC) }), 15n * TAC, 'a chain where gas costs next to nothing pays the step\'s least');
  assert.equal(pay(5_000_000, 120n * 10n ** 6n, { minWei: String(8n * TAC), maxWei: String(80n * TAC) }), 12n * TAC, 'at 0.12 gwei: 5M gas is 6 TAC, doubled, between its least and most');
  assert.equal(pay(5_000_000, 10n * GWEI, { minWei: String(8n * TAC), maxWei: String(80n * TAC) }), 80n * TAC, 'a spike is held to the step\'s most');
  assert.equal(pay(5_000_000, 10n * GWEI), 1000n * TAC, 'a step with no least and most still takes its share of the job\'s bounds (5M of 20M of 10,000 TAC is 2,500; the gas, doubled, is 1,000)');
  console.log('ok - a step pays its gas with the tip, between its own least and most');
}

// ── claims on several chains ──
const dir = mkdtempSync(join(tmpdir(), 'tasks-chains-'));
try {
  const logsFor = { 1: [], 8453: [] };
  const chain = (id, { head = 500n, time = 5000n, base = 20n * GWEI } = {}) => ({
    getChainId: async () => id,
    getTransaction: async ({ hash }) => { if (!logsFor[id]?.length || hash !== `0x${'01'.repeat(32)}`) throw new Error('not found'); return { from: A(0xaa), to: CREATEX, input: '0x' }; },
    getTransactionReceipt: async ({ hash }) => { if (!logsFor[id]?.length || hash !== `0x${'01'.repeat(32)}`) throw new Error('not found'); return { status: 'success', blockNumber: 100n, logs: logsFor[id] }; },
    getBlockNumber: async () => head,
    getBlock: async () => ({ timestamp: time, baseFeePerGas: base, transactions: [] }),
  });
  const mk = (over = {}) => {
    const store = openStore(join(dir, `svc-${Math.random()}.db`));
    for (const t of [4000, 4500, 5000, 5500]) store.saveTaskQuote({ t, venue: 'precision', tacPerEth: 10_000n * TAC, gasPrice: 1n }, 0);
    const tasks = createTasks({
      store, jobs: [job], client: chain(1), clients: { 8453: over.base ?? chain(8453, { base: 5_000n }) }, log: () => {}, quote: async (a) => [{ venue: 'precision', amountIn: a, amountOut: a * 10_000n }],
      cfg: { budgetWei: 5_000n * TAC, endSec: 9_999_999_999, tipBps: 10_000n, floorWei: 0n, capWei: 10_000n * TAC, reserveDays: 2, confirmations: 12, chains: { 8453: { confirmations: 12, minAgeSecs: over.minAge ?? 0, gas: { floor: 1000n, cap: 2n * GWEI } } } },
      budgetFor: () => 1_111n * TAC, graceSecs: 1800, nowSec: () => over.now ?? 6000, fundingInputs: async () => ({ heldWei: 50_000n * TAC, claimedWei: 0n, nextDay: 100 }),
    });
    return { tasks, store };
  };
  const hash = `0x${'01'.repeat(32)}`;
  logsFor[8453] = [{ address: CREATEX, topics: [CONTRACT_CREATION, pad(REG, { size: 32 }), unboundSalt(SALT)], logIndex: 1 }];
  {
    const { tasks, store } = mk();
    const r = (await tasks.claim({ txHashes: [hash], chainId: 8453 }, { client: 'a' })).body.results[0];
    assert.equal(r.status, 'ok');
    assert.equal(r.steps[0].step, '03-registry-base');
    assert.equal(BigInt(r.steps[0].wei), 15n * TAC, 'on Base the block\'s own gas price is used (a few thousand wei), so the step\'s least pays');
    assert.equal(store.taskClaim('task:gen4:03-registry-base').quote.chainId, 8453, 'the claim records its chain');
    // the same transaction named without the chain is read on Ethereum, where it is not found
    assert.equal((await tasks.claim({ txHashes: [hash] }, { client: 'b' })).body.results[0].status, 'not found');
    assert.equal((await tasks.claim({ txHashes: [hash], chainId: 10 }, { client: 'c' })).status, 400, 'a chain no job is on is refused');
    console.log('ok - a claim is read on the chain it names, and priced from that chain\'s block');
  }
  {
    const { tasks } = mk({ minAge: 2000 });
    const r = (await tasks.claim({ txHashes: [hash], chainId: 8453 }, { client: 'd' })).body.results[0];
    assert.equal(r.status, 'confirming', 'a block younger than the chain\'s least age is not final');
    console.log('ok - a chain with quick blocks waits for the block to be old enough');
  }
  {
    const lying = { ...chain(8453, { base: 5_000n }), getChainId: async () => 1 };          // a node that serves the transaction but says it is another chain
    assert.throws(() => createTasks({ store: openStore(join(dir, 'x.db')), jobs: [job], client: chain(1), clients: {}, quote: async () => [], cfg: { budgetWei: 1n, endSec: 5 }, fundingInputs: async () => null, budgetFor: () => 0n }), /no client for/, 'a job on a chain the service cannot read refuses to start');
    const { tasks } = mk({ base: lying });
    assert.equal((await tasks.claim({ txHashes: [hash], chainId: 8453 }, { client: 'e' })).body.results[0].status, 'unknown chain', 'a node on another chain credits nothing');
    console.log('ok - a job needs a client for each of its chains, and a client must answer for its own');
  }
  {
    const { tasks } = mk();
    await tasks.cycle();
    const v = tasks.view();
    const steps = v.jobs[0].steps;
    assert.equal(steps.find((s) => s.id === '03-registry-base').chainId, 8453);
    assert.equal(steps.find((s) => s.id === '01-chunk').chainId, 1);
    assert.ok(steps.every((s) => s.estimateWei != null), 'every step has an estimate once each chain\'s price is read');
    console.log('ok - the view names each step\'s chain and prices it from that chain');
  }
  {
    // A restart a moment after the last price sample still reads each chain's own gas price for its steps' estimates.
    const { tasks, store } = mk();
    store.saveTaskQuote({ t: 5990, venue: 'precision', tacPerEth: 10_000n * TAC, gasPrice: 1n }, 0);
    await tasks.cycle();
    assert.ok(tasks.view().jobs[0].steps.every((s) => s.estimateWei != null), 'every step is priced though no new price sample was due');
    console.log('ok - other chains\' gas is read even when a recent price sample is kept');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
