// Every EVM pool keeper in one process (src/evm-pool-keeper.js is the single-chain service it is made of): one instance on Render where
// there were four, each chain with its own key, nodes, store and loop, sharing the witness model and the proving key, which are the
// bulk of a keeper's memory. Proofs are made one chain at a time (one groth16 prover in flight), so the peak is one keeper's, not four.
//
//   EVM_POOL_CHAINS=1,8453,4663,4326         the chains, in order; the first answers the unprefixed routes
//   EVM_POOL_<KNOB>_<chainId>                a chain's own value of any keeper knob (EVM_POOL_RPC_URL_8453, EVM_POOL_KEEPER_PRIV_8453,
//                                            EVM_POOL_START_BLOCK_8453 …); without one, the plain EVM_POOL_<KNOB> applies to every chain
//   EVM_POOL_KEEPER_DB_<chainId>             the chain's store (default <EVM_POOL_KEEPER_DB dir>/keeper-<chainId>.db)
//   EVM_POOL_SEED_FEED_<chainId>             another keeper's feed base (…/evm-pool/keeper) an empty store is seeded from, root-checked
//   EVM_POOL_SEED_RESET_<chainId>=1          empty a part-replayed store first (one time; unset after)
//
// HTTP, on PORT: /<chainId>/evm-pool/keeper/* and /<chainId>/health are that chain's routes, exactly as its own service served them at
// /evm-pool/keeper/* and /health; the unprefixed routes are the first chain's, so a page built for one keeper still works. GET /health
// is 200 only while every chain's last tick succeeded; GET /chains lists them.

import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { poolAsset } from '../../dapp/evm-pool-zk.js';
import { loadKeeperConfig, checkKeeperSigner } from './lib/evm-pool-keeper-config.js';
import { openKeeperStore } from './lib/evm-pool-keeper-store.js';
import { makeKeeperChain } from './lib/evm-pool-keeper-chain.js';
import { makeLeafSync, makeFactsSync } from './lib/evm-pool-keeper-leaves.js';
import { makePipeline } from './lib/evm-pool-keeper-pipeline.js';
import { makeKeeperProver, loadZk } from './lib/evm-pool-keeper-prover.js';
import { createIntakeHandler } from './lib/evm-pool-keeper-intake.js';
import { seedFromFeed } from './lib/evm-pool-keeper-seed.js';
import { createKeeper } from './lib/evm-pool-keeper-loop.js';
import { safeErr } from './lib/safe-err.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The chains named, as numbers, in order; none = the process is disabled.
export function chainsOf(env = process.env) {
  return String(env.EVM_POOL_CHAINS || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`EVM_POOL_CHAINS: bad chain id "${s}"`);
    return n;
  });
}

// One chain's view of the environment: EVM_POOL_<KNOB>_<chainId> wins over EVM_POOL_<KNOB>; EVM_POOL_CHAIN_ID is the chain itself and
// the store defaults to a file of its own beside the shared one.
export function envFor(chainId, env = process.env) {
  const suffix = `_${chainId}`;
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('EVM_POOL_') && k.endsWith(suffix)) out[k.slice(0, -suffix.length)] = v;
  }
  for (const k of Object.keys(out)) if (/^EVM_POOL_.*_\d+$/.test(k)) delete out[k];
  out.EVM_POOL_CHAIN_ID = String(chainId);
  if (!env[`EVM_POOL_KEEPER_DB${suffix}`]) {
    const base = env.EVM_POOL_KEEPER_DB || '/var/lib/tacit-evm-pool-keeper/keeper.db';
    out.EVM_POOL_KEEPER_DB = join(dirname(base), `keeper-${chainId}.db`);
  }
  return out;
}

// Routes: "/<chainId>/<rest>" names a chain; anything else is the default chain's. -> { chainId, path } or null for a chain not run.
export function routeOf(url, chains) {
  const m = /^\/(\d+)(\/.*)?$/.exec(url);
  if (m) {
    const id = Number(m[1]);
    if (!chains.includes(id)) return null;
    return { chainId: id, path: (m[2] || '/') + url.slice(m[0].length) };
  }
  return { chainId: chains[0], path: url };
}

// One prover at a time across every chain: a groth16 proof is the only thing here that takes real memory.
export function serialProver(prover) {
  let last = Promise.resolve();
  return {
    ...prover,
    prove(input) { const run = last.then(() => prover.prove(input), () => prover.prove(input)); last = run.catch(() => {}); return run; },
  };
}

