#!/usr/bin/env node
// Checks each chain's native-ETH TacitEvmPool against its own history: the ETH it holds must equal what its Transact
// events say went in, less what went out and what it paid relayers; its leaves must run on without a gap and end where
// the pool says it ends; and its last event's root must be the pool's root. Read-only: public RPC and no key.
//
//   node tools/evm-pool-solvency.mjs [--chain 1,8453] [--state <file>] [--json]
//
// --state keeps the running sums and the block they run through, so the next run reads only what came after. Without
// it every run reads the whole history (Base is about 80 log calls at the node that serves 10,000-block ranges).
// Env: RPC_<chainId>=url,url overrides a chain's nodes.
//
// Exit 0: every chain read and every check passed. 1: a check failed. 2: a chain could not be read (an operator problem,
// never a passing run).
//
// A balance above the events' net is a note, not a failure: anyone can send ETH to a contract. A failure is outflows
// above inflows, a balance below the net, a gap in the leaves, or a root that is not the pool's. Nothing here proves the
// pool sound; it is the alarm that a flaw in its proof system would trip.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';

const ROOT = new URL('..', import.meta.url).pathname;
const SIG = 'Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)';
export const TOPIC = '0x' + Buffer.from(keccak_256(new TextEncoder().encode(SIG))).toString('hex');
const sel = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex').slice(0, 8);

// Nodes that served deploy-era logs when tried (2026-10-15), the widest range each took, and how far behind the head
// to read so a node a few blocks behind cannot tip a check.
const CHAINS = {
  1: { name: 'Ethereum', rpc: ['https://mainnet.gateway.tenderly.co', 'https://rpc.mevblocker.io'], chunk: 1000, margin: 12 },
  8453: { name: 'Base', rpc: ['https://base.rpc.blxrbdn.com'], chunk: 10000, margin: 30 },
  4663: { name: 'Robinhood Chain', rpc: ['https://rpc.mainnet.chain.robinhood.com'], chunk: 100000, margin: 300 },
  4326: { name: 'MegaETH', rpc: ['https://mainnet.megaeth.com/rpc'], chunk: 100000, margin: 30 },
};

// ---------------------------------------------------------------- decoding and the checks (no network)

const ZERO32 = '0x' + '0'.repeat(64);
const wordAt = (data, i) => data.slice(2 + i * 64, 66 + i * 64);

/** One Transact log → { block, index, nf0, nf1, leaf0, leaf1, first, root, ext, fee }. */
export function decodeTransact(l) {
  const d = l.data;
  return {
    block: Number(BigInt(l.blockNumber)), index: Number(BigInt(l.logIndex)),
    nf0: l.topics[1], nf1: l.topics[2],
    leaf0: '0x' + wordAt(d, 0), leaf1: '0x' + wordAt(d, 1), first: Number(BigInt('0x' + wordAt(d, 2))), root: '0x' + wordAt(d, 3),
    ext: BigInt.asIntN(256, BigInt('0x' + wordAt(d, 5))), fee: BigInt('0x' + wordAt(d, 7)),
  };
}

export const emptyState = () => ({ to: null, dep: 0n, wd: 0n, fee: 0n, next: 0, root: null, events: 0 });

/**
 * Folds `events` (in log order) into `prior` and checks the result against what the chain says at the same block:
 * `balance` (wei), `nextIndex` and `root`. → { state, rows: [{ status: 'ok'|'FAIL'|'note', name, value }] }.
 */
export function evaluate(prior, events, { balance, nextIndex, root }) {
  const s = { ...prior };
  const rows = [], row = (status, name, value) => rows.push({ status, name, value: String(value) });
  let gaps = 0, firstGap = null;
  for (const e of events) {
    if (e.ext > 0n) s.dep += e.ext; else if (e.ext < 0n) s.wd += -e.ext;
    s.fee += e.fee; s.events++;
    if (e.first !== s.next) { gaps++; firstGap ??= `event at block ${e.block} starts at leaf ${e.first}, the tree stood at ${s.next}`; }
    if (e.leaf0 !== ZERO32 || e.leaf1 !== ZERO32) { s.next = e.first + 2; s.root = e.root; }
  }
  const eth = (w) => `${w < 0n ? '-' : ''}${(Number(w < 0n ? -w : w) / 1e18).toFixed(9)} ETH`;
  const net = s.dep - s.wd - s.fee;
  row('ok', 'events', `${s.events} Transact events through block ${s.to}`);
  row('ok', 'deposits', eth(s.dep)); row('ok', 'withdrawals', eth(s.wd)); row('ok', 'relayer fees', eth(s.fee));
  if (net < 0n) row('FAIL', 'outflows', `withdrawals and fees exceed deposits by ${eth(-net)}`);
  else if (balance < net) row('FAIL', 'balance', `${eth(balance)} held, ${eth(net)} expected: ${eth(net - balance)} missing`);
  else if (balance === net) row('ok', 'balance', `${eth(balance)} held = deposits − withdrawals − fees`);
  else { row('ok', 'balance', `${eth(balance)} held, at least the ${eth(net)} the events net`); row('note', 'surplus', `${eth(balance - net)} above the events' net (ETH sent to the pool directly)`); }
  if (gaps) row('FAIL', 'leaves', `${gaps} event(s) out of order: ${firstGap}`);
  else if (BigInt(s.next) !== BigInt(nextIndex)) row('FAIL', 'leaves', `events end at leaf ${s.next}, the pool says ${nextIndex}`);
  else row('ok', 'leaves', `${s.next} leaves, contiguous, ending where nextIndex() does`);
  if (s.root === null) row('note', 'root', 'no inserting event yet');
  else if (s.root.toLowerCase() === String(root).toLowerCase()) row('ok', 'root', `last event's root is the pool's (${s.root.slice(0, 18)}…)`);
  else row('FAIL', 'root', `last event's root ${s.root.slice(0, 18)}… is not the pool's ${String(root).slice(0, 18)}…`);
  return { state: s, rows };
}

