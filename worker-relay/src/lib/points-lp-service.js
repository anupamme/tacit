// The liquidity campaign as the points service runs it (rules in lib/points-lp.js), off unless a pocket, an end time, a schedule
// and at least one pool are set.
//
// It follows the pools it is told about (POINTS_LP_POOLS): each cycle it reads their shares' Transfer logs for who holds any, takes
// an hourly sample of each pool's value and of what every holder's shares are worth, and, once a UTC day is over, credits that
// day's amount to the addresses that held liquidity for ALL of it (each is credited on its lowest sample of the day, so nothing
// that comes and goes between samples earns anything). The first address to be minted shares in a pool is its opener; it is paid
// the opening bonus once its own liquidity has stayed above the minimum for a whole day.
//
// A credit is an ordinary ledger adjustment (lib/points-adjustments.js): it adds to what an address is owed and touches no day's
// split. Every credit waits while the campaign's pocket would be overdrawn or the distributor's funding would stop covering the
// regular pot, and what waits is credited later, never dropped (a day is marked paid only once all of it has been).
//
// deps: store, client (a viem public client), cfg (see below), fundingInputs() -> { heldWei, claimedWei, nextDay } | null, budgetFor(day),
// graceSecs, nowSec, log.
//   cfg: { schedule, pools, pocketWei, endSec, reserveDays, minUsdWei, minSamples, exclude, fromBlock, usdc, ethUsdFeed, confirmations, chunk }
import { parseAbi, parseAbiItem } from 'viem';
import { fundingStatus } from './points-funding.js';
import { rateLimited } from './holding-scan.js';
import {
  WAD, lpTermsForDay, nextLpTerms, poolValueUsd, shareValueUsd, allocateLpDay, openId, dayId, dayOf, dayIsDone, holdReason, CREDIT_PREFIX,
} from './points-lp.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const HOUR = 3600;
const POOL_ABI = parseAbi([
  'function token0() view returns (address)', 'function token1() view returns (address)', 'function reserve0() view returns (uint128)', 'function reserve1() view returns (uint128)',
  'function totalSupply() view returns (uint256)', 'function sqrtPriceCurrent() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
]);
const FEED_ABI = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const lower = (a) => String(a).toLowerCase();

