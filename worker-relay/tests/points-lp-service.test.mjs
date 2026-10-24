// The liquidity campaign as the service runs it (src/lib/points-lp-service.js): the pools' share transfers, the hourly readings of value per
// share, what a day pays and to whom, the opening bonus, and every reason a credit waits. A fake chain stands in for the pools (one block a
// second, so a block's number is its time); the store is a real one. Several of these are the attacks an independent review reproduced
// against the first version, which paid on hourly samples of each holder's balance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { createLp } from '../src/lib/points-lp-service.js';
import { WAD, parseLpSchedule, parseLpPools, parseLpFarms, openId, dayId, farmPrefix, allocateLpDay, medianOf } from '../src/lib/points-lp.js';
import { hashRecord, checkDayRecord, verifyServiceDay } from '../src/lib/points-lp-record.js';

const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dEaD';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222', C = '0x3333333333333333333333333333333333333333';
const J = '0x4444444444444444444444444444444444444444', BANK = '0x5555555555555555555555555555555555555555';
const P1 = '0xaaaa000000000000000000000000000000000001', P2 = '0xbbbb000000000000000000000000000000000002', SYN = '0xcccc000000000000000000000000000000000003';
const tac = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const D0 = 20800, DAY = 86400, HOUR = 3600, EPOCH = 1_790_000_000, T = (day, hour = 0, min = 0) => day * DAY + hour * HOUR + min * 60;

// A chain with two pools: P1 is TACD against USDC (the quote is token0, six decimals), P2 is TACE against ETH (ETH is token0). A block is a second.
// A share token that, like the pools', lets anyone send shares to the zero address: that credits the zero address and leaves the supply alone, while
// a burn lowers the supply and credits nobody; both emit the same Transfer to zero.
function world(clock) {
  const noData = () => Object.assign(new Error('returned no data'), { name: 'ContractFunctionExecutionError', cause: { name: 'ContractFunctionZeroDataError' } });
  const w = {
    patches: [], feedPatches: [], hidden: new Set(), events: [], feed: 2500n * 10n ** 8n, feedAge: 0, failLogs: 0, logCalls: 0, deployedAt: {}, failSupply: false, dupLogs: false, reverseLogs: false, maxRange: Infinity,
    pools: {
      [P1]: { token0: USDC, token1: SYN, r0: 1000n * 10n ** 6n, r1: 1000n * WAD, sqrt: 10n ** 24n },
      [P2]: { token0: ZERO, token1: SYN, r0: 2n * WAD, r1: 2n * WAD, sqrt: WAD },
    },
    add(pool, from, to, value, ts, kind) { w.events.push({ pool, block: ts - EPOCH, idx: w.events.length, ts, from, to, value, kind }); },
    // A pool's reserves or price (a patch of p.r0, p.r1, p.sqrt), or the feed's answer, changes at a time: a read at an earlier block does not see it.
    setPool(pool, patch, ts) { w.patches.push({ pool, block: ts - EPOCH, patch }); },
    setFeed(answer, ts) { w.feedPatches.push({ block: ts - EPOCH, answer }); },
    mint(pool, to, value, ts) { w.add(pool, ZERO, to, value, ts, 'mint'); },
    move(pool, from, to, value, ts) { w.add(pool, from, to, value, ts, 'move'); },       // a transfer to the zero address is one of these
    burn(pool, from, value, ts) { w.add(pool, from, ZERO, value, ts, 'burn'); },
    live: (pool) => clock.t >= (w.deployedAt[pool] ?? 0),
    supplyAt(pool, block) { return w.events.filter((e) => e.pool === pool && e.block <= block && e.ts <= clock.t).reduce((s, e) => s + (e.kind === 'mint' ? e.value : e.kind === 'burn' ? -e.value : 0n), 0n); },
    zeroAt(pool, block) { return w.events.filter((e) => e.pool === pool && e.block <= block && e.ts <= clock.t && e.kind === 'move' && e.to === ZERO).reduce((s, e) => s + e.value, 0n); },
  };
  w.client = {
    getBlockNumber: async () => BigInt(clock.t - EPOCH),
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(Number(blockNumber) + EPOCH), hash: '0x' + Number(blockNumber).toString(16).padStart(64, '0') }),
    getCode: async ({ address }) => (w.live(address.toLowerCase()) ? '0x6001' : '0x'),
    getLogs: async ({ address, fromBlock, toBlock }) => {
      w.logCalls++;
      if (w.failLogs > 0) { w.failLogs--; throw new Error('429 too many requests'); }
      if (Number(toBlock - fromBlock + 1n) > w.maxRange) throw new Error('block range is too large');
      let out = w.events.filter((e) => !w.hidden.has(e) && e.pool === address.toLowerCase() && e.ts <= clock.t && BigInt(e.block) >= fromBlock && BigInt(e.block) <= toBlock)
        .map((e) => ({ address: e.pool, blockNumber: BigInt(e.block), logIndex: e.idx, args: { from: e.from, to: e.to, value: e.value } }));
      if (w.dupLogs) out = [...out, ...out];
      if (w.reverseLogs) out = out.reverse();
      return out;
    },
    readContract: async ({ address, functionName, args, blockNumber }) => {
      const a = address.toLowerCase();
      const at = blockNumber == null ? clock.t - EPOCH : Number(blockNumber);
      if (a === FEED.toLowerCase()) {
        const fp = w.feedPatches.filter((x) => x.block <= at), round = BigInt(1 + fp.length);
        return [round, fp.length ? fp[fp.length - 1].answer : w.feed, 0n, BigInt(at + EPOCH - w.feedAge), round];
      }
      const p0 = w.pools[a];
      if (!p0) throw new Error('no such contract');
      const p = Object.assign({}, p0, ...w.patches.filter((x) => x.pool === a && x.block <= at).map((x) => x.patch));
      if (!w.live(a)) throw noData();
      if (functionName === 'token0') return p.token0;
      if (functionName === 'token1') return p.token1;
      if (functionName === 'reserve0') return p.r0;
      if (functionName === 'reserve1') return p.r1;
      if (functionName === 'sqrtPriceCurrent') return p.sqrt;
      // A pruned node keeps the recent blocks (where a reading is pinned) and has dropped the older state a replay is checked at.
      if (functionName === 'totalSupply') { if (w.failSupply && blockNumber != null && at < clock.t - EPOCH - 10) throw new Error('missing trie node'); return w.supplyAt(a, at); }
      if (functionName === 'balanceOf') { if (args[0] !== ZERO) throw new Error('only the zero address is asked'); return w.zeroAt(a, at); }
      throw new Error(`unexpected ${functionName}`);
    },
  };
  return w;
}

