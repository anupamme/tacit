// The multi-chain keeper process (src/evm-pool-keepers.js): each chain's view of the environment, the routes, and one prover at a time.
// node --test tests/evm-pool-keepers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { chainsOf, envFor, routeOf, serialProver } from '../src/evm-pool-keepers.js';

test('the chains are read in order; a bad id refuses', () => {
  assert.deepEqual(chainsOf({ EVM_POOL_CHAINS: '1, 8453,4663,4326' }), [1, 8453, 4663, 4326]);
  assert.deepEqual(chainsOf({}), []);
  assert.throws(() => chainsOf({ EVM_POOL_CHAINS: '1,base' }), /bad chain id/);
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
  const chains = [1, 8453];
  assert.deepEqual(routeOf('/8453/evm-pool/keeper/quote?x=1', chains), { chainId: 8453, path: '/evm-pool/keeper/quote?x=1' });
  assert.deepEqual(routeOf('/8453/health', chains), { chainId: 8453, path: '/health' });
  assert.deepEqual(routeOf('/8453', chains), { chainId: 8453, path: '/' });
  assert.deepEqual(routeOf('/evm-pool/keeper/head', chains), { chainId: 1, path: '/evm-pool/keeper/head' });
  assert.equal(routeOf('/4663/evm-pool/keeper/head', chains), null);
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