export function createLp({ store, client, cfg, fundingInputs, budgetFor, graceSecs = 0, nowSec = () => Math.floor(Date.now() / 1000), log = () => {} }) {
  const pools = cfg.pools ?? [];
  const enabled = cfg.pocketWei > 0n && cfg.endSec > 0 && pools.length > 0 && (cfg.schedule ?? []).length > 0;
  const reserveDays = cfg.reserveDays ?? 2, minUsdWei = cfg.minUsdWei ?? 20n * WAD, minSamples = cfg.minSamples ?? 12;
  const exclude = new Set([...(cfg.exclude ?? [])].map(lower)), confirmations = cfg.confirmations ?? 12, chunk = cfg.chunk ?? 2000;
  const weightOf = new Map(pools.map((p) => [lower(p.pool), p.weightBps]));
  const db = store.db;
  if (enabled) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lp_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lp_cursor (pool TEXT PRIMARY KEY, block INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lp_holders (pool TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY (pool, address));
      CREATE TABLE IF NOT EXISTS lp_openers (pool TEXT PRIMARY KEY, address TEXT NOT NULL, block INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lp_samples (day INTEGER NOT NULL, hour INTEGER NOT NULL, pool TEXT NOT NULL, taken_at INTEGER NOT NULL, pool_usd TEXT NOT NULL, supply TEXT NOT NULL, PRIMARY KEY (day, hour, pool));
      CREATE TABLE IF NOT EXISTS lp_balances (day INTEGER NOT NULL, hour INTEGER NOT NULL, pool TEXT NOT NULL, address TEXT NOT NULL, value_usd TEXT NOT NULL, PRIMARY KEY (day, hour, pool, address));
      CREATE TABLE IF NOT EXISTS lp_days (day INTEGER PRIMARY KEY, paid_at INTEGER NOT NULL, wei TEXT NOT NULL);
    `);
  }
  const q = (sql) => db.prepare(sql);
  const getMeta = (k) => q('SELECT v FROM lp_meta WHERE k = ?').get(k)?.v ?? null;
  const setMeta = (k, v) => q('INSERT INTO lp_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
  let lastHold = '';
  const noted = new Set();
  const noteOnce = (key, text) => { if (!noted.has(key)) { noted.add(key); log(text); } };

  // ── who holds shares ──

  async function scan() {
    const head = Number(await client.getBlockNumber()), safe = head - confirmations;
    if (getMeta('start_block') === null) setMeta('start_block', cfg.fromBlock ?? safe);
    for (const { pool } of pools) {
      const p = lower(pool);
      let cursor = q('SELECT block FROM lp_cursor WHERE pool = ?').get(p)?.block ?? Number(getMeta('start_block')) - 1, size = chunk;
      while (cursor < safe) {
        const from = cursor + 1, to = Math.min(from + size - 1, safe);
        let logs;
        try { logs = await client.getLogs({ address: p, event: TRANSFER, fromBlock: BigInt(from), toBlock: BigInt(to) }); } catch (err) {
          if (rateLimited(err)) { noteOnce(`rl${p}${from}`, `lp scan ${p}: rate limited at block ${from}, resuming next cycle`); break; }
          if (size > 50) { size = Math.max(50, Math.floor(size / 2)); continue; }
          log(`lp scan ${p}: blocks ${from}-${to} failed: ${String(err?.shortMessage || err?.message || err).slice(0, 200)}`); break;
        }
        db.transaction(() => {
          for (const l of logs) {
            const [fromAddr, toAddr] = [lower(l.args.from), lower(l.args.to)];
            if (toAddr !== ZERO) q('INSERT OR IGNORE INTO lp_holders (pool, address) VALUES (?, ?)').run(p, toAddr);
            // The first shares minted to anyone but the dead address (the pool keeps a thousand of the first deposit there for good).
            if (fromAddr === ZERO && toAddr !== DEAD && toAddr !== ZERO) q('INSERT OR IGNORE INTO lp_openers (pool, address, block) VALUES (?, ?, ?)').run(p, toAddr, Number(l.blockNumber));
          }
          q('INSERT INTO lp_cursor (pool, block) VALUES (?, ?) ON CONFLICT(pool) DO UPDATE SET block = excluded.block').run(p, to);
        })();
        cursor = to; size = Math.min(chunk, size * 2);
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
  async function ethUsdWei() {
    if (!cfg.ethUsdFeed) return null;
    const r = await client.readContract({ address: cfg.ethUsdFeed, abi: FEED_ABI, functionName: 'latestRoundData' });
    return r[1] > 0n ? r[1] * 10n ** 10n : null;                        // eight decimals to 1e18
  }

  // One sample of each pool, once an hour: its value and what each holder's shares were worth.
  async function sample() {
    const t = nowSec(), day = dayOf(t), hour = Math.floor((t % 86400) / HOUR);
    let ethUsd;
    for (const { pool } of pools) {
      const p = lower(pool);
      if (q('SELECT 1 FROM lp_samples WHERE day = ? AND hour = ? AND pool = ?').get(day, hour, p)) continue;
      try {
        const meta = await metaOf(p);
        if (!meta) continue;
        let quoteUsdWei = WAD;
        if (meta.quote === 'ETH') { ethUsd ??= await ethUsdWei(); quoteUsdWei = ethUsd; }
        if (quoteUsdWei == null) { noteOnce(`px${day}${hour}`, 'lp sample: no ETH price, hour left unsampled'); continue; }
        const [r0, r1, supply, sqrtNow] = await Promise.all(['reserve0', 'reserve1', 'totalSupply', 'sqrtPriceCurrent'].map((functionName) => client.readContract({ address: p, abi: POOL_ABI, functionName })));
        const value = supply > 0n ? poolValueUsd({
          reserveSynth: meta.synthIs1 ? r1 : r0, reserveQuote: meta.synthIs1 ? r0 : r1, quoteDec: meta.quoteDec, sqrtNow, synthIs1: meta.synthIs1, quoteUsdWei,
        }) : 0n;
        if (value === null) { noteOnce(`val${p}${day}${hour}`, `lp sample: ${p} could not be valued`); continue; }
        const holders = q('SELECT address FROM lp_holders WHERE pool = ?').all(p).map((r) => r.address);
        const rows = [];
        for (const address of holders) {
          const bal = await client.readContract({ address: p, abi: POOL_ABI, functionName: 'balanceOf', args: [address] });
          const v = shareValueUsd(bal, supply, value);
          if (v > 0n) rows.push([address, v]);
        }
        db.transaction(() => {
          q('INSERT OR IGNORE INTO lp_samples (day, hour, pool, taken_at, pool_usd, supply) VALUES (?, ?, ?, ?, ?, ?)').run(day, hour, p, t, String(value), String(supply));
          for (const [address, v] of rows) q('INSERT OR IGNORE INTO lp_balances (day, hour, pool, address, value_usd) VALUES (?, ?, ?, ?, ?)').run(day, hour, p, address, String(v));
        })();
      } catch (err) { log(`lp sample ${p} failed: ${String(err?.shortMessage || err?.message || err).slice(0, 200)}`); }
    }
  }

  // ── a day's credits ──

  // Each address's lowest value of liquidity in the pool across the day's samples (an address missing from a sample held none then),
  // or null for a pool with too few samples to say.
  function lowest(day, pool) {
    const hours = q('SELECT hour FROM lp_samples WHERE day = ? AND pool = ? ORDER BY hour').all(day, pool).map((r) => r.hour);
    if (hours.length < minSamples) return null;
    const seen = new Map();
    for (const r of q('SELECT hour, address, value_usd FROM lp_balances WHERE day = ? AND pool = ?').all(day, pool)) {
      if (!seen.has(r.address)) seen.set(r.address, new Map());
      seen.get(r.address).set(r.hour, BigInt(r.value_usd));
    }
    const out = new Map();
    for (const [address, byHour] of seen) {
      let low = null;
      for (const h of hours) { const v = byHour.get(h) ?? 0n; if (low === null || v < low) low = v; }
      out.set(address, low ?? 0n);
    }
    return out;
  }

  // What the day pays: { credits: [{ id, address, wei }], total }, or null when its samples cannot say.
  function planDay(day, terms) {
    const rows = [], mins = new Map();
    let sampled = 0;
    for (const { pool, weightBps } of pools) {
      const p = lower(pool), m = lowest(day, p);
      if (!m) { noteOnce(`few${day}${p}`, `lp day ${day}: ${p} has fewer than ${minSamples} samples, its liquidity is not counted`); continue; }
      sampled += 1;
      mins.set(p, m);
      for (const [address, valueUsdWei] of m) if (!exclude.has(address) && valueUsdWei >= WAD) rows.push({ address, pool: p, valueUsdWei, weightBps });
    }
    const credits = [];
    for (const a of allocateLpDay({ rows, dailyWei: terms.dailyWei, capWeiPerUsdDay: terms.capWeiPerUsdDay })) credits.push({ id: dayId(day, a.address), address: a.address, wei: a.wei });
    if (terms.createWei > 0n) {
      for (const [p, m] of mins) {
        const opener = q('SELECT address FROM lp_openers WHERE pool = ?').get(p)?.address;
        if (!opener || exclude.has(opener) || (m.get(opener) ?? 0n) < minUsdWei) continue;
        if (q('SELECT 1 FROM reward_adjustments WHERE id = ?').get(openId(p))) continue;
        credits.push({ id: openId(p), address: opener, wei: terms.createWei });
      }
    }
    return { credits: credits.filter((c) => c.wei > 0n), sampled };
  }

  async function settle() {
    const lastPaid = q('SELECT MAX(day) AS d FROM lp_days').get()?.d;
    const startDay = dayOf(Number(getMeta('enabled_at') ?? nowSec()));
    let day = lastPaid == null ? Math.max(startDay, cfg.schedule[0].fromDay) : lastPaid + 1;
    const t = nowSec();
    for (; dayIsDone(day, t, graceSecs); day++) {
      const terms = lpTermsForDay(cfg.schedule, day);
      if (!terms) { q('INSERT OR IGNORE INTO lp_days (day, paid_at, wei) VALUES (?, ?, ?)').run(day, t, '0'); continue; }
      const { credits } = planDay(day, terms);
      const total = credits.reduce((s, c) => s + c.wei, 0n);
      if (total > 0n) {
        const inputs = await fundingInputs().catch(() => null);
        const ledger = store.allRewards().reduce((s, r) => s + BigInt(r.cumulativeWei), 0n);
        const credited = store.creditedWithPrefix(CREDIT_PREFIX);
        const why = holdReason({
          wei: total, creditedWei: credited, pocketWei: cfg.pocketWei, nowSec: t, endSec: cfg.endSec, reserveDays,
          status: (extra) => (inputs ? fundingStatus({ heldWei: inputs.heldWei, claimedWei: inputs.claimedWei, ledgerWei: ledger + extra, budgetFor, nextDay: inputs.nextDay, graceSecs }) : null),
        });
        if (why) { if (why !== lastHold) { lastHold = why; log(`lp credits wait: ${why} (day ${day}, ${credits.length} credit(s))`); } return; }
        db.transaction(() => { for (const c of credits) store.applyAdjustment({ id: c.id, address: c.address, wei: c.wei }); q('INSERT OR IGNORE INTO lp_days (day, paid_at, wei) VALUES (?, ?, ?)').run(day, t, String(total)); })();
        lastHold = ''; log(`lp day ${day}: ${total} wei to ${credits.length} credit(s)`);
      } else q('INSERT OR IGNORE INTO lp_days (day, paid_at, wei) VALUES (?, ?, ?)').run(day, t, '0');
    }
  }

  async function cycle() {
    if (!enabled) return;
    if (getMeta('enabled_at') === null) setMeta('enabled_at', nowSec());
    try { await scan(); } catch (err) { log('lp scan failed:', err?.message || err); }
    try { await sample(); } catch (err) { log('lp sample failed:', err?.message || err); }
    try { await settle(); } catch (err) { log('lp credits failed:', err?.message || err); }
  }

  // ── what a page shows ──

  const str = (x) => (x == null ? null : String(x));
  function view({ address = null } = {}) {
    if (!enabled) return { enabled: false };
    const t = nowSec(), day = dayOf(t), terms = lpTermsForDay(cfg.schedule, day), next = nextLpTerms(cfg.schedule, day), credited = store.creditedWithPrefix(CREDIT_PREFIX);
    const me = address ? lower(address) : null;
    const hourNow = Math.floor((t % 86400) / HOUR);
    const termsOut = (e) => (e ? { fromDay: e.fromDay, dailyWei: str(e.dailyWei), createWei: str(e.createWei), capWeiPerUsdDay: str(e.capWeiPerUsdDay) } : null);
    return {
      enabled: true,
      endSec: cfg.endSec,
      pocket: { totalWei: String(cfg.pocketWei), creditedWei: String(credited), remainingWei: String(cfg.pocketWei > credited ? cfg.pocketWei - credited : 0n) },
      terms: termsOut(terms), next: termsOut(next), minUsdWei: String(minUsdWei), minSamples,
      pools: pools.map(({ pool, weightBps }) => {
        const p = lower(pool), latest = q('SELECT day, hour, pool_usd, supply FROM lp_samples WHERE pool = ? ORDER BY day DESC, hour DESC LIMIT 1').get(p);
        const opener = q('SELECT address FROM lp_openers WHERE pool = ?').get(p)?.address ?? null;
        const mineNow = me && latest ? q('SELECT value_usd FROM lp_balances WHERE day = ? AND hour = ? AND pool = ? AND address = ?').get(latest.day, latest.hour, p, me)?.value_usd : null;
        return {
          pool: p, weightBps: String(weightBps), valueUsdWei: latest ? latest.pool_usd : null, sampledAt: latest ? latest.day * 86400 + latest.hour * HOUR : null,
          opened: !!opener, opener, openPaid: !!q('SELECT 1 FROM reward_adjustments WHERE id = ?').get(openId(p)),
          ...(me ? { mineUsdWei: mineNow ?? '0' } : {}),
        };
      }),
      today: { day, samples: q('SELECT COUNT(DISTINCT hour) AS n FROM lp_samples WHERE day = ?').get(day).n, hour: hourNow },
      ...(me ? { mine: { address: me, creditedWei: String(sumFor(me)), opened: pools.filter(({ pool }) => q('SELECT 1 FROM lp_openers WHERE pool = ? AND address = ?').get(lower(pool), me)).map(({ pool }) => lower(pool)) } } : {}),
    };
  }
  // What this address has been credited by the campaign, in all.
  function sumFor(address) {
    return store.db.prepare(`SELECT wei FROM reward_adjustments WHERE id LIKE ? ESCAPE '\\' AND address = ?`).all(`${CREDIT_PREFIX.replace(/[\\%_]/g, (c) => '\\' + c)}%`, address).reduce((s, r) => s + BigInt(r.wei), 0n);
  }

  return { enabled, cycle, scan, sample, settle, view };
}
