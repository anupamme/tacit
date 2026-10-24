// A day of the liquidity campaign, kept and checked.
//
// When the service pays a day (lib/points-lp-service.js) it keeps a record of everything the payment rests on, with the record's hash:
//   the terms (what the day shared, the cap, the minimums), the addresses never paid, and for each pool
//     - its opener, and the point its transfers were replayed to and checked against the chain (a block, its time, the supply there);
//     - each hourly reading of its value per share, at a block: the block and its time, the pool's reserves, supply and price there and the
//       price feed's round, with the value per share they make; and the median of those, which is the day's value per share;
//   each holder's lowest number of shares at any moment of the UTC day, and what that was worth;
//   and the credits, one for each address, with the ledger id each was given.
// Nothing in it is a promise: every figure can be read again from the chain.
//
// checkDayRecord does that. It needs only a node with the history (an archive node for an old day), the record, and the pool's first block
// (found by search when it is not given): it reads the pool's readings again at their blocks, replays the pool's Transfer logs to the same
// point and checks the replay against the supply there, finds each address's lowest balance of the day, values it, shares the day out with
// the same rule (allocateLpDay) and compares every figure to the record's. A record that does not match its hash, a reading that is not what the
// chain says, a holder that was left out or added, or a credit that is not what the rule gives, is a problem; a reading made before readings
// were pinned to blocks is a note (it cannot be checked, and the day's median still counts it).
import { createHash } from 'node:crypto';
import { parseAbi, parseAbiItem } from 'viem';
import { WAD, dayMinimums, medianOf, allocateLpDay, poolValueUsd, classifyPool, dayId, farmPrefix, CREDIT_PREFIX } from './points-lp.js';

export const RECORD_VERSION = 1;
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const HOUR = 3600, DAY = 86400, FEED_MAX_AGE = 3 * HOUR, HOUR_SLACK = 600;
const POOL_ABI = parseAbi([
  'function token0() view returns (address)', 'function token1() view returns (address)', 'function reserve0() view returns (uint128)', 'function reserve1() view returns (uint128)',
  'function totalSupply() view returns (uint256)', 'function sqrtPriceCurrent() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
]);
const FEED_ABI = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const lower = (a) => String(a).toLowerCase();

