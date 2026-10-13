// ─────────────────────────────────────────────────────────────────────────────
// Header feeder — keeps the on-chain BitcoinLightRelay current so reflection can attest.
//
// Render service type: Cron Job. NO proving — just: read the relay tip + BTC tip, fetch the raw 80-byte
// headers for the gap, and submit advanceTip(bytes) on-chain (RELAY_KEY pays gas, ~cheap).
//
// PACING (the one subtlety): reflection's attest tip must sit at or below relayTip-CONFIRMATIONS, and
// the pool tolerates it sitting up to REFLECTION_MAX_LAG further below, so a relay that has run ahead
// never locks reflection out — it just makes reflection's next batches lag, and the pool's anchor
// walk costs one parent read per block of that lag. So the lead is a COST cap, not a correctness one:
// we target relay tip = min(btcTip-2, reflectionAttested + headerLead) to keep the two loops roughly in
// step and each attest's walk short, then hold at the tip.
// ─────────────────────────────────────────────────────────────────────────────

import { CFG, ADDR } from './lib/config.js';
import { withNonceRetry } from './lib/nonce-retry.js';
import { publicClient, relayWallet, HEADER_RELAY, RELAY_ABI, gasAboveCap } from './lib/chain.js';
import { planHeaderAdvance } from './lib/header-plan.js';
import { cbtcLockDemand } from './lib/reflection-demand.js';
import { tipFor, TIP_HISTORY_BLOCKS, TIP_PERCENTILE } from './lib/gas-tip.js';
import { tipLadder, sendPatient, raised } from './lib/patient-send.js';
import { baseFeeWait, headerTimeSec } from './lib/base-fee-wait.js';

