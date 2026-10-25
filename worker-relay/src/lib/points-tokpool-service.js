// The token pools' campaign as the points service runs it (rules in lib/points-tokpool.js), off unless a pocket, an end time, a schedule
// and at least one pool are set.
//
// It reads each listed pool's Transact events as far as they are final: a positive amount is a deposit, kept with who sent it and whether
// it counts; a negative one is a payout to its recipient, and a fee is a payout to its relayer (a deposit from an address the pool paid
// out to in the day before does not count). A deposit that pays a fee does not count at all: the pool pays the fee to whatever relayer the
// transaction names, out of the same call, so a deposit could hand itself its own amount back as a fee; a depositor's own deposit needs none. Once an hour it reads TAC's price (the oracle's pool price in ETH times the ETH price feed, at a block a few behind the
// head); a TAC pool's day is valued at the median of those readings.
//
// A credit is an ordinary ledger adjustment, `tp:day:<day>:<address>`, and waits, as the liquidity campaign's do, while the pocket would be
// overdrawn or the distributor's funding would stop covering the regular pot; what waits is credited later, never dropped. Each paid day
// keeps a record of everything it rests on (the terms, every deposit seen and why it counted or not, the readings and the credits) with
// its hash, in the same transaction as the credits (/tokpool/day/<n>).
//
// deps: store, client (a viem public client), cfg, fundingInputs() -> { heldWei, claimedWei, nextDay } | null, budgetFor(day), graceSecs,
// nowSec, log.
//   cfg: { schedule (lib/points-lp.js parseLpSchedule: daily, cap), pools ([{ pool, router, kind }]), pocketWei, endSec, fromBlock?,
//          addressUsdWei?, minUsdWei?, minSamples?, reserveDays?, exclude?, tacOracle, ethUsdFeed, confirmations?, chunk? }
import { parseAbi, parseAbiItem, toEventSelector } from 'viem';
import { fundingStatus } from './points-funding.js';
import { rateLimited } from './holding-scan.js';
import { TRANSACT_EVENT, DEPOSIT_BOX_COMPLETED_EVENT, RECEIVED_EVENT } from './evm-pool-points.js';
import { lpTermsForDay, nextLpTerms, holdReason, reserveFor, medianOf, dayOf, dayIsDone } from './points-lp.js';
import { RECORD_VERSION, hashRecord } from './points-lp-record.js';
import { WAD, CREDIT_PREFIX, dayId, depositUsd, depositSkip, allocateTokDay, depositorOf, LOOP_SECS } from './points-tokpool.js';

const HOUR = 3600, DAY = 86400, FEED_MAX_AGE = 3 * HOUR, PIN_LAG = 3, PIN_MAX_AGE = 300;
const POOL_ABI = parseAbi(['function ASSET() view returns (address)']);
const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)']);
const ORACLE_ABI = parseAbi(['function spot() view returns (uint256)']);
const FEED_ABI = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const BOX_TOPICS = new Set([toEventSelector(DEPOSIT_BOX_COMPLETED_EVENT), toEventSelector(RECEIVED_EVENT)]);
const lower = (a) => String(a).toLowerCase();
const short = (err) => String(err?.shortMessage || err?.message || err).slice(0, 200);
class Hold extends Error { constructor(why) { super(why); this.why = why; } }

