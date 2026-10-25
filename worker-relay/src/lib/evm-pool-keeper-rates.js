// A token pool's price in ETH, for a keeper paid in the pool's token (the TAC, TACD and TACE pools beside the TAC vaults): read from the
// chain on a timer and written into cfg.rates (wei per 10^18 of the token's base units), which every fee check reads (coverCheck,
// quoteFee). EVM_POOL_KEEPER_RATE_FEED names where the price comes from:
//   tac:<TacPairOracle>     TAC: the lower of the two venues' spot prices the vaults' pair oracle reads (Precision and the Tacit pool), and
//                           of its latest recorded price when it has one; and the lowest such price read over the last cfg.rateWindowSecs,
//                           so raising the fee's worth takes holding both venues up for that long
//   usd:<Chainlink feed>[:<max age, s>]
//                           a token worth one US dollar (TACD): ETH per dollar from an ETH/USD feed, refused once its answer is stale:
//                           older than two hours, or than the age named, for a chain whose feed is written less often (Robinhood
//                           Chain's ETH/USD is written on a 0.5% move or once a day, so an answer a day old is still within 0.5%)
//   eth                     a token worth one ETH (TACE)
//   zq[:<zQuoter>]          any token zQuoter routes (an opened token pool): what one whole token sells for, the best pool's quote, and the
//                           lowest over the window, as TAC's
// A price that cannot be read keeps the last one for cfg.rateMaxAgeSecs, then is dropped, and fees in the token are refused until one is
// read again: the keeper never relays at a price it does not know. A pool that holds ETH has no feed (its price is one, always).
import { getAddress, isAddress, parseAbi } from 'viem';
import { safeErr } from './safe-err.js';

const E18 = 10n ** 18n;
const PAIR_ABI = parseAbi(['function spot() view returns (uint256)', 'function latest() view returns (uint256)']);
const ZQ_ABI = parseAbi(['function getQuotes(bool exactOut, address tokenIn, address tokenOut, uint256 swapAmount) view returns ((uint8 source, uint256 feeBps, uint256 amountIn, uint256 amountOut) best, (uint8 source, uint256 feeBps, uint256 amountIn, uint256 amountOut)[] quotes)']);
export const ZQUOTER = '0x000000bd2DB80567c23E353ca95a251c573cBf9B';
const FEED_ABI = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)', 'function decimals() view returns (uint8)']);
const TOKEN_ABI = parseAbi(['function decimals() view returns (uint8)']);
// Chainlink's ETH/USD heartbeat is an hour on Ethereum; an answer older than two is not a price. A feed named with its own age may take up
// to two days (past its heartbeat, an answer is a feed that has stopped).
const FEED_STALE_SECS = 2 * 3600, FEED_STALE_MAX_SECS = 2 * 86400;
const ETH = '0x0000000000000000000000000000000000000000';

// "tac:<address>" | "usd:<address>" | "eth" | "" → { kind, address? } or null.
export function parseRateFeed(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s === 'eth') return { kind: 'eth' };
  if (s === 'zq') return { kind: 'zq', address: ZQUOTER };
  const [kind, address, age] = s.split(':').map((x) => x.trim());
  if (kind === 'zq' && isAddress(address || '')) return { kind, address: getAddress(address) };
  if (kind === 'tac' && isAddress(address || '')) return { kind, address: getAddress(address) };
  if (kind === 'usd' && isAddress(address || '')) {
    if (!age) return { kind, address: getAddress(address) };
    const secs = /^\d+$/.test(age) ? Number(age) : NaN;
    if (secs >= 60 && secs <= FEED_STALE_MAX_SECS) return { kind, address: getAddress(address), maxAgeSecs: secs };
  }
  throw new Error(`EVM_POOL_KEEPER_RATE_FEED: bad value "${s}" (tac:<pair oracle>, usd:<ETH/USD feed>[:<max age, 60 to ${FEED_STALE_MAX_SECS} s>], eth or zq[:<zQuoter>])`);
}

