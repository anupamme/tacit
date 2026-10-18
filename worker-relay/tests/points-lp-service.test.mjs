// The liquidity campaign as the service runs it (src/lib/points-lp-service.js): the pools' share transfers, the hourly readings of value per
// share, what a day pays and to whom, the opening bonus, and every reason a credit waits. A fake chain stands in for the pools (one block a
// second, so a block's number is its time); the store is a real one. Several of these are the attacks an independent review reproduced
// against the first version, which paid on hourly samples of each holder's balance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { createLp } from '../src/lib/points-lp-service.js';
import { WAD, parseLpSchedule, parseLpPools, openId, dayId } from '../src/lib/points-lp.js';

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
    events: [], feed: 2500n * 10n ** 8n, feedAge: 0, failLogs: 0, logCalls: 0, deployedAt: {}, failSupply: false, dupLogs: false, reverseLogs: false, maxRange: Infinity,
    pools: {
      [P1]: { token0: USDC, token1: SYN, r0: 1000n * 10n ** 6n, r1: 1000n * WAD, sqrt: 10n ** 24n },
      [P2]: { token0: ZERO, token1: SYN, r0: 2n * WAD, r1: 2n * WAD, sqrt: WAD },
    },
    add(pool, from, to, value, ts, kind) { w.events.push({ pool, block: ts - EPOCH, idx: w.events.length, ts, from, to, value, kind }); },
    mint(pool, to, value, ts) { w.add(pool, ZERO, to, value, ts, 'mint'); },
    move(pool, from, to, value, ts) { w.add(pool, from, to, value, ts, 'move'); },       // a transfer to the zero address is one of these
    burn(pool, from, value, ts) { w.add(pool, from, ZERO, value, ts, 'burn'); },
    live: (pool) => clock.t >= (w.deployedAt[pool] ?? 0),
    supplyAt(pool, block) { return w.events.filter((e) => e.pool === pool && e.block <= block && e.ts <= clock.t).reduce((s, e) => s + (e.kind === 'mint' ? e.value : e.kind === 'burn' ? -e.value : 0n), 0n); },
    zeroAt(pool, block) { return w.events.filter((e) => e.pool === pool && e.block <= block && e.ts <= clock.t && e.kind === 'move' && e.to === ZERO).reduce((s, e) => s + e.value, 0n); },
  };
  w.client = {
    getBlockNumber: async () => BigInt(clock.t - EPOCH),
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(Number(blockNumber) + EPOCH) }),
    getCode: async ({ address }) => (w.live(address.toLowerCase()) ? '0x6001' : '0x'),
    getLogs: async ({ address, fromBlock, toBlock }) => {
      w.logCalls++;
      if (w.failLogs > 0) { w.failLogs--; throw new Error('429 too many requests'); }
      if (Number(toBlock - fromBlock + 1n) > w.maxRange) throw new Error('block range is too large');
      let out = w.events.filter((e) => e.pool === address.toLowerCase() && e.ts <= clock.t && BigInt(e.block) >= fromBlock && BigInt(e.block) <= toBlock)
        .map((e) => ({ address: e.pool, blockNumber: BigInt(e.block), logIndex: e.idx, args: { from: e.from, to: e.to, value: e.value } }));
      if (w.dupLogs) out = [...out, ...out];
      if (w.reverseLogs) out = out.reverse();
      return out;
    },
    readContract: async ({ address, functionName, args, blockNumber }) => {
      const a = address.toLowerCase();
      if (a === FEED.toLowerCase()) return [1n, w.feed, 0n, BigInt(clock.t - w.feedAge), 1n];
      const p = w.pools[a];
      if (!p) throw new Error('no such contract');
      if (!w.live(a)) throw noData();
      if (functionName === 'token0') return p.token0;
      if (functionName === 'token1') return p.token1;
      if (functionName === 'reserve0') return p.r0;
      if (functionName === 'reserve1') return p.r1;
      if (functionName === 'sqrtPriceCurrent') return p.sqrt;
      const at = blockNumber == null ? clock.t - EPOCH : Number(blockNumber);
      if (functionName === 'totalSupply') { if (w.failSupply && blockNumber != null) throw new Error('missing trie node'); return w.supplyAt(a, at); }
      if (functionName === 'balanceOf') { if (args[0] !== ZERO) throw new Error('only the zero address is asked'); return w.zeroAt(a, at); }
      throw new Error(`unexpected ${functionName}`);
    },
  };
  return w;
}

// The service on a fresh store, with a clock the test moves. The scan begins two hours before day D0.
function service(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lp-'));
  const store = openStore(join(dir, 'points.db'));
  const clock = { t: T(D0) - 2 * HOUR };
  const w = world(clock), said = [];
  const cfg = {
    schedule: parseLpSchedule(`${D0}:daily=50,create=150,cap=0.02;${D0 + 5}:off`), pools: parseLpPools(`${P1},${P2}=0.5`), pocketWei: tac(1000), endSec: (D0 + 40) * DAY,
    reserveDays: 2, minUsdWei: 20n * WAD, minSamples: 12, exclude: [], fromBlock: T(D0) - 2 * HOUR - EPOCH, usdc: USDC, ethUsdFeed: FEED, confirmations: 12, chunk: 2000, ...over.cfg,
  };
  const lp = createLp({
    store, client: w.client, cfg, budgetFor: over.budgetFor ?? (() => 1111n * WAD), graceSecs: 1800, nowSec: () => clock.t, log: (...m) => said.push(m.join(' ')),
    fundingInputs: over.fundingInputs ?? (async () => ({ heldWei: 100_000n * WAD, claimedWei: 0n, nextDay: D0 })),
  });
  return { lp, w, store, clock, said, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