export function createTokPool({ store, client, cfg, fundingInputs, budgetFor, graceSecs = 0, nowSec = () => Math.floor(Date.now() / 1000), log = () => {} }) {
  let pools = cfg.pools ?? [];
  const enabled = cfg.pocketWei > 0n && cfg.endSec > 0 && pools.length > 0 && (cfg.schedule ?? []).length > 0;
  const addressUsdWei = cfg.addressUsdWei ?? 2_500n * WAD, minUsdWei = cfg.minUsdWei ?? 10n * WAD, minSamples = cfg.minSamples ?? 12;
  const reserveDays = cfg.reserveDays ?? 2, confirmations = cfg.confirmations ?? 12, chunk = cfg.chunk ?? 2000, budgetMs = cfg.budgetMs ?? 30_000;
  const excluded = new Set((cfg.exclude ?? []).map(lower));
  const db = store.db;
  if (enabled) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tp_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tp_cursor (pool TEXT PRIMARY KEY, block INTEGER NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tp_deposits (pool TEXT NOT NULL, block INTEGER NOT NULL, idx INTEGER NOT NULL, ts INTEGER NOT NULL, tx TEXT NOT NULL, address TEXT, amount TEXT NOT NULL, why TEXT, PRIMARY KEY (pool, block, idx));
      CREATE TABLE IF NOT EXISTS tp_payouts (pool TEXT NOT NULL, block INTEGER NOT NULL, idx INTEGER NOT NULL, ts INTEGER NOT NULL, recipient TEXT NOT NULL, PRIMARY KEY (pool, block, idx, recipient));
      CREATE INDEX IF NOT EXISTS tp_payouts_to ON tp_payouts (pool, recipient, ts);
      CREATE TABLE IF NOT EXISTS tp_samples (day INTEGER NOT NULL, hour INTEGER NOT NULL, taken_at INTEGER NOT NULL, block INTEGER NOT NULL, eth_per_tac TEXT NOT NULL, eth_usd TEXT NOT NULL, feed_round TEXT NOT NULL, tac_usd TEXT NOT NULL, PRIMARY KEY (day, hour));
      CREATE TABLE IF NOT EXISTS tp_days (day INTEGER PRIMARY KEY, paid_at INTEGER NOT NULL, wei TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tp_day_records (day INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, json TEXT NOT NULL);
    `);
  }
  const stmts = new Map();
  const q = (sql) => { if (!stmts.has(sql)) stmts.set(sql, db.prepare(sql)); return stmts.get(sql); };
  const getMeta = (k) => q('SELECT v FROM tp_meta WHERE k = ?').get(k)?.v ?? null;
  const setMeta = (k, v) => q('INSERT INTO tp_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
  let lastHold = '';
  const noted = new Set();
  const noteOnce = (key, text) => { if (noted.size > 500) noted.clear(); if (!noted.has(key)) { noted.add(key); log(text); } };

  // Each pool's token decimals, read once (the pool's asset, then its decimals) before the pool is read at all. A listed address that is
  // no token pool (no code, no asset, a token with no decimals) is dropped and said so: left in, it would hold every day for every pool,
  // because days are paid in order. A read the node fails is tried again next cycle, and nothing is scanned or paid until every pool is read.
  const decs = new Map();
  const ZERO = '0x0000000000000000000000000000000000000000';
  const notAPool = (err) => /revert|returned no data|zero data|not a contract|no pool token/i.test(`${err?.name} ${err?.shortMessage} ${err?.message} ${err?.cause?.name}`);
  async function checkPools() {
    for (const x of [...pools]) {
      const p = lower(x.pool);
      if (decs.has(p)) continue;
      try {
        const asset = await client.readContract({ address: p, abi: POOL_ABI, functionName: 'ASSET' });
        if (lower(asset) === ZERO) throw new Error('no pool token: its asset is ETH');
        const dec = Number(await client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'decimals' }));
        if (!Number.isInteger(dec) || dec > 36) throw new Error(`no pool token: ${dec} decimals`);
        decs.set(p, dec);
      } catch (err) {
        if (!notAPool(err)) { noteOnce(`dec${p}`, `tokpool: the pool ${p} could not be read yet (${short(err)}); waiting`); return false; }
        pools = pools.filter((y) => y !== x);
        log(`tokpool: ${p} is not a token pool (${short(err)}); it is left out`);
      }
    }
    return true;
  }
  const decOf = (p) => decs.get(p);

  // ── the pools' deposits and payouts ──

  const times = new Map();
  async function timeOf(n) {
    if (!times.has(n)) { if (times.size > 5000) times.clear(); times.set(n, Number((await client.getBlock({ blockNumber: BigInt(n) })).timestamp)); }
    return times.get(n);
  }
  // Who a deposit credits and why it might not: its transaction must be the depositor's own, and not a deposit box's completion.
  async function attribute(p, router, l) {
    const tx = await client.getTransaction({ hash: l.transactionHash });
    const address = depositorOf(tx, { pool: p, router, excluded });
    if (!address) return { address: lower(tx.from || ''), why: 'sender' };
    const receipt = await client.getTransactionReceipt({ hash: l.transactionHash });
    if (receipt.logs.some((x) => lower(x.address) === router && BOX_TOPICS.has(lower(x.topics?.[0] || '')))) return { address, why: 'box' };
    return { address, why: null };
  }
  const chunks = new Map();
  async function scan() {
    const head = Number(await client.getBlockNumber()), safe = head - confirmations, began = Date.now();
    if (getMeta('start_block') === null) setMeta('start_block', cfg.fromBlock ?? safe);
    for (const { pool, router } of pools) {
      const p = lower(pool);
      let cursor = q('SELECT block FROM tp_cursor WHERE pool = ?').get(p)?.block ?? Number(getMeta('start_block')) - 1;
      while (cursor < safe && Date.now() - began < budgetMs) {
        const size = chunks.get(p) ?? chunk, from = cursor + 1, to = Math.min(from + size - 1, safe);
        let logs;
        try { logs = await client.getLogs({ address: p, event: TRANSACT_EVENT, fromBlock: BigInt(from), toBlock: BigInt(to) }); } catch (err) {
          if (rateLimited(err)) { noteOnce(`rl${p}${from}`, `tokpool scan ${p}: rate limited at block ${from}, resuming next cycle`); break; }
          if (size > 50) { chunks.set(p, Math.max(50, Math.floor(size / 2))); continue; }
          log(`tokpool scan ${p}: blocks ${from}-${to} failed: ${short(err)}`); break;
        }
        try {
          const rows = [];
          for (const l of [...logs].sort((x, y) => Number(x.blockNumber - y.blockNumber) || x.logIndex - y.logIndex)) {
            const amount = l.args.extAmount, fee = l.args.fee ?? 0n, block = Number(l.blockNumber), ts = await timeOf(block);
            if (amount > 0n) {
              const who = await attribute(p, router, l);
              rows.push({ kind: 'in', block, idx: l.logIndex, ts, tx: l.transactionHash, amount, address: who.address, why: fee > 0n ? 'fee' : who.why });
            } else if (amount < 0n) rows.push({ kind: 'out', block, idx: l.logIndex, ts, recipient: lower(l.args.recipient) });
            if (fee > 0n) rows.push({ kind: 'out', block, idx: l.logIndex, ts, recipient: lower(l.args.relayer) });
          }
          const endTs = await timeOf(to);
          db.transaction(() => {
            for (const r of rows) {
              if (r.kind === 'in') q('INSERT OR IGNORE INTO tp_deposits (pool, block, idx, ts, tx, address, amount, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(p, r.block, r.idx, r.ts, r.tx, r.address || null, String(r.amount), r.why);
              else q('INSERT OR IGNORE INTO tp_payouts (pool, block, idx, ts, recipient) VALUES (?, ?, ?, ?, ?)').run(p, r.block, r.idx, r.ts, r.recipient);
            }
            q('INSERT INTO tp_cursor (pool, block, ts) VALUES (?, ?, ?) ON CONFLICT(pool) DO UPDATE SET block = excluded.block, ts = excluded.ts').run(p, to, endTs);
          })();
          cursor = to; chunks.set(p, Math.min(chunk, size * 2));
        } catch (err) { log(`tokpool scan ${p}: blocks ${from}-${to} could not be read: ${short(err)}`); break; }
      }
    }
  }

  // ── TAC's price ──

  const needsPrice = pools.some((x) => x.kind === 'tac');
  async function sample() {
    if (!needsPrice) return;
    const t = nowSec(), day = dayOf(t), hour = Math.floor((t % DAY) / HOUR);
    if (q('SELECT 1 FROM tp_samples WHERE day = ? AND hour = ?').get(day, hour)) return;
    try {
      const n = BigInt(Math.max(0, Number(await client.getBlockNumber()) - PIN_LAG)), b = await client.getBlock({ blockNumber: n }), bts = Number(b.timestamp);
      if (t - bts > PIN_MAX_AGE) { noteOnce(`lag${day}${hour}`, `tokpool sample: the node's block ${n} is ${t - bts} s old, the hour is left unsampled`); return; }
      const [ethPerTac, r] = await Promise.all([
        client.readContract({ address: cfg.tacOracle, abi: ORACLE_ABI, functionName: 'spot', blockNumber: n }),
        client.readContract({ address: cfg.ethUsdFeed, abi: FEED_ABI, functionName: 'latestRoundData', blockNumber: n }),
      ]);
      if (!(ethPerTac > 0n) || !(r[1] > 0n) || bts - Number(r[3]) > FEED_MAX_AGE) { noteOnce(`px${day}${hour}`, 'tokpool sample: no fresh price, the hour is left unsampled'); return; }
      const ethUsd = r[1] * 10n ** 10n;
      q('INSERT OR IGNORE INTO tp_samples (day, hour, taken_at, block, eth_per_tac, eth_usd, feed_round, tac_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(day, hour, t, Number(n), String(ethPerTac), String(ethUsd), String(r[0]), String((ethPerTac * ethUsd) / WAD));
    } catch (err) { log(`tokpool sample failed: ${short(err)}`); }
  }
  const samplesOf = (day) => q('SELECT hour, taken_at, block, eth_per_tac, eth_usd, feed_round, tac_usd FROM tp_samples WHERE day = ? ORDER BY hour').all(day);
  const tacPriceOf = (day) => { const s = samplesOf(day); return s.length >= minSamples ? medianOf(s.map((r) => BigInt(r.tac_usd))) : null; };

  // ── a day's credits ──

  const ready = (day) => pools.every(({ pool }) => (q('SELECT ts FROM tp_cursor WHERE pool = ?').get(lower(pool))?.ts ?? -1) >= (day + 1) * DAY);
  async function computeDay(day, terms) {
    const start = day * DAY, end = start + DAY, tacUsdWei = tacPriceOf(day), counted = [], recPools = [], recDeposits = [];
    for (const { pool, kind } of pools) {
      const p = lower(pool), dec = decOf(p);
      recPools.push({ pool: p, kind, dec });
      for (const d of q('SELECT block, idx, ts, tx, address, amount, why FROM tp_deposits WHERE pool = ? AND ts >= ? AND ts < ? ORDER BY block, idx').all(p, start, end)) {
        const usdWei = depositUsd({ amount: BigInt(d.amount), dec, kind, tacUsdWei });
        const paidOut = d.address ? q('SELECT ts FROM tp_payouts WHERE pool = ? AND recipient = ? AND ts > ? AND ts <= ?').all(p, d.address, d.ts - LOOP_SECS, d.ts).map((r) => r.ts) : [];
        const why = d.why ?? depositSkip({ usdWei, minUsdWei, ts: d.ts, paidOut });
        recDeposits.push({ pool: p, block: d.block, idx: d.idx, tx: d.tx, address: d.address, amount: d.amount, usdWei: usdWei == null ? null : String(usdWei), ...(why ? { why } : {}) });
        if (!why) counted.push({ pool: p, address: d.address, usdWei });
      }
    }
    const credits = allocateTokDay({ deposits: counted, pools: pools.map((x) => lower(x.pool)), dailyWei: terms.dailyWei, capWeiPerUsd: terms.capWeiPerUsdDay, addressUsdWei })
      .map((a) => ({ id: dayId(day, a.address), address: a.address, wei: a.wei }));
    const record = {
      v: RECORD_VERSION, campaign: 'tokpool', day,
      terms: { dailyWei: String(terms.dailyWei), capWeiPerUsd: String(terms.capWeiPerUsdDay) },
      addressUsdWei: String(addressUsdWei), minUsdWei: String(minUsdWei), minSamples, exclude: [...excluded].sort(),
      pools: recPools, ...(needsPrice ? { tacUsdWei: tacUsdWei == null ? null : String(tacUsdWei), samples: samplesOf(day) } : {}),
      deposits: recDeposits,
      credits: credits.map((c) => ({ id: c.id, address: c.address, wei: String(c.wei) })),
    };
    return { credits, record };
  }
  const saveRecord = (day, record) => q('INSERT OR IGNORE INTO tp_day_records (day, sha256, json) VALUES (?, ?, ?)').run(day, hashRecord(record), JSON.stringify(record));
  const applyAll = db.transaction((credits, day, t, record) => {
    const total = credits.reduce((s, c) => s + c.wei, 0n);
    if (store.creditedWithPrefix(CREDIT_PREFIX) + total > cfg.pocketWei) throw new Hold('pocket');
    for (const c of credits) store.applyAdjustment({ id: c.id, address: c.address, wei: c.wei });
    q('INSERT OR IGNORE INTO tp_days (day, paid_at, wei) VALUES (?, ?, ?)').run(day, t, String(total));
    saveRecord(day, record);
    return total;
  });
  async function holdFor(wei, t) {
    const inputs = await fundingInputs().catch(() => null);
    const ledger = store.allRewards().reduce((s, r) => s + BigInt(r.cumulativeWei), 0n);
    const need = inputs ? reserveFor({ reserveDays, nextDay: inputs.nextDay, budgetFor }) : reserveDays;
    return holdReason({
      wei, creditedWei: store.creditedWithPrefix(CREDIT_PREFIX), pocketWei: cfg.pocketWei, nowSec: t, endSec: cfg.endSec, reserveDays: need,
      status: (extra) => (inputs ? fundingStatus({ heldWei: inputs.heldWei, claimedWei: inputs.claimedWei, ledgerWei: ledger + extra, budgetFor, nextDay: inputs.nextDay, graceSecs }) : null),
    });
  }
  const said = (why, text) => { if (why !== lastHold) { lastHold = why; log(`tokpool credits wait: ${why} (${text})`); } };

  async function settle() {
    const lastPaid = q('SELECT MAX(day) AS d FROM tp_days').get()?.d;
    let day = lastPaid == null ? Math.max(dayOf(Number(getMeta('enabled_at') ?? nowSec())), cfg.schedule[0].fromDay) : lastPaid + 1;
    const t = nowSec();
    for (; dayIsDone(day, t, graceSecs); day++) {
      const terms = lpTermsForDay(cfg.schedule, day);
      if (!terms) { q('INSERT OR IGNORE INTO tp_days (day, paid_at, wei) VALUES (?, ?, ?)').run(day, t, '0'); continue; }
      if (!ready(day)) { said('scan', `day ${day}: the pools are not read through its end yet`); return; }
      const { credits, record } = await computeDay(day, terms);
      const total = credits.reduce((s, c) => s + c.wei, 0n);
      if (total > 0n) {
        // Whether the campaign has ended is asked of the day, not of now: a day is paid only after it is over, so the last one would
        // otherwise always be past the end.
        const why = await holdFor(total, day * DAY);
        if (why) { said(why, `day ${day}, ${credits.length} credit(s)`); return; }
      }
      try { applyAll(credits, day, t, record); } catch (err) { if (err instanceof Hold) { said(err.why, `day ${day}`); return; } throw err; }
      lastHold = '';
      if (total > 0n) log(`tokpool day ${day}: ${total} wei to ${credits.length} credit(s)`);
    }
  }

  async function cycle() {
    if (!enabled || nowSec() > cfg.endSec + 3 * DAY) return;
    if (getMeta('enabled_at') === null) setMeta('enabled_at', nowSec());
    try { if (!(await checkPools())) return; } catch (err) { log('tokpool pool check failed:', short(err)); return; }
    try { await scan(); } catch (err) { log('tokpool scan failed:', short(err)); }
    try { await sample(); } catch (err) { log('tokpool sample failed:', short(err)); }
    try { await settle(); } catch (err) { log('tokpool credits failed:', short(err)); }
  }

  // ── what a page shows ──

  const likePrefix = CREDIT_PREFIX.replace(/[\\%_]/g, (c) => '\\' + c);
  const sumFor = (address) => db.prepare(`SELECT wei FROM reward_adjustments WHERE id LIKE ? ESCAPE '\\' AND address = ?`).all(`${likePrefix}%`, address).reduce((s, r) => s + BigInt(r.wei), 0n);
  function dayRecord(day) {
    const r = enabled && Number.isInteger(day) ? q('SELECT sha256, json FROM tp_day_records WHERE day = ?').get(day) : null;
    return r ? { sha256: r.sha256, record: JSON.parse(r.json) } : null;
  }
  const memo = new Map();
  function view({ address = null } = {}) {
    if (!enabled) return { enabled: false };
    const key = lower(address ?? ''), hit = memo.get(key);
    if (hit && Date.now() - hit.t < 15_000) return hit.v;
    const t = nowSec(), day = dayOf(t), credited = store.creditedWithPrefix(CREDIT_PREFIX);
    const termsOut = (e) => (!e ? null : e.off ? { fromDay: e.fromDay, off: true } : { fromDay: e.fromDay, dailyWei: String(e.dailyWei), capWeiPerUsd: String(e.capWeiPerUsdDay) });
    const me = address ? lower(address) : null;
    const v = {
      enabled: true, endSec: cfg.endSec,
      pocket: { totalWei: String(cfg.pocketWei), creditedWei: String(credited), remainingWei: String(cfg.pocketWei > credited ? cfg.pocketWei - credited : 0n) },
      terms: termsOut(lpTermsForDay(cfg.schedule, day)), next: termsOut(nextLpTerms(cfg.schedule, day)),
      addressUsdWei: String(addressUsdWei), minUsdWei: String(minUsdWei), loopSecs: LOOP_SECS,
      pools: pools.map(({ pool, kind }) => ({ pool: lower(pool), kind, depositsToday: q('SELECT COUNT(*) AS n FROM tp_deposits WHERE pool = ? AND ts >= ? AND why IS NULL').get(lower(pool), day * DAY).n })),
      lastPaidDay: q('SELECT MAX(day) AS d FROM tp_days').get()?.d ?? null,
      ...(me ? { mine: { address: me, creditedWei: String(sumFor(me)), depositsToday: q('SELECT pool, amount, why FROM tp_deposits WHERE address = ? AND ts >= ?').all(me, day * DAY) } } : {}),
    };
    if (memo.size > 200) memo.clear();
    memo.set(key, { t: Date.now(), v });
    return v;
  }

  return { enabled, name: 'tokpool', cycle, scan, sample, settle, view, dayRecord, endSec: cfg.endSec, pocketWei: cfg.pocketWei, credited: () => store.creditedWithPrefix(CREDIT_PREFIX) };
}
