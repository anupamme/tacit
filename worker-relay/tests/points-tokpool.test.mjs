// The token pools' campaign: its rules (src/lib/points-tokpool.js) and the service that runs them (src/lib/points-tokpool-service.js) on a
// fake chain (one block a second, so a block's number is its time) and a real store. What a deposit is worth, which deposits count and why
// the others do not, how a day is split between the pools, and every reason a credit waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toEventSelector } from 'viem';
import { openStore } from '../src/lib/points-store.js';
import { parseLpSchedule } from '../src/lib/points-lp.js';
import { createTokPool } from '../src/lib/points-tokpool-service.js';
import { WAD, parseTokPools, depositUsd, depositSkip, allocateTokDay, depositorOf, dayId } from '../src/lib/points-tokpool.js';
import { DEPOSIT_BOX_COMPLETED_EVENT } from '../src/lib/evm-pool-points.js';

const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222', C = '0x3333333333333333333333333333333333333333';
const E = '0x4444444444444444444444444444444444444444', RELAY = '0x7c9f8ae4e48cbb2727f95b6477a1cf92bcfc43d0', OTHER = '0x5555555555555555555555555555555555555555';
const PU = '0xaaaa000000000000000000000000000000000001', RU = '0xbbbb000000000000000000000000000000000002', PT = '0xcccc000000000000000000000000000000000003', RT = '0xdddd000000000000000000000000000000000004';
const USDC = '0x9999000000000000000000000000000000000009', TAC = '0x8888000000000000000000000000000000000008', ORACLE = '0x7777000000000000000000000000000000000007', FEED = '0x6666000000000000000000000000000000000006';
const tac = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n, usdc = (n) => BigInt(Math.round(n * 1e6));
const D0 = 20800, DAY = 86400, HOUR = 3600, EPOCH = 1_790_000_000, T = (day, hour = 0, min = 0) => day * DAY + hour * HOUR + min * 60;
const POOLS = parseTokPools(`${PU}/${RU}=usd,${PT}/${RT}=tac`);
const SCHEDULE = parseLpSchedule(`${D0}:daily=60,cap=0.006`);

test('the rules: pools, a deposit\'s worth, which deposits count, the day\'s split', () => {
  const said = [];
  assert.deepEqual(parseTokPools(`${PU}/${RU}=usd, ${PU}/${RU}=tac, ${PT}=tac, ${PT}/${RT}=eth`, (m) => said.push(m)), [{ pool: PU, router: RU, kind: 'usd' }]);
  assert.equal(said.length, 3, 'a pool twice, one with no router and one of an unknown kind are refused');
  assert.equal(depositUsd({ amount: usdc(1000), dec: 6, kind: 'usd' }), 1000n * WAD);
  assert.equal(depositUsd({ amount: tac(10_000), dec: 18, kind: 'tac', tacUsdWei: tac(0.15) }), 1500n * WAD);
  assert.equal(depositUsd({ amount: tac(10_000), dec: 18, kind: 'tac', tacUsdWei: null }), null, 'TAC with no price for the day is worth nothing yet');
  assert.equal(depositSkip({ usdWei: 9n * WAD, minUsdWei: 10n * WAD, ts: 100 }), 'small');
  assert.equal(depositSkip({ usdWei: 100n * WAD, minUsdWei: 10n * WAD, ts: 100_000, paidOut: [100_000 - DAY + 1] }), 'loop', 'paid out less than a day before');
  assert.equal(depositSkip({ usdWei: 100n * WAD, minUsdWei: 10n * WAD, ts: 100_000, paidOut: [100_000 - DAY] }), null, 'a day or more before is fine');
  assert.equal(depositSkip({ usdWei: 100n * WAD, minUsdWei: 10n * WAD, ts: 100_000, paidOut: [100_001] }), null, 'a payout after the deposit does not undo it');
  const ex = new Set([RELAY]);
  assert.equal(depositorOf({ from: A, to: RU }, { pool: PU, router: RU, excluded: ex }), A.toLowerCase());
  assert.equal(depositorOf({ from: A, to: A }, { pool: PU, router: RU, excluded: ex }), A.toLowerCase(), 'a wallet batching its own calls');
  assert.equal(depositorOf({ from: A, to: OTHER }, { pool: PU, router: RU, excluded: ex }), null, 'through another contract (a bundler, a zap) the sender may not be the depositor');
  assert.equal(depositorOf({ from: RELAY, to: RU }, { pool: PU, router: RU, excluded: ex }), null, 'the relay sends for others');

  const cap = tac(0.006), pools = [PU, PT], big = 2500n * WAD;
  // A quiet day: everyone at the cap, the rest stays in the pocket.
  assert.deepEqual(allocateTokDay({ deposits: [{ pool: PU, address: A, usdWei: 1000n * WAD }], pools, dailyWei: tac(60), capWeiPerUsd: cap, addressUsdWei: big }), [{ address: A, wei: tac(6) }]);
  // A busy pool shares its half (30 TAC) by dollars; the other pool's half is not handed to it.
  const busy = allocateTokDay({ deposits: [{ pool: PU, address: A, usdWei: 2000n * WAD }, { pool: PU, address: B, usdWei: 2000n * WAD }, { pool: PU, address: C, usdWei: 2000n * WAD }, { pool: PU, address: E, usdWei: 2000n * WAD }], pools, dailyWei: tac(60), capWeiPerUsd: cap, addressUsdWei: big });
  assert.deepEqual(busy.map((x) => x.wei), [tac(7.5), tac(7.5), tac(7.5), tac(7.5)]);
  // What an address deposits counts up to the per-address cap in a pool, and its deposits in two pools are paid once, added.
  const capped = allocateTokDay({ deposits: [{ pool: PU, address: A, usdWei: 9000n * WAD }, { pool: PT, address: A, usdWei: 100n * WAD }], pools, dailyWei: tac(60), capWeiPerUsd: cap, addressUsdWei: big });
  assert.deepEqual(capped, [{ address: A, wei: tac(15) + tac(0.6) }]);
});

