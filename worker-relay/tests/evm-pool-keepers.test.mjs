// The multi-chain keeper process (src/evm-pool-keepers.js): each chain's view of the environment, the routes, and one prover at a time.
// node --test tests/evm-pool-keepers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { chainsOf, instancesOf, envFor, routeOf, serialProver } from '../src/evm-pool-keepers.js';

test('the chains are read in order; a bad id refuses', () => {
  assert.deepEqual(chainsOf({ EVM_POOL_CHAINS: '1, 8453,4663,4326' }), [1, 8453, 4663, 4326]);
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