// The service on a fresh store, with a clock the test moves. The scan begins two hours before day D0.
function service(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lp-'));
  const store = over.store ?? openStore(join(dir, 'points.db'));
  const clock = { t: T(D0) - 2 * HOUR };
  const w = world(clock), said = [];
  const cfg = {
    schedule: parseLpSchedule(`${D0}:daily=50,create=150,cap=0.02;${D0 + 5}:off`), pools: parseLpPools(`${P1},${P2}=0.5`), pocketWei: tac(1000), endSec: (D0 + 40) * DAY,
    reserveDays: 2, minUsdWei: 20n * WAD, minSamples: 12, exclude: [], fromBlock: T(D0) - 2 * HOUR - EPOCH, usdc: USDC, ethUsdFeed: FEED, confirmations: 12, chunk: 2000, ...over.cfg,
  };
  const make = () => createLp({
    store, client: w.client, cfg, budgetFor: over.budgetFor ?? (() => 1111n * WAD), graceSecs: 1800, nowSec: () => clock.t, log: (...m) => said.push(m.join(' ')),
    fundingInputs: over.fundingInputs ?? (async () => ({ heldWei: 100_000n * WAD, claimedWei: 0n, nextDay: D0 })),
  });
  return { lp: make(), rebuild: make, w, store, clock, said, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
// One cycle for each hour from `from` seconds to `to`.
async function hours(s, from, to) { for (let t = from; t < to; t += HOUR) { s.clock.t = t; await s.lp.cycle(); } }
// The day done: a cycle once its grace has passed.
const close = async (s, day) => { s.clock.t = T(day + 1) + 1900; await s.lp.cycle(); };
const credited = (store, id) => store.db.prepare('SELECT wei FROM reward_adjustments WHERE id = ?').get(id)?.wei;
const total = (store) => store.creditedWithPrefix('lp:');

test('a day is paid to whoever held liquidity for all of it, and the opener is paid once it has held enough', async () => {
  const s = service();
  try {
    // The pool's first shares: a thousand to the dead address, then 600 to A (the opener). B is minted shares at hour 10 of the day.
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    s.w.mint(P1, B, 400n * WAD, T(D0, 10, 30));
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1));
    assert.equal(s.store.db.prepare('SELECT COUNT(DISTINCT hour) AS n FROM lp_samples WHERE day = ? AND pool = ?').get(D0, P1).n, 24, 'a reading of value per share every hour');
    s.clock.t = T(D0 + 1) + 1000; await s.lp.cycle();
    assert.equal(credited(s.store, dayId(D0, A)), undefined, 'not before the grace has passed');
    await close(s, D0);
    // A held 600 shares all day. Median value per share: $2,000 over 600 shares for 10 hours, over 1,000 for 14; the median is the lower, $2: A is $1,200,
    // the cap is 0.02 TAC for each dollar, so 24 TAC (its share of the pot would be 30).
    const a = BigInt(credited(s.store, dayId(D0, A)));
    assert.ok(a > tac(23.9) && a <= tac(24), `A is capped at 0.02 TAC for each dollar held: ${a}`);
    assert.equal(credited(s.store, dayId(D0, B)), undefined, 'B arrived at hour 10, so its lowest balance of the day is nothing');
    assert.equal(credited(s.store, openId(P1)), '150000000000000000000', 'A opened the pool and held $20 or more all day: the opening bonus');
    assert.equal(credited(s.store, dayId(D0, DEAD)), undefined, 'the dead address is not paid');
    // Looking again pays nothing twice.
    const before = total(s.store);
    for (let i = 0; i < 3; i++) { s.clock.t += 60; await s.lp.cycle(); }
    assert.equal(total(s.store), before, 'a paid day is never paid again');
    // The next day both held all of it.
    await hours(s, T(D0 + 1) + 2 * HOUR, T(D0 + 2)); await close(s, D0 + 1);
    const [a1, b1] = [BigInt(credited(s.store, dayId(D0 + 1, A))), BigInt(credited(s.store, dayId(D0 + 1, B)))];
    assert.ok(a1 > 0n && b1 > 0n && a1 + b1 <= tac(50), 'on the next day both are paid, and never more than the day');
    assert.equal(credited(s.store, openId(P1)), '150000000000000000000', 'the opening bonus stays a single credit');
  } finally { s.cleanup(); }
});

test('liquidity that comes for a moment and goes earns nothing, however the moments are timed', async () => {
  // The review's attack: add a minute before the hour and remove it a minute after, every hour, with four times what the honest holder has.
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 500n * WAD, T(D0) - 5300); s.w.mint(P1, BANK, 2000n * WAD, T(D0) - 5200);
    for (let h = 0; h < 24; h++) { s.w.move(P1, BANK, J, 2000n * WAD, T(D0, h) - 30); s.w.move(P1, J, BANK, 2000n * WAD, T(D0, h) + 90); }
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(credited(s.store, dayId(D0, J)), undefined, 'two minutes an hour is no part of the day');
    assert.ok(BigInt(credited(s.store, dayId(D0, A))) > 0n, 'the honest holder is paid');
    // The bank gave the shares away for two minutes each hour, so it is counted for what it kept: nothing counted twice.
    const sum = BigInt(credited(s.store, dayId(D0, A))) + BigInt(credited(s.store, dayId(D0, BANK)) ?? 0);
    assert.ok(sum <= tac(50), 'and the day is never overpaid');
  } finally { s.cleanup(); }
});

test('the same shares are never counted for two holders', async () => {
  // The review's other attack: move the shares from one account to another between two reads so both show them.
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300); s.w.mint(P1, J, 400n * WAD, T(D0) - 5200);
    s.w.move(P1, J, B, 400n * WAD, T(D0, 5, 30)); s.w.move(P1, B, J, 400n * WAD, T(D0, 6, 10));
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(credited(s.store, dayId(D0, J)), undefined, 'J did not hold its shares while they were at B');
    assert.equal(credited(s.store, dayId(D0, B)), undefined, 'and B did not hold them before or after');
    assert.ok(BigInt(credited(s.store, dayId(D0, A))) > 0n);
    // Counted: only A's 600 of ~1,000 shares of a $2,000 pool.
    assert.ok(total(s.store) - BigInt(credited(s.store, openId(P1)) ?? 0) <= tac(24), 'what is counted is what really stayed');
  } finally { s.cleanup(); }
});

test('a pool opened before the scan began is not counted, and nobody is made its opener', async () => {
  // The scan begins after A opened the pool (the dead address's thousand shares and A's 600 came before it). B adds liquidity later and holds it all
  // day, and the first version made B the opener, never saw A, and paid B. The transfers it saw do not add up to the pool, so nothing is paid.
  const s = service({ cfg: { pools: parseLpPools(P1), fromBlock: T(D0) - 3600 - EPOCH } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    s.w.mint(P1, B, 400n * WAD, T(D0) - 1800);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(total(s.store), 0n, 'B held shares all day, but the pool is not counted: its transfers do not add up');
    assert.ok(s.said.some((m) => /do not add up to the pool's supply/.test(m)), s.said.join('\n'));
    assert.equal(credited(s.store, openId(P1)), undefined, 'and no bonus');
    assert.equal(s.store.db.prepare('SELECT address FROM lp_openers WHERE pool = ?').get(P1)?.address, B.toLowerCase(), 'B is only what the transfers it saw make it, and is paid nothing for it');
  } finally { s.cleanup(); }
});

test('a scan that is behind holds the day, and the holders it had not seen are paid when it catches up', async () => {
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 500n * WAD, T(D0) - 5300); s.w.mint(P1, B, 500n * WAD, T(D0) - 5200);
    await hours(s, T(D0) - 2 * HOUR, T(D0, 3));                 // the first hours are read
    s.w.failLogs = 1_000_000;                                  // then the node refuses every read for the rest of the day
    await hours(s, T(D0, 3), T(D0 + 1));
    s.clock.t = T(D0 + 1) + 1900; await s.lp.cycle();
    assert.equal(total(s.store), 0n, 'the day waits while the pool has not been read through its end');
    assert.equal(s.store.db.prepare('SELECT 1 FROM lp_days WHERE day = ?').get(D0), undefined, 'and is not closed');
    assert.ok(s.said.some((m) => /not read through its end/.test(m)));
    s.w.failLogs = 0; s.clock.t += 60; await s.lp.cycle();
    const [a, b] = [credited(s.store, dayId(D0, A)), credited(s.store, dayId(D0, B))];
    assert.ok(a && b && a === b, `both are paid the same once the scan is through: ${a} ${b}`);
  } finally { s.cleanup(); }
});

test('a transfer of nothing is ignored, so it can neither add a holder nor cost a read', async () => {
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 500n * WAD, T(D0) - 5300);
    for (let i = 0; i < 50; i++) s.w.move(P1, A, `0x${(i + 1).toString(16).padStart(40, '0')}`, 0n, T(D0, 1, i));
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1));
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM lp_events').get().n, 2, 'only the two real mints are kept');
    await close(s, D0);
    assert.ok(BigInt(credited(s.store, dayId(D0, A))) > 0n);
  } finally { s.cleanup(); }
});

test('a day with too few readings of the price is not counted, and a first day that began mid-way is exact', async () => {
  let s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    await hours(s, T(D0, 20), T(D0 + 1)); await close(s, D0);
    assert.equal(total(s.store), 0n, 'four readings do not say what a share was worth');
    assert.ok(s.said.some((m) => /fewer than 12 readings/.test(m)));
    assert.ok(s.store.db.prepare('SELECT 1 FROM lp_days WHERE day = ?').get(D0), 'and the day is closed, not retried for ever');
  } finally { s.cleanup(); }
  // Switched on at 11:00 with 13 readings: holders are known from the transfers for the whole day, so whoever left in the first hours is not paid.
  s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300); s.w.mint(P1, J, 400n * WAD, T(D0) - 5200);
    s.w.burn(P1, J, 400n * WAD, T(D0, 5));                      // J leaves at 05:00, before the service had been switched on
    await hours(s, T(D0, 11), T(D0 + 1)); await close(s, D0);
    assert.equal(credited(s.store, dayId(D0, J)), undefined, 'J left at 05:00, which the replay knows though no reading was taken then');
    assert.ok(BigInt(credited(s.store, dayId(D0, A))) > 0n, 'A held the whole day');
  } finally { s.cleanup(); }
});