// A chain with a dollar pool (six decimals) and a TAC pool, their routers, an oracle and a feed.
function world(clock) {
  const w = {
    logs: [], txs: new Map(), receipts: new Map(), spot: tac(0.15) / 2000n, feed: 2000n * 10n ** 8n, n: 0,
    // A pool Transact at `ts`: `amount` > 0 a deposit sent by `from` to `to`, < 0 a payout to `recipient`. `box` adds the router's completion.
    transact(pool, amount, ts, { from = A, to, recipient = '0x0000000000000000000000000000000000000000', box = false, fee = 0n, relayer = '0x0000000000000000000000000000000000000000' } = {}) {
      const hash = '0x' + (++w.n).toString(16).padStart(64, '0'), router = pool === PU ? RU : RT;
      w.logs.push({ pool, blockNumber: BigInt(ts - EPOCH), logIndex: 0, transactionHash: hash, args: { extAmount: amount, recipient, fee, relayer } });
      w.txs.set(hash, { from, to: to ?? router });
      w.receipts.set(hash, { logs: box ? [{ address: router, topics: [toEventSelector(DEPOSIT_BOX_COMPLETED_EVENT)] }] : [] });
      return hash;
    },
  };
  w.client = {
    getBlockNumber: async () => BigInt(clock.t - EPOCH),
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(Number(blockNumber) + EPOCH) }),
    getLogs: async ({ address, fromBlock, toBlock }) => w.logs.filter((l) => l.pool === address.toLowerCase() && l.blockNumber >= fromBlock && l.blockNumber <= toBlock && Number(l.blockNumber) + EPOCH <= clock.t),
    getTransaction: async ({ hash }) => w.txs.get(hash),
    getTransactionReceipt: async ({ hash }) => w.receipts.get(hash),
    readContract: async ({ address, functionName, blockNumber }) => {
      const a = address.toLowerCase();
      if (functionName === 'ASSET') { if (a !== PU && a !== PT) throw new Error('execution reverted'); return a === PU ? USDC : TAC; }
      if (functionName === 'decimals') return a === USDC ? 6 : 18;
      if (functionName === 'spot') return w.spot;
      if (functionName === 'latestRoundData') return [7n, w.feed, 0n, BigInt(Number(blockNumber) + EPOCH), 7n];
      throw new Error(`unexpected ${functionName}`);
    },
  };
  return w;
}

