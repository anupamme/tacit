// Every EVM pool keeper in one process (src/evm-pool-keeper.js is the single-chain service it is made of): one instance on Render where
// there were four, each pool with its own nodes, store and loop, sharing the witness model and the proving key, which are the bulk of a
// keeper's memory. Proofs are made one pool at a time (one groth16 prover in flight), so the peak is one keeper's, not four.
//
//   EVM_POOL_CHAINS=1,8453,4663,4326,1-tac   the keepers, in order; the first answers the unprefixed routes. A chain id is that chain's
//                                            pool; a chain id and a name (1-tac) is another pool on the same chain, here the TAC pool
//   EVM_POOL_<KNOB>_<chainId>                a chain's own value of any keeper knob (EVM_POOL_RPC_URL_8453, EVM_POOL_KEEPER_PRIV_8453,
//                                            EVM_POOL_START_BLOCK_8453 …); without one, the plain EVM_POOL_<KNOB> applies to every chain
//   EVM_POOL_<KNOB>_<CHAINID>_<NAME>         a named pool's own value (EVM_POOL_ADDR_1_TAC); over its chain's, which it otherwise takes
//                                            (nodes, fees) except for what is the pool's alone: its addresses, first block, store, seed,
//                                            key and price feed. A named pool that cannot start is left out; the others run on
//   EVM_POOL_KEEPER_DB_<chainId>             the chain's store (default <EVM_POOL_KEEPER_DB dir>/keeper-<chainId>.db; keeper-1-tac.db …)
//   EVM_POOL_SEED_FEED_<chainId>             another keeper's feed base (…/evm-pool/keeper) an empty store is seeded from, root-checked
//   EVM_POOL_SEED_RESET_<chainId>=1          empty a part-replayed store first (one time; unset after)
//
// Pools on one chain may share a key: their sends go through one queue per signer (evm-pool-keeper-chain.js), so they never race for a
// nonce. A pool that holds a token is paid in it; EVM_POOL_KEEPER_RATE_FEED keeps its price in ETH current (evm-pool-keeper-rates.js).
//
// HTTP, on PORT: /<id>/evm-pool/keeper/* and /<id>/health are that keeper's routes, exactly as its own service served them at
// /evm-pool/keeper/* and /health; the unprefixed routes are the first keeper's, so a page built for one keeper still works. GET /health
// is 200 only while every keeper's last tick succeeded; GET /chains lists them.

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
import { makeRateFeed } from './lib/evm-pool-keeper-rates.js';
import { safeErr } from './lib/safe-err.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ID = /^(\d+)(?:-([a-z][a-z0-9]*))?$/;
const suffixOf = (id) => `_${id.toUpperCase().replace(/-/g, '_')}`;
// The keepers named, in order: { id, chainId, suffix } ('1' → chain 1's pool; '1-tac' → another pool on chain 1); none = disabled.
export function instancesOf(env = process.env) {
  const out = String(env.EVM_POOL_CHAINS || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = ID.exec(s), chainId = m ? Number(m[1]) : NaN;
    if (!m || !Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`EVM_POOL_CHAINS: bad chain id "${s}"`);
    return { id: s, chainId, suffix: suffixOf(s) };
  });
  if (new Set(out.map((x) => x.id)).size !== out.length) throw new Error('EVM_POOL_CHAINS: a keeper is named twice');
  return out;
}
// The chain ids alone, in order (a chain with several pools is named once per pool).
export const chainsOf = (env = process.env) => instancesOf(env).map((x) => x.chainId);

// What is a pool's alone: a named pool never takes these from its chain's knobs (it would watch the chain's pool, share its store, sign
// with the chain keeper's key unawares, or take a price feed meant for another pool).
const POOL_OWN = ['EVM_POOL_ADDR', 'EVM_POOL_ROUTER_ADDR', 'EVM_POOL_START_BLOCK', 'EVM_POOL_KEEPER_DB', 'EVM_POOL_SEED_FEED', 'EVM_POOL_SEED_RESET', 'EVM_POOL_KEEPER_PRIV', 'EVM_POOL_KEEPER_RATE_FEED'];
// One keeper's view of the environment: EVM_POOL_<KNOB>_<chainId> wins over EVM_POOL_<KNOB>, and for a named pool its own
// EVM_POOL_<KNOB>_<CHAINID>_<NAME> wins over both; a named pool has no address, first block, store or seed but its own. EVM_POOL_CHAIN_ID is
// the chain itself and the store defaults to a file of its own beside the shared one.
export function envFor(inst, env = process.env) {
  const { id, chainId, suffix } = typeof inst === 'object' ? inst : instancesOf({ EVM_POOL_CHAINS: String(inst) })[0];
  const chainSuffix = `_${chainId}`, named = suffix !== chainSuffix;
  const out = { ...env };
  if (named) for (const k of POOL_OWN) delete out[k];
  const take = (sfx, skip = []) => {
    for (const [k, v] of Object.entries(env)) {
      if (!k.startsWith('EVM_POOL_') || !k.endsWith(sfx)) continue;
      const knob = k.slice(0, -sfx.length);
      if (!skip.includes(knob)) out[knob] = v;
    }
  };
  take(chainSuffix, named ? POOL_OWN : []);
  if (named) take(suffix);
  for (const k of Object.keys(out)) if (/^EVM_POOL_.*_\d+(_[A-Z][A-Z0-9]*)?$/.test(k)) delete out[k];
  out.EVM_POOL_CHAIN_ID = String(chainId);
  if (!env[`EVM_POOL_KEEPER_DB${suffix}`]) {
    const base = env.EVM_POOL_KEEPER_DB || '/var/lib/tacit-evm-pool-keeper/keeper.db';
    out.EVM_POOL_KEEPER_DB = join(dirname(base), `keeper-${id}.db`);
  }
  return out;
}

