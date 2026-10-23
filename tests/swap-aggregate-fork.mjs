#!/usr/bin/env node
// dapp/swap/aggregate.js on a mainnet fork: zQuoter's best onchain route for any token to any token (a single swap, a two-hop chain through
// ETH, a split across two pools), held to the terms by zrouter-guard, then sent to zRouter from a funded account. Each pays the account at
// least the route's own floor, spends exactly the amount, and leaves nothing at zRouter.
//
//   node tests/swap-aggregate-fork.mjs        (FORK=<rpc url> to fork another node)
import { spawn } from 'node:child_process';
import { bestRoute, legsOf } from '../dapp/swap/aggregate.js';
import { ZROUTER, ZERO, encApprove } from '../dapp/swap/route.js';

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

console.log(`\n${n} passed, ${fails} failed`);
anvil.kill('SIGKILL');
process.exit(fails ? 1 : 0);
