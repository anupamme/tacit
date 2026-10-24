// The token pools anyone opens with dapp/evm-pool-tokens.js (a private pool for one ERC-20 and its router, through CreateX), for the tokens
// the relay serves (`tokens`): found from CreateX's ContractCreation logs under those tokens' pool salts (the salt is an indexed topic, so the
// node filters them), kept only where the contract made is the pool the salts give the token, which makes its init code the live pool's; it is
// ready to serve once its router is on chain too (it answers POOL() with the pool). A contract under any other salt is never looked at.
// What is found is kept in a small file beside the keepers' stores, so a restart reads on from where it was; a change of `tokens` reads the
// logs again from `fromBlock`, for the tokens added.
//
// rpc(method, params) → the node's result.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { CREATEX, CREATED_TOPIC, SEL } from '../../../dapp/evm-pool-tokens.js';

const strip = (h) => String(h || '').replace(/^0x/, '').toLowerCase();
const hex = (n) => '0x' + BigInt(n).toString(16);

export function makeTokenPoolDiscovery({ tp, tokens, rpc, fromBlock, statePath = null, chunk = 2000n, confirmations = 3n, log = () => {} }) {
  // each token's pool as CreateX logs its creation: the guarded salt (topic 2) → the token
  const byGuard = new Map();
  for (const t of tokens) { const p = tp.poolOf(t); if (!p.fixed) byGuard.set(strip(p.poolGuard), p.token.toLowerCase()); }
  const guards = [...byGuard.keys()].sort().map((g) => '0x' + g), list = [...byGuard.values()].sort().join(',');
  const start = String(BigInt(fromBlock) - 1n);
  let state = { cursor: start, tokens: list, pools: {}, pending: {} };
  if (statePath) { try { state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) }; } catch { /* first run: from fromBlock */ } }
  if (state.tokens !== list) { log(`token pools: the tokens changed, reading from block ${fromBlock} again`); state.cursor = start; state.tokens = list; }
  const save = () => { if (!statePath) return; writeFileSync(`${statePath}.tmp`, JSON.stringify(state)); renameSync(`${statePath}.tmp`, statePath); };
  const call = async (to, data) => { try { return strip(await rpc('eth_call', [{ to, data }, 'latest'])); } catch { return ''; } };

  // → the pools that became ready (pool and router both on chain) since the last scan: [{ token, pool, router, block }]
  async function scan() {
    if (!guards.length) return [];
    const head = BigInt(await rpc('eth_blockNumber', [])) - BigInt(confirmations);
    for (let from = BigInt(state.cursor) + 1n; from <= head;) {
      const to = from + BigInt(chunk) - 1n < head ? from + BigInt(chunk) - 1n : head;
      const logs = await rpc('eth_getLogs', [{ address: CREATEX, topics: [CREATED_TOPIC, null, guards], fromBlock: hex(from), toBlock: hex(to) }]);
      for (const l of logs || []) {
        const t = byGuard.get(strip(l.topics?.[2])), made = strip(l.topics?.[1]).slice(24);
        if (!t || state.pools[t] || state.pending[t] || made !== strip(tp.poolOf(t).pool)) continue;
        state.pending[t] = { block: Number(BigInt(l.blockNumber)) };
        log(`token pool for ${t} found at 0x${made} (block ${state.pending[t].block})`);
      }
      state.cursor = String(to);
      save();
      from = to + 1n;
    }
    const ready = [];
    for (const [t, v] of Object.entries(state.pending)) {
      const p = tp.poolOf(t);
      if ((await call(p.router, SEL.pool)) !== strip(p.pool).padStart(64, '0')) continue;
      state.pools[t] = { token: p.token, pool: p.pool, router: p.router, block: v.block };
      delete state.pending[t];
      ready.push(state.pools[t]);
    }
    if (ready.length) save();
    return ready;
  }
  // only the tokens served now (a token taken off the list stays in the file, and is served again if it comes back)
  const now = (t) => [...byGuard.values()].includes(t);
  return { scan, known: () => Object.entries(state.pools).filter(([t]) => now(t)).map(([, p]) => p), pending: () => Object.keys(state.pending).filter(now) };
}
