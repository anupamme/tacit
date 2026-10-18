// The liquidity campaign as the service runs it (src/lib/points-lp-service.js): who holds shares, hourly samples, what a day pays, the
// opening bonus, and every reason a credit waits. A fake chain stands in for the pools; the store is a real one.
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
const P1 = '0xaaaa000000000000000000000000000000000001', P2 = '0xbbbb000000000000000000000000000000000002', SYN = '0xcccc000000000000000000000000000000000003';
const tac = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const D0 = 20800, DAY = 86400;

// A chain with two pools: P1 is TACD against USDC (the quote is token0, six decimals), P2 is TACE against ETH (ETH is token0).
function world() {
  const w = {
    head: 5000, logs: [], feed: 2500n * 10n ** 8n,
    pools: {
      [P1]: { token0: USDC, token1: SYN, r0: 1000n * 10n ** 6n, r1: 1000n * WAD, sqrt: 10n ** 24n, supply: 0n, bal: new Map() },
      [P2]: { token0: ZERO, token1: SYN, r0: 2n * WAD, r1: 2n * WAD, sqrt: WAD, supply: 0n, bal: new Map() },
    },
    mint(pool, to, shares, block) {
      const p = w.pools[pool];
      p.bal.set(to.toLowerCase(), (p.bal.get(to.toLowerCase()) ?? 0n) + shares); p.supply += shares;
      w.logs.push({ address: pool, blockNumber: BigInt(block), logIndex: w.logs.length, args: { from: ZERO, to, value: shares } });
    },
    move(pool, from, to, shares, block) {
      const p = w.pools[pool], f = from.toLowerCase(), t = to.toLowerCase();
      p.bal.set(f, p.bal.get(f) - shares); p.bal.set(t, (p.bal.get(t) ?? 0n) + shares);
      w.logs.push({ address: pool, blockNumber: BigInt(block), logIndex: w.logs.length, args: { from, to, value: shares } });
    },
  };
  w.client = {
    getBlockNumber: async () => BigInt(w.head),
    getLogs: async ({ address, fromBlock, toBlock }) => w.logs.filter((l) => l.address === address.toLowerCase() && l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    readContract: async ({ address, functionName, args }) => {
      const a = address.toLowerCase();
      if (a === FEED.toLowerCase()) return [1n, w.feed, 0n, 0n, 1n];
      const p = w.pools[a];
      if (!p) throw new Error('no such contract');
      if (functionName === 'token0') return p.token0;
      if (functionName === 'token1') return p.token1;
      if (functionName === 'reserve0') return p.r0;
      if (functionName === 'reserve1') return p.r1;
      if (functionName === 'totalSupply') return p.supply;
      if (functionName === 'sqrtPriceCurrent') return p.sqrt;
      if (functionName === 'balanceOf') return p.bal.get(args[0].toLowerCase()) ?? 0n;
      throw new Error(`unexpected ${functionName}`);
    },
  };
  return w;
}

// The service on a fresh store, with a clock the test moves.
function service(w, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lp-'));
  const store = openStore(join(dir, 'points.db'));
  const clock = { t: D0 * DAY - 3600 };
  const said = [];
  const cfg = {
    schedule: parseLpSchedule(`${D0}:daily=50,create=150,cap=0.02;${D0 + 5}:off`), pools: parseLpPools(`${P1},${P2}=0.5`), pocketWei: tac(1000), endSec: (D0 + 40) * DAY,
    reserveDays: 2, minUsdWei: 20n * WAD, minSamples: 12, exclude: [], fromBlock: 1000, usdc: USDC, ethUsdFeed: FEED, confirmations: 12, chunk: 2000, ...over.cfg,
  };
  const lp = createLp({
    store, client: w.client, cfg, budgetFor: () => 1111n * WAD, graceSecs: 1800, nowSec: () => clock.t, log: (...m) => said.push(m.join(' ')),
    fundingInputs: over.fundingInputs ?? (async () => ({ heldWei: 100_000n * WAD, claimedWei: 0n, nextDay: D0 })),
  });
  return { lp, store, clock, said, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
// One cycle for each hour from `from` seconds to `to`.
async function hours(s, from, to) { for (let t = from; t < to; t += 3600) { s.clock.t = t; await s.lp.cycle(); } }
const credited = (store, id) => store.db.prepare('SELECT wei FROM reward_adjustments WHERE id = ?').get(id)?.wei;

test('a day is paid to whoever held liquidity for all of it, on the lowest sample, and nothing waits on those who came and went', async () => {
  const w = world(), s = service(w);
  try {
    // The pool's first shares: a thousand to the dead address, then 600 to A (the opener). B is minted shares at hour 10 of the day.
    w.mint(P1, DEAD, 1000n, 1100); w.mint(P1, A, 600n * WAD, 1101);
    await hours(s, D0 * DAY - 3600, D0 * DAY + 10 * 3600);
    w.mint(P1, B, 400n * WAD, 5000); w.head = 5100;
    await hours(s, D0 * DAY + 10 * 3600, (D0 + 1) * DAY);
    assert.equal(s.store.db.prepare('SELECT COUNT(DISTINCT hour) AS n FROM lp_samples WHERE day = ? AND pool = ?').get(D0, P1.toLowerCase()).n, 24, 'a sample every hour');
    // The day is not paid until it is over, with the grace.
    s.clock.t = (D0 + 1) * DAY + 1000; await s.lp.cycle();
    assert.equal(credited(s.store, dayId(D0, A)), undefined, 'not before the grace has passed');
    s.clock.t = (D0 + 1) * DAY + 1900; await s.lp.cycle();
    const a = BigInt(credited(s.store, dayId(D0, A)));
    // A held 600 of the ~1000 shares of a $2,000 pool all day: about $1,200, and the cap is 0.02 TAC for each dollar, so 24 TAC (not 30, its share of the pot).
    assert.ok(a > tac(23.9) && a <= tac(24), `A is capped at 0.02 TAC for each dollar held: ${a}`);
    assert.equal(credited(s.store, dayId(D0, B)), undefined, 'B arrived at hour 10, so its lowest sample of the day is nothing');
    assert.equal(credited(s.store, openId(P1)), '150000000000000000000', 'A opened the pool and held $20 or more all day, so it is paid the opening bonus');
    assert.equal(credited(s.store, dayId(D0, DEAD)), undefined, 'the dead address is not paid');
    // Looking again pays nothing twice.
    const before = s.store.creditedWithPrefix('lp:');
    for (let i = 0; i < 3; i++) { s.clock.t += 60; await s.lp.cycle(); }
    assert.equal(s.store.creditedWithPrefix('lp:'), before, 'a paid day is never paid again');
    // The next day both held all of it.
    await hours(s, (D0 + 1) * DAY + 3600 * 2, (D0 + 2) * DAY);
    s.clock.t = (D0 + 2) * DAY + 1900; await s.lp.cycle();
    const [a1, b1] = [BigInt(credited(s.store, dayId(D0 + 1, A))), BigInt(credited(s.store, dayId(D0 + 1, B)))];
    assert.ok(a1 > 0n && b1 > 0n, 'on the next day both are paid');
    assert.ok(a1 + b1 <= tac(50), 'and never more than the day');
    assert.equal(credited(s.store, openId(P1)), '150000000000000000000', 'the opening bonus stays a single credit');
  } finally { s.cleanup(); }
});

test('what a half-sampled day pays, the cap on the pocket, an excluded address and the end', async () => {
  const w = world(); w.mint(P1, DEAD, 1000n, 1100); w.mint(P1, A, 1000n * WAD, 1101);
  // Too few samples: the service was down for most of the day.
  let s = service(w);
  try {
    await hours(s, D0 * DAY + 20 * 3600, (D0 + 1) * DAY);
    s.clock.t = (D0 + 1) * DAY + 1900; await s.lp.cycle();
    assert.equal(s.store.creditedWithPrefix('lp:'), 0n, 'four samples are not a day');
    assert.ok(s.said.some((m) => /fewer than 12 samples/.test(m)));
    assert.ok(s.store.db.prepare('SELECT 1 FROM lp_days WHERE day = ?').get(D0), 'and the day is closed, not retried for ever');
  } finally { s.cleanup(); }
  // The pocket: only 30 TAC in it, a day wants 24 + the 150 bonus.
  s = service(w, { cfg: { pocketWei: tac(30) } });
  try {
    await hours(s, D0 * DAY - 3600, (D0 + 1) * DAY);
    s.clock.t = (D0 + 1) * DAY + 1900; await s.lp.cycle();
    assert.equal(s.store.creditedWithPrefix('lp:'), 0n, 'a day that would overdraw the pocket waits whole');
    assert.ok(s.said.some((m) => /lp credits wait: pocket/.test(m)));
  } finally { s.cleanup(); }
  // An excluded address earns nothing, and its liquidity does not dilute anyone.
  s = service(w, { cfg: { exclude: [A] } });
  try {
    await hours(s, D0 * DAY - 3600, (D0 + 1) * DAY);
    s.clock.t = (D0 + 1) * DAY + 1900; await s.lp.cycle();
    assert.equal(s.store.creditedWithPrefix('lp:'), 0n, 'the only holder is excluded: nothing is paid, and no bonus');
  } finally { s.cleanup(); }
  // After the end nothing is paid.
  s = service(w, { cfg: { endSec: D0 * DAY + 100 } });
  try {
    await hours(s, D0 * DAY - 3600, (D0 + 1) * DAY);
    s.clock.t = (D0 + 1) * DAY + 1900; await s.lp.cycle();
    assert.equal(s.store.creditedWithPrefix('lp:'), 0n);
    assert.ok(s.said.some((m) => /lp credits wait: ended/.test(m)));
  } finally { s.cleanup(); }
});

test('an opener whose own liquidity is under the minimum is not paid the bonus, however it came to open the pool', async () => {
  const w = world();
  // C is minted the first shares, but they are worth about $10 of a $10,000 pool; B puts in the rest.
  w.mint(P2, DEAD, 1000n, 1100); w.mint(P2, C, 10n ** 15n, 1101); w.mint(P2, B, 10n ** 18n, 1102);
  const s = service(w, { cfg: { pools: parseLpPools(P2) } });
  try {
    await hours(s, D0 * DAY - 3600, (D0 + 1) * DAY);
    s.clock.t = (D0 + 1) * DAY + 1900; await s.lp.cycle();
    assert.equal(credited(s.store, openId(P2)), undefined, 'the opener held under $20, so there is no opening bonus');
    assert.ok(BigInt(credited(s.store, dayId(D0, B))) > 0n, 'the day is still paid to the one holding most of the pool');
    assert.equal(credited(s.store, dayId(D0, C)) === undefined || BigInt(credited(s.store, dayId(D0, C))) >= 0n, true);
    // It is paid on a later day, once its own liquidity is over the minimum for the whole of it: more shares for the same address, from the
    // start of the day after next (the day between is only sampled once, so it counts for nothing).
    w.mint(P2, C, 10n ** 18n, 5200); w.head = 5300;
    await hours(s, (D0 + 2) * DAY, (D0 + 3) * DAY);
    assert.equal(credited(s.store, openId(P2)), undefined, 'not before that day is over');
    s.clock.t = (D0 + 3) * DAY + 1900; await s.lp.cycle();
    assert.equal(credited(s.store, openId(P2)), '150000000000000000000', 'once it has held $20 or more for a whole day the opener is paid, as a single credit');
  } finally { s.cleanup(); }
});

test('funding that would stop covering the regular pot holds the credits, and they are paid when it recovers', async () => {
  const w = world(); w.mint(P1, DEAD, 1000n, 1100); w.mint(P1, A, 1000n * WAD, 1101);
  let held = 1_500n * WAD;                                     // a day of the regular pot (1,111) and a little: fewer than two days covered
  const s = service(w, { fundingInputs: async () => ({ heldWei: held, claimedWei: 0n, nextDay: D0 }) });
  try {
    await hours(s, D0 * DAY - 3600, (D0 + 1) * DAY);
    s.clock.t = (D0 + 1) * DAY + 1900; await s.lp.cycle();
    assert.equal(s.store.creditedWithPrefix('lp:'), 0n, 'the regular pot comes first');
    assert.ok(s.said.some((m) => /lp credits wait: funding/.test(m)));
    held = 100_000n * WAD;
    s.clock.t += 60; await s.lp.cycle();
    assert.ok(s.store.creditedWithPrefix('lp:') > 0n, 'once the distributor is funded the day is paid, nothing lost');
  } finally { s.cleanup(); }
});

test('an ETH pool is valued at the feed, a pool of anything else is left alone, and the view says what a page needs', async () => {
  const w = world(); w.mint(P2, DEAD, 1000n, 1100); w.mint(P2, C, 10n * WAD, 1101);
  w.pools['0xdddd000000000000000000000000000000000004'] = { token0: '0x9999999999999999999999999999999999999999', token1: SYN, r0: 1n, r1: 1n, sqrt: 1n, supply: 5n, bal: new Map() };
  const s = service(w, { cfg: { pools: parseLpPools(`${P2},0xdddd000000000000000000000000000000000004`) } });
  try {
    await hours(s, D0 * DAY - 3600, D0 * DAY + 2 * 3600);
    const row = s.store.db.prepare('SELECT pool_usd FROM lp_samples WHERE pool = ? ORDER BY day, hour LIMIT 1').get(P2.toLowerCase());
    assert.equal(BigInt(row.pool_usd), 10_000n * WAD, '2 ETH at $2,500 and 2 TACE at the peg is $10,000');
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM lp_samples WHERE pool = ?').get('0xdddd000000000000000000000000000000000004').n, 0, 'a pool of neither ETH nor USDC is not valued');
    const v = s.lp.view({ address: C });
    assert.equal(v.enabled, true);
    assert.equal(v.pocket.totalWei, String(tac(1000)));
    assert.equal(v.terms.dailyWei, String(tac(50)));
    assert.equal(v.next.fromDay, D0 + 5, 'the next change is the end');
    const p2 = v.pools.find((p) => p.pool === P2.toLowerCase());
    assert.equal(p2.opened, true); assert.equal(p2.opener, C.toLowerCase()); assert.equal(p2.openPaid, false);
    assert.equal(p2.weightBps, '10000');
    assert.ok(BigInt(p2.mineUsdWei) > 9_900n * WAD, 'the account sees what its shares are worth now');
    assert.deepEqual(v.mine.opened, [P2.toLowerCase()]);
    assert.equal(v.mine.creditedWei, '0');
    s.clock.t = D0 * DAY + 3 * 3600; w.feed = 0n;
    await s.lp.cycle();
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM lp_samples WHERE day = ? AND hour = 3 AND pool = ?').get(D0, P2.toLowerCase()).n, 0, 'with no ETH price the hour is left unsampled');
  } finally { s.cleanup(); }
});

test('it is off unless it has a pocket, an end, a schedule and a pool', async () => {
  const w = world();
  for (const over of [{ pocketWei: 0n }, { endSec: 0 }, { schedule: [] }, { pools: [] }]) {
    const s = service(w, { cfg: over });
    try {
      assert.equal(s.lp.enabled, false);
      await s.lp.cycle();
      assert.deepEqual(s.lp.view(), { enabled: false });
      assert.equal(s.store.db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'lp_%'`).get().n, 0, 'and it leaves the store alone');
    } finally { s.cleanup(); }
  }
});