// `read(address, abi, functionName, args)` is a view call (makeKeeperChain's readContract). → { refresh, rate } where refresh() reads the
// price and sets cfg.rates for `token`, and rate() is the current one (or null).
export function makeRateFeed({ feed, token, read, cfg, log = () => {}, now = () => Date.now() }) {
  const key = token.toLowerCase();
  if (key === ETH) throw new Error('a pool that holds ETH takes no EVM_POOL_KEEPER_RATE_FEED: its price is one ETH');
  let at = 0, decimals = null;
  const seen = [];   // TAC and zq: [time, price] read within the window
  const lowest = (p) => {
    const t = now(), window = (cfg.rateWindowSecs ?? 600) * 1000;
    seen.push([t, p]);
    while (seen.length && t - seen[0][0] > window) seen.shift();
    return seen.reduce((m, [, x]) => (x < m ? x : m), p);
  };
  // wei per 10^18 base units, from wei per whole token
  const perBase = (weiPerToken) => (decimals === 18 ? weiPerToken : (weiPerToken * E18) / 10n ** BigInt(decimals));
  async function price() {
    if (decimals === null) decimals = Number(await read(token, TOKEN_ABI, 'decimals'));
    if (feed.kind === 'eth') return perBase(E18);
    if (feed.kind === 'tac') {
      // the pair oracle's prices are already wei per 10^18 base units (its venues price in base units)
      const [spot, latest] = await Promise.all([read(feed.address, PAIR_ABI, 'spot'), read(feed.address, PAIR_ABI, 'latest').catch(() => 0n)]);
      const p = BigInt(latest) > 0n && BigInt(latest) < BigInt(spot) ? BigInt(latest) : BigInt(spot);
      if (p <= 0n) throw new Error('the pair oracle has no price');
      return lowest(p);
    }
    if (feed.kind === 'zq') {
      // one whole token sold for ETH at the best pool zQuoter finds (a larger sale moves a thin pool more, which only asks a higher fee)
      const one = 10n ** BigInt(decimals);
      const [best] = await read(feed.address, ZQ_ABI, 'getQuotes', [false, token, ETH, one], { gas: 30_000_000n });
      const out = BigInt(best?.amountOut ?? 0n);
      if (out <= 0n) throw new Error('no pool zQuoter reads sells this token for ETH');
      return lowest(perBase(out));
    }
    const [[, answer, , updatedAt], fdec] = await Promise.all([read(feed.address, FEED_ABI, 'latestRoundData'), read(feed.address, FEED_ABI, 'decimals')]);
    if (BigInt(answer) <= 0n) throw new Error('the ETH/USD feed has no answer');
    if (now() / 1000 - Number(updatedAt) > (feed.maxAgeSecs ?? FEED_STALE_SECS)) throw new Error(`the ETH/USD feed's answer is ${Math.round((now() / 1000 - Number(updatedAt)) / 60)} minutes old`);
    // a dollar is 10^fdec / answer ETH
    return perBase((E18 * 10n ** BigInt(fdec)) / BigInt(answer));
  }
  async function refresh() {
    try {
      const r = await price();
      if (r <= 0n) throw new Error('a price of zero');
      const was = cfg.rates.get(key);
      cfg.rates.set(key, r);
      at = now();
      if (was === undefined) log(`price of ${token}: ${r} wei per 1e18 (${feed.kind}${feed.address ? ` ${feed.address}` : ''})`);
      return r;
    } catch (e) {
      if (key !== ETH && cfg.rates.has(key) && now() - at > cfg.rateMaxAgeSecs * 1000) { cfg.rates.delete(key); log(`price of ${token} dropped: none read for ${cfg.rateMaxAgeSecs} s (${safeErr(e)}); fees in it are refused until one is`); }
      else log(`price of ${token} not read: ${safeErr(e)}`);
      return null;
    }
  }
  return { refresh, rate: () => cfg.rates.get(key) ?? null };
}
