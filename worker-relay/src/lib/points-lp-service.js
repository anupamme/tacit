// The liquidity campaign as the points service runs it (rules in lib/points-lp.js), off unless a pocket, an end time, a schedule
// and at least one pool are set.
//
// It follows the pools it is told about (POINTS_LP_POOLS) by their share tokens' Transfer events, kept with each one's time. From
// those it knows exactly what every address held at every moment, so a UTC day is paid on the LOWEST number of shares an address
// held at any moment of it: liquidity that comes for a moment and goes earns nothing, and the same shares cannot be counted for two
// holders. Once an hour it also reads each pool's value per share; the day's figure is the median of those readings. The first
// address to be minted shares in a pool is its opener, paid the opening bonus once its own liquidity has stayed above the minimum
// for a whole day.
//
// A pool is counted only while its replay agrees with the chain: the shares the transfers add up to (minted, less everything sent to the
// zero address) plus what the zero address holds must equal the pool's total supply at the block the scan has reached. That is exact,
// because a burn lowers the supply and credits nobody, while a plain transfer to the zero address (which the share token allows) credits
// it and leaves the supply alone; and it fails if the scan began after the pool was opened or a log was missed. A pool that has no code yet
// has nothing minted and agrees at zero. A day waits until every pool has been read through its end.
//
// A credit is an ordinary ledger adjustment (lib/points-adjustments.js): it adds to what an address is owed and touches no day's
// split. Every credit waits while the pocket would be overdrawn or the distributor's funding would stop covering the regular pot, and
// what waits is credited later, never dropped (a day is marked paid only once all of it has been).
//
// deps: store, client (a viem public client), cfg (see below), fundingInputs() -> { heldWei, claimedWei, nextDay } | null, budgetFor(day),
// graceSecs, nowSec, log.
//   cfg: { schedule, pools, pocketWei, endSec, reserveDays, minUsdWei, minSamples, exclude, fromBlock, usdc, ethUsdFeed, confirmations, chunk }
import { parseAbi, parseAbiItem } from 'viem';
import { fundingStatus } from './points-funding.js';
import { rateLimited } from './holding-scan.js';
import {
  WAD, lpTermsForDay, nextLpTerms, poolValueUsd, allocateLpDay, openId, dayId, dayOf, dayIsDone, holdReason, reserveFor, dayMinimums, medianOf, CREDIT_PREFIX,
} from './points-lp.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const HOUR = 3600, DAY = 86400, FEED_MAX_AGE = 3 * HOUR;
const POOL_ABI = parseAbi([
  'function token0() view returns (address)', 'function token1() view returns (address)', 'function reserve0() view returns (uint128)', 'function reserve1() view returns (uint128)',
  'function totalSupply() view returns (uint256)', 'function sqrtPriceCurrent() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
]);
const FEED_ABI = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const lower = (a) => String(a).toLowerCase();
class Hold extends Error { constructor(why) { super(why); this.why = why; } }

