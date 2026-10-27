// The multi-chain keeper process (src/evm-pool-keepers.js): each chain's view of the environment, the routes, and one prover at a time.
// node --test tests/evm-pool-keepers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { chainsOf, instancesOf, envFor, routeOf, serialProver, healthOf, isChainPool } from '../src/evm-pool-keepers.js';

test('the chains are read in order; a bad id refuses', () => {
  assert.deepEqual(chainsOf({ EVM_POOL_CHAINS: '1, 8453,4663,10' }), [1, 8453, 4663, 10]);
  assert.deepEqual(chainsOf({}), []);
  assert.throws(() => chainsOf({ EVM_POOL_CHAINS: '1,base' }), /bad chain id/);
});

test('another pool on a chain is a chain id and a name; each is named once', () => {
  assert.deepEqual(instancesOf({ EVM_POOL_CHAINS: '1,8453,1-tac,1-tacd' }).map((x) => [x.id, x.chainId, x.suffix]), [['1', 1, '_1'], ['8453', 8453, '_8453'], ['1-tac', 1, '_1_TAC'], ['1-tacd', 1, '_1_TACD']]);
  assert.deepEqual(chainsOf({ EVM_POOL_CHAINS: '1,1-tac' }), [1, 1]);
  for (const bad of ['1-', '1-TAC', 'tac', '1-t-a', '0-tac', '1_tac']) assert.throws(() => instancesOf({ EVM_POOL_CHAINS: bad }), /bad chain id/, bad);
  assert.throws(() => instancesOf({ EVM_POOL_CHAINS: '1,1' }), /named twice/);
});

test("a named pool takes its chain's nodes but none of the chain pool's own: its address, first block, store, seed, key and price feed are its own", () => {
  const env = {
    EVM_POOL_ADDR: '0xethpool', EVM_POOL_ROUTER_ADDR: '0xethrouter', EVM_POOL_RPC_URL_1: 'https://eth', EVM_POOL_RPC_URLS_FALLBACK_1: 'https://b', EVM_POOL_KEEPER_PRIV_1: '0x11',
    EVM_POOL_START_BLOCK_1: '100', EVM_POOL_SEED_FEED_1: 'https://feed', EVM_POOL_KEEPER_DB_1: '/x/eth.db', EVM_POOL_KEEPER_MIN_FEES_1: 'eth:5',
    EVM_POOL_ADDR_1_TAC: '0xtacpool', EVM_POOL_ROUTER_ADDR_1_TAC: '0xtacrouter', EVM_POOL_START_BLOCK_1_TAC: '200', EVM_POOL_KEEPER_RATE_FEED_1_TAC: 'tac:0x000000cE58D7d49319252DaFB0ABdB3F02101271',
    EVM_POOL_KEEPER_PRIV_1_TAC: '0x22', EVM_POOL_KEEPER_RATE_FEED: 'eth',
    EVM_POOL_KEEPER_POLL_SECS_1_TAC: '30', EVM_POOL_KEEPER_DB: '/var/lib/tacit-evm-pool-keeper/keeper.db', EVM_POOL_RPC_URL_8453: 'https://base',
  };
  const tac = envFor(instancesOf({ EVM_POOL_CHAINS: '1-tac' })[0], env), eth = envFor(1, env), bare = envFor('1-tacd', env);
  assert.equal(tac.EVM_POOL_ADDR, '0xtacpool'); assert.equal(tac.EVM_POOL_ROUTER_ADDR, '0xtacrouter'); assert.equal(tac.EVM_POOL_START_BLOCK, '200');
  assert.equal(tac.EVM_POOL_RPC_URL, 'https://eth'); assert.equal(tac.EVM_POOL_RPC_URLS_FALLBACK, 'https://b'); assert.equal(tac.EVM_POOL_KEEPER_PRIV, '0x22');
  assert.equal(tac.EVM_POOL_KEEPER_RATE_FEED, 'tac:0x000000cE58D7d49319252DaFB0ABdB3F02101271'); assert.equal(tac.EVM_POOL_KEEPER_POLL_SECS, '30');
  assert.equal(tac.EVM_POOL_SEED_FEED, undefined); assert.equal(tac.EVM_POOL_KEEPER_DB, '/var/lib/tacit-evm-pool-keeper/keeper-1-tac.db'); assert.equal(tac.EVM_POOL_CHAIN_ID, '1');
  assert.ok(!Object.keys(tac).some((k) => /^EVM_POOL_.*_\d+(_[A-Z][A-Z0-9]*)?$/.test(k)), 'no suffixed knob is left in its view');
  assert.equal(eth.EVM_POOL_ADDR, '0xethpool'); assert.equal(eth.EVM_POOL_START_BLOCK, '100'); assert.equal(eth.EVM_POOL_KEEPER_DB, '/x/eth.db');
  assert.equal(eth.EVM_POOL_KEEPER_RATE_FEED, 'eth', 'the chain pool sees a plain feed (and, holding ETH, ignores it when it starts)');
  assert.equal(eth.EVM_POOL_KEEPER_POLL_SECS, undefined, 'the chain pool takes nothing of a named pool\'s');
  assert.equal(bare.EVM_POOL_ADDR, undefined, 'a named pool with no address of its own does not fall back to the chain pool\'s'); assert.equal(bare.EVM_POOL_ROUTER_ADDR, undefined);
  assert.equal(bare.EVM_POOL_KEEPER_DB, '/var/lib/tacit-evm-pool-keeper/keeper-1-tacd.db');
  assert.equal(bare.EVM_POOL_KEEPER_PRIV, undefined, 'a named pool never signs with the chain keeper\'s key unawares');
  assert.equal(bare.EVM_POOL_KEEPER_RATE_FEED, undefined, 'nor takes a price feed not named for it');
  assert.equal(eth.EVM_POOL_KEEPER_PRIV, '0x11');
});