test('the pocket, the end and an excluded address; an opening bonus that cannot go does not hold the day', async () => {
  const seed = (s) => { s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 1000n * WAD, T(D0) - 5300); };
  // The pocket holds 60 TAC: the day's 40 go, the 150 bonus waits (and the day is closed).
  let s = service({ cfg: { pools: parseLpPools(P1), pocketWei: tac(60) } });
  try {
    seed(s);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    const day = BigInt(credited(s.store, dayId(D0, A)));
    assert.ok(day > tac(39) && day <= tac(40), `the day was paid: ${day}`);
    assert.equal(credited(s.store, openId(P1)), undefined, 'the bonus would overdraw the pocket, so it waits');
    assert.ok(s.store.db.prepare('SELECT 1 FROM lp_days WHERE day = ?').get(D0), 'but the day is paid and closed');
    assert.ok(s.said.some((m) => /lp credits wait: pocket/.test(m)));
    assert.ok(total(s.store) <= tac(60));
  } finally { s.cleanup(); }
  // A day that would not fit the pocket whole waits whole.
  s = service({ cfg: { pools: parseLpPools(P1), pocketWei: tac(30) } });
  try {
    seed(s); await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(total(s.store), 0n); assert.equal(s.store.db.prepare('SELECT 1 FROM lp_days WHERE day = ?').get(D0), undefined, 'and is not closed');
  } finally { s.cleanup(); }
  // An excluded address earns nothing and is no opener.
  s = service({ cfg: { pools: parseLpPools(P1), exclude: [A] } });
  try {
    seed(s); await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(total(s.store), 0n, 'the only holder is excluded: nothing is paid, and no bonus');
  } finally { s.cleanup(); }
  // After the end nothing is paid.
  s = service({ cfg: { pools: parseLpPools(P1), endSec: T(D0) + 100 } });
  try {
    seed(s); await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(total(s.store), 0n); assert.ok(s.said.some((m) => /lp credits wait: ended/.test(m)));
  } finally { s.cleanup(); }
});

test('the dead address and the pool itself are never paid, even in a pool too small for the dollar floor to hide them', async () => {
  const s = service({ cfg: { pools: parseLpPools(P2) } });
  try {
    s.w.mint(P2, DEAD, 2000n, T(D0) - 5400); s.w.mint(P2, DEAD, 10n ** 17n, T(D0) - 5350); s.w.mint(P2, P2, 10n ** 17n, T(D0) - 5300); s.w.mint(P2, C, 1n * WAD, T(D0) - 5200);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(credited(s.store, dayId(D0, DEAD)), undefined); assert.equal(credited(s.store, dayId(D0, P2)), undefined);
    assert.ok(BigInt(credited(s.store, dayId(D0, C))) > 0n);
  } finally { s.cleanup(); }
});

test('an opener whose own liquidity is under the minimum is not paid the bonus, until it has held enough for a whole day', async () => {
  const s = service({ cfg: { pools: parseLpPools(P2) } });
  try {
    // C is minted the first shares, but they are worth about $10 of a $10,000 pool; B puts in the rest.
    s.w.mint(P2, DEAD, 1000n, T(D0) - 5400); s.w.mint(P2, C, 10n ** 15n, T(D0) - 5300); s.w.mint(P2, B, 10n ** 18n, T(D0) - 5200);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(credited(s.store, openId(P2)), undefined, 'the opener held under $20, so there is no opening bonus');
    assert.ok(BigInt(credited(s.store, dayId(D0, B))) > 0n, 'the day is still paid to the one holding most of the pool');
    // More shares from the same address from the start of the day after next (the day between has its own).
    s.w.mint(P2, C, 10n ** 18n, T(D0 + 2) - 600);
    await hours(s, T(D0 + 1), T(D0 + 3));
    await close(s, D0 + 1);
    assert.equal(credited(s.store, openId(P2)), undefined, 'not while its lowest balance of the day was still small');
    await close(s, D0 + 2);
    assert.equal(credited(s.store, openId(P2)), '150000000000000000000', 'once it has held $20 or more for a whole day the opener is paid, as a single credit');
  } finally { s.cleanup(); }
});

test('funding that would stop covering the regular pot holds the credits and they are paid when it recovers; near the end of the regular program the reserve is what is left', async () => {
  const seed = (s) => { s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 1000n * WAD, T(D0) - 5300); };
  let held = 1_500n * WAD;                                     // a day of the regular pot (1,111) and a little: fewer than two days covered
  let s = service({ cfg: { pools: parseLpPools(P1) }, fundingInputs: async () => ({ heldWei: held, claimedWei: 0n, nextDay: D0 }) });
  try {
    seed(s); await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(total(s.store), 0n, 'the regular pot comes first');
    assert.ok(s.said.some((m) => /lp credits wait: funding/.test(m)));
    held = 100_000n * WAD;
    s.clock.t += 60; await s.lp.cycle();
    assert.ok(total(s.store) > 0n, 'once the distributor is funded the day is paid, nothing lost');
  } finally { s.cleanup(); }
  // The regular program ends with day D0: the reserve is what is left of it, and after it none.
  const ends = (last) => (day) => (day <= last ? 1111n * WAD : 0n);
  s = service({ cfg: { pools: parseLpPools(P1) }, budgetFor: ends(D0), fundingInputs: async () => ({ heldWei: 1_200n * WAD, claimedWei: 0n, nextDay: D0 }) });
  try {
    seed(s); await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.ok(total(s.store) > 0n, 'with one day of the regular program left and a day and a bit funded, the reserve of one is met');
  } finally { s.cleanup(); }
  s = service({ cfg: { pools: parseLpPools(P1) }, budgetFor: ends(D0 - 1), fundingInputs: async () => ({ heldWei: 1_000n * WAD, claimedWei: 0n, nextDay: D0 }) });
  try {
    seed(s); await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.ok(total(s.store) > 0n, 'after the regular program there is nothing to reserve for, and the pocket is the only limit');
  } finally { s.cleanup(); }
});

test('an ETH pool is valued at the feed, a stale feed leaves the hour unsampled, a pool of anything else is left alone, and the view says what a page needs', async () => {
  const s = service({ cfg: { pools: parseLpPools(`${P2},0xdddd000000000000000000000000000000000004`) } });
  try {
    s.w.pools['0xdddd000000000000000000000000000000000004'] = { token0: '0x9999999999999999999999999999999999999999', token1: SYN, r0: 1n, r1: 1n, sqrt: 1n };
    s.w.mint(P2, DEAD, 1000n, T(D0) - 5400); s.w.mint(P2, C, 10n * WAD, T(D0) - 5300);
    await hours(s, T(D0) - 2 * HOUR, T(D0, 2));
    const row = s.store.db.prepare('SELECT pool_usd FROM lp_samples WHERE pool = ? ORDER BY day, hour LIMIT 1').get(P2);
    assert.equal(BigInt(row.pool_usd), 10_000n * WAD, '2 ETH at $2,500 and 2 TACE at the peg is $10,000');
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM lp_samples WHERE pool = ?').get('0xdddd000000000000000000000000000000000004').n, 0, 'a pool of neither ETH nor USDC is not valued');
    const v = s.lp.view({ address: C });
    assert.equal(v.enabled, true); assert.equal(v.pocket.totalWei, String(tac(1000))); assert.equal(v.terms.dailyWei, String(tac(50)));
    assert.equal(v.next.fromDay, D0 + 5, 'the next change is the end');
    const p2 = v.pools.find((p) => p.pool === P2);
    assert.equal(p2.opened, true); assert.equal(p2.opener, C.toLowerCase()); assert.equal(p2.openPaid, false); assert.equal(p2.weightBps, '10000');
    assert.ok(BigInt(p2.mineUsdWei) > 9_900n * WAD, `the account sees what its shares are worth now: ${p2.mineUsdWei}`);
    assert.deepEqual(v.mine.opened, [P2]); assert.equal(v.mine.creditedWei, '0');
    s.w.feedAge = 4 * HOUR; s.clock.t = T(D0, 3); await s.lp.cycle();
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM lp_samples WHERE day = ? AND hour = 3 AND pool = ?').get(D0, P2).n, 0, 'a price four hours old is not used');
    s.w.feedAge = 0; s.w.feed = 0n; s.clock.t = T(D0, 4); await s.lp.cycle();
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM lp_samples WHERE day = ? AND hour = 4 AND pool = ?').get(D0, P2).n, 0, 'and no price leaves it unsampled');
  } finally { s.cleanup(); }
});