async function main() {
  const chains = chainsOf();
  if (!chains.length) { console.log('[evm-pool-keepers] disabled: EVM_POOL_CHAINS is not set'); return; }
  const log = (...a) => console.log(`[evm-pool-keepers ${new Date().toISOString()}]`, ...a);
  const zk = await loadZk();
  const provers = new Map(); // one per distinct (wasm, zkey, vk), shared by the chains that use it
  const keepers = new Map();
  for (const chainId of chains) {
    const env = envFor(chainId);
    const cfg = loadKeeperConfig(env);
    const clog = (...a) => console.log(`[evm-pool-keeper ${chainId} ${new Date().toISOString()}]`, ...a);
    if (!cfg.enabled) { clog(`disabled: ${cfg.reason}`); continue; }
    if (!cfg.keeperKey) throw new Error(`EVM_POOL_KEEPER_PRIV (or _${chainId}) is not set`);
    const account = privateKeyToAccount(cfg.keeperKey.startsWith('0x') ? cfg.keeperKey : `0x${cfg.keeperKey}`);
    checkKeeperSigner(cfg, account.address);
    cfg.keeperAddress = account.address;
    const chain = await makeKeeperChain({ cfg, account, log: clog });
    if (chain.chainId !== chainId) throw new Error(`chain ${chainId}: its node is on chain ${chain.chainId}`);
    const assetField = poolAsset({ chainId: BigInt(chain.chainId), pool: chain.pool, token: chain.asset });
    const pk = [cfg.wasm, cfg.zkey, cfg.vk, cfg.vkHash, cfg.wasmSha256, cfg.zkeySha256].join('|');
    if (!provers.has(pk)) provers.set(pk, serialProver(await makeKeeperProver(cfg)));
    const prover = provers.get(pk);
    const store = openKeeperStore(cfg.dbPath);
    // An empty store (a new instance, a replaced disk) is seeded from another keeper's feed when one is named, checked against the pool's
    // root; EVM_POOL_SEED_RESET=1 empties a store part-way through a log replay first. Else, or on any failure, the log replay runs as before.
    if (env.EVM_POOL_SEED_FEED) {
      try { await seedFromFeed({ store, chain, zk, feedUrl: env.EVM_POOL_SEED_FEED, startBlock: cfg.startBlock, reset: env.EVM_POOL_SEED_RESET === '1', log: clog }); }
      catch (e) { clog(`seed from ${env.EVM_POOL_SEED_FEED} not taken: ${safeErr(e)}`); }
    }
    const leafSync = makeLeafSync({ store, chain, zk, startBlock: cfg.startBlock, confirmations: cfg.confirmations, logChunk: cfg.logChunk, log: clog });
    const pipeline = cfg.pipeline ? makePipeline({ chain, verify: prover.verify, assetField, baseTree: () => leafSync.sync(), maxDepth: cfg.pipelineDepth, log: clog }) : null;
    const keeper = createKeeper({ store, chain, prover, zk, assetField, leafSync, pipeline, cfg, log: clog });
    const assetKey = chain.asset.toLowerCase();
    if (!cfg.minFees.has(assetKey) && !cfg.rates.has(assetKey)) clog(`warning: no EVM_POOL_KEEPER_MIN_FEES or _TOKEN_RATES entry for the pool asset ${assetKey}; deposits will be skipped`);
    clog(`keeper ${account.address} on chain ${chain.chainId}: pool ${chain.pool} router ${chain.router} asset ${chain.asset} vk ${prover.vkHash.slice(0, 16)} store ${cfg.dbPath}${cfg.dryRun ? ' (dry run)' : ''}`);
    const k = { chainId, cfg, chain, store, leafSync, keeper, lastTickOk: true, log: clog };
    k.handler = createIntakeHandler({ store, chain, zk, assetField, cfg, log: clog, leafSync, pipeline, isReady: () => k.lastTickOk });
    keepers.set(chainId, k);
  }
  const running = chains.filter((c) => keepers.has(c));
  if (!running.length) { log('no chain is enabled'); return; }

  const port = Number(process.env.PORT || 10000);
  createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/health' || url === '/health/') {
      const ok = running.every((c) => keepers.get(c).lastTickOk);
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok, chains: Object.fromEntries(running.map((c) => [c, keepers.get(c).lastTickOk])) }));
    }
    if (url === '/chains' || url === '/chains/') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=60' });
      return res.end(JSON.stringify({ chains: running.map((c) => ({ chainId: c, keeper: keepers.get(c).cfg.keeperAddress, pool: keepers.get(c).cfg.pool, router: keepers.get(c).cfg.router, base: `/${c}/evm-pool/keeper` })) }));
    }
    const r = routeOf(url, running);
    if (!r) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: 'no such chain' })); }
    req.url = r.path;
    return keepers.get(r.chainId).handler(req, res);
  }).listen(port, () => log(`listening on ${port}: chains ${running.join(', ')} (unprefixed routes are chain ${running[0]}'s)`));

  for (const c of running) {
    const k = keepers.get(c);
    // The history's public facts fill in on their own loop: a backfill or a slow node never delays a relay or a proof.
    if (k.cfg.facts) {
      const facts = makeFactsSync({ store: k.store, chain: k.chain, startBlock: k.cfg.startBlock, logChunk: k.cfg.logChunk, concurrency: k.cfg.factsConcurrency });
      (async () => {
        for (;;) {
          let more = false;
          try { more = await facts.step(20_000); } catch (e) { k.log(`history facts: ${safeErr(e)}`); }
          await sleep(more ? 1000 : k.cfg.historySecs * 1000);
        }
      })();
    }
    (async () => {
      let lastHistory = 0;
      for (;;) {
        try { await k.keeper.tick(); k.lastTickOk = true; }
        catch (e) { k.lastTickOk = false; k.log(`tick failed: ${safeErr(e)}`); }
        if (Date.now() - lastHistory >= k.cfg.historySecs * 1000) {
          lastHistory = Date.now();
          try { await k.leafSync.sync(); } catch (e) { k.log(`history sync: ${safeErr(e)}`); }
        }
        await sleep(k.cfg.pollSecs * 1000);
      }
    })();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[evm-pool-keepers] failed:', safeErr(e, 500)); process.exit(1); });
}