test("a chain's own knobs win over the shared ones, the chain id is its own, and the store is a file of its own", () => {
  const env = {
    EVM_POOL_ADDR: '0xpool', EVM_POOL_RPC_URL: 'https://eth', EVM_POOL_RPC_URL_8453: 'https://base', EVM_POOL_KEEPER_PRIV: '0x11', EVM_POOL_KEEPER_PRIV_8453: '0x22',
    EVM_POOL_START_BLOCK_8453: '100', EVM_POOL_KEEPER_DB: '/var/lib/tacit-evm-pool-keeper/keeper.db', EVM_POOL_KEEPER_DB_4663: '/x/rh.db', PORT: '10000',
  };
  const base = envFor(8453, env), eth = envFor(1, env), rh = envFor(4663, env);
  assert.equal(base.EVM_POOL_RPC_URL, 'https://base'); assert.equal(base.EVM_POOL_KEEPER_PRIV, '0x22'); assert.equal(base.EVM_POOL_START_BLOCK, '100');
  assert.equal(base.EVM_POOL_CHAIN_ID, '8453'); assert.equal(base.EVM_POOL_KEEPER_DB, '/var/lib/tacit-evm-pool-keeper/keeper-8453.db');
  assert.equal(eth.EVM_POOL_RPC_URL, 'https://eth'); assert.equal(eth.EVM_POOL_KEEPER_PRIV, '0x11'); assert.equal(eth.EVM_POOL_START_BLOCK, undefined);
  assert.equal(eth.EVM_POOL_KEEPER_DB, '/var/lib/tacit-evm-pool-keeper/keeper-1.db');
  assert.equal(rh.EVM_POOL_KEEPER_DB, '/x/rh.db');
  assert.ok(!Object.keys(base).some((k) => /^EVM_POOL_.*_\d+$/.test(k)), 'suffixed knobs are not left in a chain\'s view');
  assert.equal(base.EVM_POOL_ADDR, '0xpool'); assert.equal(base.PORT, '10000');
});