test('one pushed reading does not move the day: the value per share is the median of the hourly ones', async () => {
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 1000n * WAD, T(D0) - 5300);
    for (let h = -2; h < 24; h++) {
      s.clock.t = T(D0, h);
      s.w.pools[P1].sqrt = h === 7 ? 10n ** 24n * 200n / 141n : 10n ** 24n;     // the synth's price pushed down to about half for the reading at 07:00
      await s.lp.cycle();
    }
    await close(s, D0);
    const a = BigInt(credited(s.store, dayId(D0, A)));
    assert.ok(a <= tac(0.02) * 2000n && a > tac(0.02) * 2000n - 1000n, `A is paid on the full $2,000 pool, the one low reading ignored: ${a}`);
  } finally { s.cleanup(); }
});

test('a listed pool that is not deployed yet freezes nothing: the others are paid, and it is paid once it opens', async () => {
  const s = service();
  try {
    s.w.deployedAt[P2] = T(D0 + 2);                                      // P2 has no code until day D0+2
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.ok(BigInt(credited(s.store, dayId(D0, A))) > 0n, 'P1 is paid though P2 does not exist yet');
    assert.ok(!s.said.some((m) => /not read through its end/.test(m)), 'and nothing says a scan is behind');
    assert.ok(!s.said.some((m) => /sample .* failed|could not be read/.test(m)), `and it is not read for a price while there is no pool: ${s.said.join(' | ')}`);
    assert.equal(s.store.db.prepare('SELECT 1 FROM lp_days WHERE day = ?').get(D0) != null, true, 'the day is closed');
    // P2 opens on day D0+2 and is paid from then on.
    s.w.mint(P2, DEAD, 1000n, T(D0 + 2) - 600); s.w.mint(P2, C, 10n * WAD, T(D0 + 2) - 500);
    await hours(s, T(D0 + 1), T(D0 + 4)); await close(s, D0 + 3);
    assert.ok(BigInt(credited(s.store, dayId(D0 + 3, C))) > 0n, 'once it is open its holder is paid for a whole day');
    assert.equal(credited(s.store, openId(P2)), '150000000000000000000', 'and its opener has the bonus');
  } finally { s.cleanup(); }
});

test('a transfer of shares to the zero address does not disable the pool, and a real burn is counted as one', async () => {
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300); s.w.mint(P1, B, 400n * WAD, T(D0) - 5200);
    s.w.move(P1, B, ZERO, 1n, T(D0, 2));                                   // one wei sent to the zero address: the supply is unchanged, the zero address holds it
    s.w.burn(P1, B, 100n * WAD, T(D0, 3));                                 // and B burns 100 shares for real
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.ok(!s.said.some((m) => /do not add up/.test(m)), `the pool is still counted: ${s.said.join(' | ')}`);
    const a = BigInt(credited(s.store, dayId(D0, A))), b = BigInt(credited(s.store, dayId(D0, B)));
    assert.ok(a > 0n && b > 0n, 'both are paid');
    assert.ok(b < a, 'B kept 300 shares to A\'s 600: the sent and the burned ones left it at the moments they left');
    assert.equal(credited(s.store, openId(P1)), '150000000000000000000');
  } finally { s.cleanup(); }
});

test('a node that gives a log twice or gives them out of order changes nothing', async () => {
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.dupLogs = true; s.w.reverseLogs = true;
    // The opening mints share a block: the dead address's thousand first, then A's shares, then B's, then A sends some on, all in the same second.
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5400); s.w.mint(P1, B, 50n * WAD, T(D0) - 5400); s.w.move(P1, A, B, 100n * WAD, T(D0) - 5400);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM lp_events').get().n, 4, 'each transfer is kept once');
    assert.ok(!s.said.some((m) => /do not add up/.test(m)), `the pool is still counted: ${s.said.join(' | ')}`);
    assert.equal(s.store.db.prepare('SELECT address FROM lp_openers WHERE pool = ?').get(P1).address, A.toLowerCase(), 'the opener is the first mint after the dead address, however the logs came');
    assert.ok(BigInt(credited(s.store, dayId(D0, A))) > 0n && BigInt(credited(s.store, dayId(D0, B))) > 0n, 'and the holders are right (A 500, B 150)');
  } finally { s.cleanup(); }
});

test('a node that refuses a long range is asked for less; one that cannot say the pool\'s supply holds the day', async () => {
  let s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.maxRange = 300;
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.ok(BigInt(credited(s.store, dayId(D0, A))) > 0n, 'the scan halved its stretch until the node answered, and the day is paid');
  } finally { s.cleanup(); }
  s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    s.w.failSupply = true;                                                   // a node that has dropped the state of that block
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.equal(total(s.store), 0n); assert.equal(s.store.db.prepare('SELECT 1 FROM lp_days WHERE day = ?').get(D0), undefined, 'the day is not closed');
    assert.ok(s.said.some((m) => /could not be read.*days wait/.test(m)));
    s.w.failSupply = false; s.clock.t += 60; await s.lp.cycle();
    assert.ok(BigInt(credited(s.store, dayId(D0, A))) > 0n, 'and is paid once the supply can be read');
  } finally { s.cleanup(); }
});

test('under a dollar of liquidity is not paid, the first reading of an hour is the one kept, and nothing is done long after the end', async () => {
  let s = service({ cfg: { pools: parseLpPools(P2) } });
  try {
    // $10,000 pool: 1e14 of 1e18 shares is a cent.
    s.w.mint(P2, DEAD, 1000n, T(D0) - 5400); s.w.mint(P2, C, 10n ** 18n, T(D0) - 5300); s.w.mint(P2, J, 10n ** 14n, T(D0) - 5200);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    assert.ok(BigInt(credited(s.store, dayId(D0, C))) > 0n); assert.equal(credited(s.store, dayId(D0, J)), undefined, 'a cent of liquidity earns no credit');
    // A second reading in the same hour is ignored.
    s.clock.t = T(D0 + 1, 5); await s.lp.cycle();
    const first = s.store.db.prepare('SELECT vps FROM lp_samples WHERE day = ? AND hour = 5 AND pool = ?').get(D0 + 1, P2).vps;
    s.w.pools[P2].r0 = 10n * WAD; s.clock.t += 600; await s.lp.cycle();
    assert.equal(s.store.db.prepare('SELECT vps FROM lp_samples WHERE day = ? AND hour = 5 AND pool = ?').get(D0 + 1, P2).vps, first, 'the reading stays the first of the hour');
    // Long after the end the service reads nothing.
    s.w.logCalls = 0; s.clock.t = (D0 + 40 + 4) * DAY; await s.lp.cycle();
    assert.equal(s.w.logCalls, 0, 'three days past the end it does no work');
  } finally { s.cleanup(); }
});

