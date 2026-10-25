#!/usr/bin/env node
// Writes the kits that open the next token pools (dapp/evm-pool-tokens.js) on Ethereum, Base and Robinhood Chain: for each, the token as
// read from its chain, the pool and router the salts give it there, and the one transaction that opens both (Multicall3 calling CreateX
// twice, the pool first) or the router alone when only the pool is there, each run on the live chain with eth_call and eth_estimateGas
// from a plain address before it is written. dapp/admin/token-pools/ shows them and sends one from the owner's wallet.
//   dapp/admin/token-pools/kits.json        every kit, with its transactions, gas and cost as read, and what its keeper needs
//   dapp/admin/token-pools/anon-pools.json  { chainId: [{ sym, token, dec, pool, router, keeper, permit }] } for a page to embed: the
//                                           live Ethereum pools (TAC, USDC, USDT) and these, whose addresses are fixed before they open
// A token's symbol, decimals and permit must read as listed here, or nothing is written. `permit` is the token's EIP-2612 domain version
// ('1', '2'), or null where it has none (its deposits go through Permit2, or an approval).
//
//   node tools/token-pool-kits.mjs [--no-check] [--out <dir>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeTokenPools, poolState, decodeAggregate3, keeperIdOf, TOKEN_POOL_CHAINS, SERVED, FIXED, KEEPERS, CREATEX, MULTICALL3 } from '../dapp/evm-pool-tokens.js';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const CHECK = !args.includes('--no-check'), OUT = flag('--out', new URL('../dapp/admin/token-pools/', import.meta.url).pathname);
const code = JSON.parse(readFileSync(new URL('../dapp/evm-pool/token-pool-code.json', import.meta.url), 'utf8'));

