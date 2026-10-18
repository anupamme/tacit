// The liquidity campaign's rules: TAC for opening one of the named Precision pools and for holding liquidity in it, paid from a
// pocket of its own.
//
// A borrowed token is worth what it sells for, and TACD and TACE sell in Precision pools that nobody has a reason to open or to
// supply first. This campaign pays for both, in TAC credited as ledger adjustments (lib/points-adjustments.js), so it adds to what
// an address is owed and touches no day's split: the daily pot, its ceilings, weights and groups are all unchanged, and nobody
// already earning is paid less because of it. What bounds it instead is its own pocket (the most it may ever credit) and its end.
//
// Everything here is pure and BigInt, so the service, its tests and the pages state the same figures.
//
// Two things are paid:
//   - opening a pool: a fixed amount to the first account minted shares in one of the named pools (the one its seeding named to receive them,
//     which is whoever put the liquidity in), once per pool, when it has kept its own liquidity in for a whole day;
//   - holding liquidity in it: each UTC day's amount shared between the addresses holding its shares, by the value they held.
//
// What counts is the LOWEST number of shares an address held at any moment of the UTC day, read exactly from the pool's share
// transfers (not from samples, whose moments can be guessed and whose reads cannot be made at once): so liquidity that arrives for
// a moment and leaves earns nothing, and the same shares cannot be counted for two holders. That number is valued at the pool's
// value per share, taken as the median of the day's hourly readings so that no single moment of a pushed price decides it, with the
// synth side of the pool marked at the LOWER of the pool's own price and the peg: pushing the price up buys no credit, and a pool
// that has drifted below the peg is valued at what it is really worth.

export const WAD = 10n ** 18n;
const BPS = 10_000n;
const DAY = 86400;
// Guards against a slipped digit, not policy.
export const MAX_DAILY_WEI = 5_000n * WAD;            // TAC a day for the whole campaign
export const MAX_CREATE_WEI = 5_000n * WAD;           // TAC for opening one pool
export const MAX_CAP_WEI = 100n * WAD;                // TAC per dollar of liquidity a day

const entries = (raw) => String(raw || '').split(';').map((s) => s.trim()).filter(Boolean);
const bySchedule = (list) => list.sort((a, b) => a.fromDay - b.fromDay);
// "12.5" as wei; refuses anything else, so a typo stops an entry rather than paying what it never meant.
const tac = (text) => {
  const t = String(text).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) throw new Error(`"${text}" is not an amount of TAC`);
  const [whole, frac = ''] = t.split('.');
  return BigInt(whole) * WAD + BigInt((frac + '0'.repeat(18)).slice(0, 18));
};

// POINTS_LP_SCHEDULE: "<day>:daily=<TAC>,create=<TAC>,cap=<TAC per $ a day>;<day>:off" — from each UTC day, what the campaign pays.
// A later entry replaces an earlier one and "off" ends it; a malformed entry is reported and skipped, which pays nothing under it.
// `daily` is shared by everyone holding liquidity that day, `create` is paid once per pool to whoever opened it, and `cap` is the
// most one dollar of liquidity may earn in a day (what the cap leaves unpaid stays in the pocket).
export function parseLpSchedule(raw, log = () => {}) {
  const out = [];
  for (const part of entries(raw)) {
    try {
      const m = part.match(/^(\d+):(.+)$/);
      if (!m) throw new Error('expected <day>:daily=…,create=…,cap=… or <day>:off');
      const fromDay = Number(m[1]);
      if (!Number.isSafeInteger(fromDay) || fromDay <= 0) throw new Error('the day must be a UTC day number');
      if (m[2].trim().toLowerCase() === 'off') { out.push({ fromDay, off: true }); continue; }
      const terms = {};
      for (const kv of m[2].split(',').map((s) => s.trim()).filter(Boolean)) {
        const [k, v] = kv.split('=').map((s) => s.trim());
        if (!['daily', 'create', 'cap'].includes(k) || v === undefined) throw new Error(`"${kv}" is not daily=, create= or cap=`);
        if (terms[k] !== undefined) throw new Error(`${k} given twice`);
        terms[k] = tac(v);
      }
      if (terms.daily === undefined) throw new Error('daily= is required');
      if (terms.daily > MAX_DAILY_WEI) throw new Error('daily= is over the limit');
      if ((terms.create ?? 0n) > MAX_CREATE_WEI) throw new Error('create= is over the limit');
      if (terms.cap === undefined || terms.cap <= 0n) throw new Error('cap= is required and must be more than zero');
      if (terms.cap > MAX_CAP_WEI) throw new Error('cap= is over the limit');
      out.push({ fromDay, dailyWei: terms.daily, createWei: terms.create ?? 0n, capWeiPerUsdDay: terms.cap });
    } catch (err) {
      log(`ignoring POINTS_LP_SCHEDULE entry "${part}": ${err.message}`);
    }
  }
  return bySchedule(out);
}
// What the campaign pays on `day`, or null when it pays nothing then.
export function lpTermsForDay(schedule, day) {
  let found = null;
  for (const e of schedule) { if (e.fromDay > day) break; found = e.off ? null : e; }
  return found;
}
// The first entry after `day` that turns the campaign on or changes it, for a page that says what is coming.
export const nextLpTerms = (schedule, day) => schedule.find((e) => e.fromDay > day) ?? null;

