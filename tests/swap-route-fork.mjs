#!/usr/bin/env node
// dapp/swap/route.js against an anvil fork of Ethereum mainnet: any ERC-20 into TAC in one transaction (USDC and wstETH by EIP-2612
// permit, DAI by its own permit, USDC and WETH by Permit2, USDT and WETH by approval), and ETH to and from cUSD and cBTC through the
// Tacit pool's public door (a token in by permit and by approval). Each run checks what arrives, that no more than the amount typed
// is spent, and that nothing is left at zRouter or PrecisionRoute. Fresh accounts sign with real keys. Needs foundry (`anvil`, `cast`)
// and a mainnet RPC that serves state (default: Tenderly's public gateway). Nothing leaves the fork.
//
//   node tests/swap-route-fork.mjs                 # FORK=<rpc url>  PORT=8613  to override
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeEvmTradeVenues } from '../dapp/evm-trade-venues.js';
import {
  ZERO, WETH, TAC, CUSD, CBTC, DAI, ZROUTER, ZQUOTER, PERMIT2, PRECISION_ROUTE, CONF_ROUTER, TOKENS,
  quoteAnyToTac, buildAnyToTac, quoteAmm, buildAmm, readToken, readAccess, encApprove, permitTyped, daiPermitTyped, permit2Typed, splitSig, randomNonce,
} from '../dapp/swap/route.js';

const FORK = process.env.FORK || 'https://ethereum-rpc.publicnode.com', PORT = Number(process.env.PORT || 8613), URL = `http://127.0.0.1:${PORT}`;
// zQuoter's scan of every pool reads thousands of storage slots, which a fork fetches one by one: that one view call is asked of the
// upstream node at the block the fork was made from, and everything else runs on the fork.
const upstream = async (method, params) => { const j = await (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { revert: /revert/i.test(j.error.message || '') }); return j.result; };
const FORK_BLOCK = Number(BigInt(await upstream('eth_blockNumber', [])) - 2n);
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(FORK_BLOCK), '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data, revert: /revert/i.test(j.error.message || '') });
  return j.result;
}
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const hex = (v) => '0x' + BigInt(v).toString(16);
const E18 = 10n ** 18n;
const ethCall = (to, data, block = 'latest', o = {}) => (to === ZQUOTER ? upstream : rpc)('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: hex(o.value) } : {}), ...(o.gas ? { gas: o.gas } : {}) }, to === ZQUOTER ? '0x' + FORK_BLOCK.toString(16) : block]);
const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak_256 });
const tok = (s) => TOKENS.find((t) => t.sym === s);
const balanceOf = async (token, who) => (token === ZERO ? BigInt(await rpc('eth_getBalance', [who, 'latest'])) : BigInt(await ethCall(token, '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0'))));
const cast = (...args) => execFileSync('cast', args, { encoding: 'utf8' }).trim();
const newWallet = () => { const j = JSON.parse(cast('wallet', 'new', '--json'))[0]; return { address: j.address, key: j.private_key }; };
const sign = (w, typed) => cast('wallet', 'sign', '--private-key', w.key, '--data', JSON.stringify(typed));
async function fund(w, token, amount) {
  await rpc('anvil_setBalance', [w.address, hex(10n * E18)]);
  if (token && token !== ZERO) await rpc('anvil_dealERC20', [w.address, token, hex(amount)]);
}
async function send(from, tx) {
  await rpc('anvil_impersonateAccount', [from]);
  const h = await rpc('eth_sendTransaction', [{ from, to: tx.to, data: tx.data, ...(tx.value ? { value: hex(tx.value) } : {}), gas: hex(3_000_000) }]);
  let rc = null;
  for (let i = 0; i < 40 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [h]); if (!rc) await sleep(250); }
  return { ok: rc?.status === '0x1', gas: BigInt(rc?.gasUsed || 0) };
}
const now = async () => BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp);

// The fork reads each contract from upstream on first use: wait until the Precision pool answers.
for (let i = 0; ; i++) {
  const q = await venues.quotePrecision({ dir: 'ETH_TO_TAC', amountIn: E18 / 100n, account: '0x1111111111111111111111111111111111111111' }).catch(() => null);
  if (q?.pool) break;
  if (i >= 12) throw new Error('the fork never answered the Precision pool');
  await sleep(4000);
}

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const f = (x, d = 18, p = 4) => (Number(x) / 10 ** d).toFixed(p);
const leftovers = async (tokens) => {
  const out = {};
  for (const t of tokens) out[t] = { zr: await balanceOf(t, ZROUTER), pr: await balanceOf(t, PRECISION_ROUTE) };
  out.eth = { zr: await balanceOf(ZERO, ZROUTER), pr: await balanceOf(ZERO, PRECISION_ROUTE) };
  return out;
};