// ---------------------------------------------------------------- network

let calls = 0;
async function rpcOn(url, method, params) {
  calls++;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}
async function rpc(urls, method, params) {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const u of urls) { try { return await rpcOn(u, method, params); } catch (e) { last = e; } }
    await new Promise((r) => setTimeout(r, 700 * (round + 1)));
  }
  throw new Error(`${method} failed on every node: ${last?.message}`);
}

// Logs for [from, to], 4 ranges at a time; a range a node refuses is split, down to 50 blocks.
async function transactLogs(urls, pool, from, to, chunk) {
  const ranges = [];
  for (let a = from; a <= to; a += chunk) ranges.push([a, Math.min(to, a + chunk - 1)]);
  const out = [];
  const get = async (a, b) => {
    try { return await rpc(urls, 'eth_getLogs', [{ address: pool, topics: [TOPIC], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]); }
    catch (e) { if (b - a < 50) throw e; const m = Math.floor((a + b) / 2); return [...(await get(a, m)), ...(await get(m + 1, b))]; }
  };
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (i < ranges.length) { const [a, b] = ranges[i++]; out.push(...(await get(a, b))); } }));
  return out.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)));
}

async function checkChain(id, cfg, pool, deployBlock, prior) {
  const urls = (process.env[`RPC_${id}`]?.split(',').filter(Boolean)) || cfg.rpc;
  const head = Number(BigInt(await rpc(urls, 'eth_blockNumber', [])));
  const to = head - cfg.margin, tag = '0x' + to.toString(16);
  const from = prior.to === null ? deployBlock : prior.to + 1;
  const logs = from <= to ? await transactLogs(urls, pool, from, to, cfg.chunk) : [];
  const [balance, nextIndex, root] = await Promise.all([
    rpc(urls, 'eth_getBalance', [pool, tag]),
    rpc(urls, 'eth_call', [{ to: pool, data: sel('nextIndex()') }, tag]),
    rpc(urls, 'eth_call', [{ to: pool, data: sel('root()') }, tag]),
  ]);
  const { state, rows } = evaluate({ ...prior, to }, logs.map(decodeTransact), { balance: BigInt(balance), nextIndex: BigInt(nextIndex), root });
  return { state, rows, read: logs.length, from, to };
}

// ---------------------------------------------------------------- state file and main

const encode = (s) => ({ ...s, dep: s.dep.toString(), wd: s.wd.toString(), fee: s.fee.toString() });
const decode = (s) => ({ ...s, dep: BigInt(s.dep), wd: BigInt(s.wd), fee: BigInt(s.fee) });

async function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
  const only = arg('--chain')?.split(',').map(Number), stateFile = arg('--state'), asJson = process.argv.includes('--json');
  const dep = JSON.parse(readFileSync(ROOT + 'contracts/deployments/evm-pool.json', 'utf8'));
  const saved = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { chains: {} };
  const report = [], next = { chains: { ...saved.chains } };
  let failed = 0, unread = 0;
  for (const [sid, cfg] of Object.entries(CHAINS)) {
    const id = Number(sid);
    if (only && !only.includes(id)) continue;
    const d = dep.chains[sid];
    try {
      const prior = saved.chains[sid] ? decode(saved.chains[sid]) : emptyState();
      const r = await checkChain(id, cfg, d.pool, d.deployBlock, prior);
      next.chains[sid] = encode(r.state);
      failed += r.rows.filter((x) => x.status === 'FAIL').length;
      report.push({ chain: id, name: cfg.name, pool: d.pool, from: r.from, to: r.to, logsRead: r.read, rows: r.rows });
    } catch (e) { unread++; report.push({ chain: id, name: cfg.name, error: e.message }); }
  }
  if (stateFile && !unread && !failed) writeFileSync(stateFile, JSON.stringify(next));
  if (asJson) console.log(JSON.stringify({ calls, failed, unread, report }, null, 1));
  else {
    for (const c of report) {
      console.log(`\n${c.name} (chain ${c.chain})${c.error ? '' : ` · pool ${c.pool} · read blocks ${c.from}-${c.to}, ${c.logsRead} new events`}`);
      if (c.error) { console.log(`  UNREAD  ${c.error}`); continue; }
      for (const r of c.rows) console.log(`  ${r.status.padEnd(4)}  ${r.name.padEnd(13)} ${r.value}`);
    }
    console.log(`\n${failed ? `${failed} check(s) FAILED` : unread ? `${unread} chain(s) could not be read` : 'every check passed'} · ${calls} RPC calls`);
  }
  process.exit(failed ? 1 : unread ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`evm-pool-solvency: ${e.message}`); process.exit(2); });
}