test('a chain prefix names the chain and is stripped; the unprefixed routes are the first chain\'s; an unknown chain is refused', () => {
  const chains = ['1', '8453', '1-tac'];
  assert.deepEqual(routeOf('/8453/evm-pool/keeper/quote?x=1', chains), { id: '8453', path: '/evm-pool/keeper/quote?x=1' });
  assert.deepEqual(routeOf('/8453/health', chains), { id: '8453', path: '/health' });
  assert.deepEqual(routeOf('/8453', chains), { id: '8453', path: '/' });
  assert.deepEqual(routeOf('/evm-pool/keeper/head', chains), { id: '1', path: '/evm-pool/keeper/head' });
  assert.equal(routeOf('/4663/evm-pool/keeper/head', chains), null);
  assert.deepEqual(routeOf('/1-tac/evm-pool/keeper/quote?gas=5', chains), { id: '1-tac', path: '/evm-pool/keeper/quote?gas=5' });
  assert.equal(routeOf('/1-tacd/evm-pool/keeper/head', chains), null);
  assert.deepEqual(routeOf('/evm-pool/keeper/head', [8453, 1]), { id: '8453', path: '/evm-pool/keeper/head' }, 'numbers still name chains');
});

test('proofs are made one at a time across chains, in the order asked, and a failure does not block the next', async () => {
  let inFlight = 0, overlap = false; const order = [];
  const prover = { vkHash: 'vk', verify: () => true, prove: async (x) => { inFlight++; if (inFlight > 1) overlap = true; await new Promise((r) => setTimeout(r, 5)); inFlight--; order.push(x); if (x === 'bad') throw new Error('no'); return x; } };
  const s = serialProver(prover);
  const results = await Promise.allSettled([s.prove('a'), s.prove('bad'), s.prove('c')]);
  assert.equal(overlap, false); assert.deepEqual(order, ['a', 'bad', 'c']);
  assert.equal(results[1].status, 'rejected'); assert.equal(results[2].value, 'c');
  assert.equal(s.vkHash, 'vk'); assert.equal(s.verify(), true);
});

test('a proof with a priority goes ahead of a line of others by a head start, and one that has waited longer is first', async () => {
  let t = 0; const order = []; let release;
  const gate = new Promise((r) => { release = r; });
  const prover = { prove: async (x) => { if (x === 'first') await gate; order.push(x); return x; } };
  const s = serialProver(prover, { now: () => t, headStartMs: 60_000 });
  const first = s.prove('first');                                         // being made
  const all = [s.prove('base1'), s.prove('base2'), s.prove('eth1', { priority: 1 }), s.prove('base3'), s.prove('eth2', { priority: 1 })];
  release();
  await Promise.all([first, ...all]);
  assert.deepEqual(order, ['first', 'eth1', 'eth2', 'base1', 'base2', 'base3'], 'ahead of the line, each group in its order');
  // aging: a priority-0 proof that has waited over the head start is ahead of a priority-1 one asked just now
  order.length = 0; t = 0;
  let free; const gate2 = new Promise((r) => { free = r; });
  const prover2 = { prove: async (x) => { if (x === 'busy') await gate2; order.push(x); return x; } };
  const s2 = serialProver(prover2, { now: () => t, headStartMs: 60_000 });
  const busy = s2.prove('busy');
  const old = s2.prove('old');                                           // asked at t = 0
  t = 90_000;                                                            // 90 s later
  const fresh = s2.prove('fresh', { priority: 1 });
  free();
  await Promise.all([busy, old, fresh]);
  assert.deepEqual(order, ['busy', 'old', 'fresh'], 'a proof is never starved by a stream of priority ones');
});

