#!/usr/bin/env node
// Checks a paid day of the liquidity campaign (or of a virtual farm) against the chain.
//
//   node tools/lp-verify.mjs <day> [--farm <name>] [--service <url>] [--rpc <url>] [--from-block <pool>=<block> ...]
//                                  [--allow-unpinned] [--reference] [--json]
//
// The points service keeps, for every day it pays, a record of what the day rests on (GET /lp/day/<n>, with ?farm=<name> for a farm) and its
// hash. This reads it, reads the pools' state at the blocks the record names, replays each pool's Transfer logs, finds every holder's lowest
// shares of the UTC day, shares the day out by the campaign's own rule and compares all of it, and the credits to the service's ledger
// (GET /rewards) both ways. Nothing the service says is taken on trust but the campaign's own terms (which it also compares to what it
// publishes now): see lib/points-lp-record.js for what is and is not shown.
//
//   --reference         also read each hour's first block yourself and compare the day's median (an archive node; catches readings picked
//                       to suit, which no check of the record alone can)
//   --allow-unpinned    accept readings made before they were pinned to blocks (only the day of the upgrade has them)
//   --from-block        the block a pool was created at, to skip the search for it
//
// A day long past needs an archive node for --rpc (or LP_VERIFY_RPC); a recent one does not. Exit code 0 when everything checks out, 1 when
// something does not, 2 when it cannot be read.
import { createRequire } from 'node:module';
import { verifyServiceDay } from '../worker-relay/src/lib/points-lp-record.js';

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { createPublicClient, http } = require('viem');
const { mainnet } = require('viem/chains');

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--farm', '--service', '--rpc', '--from-block']);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
const day = positional.length === 1 && /^\d+$/.test(positional[0]) ? Number(positional[0]) : null;
if (!day) { console.error('usage: node tools/lp-verify.mjs <day> [--farm <name>] [--service <url>] [--rpc <url>] [--from-block <pool>=<block>] [--allow-unpinned] [--reference] [--json]'); process.exit(2); }
const service = (flag('--service') || 'https://tacit-points.onrender.com').replace(/\/$/, '');
const rpc = flag('--rpc') || process.env.LP_VERIFY_RPC || 'https://ethereum-rpc.publicnode.com';
const farm = flag('--farm');
const json = args.includes('--json');
const USDC = process.env.POINTS_LP_USDC || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', FEED = process.env.POINTS_LP_ETH_USD_FEED || '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const fromBlocks = Object.fromEntries(all('--from-block').map((s) => { const [p, b] = String(s).split('='); return [p.toLowerCase(), Number(b)]; }));

const get = async (path) => {
  const r = await fetch(`${service}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};

let result;
try {
  const client = createPublicClient({ chain: mainnet, transport: http(rpc) });
  result = await verifyServiceDay({ get, day, farm, client, usdc: USDC, ethUsdFeed: FEED, fromBlocks, allowUnpinned: args.includes('--allow-unpinned'), reference: args.includes('--reference') });
} catch (e) {
  console.error(`cannot check day ${day}: ${e?.shortMessage || e?.message || e}`);
  process.exit(2);
}

if (json) console.log(JSON.stringify({ day, farm, sha256: result.sha256, ok: result.ok, problems: result.problems, notes: result.notes }, null, 2));
else {
  console.log(`${farm ? `farm "${farm}"` : 'liquidity campaign'}, day ${day}  ${result.ok ? 'CHECKS OUT' : 'DOES NOT CHECK OUT'}`);
  if (result.sha256) console.log(`  hash ${result.sha256}`);
  const r = result.record;
  if (r?.terms) console.log(`  ${r.pools.length} pool(s), ${result.holders ?? 0} holder(s), ${result.credits ?? 0} credit(s); the day shared ${Number(BigInt(r.terms.dailyWei) / 10n ** 14n) / 1e4} TAC at most, ${Number(BigInt(r.terms.capWeiPerUsdDay) / 10n ** 14n) / 1e4} TAC per dollar`);
  for (const n of result.notes) console.log(`  note     ${n}`);
  for (const p of result.problems) console.log(`  PROBLEM  ${p}`);
}
process.exit(result.ok ? 0 : 1);