test('it is off unless it has a pocket, an end, a schedule and a pool', async () => {
  for (const over of [{ pocketWei: 0n }, { endSec: 0 }, { schedule: [] }, { pools: [] }]) {
    const s = service({ cfg: over });
    try {
      assert.equal(s.lp.enabled, false);
      await s.lp.cycle();
      assert.deepEqual(s.lp.view(), { enabled: false });
      assert.equal(s.store.db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'lp_%'`).get().n, 0, 'and it leaves the store alone');
      assert.equal(s.w.logCalls, 0, 'and reads nothing');
    } finally { s.cleanup(); }
  }
});

// ── pinned readings, the day's record, and the farms beside the first campaign ──

// The record of a day checked against the fake chain, with the ledger's credits.
const check = (s, kept, over = {}) => checkDayRecord({ record: kept.record, sha256: kept.sha256, client: s.w.client, usdc: USDC, ethUsdFeed: FEED, adjustments: s.store.listAdjustments(), ...over });

test('every reading is taken at a block, and a paid day keeps a hashed record that the chain bears out', async () => {
  const s = service();
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300); s.w.mint(P1, B, 400n * WAD, T(D0) - 5200);
    s.w.mint(P2, DEAD, 1000n, T(D0) - 5400); s.w.mint(P2, C, 700n * WAD, T(D0) - 5300);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1));
    const row = s.store.db.prepare('SELECT * FROM lp_samples WHERE day = ? AND hour = 7 AND pool = ?').get(D0, P2);
    assert.equal(row.block, T(D0, 7) - EPOCH - 3, 'the reading is pinned three blocks behind the head');
    assert.equal(row.block_ts, T(D0, 7) - 3);
    assert.equal(row.quote_usd, String(2500n * WAD), 'with the price it used for ETH');
    assert.equal(row.feed_round, '1', 'and the feed round it came from');
    assert.equal(row.r0, String(2n * WAD)); assert.equal(row.r1, String(2n * WAD));
    assert.equal(s.lp.dayRecord(D0), null, 'a day that is not paid has no record');
    await close(s, D0);
    const kept = s.lp.dayRecord(D0);
    assert.ok(kept, 'the paid day has a record');
    assert.equal(hashRecord(kept.record), kept.sha256, 'kept with its hash');
    assert.equal(kept.record.pools.length, 2); assert.equal(kept.record.pools[1].samples.length, 24);
    assert.deepEqual(kept.record.holders.map((h) => h.address).sort(), [A, B, C].sort());
    assert.equal(kept.record.credits.length, 3);
    const ok = await check(s, kept);
    assert.deepEqual(ok.problems, [], 'the chain gives every figure in the record');
    assert.ok(ok.ok); assert.deepEqual(ok.notes, []);
    assert.ok((await check(s, kept, { fromBlocks: { [P1]: 1, [P2]: 1 } })).ok, 'and so it does from a known first block');
    // Looking again changes nothing: the record is the one of the day it was paid.
    const before = JSON.stringify(s.lp.dayRecord(D0));
    for (let i = 0; i < 3; i++) { s.clock.t += 60; await s.lp.cycle(); }
    assert.equal(JSON.stringify(s.lp.dayRecord(D0)), before);
  } finally { s.cleanup(); }
});

test('a record that was changed, or a credit the rule does not give, is found', async () => {
  const s = service();
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300); s.w.mint(P1, B, 400n * WAD, T(D0) - 5200);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    const kept = s.lp.dayRecord(D0), clone = () => JSON.parse(JSON.stringify(kept.record));
    const fails = async (record, what, sha256 = null) => { const r = await check(s, { record, sha256 }); assert.ok(!r.ok && r.problems.length > 0, what); return r.problems.join(' | '); };
    const credit = clone(); credit.credits[0].wei = String(BigInt(credit.credits[0].wei) + 1n);
    assert.match(await fails(credit, 'a credit changed by a wei'), /credits are not what the rule gives|ledger/);
    assert.match(await fails(credit, 'and the hash shows it', kept.sha256), /does not match its hash/);
    const shares = clone(); shares.holders[0].minShares = String(BigInt(shares.holders[0].minShares) * 2n);
    assert.match(await fails(shares, 'a holder given more shares'), /lowest shares/);
    const left = clone(); left.holders = left.holders.filter((h) => h.address !== B); left.credits = left.credits.filter((c) => c.address !== B);
    assert.match(await fails(left, 'a holder left out'), new RegExp(`${B} held`));
    const reading = clone(); reading.pools[0].samples[5].r0 = String(BigInt(reading.pools[0].samples[5].r0) + 1n);
    assert.match(await fails(reading, 'a reading that is not what the pool held at its block'), /reserve0/);
    const moved = clone(); moved.pools[0].samples[5].block += 7200; moved.pools[0].samples[5].blockTs += 7200;
    assert.match(await fails(moved, 'a reading moved to a block of another hour'), /outside that hour/);
    const median = clone(); median.pools[0].vps = String(BigInt(median.pools[0].vps) * 2n);
    assert.match(await fails(median, 'a median that is not the readings\''), /median value per share/);
    // The ledger is held to it too: a credit the ledger has at another amount.
    const ledger = s.store.listAdjustments().map((a) => (a.id === kept.record.credits[0].id ? { ...a, wei: '1' } : a));
    const r = await check(s, kept, { adjustments: ledger });
    assert.ok(!r.ok && /ledger has 1/.test(r.problems.join()), 'the ledger and the record must agree');
    assert.ok((await check(s, kept)).ok, 'the untouched record still checks');
  } finally { s.cleanup(); }
});

test('readings from before pinning still count, and the record says they cannot be checked', async () => {
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1));
    s.store.db.prepare('UPDATE lp_samples SET block = NULL, block_ts = NULL, quote_usd = NULL, feed_round = NULL, r0 = NULL, r1 = NULL, sqrt = NULL WHERE day = ? AND hour < 4').run(D0);
    await close(s, D0);
    const kept = s.lp.dayRecord(D0);
    assert.equal(kept.record.pools[0].samples.filter((x) => x.unpinned).length, 4);
    assert.ok(BigInt(credited(s.store, dayId(D0, A))) > 0n, 'the day is paid on all 24 readings');
    const strict = await check(s, kept);
    assert.ok(!strict.ok && /made before readings were pinned/.test(strict.problems.join()), 'by default a reading that cannot be checked is a problem');
    const r = await check(s, kept, { allowUnpinned: true });
    assert.deepEqual(r.problems, []); assert.match(r.notes.join(), /4 reading\(s\) predate pinning/);
  } finally { s.cleanup(); }
});

test('a day that pays nobody still keeps its record, and an address sees its streak', async () => {
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400);                       // the dead address holds shares all day; A comes at its end
    s.w.mint(P1, A, 600n * WAD, T(D0 + 1) - 3000);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    const kept = s.lp.dayRecord(D0);
    assert.ok(kept && kept.record.credits.length === 0 && kept.record.holders.length === 0, 'an empty day has its record');
    assert.ok((await check(s, kept)).ok);
    await hours(s, T(D0 + 1), T(D0 + 3)); await close(s, D0 + 1); await close(s, D0 + 2);
    const mine = s.lp.view({ address: A }).mine;
    assert.deepEqual([mine.daysCredited, mine.lastDay, mine.streak], [2, D0 + 2, 2], 'A held for the whole of both days');
    assert.equal(s.lp.view({ address: C }).mine.streak, 0, 'an address that was never credited has none');
    assert.equal(s.lp.view({ address: C }).lastPaidDay, D0 + 2);
  } finally { s.cleanup(); }
});

// Two campaigns on one store and one chain: the first (P1) and a farm (P2), each with its own schedule and pocket.
function twin(farmCfg = {}, firstCfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lp-'));
  const store = openStore(join(dir, 'points.db'));
  const clock = { t: T(D0) - 2 * HOUR };
  const w = world(clock), said = [];
  const base = { minUsdWei: 20n * WAD, minSamples: 12, exclude: [], fromBlock: T(D0) - 2 * HOUR - EPOCH, usdc: USDC, ethUsdFeed: FEED, confirmations: 12, chunk: 2000, reserveDays: 2, endSec: (D0 + 40) * DAY };
  const deps = { store, client: w.client, budgetFor: () => 1111n * WAD, graceSecs: 1800, nowSec: () => clock.t, log: (...m) => said.push(m.join(' ')), fundingInputs: async () => ({ heldWei: 100_000n * WAD, claimedWei: 0n, nextDay: D0 }) };
  const first = createLp({ ...deps, cfg: { ...base, schedule: parseLpSchedule(`${D0}:daily=50,create=150,cap=0.02`), pools: parseLpPools(P1), pocketWei: tac(1000), ...firstCfg } });
  const farm = createLp({ ...deps, name: 'farm', cfg: { ...base, schedule: parseLpSchedule(`${D0}:daily=40,create=0,cap=0.05`), pools: parseLpPools(P2), pocketWei: tac(500), ...farmCfg } });
  const cycle = async () => { await first.cycle(); await farm.cycle(); };
  return { first, farm, store, clock, w, said, cycle, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const hoursOf = async (s, from, to) => { for (let t = from; t < to; t += HOUR) { s.clock.t = t; await s.cycle(); } };

test('a farm is a campaign of its own: its own tables, credits, pocket and day, and its liquidity does not thin the first campaign\'s', async () => {
  const alone = service({ cfg: { pools: parseLpPools(P1) } });
  const s = twin();
  try {
    for (const x of [alone.w, s.w]) {
      x.mint(P1, DEAD, 1000n, T(D0) - 5400); x.mint(P1, A, 600n * WAD, T(D0) - 5300);
    }
    s.w.mint(P2, DEAD, 1000n, T(D0) - 5400); s.w.mint(P2, C, 700n * WAD, T(D0) - 5300);      // a pool of the farm's, far deeper than the first one's
    await hours(alone, T(D0) - 2 * HOUR, T(D0 + 1)); await close(alone, D0);
    await hoursOf(s, T(D0) - 2 * HOUR, T(D0 + 1)); s.clock.t = T(D0 + 1) + 1900; await s.cycle();
    const a = credited(alone.store, dayId(D0, A)), tw = credited(s.store, dayId(D0, A));
    assert.ok(BigInt(a) > 0n && tw === a, 'the first campaign pays A the same whether or not a farm shares the store');
    assert.equal(credited(s.store, dayId(D0, C, farmPrefix('farm'))) > 0, true, 'the farm pays C under its own ids');
    assert.equal(credited(s.store, dayId(D0, C)), undefined, 'and not under the first campaign\'s');
    assert.equal(s.store.creditedWithPrefix('lp:'), alone.store.creditedWithPrefix('lp:'), 'the first pocket counts only its own credits (the day and the opening bonus), as it does alone');
    assert.equal(s.farm.credited(), BigInt(credited(s.store, dayId(D0, C, farmPrefix('farm')))));
    assert.ok(s.store.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'vf_farm_samples'`).get(), 'the farm has tables of its own');
    assert.equal(s.farm.view().name, 'farm'); assert.equal(s.first.view().name, undefined);
    assert.ok(s.farm.dayRecord(D0) && s.first.dayRecord(D0), 'each keeps its own record of the day');
    assert.equal(s.farm.dayRecord(D0).record.campaign, 'farm');
    const r = await checkDayRecord({ ...{ record: s.farm.dayRecord(D0).record, sha256: s.farm.dayRecord(D0).sha256 }, client: s.w.client, usdc: USDC, ethUsdFeed: FEED, adjustments: s.store.listAdjustments() });
    assert.deepEqual(r.problems, [], 'and the farm\'s record checks out too');
  } finally { s.cleanup(); alone.cleanup(); }
});

