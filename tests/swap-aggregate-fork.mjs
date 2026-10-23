#!/usr/bin/env node
// dapp/swap/aggregate.js on a mainnet fork: zQuoter's best onchain route for any token to any token (a single swap, a two-hop chain through
// ETH, a split across two pools), held to the terms by zrouter-guard, then sent to zRouter from a funded account. Each pays the account at
// least the route's own floor, spends exactly the amount, and leaves nothing at zRouter.
//
//   node tests/swap-aggregate-fork.mjs        (FORK=<rpc url> to fork another node)
import { spawn } from 'node:child_process';
import { register } from 'node:module';

// aggregate.js imports by site path (/swap/route.js?cb=…): answered from dapp/ here
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { bestRoute, legsOf } = await import('../dapp/swap/aggregate.js');
const { ZROUTER, ZERO, encApprove } = await import('../dapp/swap/route.js');

const FORK = process.env.FORK || 'https://ethereum-rpc.publicnode.com';
const PORT = 23900 + Math.floor(Math.random() * 90), RPC = `http://127.0.0.1:${PORT}`;
const T = { USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA', PEPE: '0x6982508145454Ce325dDbE47a25d4ec3d2311933' };
const WHO = '0x00000000000000000000000000000000000ab0Cd';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params = []) => {
  const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(j.error.message), { revert: /revert/i.test(j.error.message) });
  return j.result;
};
const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, block]);
// zQuoter's scans read every pool, which a fork fetches slot by slot: they are asked of the upstream node at the fork's own block, so they see
// exactly the state the fork runs them on
const UP = process.env.QUOTE_RPC || 'https://mainnet.gateway.tenderly.co';
const upCall = async (to, data, block, o = {}) => {
  const j = await (await fetch(UP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, block] }) })).json();
  if (j.error) throw Object.assign(new Error(j.error.message), { revert: /revert/i.test(j.error.message) });
  return j.result;
};
const bal = async (tok, who) => (tok === ZERO ? BigInt(await rpc('eth_getBalance', [who, 'latest'])) : BigInt(await ethCall(tok, '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0'))));
async function send(to, data, value = 0n) {
  const h = await rpc('eth_sendTransaction', [{ from: WHO, to, data, value: '0x' + value.toString(16), gas: '0x7A1200' }]);
  for (let i = 0; i < 100; i++) { const rc = await rpc('eth_getTransactionReceipt', [h]); if (rc) return rc; await sleep(100); }
  throw new Error('no receipt');
}

const head = BigInt((await (await fetch(UP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json()).result) - 2n;
const BLOCK = '0x' + head.toString(16);
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
await rpc('anvil_impersonateAccount', [WHO]);
await rpc('anvil_setBalance', [WHO, '0x' + (100n * 10n ** 18n).toString(16)]);
await rpc('anvil_dealERC20', [WHO, T.USDC, '0x' + (100000n * 10n ** 6n).toString(16)]);
await rpc('anvil_dealERC20', [WHO, T.LINK, '0x' + (10000n * 10n ** 18n).toString(16)]);
const now = Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));

for (const [label, tokenIn, tokenOut, amountIn] of [['USDC → WBTC', T.USDC, T.WBTC, 50000n * 10n ** 6n], ['LINK → PEPE', T.LINK, T.PEPE, 1000n * 10n ** 18n], ['ETH → USDC', ZERO, T.USDC, 2n * 10n ** 18n]]) {
  const q = await bestRoute({ ethCall: upCall, block: BLOCK, to: WHO, refundTo: WHO, tokenIn, tokenOut, amountIn, slippageBps: 50, deadline: BigInt(now + 1200) });
  ok(!!q && q.out > 0n && q.min > 0n && q.min <= q.out, `${label}: a route that passes the guard (${q ? `${q.kind}: ${q.name}, ${q.out} at least ${q.min}` : 'none'})`);
  if (!q) continue;
  ok(q.value === (tokenIn === ZERO ? amountIn : 0n), `${label}: sent exactly the ETH it spends (${q.value})`);
  ok(legsOf(q.callData).length >= 1, `${label}: its zRouter calls can be taken apart, so a permit can go ahead of them`);
  if (tokenIn !== ZERO) ok((await send(tokenIn, encApprove(ZROUTER, amountIn))).status === '0x1', `${label}: zRouter may spend exactly the amount`);
  const in0 = await bal(tokenIn, WHO), out0 = await bal(tokenOut, WHO);
  const rc = await send(ZROUTER, q.callData, q.value);
  ok(rc.status === '0x1', `${label}: the route runs (${BigInt(rc.gasUsed)} gas)`);
  const got = (await bal(tokenOut, WHO)) - out0, spent = in0 - (await bal(tokenIn, WHO));
  ok(got >= q.min, `${label}: paid ${got}, at least its floor ${q.min}`);
  if (tokenIn !== ZERO) ok(spent === amountIn, `${label}: spent exactly ${amountIn}`);
  ok((await bal(tokenOut, ZROUTER)) === 0n || tokenOut === ZERO, `${label}: nothing of it is left at zRouter`);
}

// ── a mix: a direct swap beside a chain through ETH, found for mid-cap tokens at size, then executed ──
{
  const MID = { UNI: ['0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 37500n * 10n ** 18n], AAVE: ['0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', 1200n * 10n ** 18n], wstETH: ['0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', 103n * 10n ** 18n] };
  const OUT = { UNI: ['USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7'], AAVE: ['USDC', T.USDC], wstETH: ['USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7'] };
  const kinds = [];
  for (const [sym, [token, amountIn]] of Object.entries(MID)) {
    const [osym, out] = OUT[sym];
    await rpc('anvil_dealERC20', [WHO, token, '0x' + amountIn.toString(16)]);
    const q = await bestRoute({ ethCall: upCall, block: BLOCK, to: WHO, refundTo: WHO, tokenIn: token, tokenOut: out, amountIn, slippageBps: 50, deadline: BigInt(now + 1200) });
    ok(!!q && q.min > 0n && q.min <= q.out, `${sym} → ${osym} at size: a route that passes the guard (${q ? `${q.kind}: ${q.name}, ${q.out} at least ${q.min}` : 'none'})`);
    if (!q) continue;
    kinds.push(q.kind);
    ok((await send(token, encApprove(ZROUTER, amountIn))).status === '0x1', `${sym}: zRouter may spend exactly the amount`);
    const in0 = await bal(token, WHO), out0 = await bal(out, WHO), rc = await send(ZROUTER, q.callData, q.value);
    const got = (await bal(out, WHO)) - out0, spent = in0 - (await bal(token, WHO));
    ok(rc.status === '0x1' && got >= q.min && spent === amountIn, `${sym}: it runs (${BigInt(rc.gasUsed)} gas), pays ${got} (at least ${q.min}) and spends exactly ${amountIn}`);
    ok((await bal(out, ZROUTER)) === 0n && (await bal('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', ZROUTER)) === 0n, `${sym}: nothing of the output or the hub's WETH is left at zRouter`);
  }
  ok(kinds.includes('hybrid'), `at least one of these pairs is answered with a mix at this block (${kinds.join(', ')})`);
}

console.log(`\n${n} passed, ${fails} failed`);
anvil.kill('SIGKILL');
process.exit(fails ? 1 : 0);