export function createLp({ store, client, cfg, fundingInputs, budgetFor, graceSecs = 0, nowSec = () => Math.floor(Date.now() / 1000), log = () => {} }) {
  const pools = cfg.pools ?? [];
  const enabled = cfg.pocketWei > 0n && cfg.endSec > 0 && pools.length > 0 && (cfg.schedule ?? []).length > 0;
  const reserveDays = cfg.reserveDays ?? 2, minUsdWei = cfg.minUsdWei ?? 20n * WAD, minSamples = cfg.minSamples ?? 12;
  const confirmations = cfg.confirmations ?? 12, chunk = cfg.chunk ?? 2000, budgetMs = cfg.budgetMs ?? 30_000;
  // Never paid: nobody's, the dead address, and the pools themselves. A contract that holds shares for others (a farm) is paid as one
  // holder unless it is listed in cfg.exclude.
  const exclude = new Set([ZERO, DEAD, ...pools.map((p) => lower(p.pool)), ...(cfg.exclude ?? []).map(lower)]);
  const db = store.db;
  if (enabled) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lp_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lp_cursor (pool TEXT PRIMARY KEY, block INTEGER NOT NULL, ts INTEGER NOT NULL, supply TEXT NOT NULL, verified INTEGER);
      CREATE TABLE IF NOT EXISTS lp_events (pool TEXT NOT NULL, block INTEGER NOT NULL, idx INTEGER NOT NULL, ts INTEGER NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (pool, block, idx));
      CREATE TABLE IF NOT EXISTS lp_openers (pool TEXT PRIMARY KEY, address TEXT NOT NULL, block INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lp_bal (pool TEXT NOT NULL, address TEXT NOT NULL, bal TEXT NOT NULL, PRIMARY KEY (pool, address));
      CREATE TABLE IF NOT EXISTS lp_samples (day INTEGER NOT NULL, hour INTEGER NOT NULL, pool TEXT NOT NULL, taken_at INTEGER NOT NULL, pool_usd TEXT NOT NULL, supply TEXT NOT NULL, vps TEXT NOT NULL, PRIMARY KEY (day, hour, pool));
      CREATE TABLE IF NOT EXISTS lp_days (day INTEGER PRIMARY KEY, paid_at INTEGER NOT NULL, wei TEXT NOT NULL);
    `);
  }
  const stmts = new Map();
  const q = (sql) => { if (!stmts.has(sql)) stmts.set(sql, db.prepare(sql)); return stmts.get(sql); };
  const getMeta = (k) => q('SELECT v FROM lp_meta WHERE k = ?').get(k)?.v ?? null;
  const setMeta = (k, v) => q('INSERT INTO lp_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
  let lastHold = '';
  const noted = new Set();
  const noteOnce = (key, text) => { if (noted.size > 500) noted.clear(); if (!noted.has(key)) { noted.add(key); log(text); } };

  // ── the shares' transfers ──

  // The times of the blocks a stretch's transfers are in, ten at a time, and false if the stretch's time ran out first.
  async function blockTimes(blocks, cache, began) {
    const need = [...new Set(blocks)].filter((n) => !cache.has(n));
    for (let i = 0; i < need.length; i += 10) {
      if (Date.now() - began >= budgetMs) return false;
      await Promise.all(need.slice(i, i + 10).map(async (n) => { cache.set(n, Number((await client.getBlock({ blockNumber: BigInt(n) })).timestamp)); }));
    }
    return true;
  }
  const chunks = new Map();                                   // each pool's stretch of blocks, halved when a stretch takes too long and grown again when it does not

  // Whether the pool's replay agrees with the chain at `cursor`: what the transfers add up to, plus what the zero address holds, is the total supply.
  async function agrees(p, cursor, replay) {
    const at = BigInt(cursor), code = await client.getCode({ address: p, blockNumber: at });
    if (!code || code === '0x') return replay === 0n;           // not deployed yet: nothing can have been minted
    const [supply, parked] = await Promise.all([
      client.readContract({ address: p, abi: POOL_ABI, functionName: 'totalSupply', blockNumber: at }),
      client.readContract({ address: p, abi: POOL_ABI, functionName: 'balanceOf', args: [ZERO], blockNumber: at }),
    ]);
    return supply === replay + parked;
  }

  // Reads each pool's share transfers into the store as far as they are final, a bounded stretch at a time: a node that refuses a range is
  // asked for less, a rate limit ends the stretch to resume next cycle, and the cursor only moves over blocks whose events are stored. Then
  // checks the replay against the chain.
  async function scan() {
    const head = Number(await client.getBlockNumber()), safe = head - confirmations;
    if (getMeta('start_block') === null) setMeta('start_block', cfg.fromBlock ?? safe);
    else if (cfg.fromBlock && Number(getMeta('start_block')) !== cfg.fromBlock) noteOnce('fromblock', `lp: POINTS_LP_FROM_BLOCK is ${cfg.fromBlock} but the scan began at ${getMeta('start_block')}, which is kept`);
    if (Number(getMeta('start_block')) > safe) noteOnce('ahead', `lp: the scan starts at block ${getMeta('start_block')}, ahead of the chain's final head ${safe}; nothing is read until then`);
    const times = new Map(), began = Date.now();
    for (const { pool } of pools) {
      const p = lower(pool);
      const cur = q('SELECT block, ts, supply, verified FROM lp_cursor WHERE pool = ?').get(p) ?? { block: Number(getMeta('start_block')) - 1, ts: 0, supply: '0', verified: null };
      let cursor = cur.block, supply = BigInt(cur.supply), moved = false;
      while (cursor < safe && Date.now() - began < budgetMs) {                 // a stretch is bounded: the rest waits for the next cycle, so the scan never holds the loop it runs in
        const size = chunks.get(p) ?? chunk, from = cursor + 1, to = Math.min(from + size - 1, safe);
        let logs;
        try { logs = await client.getLogs({ address: p, event: TRANSFER, fromBlock: BigInt(from), toBlock: BigInt(to) }); } catch (err) {
          if (rateLimited(err)) { noteOnce(`rl${p}${from}`, `lp scan ${p}: rate limited at block ${from}, resuming next cycle`); break; }
          if (size > 50) { chunks.set(p, Math.max(50, Math.floor(size / 2))); continue; }
          log(`lp scan ${p}: blocks ${from}-${to} failed: ${String(err?.shortMessage || err?.message || err).slice(0, 200)}`); break;
        }
        try {
          // The transfers in the order they happened, whatever order the node gave them in, each once.
          const sorted = logs.filter((l) => l.args.value !== 0n).map((l) => ({ block: Number(l.blockNumber), idx: l.logIndex, from: lower(l.args.from), to: lower(l.args.to), value: l.args.value }))
            .sort((x, y) => x.block - y.block || x.idx - y.idx);
          if (!(await blockTimes([...sorted.map((r) => r.block), to], times, began))) { chunks.set(p, Math.max(50, Math.floor(size / 2))); noteOnce(`slow${p}`, `lp scan ${p}: the node is slow, reading fewer blocks at a time`); break; }
          db.transaction(() => {
            for (const r of sorted) {
              const added = q('INSERT OR IGNORE INTO lp_events (pool, block, idx, ts, from_addr, to_addr, value) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p, r.block, r.idx, times.get(r.block), r.from, r.to, String(r.value)).changes;
              if (added !== 1) continue;                                       // a log the node gave twice counts once
              if (r.from === ZERO) supply += r.value;
              if (r.to === ZERO) supply -= r.value;
              for (const [a, d] of [[r.from, -r.value], [r.to, r.value]]) {
                if (a === ZERO) continue;
                const had = q('SELECT bal FROM lp_bal WHERE pool = ? AND address = ?').get(p, a)?.bal;
                q('INSERT INTO lp_bal (pool, address, bal) VALUES (?, ?, ?) ON CONFLICT(pool, address) DO UPDATE SET bal = excluded.bal').run(p, a, String(BigInt(had ?? 0) + d));
              }
              // The first shares minted to anyone but the dead address (the pool keeps a thousand of the first deposit there for good).
              if (r.from === ZERO && r.to !== DEAD && r.to !== ZERO) q('INSERT OR IGNORE INTO lp_openers (pool, address, block) VALUES (?, ?, ?)').run(p, r.to, r.block);
            }
            q('INSERT INTO lp_cursor (pool, block, ts, supply, verified) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(pool) DO UPDATE SET block = excluded.block, ts = excluded.ts, supply = excluded.supply, verified = NULL').run(p, to, times.get(to), String(supply));
          })();
          cursor = to; moved = true; chunks.set(p, Math.min(chunk, size * 2));
        } catch (err) { log(`lp scan ${p}: blocks ${from}-${to} could not be stored: ${String(err?.shortMessage || err?.message || err).slice(0, 200)}`); break; }
      }
      // The replay must agree with the chain at the block the scan has reached; otherwise it began too late or missed a log, and this pool is not
      // counted (a mismatch) or its days wait (not yet checked).
      if (moved || cur.verified == null) {
        const have = q('SELECT 1 FROM lp_cursor WHERE pool = ?').get(p);
        if (have) {
          try {
            const ok = await agrees(p, cursor, supply);
            q('UPDATE lp_cursor SET verified = ? WHERE pool = ?').run(ok ? 1 : 0, p);
            if (!ok) noteOnce(`bad${p}`, `lp pool ${p}: its transfers do not add up to the pool's supply at block ${cursor}; not counted (start the scan, POINTS_LP_FROM_BLOCK, before the pool was opened)`);
          } catch (err) { noteOnce(`sup${p}${cursor}`, `lp pool ${p}: its supply at block ${cursor} could not be read (${String(err?.shortMessage || err?.message || err).slice(0, 120)}); its days wait`); }
        }
      }
    }
  }

  // ── what a pool is worth ──

  const metas = new Map();
  // The pool's tokens: which is ETH or USDC (the quote) and which the synth, and the quote's decimals; null for a pool of anything else.
  async function metaOf(pool) {
    if (metas.has(pool)) return metas.get(pool);
    const [t0, t1] = (await Promise.all([client.readContract({ address: pool, abi: POOL_ABI, functionName: 'token0' }), client.readContract({ address: pool, abi: POOL_ABI, functionName: 'token1' })])).map(lower);
    const usdc = lower(cfg.usdc ?? '');
    let m = null;
    if (t0 === ZERO) m = { synthIs1: true, quote: 'ETH', quoteDec: 18 };
    else if (usdc && t0 === usdc) m = { synthIs1: true, quote: 'USDC', quoteDec: 6 };
    else if (usdc && t1 === usdc) m = { synthIs1: false, quote: 'USDC', quoteDec: 6 };
    else noteOnce(`meta${pool}`, `lp pool ${pool} is neither against ETH nor USDC: not valued`);
    metas.set(pool, m);
    return m;
  }
  // The ETH price in dollars (1e18), or null when the feed is silent, stopped or older than three hours.
  async function ethUsdWei(t) {
    if (!cfg.ethUsdFeed) return null;
    const r = await client.readContract({ address: cfg.ethUsdFeed, abi: FEED_ABI, functionName: 'latestRoundData' });
    if (!(r[1] > 0n) || t - Number(r[3]) > FEED_MAX_AGE) return null;
    return r[1] * 10n ** 10n;                                            // eight decimals to 1e18
  }

  // One reading of each pool's value per share, once an hour. No holder is read: what each holds comes from the transfers.
  async function sample() {
    const t = nowSec(), day = dayOf(t), hour = Math.floor((t % DAY) / HOUR);
    let ethUsd;
    for (const { pool } of pools) {
      const p = lower(pool);
      if (q('SELECT 1 FROM lp_samples WHERE day = ? AND hour = ? AND pool = ?').get(day, hour, p)) continue;
      const seen = q('SELECT supply FROM lp_cursor WHERE pool = ?').get(p);
      if (!seen || BigInt(seen.supply) <= 0n) continue;                  // nothing minted yet (the pool may not exist): there is no value per share to read
      try {
        const meta = await metaOf(p);
        if (!meta) continue;
        let quoteUsdWei = WAD;
        if (meta.quote === 'ETH') { ethUsd ??= await ethUsdWei(t); quoteUsdWei = ethUsd; }
        if (quoteUsdWei == null) { noteOnce(`px${day}${hour}`, 'lp sample: no fresh ETH price, hour left unsampled'); continue; }
        const [r0, r1, supply, sqrtNow] = await Promise.all(['reserve0', 'reserve1', 'totalSupply', 'sqrtPriceCurrent'].map((functionName) => client.readContract({ address: p, abi: POOL_ABI, functionName })));
        if (!(supply > 0n)) continue;                                    // an empty pool has no value per share
        const value = poolValueUsd({ reserveSynth: meta.synthIs1 ? r1 : r0, reserveQuote: meta.synthIs1 ? r0 : r1, quoteDec: meta.quoteDec, sqrtNow, synthIs1: meta.synthIs1, quoteUsdWei });
        if (value === null) { noteOnce(`val${p}${day}${hour}`, `lp sample: ${p} could not be valued`); continue; }
        q('INSERT OR IGNORE INTO lp_samples (day, hour, pool, taken_at, pool_usd, supply, vps) VALUES (?, ?, ?, ?, ?, ?, ?)').run(day, hour, p, t, String(value), String(supply), String((value * WAD) / supply));
      } catch (err) { log(`lp sample ${p} failed: ${String(err?.shortMessage || err?.message || err).slice(0, 200)}`); }
    }
  }

  // ── a day's credits ──

  const eventsOf = (pool, endTs) => q('SELECT ts, from_addr, to_addr, value FROM lp_events WHERE pool = ? AND ts < ? ORDER BY block, idx').all(pool, endTs).map((r) => ({ ts: r.ts, from: r.from_addr, to: r.to_addr, value: BigInt(r.value) }));
  const valuePerShare = (day, pool) => {
    const v = q('SELECT vps FROM lp_samples WHERE day = ? AND pool = ?').all(day, pool).map((r) => BigInt(r.vps));
    return v.length >= minSamples ? medianOf(v) : null;
  };

  // Whether the day can be read for every pool yet: each pool's transfers read through the end of the day, and checked against the chain.
  // 'wait' when not yet, 'ok', or 'skip' for a pool whose replay disagrees with the chain (it is not counted).
  function readiness(day) {
    const end = (day + 1) * DAY, out = new Map();
    let wait = false;
    for (const { pool } of pools) {
      const p = lower(pool), c = q('SELECT ts, verified FROM lp_cursor WHERE pool = ?').get(p);
      if (!c || c.ts < end || c.verified == null) { wait = true; continue; }
      out.set(p, c.verified === 1 ? 'ok' : 'skip');
    }
    return { wait, pools: out };
  }

  // What the day pays: the day's credits for holding liquidity, and the opening bonuses now due. A day's figures are fixed once it has been read through its
  // end, so they are kept (a day that is held for funding is looked at every cycle); the bonuses are asked again each time.
  const plans = new Map();
  function planDay(day, terms, ready) {
    const hit = plans.get(day);
    if (hit) return { credits: hit.credits, bonuses: hit.bonuses.filter((b) => !q('SELECT 1 FROM reward_adjustments WHERE id = ?').get(b.id)) };
    const plan = computeDay(day, terms, ready);
    if (plans.size > 8) plans.clear();
    plans.set(day, plan);
    return plan;
  }
  function computeDay(day, terms, ready) {
    const start = day * DAY, end = start + DAY, rows = [], mins = new Map();
    for (const { pool, weightBps } of pools) {
      const p = lower(pool);
      if (ready.pools.get(p) !== 'ok') continue;
      const vps = valuePerShare(day, p);
      if (vps === null) { noteOnce(`few${day}${p}`, `lp day ${day}: ${p} has fewer than ${minSamples} readings of its value, its liquidity is not counted`); continue; }
      const held = new Map();
      for (const [address, shares] of dayMinimums(eventsOf(p, end), start, end)) held.set(address, (shares * vps) / WAD);
      mins.set(p, held);
      for (const [address, valueUsdWei] of held) if (!exclude.has(address) && valueUsdWei >= WAD) rows.push({ address, pool: p, valueUsdWei, weightBps });
    }
    const credits = allocateLpDay({ rows, dailyWei: terms.dailyWei, capWeiPerUsdDay: terms.capWeiPerUsdDay })
      .map((a) => ({ id: dayId(day, a.address), address: a.address, wei: a.wei })).filter((c) => c.wei > 0n);
    const bonuses = [];
    if (terms.createWei > 0n) {
      for (const [p, held] of mins) {
        const opener = q('SELECT address FROM lp_openers WHERE pool = ?').get(p)?.address;
        if (!opener || exclude.has(opener) || (held.get(opener) ?? 0n) < minUsdWei) continue;
        if (q('SELECT 1 FROM reward_adjustments WHERE id = ?').get(openId(p))) continue;
        bonuses.push({ id: openId(p), address: opener, wei: terms.createWei });
      }
    }
    return { credits, bonuses };
  }

  // Credits `credits` together, or none: the pocket is checked inside the same transaction that writes them, so nothing can overdraw it
  // between the check and the credit. `markDay` closes the day in that transaction.
  const applyAll = db.transaction((credits, markDay, t) => {
    const total = credits.reduce((s, c) => s + c.wei, 0n);
    if (store.creditedWithPrefix(CREDIT_PREFIX) + total > cfg.pocketWei) throw new Hold('pocket');
    for (const c of credits) store.applyAdjustment({ id: c.id, address: c.address, wei: c.wei });
    if (markDay != null) q('INSERT OR IGNORE INTO lp_days (day, paid_at, wei) VALUES (?, ?, ?)').run(markDay, t, String(total));
    return total;
  });

  // Why `wei` more has to wait (see holdReason), with the funding read now.
  async function holdFor(wei, t) {
    const inputs = await fundingInputs().catch(() => null);
    const ledger = store.allRewards().reduce((s, r) => s + BigInt(r.cumulativeWei), 0n);
    const need = inputs ? reserveFor({ reserveDays, nextDay: inputs.nextDay, budgetFor }) : reserveDays;
    return holdReason({
      wei, creditedWei: store.creditedWithPrefix(CREDIT_PREFIX), pocketWei: cfg.pocketWei, nowSec: t, endSec: cfg.endSec, reserveDays: need,
      status: (extra) => (inputs ? fundingStatus({ heldWei: inputs.heldWei, claimedWei: inputs.claimedWei, ledgerWei: ledger + extra, budgetFor, nextDay: inputs.nextDay, graceSecs }) : null),
    });
  }
  const said = (why, text) => { if (why !== lastHold) { lastHold = why; log(`lp credits wait: ${why} (${text})`); } };

  async function settle() {
    const lastPaid = q('SELECT MAX(day) AS d FROM lp_days').get()?.d;
    const startDay = dayOf(Number(getMeta('enabled_at') ?? nowSec()));
    let day = lastPaid == null ? Math.max(startDay, cfg.schedule[0].fromDay) : lastPaid + 1;
    const t = nowSec();
    for (; dayIsDone(day, t, graceSecs); day++) {
      const terms = lpTermsForDay(cfg.schedule, day);
      if (!terms) { q('INSERT OR IGNORE INTO lp_days (day, paid_at, wei) VALUES (?, ?, ?)').run(day, t, '0'); continue; }
      const ready = readiness(day);
      if (ready.wait) { said('scan', `day ${day}: the pools' transfers are not read through its end yet`); return; }
      const { credits, bonuses } = planDay(day, terms, ready);
      const total = credits.reduce((s, c) => s + c.wei, 0n);
      if (total > 0n) {
        const why = await holdFor(total, t);
        if (why) { said(why, `day ${day}, ${credits.length} credit(s)`); return; }
        try { applyAll(credits, day, t); } catch (err) { if (err instanceof Hold) { said(err.why, `day ${day}`); return; } throw err; }
        lastHold = ''; log(`lp day ${day}: ${total} wei to ${credits.length} credit(s)`);
      } else q('INSERT OR IGNORE INTO lp_days (day, paid_at, wei) VALUES (?, ?, ?)').run(day, t, '0');
      // An opening bonus is its own credit: one that cannot go yet (the pocket) does not hold back the days, and is offered again each day.
      for (const b of bonuses) {
        const why = await holdFor(b.wei, t);
        if (why) { said(why, `the opening bonus of ${b.id}`); continue; }
        try { applyAll([b], null, t); log(`lp opening bonus ${b.id}: ${b.wei} wei to ${b.address}`); } catch (err) { if (err instanceof Hold) { said(err.why, `the opening bonus of ${b.id}`); continue; } throw err; }
      }
    }
  }

  async function cycle() {
    if (!enabled) return;
    if (nowSec() > cfg.endSec + 3 * DAY) return;                           // well past the end: nothing is read, sampled or paid any more
    if (getMeta('enabled_at') === null) setMeta('enabled_at', nowSec());
    try { await scan(); } catch (err) { log('lp scan failed:', err?.message || err); }
    try { await sample(); } catch (err) { log('lp sample failed:', err?.message || err); }
    try { await settle(); } catch (err) { log('lp credits failed:', err?.message || err); }
  }

  // ── what a page shows ──

  const str = (x) => (x == null ? null : String(x));
  // What this address has been credited by the campaign, in all.
  function sumFor(address) {
    return db.prepare(`SELECT wei FROM reward_adjustments WHERE id LIKE ? ESCAPE '\\' AND address = ?`).all(`${CREDIT_PREFIX.replace(/[\\%_]/g, (c) => '\\' + c)}%`, address).reduce((s, r) => s + BigInt(r.wei), 0n);
  }
  // A page may ask often, and an account's part is read from every transfer: the answer is kept for fifteen seconds.
  const memo = new Map();
  function view(opts = {}) {
    if (!enabled) return { enabled: false };
    const key = String(opts.address ?? '').toLowerCase(), t = Date.now(), hit = memo.get(key);
    if (hit && t - hit.t < 15_000) return hit.v;
    const v = build(opts);
    if (memo.size > 200) memo.clear();
    memo.set(key, { t, v });
    return v;
  }
  function build({ address = null } = {}) {
    const t = nowSec(), day = dayOf(t), terms = lpTermsForDay(cfg.schedule, day), next = nextLpTerms(cfg.schedule, day), credited = store.creditedWithPrefix(CREDIT_PREFIX);
    const me = address ? lower(address) : null;
    const termsOut = (e) => (e ? { fromDay: e.fromDay, dailyWei: str(e.dailyWei), createWei: str(e.createWei), capWeiPerUsdDay: str(e.capWeiPerUsdDay) } : null);
    return {
      enabled: true,
      endSec: cfg.endSec,
      pocket: { totalWei: String(cfg.pocketWei), creditedWei: String(credited), remainingWei: String(cfg.pocketWei > credited ? cfg.pocketWei - credited : 0n) },
      terms: termsOut(terms), next: termsOut(next), minUsdWei: String(minUsdWei), minSamples,
      pools: pools.map(({ pool, weightBps }) => {
        const p = lower(pool), latest = q('SELECT day, hour, pool_usd, vps FROM lp_samples WHERE pool = ? ORDER BY day DESC, hour DESC LIMIT 1').get(p);
        const opener = q('SELECT address FROM lp_openers WHERE pool = ?').get(p)?.address ?? null;
        let mine = null;
        if (me && latest) mine = (BigInt(q('SELECT bal FROM lp_bal WHERE pool = ? AND address = ?').get(p, me)?.bal ?? 0) * BigInt(latest.vps)) / WAD;
        return {
          pool: p, weightBps: String(weightBps), valueUsdWei: latest ? latest.pool_usd : null, sampledAt: latest ? latest.day * DAY + latest.hour * HOUR : null,
          opened: !!opener, opener, openPaid: !!q('SELECT 1 FROM reward_adjustments WHERE id = ?').get(openId(p)),
          ...(me ? { mineUsdWei: String(mine ?? 0n) } : {}),
        };
      }),
      today: { day, samples: q('SELECT COUNT(DISTINCT hour) AS n FROM lp_samples WHERE day = ?').get(day).n, hour: Math.floor((t % DAY) / HOUR) },
      ...(me ? { mine: { address: me, creditedWei: String(sumFor(me)), opened: pools.filter(({ pool }) => q('SELECT 1 FROM lp_openers WHERE pool = ? AND address = ?').get(lower(pool), me)).map(({ pool }) => lower(pool)) } } : {}),
    };
  }

  return { enabled, cycle, scan, sample, settle, view };
}