// ── catch-up points: the ETH pool's to its registry, every other pool's to the hub ──
const { pointPosterFor, historyStep } = await import('../src/evm-pool-keepers.js');
const { loadKeeperConfig, CHECKPOINTS, CHECKPOINT_HUB } = await import('../src/lib/evm-pool-keeper-config.js');
const ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', TAC_POOL = '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe';
const ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const edge = (size) => ({ confirmed: { tree: { size, toJSON: () => ({ filled: Array.from({ length: 32 }, (_, i) => String(size * 100 + i)) }) }, block: 1000 + size } });
// A keeper's chain as the poster sees it: the registry keeps the ETH pool's points, the hub has code, nothing posted anywhere yet.
const pointChain = (pool, address, chainId = 1) => {
  const sent = [];
  return {
    sent, pool, address, chainId,
    hasCode: async () => true, pointPool: async () => ETH_POOL, pointLatest: async () => 0, pointPostedAt: async () => 0, hubLatest: async () => 0, hubPostedAt: async () => 0,
    canFront: async () => ({ ok: true, balance: 10n ** 18n, need: 10n ** 15n }),
    send: async (fn, args, opts) => { sent.push({ fn, args, opts }); return `0x${fn === 'hub.post' ? 'b' : 'a'}${sent.length}`; },
  };
};
const pointsCfg = (env = {}) => loadKeeperConfig({ EVM_POOL_ADDR: ETH_POOL, EVM_POOL_ROUTER_ADDR: ROUTER, EVM_POOL_RPC_URL: 'https://eth', ...env });

test("the hub is on by default; a chain's or a pool's own EVM_POOL_KEEPER_POINTS_HUB turns it off there, and EVM_POOL_KEEPER_POINTS=0 stops every post", () => {
  const env = { EVM_POOL_ADDR: ETH_POOL, EVM_POOL_ROUTER_ADDR: ROUTER, EVM_POOL_RPC_URL: 'https://eth', EVM_POOL_ADDR_1_TAC: TAC_POOL, EVM_POOL_ROUTER_ADDR_1_TAC: ROUTER, EVM_POOL_KEEPER_POINTS_HUB_8453: '0' };
  const eth = loadKeeperConfig(envFor(1, env)), base = loadKeeperConfig(envFor(8453, env)), tac = loadKeeperConfig(envFor('1-tac', env));
  assert.equal(eth.pointsAddress, CHECKPOINTS); assert.equal(eth.pointsHub, CHECKPOINT_HUB);
  assert.equal(CHECKPOINT_HUB, '0x00000000C824B4F120C03f4Bdd4Bf4656232E835');
  assert.equal(base.pointsHub, null, 'off on Base alone'); assert.equal(base.pointsAddress, CHECKPOINTS, 'the registry stays on there');
  assert.equal(tac.pointsHub, CHECKPOINT_HUB, "a named pool takes its chain's hub");
  assert.equal(loadKeeperConfig(envFor('1-tac', { ...env, EVM_POOL_KEEPER_POINTS_HUB_1_TAC: '0' })).pointsHub, null, 'and its own knob wins');
  const none = pointsCfg({ EVM_POOL_KEEPER_POINTS: '0' });
  assert.equal(none.pointsAddress, null); assert.equal(none.pointsHub, null);
  assert.equal(pointsCfg({ EVM_POOL_KEEPER_POINTS_HUB: '0x00000000000000000000000000000000000000b0' }).pointsHub, '0x00000000000000000000000000000000000000B0');
});

test("the keepers sharing a key on a chain each post their own points, the ETH pool's to the registry and the TAC pool's to the hub, one at a time", async () => {
  let clock = 1_800_000_000_000;
  const key = '0x00000000000000000000000000000000000000c1', cfg = pointsCfg(), logs = [];
  const eth = { chain: pointChain(ETH_POOL, key), leafSync: { sync: async () => edge(400) }, log: (m) => logs.push(m) };
  const tac = { chain: pointChain(TAC_POOL, key), leafSync: { sync: async () => edge(600) }, log: (m) => logs.push(m) };
  for (const k of [eth, tac]) k.poster = pointPosterFor({ chain: k.chain, cfg, log: k.log, now: () => clock });
  assert.equal(await historyStep(eth), '0xa1');
  assert.deepEqual([eth.chain.sent[0].fn, eth.chain.sent[0].args[0]], ['checkpoints.post', 400n]);
  assert.equal(await historyStep(tac), null, 'the TAC pool waits for the key');
  clock += 5 * 60_000 + 1;
  assert.equal(await historyStep(tac), '0xb1');
  assert.deepEqual([tac.chain.sent[0].fn, tac.chain.sent[0].args[0], tac.chain.sent[0].args[1], tac.chain.sent[0].args[2], tac.chain.sent[0].opts.gas], ['hub.post', TAC_POOL, 600n, 1600n, 2500000n]);
  assert.equal(eth.poster.target(), 'registry'); assert.equal(tac.poster.target(), 'hub');
  // a pool on another chain, with the same key, does not wait for chain 1's
  const other = { chain: pointChain(TAC_POOL, key, 8453), leafSync: { sync: async () => edge(800) }, log: () => {} };
  other.poster = pointPosterFor({ chain: other.chain, cfg, log: other.log, now: () => clock });
  assert.equal(await historyStep(other), '0xb1');
});

