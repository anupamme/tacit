// Task rewards as the points service runs them (rules in lib/points-tasks.js), off unless a tasks budget and an end time are set.
//
// A person does a job's step (sends a transaction), then names its hash: `claim` reads the transaction from the chain, finds
// which steps it completed, fixes each step's reward and records it as a pending claim for the account that sent it. Each cycle
// samples a price quote and credits the pending claims to the ledger, as long as the tasks budget has room and the distributor's
// funding keeps covering the regular daily pot (a claim that waits is credited later, never dropped). The credit is an ordinary
// ledger adjustment, so the next root carries it and nothing about the daily split changes.
//
// deps: store, cfg, jobs (checked job files), client (a viem public client), quote(amountInWei) -> [{ venue, amountIn, amountOut }]
// (lib/tac-quote.js),
// fundingInputs() -> { heldWei, claimedWei, nextDay } | null, budgetFor(day), graceSecs, nowSec, log.
import { fundingStatus } from './points-funding.js';
import { makeTokenBucket } from './token-bucket.js';
import { deepest } from './tac-quote.js';
import { WAD, slowGasPrice, tacPerEthAt, stepReward, stepsCompleted, jobGas, claimId, holdReason } from './points-tasks.js';

const reply = (status, body) => ({ status, body });
const ETH = WAD;
const PRICE_SIZE = WAD / 100n;             // the TAC bought with 0.01 ETH sets the price
const KEEP_QUOTES_SECS = 30 * 86400;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function createTasks({ store, cfg, jobs, client, quote, fundingInputs, budgetFor, graceSecs, nowSec = () => Math.floor(Date.now() / 1000), log = () => {} }) {
  const enabled = cfg.budgetWei > 0n && cfg.endSec > 0 && jobs.length > 0;
  const confirmations = cfg.confirmations ?? 12;
  const sampleEverySecs = cfg.sampleEverySecs ?? 120;
  const allow = makeTokenBucket({ perMin: cfg.claimsPerMin ?? 12, burst: cfg.claimBurst ?? 6 });
  let lastHold = '';

  // ── price quotes ──

  // One reading: the venue that gives the most TAC for one ETH is the deepest, and the TAC that 0.01 ETH buys there is the
  // price. The slow gas price at the chain's latest block is recorded with it, for the live estimates a page shows.
  async function sample() {
    const t = nowSec();
    const last = store.latestTaskQuote();
    if (last && t - last.t < sampleEverySecs) return last;
    const [deep, small, block] = await Promise.all([quote(ETH), quote(PRICE_SIZE), client.getBlock({ blockTag: 'latest', includeTransactions: true })]);
    const best = deepest(deep);
    if (!best) throw new Error('no venue quoted TAC');
    const priced = small.find((q) => q.venue === best.venue);
    if (!priced) throw new Error(`${best.venue} did not quote the small size`);
    const q = { t, venue: best.venue, tacPerEth: (priced.amountOut * ETH) / priced.amountIn, gasPrice: slowGasPrice(block, cfg.gas) };
    store.saveTaskQuote(q, t - KEEP_QUOTES_SECS);
    return q;
  }

  const priceWindow = (t) => store.taskQuotes(t - 21600 - 7200, t + 7200);

  // ── claims ──

  // What a transaction completed, as the reply to its claim: each step with its reward, and what became of it.
  async function claimOne(hash) {
    let tx, receipt, head;
    try {
      [tx, receipt, head] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash }), client.getBlockNumber({ cacheTime: 0 })]);
    } catch { return { txHash: hash, status: 'not found', steps: [] }; }
    if (receipt.status !== 'success') return { txHash: hash, status: 'failed', steps: [] };
    const left = confirmations - Number(head - receipt.blockNumber + 1n);
    if (left > 0) return { txHash: hash, status: 'confirming', confirmationsLeft: left, steps: [] };
    const block = await client.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: true });
    const blockTime = Number(block.timestamp);
    const steps = [];
    const chain = await chainIdOf();
    for (const job of jobs) {
      if (job.chainId !== chain) continue;
      const done = stepsCompleted(job, tx, receipt);
      if (!done.length) continue;
      const jg = jobGas(job);
      for (const { step } of done) {
        const id = claimId(job, step);
        const have = store.taskClaim(id);
        if (have) { steps.push({ job: job.id, step: step.id, ...view1(have), status: have.status === 'credited' ? 'credited' : 'queued' }); continue; }
        if (nowSec() > cfg.endSec) { steps.push({ job: job.id, step: step.id, status: 'ended' }); continue; }
        if (!job.opensAt || blockTime < job.opensAt) { steps.push({ job: job.id, step: step.id, status: 'not open' }); continue; }
        const tacPerEth = tacPerEthAt(priceWindow(blockTime), blockTime);
        if (tacPerEth == null) { steps.push({ job: job.id, step: step.id, status: 'no price yet' }); continue; }
        const gasPriceWei = slowGasPrice(block, cfg.gas);
        const wei = stepReward({ gas: step.gas, jobGas: jg, gasPriceWei, tacPerEth, tipBps: cfg.tipBps, floorWei: cfg.floorWei, capWei: cfg.capWei });
        const quote = { gasPriceWei: String(gasPriceWei), tacPerEth: String(tacPerEth), gas: step.gas, tipBps: String(cfg.tipBps) };
        store.saveTaskClaim({ id, job: job.id, step: step.id, address: tx.from, txHash: hash.toLowerCase(), blockNumber: Number(receipt.blockNumber), blockTime, wei, quote });
        log(`task claim ${id}: ${tx.from} ${wei} wei from ${hash}`);
        steps.push({ job: job.id, step: step.id, ...view1(store.taskClaim(id)), status: 'queued' });
      }
    }
    return { txHash: hash, status: steps.length ? 'ok' : 'no step', steps };
  }

  let chainId = null;
  const chainIdOf = async () => (chainId ??= await client.getChainId());

  const view1 = (c) => ({ address: c.address, wei: String(c.wei), txHash: c.txHash, state: c.status });

  // body: { txHashes: [0x…] }. Anyone may name any transaction: the account credited is the one that sent it.
  async function claim(body, { client: who = 'anon' } = {}) {
    if (!enabled) return reply(404, { error: 'not enabled' });
    if (!allow(who)) return reply(429, { error: 'slow down' });
    const hashes = Array.isArray(body?.txHashes) ? body.txHashes : [];
    if (!hashes.length || hashes.length > 25 || !hashes.every((h) => HASH.test(h))) return reply(400, { error: 'txHashes: 1 to 25 transaction hashes' });
    const results = [];
    for (const h of [...new Set(hashes.map((x) => x.toLowerCase()))]) {
      try { results.push(await claimOne(h)); } catch (err) { log(`task claim ${h} failed:`, err?.message || err); results.push({ txHash: h, status: 'unavailable', steps: [] }); }
    }
    return reply(200, { results });
  }

  // ── crediting ──

  async function applyPending() {
    const pending = store.pendingTaskClaims();
    if (!pending.length) return;
    const inputs = await fundingInputs().catch(() => null);
    let ledger = store.allRewards().reduce((s, r) => s + BigInt(r.cumulativeWei), 0n);
    let credited = store.creditedWithPrefix('task:');
    for (const c of pending) {
      const why = holdReason({
        wei: c.wei, creditedWei: credited, budgetWei: cfg.budgetWei, nowSec: nowSec(), endSec: cfg.endSec, reserveDays: cfg.reserveDays ?? 2,
        status: (extra) => (inputs ? fundingStatus({ heldWei: inputs.heldWei, claimedWei: inputs.claimedWei, ledgerWei: ledger + extra, budgetFor, nextDay: inputs.nextDay, graceSecs }) : null),
      });
      if (why) {
        if (why !== lastHold) { lastHold = why; log(`task credits wait: ${why} (${pending.length} pending)`); }
        if (why === 'ended') break;
        continue;
      }
      if (store.creditTaskClaim(c.id)) { credited += c.wei; ledger += c.wei; lastHold = ''; log(`task credit ${c.id}: ${c.wei} wei to ${c.address}`); }
    }
  }

  async function cycle() {
    if (!enabled) return;
    try { await sample(); } catch (err) { log('task quote failed:', err?.message || err); }
    try { await applyPending(); } catch (err) { log('task credits failed:', err?.message || err); }
  }

  // ── what a page shows ──

  // The live estimate for each step, the budget, and every claim (or one account's, with `address`).
  function view({ address = null } = {}) {
    if (!enabled) return { enabled: false };
    const latest = store.latestTaskQuote();
    const t = nowSec();
    const tacPerEth = latest ? tacPerEthAt(priceWindow(latest.t), latest.t) : null;
    const claims = store.taskClaims().filter((c) => !address || c.address === address.toLowerCase());
    const credited = store.creditedWithPrefix('task:');
    const pendingWei = store.pendingTaskClaims().reduce((s, c) => s + c.wei, 0n);
    const fresh = latest && t - latest.t <= 3600 && tacPerEth != null;
    return {
      enabled: true,
      endSec: cfg.endSec,
      budget: { totalWei: String(cfg.budgetWei), creditedWei: String(credited), pendingWei: String(pendingWei), remainingWei: String(cfg.budgetWei > credited + pendingWei ? cfg.budgetWei - credited - pendingWei : 0n) },
      terms: { tipBps: String(cfg.tipBps), floorWei: String(cfg.floorWei), capWei: String(cfg.capWei) },
      quote: latest ? { t: latest.t, venue: latest.venue, tacPerEthWei: tacPerEth == null ? null : String(tacPerEth), gasPriceWei: latest.gasPrice, fresh } : null,
      jobs: jobs.map((job) => {
        const jg = jobGas(job);
        const steps = job.steps.map((s) => {
          const c = store.taskClaim(claimId(job, s));
          const estimateWei = fresh ? stepReward({ gas: s.gas, jobGas: jg, gasPriceWei: BigInt(latest.gasPrice), tacPerEth, tipBps: cfg.tipBps, floorWei: cfg.floorWei, capWei: cfg.capWei }) : null;
          return { id: s.id, estimateWei: estimateWei == null ? null : String(estimateWei), claim: c ? view1(c) : null };
        });
        return { id: job.id, estimateWei: steps.every((s) => s.estimateWei != null) ? String(steps.reduce((n, s) => n + BigInt(s.estimateWei), 0n)) : null, steps };
      }),
      claims: claims.map((c) => ({ job: c.job, step: c.step, ...view1(c), blockTime: c.blockTime })),
    };
  }

  return { enabled, cycle, claim, view, sample };
}
