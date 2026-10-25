// A token pool's price in ETH (src/lib/evm-pool-keeper-rates.js): read from the pair oracle, an ETH/USD feed or one to one with ETH, written
// where the fee checks read it, kept a while when a read fails and then dropped, so fees in the token are refused rather than mispriced.
// node --test tests/evm-pool-keeper-rates.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRateFeed, makeRateFeed } from '../src/lib/evm-pool-keeper-rates.js';
import { coverCheck, quoteFee } from '../src/lib/evm-pool-keeper-loop.js';

const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', PAIR = '0x000000cE58D7d49319252DaFB0ABdB3F02101271', FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const cfgOf = () => ({ rates: new Map([['0x0000000000000000000000000000000000000000', 10n ** 18n]]), minFees: new Map(), rateMaxAgeSecs: 900, rateWindowSecs: 600, marginBps: 2000n, gasCap: 1_500_000n });
// a chain whose views answer from `v`, or throw where `v` says so
const reader = (v) => async (address, abi, fn) => { const x = v[`${address.toLowerCase()}:${fn}`] ?? v[fn]; if (x instanceof Error) throw x; if (x === undefined) throw new Error(`no ${fn}`); return typeof x === 'function' ? x() : x; };

test('the feed is named tac:<oracle>, usd:<feed> or eth, and anything else refuses', () => {
  assert.deepEqual(parseRateFeed('tac:' + PAIR.toLowerCase()), { kind: 'tac', address: PAIR });
  assert.deepEqual(parseRateFeed('usd:' + FEED), { kind: 'usd', address: FEED });
  assert.deepEqual(parseRateFeed('eth'), { kind: 'eth' });
  assert.equal(parseRateFeed(''), null);
  for (const bad of ['tac', 'tac:0x12', 'btc:' + FEED, 'usd:']) assert.throws(() => parseRateFeed(bad), /RATE_FEED/, bad);
});

test("TAC is priced at the lower of the pair's spot and its latest, and the fee checks use it", async () => {
  const cfg = cfgOf(), f = makeRateFeed({ feed: parseRateFeed('tac:' + PAIR), token: TAC, read: reader({ decimals: 18, spot: 65_561_273_117_213n, latest: 0n }), cfg });
  assert.equal(await f.refresh(), 65_561_273_117_213n, 'no latest: the spot');
  const g = makeRateFeed({ feed: parseRateFeed('tac:' + PAIR), token: TAC, read: reader({ decimals: 18, spot: 70_000_000_000_000n, latest: 60_000_000_000_000n }), cfg });
  assert.equal(await g.refresh(), 60_000_000_000_000n, 'a latest under the spot: the latest');
  // 450k gas at 2 gwei with 20% over: 0.00108 ETH, which at 6e13 wei a TAC is 18 TAC
  const fee = quoteFee({ token: TAC, gas: 450_000n, gasPrice: 2_000_000_000n, cfg });
  assert.equal(fee, 18n * 10n ** 18n);
  assert.equal(coverCheck({ reward: fee, token: TAC, gas: 450_000n, gasPrice: 2_000_000_000n, cfg }).ok, true);
  assert.equal(coverCheck({ reward: fee - 10n ** 17n, token: TAC, gas: 450_000n, gasPrice: 2_000_000_000n, cfg }).ok, false);
});

