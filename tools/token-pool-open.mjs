#!/usr/bin/env node
// The transactions that open the token pools the relay serves (dapp/evm-pool-tokens.js SERVED), for any wallet to send: each the page's one
// transaction (Multicall3 calling CreateX for the pool and its router, or the router alone), for the pools not open yet. Anyone may send
// them; the contracts are the same whoever does. Writes one JSON file per pool ({ to, data, value, gas }) and prints a `cast send` for each.
//
//   node tools/token-pool-open.mjs [token …] [--rpc <url>] [--out <dir>]      (no token: every served pool)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeTokenPools, poolState, SERVED } from '../dapp/evm-pool-tokens.js';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const RPC = flag('--rpc', 'https://mainnet.gateway.tenderly.co'), OUT = flag('--out', 'token-pool-open');
const tp = makeTokenPools({ code: JSON.parse(readFileSync(new URL('../dapp/evm-pool/token-pool-code.json', import.meta.url), 'utf8')), keccak256: keccak_256 });
const ethCall = async (to, data) => {
  const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) })).json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const tokens = args.length ? args : Object.keys(SERVED);
mkdirSync(OUT, { recursive: true });
for (const t of tokens) {
  const p = tp.poolOf(t), sym = SERVED[t.toLowerCase()]?.sym || p.token, have = await poolState(tp, t, ethCall), tx = tp.openTx(t, have);
  if (!tx) { console.log(`${sym}: open already (pool ${p.pool}, router ${p.router})`); continue; }
  const file = join(OUT, `${sym}.json`);
  writeFileSync(file, JSON.stringify({ to: tx.to, data: tx.data, value: '0', gas: String(tx.gas) }) + '\n');
  console.log(`${sym}: ${have.pool ? 'its router' : 'pool and router'} → pool ${p.pool}, router ${p.router}\n  ${file}\n  cast send ${tx.to} $(jq -r .data ${file}) --gas-limit ${tx.gas} --rpc-url <rpc> --private-key <key>`);
}