// One any-token purchase of TAC, start to finish, the way the page makes it.
async function anyToTac(sym, amount, how) {
  const t = tok(sym), w = newWallet();
  await fund(w, t.addr, amount);
  const q = await quoteAnyToTac({ ethCall, venues, token: t.addr, amountIn: amount, account: w.address, slippageBps: 50, deadline: (await now()) + 1800n });
  assert.ok(q, `${sym}: a route`);
  assert.ok(q.maxIn <= amount, `${sym}: the most spent (${q.maxIn}) is inside the amount (${amount})`);
  const minOut = (q.tacOut * 9950n) / 10000n, acc = await readAccess({ ethCall, token: t.addr, owner: w.address });
  let access;
  if (how === 'permit') {
    const typed = permitTyped({ token: t.addr, name: (await readToken({ ethCall, keccak256: keccak_256, address: t.addr })).name, version: t.permit, owner: w.address, spender: ZROUTER, value: q.maxIn, nonce: acc.nonce, deadline: q.deadline });
    access = { kind: 'permit', value: q.maxIn, deadline: q.deadline, ...splitSig(sign(w, typed)) };
  } else if (how === 'dai') {
    access = { kind: 'dai', nonce: acc.nonce, expiry: q.deadline, ...splitSig(sign(w, daiPermitTyped({ owner: w.address, nonce: acc.nonce, expiry: q.deadline }))) };
  } else if (how === 'permit2') {
    assert.ok((await send(w.address, { to: t.addr, data: encApprove(PERMIT2, (1n << 256n) - 1n) })).ok, 'approve Permit2');
    const nonce = randomNonce();
    access = { kind: 'permit2', nonce, deadline: q.deadline, signature: sign(w, permit2Typed({ token: t.addr, amount: q.maxIn, nonce, deadline: q.deadline })) };
  } else {
    if (sym === 'USDT' && acc.allowed) await send(w.address, { to: t.addr, data: encApprove(ZROUTER, 0n) });
    assert.ok((await send(w.address, { to: t.addr, data: encApprove(ZROUTER, q.maxIn) })).ok, 'approve zRouter');
    access = { kind: 'approved' };
  }
  const tx = buildAnyToTac({ quote: q, account: w.address, minOut, keccak256: keccak_256, access });
  const before = await leftovers([t.addr, WETH, TAC]);
  const r = await send(w.address, tx);
  assert.ok(r.ok, `${sym} by ${how}: the transaction landed`);
  const got = await balanceOf(TAC, w.address), left = await balanceOf(t.addr, w.address), spent = amount - left;
  assert.ok(got >= minOut, `${sym}: TAC ${got} at least the floor ${minOut}`);
  assert.ok(spent <= amount && spent <= q.maxIn, `${sym}: spent ${spent} within ${q.maxIn}`);
  const after = await leftovers([t.addr, WETH, TAC]);
  for (const k of Object.keys(after)) {
    assert.ok(after[k].pr <= before[k].pr, `${sym}: nothing of ${k} left at PrecisionRoute`);
    assert.ok(after[k].zr <= before[k].zr + 1n, `${sym}: nothing of ${k} left at zRouter (${before[k].zr} → ${after[k].zr})`);
  }
  if (how === 'permit') assert.equal((await readAccess({ ethCall, token: t.addr, owner: w.address })).nonce, acc.nonce + 1n, 'the permit was used');
  ok(`${sym} → TAC by ${how}: ${f(spent, t.dec, 4)} ${sym} → ${f(got, 18, 2)} TAC via ${q.hop ? `${q.hop.name} + ` : ''}Precision (WETH ${f(q.weth)}), gas ${r.gas}`);
  return { q, got };
}

// ── readToken: the permit version is found from the token's own domain separator ──
assert.equal((await readToken({ ethCall, keccak256: keccak_256, address: tok('USDC').addr })).permit, '2');
assert.equal((await readToken({ ethCall, keccak256: keccak_256, address: tok('wstETH').addr })).permit, '1');
assert.equal((await readToken({ ethCall, keccak256: keccak_256, address: TAC })).permit, '1');
assert.equal((await readToken({ ethCall, keccak256: keccak_256, address: CUSD })).permit, '1');
assert.equal((await readToken({ ethCall, keccak256: keccak_256, address: tok('USDT').addr })).permit, null);
const wbtc = await readToken({ ethCall, keccak256: keccak_256, address: tok('WBTC').addr });
assert.equal(wbtc.sym, 'WBTC'); assert.equal(wbtc.dec, 8); assert.equal(wbtc.permit, null);
assert.equal(await readToken({ ethCall, keccak256: keccak_256, address: '0x1111111111111111111111111111111111111111' }), null);
for (const t of TOKENS.filter((x) => x.permit && x.permit !== 'dai')) assert.equal((await readToken({ ethCall, keccak256: keccak_256, address: t.addr })).permit, t.permit, `${t.sym} permit version`);
ok('readToken: permit versions from each token\'s domain separator (USDC 2, wstETH/TAC/cUSD/cBTC 1, none for USDT/WBTC), decimals, a non-token');