const log = (...a) => console.log(`[header ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const ESPLORAS = CFG.btcEsplora.split(',').map((s) => s.trim()).filter(Boolean);

async function esplora(path) {
  let err;
  for (let a = 0; a < ESPLORAS.length * 3; a++) {
    const base = ESPLORAS[a % ESPLORAS.length];
    try { const r = await fetch(base + path); if (!r.ok) throw new Error(`${r.status}`); return (await r.text()).trim(); }
    catch (e) { err = e; await sleep(0.5 * (a + 1)); }
  }
  throw new Error(`esplora ${path}: ${err?.message}`);
}
const btcTip = async () => parseInt(await esplora('/blocks/tip/height'), 10);
async function headerHex(h) {
  const hash = await esplora(`/block-height/${h}`);
  const hdr = await esplora(`/block/${hash}/header`);
  if (!/^[0-9a-fA-F]{160}$/.test(hdr)) throw new Error(`bad header @${h} (${hdr.slice(0, 16)}…)`);
  return hdr;
}
// A ready batch holds for a cheaper block, for a bounded time (lib/base-fee-wait.js). HEADER_BASEFEE_WAIT=0 turns it off.
const BASEFEE_WAIT = process.env.HEADER_BASEFEE_WAIT !== '0';
const BASEFEE_BLOCKS = Number(process.env.HEADER_BASEFEE_BLOCKS || 1000);
const BASEFEE_PERCENTILE = Number(process.env.HEADER_BASEFEE_PERCENTILE || 40);
const BASEFEE_RATIO = Number(process.env.HEADER_BASEFEE_RATIO || 1);
const BASEFEE_MAX_WAIT_SEC = Number(process.env.HEADER_BASEFEE_MAX_WAIT_MIN || 120) * 60;
// `readyHeight`: the header whose arrival made this a full batch; its own time says how long the batch has been ready.
async function baseFeeGate(readyHeight) {
  const [hist, hdr] = await Promise.all([
    publicClient.getFeeHistory({ blockCount: BASEFEE_BLOCKS, rewardPercentiles: [50] }),
    headerHex(readyHeight),
  ]);
  const fees = hist.baseFeePerGas || [], nextBase = fees.length ? fees[fees.length - 1] : null, t = headerTimeSec(hdr);
  const readyAgeSec = t == null ? NaN : Date.now() / 1000 - t;
  return { ...baseFeeWait({ history: fees.slice(0, -1), nextBase, readyAgeSec, maxWaitSec: BASEFEE_MAX_WAIT_SEC, percentile: BASEFEE_PERCENTILE, ratio: BASEFEE_RATIO }), nextBase, readyAgeSec };
}
const relayTip = async () => Number(await publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'tipHeight' }));
const relayTipHash = async () => publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'tip' });
const relayParent = async (h) => publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'blockParent', args: [h] });
// Explorer hashes are displayed byte-reversed; the relay keys blocks by the header's internal byte order.
const relayKey = (explorerHash) => `0x${explorerHash.replace(/^0x/, '').toLowerCase().match(/../g).reverse().join('')}`;
const relayKnows = async (explorerHash) => (await publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'blockWork', args: [relayKey(explorerHash)] })) > 0n;

// The relay keys blocks by the hash as it appears in the header (internal byte order); explorers display
// the byte-reversed form. Accept either so the comparison never hinges on one convention.
const sameBlock = (relayHash, explorerHash) => {
  const a = relayHash.replace(/^0x/, '').toLowerCase();
  const b = explorerHash.replace(/^0x/, '').toLowerCase();
  return a === b || a === b.match(/../g).reverse().join('');
};

// The height the next submission continues from. Normally the relay's tip is on the canonical chain and that
// is simply its tip height. If the relay's tip sits on a branch the network has since abandoned (a reorg, a
// header taken from a lagging explorer, or a branch someone else submitted), every submission from tipHeight+1
// would build on that branch or fail with UnknownParent. The relay accepts a branch from ANY block it knows
// (heaviest-chain fork choice, every header PoW-checked), so walk its tip back through blockParent to the last
// block the explorer still agrees on, at any depth, and resubmit the explorer chain from there: submitting the
// honest chain is always safe. A fork deeper than `alertDepth` is not normal network behaviour, so it is also
// raised through `onDeepFork` — but the feeder keeps restoring the canonical tip rather than stopping.
// A restore can take several batches while the abandoned branch still carries more work, so the explorer blocks
// the relay already stores past the common ancestor (`isKnown`, up to `maxHeight`) are skipped: each cycle then
// continues the honest branch instead of resubmitting its first batch. Pure over its readers so it is testable.
export async function findResumeHeight({ tipHeight, tipHash, parentOf, explorerHashAt, isKnown, maxHeight, alertDepth, onDeepFork }) {
  let hash = tipHash;
  for (let h = tipHeight; h >= 0; h--) {
    if (sameBlock(hash, await explorerHashAt(h))) {
      const depth = tipHeight - h;
      if (depth > alertDepth && onDeepFork) await onDeepFork({ depth, height: h, tipHeight });
      let height = h;
      if (depth > 0 && isKnown) {
        while (height + 1 <= maxHeight && await isKnown(await explorerHashAt(height + 1))) height++;
      }
      return { height, depth, ancestor: h };
    }
    hash = await parentOf(hash);
    if (!hash || /^(0x)?0*$/.test(String(hash))) break; // walked past the relay's first known block
  }
  throw new Error(`relay tip shares no block with the explorer chain in the relay's known history (tip ${tipHeight})`);
}