// The record in one fixed form: keys in order, big numbers as decimal strings, no spaces. The hash is of this, so the same record has the
// same hash wherever it is written.
export function canonical(v) {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
export const hashRecord = (record) => createHash('sha256').update(canonical(record)).digest('hex');

// The transfers of `pool` from block `from` to `to`, in the order they happened, in stretches the node will give (halved when it refuses one).
async function transfersOf(client, pool, from, to, chunk) {
  const out = [];
  let size = chunk, at = from;
  while (at <= to) {
    const upto = Math.min(at + size - 1, to);
    let logs;
    try { logs = await client.getLogs({ address: pool, event: TRANSFER, fromBlock: BigInt(at), toBlock: BigInt(upto) }); } catch (err) {
      if (size > 50) { size = Math.max(50, Math.floor(size / 2)); continue; }
      throw err;
    }
    for (const l of logs) if (l.args.value !== 0n) out.push({ block: Number(l.blockNumber), idx: l.logIndex, from: lower(l.args.from), to: lower(l.args.to), value: l.args.value });
    at = upto + 1;
  }
  const seen = new Set();
  return out.sort((a, b) => a.block - b.block || a.idx - b.idx).filter((e) => { const k = `${e.block}:${e.idx}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// The first block at which `pool` has code, by search between block 1 and `last` (which must have it).
async function firstBlockWithCode(client, pool, last) {
  let lo = 1, hi = last;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await client.getCode({ address: pool, blockNumber: BigInt(mid) });
    if (code && code !== '0x') hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Checks a day's record against the chain. Returns { ok, problems, notes }.
//   client: a viem public client (an archive node for a day long gone); usdc and ethUsdFeed as the service was configured;
//   fromBlocks: { <pool>: first block } when known (otherwise found by search); adjustments: the ledger's [{ id, address, wei }] to compare
//   the credits to, or null; sha256: the hash the service kept with the record, or null.
export async function checkDayRecord({ record, sha256 = null, client, usdc, ethUsdFeed, fromBlocks = {}, adjustments = null, chunk = 2000 }) {
  const problems = [], notes = [];
  const bad = (m) => problems.push(m);
  if (!record || record.v !== RECORD_VERSION) return { ok: false, problems: [`the record is of version ${record?.v}, not ${RECORD_VERSION}`], notes };
  if (sha256 && hashRecord(record) !== sha256) bad('the record does not match its hash');
  const day = record.day, start = day * DAY, end = start + DAY, minSamples = record.minSamples;
  const exclude = new Set((record.exclude ?? []).map(lower));
  const rows = [], times = new Map();
  // What the chain cannot say: the campaign's own terms (the day's amount, the cap, the weights, the minimums, who is never paid) are the
  // operator's published schedule. The record states them and the check holds the service to applying them; this lists the addresses it left out.
  const named = [...exclude].filter((a) => a !== ZERO && a !== DEAD && !record.pools.some((p) => lower(p.pool) === a));
  if (named.length) notes.push(`never paid, by the campaign's configuration: ${named.join(', ')}`);
  const read = (address, functionName, blockNumber) => client.readContract({ address, abi: POOL_ABI, functionName, ...(functionName === 'balanceOf' ? { args: [ZERO] } : {}), ...(blockNumber == null ? {} : { blockNumber }) });
  const timeOf = async (n) => { if (!times.has(n)) times.set(n, Number((await client.getBlock({ blockNumber: BigInt(n) })).timestamp)); return times.get(n); };
  const eq = (what, a, b) => { if (String(a) !== String(b)) bad(`${what}: the record has ${a}, the chain gives ${b}`); };

  for (const rp of record.pools) {
    const p = lower(rp.pool);
    if (rp.status !== 'ok') { notes.push(`${p}: ${rp.status}; its liquidity was not counted that day`); continue; }
    if (!rp.cursor) { bad(`${p}: the record has no replay point`); continue; }
    const [t0, t1] = await Promise.all([read(p, 'token0'), read(p, 'token1')]);
    const meta = classifyPool(t0, t1, usdc);
    if (!meta) { bad(`${p}: not a pool against ETH or USDC`); continue; }
    if (rp.quote && (rp.quote !== meta.quote || rp.synthIs1 !== meta.synthIs1 || rp.quoteDec !== meta.quoteDec)) bad(`${p}: the record's tokens are not the pool's`);

    // The readings, each again at its block.
    const vpsList = [], hours = new Set();
    let unpinned = 0;
    for (const s of rp.samples ?? []) {
      if (hours.has(s.hour)) bad(`${p}: two readings for hour ${s.hour}`);
      hours.add(s.hour);
      vpsList.push(BigInt(s.vps));
      if (s.block == null) { unpinned++; continue; }
      if (s.blockTs < start + s.hour * HOUR - HOUR_SLACK || s.blockTs >= start + (s.hour + 1) * HOUR) bad(`${p}: the reading of hour ${s.hour} was taken at ${s.blockTs}, outside that hour`);
      const at = BigInt(s.block);
      eq(`${p} block ${s.block} time`, s.blockTs, await timeOf(s.block));
      const [r0, r1, supply, sqrtNow] = await Promise.all(['reserve0', 'reserve1', 'totalSupply', 'sqrtPriceCurrent'].map((fn) => read(p, fn, at)));
      let quoteUsdWei = WAD;
      if (meta.quote === 'ETH') {
        const f = await client.readContract({ address: ethUsdFeed, abi: FEED_ABI, functionName: 'latestRoundData', blockNumber: at });
        if (!(f[1] > 0n) || s.blockTs - Number(f[3]) > FEED_MAX_AGE) bad(`${p}: the price feed was stale at block ${s.block}`);
        eq(`${p} block ${s.block} feed round`, s.feedRound, f[0]);
        quoteUsdWei = f[1] * 10n ** 10n;
      }
      eq(`${p} block ${s.block} quote price`, s.quoteUsdWei, quoteUsdWei);
      eq(`${p} block ${s.block} reserve0`, s.r0, r0); eq(`${p} block ${s.block} reserve1`, s.r1, r1); eq(`${p} block ${s.block} price`, s.sqrt, sqrtNow); eq(`${p} block ${s.block} supply`, s.supply, supply);
      const value = supply > 0n ? poolValueUsd({ reserveSynth: meta.synthIs1 ? r1 : r0, reserveQuote: meta.synthIs1 ? r0 : r1, quoteDec: meta.quoteDec, sqrtNow, synthIs1: meta.synthIs1, quoteUsdWei, ...(rp.spot ? { pegQuoteWei: null } : {}) }) : null;
      if (value === null) bad(`${p}: the reading of hour ${s.hour} cannot be valued from the chain`); else eq(`${p} block ${s.block} value per share`, s.vps, (value * WAD) / supply);
    }
    if (vpsList.length < minSamples) bad(`${p}: ${vpsList.length} readings, fewer than the ${minSamples} a day needs`);
    const vps = medianOf(vpsList);
    eq(`${p} median value per share`, rp.vps, vps);
    if (unpinned) notes.push(`${p}: ${unpinned} reading(s) predate pinning to blocks and cannot be checked`);

    // The holders, from the pool's own transfers, replayed to the point the service checked them at.
    const upto = rp.cursor.block;
    const first = fromBlocks[p] ?? await firstBlockWithCode(client, p, upto);
    const events = await transfersOf(client, p, first, upto, chunk);
    let replay = 0n;
    for (const e of events) { if (e.from === ZERO) replay += e.value; if (e.to === ZERO) replay -= e.value; }
    const code = await client.getCode({ address: p, blockNumber: BigInt(upto) });
    const agrees = !code || code === '0x' ? replay === 0n : (await read(p, 'totalSupply', BigInt(upto))) === replay + (await read(p, 'balanceOf', BigInt(upto)));
    if (!agrees) bad(`${p}: its transfers from block ${first} do not add up to its supply at block ${upto}`);
    eq(`${p} supply at the replay point`, rp.cursor.supply, replay);
    for (const b of new Set(events.map((e) => e.block))) await timeOf(b);
    const opener = events.find((e) => e.from === ZERO && e.to !== DEAD && e.to !== ZERO)?.to ?? null;
    eq(`${p} opener`, rp.opener, opener);

    const shares = dayMinimums(events.map((e) => ({ ts: times.get(e.block), from: e.from, to: e.to, value: e.value })), start, end);
    const have = new Map(record.holders.filter((h) => lower(h.pool) === p).map((h) => [lower(h.address), h]));
    const weightBps = BigInt(rp.weightBps);
    for (const [address, s] of shares) {
      const valueUsdWei = (s * vps) / WAD;
      if (exclude.has(address) || valueUsdWei < WAD) continue;
      const h = have.get(address);
      if (!h) { bad(`${p}: ${address} held ${s} shares all day and is not in the record`); continue; }
      eq(`${p} ${address} lowest shares`, h.minShares, s); eq(`${p} ${address} value`, h.valueUsdWei, valueUsdWei);
      rows.push({ address, pool: p, valueUsdWei, weightBps });
      have.delete(address);
    }
    for (const address of have.keys()) bad(`${p}: ${address} is in the record and did not hold that much all day`);
  }

  // The day's sharing out, by the same rule.
  const prefix = record.campaign ? farmPrefix(record.campaign) : CREDIT_PREFIX;
  const want = allocateLpDay({ rows, dailyWei: BigInt(record.terms.dailyWei), capWeiPerUsdDay: BigInt(record.terms.capWeiPerUsdDay) }).filter((c) => c.wei > 0n)
    .map((c) => ({ id: dayId(day, c.address, prefix), address: c.address, wei: String(c.wei) }));
  if (canonical(want) !== canonical(record.credits)) bad(`the credits are not what the rule gives: the record has ${record.credits.length}, the chain gives ${want.length}${want.length === record.credits.length ? ' (their amounts or addresses differ)' : ''}`);
  if (adjustments) {
    const ledger = new Map(adjustments.map((a) => [a.id, a]));
    for (const c of record.credits) {
      const a = ledger.get(c.id);
      if (!a) bad(`${c.id} is not in the ledger`);
      else if (String(a.wei) !== c.wei || lower(a.address) !== lower(c.address)) bad(`${c.id}: the ledger has ${a.wei} to ${a.address}, the record ${c.wei} to ${c.address}`);
    }
  }
  return { ok: problems.length === 0, problems, notes, credits: record.credits.length, holders: record.holders.length };
}