test('a pool served on a day\'s allowance of gas posts no points; a failed sync or read is logged and the loop goes on', async () => {
  const cfg = pointsCfg();
  assert.equal(pointPosterFor({ chain: pointChain(TAC_POOL, '0x00000000000000000000000000000000000000c2'), cfg, budgeted: true }), null);
  const logs = [], k = { chain: pointChain(TAC_POOL, '0x00000000000000000000000000000000000000c3'), leafSync: { sync: async () => { throw new Error('node down'); } }, log: (m) => logs.push(m) };
  k.poster = pointPosterFor({ chain: k.chain, cfg, log: k.log });
  assert.equal(await historyStep(k), null); assert.match(logs.join(), /history sync: node down/); assert.equal(k.chain.sent.length, 0);
  k.leafSync.sync = async () => edge(400); k.chain.hubLatest = async () => { throw new Error('hub read failed'); };
  assert.equal(await historyStep(k), null); assert.match(logs.join(), /catch-up point: hub read failed/);
  assert.equal(await historyStep({ leafSync: { sync: async () => edge(400) }, poster: null, log: () => {} }), null, 'a keeper with no poster only syncs');
});

test('health fails (and Render restarts every chain) only for a hang, not for a tick that failed; a token pool never decides it', () => {
  const k = (lastTickAt, lastTickOk = true) => ({ lastTickAt, lastTickOk });
  const T = 1_000_000, stuckMs = 600_000;
  const keepers = new Map([['1', k(T - 20_000)], ['8453', k(T - 5_000)], ['1-tac', k(T - 9_000_000)], ['1-xa0b86991c6', k(T - 9_000_000, false)]]);
  const running = ['1', '8453', '1-tac', '1-xa0b86991c6'];
  assert.ok(isChainPool('1') && isChainPool('8453') && !isChainPool('1-tac'));
  let h = healthOf({ running, keepers, at: T, stuckMs });
  assert.equal(h.ok, true, 'a token pool whose loop is long silent does not fail the service');
  assert.equal(h.ready, true);
  keepers.get('8453').lastTickOk = false;                         // Base's last tick failed (a node's bad minute)
  h = healthOf({ running, keepers, at: T, stuckMs });
  assert.equal(h.ok, true, 'a failed tick is not a reason to restart every chain');
  assert.equal(h.ready, false, 'but it shows, for whoever watches');
  assert.equal(h.chains['8453'], false);
  keepers.get('8453').lastTickAt = T - 700_000;                    // and no tick has finished for over ten minutes: a hang
  h = healthOf({ running, keepers, at: T, stuckMs });
  assert.equal(h.ok, false, 'a loop that has finished no tick in ten minutes is stuck');
  assert.deepEqual(h.stuck, ['8453']);
  keepers.get('8453').leafSync = { progressAt: T - 30_000 };       // but a history replay that stored a chunk 30 s ago is progress
  h = healthOf({ running, keepers, at: T, stuckMs });
  assert.equal(h.ok, true, 'a long replay of a pool\'s history is not a hang');
  keepers.get('8453').leafSync = { progressAt: T - 700_000 };
  assert.equal(healthOf({ running, keepers, at: T, stuckMs }).ok, false, 'one that has stored nothing for ten minutes is');
});