// Routes: "/<id>/<rest>" names a keeper; anything else is the default (first) one's. -> { id, path } or null for a keeper not run.
export function routeOf(url, ids) {
  const m = /^\/(\d+(?:-[a-z][a-z0-9]*)?)(\/.*)?$/.exec(url);
  const list = ids.map(String);
  if (m) {
    if (!list.includes(m[1])) return null;
    return { id: m[1], path: (m[2] || '/') + url.slice(m[0].length) };
  }
  return { id: list[0], path: url };
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
  const insts = instancesOf();
  if (!insts.length) { console.log('[evm-pool-keepers] disabled: EVM_POOL_CHAINS is not set'); return; }
  const log = (...a) => console.log(`[evm-pool-keepers ${new Date().toISOString()}]`, ...a);
  const zk = await loadZk();
  const provers = new Map(); // one per distinct (wasm, zkey, vk), shared by the pools that use it
  const keepers = new Map();
  const pools = new Map();    // chainId:pool → id, so two keepers never watch one pool
  for (const inst of insts) {
    const named = inst.suffix !== `_${inst.chainId}`;
    const clog = (...a) => console.log(`[evm-pool-keeper ${inst.id} ${new Date().toISOString()}]`, ...a);
    try {
      const { id, chainId } = inst;
      const env = envFor(inst);
      const cfg = loadKeeperConfig(env);
      if (!cfg.enabled) { clog(`disabled: ${cfg.reason}`); continue; }
      if (!cfg.keeperKey) throw new Error(`EVM_POOL_KEEPER_PRIV${named ? inst.suffix : ` (or _${chainId})`} is not set`);
      const poolKey = `${chainId}:${cfg.pool.toLowerCase()}`;
      if (pools.has(poolKey)) throw new Error(`keeper ${id} watches pool ${cfg.pool}, which keeper ${pools.get(poolKey)} watches already`);
      pools.set(poolKey, id);
      const account = privateKeyToAccount(cfg.keeperKey.startsWith('0x') ? cfg.keeperKey : `0x${cfg.keeperKey}`);
      checkKeeperSigner(cfg, account.address);
      cfg.keeperAddress = account.address;
      const chain = await makeKeeperChain({ cfg, account, log: clog });
      if (chain.chainId !== chainId) throw new Error(`keeper ${id}: its node is on chain ${chain.chainId}, not ${chainId}`);
      // a pool that holds a token: its price in ETH, kept current from the chain, before the first fee is checked
      const ethPool = BigInt(chain.asset) === 0n;
      if (cfg.rateFeed && ethPool) clog('EVM_POOL_KEEPER_RATE_FEED ignored: this pool holds ETH, whose price is one');
      const rates = cfg.rateFeed && !ethPool ? makeRateFeed({ feed: cfg.rateFeed, token: chain.asset, read: chain.readContract, cfg, log: clog }) : null;
      if (rates) await rates.refresh();
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
      if (!cfg.minFees.has(assetKey) && !cfg.rates.has(assetKey) && !rates) clog(`warning: no EVM_POOL_KEEPER_MIN_FEES, _TOKEN_RATES or _RATE_FEED entry for the pool asset ${assetKey}; deposits will be skipped`);
      clog(`keeper ${account.address} on chain ${chain.chainId}: pool ${chain.pool} router ${chain.router} asset ${chain.asset} vk ${prover.vkHash.slice(0, 16)} store ${cfg.dbPath}${cfg.dryRun ? ' (dry run)' : ''}`);
      const k = { id, chainId, cfg, chain, store, leafSync, keeper, rates, lastTickOk: true, log: clog };
      k.handler = createIntakeHandler({ store, chain, zk, assetField, cfg, log: clog, leafSync, pipeline, isReady: () => k.lastTickOk });
      keepers.set(id, k);
    } catch (e) {
      // a chain's own pool failing stops the process as it always has; another pool on a chain is left out, and the rest run
      if (!named) throw e;
      clog(`not started: ${safeErr(e)}`);
    }
  }
  const running = insts.map((x) => x.id).filter((id) => keepers.has(id));
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
      return res.end(JSON.stringify({ chains: running.map((id) => { const k = keepers.get(id); return { id, chainId: k.chainId, keeper: k.cfg.keeperAddress, pool: k.cfg.pool, router: k.cfg.router, asset: k.chain.asset, base: `/${id}/evm-pool/keeper` }; }) }));
    }
    const r = routeOf(url, running);
    if (!r) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: 'no such chain' })); }
    req.url = r.path;
    return keepers.get(r.id).handler(req, res);
  }).listen(port, () => log(`listening on ${port}: keepers ${running.join(', ')} (unprefixed routes are ${running[0]}'s)`));

  for (const id of running) {
    const k = keepers.get(id);
    if (k.rates) setInterval(() => { k.rates.refresh().catch(() => {}); }, k.cfg.rateSecs * 1000).unref?.();
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
