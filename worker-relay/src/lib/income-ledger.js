// The settle relay's own books: for each UTC day, what the jobs it settled paid it (by kind of asset), what the settles cost in gas, how
// many it settled, left unpriced or only proved, and what it put into the PROVE vApp and into the buyback. Kept in memory and posted
// with the heartbeat, so the public page can show it without anyone reading the chain job by job.
//
// It counts what a job's own fee leg says it paid, never the wallet's balance: a top-up from the owner is not income and must not be
// taxed for the buyback. A restart starts the books again (`since` says from when), and the buyback owed is the only carry-over the
// replenish pass needs, which is kept here too.
//
// Nothing here throws or waits: it is called from the settle path and must never be the reason a settle does not go out.

import { burnFromBooks } from './treasury-plan.js';

export const ETH = '0x0000000000000000000000000000000000000000';
const lc = (a) => String(a || '').toLowerCase();
const day = (t) => new Date(t).toISOString().slice(0, 10);

// What kind of fee a job paid, by the address of the token its fee leg pays out in. 'converted' = an ERC-20 the sweep turns into ETH or
// PROVE (FEE_ASSETS); 'tac' = held, and moved to the reserve; 'other' = paid but nothing converts it yet (tacUSD, tacBTC: held and
// moved to the reserve as TAC is). The API names the token (`feeToken`, from the fee leg's own asset row); `feeAsset` is what a
// submitter said, read only when the API did not say.
export function classifyFeeAsset(feeAsset, { converted = [], tac = null } = {}) {
  if (feeAsset == null || feeAsset === '') return 'none';
  const a = lc(feeAsset);
  if (a === 'eth' || /^0x0{40}$/.test(a)) return 'eth';
  if (converted.some((x) => lc(x) === a)) return 'converted';
  if (tac && lc(tac) === a) return 'tac';
  return 'other';
}

const blank = () => ({
  settled: 0, priced: 0, unpriced: 0, proveOnly: 0,
  feeUsd: { eth: 0, converted: 0, tac: 0, other: 0 },
  gasEth: 0, proveIn: 0, buybackEth: 0, splitterSends: 0,
});