test('a dollar token is priced from ETH/USD, refused when the answer is stale; a token worth an ETH is one to one', async () => {
  const t = 1_800_000_000_000, cfg = cfgOf(), TACD = '0xA0f6B02561C8ef08335B69aD25e022C0B342147C', TACE = '0x9DE27883C5Dc9Db47BE12E595D59b8f1aBEC8570';
  const fresh = makeRateFeed({ feed: parseRateFeed('usd:' + FEED), token: TACD, read: reader({ decimals: 18, [`${FEED.toLowerCase()}:decimals`]: 8, latestRoundData: [1n, 250_000_000_000n, 0n, BigInt(t / 1000 - 600), 1n] }), cfg, now: () => t });
  assert.equal(await fresh.refresh(), 4n * 10n ** 14n, 'at $2,500 a dollar is 0.0004 ETH');
  const stale = makeRateFeed({ feed: parseRateFeed('usd:' + FEED), token: TACD, read: reader({ decimals: 18, [`${FEED.toLowerCase()}:decimals`]: 8, latestRoundData: [1n, 250_000_000_000n, 0n, BigInt(t / 1000 - 4 * 3600), 1n] }), cfg: cfgOf(), now: () => t });
  assert.equal(await stale.refresh(), null);
  assert.equal(stale.rate(), null, 'a stale answer sets no price');
  const one = makeRateFeed({ feed: parseRateFeed('eth'), token: TACE, read: reader({ decimals: 18 }), cfg });
  assert.equal(await one.refresh(), 10n ** 18n);
  const six = makeRateFeed({ feed: parseRateFeed('eth'), token: TACE, read: reader({ decimals: 6 }), cfg: cfgOf() });
  assert.equal(await six.refresh(), 10n ** 30n, 'per 1e18 base units of a six-decimal token');
});

test('a read that fails keeps the last price a while, then drops it, and fees in the token are refused until one is read', async () => {
  let t = 1_000_000, spot = 50_000_000_000_000n;
  const cfg = cfgOf(), f = makeRateFeed({ feed: parseRateFeed('tac:' + PAIR), token: TAC, read: reader({ decimals: 18, spot: () => { if (spot instanceof Error) throw spot; return spot; }, latest: 0n }), cfg, now: () => t });
  assert.equal(await f.refresh(), spot);
  spot = new Error('node down'); t += 600_000;
  assert.equal(await f.refresh(), null); assert.equal(f.rate(), 50_000_000_000_000n, 'kept within the 15 minutes');
  t += 400_000;
  await f.refresh(); assert.equal(f.rate(), null, 'dropped after them');
  assert.equal(coverCheck({ reward: 10n ** 24n, token: TAC, gas: 450_000n, gasPrice: 1n, cfg }).ok, false, 'with no price and no minimum, no fee in TAC is taken');
  spot = 40_000_000_000_000n; t += 1000;
  assert.equal(await f.refresh(), spot); assert.equal(f.rate(), spot, 'read again, it stands again');
});

test("TAC is counted at the lowest price read over the window, so a price held up for less than it does not count", async () => {
  let t = 1_000_000, spot = 50_000_000_000_000n;
  const cfg = cfgOf(), f = makeRateFeed({ feed: parseRateFeed('tac:' + PAIR), token: TAC, read: reader({ decimals: 18, spot: () => spot, latest: 0n }), cfg, now: () => t });
  assert.equal(await f.refresh(), spot);
  spot = 90_000_000_000_000n; t += 60_000;
  assert.equal(await f.refresh(), 50_000_000_000_000n, 'pushed up a minute later: still the low');
  t += 9 * 60_000;
  assert.equal(await f.refresh(), 50_000_000_000_000n, 'and nine minutes after that');
  t += 61_000;
  assert.equal(await f.refresh(), 90_000_000_000_000n, 'held up for the whole window: it counts');
  spot = 40_000_000_000_000n; t += 1000;
  assert.equal(await f.refresh(), 40_000_000_000_000n, 'a fall counts at once');
});

test('a pool that holds ETH takes no feed, and the ETH price is never dropped', async () => {
  assert.throws(() => makeRateFeed({ feed: parseRateFeed('eth'), token: '0x0000000000000000000000000000000000000000', read: async () => 0n, cfg: cfgOf() }), /holds ETH/);
  const cfg = cfgOf();
  const f = makeRateFeed({ feed: parseRateFeed('tac:' + PAIR), token: TAC, read: async () => { throw new Error('down'); }, cfg, now: () => 10 ** 12 });
  await f.refresh(); await f.refresh();
  assert.equal(cfg.rates.get('0x0000000000000000000000000000000000000000'), 10n ** 18n);
});

