#!/usr/bin/env node
// Checks a paid day of the liquidity campaign (or of a virtual farm) against the chain.
//
//   node tools/lp-verify.mjs <day> [--farm <name>] [--service <url>] [--rpc <url>] [--from-block <pool>=<block> ...] [--json]
//
// The points service keeps, for every day it pays, a record of what the day rests on (GET /lp/day/<n>, with ?farm=<name> for a farm) and its
// hash. This reads it, reads the pools' state at the blocks the record names, replays each pool's Transfer logs, finds every holder's lowest
// shares of the UTC day, shares the day out by the campaign's own rule and compares all of it, and the credits to the service's ledger
// (GET /rewards). Nothing the service says is taken on trust but the record itself, and the record's hash and figures are all checked.
//
// A day long past needs an archive node for --rpc (or LP_VERIFY_RPC); a recent one does not. Add --from-block <pool>=<first block> to skip the
// search for the block a pool was created at. Exit code 0 when everything checks out, 1 when something does not, 2 when it cannot be read.
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { checkDayRecord } from '../worker-relay/src/lib/points-lp-record.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const day = Number(args.find((a, i) => /^\d+$/.test(a) && !args[i - 1]?.startsWith('--')));
if (!day) { console.error('usage: node tools/lp-verify.mjs <day> [--farm <name>] [--service <url>] [--rpc <url>] [--from-block <pool>=<block>] [--json]'); process.exit(2); }
const service = (flag('--service') || 'https://tacit-points.onrender.com').replace(/\/$/, '');
const rpc = flag('--rpc') || process.env.LP_VERIFY_RPC || 'https://ethereum-rpc.publicnode.com';
const farm = flag('--farm');
const json = args.includes('--json');
const USDC = process.env.POINTS_LP_USDC || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', FEED = process.env.POINTS_LP_ETH_USD_FEED || '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const fromBlocks = Object.fromEntries(all('--from-block').map((s) => { const [p, b] = s.split('='); return [p.toLowerCase(), Number(b)]; }));

const get = async (path) => {
  const r = await fetch(`${service}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};

let kept, rewards, result;
try {
  kept = await get(`/lp/day/${day}${farm ? `?farm=${encodeURIComponent(farm)}` : ''}`);
  rewards = await get('/rewards');
  const client = createPublicClient({ chain: mainnet, transport: http(rpc) });
  result = await checkDayRecord({ record: kept.record, sha256: kept.sha256, client, usdc: USDC, ethUsdFeed: FEED, fromBlocks, adjustments: rewards.adjustments });
} catch (e) {
  console.error(`cannot check day ${day}: ${e?.shortMessage || e?.message || e}`);
  process.exit(2);
}

if (json) console.log(JSON.stringify({ day, farm, sha256: kept.sha256, ...result }, null, 2));
else {
  const r = kept.record;
  console.log(`${farm ? `farm "${farm}"` : 'liquidity campaign'}, day ${day}  ${result.ok ? 'CHECKS OUT' : 'DOES NOT CHECK OUT'}`);
  console.log(`  hash ${kept.sha256}`);
  console.log(`  ${r.pools.length} pool(s), ${result.holders} holder(s), ${result.credits} credit(s); the day shared ${Number(BigInt(r.terms.dailyWei) / 10n ** 14n) / 1e4} TAC at most, ${Number(BigInt(r.terms.capWeiPerUsdDay) / 10n ** 14n) / 1e4} TAC per dollar`);
  for (const n of result.notes) console.log(`  note     ${n}`);
  for (const p of result.problems) console.log(`  PROBLEM  ${p}`);
}
process.exit(result.ok ? 0 : 1);