export function makeLedger({ now = () => Date.now(), keepDays = 8, converted = [], tac = null } = {}) {
  let since = now(), restored = false;
  const days = new Map();
  let pendingUsd = 0, owedWei = 0n, cfg = {}, runway = null;
  const bucket = (t = now()) => {
    const k = day(t);
    if (!days.has(k)) {
      days.set(k, blank());
      prune();
    }
    return days.get(k);
  };
  const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
  const eth = (wei) => Number(BigInt(wei) / 10n ** 9n) / 1e9;
  const safe = (fn) => (...a) => { try { return fn(...a); } catch { return undefined; } };
  const prune = () => { for (const old of [...days.keys()].sort().slice(0, -keepDays)) days.delete(old); };

  return {
    // Which ERC-20s count as converted, and which is TAC: set once the process knows its configuration.
    configure: safe((o = {}) => { if (Array.isArray(o.converted)) converted = o.converted; if (o.tac !== undefined) tac = o.tac; }),
    // A job the relay settled on chain: its fee, and its share of the settle's gas (wei).
    settled: safe((job, { txCostWei = 0n } = {}) => {
      const b = bucket(), usd = num(job?.feeUsd), kind = classifyFeeAsset(job?.feeToken ?? job?.feeAsset, { converted, tac });
      b.settled++;
      if (job?.feeUsd == null || !(usd > 0)) b.unpriced++;
      else {
        b.priced++;
        const k = kind === 'none' ? 'other' : kind;
        b.feeUsd[k] += usd;
        if (k === 'eth' || k === 'converted') pendingUsd += usd;
      }
      b.gasEth += eth(txCostWei);
    }),
    // A job the relay only proved: the holder sends the settle, so there is no fee and no gas, only the proof.
    provedOnly: safe(() => { bucket().proveOnly++; }),
    // PROVE the relay's wallet put into the prover vApp (whole PROVE).
    deposited: safe((prove) => { bucket().proveIn += num(prove); }),
    // ETH sent to the buyback, and a splitter sent on.
    boughtBack: safe((wei) => { bucket().buybackEth += eth(wei); }),
    splitterSent: safe(() => { bucket().splitterSends++; }),

    // The fee income, in USD, that the buyback share is taken from: every fee the sweep turns into ETH or PROVE, earned since the last take.
    takeBuybackBase: () => { const usd = pendingUsd; pendingUsd = 0; return usd; },
    peekBuybackBase: () => pendingUsd,
    giveBackBase: safe((usd) => { pendingUsd += num(usd); }),            // a pass that could not pay hands its base back
    owed: () => owedWei,
    setOwed: safe((wei) => { owedWei = BigInt(wei) < 0n ? 0n : BigInt(wei); }),
    setConfig: safe((c) => { cfg = { ...c }; }),
    // Where the treasury stands after a replenish pass (lib/treasury-plan.js): days of runway per wallet and for the credit, and what
    // the pass moved. Posted with the heartbeat for the operator's panel only; the public economics never carry it.
    setRunway: safe((r) => { runway = r && typeof r === 'object' ? { ...r, at: new Date(now()).toISOString() } : null; }),
    // What the books say the relay burns a day, from the days it has: settle gas (ETH), PROVE put in, settles. Null before any day.
    burnPerDay: () => burnFromBooks(Object.fromEntries(days), { now: now() }),

    // The books a previous process of this relay posted (snapshot() shape, read back from the API), added to this one's. Once only, and
    // all or nothing: a snapshot that does not parse changes nothing. What this process counted before the call is kept, so it may run late.
    restore: safe((snap) => {
      if (restored || !snap || typeof snap !== 'object' || Array.isArray(snap)) return false;
      const add = {};
      for (const [k, b] of Object.entries(snap.days && typeof snap.days === 'object' ? snap.days : {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !b || typeof b !== 'object') continue;
        const r = blank();
        for (const f of Object.keys(r)) if (f !== 'feeUsd') r[f] = num(b[f]);
        for (const f of Object.keys(r.feeUsd)) r.feeUsd[f] = num(b.feeUsd && b.feeUsd[f]);
        add[k] = r;
      }
      const owed = /^\d{1,30}$/.test(String(snap.owedWei ?? '')) ? BigInt(snap.owedWei) : 0n, pending = num(snap.pendingUsd), from = Date.parse(snap.since);
      restored = true;
      for (const [k, r] of Object.entries(add)) {
        if (!days.has(k)) days.set(k, blank());
        const b = days.get(k);
        for (const f of Object.keys(r)) if (f !== 'feeUsd') b[f] += r[f];
        for (const f of Object.keys(r.feeUsd)) b.feeUsd[f] += r.feeUsd[f];
      }
      prune();
      owedWei += owed; pendingUsd += pending;
      if (Number.isFinite(from) && from < since) since = from;
      return true;
    }),

    // A plain object for the heartbeat: whole numbers and short decimals only, newest day last.
    snapshot: () => ({
      since: new Date(since).toISOString(),
      cfg,
      ...(runway ? { runway } : {}),
      owedEth: eth(owedWei),
      owedWei: owedWei.toString(),            // exact, for a restart to take back; owedEth is for people
      pendingUsd: Math.round(pendingUsd * 1e4) / 1e4,
      days: Object.fromEntries([...days.entries()].sort().map(([k, b]) => [k, {
        ...b, feeUsd: Object.fromEntries(Object.entries(b.feeUsd).map(([x, v]) => [x, Math.round(v * 100) / 100])),
        gasEth: Math.round(b.gasEth * 1e6) / 1e6, proveIn: Math.round(b.proveIn * 100) / 100, buybackEth: Math.round(b.buybackEth * 1e6) / 1e6,
      }])),
    }),
  };
}

// One book per process, shared by the settle path and the replenish pass that runs beside it.
export const ledger = makeLedger();
