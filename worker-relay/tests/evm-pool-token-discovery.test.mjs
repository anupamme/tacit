// Token pools found on chain (src/lib/evm-pool-token-discovery.js): from CreateX's ContractCreation logs under the served tokens' pool salts, a
// contract is kept only if it is the pool the salts give that token, served once its router answers too; what is found is kept across
// restarts, and a change of the tokens reads the logs again; any other token's pool is kept when it is named and is on chain.
// node --test tests/evm-pool-token-discovery.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak_256 } from '../../dapp/vendor/tacit-deps.min.js';
import { makeTokenPools, CREATEX, CREATED_TOPIC } from '../../dapp/evm-pool-tokens.js';
import { makeTokenPoolDiscovery } from '../src/lib/evm-pool-token-discovery.js';

const code = JSON.parse(readFileSync(new URL('../../dapp/evm-pool/token-pool-code.json', import.meta.url), 'utf8'));
const tp = makeTokenPools({ code, keccak256: keccak_256 });
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
const w = (a) => '0x' + a.toLowerCase().slice(2).padStart(64, '0');
const U = tp.poolOf(USDC), D = tp.poolOf(DAI), B = tp.poolOf(WBTC);
// a chain: CreateX logs at blocks (each under a guarded salt), filtered by topic 2 as a node would, and the routers' POOL() answers
function chain({ head = 1000, logs = [], views = {} } = {}) {
  const asked = [];
  const rpc = async (m, p) => {
    asked.push(m);
    if (m === 'eth_blockNumber') return '0x' + head.toString(16);
    if (m === 'eth_getLogs') {
      const [{ address, topics, fromBlock, toBlock }] = p;
      assert.equal(address, CREATEX); assert.equal(topics[0], CREATED_TOPIC);
      // by salt (the scan: topic 1 open, topic 2 the served tokens' salts) or by the address made (a named pool's creation)
      const hit = topics[1] == null ? (l) => topics[2].includes(l.guard) : (l) => w(l.made) === topics[1].toLowerCase();
      return logs.filter((l) => l.block >= Number(fromBlock) && l.block <= Number(toBlock) && hit(l))
        .map((l) => ({ topics: [CREATED_TOPIC, w(l.made), l.guard], blockNumber: '0x' + l.block.toString(16) }));
    }
    if (m === 'eth_call') { const v = views[`${p[0].to.toLowerCase()}:${p[0].data}`]; if (v === undefined) throw new Error('execution reverted'); return v; }
    throw new Error(m);
  };
  return { rpc, asked, views, logs, set head(h) { head = h; } };
}
const routerOk = (P) => ({ [`${P.router.toLowerCase()}:0x7535d246`]: w(P.pool) });

test("a served token's pool is found under its salt; another contract under that salt, and other tokens' pools, are not", async () => {
  const LOOK = '0x00000000000000000000000000000000000c0FFE';
  const c = chain({ logs: [{ made: U.pool, guard: U.poolGuard, block: 900 }, { made: LOOK, guard: U.poolGuard, block: 905 }, { made: D.pool, guard: D.poolGuard, block: 910 }],
    views: { ...routerOk(U), ...routerOk(D) } });
  const d = makeTokenPoolDiscovery({ tp, tokens: [USDC], rpc: c.rpc, fromBlock: 800n, confirmations: 3n });
  const ready = await d.scan();
  assert.deepEqual(ready.map((p) => [p.token, p.pool, p.router, p.block]), [[USDC, U.pool, U.router, 900]]);
  assert.equal(d.known().length, 1);
  assert.equal(c.asked.filter((m) => m === 'eth_call').length, 1, 'only the found pool\'s router is asked');
});

test("TAC's own pool is not looked for, and no tokens means no reads", async () => {
  const c = chain({});
  assert.deepEqual(await makeTokenPoolDiscovery({ tp, tokens: [TAC], rpc: c.rpc, fromBlock: 800n }).scan(), []);
  assert.deepEqual(c.asked, []);
});

test("a pool whose router is not there yet waits, and is served once it is; the cursor keeps the confirmations' distance", async () => {
  const c = chain({ head: 1000, logs: [{ made: D.pool, guard: D.poolGuard, block: 950 }] });
  const d = makeTokenPoolDiscovery({ tp, tokens: [DAI], rpc: c.rpc, fromBlock: 900n, confirmations: 3n });
  assert.deepEqual(await d.scan(), []);
  assert.deepEqual(d.pending(), [DAI.toLowerCase()]);
  Object.assign(c.views, routerOk(D));
  const ready = await d.scan();
  assert.deepEqual(ready.map((p) => p.token), [DAI]); assert.deepEqual(d.pending(), []);
  const late = chain({ head: 1000, logs: [{ made: U.pool, guard: U.poolGuard, block: 999 }], views: routerOk(U) });
  const e = makeTokenPoolDiscovery({ tp, tokens: [USDC], rpc: late.rpc, fromBlock: 900n, confirmations: 3n });
  assert.deepEqual(await e.scan(), [], 'a creation within the confirmations is not read yet');
  late.head = 1003;
  assert.deepEqual((await e.scan()).map((p) => p.token), [USDC], 'and is once they pass');
});