// POINTS_LP_POOLS: "<pool>=<weight>,<pool>" — the pools the campaign pays for, each with the weight its liquidity counts at
// (1 by default, at most 20). A pool that is not listed earns nothing, whoever opens it.
export function parseLpPools(raw, log = () => {}) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const [addr, w = '1'] = part.split('=').map((s) => s.trim());
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('expected <pool address>[=<weight>]');
      const weight = Number(w);
      if (!(weight > 0) || weight > 20 || !Number.isFinite(weight)) throw new Error('the weight must be more than 0 and at most 20');
      const pool = addr.toLowerCase();
      if (seen.has(pool)) throw new Error('the pool is listed twice');
      seen.add(pool);
      out.push({ pool, weightBps: BigInt(Math.round(weight * 10_000)) });
    } catch (err) {
      log(`ignoring POINTS_LP_POOLS entry "${part}": ${err.message}`);
    }
  }
  return out;
}

// ── what an address held, exactly ──

const ZERO = '0x0000000000000000000000000000000000000000';
// Each address's lowest balance at any moment of the UTC day [dayStart, dayEnd), from the pool's share transfers in order (each
// { ts, from, to, value }, oldest first, every one up to the end of the day; `from` the zero address is a mint and `to` it a burn).
// An address that held shares at the start and was never touched held them all day; one that first received them in the day held
// nothing at the start, so its lowest is nothing. Transfers at the very start of the day count as in it.
export function dayMinimums(events, dayStart, dayEnd) {
  const bal = new Map(), min = new Map();
  let started = false;
  const start = () => { for (const [a, b] of bal) if (b > 0n) min.set(a, b); started = true; };
  for (const e of events) {
    if (e.ts >= dayEnd) break;
    if (!started && e.ts >= dayStart) start();
    if (e.from !== ZERO) bal.set(e.from, (bal.get(e.from) ?? 0n) - e.value);
    if (e.to !== ZERO) bal.set(e.to, (bal.get(e.to) ?? 0n) + e.value);
    if (started) for (const a of [e.from, e.to]) if (a !== ZERO) { const b = bal.get(a), m = min.has(a) ? min.get(a) : 0n; min.set(a, b < m ? b : m); }
  }
  if (!started) start();
  return min;
}
// The middle of the readings (the lower one when there is an even number of them): one moment's reading cannot move it.
export const medianOf = (xs) => { const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

// ── what a pool and a share in it are worth ──

// The quote asset per synth (1e18-scaled) from a Precision pool's square-root price, which is of token1 per token0 in raw units.
export function poolPrice({ sqrtNow, synthIs1, quoteDec }) {
  if (!(sqrtNow > 0n)) return null;
  const dq = 10n ** BigInt(quoteDec);
  return synthIs1 ? 10n ** 72n / (sqrtNow * sqrtNow * dq) : (sqrtNow * sqrtNow) / dq;
}

// What a pool holds, in dollars (1e18-scaled).
//
// The quote side is worth what the quote is worth. The synth side is marked at the LOWER of the pool's own price and the peg,
// in quote per synth: nobody can earn more by moving the price up (the mark stops at the peg), and a pool whose synth really has
// fallen is valued at the fall. `quoteUsdWei` is the dollar price of one quote token (1e18 for a dollar stablecoin, the feed's
// ETH price for ether) and `pegQuoteWei` the quote per synth the market is built around (1e18 for both of today's pools).
export function poolValueUsd({ reserveSynth, reserveQuote, quoteDec, sqrtNow, synthIs1, quoteUsdWei, pegQuoteWei = WAD }) {
  if (quoteUsdWei === null || quoteUsdWei === undefined || quoteUsdWei <= 0n) return null;
  const price = poolPrice({ sqrtNow, synthIs1, quoteDec });
  if (price === null) return null;
  const mark = price < pegQuoteWei ? price : pegQuoteWei;
  const quoteIn18 = reserveQuote * 10n ** BigInt(18 - quoteDec);
  return (quoteIn18 * quoteUsdWei) / WAD + (((reserveSynth * mark) / WAD) * quoteUsdWei) / WAD;
}
// What `balance` of a pool's shares is worth, in dollars (1e18-scaled).
export const shareValueUsd = (balance, supply, poolUsdWei) => (supply > 0n && balance > 0n ? (balance * poolUsdWei) / supply : 0n);

// ── the day's share-out ──

// A day's `dailyWei` shared between the rows by the value each held, weighted by its pool's weight, and no row paid more than
// `capWeiPerUsdDay` for each weighted dollar it held. Rounded down, so what rounding and the cap leave unpaid stays in the pocket
// rather than being paid to someone else: the campaign never pays more in a day than it says it will.
//
// rows: [{ address, pool, valueUsdWei, weightBps }]. The result is one entry per address (an address with liquidity in two pools
// is paid once), ordered by address, and never includes a zero.
export function allocateLpDay({ rows, dailyWei, capWeiPerUsdDay }) {
  if (!(dailyWei > 0n)) return [];
  const weighted = rows.map((r) => ({ ...r, weightedUsdWei: (r.valueUsdWei * r.weightBps) / BPS }));
  const total = weighted.reduce((s, r) => s + r.weightedUsdWei, 0n);
  if (total <= 0n) return [];
  const by = new Map();
  for (const r of weighted) {
    if (r.weightedUsdWei <= 0n) continue;
    const share = (dailyWei * r.weightedUsdWei) / total;
    const ceiling = (capWeiPerUsdDay * r.weightedUsdWei) / WAD;
    const wei = share < ceiling ? share : ceiling;
    if (wei > 0n) by.set(r.address, (by.get(r.address) ?? 0n) + wei);
  }
  return [...by.entries()].map(([address, wei]) => ({ address, wei })).sort((a, b) => (a.address < b.address ? -1 : 1));
}

// ── what each credit is called ──

// One id per pool for opening it, one per address and day for holding liquidity (an address in two pools is paid once for the
// day): an id is credited once and for all, so a day that has been paid is never paid again however often it is looked at.
export const CREDIT_PREFIX = 'lp:';
export const openId = (pool) => `${CREDIT_PREFIX}open:${pool.toLowerCase()}`;
export const dayId = (day, address) => `${CREDIT_PREFIX}day:${day}:${address.toLowerCase()}`;

// The days of the regular pot the campaign must leave covered: the reserve, or fewer when fewer are left to pay (the funding report
// counts days only while the regular program has a budget for them, so near and after its end it can never show the reserve).
export function reserveFor({ reserveDays, nextDay, budgetFor }) {
  let left = 0;
  while (left < reserveDays && budgetFor(nextDay + left) > 0n) left++;
  return left;
}

// The campaign's numbers from the environment's text, each checked: a typo falls back to the safe default (or, for what must be
// given, switches the campaign off) rather than turning a guard off. Returns null when it is off.
export function parseLpSettings(raw, log = () => {}) {
  const int = (name, v, dflt, lo, hi) => {
    if (v === undefined || v === null || v === '') return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) { log(`ignoring ${name}="${v}": expected a whole number from ${lo} to ${hi}; using ${dflt}`); return dflt; }
    return n;
  };
  const wei = (name, v) => {
    if (v === undefined || v === null || v === '' || v === '0') return 0n;
    if (!/^[1-9]\d{0,40}$/.test(String(v))) { log(`ignoring ${name}="${v}": expected a whole number of wei`); return 0n; }
    return BigInt(v);
  };
  const pocketWei = wei('POINTS_LP_POCKET_WEI', raw.pocket), endSec = int('POINTS_LP_END_SEC', raw.endSec, 0, 0, 4_102_444_800);
  if (pocketWei <= 0n || !endSec) return null;
  return {
    pocketWei, endSec,
    fromBlock: int('POINTS_LP_FROM_BLOCK', raw.fromBlock, 0, 0, 1_000_000_000) || undefined,
    reserveDays: int('POINTS_LP_RESERVE_DAYS', raw.reserveDays, 2, 0, 30),
    minSamples: int('POINTS_LP_MIN_SAMPLES', raw.minSamples, 12, 1, 24),
    minUsdWei: BigInt(int('POINTS_LP_MIN_USD', raw.minUsd, 20, 0, 1_000_000)) * WAD,
  };
}

// Why a credit of `wei` has to wait, or null when it may go ahead: the campaign has ended, it would take the pocket past what was
// put in it, or the distributor's funding would then cover fewer than `reserveDays` whole days of the regular pot (a root is
// published all or nothing, so the campaign must never be what holds the daily payouts back). `status(extraWei)` is the funding
// status with `extraWei` more on the ledger (lib/points-funding.js), or null when it cannot be read.
export function holdReason({ wei, creditedWei, pocketWei, nowSec, endSec, status, reserveDays = 2 }) {
  if (!endSec || nowSec > endSec) return 'ended';
  if (creditedWei + wei > pocketWei) return 'pocket';
  const s = status(wei);
  if (!s) return 'funding unread';
  if (s.shortfallWei > 0n || s.daysCovered < reserveDays) return 'funding';
  return null;
}

export const dayOf = (sec) => Math.floor(sec / DAY);
// A day is paid once it is over, with the same grace the daily pot settles after.
export const dayIsDone = (day, nowSec, graceSecs = 0) => nowSec >= (day + 1) * DAY + graceSecs;