async function alert(msg, extra = {}) {
  log(`CRITICAL: ${msg}`, extra);
  if (!CFG.alertWebhookUrl) return;
  try {
    await fetch(CFG.alertWebhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[tacit-relay critical] ${msg}`, level: 'critical', ...extra }),
    });
  } catch (e) { log('webhook post failed:', e.message); }
}

async function resumeHeight(rtip, btip) {
  const r = await findResumeHeight({
    tipHeight: rtip,
    tipHash: await relayTipHash(),
    parentOf: relayParent,
    explorerHashAt: (h) => esplora(`/block-height/${h}`),
    isKnown: relayKnows,
    maxHeight: btip - 2,
    alertDepth: CFG.headerReorgDepth,
    onDeepFork: ({ depth: d, height: h }) => alert(`header relay tip was on a ${d}-block branch the explorer chain abandoned; resubmitting the canonical chain from ${h}`, { depth: d, height: h, relayTip: rtip }),
  });
  if (r.depth > 0) log(`relay tip is on an abandoned branch (${r.depth} blocks past ${r.ancestor}) — continuing the canonical chain from ${r.height}`);
  return r;
}

// A node refuses a send whose gas limit times fee cap is more than the wallet holds, so on a thin wallet a full
// batch is refused outright while a shorter one would land. The cap is set here, at twice the base fee plus the
// tip (a three-minute cron never outgrows it), rather than left to the client, whose default reserves several
// times what an advance costs; and the batch is cut to what the wallet covers. The next run carries on from
// wherever this one stops. Returns the transaction and the height it advanced to.
//
// The wallet also pays for the reflection's attests, and for users' settles unless those have their own key
// (SETTLE_ADDRESS names another wallet), so headers never spend into what those need: one attest, and one settle
// where it applies, each at the fee cap its own service sends with, stay behind.
const MIN_TIP_WEI = 50_000_000n; // 0.05 gwei: only a fallback now, for when the fee history cannot be read
// What recent blocks actually paid, floored on what a batch offers in TOTAL rather than per gas (lib/gas-tip.js). A rate
// fixed when gas was dear is the overpayment worth removing here: a batch runs to millions of gas (measured on this
// relay's own advances, ~177k per header), so the tip is the larger part of its cost and the market reading is what
// binds. GAS_PER_HEADER only sizes the total floor; the real limit is estimated per send below.
// Headers are in no hurry, so the first offer is the cheap end of what blocks accept (the 10th-percentile tip, never under
// 0.001 gwei), and it is raised toward the market tip only if nobody takes it within HEADER_TIP_WAIT_MS. The relay's own attests
// pay no tip at all and land in about 30 s, so a cheap offer is taken; the old offer, the median, was 0.05 gwei on a 0.08 gwei
// base fee (2026-10-13), 38% of what a 20-header batch paid.
const MIN_TIP_TOTAL_WEI = BigInt(process.env.HEADER_TIP_MIN_TOTAL_WEI || '0');
const TIP_CAP_WEI = BigInt(process.env.HEADER_TIP_CAP_WEI || '2000000000'); // 2 gwei
const PATIENT_PERCENTILE = Number(process.env.HEADER_TIP_PERCENTILE || 10);
const TIP_FLOOR_RATE_WEI = BigInt(process.env.HEADER_TIP_FLOOR_WEI || '1000000'); // 0.001 gwei
const TIP_WAIT_MS = Number(process.env.HEADER_TIP_WAIT_MS || 90_000);
const GAS_PER_HEADER = 180_000n;
const SETTLE_RESERVE_GAS = CFG.settleFundsGas;   // settle-relay's fee cap: 3x base
const ATTEST_RESERVE_GAS = CFG.attestGasBudget;  // reflection's fee cap: 2x base
const eth = (wei) => (Number(wei) / 1e18).toFixed(4);
// One percentile's column of an eth_feeHistory reward table (each row holds the requested percentiles, in order).
const rewardColumn = (hist, k) => (hist && Array.isArray(hist.reward) ? hist.reward.map((r) => (Array.isArray(r) ? r[k] : null)) : null);
async function submitAdvance(from, to) {
  const [blk, feeHist, have] = await Promise.all([
    publicClient.getBlock({ blockTag: 'latest' }),
    publicClient.getFeeHistory({ blockCount: TIP_HISTORY_BLOCKS, rewardPercentiles: [PATIENT_PERCENTILE, TIP_PERCENTILE] }).catch(() => null),
    publicClient.getBalance({ address: relayWallet.account.address }),
  ]);
  // The gas here is the batch this run means to send. It can still be cut to fit the wallet below, which only leaves the
  // total floor a shade conservative — at this size the market reading binds anyway.
  const gas0 = BigInt(Math.max(1, to - from + 1)) * GAS_PER_HEADER, col = (k) => (rewardColumn(feeHist, k));
  const market = tipFor({ rewards: col(1), gas: gas0, minTotalWei: MIN_TIP_TOTAL_WEI, capWei: TIP_CAP_WEI, fallbackWei: MIN_TIP_WEI });
  const cheap = tipFor({ rewards: col(0), gas: gas0, minTotalWei: MIN_TIP_TOTAL_WEI, capWei: TIP_CAP_WEI, fallbackWei: market });
  // The cheap offer is never over the market and never under the floor rate; with no reading at all both are the old fixed rate.
  const patient = cheap > market ? market : cheap;
  const tips = tipLadder({ patient: patient < TIP_FLOOR_RATE_WEI ? TIP_FLOOR_RATE_WEI : patient, market, capWei: TIP_CAP_WEI });
  const maxPriorityFeePerGas = tips[0];
  const maxFeePerGas = (blk.baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas;
  const base = blk.baseFeePerGas ?? 0n;
  const settlesHere = !CFG.settleAddress || CFG.settleAddress.toLowerCase() === relayWallet.account.address.toLowerCase();
  const reserve = (settlesHere ? SETTLE_RESERVE_GAS * (base * 3n + maxPriorityFeePerGas) : 0n) + ATTEST_RESERVE_GAS * (base * 2n + maxPriorityFeePerGas);
  const budget = have > reserve ? have - reserve : 0n;
  const headers = [];
  for (let h = from; h <= to; h++) headers.push(await headerHex(h));
  for (;;) {
    const advanceCall = { address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'advanceTip', args: [`0x${headers.slice(0, to - from + 1).join('')}`] };
    const gas = ((await publicClient.estimateContractGas({ ...advanceCall, account: relayWallet.account })) * 125n) / 100n;
    const need = gas * maxFeePerGas;
    if (need > budget) {
      // Gas is close to linear in the header count; one header of margin covers the fixed part.
      const n = to - from + 1;
      const fits = Math.floor((n * Number(budget)) / Number(need)) - 1;
      const kept = settlesHere ? 'settles and attests' : 'attests';
      if (fits < 1) throw new Error(`relay wallet holds ${eth(have)} ETH and keeps ${eth(reserve)} for ${kept}; one header costs ${eth(need / BigInt(n))} ETH at today's gas: top it up`);
      log(`relay wallet holds ${eth(have)} ETH (${eth(reserve)} kept for ${kept}), enough for ${fits} of ${n} headers at today's gas — advancing to ${from + fits - 1}`);
      to = from + fits - 1;
      continue;
    }
    // Same shared-key nonce race as the reflection attest (see lib/nonce-retry.js). Cheap to lose here — the
    // next cron run is three minutes away — but retrying keeps the relay's pacing steady under load.
    let lastFee = maxFeePerGas;
    const landed = await sendPatient({
      tips, waitMs: TIP_WAIT_MS, log,
      // The first offer takes the wallet's next nonce; a raise reuses it, with a fee cap refreshed to the base fee now and at
      // least the raise a node asks for.
      send: async ({ tip, nonce }) => {
        let fee = maxFeePerGas;
        if (nonce != null) {
          const b = (await publicClient.getBlock({ blockTag: 'latest' })).baseFeePerGas ?? 0n;
          fee = b * 2n + tip;
          if (fee < raised(lastFee)) fee = raised(lastFee);
        }
        lastFee = fee;
        const call = { ...advanceCall, gas, maxFeePerGas: fee, maxPriorityFeePerGas: tip, ...(nonce != null && { nonce }) };
        return nonce == null ? withNonceRetry('advanceTip', () => relayWallet.writeContract(call), { log }) : relayWallet.writeContract(call);
      },
      wait: (hash, ms) => publicClient.waitForTransactionReceipt({ hash, timeout: ms, pollingInterval: 4_000 }).catch((e) => (/timed out|timeout/i.test(String(e?.name || e?.message)) ? null : Promise.reject(e))),
      nonceOf: async (hash) => { for (let i = 0; ; i++) { try { return (await publicClient.getTransaction({ hash })).nonce; } catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 2_000)); } } },
      found: async (hashes) => { for (const hash of hashes) { const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null); if (receipt) return { hash, receipt }; } return null; },
    });
    if (landed.receipt.status !== 'success') throw new Error(`advanceTip reverted ${landed.hash}`);
    if (landed.raises) log(`  advanceTip landed after ${landed.raises} raise${landed.raises === 1 ? '' : 's'}, at a ${(Number(landed.tip) / 1e9).toFixed(4)} gwei tip`);
    return { txHash: landed.hash, to };
  }
}