test('what was found is kept in its file: a restart serves it at once and reads on; a token added reads from the start again', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tpd-')), 'token-pools-1.json');
  const logs = [{ made: U.pool, guard: U.poolGuard, block: 900 }, { made: D.pool, guard: D.poolGuard, block: 910 }];
  await makeTokenPoolDiscovery({ tp, tokens: [USDC], rpc: chain({ logs, views: { ...routerOk(U), ...routerOk(D) } }).rpc, fromBlock: 800n, statePath: file }).scan();
  const again = makeTokenPoolDiscovery({ tp, tokens: [USDC], rpc: chain({ logs: [] }).rpc, fromBlock: 800n, statePath: file });
  assert.deepEqual(again.known().map((p) => p.token), [USDC]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).cursor, '997');
  const more = makeTokenPoolDiscovery({ tp, tokens: [USDC, DAI], rpc: chain({ logs, views: { ...routerOk(U), ...routerOk(D) } }).rpc, fromBlock: 800n, statePath: file });
  assert.deepEqual((await more.scan()).map((p) => p.token), [DAI]);
  assert.deepEqual(more.known().map((p) => p.token).sort(), [DAI, USDC].sort());
  const fewer = makeTokenPoolDiscovery({ tp, tokens: [DAI], rpc: chain({ logs: [] }).rpc, fromBlock: 800n, statePath: file });
  assert.deepEqual(fewer.known().map((p) => p.token), [DAI], 'a token taken off the list is not served');
});

test("a named token's pool is kept once its pool and router are on chain where the salts put them, from the block CreateX made it in", async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tpd-')), 'token-pools-1.json');
  const assetOk = (P, t) => ({ [`${P.pool.toLowerCase()}:0x4800d97f`]: w(t) });
  const c = chain({ head: 1000, logs: [{ made: D.pool, guard: D.poolGuard, block: 960 }], views: {} });
  const d = makeTokenPoolDiscovery({ tp, tokens: [USDC], rpc: c.rpc, fromBlock: 800n, statePath: file, maxNamed: 1 });
  assert.equal((await d.notify(DAI)).status, 'not-open', 'nothing there yet');
  Object.assign(c.views, assetOk(D, DAI));
  assert.equal((await d.notify(DAI)).status, 'not-open', 'a pool with no router is not open');
  Object.assign(c.views, routerOk(D));
  const r = await d.notify(DAI);
  assert.equal(r.status, 'added'); assert.deepEqual([r.entry.token, r.entry.pool, r.entry.router, r.entry.block], [DAI, D.pool, D.router, 960]);
  assert.deepEqual(d.known().map((p) => p.token), [DAI]); assert.equal(d.named(DAI), true);
  assert.equal((await d.notify(DAI)).status, 'known');
  assert.equal((await d.notify(USDC)).status, 'served', 'a listed token is served already');
  assert.equal((await d.notify(TAC)).status, 'fixed', "TAC has its own pool");
  Object.assign(c.views, assetOk(B, WBTC), routerOk(B)); c.logs.push({ made: B.pool, guard: B.poolGuard, block: 970 });
  assert.equal((await d.notify(WBTC)).status, 'full', 'no more than maxNamed');
  const again = makeTokenPoolDiscovery({ tp, tokens: [USDC], rpc: chain({}).rpc, fromBlock: 800n, statePath: file });
  assert.deepEqual(again.known().map((p) => p.token), [DAI], 'and it is kept across a restart');
});

test('a contract at the address with another salt (not made from the salts) is not a named pool', async () => {
  const c = chain({ head: 1000, logs: [{ made: D.pool, guard: '0x' + '22'.repeat(32), block: 960 }], views: { [`${D.pool.toLowerCase()}:0x4800d97f`]: w(DAI), ...routerOk(D) } });
  const d = makeTokenPoolDiscovery({ tp, tokens: [USDC], rpc: c.rpc, fromBlock: 800n });
  assert.equal((await d.notify(DAI)).status, 'not-open');
});
