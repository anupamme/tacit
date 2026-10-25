// The token pools' campaign rules: TAC for depositing into the private USDC, USDT and TAC pools on Ethereum, paid from a pocket of its own.
//
// Those pools are young, and a private pool is only as private as its crowd. This campaign pays depositors in TAC credited as ledger
// adjustments (lib/points-adjustments.js), as the liquidity campaign does (lib/points-lp.js): it adds to what an address is owed and touches
// no day's split, so the daily pot, its ceilings, weights and groups are all unchanged and nobody already earning is paid less because of
// it. What bounds it is its own pocket, its end, and the day's amount.
//
// What is paid: each UTC day's amount, split evenly between the listed pools, and each pool's part shared between the addresses that
// deposited into it that day by the dollars they deposited. Every dollar earns at most the schedule's `cap`, so a quiet day pays its
// depositors in full at the cap and leaves the rest of the pool's part in the pocket; a busy day shares the part. What counts for an
// address in a pool is capped too (`addressUsd` a day), and a deposit under `minUsd` is not counted.
//
// What a deposit is: a pool Transact with a positive amount and no fee, sent by the depositor's own transaction to the pool or its router
// (or to itself, a wallet that batches its own calls), and not completed out of a deposit box (whose completer is not who funded it). The
// pool pays a Transact's fee to whatever relayer it names, out of the same call, so a deposit with a fee could hand its own amount back. A deposit
// from an address that the same pool paid out to in the 24 hours before is not counted: withdrawing and depositing again earns nothing.
// A withdrawal to another address and a deposit from it is not seen as one, so this bounds a loop rather than stopping it; the
// day's amount and the per-dollar cap are what make one not worth running.
//
// A dollar pool's deposits are worth their face value. TAC's are worth the median of the day's hourly readings of TAC's price (the pool
// price in ETH times the ETH price feed): no one moment of a pushed price decides it.
//
// Everything here is pure and BigInt.
import { WAD, allocateLpDay } from './points-lp.js';

export { WAD };
const DAY = 86400;
export const LOOP_SECS = DAY;                                           // a payout this recent to the depositor makes a deposit not count
export const CREDIT_PREFIX = 'tp:';
export const dayId = (day, address) => `${CREDIT_PREFIX}day:${day}:${String(address).toLowerCase()}`;

// POINTS_TOKPOOL_POOLS: "<pool>/<router>=usd,<pool>/<router>=tac" — the pools the campaign pays for, each with its router (a deposit sent
// through it counts) and what its token is worth: a dollar (`usd`, at face value) or TAC (`tac`, at the day's median price). A pool that is
// not listed earns nothing.
export function parseTokPools(raw, log = () => {}) {
  const out = [], seen = new Set();
  for (const part of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const m = part.match(/^(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]{40})=(usd|tac)$/);
      if (!m) throw new Error('expected <pool address>/<router address>=usd or =tac');
      const pool = m[1].toLowerCase();
      if (seen.has(pool)) throw new Error('the pool is listed twice');
      seen.add(pool);
      out.push({ pool, router: m[2].toLowerCase(), kind: m[3] });
    } catch (err) { log(`ignoring POINTS_TOKPOOL_POOLS entry "${part}": ${err.message}`); }
  }
  return out;
}

// A deposit of `amount` base units of a token with `dec` decimals, in dollars (1e18), or null when TAC has no price for the day.
export function depositUsd({ amount, dec, kind, tacUsdWei }) {
  const in18 = dec <= 18 ? amount * 10n ** BigInt(18 - dec) : amount / 10n ** BigInt(dec - 18);
  if (kind === 'usd') return in18;
  if (tacUsdWei == null || tacUsdWei <= 0n) return null;
  return (in18 * tacUsdWei) / WAD;
}

// Whether a deposit counts, or why not. `paidOut`: the times (seconds) the same pool paid out to the depositor.
export function depositSkip({ usdWei, minUsdWei, ts, paidOut = [] }) {
  if (usdWei == null) return 'unpriced';
  if (usdWei < minUsdWei) return 'small';
  if (paidOut.some((t) => t <= ts && ts - t < LOOP_SECS)) return 'loop';
  return null;
}

// A day's credits: `dailyWei` split evenly between `pools`, each part shared between that pool's depositors by the dollars they deposited
// (each address's total capped at `addressUsdWei`), at most `capWeiPerUsd` a dollar. Rounded down; what the caps and rounding leave unpaid
// stays in the pocket. deposits: [{ pool, address, usdWei }] (counted deposits only). One entry per address, by address, never a zero.
export function allocateTokDay({ deposits, pools, dailyWei, capWeiPerUsd, addressUsdWei }) {
  if (!(dailyWei > 0n) || !pools.length) return [];
  const part = dailyWei / BigInt(pools.length), by = new Map();
  for (const pool of pools) {
    const sums = new Map();
    for (const d of deposits) if (d.pool === pool) sums.set(d.address, (sums.get(d.address) ?? 0n) + d.usdWei);
    const rows = [...sums].map(([address, usd]) => ({ address, pool, valueUsdWei: usd < addressUsdWei ? usd : addressUsdWei, weightBps: 10_000n }));
    for (const a of allocateLpDay({ rows, dailyWei: part, capWeiPerUsdDay: capWeiPerUsd })) by.set(a.address, (by.get(a.address) ?? 0n) + a.wei);
  }
  return [...by].map(([address, wei]) => ({ address, wei })).filter((a) => a.wei > 0n).sort((a, b) => (a.address < b.address ? -1 : 1));
}

// Who a deposit's transaction credits, or null: its sender, when the transaction went to the pool, its router or the sender itself, and the
// sender is not excluded (the relay, which sends for others).
export function depositorOf(tx, { pool, router, excluded }) {
  const from = String(tx?.from || '').toLowerCase(), to = String(tx?.to || '').toLowerCase();
  if (!from || excluded.has(from)) return null;
  if (to !== pool && to !== router && to !== from) return null;
  return from;
}