// Reflection's attested height from the control plane (lightweight KV read, no assembly). Null if the
// endpoint isn't available — the cycle then follows the explorer tip instead of pacing.
async function reflectionAttested() {
  try {
    const r = await fetch(`${CFG.workerBase}/reflection/state?network=${CFG.network}`, { headers: { authorization: `Bearer ${CFG.boxToken}` } });
    if (!r.ok) return null;
    const j = await r.json();
    return Number.isFinite(Number(j.attestedHeight)) ? Number(j.attestedHeight) | 0 : null;
  } catch { return null; }
}

async function cycle() {
  const [rtip, btip, refl] = await Promise.all([relayTip(), btcTip(), reflectionAttested()]);
  // Pace against reflection: keep the relay within headerLead of reflection's attested height, so each attest
  // pays a short ancestor walk rather than one proportional to an unbounded lead. The pace is only a cost cap.
  // What protects reflected effects is the relay following the real chain: while it idles, a privately mined
  // branch needs only REFLECTION_CONFIRMATIONS headers past the last reflected block to become the relay's tip.
  // So when reflection's height is UNKNOWN (/reflection/state not reachable) the feeder keeps following the
  // explorer tip rather than stopping; a longer attest walk is the price, and a lane that falls past the
  // pool's lag bound recovers through advanceReflectionAncestry.
  if (refl == null) log(`reflection height unavailable (/reflection/state) — following the explorer tip. relay tip=${rtip}`);
  const paceCap = refl == null ? btip - 2 : refl + CFG.headerLead;
  let to = Math.min(btip - 2, paceCap);
  const { height: base, depth } = await resumeHeight(rtip, btip);
  // Off the canonical chain, restoring it outranks pacing: carry the honest branch past the abandoned tip.
  if (depth > 0) to = Math.max(to, Math.min(btip - 2, rtip + 1));
  if (to <= base) { log(`relay current (tip=${rtip} btc=${btip} refl=${refl ?? '?'})`); return false; }

  // advanceTip derives each header's difficulty target from its OWN branch (blockTarget[prev] +
  // epochStartTs[prev]), not a single global per-epoch value set by a separate call — so it crosses a
  // difficulty-epoch boundary transparently within one submission. No special-casing needed here.
  const dear = await gasAboveCap();
  // A user waiting on the reflection (a bonded cBTC lock not recorded yet) outranks waiting for cheap gas, up to a
  // ceiling, once the wait is real: a lock cannot be folded before it has its confirmations (about four hours), so
  // until the oldest such bond is DEMAND_GRACE_BLOCKS old the relay keeps to cheap gas and loses nothing by it.
  // After that, headers go out now, in whatever number is pending, so the lock folds as soon as it can.
  const demand = await cbtcLockDemand({ client: publicClient, pool: ADDR.pool, helper: ADDR.cbtcEscrowHelper, engine: ADDR.collateralEngine, lookbackBlocks: CFG.demandLookbackBlocks })
    .catch((e) => { log(`demand check unavailable (${String(e.message).slice(0, 80)})`); return null; });
  const gwei = dear || null;
  const ripe = !!demand?.waiting && demand.oldestAgeBlocks >= CFG.demandGraceBlocks;
  const urgent = ripe && !(gwei && gwei > CFG.demandMaxGasGwei);
  if (demand?.waiting) {
    const why = !ripe ? `bonded ${Math.round((demand.oldestAgeBlocks * 12) / 60)} min ago, before it can have its confirmations — keeping to cheap gas for now`
      : urgent ? 'advancing now' : `gas ${gwei.toFixed(2)} gwei is above the ${CFG.demandMaxGasGwei} gwei ceiling, waiting`;
    log(`${demand.waiting} bonded cBTC lock(s) waiting on the reflection — ${why}`);
  }
  const plan = planHeaderAdvance({
    base, to, minBatch: urgent ? 1 : CFG.headerMinBatch, maxStale: CFG.headerMaxStaleBlocks, maxBatch: CFG.headerMaxBatch,
    gasDear: urgent ? false : !!dear, restore: depth > 0,
  });
  if (plan.action === 'wait') {
    if (plan.reason === 'gas') log(`gas ${dear.toFixed(3)} gwei is above MAX_GAS_GWEI=${CFG.maxGasGwei} — waiting`);
    else log(`batching: ${plan.pending} of ${CFG.headerMinBatch} headers pending — waiting (tip=${rtip} btc=${btip})`);
    return false;
  }
  // Nobody waits on this batch to the minute (a user who does is 'urgent', above), so a ready batch holds for a cheaper block,
  // for at most HEADER_BASEFEE_MAX_WAIT_MIN. Not when the relay is at its staleness bound or restoring the canonical chain.
  if (BASEFEE_WAIT && !plan.forced && !urgent && depth === 0) {
    const gate = await baseFeeGate(base + Math.max(1, CFG.headerMinBatch)).catch((e) => { log(`base-fee check unavailable (${String(e.message).slice(0, 80)}) — not waiting`); return null; });
    if (gate?.wait) {
      const g = (w) => (Number(w) / 1e9).toFixed(3);
      log(`base fee ${g(gate.nextBase)} gwei is above the ${g(gate.ref)} gwei the last ${BASEFEE_BLOCKS} blocks usually paid; the batch has been ready ${Math.round(gate.readyAgeSec / 60)} min, waiting up to ${Math.round(BASEFEE_MAX_WAIT_SEC / 60)} min for a cheaper block`);
      return false;
    }
    if (gate && gate.ref != null) log(`base fee ${(Number(gate.nextBase) / 1e9).toFixed(3)} gwei (${gate.why}; recent norm ${(Number(gate.ref) / 1e9).toFixed(3)} gwei)`);
  }
  if (plan.forced && dear) log(`gas ${dear.toFixed(3)} gwei is above MAX_GAS_GWEI=${CFG.maxGasGwei} but the relay is at its staleness bound — advancing`);
  log(`advancing relay ${plan.from}..${plan.to} (btc=${btip} refl=${refl ?? '?'} lead-cap=${paceCap})`);
  const { txHash: tx, to: reached } = await submitAdvance(plan.from, plan.to);
  log(`relay advanced to ${reached} tx=${tx}`);
  return true;
}

async function main() {
  log(`starting — relay=${HEADER_RELAY} lead=${CFG.headerLead} maxBatch=${CFG.headerMaxBatch} minBatch=${CFG.headerMinBatch} maxStale=${CFG.headerMaxStaleBlocks || 'off'} esploras=${ESPLORAS.length}`);
  if (CFG.runMode === 'cron') {
    const t0 = Date.now();
    for (let i = 0; i < CFG.cronMaxCycles; i++) {
      if ((Date.now() - t0) / 1000 > CFG.cronBudgetSecs) { log('cron budget reached — exiting'); break; }
      let worked;
      try { worked = await cycle(); }
      catch (e) { log('cycle error — exiting cron run:', e.message); break; }
      if (!worked) { log('relay caught up to pace — cron run done'); break; }
    }
    return;
  }
  for (;;) {
    try { await cycle(); } catch (e) { log('cycle error (continuing):', e.message); }
    await sleep(CFG.reflectionPollSecs);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('fatal', e); process.exit(1); });
}