test('a farm\'s pocket is its own: when it is spent the farm waits and the first campaign goes on', async () => {
  const s = twin({ pocketWei: tac(10) });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    s.w.mint(P2, DEAD, 1000n, T(D0) - 5400); s.w.mint(P2, C, 700n * WAD, T(D0) - 5300);
    await hoursOf(s, T(D0) - 2 * HOUR, T(D0 + 1)); s.clock.t = T(D0 + 1) + 1900; await s.cycle();
    assert.ok(BigInt(credited(s.store, dayId(D0, A))) > 0n, 'the first campaign was paid');
    assert.equal(credited(s.store, dayId(D0, C, farmPrefix('farm'))), undefined, 'the farm\'s day is larger than its pocket, so it waits');
    assert.ok(s.said.some((m) => /lp credits wait: pocket/.test(m)));
    assert.equal(s.farm.dayRecord(D0), null, 'and a day that has not been paid keeps no record');
  } finally { s.cleanup(); }
});

test('a pool of a token with no peg is valued at its own price, and a pegged one at no more than the peg', async () => {
  const price5 = 447213595499957939n;                         // a sqrt price that makes one token worth five ETH
  const vpsOf = async (pools) => {
    const s = service({ cfg: { pools: parseLpPools(pools) } });
    try {
      s.w.pools[P2].sqrt = price5;
      s.w.mint(P2, DEAD, 1000n, T(D0) - 5400); s.w.mint(P2, C, 10n ** 18n, T(D0) - 5300);
      await hours(s, T(D0) - 2 * HOUR, T(D0) + 2 * HOUR);
      return { vps: BigInt(s.store.db.prepare('SELECT vps FROM lp_samples WHERE day = ? AND hour = 1 AND pool = ?').get(D0, P2).vps), view: s.lp.view().pools[0] };
    } finally { s.cleanup(); }
  };
  const pegged = await vpsOf(P2), spot = await vpsOf(`${P2}/spot`);
  // 2 ETH and 2 tokens at $2,500 an ETH: $10,000 with the token held to the peg of one ETH, $30,000 at five.
  assert.ok(spot.vps > pegged.vps * 29n / 10n && spot.vps < pegged.vps * 31n / 10n, `spot ${spot.vps} against pegged ${pegged.vps}`);
  assert.equal(spot.view.spot, true); assert.equal(pegged.view.spot, undefined);
});