function service(over = {}) {
  const clock = { t: T(D0) }, w = world(clock), dir = mkdtempSync(join(tmpdir(), 'tokpool-')), said = [];
  const store = openStore(join(dir, 'points.db'));
  const s = createTokPool({
    store, client: w.client, budgetFor: () => 1111n * WAD, graceSecs: 1800, nowSec: () => clock.t, log: (...m) => said.push(m.join(' ')),
    fundingInputs: over.fundingInputs ?? (async () => ({ heldWei: 100_000n * WAD, claimedWei: 0n, nextDay: D0 })),
    cfg: { schedule: SCHEDULE, pools: over.pools ?? POOLS, pocketWei: 3500n * WAD, endSec: T(D0 + 60), fromBlock: T(D0 - 1) - EPOCH, exclude: [RELAY], tacOracle: ORACLE, ethUsdFeed: FEED, confirmations: 0, ...over.cfg },
  });
  // Runs the service once an hour from now to `to`, as the indexer's loop would (more often, but an hour is enough for its readings).
  const runTo = async (to) => { while (clock.t < to) { clock.t = Math.min(to, clock.t + HOUR); await s.cycle(); } };
  return { s, w, clock, store, said, runTo, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a day: who deposited, what counted and why not, and what each was credited', async () => {
  const { s, w, store, runTo, said, done } = service();
  w.transact(PU, -usdc(500), T(D0 - 1, 22), { from: RELAY, recipient: C });                  // C was paid out late yesterday
  w.transact(PU, usdc(1000), T(D0, 3), { from: A });                                         // A: through the router
  w.transact(PU, usdc(1000), T(D0, 4), { from: B, to: OTHER });                              // B: through someone else's contract
  w.transact(PU, usdc(1000), T(D0, 5), { from: RELAY });                                     // the relay
  w.transact(PU, usdc(1000), T(D0, 6), { from: C });                                         // C: within a day of its payout
  w.transact(PU, usdc(1000), T(D0, 7), { from: E, box: true });                              // E completed a deposit box
  w.transact(PU, usdc(5), T(D0, 8), { from: B, to: PU });                                    // B: too small
  w.transact(PT, tac(10_000), T(D0, 9), { from: B, to: PT });                                // B: 10,000 TAC straight to the pool
  await runTo(T(D0 + 1, 0, 40));
  const rec = s.dayRecord(D0);
  assert.ok(rec, 'the day is paid and its record kept');
  const why = Object.fromEntries(rec.record.deposits.map((d) => [`${d.address}:${d.amount}`, d.why ?? 'counted']));
  assert.deepEqual(why, {
    [`${A}:${usdc(1000)}`]: 'counted', [`${B}:${usdc(1000)}`]: 'sender', [`${RELAY}:${usdc(1000)}`]: 'sender', [`${C}:${usdc(1000)}`]: 'loop',
    [`${E}:${usdc(1000)}`]: 'box', [`${B}:${usdc(5)}`]: 'small', [`${B}:${tac(10_000)}`]: 'counted',
  });
  assert.equal(BigInt(rec.record.tacUsdWei), tac(0.15), 'TAC at the median of the day\'s readings');
  assert.equal(store.creditedWithPrefix(dayId(D0, A)), tac(6), 'A: $1,000 at 0.006 TAC a dollar');
  assert.equal(store.creditedWithPrefix(dayId(D0, B)), tac(9), 'B: 10,000 TAC at $0.15 is $1,500');
  assert.equal(store.creditedWithPrefix('tp:'), tac(15));
  await s.settle(); await s.settle();
  assert.equal(store.creditedWithPrefix('tp:'), tac(15), 'a paid day is never paid again');
  assert.equal(s.view({ address: A }).mine.creditedWei, String(tac(6)));
  assert.ok(!said.some((m) => /failed/.test(m)), said.join('\n'));
  done();
});

test('TAC without enough readings is not counted; the dollar pool is paid all the same', async () => {
  const { s, w, store, clock, done } = service();
  w.transact(PU, usdc(100), T(D0, 3), { from: A });
  w.transact(PT, tac(1000), T(D0, 4), { from: B, to: PT });
  await s.cycle();                                                                           // on at the start of the day, then down for the rest of it: no readings
  clock.t = T(D0 + 1, 0, 40);
  await s.cycle();
  const d = s.dayRecord(D0).record.deposits;
  assert.equal(d.find((x) => x.address === B.toLowerCase()).why, 'unpriced');
  assert.equal(store.creditedWithPrefix(dayId(D0, A)), tac(0.6));
  assert.equal(store.creditedWithPrefix(dayId(D0, B)), 0n);
  done();
});