test('an opened token pool is priced from zQuoter: one whole token sold for ETH at the best pool, per 1e18 base units, the lowest over the window', async () => {
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', asked = [];
  let out = 422_168_809_698_834n, t = 1_000_000;
  const read = async (address, abi, fn, args, opts) => {
    asked.push({ address, fn, args, opts });
    if (fn === 'decimals') return 6;
    if (fn === 'getQuotes') return [{ source: 4, feeBps: 1n, amountIn: args[3], amountOut: out }, []];
    throw new Error(fn);
  };
  const cfg = cfgOf(), f = makeRateFeed({ feed: parseRateFeed('zq'), token: USDC, read, cfg, now: () => t });
  assert.equal(await f.refresh(), 422_168_809_698_834n * 10n ** 12n, 'per 1e18 base units of a six-decimal token');
  const q = asked.find((x) => x.fn === 'getQuotes');
  assert.deepEqual(q.args, [false, USDC, '0x0000000000000000000000000000000000000000', 1_000_000n]);
  assert.equal(q.address, '0x000000bd2DB80567c23E353ca95a251c573cBf9B'); assert.ok(q.opts?.gas >= 10_000_000n && q.opts.gas <= 30_000_000n, 'with the gas its scan takes (wstETH takes 1.6M), within what every node allows');
  // 0.5 USDC against a 450k-gas relay at 1 gwei (0.00054 ETH with the margin): too little; 1.3 USDC covers it
  assert.equal(coverCheck({ reward: 500_000n, token: USDC, gas: 450_000n, gasPrice: 10n ** 9n, cfg }).ok, false);
  assert.equal(coverCheck({ reward: 1_300_000n, token: USDC, gas: 450_000n, gasPrice: 10n ** 9n, cfg }).ok, true);
  out = 900_000_000_000_000n; t += 60_000;
  assert.equal(await f.refresh(), 422_168_809_698_834n * 10n ** 12n, 'pushed up: still the low');
  out = 0n; t += 60_000;
  assert.equal(await f.refresh(), null, 'no pool sells it: no price read');
  assert.deepEqual(parseRateFeed('zq:0x000000bd2DB80567c23E353ca95a251c573cBf9B'), { kind: 'zq', address: '0x000000bd2DB80567c23E353ca95a251c573cBf9B' });
});

test("a feed written less often is named with its own age: an answer within it is a price, one past it is not, and the age is bounded", async () => {
  const t = 1_800_000_000_000, USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  assert.deepEqual(parseRateFeed(`usd:${FEED}:90000`), { kind: 'usd', address: FEED, maxAgeSecs: 90000 });
  assert.deepEqual(parseRateFeed(`usd:${FEED}`), { kind: 'usd', address: FEED }, 'no age: two hours, as before');
  for (const bad of [`usd:${FEED}:59`, `usd:${FEED}:172801`, `usd:${FEED}:1h`, `usd:${FEED}:-5`]) assert.throws(() => parseRateFeed(bad), /RATE_FEED/, bad);
  // a day old: refused at two hours, a price at 25
  const at = (age, feed) => makeRateFeed({ feed: parseRateFeed(feed), token: USDG, read: reader({ decimals: 6, [`${FEED.toLowerCase()}:decimals`]: 8, latestRoundData: [1n, 250_000_000_000n, 0n, BigInt(t / 1000 - age), 1n] }), cfg: cfgOf(), now: () => t });
  assert.equal(await at(86_000, `usd:${FEED}`).refresh(), null);
  assert.equal(await at(86_000, `usd:${FEED}:90000`).refresh(), 4n * 10n ** 26n, 'a six-decimal dollar at $2,500, per 1e18 base units');
  assert.equal(await at(91_000, `usd:${FEED}:90000`).refresh(), null, 'past its own age it is stale');
});