test('a store from before readings were pinned is upgraded in place, and its old readings still count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-old-'));
  const store = openStore(join(dir, 'points.db'));
  // The tables as the first version made them.
  store.db.exec(`CREATE TABLE lp_samples (day INTEGER NOT NULL, hour INTEGER NOT NULL, pool TEXT NOT NULL, taken_at INTEGER NOT NULL, pool_usd TEXT NOT NULL, supply TEXT NOT NULL, vps TEXT NOT NULL, PRIMARY KEY (day, hour, pool));
    CREATE TABLE lp_days (day INTEGER PRIMARY KEY, paid_at INTEGER NOT NULL, wei TEXT NOT NULL);`);
  store.db.prepare('INSERT INTO lp_samples VALUES (?, ?, ?, ?, ?, ?, ?)').run(D0, 3, P1, T(D0, 3), '1000000000000000000', '5', '2000000000000000000');
  const s = service({ store, cfg: { pools: parseLpPools(P1) } });
  try {
    const cols = store.db.prepare('PRAGMA table_info(lp_samples)').all().map((c) => c.name);
    for (const c of ['block', 'block_ts', 'quote_usd', 'feed_round', 'r0', 'r1', 'sqrt']) assert.ok(cols.includes(c), `${c} was added`);
    assert.ok(store.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'lp_day_records'`).get(), 'and the records table');
    const old = store.db.prepare('SELECT * FROM lp_samples WHERE hour = 3').get();
    assert.equal(old.vps, '2000000000000000000'); assert.equal(old.block, null, 'the old reading is kept as it was');
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
    const kept = s.lp.dayRecord(D0);
    assert.equal(kept.record.pools[0].samples.filter((x) => x.unpinned).length, 1, 'the old reading is in the record, marked as one that cannot be checked');
    assert.equal(kept.record.pools[0].samples.length, 24);
    assert.deepEqual((await check(s, kept, { allowUnpinned: true })).problems, []);
  } finally { s.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

// ── what the review of the first version found ──

const rowOf = (s, hour, pool = P2, day = D0) => s.store.db.prepare('SELECT * FROM lp_samples WHERE day = ? AND hour = ? AND pool = ?').get(day, hour, pool);

test('a reading is the pool and the feed as they stood at its block, not as they stand when it is stored', async () => {
  const s = service({ cfg: { pools: parseLpPools(P2) } });
  try {
    s.w.mint(P2, DEAD, 1000n, T(D0) - 5400); s.w.mint(P2, C, 700n * WAD, T(D0) - 5300);
    // One second before hour 5's reading, which is pinned three blocks behind its time, the pool and the feed move.
    s.w.setPool(P2, { r0: 3n * WAD }, T(D0, 5) - 1); s.w.setFeed(3000n * 10n ** 8n, T(D0, 5) - 1);
    await hours(s, T(D0) - 2 * HOUR, T(D0, 8));
    const [h5, h6] = [rowOf(s, 5), rowOf(s, 6)];
    assert.deepEqual([h5.r0, h5.quote_usd, h5.feed_round], [String(2n * WAD), String(2500n * WAD), '1'], 'hour 5 is the state before the move');
    assert.deepEqual([h6.r0, h6.quote_usd, h6.feed_round], [String(3n * WAD), String(3000n * WAD), '2'], 'hour 6 is the state after it');
    assert.equal(h6.block_hash, '0x' + (T(D0, 6) - EPOCH - 3).toString(16).padStart(64, '0'), 'with the hash of its block');
  } finally { s.cleanup(); }
});

test('a node that is behind pins nothing: the hour is left unsampled, and the readings that follow are good', async () => {
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    const real = s.w.client.getBlockNumber; let calls = 0, lagging = true;
    // Each cycle asks for the head twice, once to scan and once to pin; the second answer is two hours old while the node is behind.
    s.w.client.getBlockNumber = async () => { const n = await real(); return ++calls % 2 === 0 && lagging ? n - 7200n : n; };
    await hours(s, T(D0) - 2 * HOUR, T(D0, 6));
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM lp_samples').get().n, 0, 'nothing was stored from a block two hours old');
    assert.ok(s.said.some((m) => /is 7203 s old, the hour is left unsampled/.test(m)));
    lagging = false;
    await hours(s, T(D0, 6), T(D0 + 1)); await close(s, D0);
    const kept = s.lp.dayRecord(D0);
    assert.equal(kept.record.pools[0].samples.length, 18, 'hours 6 to 23');
    assert.deepEqual((await check(s, kept)).problems, [], 'and the day it pays is one the chain bears out');
  } finally { s.cleanup(); }
});

test('after a restart the record still says what the pools are made of', async () => {
  const s = service({ cfg: { pools: parseLpPools(P1) } });
  try {
    s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300);
    await hours(s, T(D0) - 2 * HOUR, T(D0 + 1) + 1);                       // the first reading of the next day is taken
    const lp2 = s.rebuild();                                              // restarted: it has not yet read the pool's tokens
    s.clock.t = T(D0 + 1) + 1900; await lp2.cycle();
    const rec = lp2.dayRecord(D0).record.pools[0];
    assert.deepEqual([rec.quote, rec.synthIs1, rec.quoteDec], ['USDC', true, 6]);
  } finally { s.cleanup(); }
});

// A paid day to forge: A and B in P1 (USDC), C in P2 (ETH), the ETH price changing at noon so that the day's readings differ.
async function forgeable() {
  const s = service({ cfg: { schedule: parseLpSchedule(`${D0}:daily=500,create=0,cap=0.02`) } });
  s.w.mint(P1, DEAD, 1000n, T(D0) - 5400); s.w.mint(P1, A, 600n * WAD, T(D0) - 5300); s.w.mint(P1, B, 400n * WAD, T(D0) - 5200);
  s.w.mint(P2, DEAD, 1000n, T(D0) - 5400); s.w.mint(P2, C, 700n * WAD, T(D0) - 5300);
  s.w.setFeed(3000n * 10n ** 8n, T(D0, 12));
  await hours(s, T(D0) - 2 * HOUR, T(D0 + 1)); await close(s, D0);
  const kept = s.lp.dayRecord(D0), clone = () => JSON.parse(JSON.stringify(kept.record));
  return { s, kept, clone };
}
const rehash = async (s, record, over = {}) => check(s, { record, sha256: null }, { adjustments: null, ...over });

test('a forged record is refused: its replay point, its readings, its hours, its status and its ledger have to be real', async () => {
  const { s, kept, clone } = await forgeable();
  try {
    assert.deepEqual((await check(s, kept)).problems, [], 'the honest record checks out');
    const refused = async (record, re, what, over) => { const r = await rehash(s, record, over); assert.ok(!r.ok, `${what}: refused`); assert.match(r.problems.join(' | '), re, what); };

    // The replay point: it has to be at or after the end of the day, by the chain's own clock, or transfers can be hidden.
    const early = clone(), blk = T(D0, 22) - EPOCH;
    Object.assign(early.pools[0].cursor, { block: blk, ts: blk + EPOCH });
    await refused(early, /before the end of the day/, 'a replay point at 22:00');
    const lie = clone(); lie.pools[0].cursor.block = blk;                  // the block of 22:00 with the time of the real replay point
    await refused(lie, /replay point time/, 'a replay point whose time is not its block\'s');

    // Readings: all have to be of an hour of the day, once, and pinned; a missing minimum is not a waived one.
    const pinned = clone(); for (const x of pinned.pools[1].samples) { delete x.block; x.unpinned = true; }
    await refused(pinned, /made before readings were pinned/, 'every reading marked as one from before pinning');
    assert.ok((await rehash(s, pinned, { allowUnpinned: true })).problems.every((m) => !/pinned/.test(m)), 'unless the day is that of the upgrade');
    const next = clone(); next.pools[1].samples[3].hour = 24 + 3;
    await refused(next, /not an hour of the day/, 'a reading of hour 27');
    const text = clone(); text.pools[1].samples[23].hour = '23';
    await refused(text, /not an hour of the day/, 'an hour written as a string');
    const twice = clone(); twice.pools[1].samples[4].hour = twice.pools[1].samples[5].hour;
    await refused(twice, /two readings for hour/, 'one hour twice');
    const noMin = clone(); delete noMin.minSamples;
    await refused(noMin, /how many readings a day needs/, 'no minimum of readings');
    const hash = clone(); hash.pools[1].samples[9].blockHash = '0x' + '1'.repeat(64);
    await refused(hash, /hash/, 'a block that is not the chain\'s');
    const few = clone(); few.pools[1].samples = few.pools[1].samples.slice(0, 11);
    await refused(few, /fewer than the 12/, 'eleven readings');

    // A status taken on trust: too few readings, or a replay that disagrees.
    const fewS = clone(); fewS.pools[1].status = 'few'; fewS.holders = fewS.holders.filter((h) => h.pool !== P2); fewS.credits = fewS.credits.filter((c) => c.address !== C);
    await refused(fewS, /marked as having too few readings/, 'a pool marked few with its 24 readings');
    const skipS = clone(); skipS.pools[1].status = 'skip';
    await refused(skipS, /marked as not counted .* they agree/, 'a pool marked skip whose transfers agree');
    const odd = clone(); odd.pools[0].status = 'paid';
    await refused(odd, /not one the service gives/, 'an invented status');

    // The ledger, both ways, and a record emptied of everything.
    const empty = clone(); empty.pools = [];
    await refused(empty, /no pools/, 'a record with no pools', { adjustments: s.store.listAdjustments() });
    const stripped = clone(); stripped.holders = []; stripped.credits = [];
    await refused(stripped, /not in the record|ledger/, 'holders and credits taken out', { adjustments: s.store.listAdjustments() });
    const extra = [...s.store.listAdjustments(), { id: dayId(D0, '0x9999999999999999999999999999999999999999'), address: '0x9999999999999999999999999999999999999999', wei: '5', appliedAt: 1 }];
    const e = await check(s, kept, { adjustments: extra });
    assert.match(e.problems.join(), /0x9999999999999999999999999999999999999999 is in the ledger and not in the record/, 'a credit in the ledger that the record does not have');
    const more = clone(); more.holders.push({ pool: P1, address: J, minShares: '1000000000000000000', valueUsdWei: '2000000000000000000' });
    await refused(more, /is in the record and did not hold that much/, 'a holder that held nothing');
    const nq = clone(); delete nq.pools[0].quote; delete nq.pools[0].synthIs1;
    await refused(nq, /does not say which token is the quote/, 'a pool that does not say what its tokens are');
    const wq = clone(); wq.pools[0].quote = 'ETH';
    await refused(wq, /record's tokens are not the pool's/, 'a pool said to be against ETH that is against USDC');
    const mid = clone(); mid.pools[0].opener = J;
    await refused(mid, /opener/, 'another opener');
    const sup = clone(); sup.pools[0].cursor.supply = String(BigInt(sup.pools[0].cursor.supply) + 1n);
    await refused(sup, /supply at the replay point/, 'a supply that is not the replay\'s');
    const round = clone(); round.pools[1].samples[2].feedRound = '9';
    await refused(round, /feed round/, 'a feed round that is not the chain\'s');
    const tm = clone(); tm.pools[1].samples[2].blockTs += 1;
    await refused(tm, /time/, 'a block time that is not the chain\'s');
  } finally { s.cleanup(); }
});

test('what only the chain can say: a stale feed, a replay that disagrees, and readings picked to suit', async () => {
  const { s, kept, clone } = await forgeable();
  try {
    // The chain says the feed was stale at those blocks.
    s.w.feedAge = 4 * HOUR;
    const stale = await check(s, kept);
    assert.match(stale.problems.join(), /price feed was stale/); s.w.feedAge = 0;
    // The pool's transfers no longer add up to its supply at the replay point (a log the record has not seen).
    const missed = s.w.events.find((e) => e.pool === P1 && e.to === B);
    s.w.hidden.add(missed);
    assert.match((await check(s, kept)).problems.join().slice(0, 3000), /do not add up to its supply/);
    s.w.hidden.delete(missed);
    assert.ok((await check(s, kept)).ok, 'and it checks out again with the log back');

    // Readings picked to suit: the 12 highest of the P2 pool (the price rose at noon), with the median, the holders and the credits recomputed and consistent.
    const forged = clone(), pool = forged.pools[1];
    const top = [...pool.samples].sort((x, y) => (BigInt(x.vps) < BigInt(y.vps) ? 1 : -1)).slice(0, 12).map((x) => x.hour);
    pool.samples = pool.samples.filter((x) => top.includes(x.hour));
    pool.vps = String(medianOf(pool.samples.map((x) => BigInt(x.vps))));
    forged.holders = forged.holders.map((h) => (h.pool === P2 ? { ...h, valueUsdWei: String((BigInt(h.minShares) * BigInt(pool.vps)) / WAD) } : h));
    forged.credits = allocateLpDay({
      rows: forged.holders.map((h) => ({ address: h.address, pool: h.pool, valueUsdWei: BigInt(h.valueUsdWei), weightBps: BigInt(forged.pools.find((p) => p.pool === h.pool).weightBps) })),
      dailyWei: BigInt(forged.terms.dailyWei), capWeiPerUsdDay: BigInt(forged.terms.capWeiPerUsdDay),
    }).map((c) => ({ id: dayId(D0, c.address), address: c.address, wei: String(c.wei) }));
    assert.deepEqual((await rehash(s, forged)).problems, [], 'a consistent subset of real readings passes the check of the record alone (its documented limit)');
    const audit = await rehash(s, forged, { reference: true });
    assert.ok(!audit.ok && /from the median of the pool at the first block of each hour/.test(audit.problems.join()), 'but not the reference audit');
    const honest = await check(s, kept, { reference: true });
    assert.deepEqual(honest.problems, [], 'which the honest record passes'); assert.match(honest.notes.join(), /within [\d.]+% of the record/);
  } finally { s.cleanup(); }
});

test('a farm\'s money is its own all the way through: pocket, bonus, funding, view and streak', async () => {
  // The farm\'s pocket (100) is smaller than what the first campaign has credited (a day and a 150 bonus), so a farm that counted the first\'s credits would stop at once.
  const s = twin({ schedule: parseLpSchedule(`${D0}:daily=40,create=30,cap=0.05`), pocketWei: tac(100) });
  try {
    for (const p of [P1, P2]) s.w.mint(p, DEAD, 1000n, T(D0) - 5400);
    s.w.mint(P1, A, 600n * WAD, T(D0) - 5300); s.w.mint(P2, C, 700n * WAD, T(D0) - 5300);
    await hoursOf(s, T(D0) - 2 * HOUR, T(D0 + 2)); s.clock.t = T(D0 + 1) + 1900; await s.cycle();
    const bonus = openId(P2, farmPrefix('farm'));
    assert.equal(credited(s.store, bonus), String(tac(30)), 'the farm paid its opener under its own id');
    assert.equal(credited(s.store, dayId(D0, C, farmPrefix('farm'))), String(tac(40)), 'and the day');
    assert.equal(s.farm.credited(), tac(70)); assert.ok(s.first.credited() > tac(100), 'the first campaign has credited more than the farm\'s whole pocket');
    const fv = s.farm.view({ address: C });
    assert.deepEqual([fv.pocket.creditedWei, fv.pocket.remainingWei], [String(tac(70)), String(tac(30))]);
    assert.equal(fv.pools[0].openPaid, true); assert.equal(fv.lastPaidDay, D0);
    assert.deepEqual([fv.mine.creditedWei, fv.mine.daysCredited, fv.mine.streak, fv.mine.lastDay, fv.mine.opened], [String(tac(70)), 1, 1, D0, [P2]]);
    assert.equal(s.first.view({ address: C }).mine.creditedWei, '0', 'the first campaign has paid C nothing');
    assert.equal(s.first.view({ address: A }).mine.creditedWei, String(s.first.credited()), 'and A everything it has paid');
    assert.equal(s.first.view().pools[0].openPaid, true);
    // The next day is larger than what is left of the farm\'s pocket: the farm waits, the first campaign goes on.
    await hoursOf(s, T(D0 + 1), T(D0 + 2)); s.clock.t = T(D0 + 2) + 1900; await s.cycle();
    assert.equal(credited(s.store, dayId(D0 + 1, C, farmPrefix('farm'))), undefined, 'the farm\'s second day does not fit its pocket');
    assert.ok(s.said.some((m) => /lp credits wait: pocket \(day 20801/.test(m)));
    assert.ok(BigInt(credited(s.store, dayId(D0 + 1, A))) > 0n, 'the first campaign\'s second day is paid');
    assert.equal(s.farm.credited(), tac(70));
    assert.equal(s.said.filter((m) => /opening bonus vf:farm:open/.test(m)).length, 1, 'the farm\'s bonus was paid once, not offered again each day');
    // The funding check is the farm\'s own: with the distributor covering fewer than its two days the farm waits, whatever the first has credited.
  } finally { s.cleanup(); }
});

test('a pool is paid for by one campaign only', () => {
  const said = [], pool = (n) => '0x' + String(n).repeat(40);
  const good = (name, pools) => ({ name, schedule: '20760:daily=40,create=0,cap=0.03', pools, pocketWei: String(tac(100)), endSec: 1797712559 });
  const farms = parseLpFarms(JSON.stringify([good('one', pool(1)), good('two', `${pool(2)},${pool(1)}`), good('three', pool(3)), good('four', pool(4))]), (m) => said.push(m), [pool(4)]);
  assert.deepEqual(farms.map((f) => f.name), ['one', 'three'], 'one pool in an earlier farm and one in the first campaign are both refused');
  assert.equal(said.filter((m) => /already paid for by another campaign/.test(m)).length, 2);
});

test('the tool runs from a checkout, finds the day among its flags, and cannot be fooled by a record for another day or farm', async () => {
  const r = spawnSync('node', ['tools/lp-verify.mjs'], { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /usage: node tools\/lp-verify\.mjs/); assert.doesNotMatch(r.stderr, /Cannot find package/);
  const q = spawnSync('node', ['tools/lp-verify.mjs', '--json', '--service', 'http://127.0.0.1:9', '20800'], { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(q.status, 2); assert.match(q.stderr, /cannot check day 20800/, 'a flag before the day does not hide it');

  const { s, kept } = await forgeable();
  try {
    const serve = (over = {}) => async (path) => {
      const [p, query] = path.split('?');
      if (p === `/lp/day/${D0}`) return { day: D0, ...kept, ...over.day };
      if (p === '/rewards') return { adjustments: s.store.listAdjustments() };
      if (p === '/lp') return query ? { enabled: false } : s.lp.view();
      throw new Error(`HTTP 404 ${path}`);
    };
    const args = { client: s.w.client, usdc: USDC, ethUsdFeed: FEED };
    const ok = await verifyServiceDay({ get: serve(), day: D0, ...args });
    assert.deepEqual(ok.problems, []); assert.ok(ok.ok); assert.equal(ok.sha256, kept.sha256);
    assert.match((await verifyServiceDay({ get: serve({ day: { day: D0 + 1 } }), day: D0, ...args })).problems.join(), /answered for day/, 'a record of another day');
    assert.match((await verifyServiceDay({ get: serve(), day: D0, farm: 'taceth', ...args })).problems.join(), /is of the first campaign, not farm "taceth"/, 'a record of another campaign');
    const terms = await verifyServiceDay({ get: async (p) => (p === '/lp' ? { ...s.lp.view(), terms: { ...s.lp.view().terms, dailyWei: '1' }, pools: [] } : serve()(p)), day: D0, ...args });
    assert.ok(terms.ok, 'terms that differ from today\'s are a note, not a failure');
    assert.match(terms.notes.join(), /terms in the record differ/); assert.match(terms.notes.join(), /not among the pools the service publishes now/);
  } finally { s.cleanup(); }
});

test('a farm\'s opening bonus is credited once, however many days follow', async () => {
  const s = twin({ schedule: parseLpSchedule(`${D0}:daily=40,create=30,cap=0.05`), pocketWei: tac(1000) });
  try {
    for (const p of [P1, P2]) s.w.mint(p, DEAD, 1000n, T(D0) - 5400);
    s.w.mint(P1, A, 600n * WAD, T(D0) - 5300); s.w.mint(P2, C, 700n * WAD, T(D0) - 5300);
    await hoursOf(s, T(D0) - 2 * HOUR, T(D0 + 3));
    for (const d of [D0, D0 + 1, D0 + 2]) { s.clock.t = T(d + 1) + 1900; await s.cycle(); }
    for (const d of [D0, D0 + 1, D0 + 2]) assert.equal(credited(s.store, dayId(d, C, farmPrefix('farm'))), String(tac(40)), `day ${d} was paid`);
    assert.equal(s.store.db.prepare(`SELECT COUNT(*) AS n FROM reward_adjustments WHERE id LIKE 'vf:farm:open:%'`).get().n, 1);
    assert.equal(s.said.filter((m) => /opening bonus vf:farm:open/.test(m)).length, 1, 'and it was not offered again on the days after');
    assert.equal(s.farm.credited(), tac(150), 'three days and one bonus');
  } finally { s.cleanup(); }
});