// The chains, their nodes and explorers. `usd`: the chain's Chainlink ETH/USD feed, which prices a dollar token's relay fees in ETH, and
// `usdAge` the age its answers may have where that is not two hours (Robinhood Chain's is written on a 0.5% move or once a day).
const CHAINS = {
  1: { name: 'Ethereum', explorer: 'https://etherscan.io', rpc: ['https://mainnet.gateway.tenderly.co', 'https://ethereum-rpc.publicnode.com'], usd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' },
  8453: { name: 'Base', explorer: 'https://basescan.org', rpc: ['https://mainnet.base.org', 'https://base.gateway.tenderly.co', 'https://base-rpc.publicnode.com'], usd: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' },
  4663: { name: 'Robinhood Chain', explorer: 'https://robinhoodchain.blockscout.com', rpc: ['https://rpc.mainnet.chain.robinhood.com'], usd: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', usdAge: 90000 },
};

// The kits: deep, widely held tokens, the issuer's own where it has one. `feed`: the keeper's EVM_POOL_KEEPER_RATE_FEED for the pool:
// 'usd', a dollar's worth from the chain's ETH/USD feed; 'eth', wstETH counted as one ETH (it is always worth more, so its fees are never
// too low), where its pools are too thin for a quote to be the price; 'zq', the best pool's quote, where they are deep (the keepers'
// default). `maxRelayFee`: the most a wallet takes a relay's quote for, in base units: the chain's ETH pool ceiling (0.05 ETH on
// Ethereum, 0.002 ETH on the others) in the token, with room.
const D6 = 10n ** 6n, D18 = 10n ** 18n;
const KITS = [
  { chainId: 1, sym: 'wstETH', token: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', dec: 18, permit: '1', feed: 'zq', maxRelayFee: 5n * 10n ** 16n,
    about: "Lido's own wstETH on Ethereum, not upgradeable" },
  { chainId: 8453, sym: 'USDC', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dec: 6, permit: '2', feed: 'usd', maxRelayFee: 10n * D6,
    about: "Circle's native USDC on Base (not the bridged USDbC), an upgradeable FiatToken proxy" },
  { chainId: 8453, sym: 'USDT', token: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', dec: 6, permit: null, feed: 'usd', maxRelayFee: 10n * D6,
    about: "Ethereum's USDT through Base's standard bridge (Tether issues none on Base), not upgradeable" },
  { chainId: 8453, sym: 'wstETH', token: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', dec: 18, permit: null, feed: 'eth', maxRelayFee: 2n * 10n ** 15n,
    about: "Lido's wstETH on Base through Lido's own bridge, an upgradeable proxy" },
  { chainId: 4663, sym: 'USDG', token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', dec: 6, permit: '1', feed: 'usd', maxRelayFee: 10n * D6,
    about: "Paxos's Global Dollar, issued on Robinhood Chain, an upgradeable proxy" },
  { chainId: 4663, sym: 'USDe', token: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', dec: 18, permit: null, feed: 'usd', maxRelayFee: 10n * D18,
    about: "Ethena's USDe on Robinhood Chain, its LayerZero token (minted against USDe locked on Ethereum)" },
];

// The pools open on Ethereum already, which the embedded list starts with (each read back as the kits are).
const LIVE = [
  { chainId: 1, sym: 'TAC', token: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', dec: 18, permit: '1' },
  { chainId: 1, sym: 'USDC', token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6, permit: '2' },
  { chainId: 1, sym: 'USDT', token: '0xdAC17F958D2ee523a2206206994597C13D831ec7', dec: 6, permit: null },
];

const lc = (s) => String(s || '').toLowerCase();
const strip = (h) => String(h).replace(/^0x/, '');
const w = (h) => strip(h).toLowerCase().padStart(64, '0');
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const kh = (hex) => '0x' + hexOf(keccak_256(Uint8Array.from(strip(hex).match(/../g) || [], (x) => parseInt(x, 16))));
const ks = (s) => '0x' + hexOf(keccak_256(new TextEncoder().encode(s)));
const sel = (sig) => ks(sig).slice(0, 10);
const str = (h) => { const s = strip(h || ''); if (s.length < 128) return null; const n = Number(BigInt('0x' + s.slice(64, 128))); return Buffer.from(s.slice(128, 128 + n * 2), 'hex').toString('utf8'); };
const PLAIN = '0x000000000000000000000000000000000000dEaD';   // an address with no code, whose calls stand for the owner's

const rpcOf = (chainId) => async (method, params) => {
  let last;
  for (const url of CHAINS[chainId].rpc) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      const j = await r.json();
      // a revert is the chain's answer; any other error (a node's limit, its trouble) asks the next node
      if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { revert: /revert/i.test(`${j.error.message} ${JSON.stringify(j.error.data ?? '')}`) });
      return j.result;
    } catch (e) { if (e.revert) throw e; last = e; }
  }
  throw last;
};

// The token as its chain reads it: symbol, decimals, and its EIP-2612 domain version (the one its DOMAIN_SEPARATOR is built with), if any.
// Only a view that reverts (or answers nothing) is one the token does not have; a read that fails otherwise stops the tool.
async function readToken(rpc, chainId, token) {
  const call = (data) => rpc('eth_call', [{ to: token, data }, 'latest']).then((r) => (r === '0x' ? null : r), (e) => { if (e.revert) return null; throw e; });
  const [sym, dec, name, ds, nonces] = await Promise.all([call(sel('symbol()')), call(sel('decimals()')), call(sel('name()')), call(sel('DOMAIN_SEPARATOR()')), call(sel('nonces(address)') + w(PLAIN))]);
  const domain = (v) => kh([ks('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), ks(str(name) || ''), ks(v), BigInt(chainId).toString(16), token].map(w).join(''));
  const permit = ds && ds.length === 66 && nonces && nonces.length === 66 ? (['1', '2'].find((v) => domain(v) === lc(ds)) ?? 'unknown') : null;
  return { sym: str(sym), dec: dec ? Number(BigInt(dec)) : null, name: str(name), permit };
}

// What opening costs here: gas at the node's price, and on Base the L1 data fee its gas price oracle quotes for the calldata.
async function costOf(rpc, chainId, tx, gas) {
  const price = BigInt(await rpc('eth_gasPrice', []));
  let l1 = 0n;
  if (chainId === 8453) {
    const data = strip(tx.data), body = sel('getL1Fee(bytes)') + w('20') + w(BigInt(data.length / 2).toString(16)) + data + '0'.repeat((64 - (data.length % 64)) % 64);
    l1 = BigInt(await rpc('eth_call', [{ to: '0x420000000000000000000000000000000000000F', data: body }, 'latest']));
  }
  return { gasPrice: price, l1Fee: l1, wei: gas * price + l1 };
}

async function ethUsd() {
  const r = await rpcOf(1)('eth_call', [{ to: CHAINS[1].usd, data: sel('latestRoundData()') }, 'latest']);
  return Number(BigInt('0x' + strip(r).slice(64, 128))) / 1e8;
}

// The opening transaction run on the live chain: it must create the pool and router where the salts put them, as CreateX returns them.
async function simulate(rpc, tx, want) {
  const ret = strip(await rpc('eth_call', [{ from: PLAIN, to: tx.to, data: tx.data }, 'latest']));
  const made = tx.to === MULTICALL3 ? (decodeAggregate3(ret) || []).map((r) => (r.ok ? '0x' + r.data.slice(24, 64) : null)) : ['0x' + ret.slice(24, 64)];
  if (made.length !== want.length || made.some((a, i) => lc(a) !== lc(want[i]))) throw new Error(`the opening makes ${made.join(', ')}, not ${want.join(', ')}`);
  const gas = BigInt(await rpc('eth_estimateGas', [{ from: PLAIN, to: tx.to, data: tx.data }]));
  return { made, gas };
}

const usd = CHECK ? await ethUsd() : null;
const tps = Object.fromEntries(Object.keys(CHAINS).map((c) => [c, makeTokenPools({ code, keccak256: keccak_256, chain: TOKEN_POOL_CHAINS[c] })]));
// Ethereum's salts and arguments are the ones the live pools were opened under
for (const [t, v] of Object.entries(SERVED)) {
  const p = tps[1].poolOf(t);
  if (p.pool !== v.pool || p.router !== v.router) throw new Error(`${v.sym}: the salts no longer give its live pool and router`);
}

const kits = [], chainsRead = {};
for (const k of KITS) {
  const tp = tps[k.chainId], p = tp.poolOf(k.token), c = CHAINS[k.chainId], rpc = rpcOf(k.chainId);
  const open = tp.openTx(k.token), routerOnly = tp.openTx(k.token, { pool: true, router: false });
  const kit = {
    chainId: k.chainId, chain: c.name, sym: k.sym, token: p.token, dec: k.dec, permit: k.permit, about: k.about,
    pool: p.pool, router: p.router, poolSalt: p.poolSalt, routerSalt: p.routerSalt, poolGuard: p.poolGuard,
    args: { verifier: TOKEN_POOL_CHAINS[k.chainId].verifier, zRouter: TOKEN_POOL_CHAINS[k.chainId].zRouter, permit2: TOKEN_POOL_CHAINS[k.chainId].permit2, v1: TOKEN_POOL_CHAINS[k.chainId].v1, poseidon4: TOKEN_POOL_CHAINS[k.chainId].poseidon4 },
    keeper: { id: p.id, url: p.keeper, rateFeed: k.feed === 'usd' ? `usd:${c.usd}${c.usdAge ? `:${c.usdAge}` : ''}` : k.feed, maxRelayFee: String(k.maxRelayFee) },
    open: { to: open.to, data: open.data, value: '0', gas: String(open.gas) },
    routerOnly: { to: routerOnly.to, data: routerOnly.data, value: '0', gas: String(routerOnly.gas) },
  };
  if (CHECK) {
    const got = await readToken(rpc, k.chainId, k.token);
    if (got.sym !== k.sym || got.dec !== k.dec || got.permit !== k.permit) throw new Error(`${c.name} ${k.sym}: reads as ${JSON.stringify(got)}`);
    const block = Number(BigInt(await rpc('eth_blockNumber', [])));
    const have = await poolState(tp, k.token, (to, data) => rpc('eth_call', [{ to, data }, 'latest']));
    kit.state = have.pool && have.router ? 'open' : have.pool ? 'pool only' : 'not open';
    const checked = { block, at: new Date().toISOString(), from: PLAIN };
    for (const [key, tx, want] of [['open', kit.open, [p.pool, p.router]], ['routerOnly', kit.routerOnly, [p.router]]]) {
      if (key === 'open' && have.pool) continue;
      if (key === 'routerOnly' && !have.pool) continue;       // it is run on a fork, after the pool (tests/token-pool-kits-fork.mjs)
      if (have.router) continue;
      const s = await simulate(rpc, tx, want);
      // room over the estimate (an L2's share of L1 gas moves with Ethereum's price), and never under what the page has always asked
      const gas = [BigInt(tx.gas), ((s.gas * 5n) / 4n + 9_999n) / 10_000n * 10_000n].reduce((a, b) => (a > b ? a : b));
      tx.gas = String(gas);
      const cost = await costOf(rpc, k.chainId, tx, s.gas);
      checked[key] = { estimate: String(s.gas), gasPrice: String(cost.gasPrice), l1Fee: String(cost.l1Fee), costWei: String(cost.wei), costUsd: Number((Number(cost.wei) / 1e18 * usd).toFixed(4)) };
    }
    kit.checked = checked;
    chainsRead[k.chainId] = { block, gasPrice: String(await rpc('eth_gasPrice', [])) };
  }
  kits.push(kit);
  console.log(`${c.name} ${k.sym}: pool ${p.pool} router ${p.router} keeper /${p.id}/${kit.state ? ` (${kit.state}${kit.checked?.open ? `, opening ${kit.checked.open.estimate} gas ≈ $${kit.checked.open.costUsd}` : ''})` : ''}`);
}

mkdirSync(OUT, { recursive: true });
const meta = { createx: CREATEX, multicall3: MULTICALL3, poolInitHashCheck: code.check.poolInitHash, routerInitHashCheck: code.check.routerInitHash };
writeFileSync(join(OUT, 'kits.json'), JSON.stringify({ written: new Date().toISOString(), ethUsd: usd, ...meta, chains: Object.fromEntries(Object.entries(CHAINS).map(([id, c]) => [id, { ...c, ...(chainsRead[id] || {}) }])), kits }, null, 1) + '\n');

// The pools a page embeds, by chain: the live Ethereum ones first, then the kits (whose addresses hold before they open; a page shows
// one once its code is there).
const row = (chainId, sym, token, dec, permit) => {
  const p = tps[chainId].poolOf(token);
  return { sym, token: p.token, dec, pool: p.pool, router: p.router, keeper: `${KEEPERS}/${keeperIdOf(token, chainId)}/evm-pool/keeper`, permit };
};
const anon = {};
for (const t of LIVE) {
  if (CHECK) {
    const got = await readToken(rpcOf(t.chainId), t.chainId, t.token), have = await poolState(tps[t.chainId], t.token, (to, data) => rpcOf(t.chainId)('eth_call', [{ to, data }, 'latest']));
    if (got.sym !== t.sym || got.dec !== t.dec || got.permit !== t.permit) throw new Error(`${t.sym}: reads as ${JSON.stringify(got)}`);
    if (!have.pool || !have.router) throw new Error(`${t.sym}: its pool is not open where it is listed`);
  }
  (anon[t.chainId] ||= []).push(row(t.chainId, t.sym, t.token, t.dec, t.permit));
}
for (const k of KITS) (anon[k.chainId] ||= []).push(row(k.chainId, k.sym, k.token, k.dec, k.permit));
if (lc(anon[1][0].pool) !== lc(FIXED[lc(LIVE[0].token)].pool)) throw new Error('TAC: not its own pool');
writeFileSync(join(OUT, 'anon-pools.json'), JSON.stringify(anon, null, 1) + '\n');
console.log(`wrote ${join(OUT, 'kits.json')} (${kits.length} kits) and ${join(OUT, 'anon-pools.json')}`);