test('credits wait for the pocket and for the regular pot\'s funding, and are paid once they can be', async () => {
  let held = 1_000n * WAD;                                                                     // under two days of the regular pot
  const { s, w, store, runTo, said, done } = service({ cfg: { pocketWei: tac(5) }, fundingInputs: async () => ({ heldWei: held, claimedWei: 0n, nextDay: D0 }) });
  w.transact(PU, usdc(1000), T(D0, 3), { from: A });
  await runTo(T(D0 + 1, 0, 40));
  assert.equal(store.creditedWithPrefix('tp:'), 0n);
  assert.ok(said.some((m) => /wait: pocket/.test(m)), 'a pocket of 5 cannot pay 6');
  done();
  const b = service({ fundingInputs: async () => ({ heldWei: held, claimedWei: 0n, nextDay: D0 }) });
  b.w.transact(PU, usdc(1000), T(D0, 3), { from: A });
  await b.runTo(T(D0 + 1, 0, 40));
  assert.equal(b.store.creditedWithPrefix('tp:'), 0n);
  assert.ok(b.said.some((m) => /wait: funding/.test(m)), 'the regular pot comes first');
  held = 100_000n * WAD;
  await b.s.settle();
  assert.equal(b.store.creditedWithPrefix('tp:'), tac(6), 'paid once the distributor is topped up');
  b.done();
});

test('the schedule: nothing before it starts, nothing after "off"', async () => {
  const { s, w, store, runTo, done } = service({ cfg: { schedule: parseLpSchedule(`${D0 + 1}:daily=60,cap=0.006;${D0 + 2}:off`) } });
  w.transact(PU, usdc(1000), T(D0, 3), { from: A });
  w.transact(PU, usdc(1000), T(D0 + 1, 3), { from: B });
  w.transact(PU, usdc(1000), T(D0 + 2, 3), { from: C });
  await runTo(T(D0 + 3, 0, 40));
  assert.equal(store.creditedWithPrefix(dayId(D0, A)), 0n);
  assert.equal(store.creditedWithPrefix(dayId(D0 + 1, B)), tac(6));
  assert.equal(store.creditedWithPrefix(dayId(D0 + 2, C)), 0n);
  assert.equal(s.view().terms, null, 'off now');
  done();
});

test('the review\'s cases: a deposit refunded through its own fee, a withdrawal paid as a fee, the last day, a listed address that is no pool', async () => {
  // A deposit whose fee hands its amount back to its sender (relayer = itself) is not counted; nor, for a day, is a deposit from an address
  // paid out as a relayer's fee.
  const a = service();
  a.w.transact(PU, usdc(2500), T(D0, 3), { from: A, fee: usdc(2500), relayer: A });
  a.w.transact(PU, 0n, T(D0, 4), { from: B, fee: usdc(300), relayer: C });                      // C withdraws by naming itself the relayer
  a.w.transact(PU, usdc(1000), T(D0, 5), { from: C });
  a.w.transact(PU, usdc(1000), T(D0, 6), { from: E });
  await a.runTo(T(D0 + 1, 0, 40));
  const why = Object.fromEntries(a.s.dayRecord(D0).record.deposits.map((d) => [d.address, d.why ?? 'counted']));
  assert.deepEqual(why, { [A.toLowerCase()]: 'fee', [C.toLowerCase()]: 'loop', [E.toLowerCase()]: 'counted' });
  assert.equal(a.store.creditedWithPrefix('tp:'), tac(6), 'only E is paid');
  a.done();
  // The last day before the end is paid, though it can only be paid after it is over.
  const b = service({ cfg: { endSec: T(D0 + 1) } });
  b.w.transact(PU, usdc(1000), T(D0, 3), { from: A });
  await b.runTo(T(D0 + 1, 0, 40));
  assert.equal(b.store.creditedWithPrefix(dayId(D0, A)), tac(6));
  b.done();
  // A listed address that is no token pool is left out and said so; the others are paid as before.
  const c = service({ pools: parseTokPools(`${PU}/${RU}=usd,${OTHER}/${RT}=usd`) });
  c.w.transact(PU, usdc(1000), T(D0, 3), { from: A });
  await c.runTo(T(D0 + 1, 0, 40));
  assert.equal(c.store.creditedWithPrefix(dayId(D0, A)), tac(6), 'paid, the dropped address taking no part');
  assert.ok(c.said.some((m) => /is not a token pool/.test(m)));
  assert.deepEqual(c.s.view().pools.map((x) => x.pool), [PU]);
  c.done();
});