// ── any token → TAC ──
await anyToTac('USDC', 500n * 10n ** 6n, 'permit');
await anyToTac('USDC', 2500n * 10n ** 6n, 'permit2');
await anyToTac('USDT', 300n * 10n ** 6n, 'approve');
await anyToTac('DAI', 400n * E18, 'dai');
await anyToTac('wstETH', E18 / 5n, 'permit');
await anyToTac('WETH', E18 / 4n, 'approve');
await anyToTac('WETH', E18 / 3n, 'permit2');
await anyToTac('WBTC', 2n * 10n ** 6n, 'approve');

// A floor above what the pool pays reverts, and nothing moves.
{
  const t = tok('USDC'), w = newWallet(), amount = 200n * 10n ** 6n;
  await fund(w, t.addr, amount);
  const q = await quoteAnyToTac({ ethCall, venues, token: t.addr, amountIn: amount, account: w.address, deadline: (await now()) + 1800n });
  await send(w.address, { to: t.addr, data: encApprove(ZROUTER, q.maxIn) });
  const r = await send(w.address, buildAnyToTac({ quote: q, account: w.address, minOut: q.tacOut * 2n, keccak256: keccak_256, access: { kind: 'approved' } }));
  assert.equal(r.ok, false, 'reverts');
  assert.equal(await balanceOf(t.addr, w.address), amount, 'nothing spent');
  ok('a floor the pool cannot meet reverts and spends nothing');
}

// ── the Tacit pool's public door ──
async function amm(sym, dir, amount, how) {
  const t = tok(sym), w = newWallet(), dl = (await now()) + 1800n;
  const [inTok, outTok] = dir === 'buy' ? [ZERO, t.addr] : [t.addr, ZERO];
  await fund(w, inTok, amount);
  const q = await quoteAmm({ ethCall, tokenIn: inTok, tokenOut: outTok, amountIn: amount });
  assert.ok(q, `${sym} ${dir}: a quote`);
  const minOut = (q.amountOut * 9950n) / 10000n;
  let permit = null;
  if (how === 'permit') {
    const acc = await readAccess({ ethCall, token: inTok, owner: w.address, spender: CONF_ROUTER });
    permit = splitSig(sign(w, permitTyped({ token: inTok, name: 'Tacit Token', version: '1', owner: w.address, spender: CONF_ROUTER, value: q.amountIn, nonce: acc.nonce, deadline: dl })));
  }
  const tx = buildAmm({ quote: q, account: w.address, minOut, deadline: dl, permit });
  if (tx.approval) assert.ok((await send(w.address, { to: tx.approval.token, data: encApprove(tx.approval.spender, tx.approval.amount) })).ok, 'approve');
  const before = await balanceOf(outTok, w.address);
  const r = await send(w.address, tx);
  assert.ok(r.ok, `${sym} ${dir} by ${how}: landed`);
  const got = (await balanceOf(outTok, w.address)) - before + (outTok === ZERO ? 0n : 0n);
  if (outTok !== ZERO) assert.ok(got >= minOut, `${sym}: ${got} at least ${minOut}`);
  else assert.ok(got > 0n, 'ETH arrived (less gas)');
  ok(`${dir === 'buy' ? `ETH → ${sym}` : `${sym} → ETH`}${how ? ` by ${how}` : ''}: ${f(q.amountIn)} → ${f(q.amountOut, 18, 6)} (${outTok === ZERO ? 'net of gas ' + f(got, 18, 6) : 'received ' + f(got, 18, 6)}), gas ${r.gas}`);
  return got;
}
const cusdGot = await amm('cUSD', 'buy', E18 / 50n);
const cbtcGot = await amm('cBTC', 'buy', E18 / 50n);
assert.ok(cusdGot > 0n && cbtcGot > 0n);
await amm('cUSD', 'sell', 20n * E18, 'permit');
await amm('cBTC', 'sell', E18 / 10000n, 'approve');
assert.equal(await quoteAmm({ ethCall, tokenIn: ZERO, tokenOut: CUSD, amountIn: 5n }), null, 'an amount under one pool unit has no quote');
ok('an amount under the pool\'s unit is not quoted');

console.log(`\n${n} passed`);
process.exit(0);
