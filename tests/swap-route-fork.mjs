#!/usr/bin/env node
// dapp/swap/route.js against an anvil fork of Ethereum mainnet: any ERC-20 into TAC in one transaction (USDC and wstETH by EIP-2612
// permit, DAI by its own permit, USDC and WETH by Permit2, USDT and WETH by approval), and ETH to and from cUSD and cBTC through the
// Tacit pool's public door (a token in by permit and by approval), and each of them with the output sent to another address (the payer
// receives none of it). Each run checks what arrives, that no more than the amount typed
// is spent, and that nothing is left at zRouter or PrecisionRoute. Fresh accounts sign with real keys. Needs foundry (`anvil`, `cast`)
// and a mainnet RPC that serves state (default: Tenderly's public gateway). Nothing leaves the fork.
//
//   node tests/swap-route-fork.mjs                 # FORK=<rpc url>  PORT=8613  to override
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeEvmTradeVenues } from '../dapp/evm-trade-venues.js';
import { ammRouteDeployTx, ammRouteAddress, ammRouteAddressMatches } from './amm-route-deploy.mjs';
import {
  ZERO, WETH, TAC, CUSD, CBTC, DAI, ZROUTER, ZQUOTER, PERMIT2, PRECISION_ROUTE, CONF_ROUTER, TOKENS,
  quoteAnyToTac, buildAnyToTac, quoteAmm, buildAmm, quoteTacitToToken, buildTacitToToken, quoteTokenToTacit, buildTokenToTacit, ammRouteLive, TACIT_AMM, TACIT_AMM_ROUTE, readToken, readAccess, encApprove, permitTyped, daiPermitTyped, permit2Typed, splitSig, randomNonce,
} from '../dapp/swap/route.js';

const FORK = process.env.FORK || 'https://ethereum-rpc.publicnode.com', PORT = Number(process.env.PORT || 8613), URL = `http://127.0.0.1:${PORT}`;
// zQuoter's scan of every pool reads thousands of storage slots, which a fork fetches one by one: that one view call is asked of the
// upstream node at the block the fork was made from, and everything else runs on the fork.
// The upstream node answers the zQuoter scan at the fork's block. A node that is unreachable, or that caps a call's gas below what the scan asks for
// (50M on some public nodes), is followed by the next one.
const UPSTREAMS = [FORK, 'https://mainnet.gateway.tenderly.co'];
const upstream = async (method, params) => {
  let last;
  for (const url of UPSTREAMS) {
    for (let a = 0; a < 2; a++) {
      try {
        const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
        if (j.error) { last = Object.assign(new Error(j.error.message), { revert: /revert/i.test(j.error.message || '') }); if (/gas required exceeds|out of gas/i.test(j.error.message || '') || last.revert) break; continue; }
        return j.result;
      } catch (e) { last = e; }
    }
  }
  throw last;
};
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
// The pool mints and burns TAC, tacUSD and tacBTC, and burns without checking the supply: a balance dealt on top of the supply would
// make the next burn wrap it, and the next mint overflow. So what is dealt of those is added to their supply as well.
const SUPPLY_SLOT = '0x' + '5345cdf77eb68f44c'.padStart(64, '0');
const POOL_MINTED = new Set([TAC, CUSD, CBTC].map((a) => a.toLowerCase()));
async function fund(w, token, amount) {
  await rpc('anvil_setBalance', [w.address, hex(10n * E18)]);
  if (!token || token === ZERO) return;
  await rpc('anvil_dealERC20', [w.address, token, hex(amount)]);
  if (POOL_MINTED.has(token.toLowerCase())) await rpc('anvil_setStorageAt', [token, SUPPLY_SLOT, '0x' + (BigInt(await rpc('eth_getStorageAt', [token, SUPPLY_SLOT, 'latest'])) + amount).toString(16).padStart(64, '0')]);
}
async function send(from, tx) {
  await rpc('anvil_impersonateAccount', [from]);
  const h = await rpc('eth_sendTransaction', [{ from, to: tx.to, data: tx.data, ...(tx.value ? { value: hex(tx.value) } : {}), gas: hex(3_000_000) }]);
  let rc = null;
  for (let i = 0; i < 40 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [h]); if (!rc) await sleep(250); }
  return { ok: rc?.status === '0x1', gas: BigInt(rc?.gasUsed || 0), hash: h };
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
  for (const t of tokens) out[t] = { zr: await balanceOf(t, ZROUTER), pr: await balanceOf(t, PRECISION_ROUTE), ar: await balanceOf(t, TACIT_AMM_ROUTE) };
  out.eth = { zr: await balanceOf(ZERO, ZROUTER), pr: await balanceOf(ZERO, PRECISION_ROUTE), ar: await balanceOf(ZERO, TACIT_AMM_ROUTE) };
  return out;
};

// One any-token purchase of TAC, start to finish, the way the page makes it.
async function anyToTac(sym, amount, how, to = null) {
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
  const tx = buildAnyToTac({ quote: q, account: w.address, ...(to ? { to } : {}), minOut, keccak256: keccak_256, access });
  const before = await leftovers([t.addr, WETH, TAC]);
  const r = await send(w.address, tx);
  assert.ok(r.ok, `${sym} by ${how}: the transaction landed`);
  const got = await balanceOf(TAC, to || w.address), left = await balanceOf(t.addr, w.address), spent = amount - left;
  if (to) assert.equal(await balanceOf(TAC, w.address), 0n, `${sym}: the payer received no TAC`);
  assert.ok(got >= minOut, `${sym}: TAC ${got} at least the floor ${minOut}`);
  assert.ok(spent <= amount && spent <= q.maxIn, `${sym}: spent ${spent} within ${q.maxIn}`);
  const after = await leftovers([t.addr, WETH, TAC]);
  for (const k of Object.keys(after)) {
    assert.ok(after[k].pr <= before[k].pr, `${sym}: nothing of ${k} left at PrecisionRoute`);
    assert.ok(after[k].zr <= before[k].zr + 1n, `${sym}: nothing of ${k} left at zRouter (${before[k].zr} → ${after[k].zr})`);
  }
  if (how === 'permit') assert.equal((await readAccess({ ethCall, token: t.addr, owner: w.address })).nonce, acc.nonce + 1n, 'the permit was used');
  ok(`${sym} → TAC by ${how}${to ? ' to another address' : ''}: ${f(spent, t.dec, 4)} ${sym} → ${f(got, 18, 2)} TAC via ${q.hop ? `${q.hop.name} + ` : ''}Precision (WETH ${f(q.weth)}), gas ${r.gas}`);
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
ok('readToken: permit versions from each token\'s domain separator (USDC 2, wstETH/TAC/tacUSD/tacBTC 1, none for USDT/WBTC), decimals, a non-token');

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
async function amm(sym, dir, amount, how, to = null) {
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
  const tx = buildAmm({ quote: q, account: w.address, ...(to ? { to } : {}), minOut, deadline: dl, permit });
  if (tx.approval) assert.ok((await send(w.address, { to: tx.approval.token, data: encApprove(tx.approval.spender, tx.approval.amount) })).ok, 'approve');
  const holder = to || w.address, before = await balanceOf(outTok, holder), payerBefore = await balanceOf(outTok, w.address);
  const r = await send(w.address, tx);
  assert.ok(r.ok, `${sym} ${dir} by ${how}: landed`);
  const got = (await balanceOf(outTok, holder)) - before;
  if (outTok !== ZERO || to) assert.ok(got >= minOut, `${sym}: ${got} at least ${minOut}`);
  else assert.ok(got > 0n, 'ETH arrived (less gas)');
  if (to) assert.ok((await balanceOf(outTok, w.address)) <= payerBefore, `${sym}: the payer received none of the output`);
  ok(`${dir === 'buy' ? `ETH → ${sym}` : `${sym} → ETH`}${how ? ` by ${how}` : ''}${to ? ' to another address' : ''}: ${f(q.amountIn)} → ${f(q.amountOut, 18, 6)} (${outTok === ZERO ? 'net of gas ' + f(got, 18, 6) : 'received ' + f(got, 18, 6)}), gas ${r.gas}`);
  return got;
}
const cusdGot = await amm('tacUSD', 'buy', E18 / 50n);
const cbtcGot = await amm('tacBTC', 'buy', E18 / 50n);
assert.ok(cusdGot > 0n && cbtcGot > 0n);
await amm('tacUSD', 'sell', 20n * E18, 'permit');
await amm('tacBTC', 'sell', E18 / 10000n, 'approve');
assert.equal(await quoteAmm({ ethCall, tokenIn: ZERO, tokenOut: CUSD, amountIn: 5n }), null, 'an amount under one pool unit has no quote');
ok('an amount under the pool\'s unit is not quoted');

// ── the output to another address: through the venues (Precision, the Tacit pool, both) and the page's own routes ──
// The payer funds and signs; the recipient is a fresh address that holds nothing. The recipient must receive at least the floor, the payer
// none of the output, nothing may stay at zRouter or PrecisionRoute, and a floor the pool cannot meet must still revert.
async function toOther(label, { payToken, amount, outToken, make, dir }) {
  const w = newWallet(), to = newWallet().address;
  await fund(w, payToken, amount);
  if (payToken === ZERO) await rpc('anvil_setBalance', [w.address, hex(amount + 2n * E18)]);
  const { tx, minOut } = await make(w, to);
  if (tx.approval) assert.ok((await send(w.address, { to: tx.approval.token, data: encApprove(tx.approval.spender, tx.approval.amount) })).ok, `${label}: approve`);
  const lo = await leftovers([TAC, WETH]), payerBefore = await balanceOf(outToken, w.address), toBefore = await balanceOf(outToken, to);
  const r = await send(w.address, tx);
  assert.ok(r.ok, `${label}: landed`);
  const got = (await balanceOf(outToken, to)) - toBefore;
  assert.ok(got >= minOut, `${label}: the recipient received ${got}, at least ${minOut}`);
  assert.ok((await balanceOf(outToken, w.address)) <= payerBefore, `${label}: the payer received none of it`);
  const la = await leftovers([TAC, WETH]);
  for (const k of Object.keys(la)) { assert.ok(la[k].pr <= lo[k].pr, `${label}: nothing of ${k} left at PrecisionRoute`); assert.ok(la[k].zr <= lo[k].zr + 1n, `${label}: nothing of ${k} left at zRouter`); }
  ok(`${label}: ${f(got, 18, outToken === ZERO ? 6 : 2)} ${outToken === ZERO ? 'ETH' : 'TAC'} to the other address, the payer none, gas ${r.gas}`);
  return { to, got };
}
const dl30 = async () => (await now()) + 1800n;
const slip = (x) => (x * 9950n) / 10000n;
await toOther('ETH → TAC (Precision) to another address', { payToken: ZERO, amount: E18 / 10n, outToken: TAC, make: async (w, to) => {
  const q = await venues.quotePrecision({ dir: 'ETH_TO_TAC', amountIn: E18 / 10n, account: w.address }), minOut = slip(BigInt(q.amountOut));
  return { tx: venues.build({ quote: q, dir: 'ETH_TO_TAC', account: w.address, to, minOut, deadline: await dl30() }), minOut };
} });
await toOther('ETH → TAC (Tacit pool) to another address', { payToken: ZERO, amount: E18 / 10n, outToken: TAC, make: async (w, to) => {
  const q = await venues.quoteTacitAmm({ dir: 'ETH_TO_TAC', amountIn: E18 / 10n }), minOut = slip(BigInt(q.amountOut));
  return { tx: venues.build({ quote: q, dir: 'ETH_TO_TAC', account: w.address, to, minOut, deadline: await dl30() }), minOut };
} });
async function splitCase(dir, payToken, outToken, sizes, fundOf) {
  for (const size of sizes) {
    const probe = await venues.quoteSplit({ dir, amountIn: size, account: '0x1111111111111111111111111111111111111111' }).catch(() => null);
    if (!probe) continue;
    return toOther(`${dir === 'ETH_TO_TAC' ? 'ETH → TAC' : 'TAC → ETH'} (both pools) to another address`, { payToken, amount: fundOf(size), outToken, make: async (w, to) => {
      const split = await venues.quoteSplit({ dir, amountIn: size, account: w.address }), minOut = slip(BigInt(split.amountOut));
      return { tx: venues.buildSplit({ split, account: w.address, to, minOut, deadline: await dl30() }), minOut };
    } });
  }
  console.log(`  skip - a split to another address (${dir}): no split worth quoting at these sizes right now`);
}
await splitCase('ETH_TO_TAC', ZERO, TAC, [3n * E18, 10n * E18], (x) => x);
await toOther('TAC → ETH (Precision) to another address', { payToken: TAC, amount: 2000n * E18, outToken: ZERO, make: async (w, to) => {
  const q = await venues.quotePrecision({ dir: 'TAC_TO_ETH', amountIn: 2000n * E18, account: w.address }), minOut = slip(BigInt(q.amountOut));
  return { tx: venues.build({ quote: q, dir: 'TAC_TO_ETH', account: w.address, to, minOut, deadline: await dl30() }), minOut };
} });
await toOther('TAC → ETH (Tacit pool) to another address', { payToken: TAC, amount: 2000n * E18, outToken: ZERO, make: async (w, to) => {
  const q = await venues.quoteTacitAmm({ dir: 'TAC_TO_ETH', amountIn: 2000n * E18 }), minOut = slip(BigInt(q.amountOut));
  return { tx: venues.build({ quote: q, dir: 'TAC_TO_ETH', account: w.address, to, minOut, deadline: await dl30() }), minOut };
} });
await splitCase('TAC_TO_ETH', TAC, ZERO, [40000n * E18, 150000n * E18], (x) => x);
await anyToTac('USDC', 500n * 10n ** 6n, 'permit', newWallet().address);
await anyToTac('WETH', E18 / 4n, 'approve', newWallet().address);
await anyToTac('WETH', E18 / 3n, 'permit2', newWallet().address);
await amm('tacUSD', 'buy', E18 / 50n, null, newWallet().address);
await amm('tacUSD', 'sell', 20n * E18, 'permit', newWallet().address);
await amm('tacBTC', 'sell', E18 / 10000n, 'approve', newWallet().address);
// a floor the pool cannot meet reverts with another recipient too (the builders in venues refuse to build one, so the page's own AMM route is used)
{
  const w = newWallet(), to = newWallet().address;
  await fund(w, ZERO, E18 / 10n);
  const q = await quoteAmm({ ethCall, tokenIn: ZERO, tokenOut: CUSD, amountIn: E18 / 50n });
  const r = await send(w.address, buildAmm({ quote: q, account: w.address, to, minOut: q.amountOut * 2n, deadline: await dl30() }));
  assert.equal(r.ok, false, 'reverts');
  assert.equal(await balanceOf(CUSD, to), 0n, 'the recipient received nothing');
  ok('a floor the pool cannot meet reverts with another recipient too, and the recipient receives nothing');
}

// ── a Tacit asset out to any ERC-20, in one transaction ──
const venuesOnly = (only) => ({ ...venues, route: async (a) => { const rt = await venues.route(a); return { ...rt, r: { ...rt.r, ranked: (rt.r.ranked || []).filter((v) => v.venue === only) } }; } });
async function sellFor(label, { token, out, amount, only = null, how, to = null }) {
  const w = newWallet(), tOut = tok(out), dl = (await now()) + 1800n;
  await fund(w, token, amount);
  const q = await quoteTacitToToken({ ethCall, venues: only ? venuesOnly(only) : venues, tokenIn: token, tokenOut: tOut.addr, amountIn: amount, account: w.address, ...(to ? { to } : {}), deadline: dl });
  assert.ok(q, `${label}: a route`);
  if (only) assert.equal(q.leg.venue, only, `${label}: sold on ${only}`);
  let access;
  if (how === 'permit') {
    const acc = await readAccess({ ethCall, token, owner: w.address });
    access = { kind: 'permit', value: q.amountIn, deadline: dl, ...splitSig(sign(w, permitTyped({ token, name: 'Tacit Token', version: '1', owner: w.address, spender: ZROUTER, value: q.amountIn, nonce: acc.nonce, deadline: dl }))) };
  } else { assert.ok((await send(w.address, { to: token, data: encApprove(ZROUTER, q.amountIn) })).ok, `${label}: approve`); access = { kind: 'approved' }; }
  const tx = buildTacitToToken({ quote: q, account: w.address, ...(to ? { to } : {}), venues, access });
  const holder = to || w.address, before = await balanceOf(tOut.addr, holder), wethBefore = await balanceOf(WETH, holder), lo = await leftovers([token, tOut.addr, WETH]);
  const r = await send(w.address, tx);
  assert.ok(r.ok, `${label}: the transaction landed`);
  const got = (await balanceOf(tOut.addr, holder)) - before, spent = amount - (await balanceOf(token, w.address));
  assert.ok(got >= q.min, `${label}: ${got} received, at least the floor ${q.min}`);
  if (q.hop) {
    assert.ok(got * 1000n >= q.out * 995n && got * 1000n <= q.out * 1005n, `${label}: what the screen shows (${q.out}) is what arrives (${got})`);
    const rest = (await balanceOf(WETH, holder)) - wethBefore;
    assert.ok(q.rest > 0n && rest >= q.rest - q.rest / 10n, `${label}: the WETH the sale did not sell (${rest}, shown ${q.rest}) went to the recipient`);
    if (to) assert.equal(await balanceOf(WETH, w.address), 0n, `${label}: the payer got none of it`);
  }
  assert.equal(spent, q.amountIn, `${label}: exactly the quoted amount was sold`);
  if (to) assert.equal(await balanceOf(tOut.addr, w.address), 0n, `${label}: the payer received none of the output`);
  const la = await leftovers([token, tOut.addr, WETH]);
  for (const k of Object.keys(la)) { assert.ok(la[k].pr <= lo[k].pr, `${label}: nothing of ${k} left at PrecisionRoute`); assert.ok(la[k].zr <= lo[k].zr, `${label}: nothing of ${k} left at zRouter`); assert.ok(la[k].ar <= lo[k].ar, `${label}: nothing of ${k} left at TacitAmmRoute`); }
  ok(`${label}: ${f(spent)} → ${f(got, tOut.dec, tOut.dec > 8 ? 4 : 6)} ${out}${to ? ' to another address' : ''} (quoted ${f(q.out, tOut.dec, tOut.dec > 8 ? 4 : 6)}, floor ${f(q.min, tOut.dec, tOut.dec > 8 ? 4 : 6)}${q.hop ? `, via ${q.hop.name}` : ''}), gas ${r.gas}`);
}
await sellFor('TAC → USDC (Precision) by permit', { token: TAC, out: 'USDC', amount: 20000n * E18, only: 'precision', how: 'permit' });
await sellFor('TAC → USDC (Tacit pool) by approval', { token: TAC, out: 'USDC', amount: 20000n * E18, only: 'tacit-amm', how: 'approve' });
await sellFor('TAC → USDC (the better pool) to another address', { token: TAC, out: 'USDC', amount: 5000n * E18, how: 'permit', to: newWallet().address });
await sellFor('TAC → WETH', { token: TAC, out: 'WETH', amount: 20000n * E18, how: 'approve' });
await sellFor('tacUSD → USDC by permit', { token: CUSD, out: 'USDC', amount: 100n * E18, how: 'permit' });
await sellFor('tacBTC → WBTC by approval', { token: CBTC, out: 'WBTC', amount: E18 / 5000n, how: 'approve' });
// without the allowance it reverts and moves nothing
{
  const w = newWallet(), dl = (await now()) + 1800n, amount = 5000n * E18;
  await fund(w, TAC, amount);
  const q = await quoteTacitToToken({ ethCall, venues, tokenIn: TAC, tokenOut: tok('USDC').addr, amountIn: amount, account: w.address, deadline: dl });
  const r = await send(w.address, buildTacitToToken({ quote: q, account: w.address, venues, access: { kind: 'approved' } }));
  assert.equal(r.ok, false, 'reverts');
  assert.equal(await balanceOf(TAC, w.address), amount, 'nothing was sold');
  ok('a sale zRouter has no allowance for reverts and moves nothing');
}

// ── any ERC-20 into tacUSD and tacBTC, in one transaction, through TacitAmmRoute ──
async function buyTacit(label, { sym, out, amount, how, to = null }) {
  const t = tok(sym), w = newWallet(), tOut = tok(out), dl = (await now()) + 1800n;
  await fund(w, t.addr, amount);
  const q = await quoteTokenToTacit({ ethCall, token: t.addr, tokenOut: tOut.addr, amountIn: amount, account: w.address, ...(to ? { to } : {}), deadline: dl });
  assert.ok(q, `${label}: a route`);
  assert.ok(q.maxIn <= amount, `${label}: the most spent (${q.maxIn}) is inside the amount (${amount})`);
  const acc = await readAccess({ ethCall, token: t.addr, owner: w.address });
  let access;
  if (how === 'permit') access = { kind: 'permit', value: q.maxIn, deadline: dl, ...splitSig(sign(w, permitTyped({ token: t.addr, name: (await readToken({ ethCall, keccak256: keccak_256, address: t.addr })).name, version: t.permit, owner: w.address, spender: ZROUTER, value: q.maxIn, nonce: acc.nonce, deadline: dl }))) };
  else if (how === 'dai') access = { kind: 'dai', nonce: acc.nonce, expiry: dl, ...splitSig(sign(w, daiPermitTyped({ owner: w.address, nonce: acc.nonce, expiry: dl }))) };
  else if (how === 'permit2') {
    assert.ok((await send(w.address, { to: t.addr, data: encApprove(PERMIT2, (1n << 256n) - 1n) })).ok, 'approve Permit2');
    const nonce = randomNonce();
    access = { kind: 'permit2', nonce, deadline: dl, signature: sign(w, permit2Typed({ token: t.addr, amount: q.maxIn, nonce, deadline: dl })) };
  } else {
    if (sym === 'USDT' && acc.allowed) await send(w.address, { to: t.addr, data: encApprove(ZROUTER, 0n) });
    assert.ok((await send(w.address, { to: t.addr, data: encApprove(ZROUTER, q.maxIn) })).ok, `${label}: approve`);
    access = { kind: 'approved' };
  }
  const minOut = (q.out * 9950n) / 10000n, tx = buildTokenToTacit({ quote: q, account: w.address, ...(to ? { to } : {}), minOut, access });
  const holder = to || w.address, before = await balanceOf(tOut.addr, holder), lo = await leftovers([t.addr, WETH, tOut.addr]);
  const r = await send(w.address, tx);
  return { w, q, r, t, tOut, holder, before, lo, minOut, label, amount, to, how, tx };
}
async function bought(c) {
  const { w, q, r, t, tOut, holder, before, lo, minOut, label, amount, to, how, tx } = c;
  if (!r.ok) { const why = await rpc('eth_call', [{ from: w.address, to: tx.to, data: tx.data, gas: hex(3_000_000) }, 'latest']).then(() => 'no revert on a replay', (e) => `${e.message} ${e.data || ''}`); const walk = (n, d = 0) => (n.error || n.revertReason ? [`${' '.repeat(d)}${n.type} ${n.to} ${String(n.input || '').slice(0, 10)} -> ${n.error || ''} ${n.revertReason || ''} ${String(n.output || '').slice(0, 10)}`] : []).concat(...(n.calls || []).map((x) => walk(x, d + 1))); let path = ''; try { path = '\n' + walk(await rpc('debug_traceTransaction', [r.hash, { tracer: 'callTracer' }])).join('\n'); } catch (e) { path = ' (no trace: ' + e.message + ')'; } assert.fail(`${label}: the transaction reverted: ${why}${path}`); }
  const got = (await balanceOf(tOut.addr, holder)) - before, spent = amount - (await balanceOf(t.addr, w.address));
  assert.ok(got >= minOut, `${label}: ${got} received, at least the floor ${minOut}`);
  assert.ok(spent <= q.maxIn && spent <= amount, `${label}: spent ${spent} within ${q.maxIn}`);
  if (to) assert.equal(await balanceOf(tOut.addr, w.address), 0n, `${label}: the payer received none of the output`);
  const la = await leftovers([t.addr, WETH, tOut.addr]);
  for (const k of Object.keys(la)) { assert.ok(la[k].pr <= lo[k].pr, `${label}: nothing of ${k} left at PrecisionRoute`); assert.ok(la[k].zr <= lo[k].zr, `${label}: nothing of ${k} left at zRouter`); assert.ok(la[k].ar <= lo[k].ar, `${label}: nothing of ${k} left at TacitAmmRoute`); }
  ok(`${label}: ${f(spent, t.dec, 4)} ${t.sym} → ${f(got, 18, 4)} ${tOut.sym}${to ? ' to another address' : ''} (floor ${f(minOut, 18, 4)}, via ${q.hop.name}), gas ${r.gas}`);
}
assert.ok(ammRouteAddressMatches(), `the compiled TacitAmmRoute lands at the address route.js names (${ammRouteAddress()})`);
ok('the compiled TacitAmmRoute lands at the address route.js names');
if ((await ammRouteLive({ ethCall })) !== true) {
  assert.equal(await ammRouteLive({ ethCall }), false, 'TacitAmmRoute is not on chain yet');
  ok('TacitAmmRoute is not deployed: the route is not offered');
  const c = await buyTacit('USDC → tacUSD before TacitAmmRoute is deployed', { sym: 'USDC', out: 'tacUSD', amount: 150n * 10n ** 6n, how: 'permit' });
  assert.equal(c.r.ok, false, 'reverts while it is not deployed');
  assert.equal(await balanceOf(CUSD, c.w.address), 0n, 'nothing was bought');
  ok('without it the transaction reverts and nothing is bought');
  const d = newWallet(); await fund(d, null, 0n);
  assert.ok((await send(d.address, ammRouteDeployTx())).ok, 'the proxy deploys it');
  assert.equal(await ammRouteLive({ ethCall }), true, 'TacitAmmRoute now answers');
  ok('after TacitAmmRoute is deployed, the route reads as available');
}
await bought(await buyTacit('USDC → tacUSD by permit', { sym: 'USDC', out: 'tacUSD', amount: 150n * 10n ** 6n, how: 'permit' }));
await bought(await buyTacit('USDT → tacBTC by approval', { sym: 'USDT', out: 'tacBTC', amount: 200n * 10n ** 6n, how: 'approve' }));
await bought(await buyTacit('DAI → tacUSD by its permit', { sym: 'DAI', out: 'tacUSD', amount: 120n * E18, how: 'dai' }));
await bought(await buyTacit('USDC → tacBTC by Permit2', { sym: 'USDC', out: 'tacBTC', amount: 300n * 10n ** 6n, how: 'permit2' }));
await bought(await buyTacit('wstETH → tacUSD by permit', { sym: 'wstETH', out: 'tacUSD', amount: E18 / 50n, how: 'permit' }));
await bought(await buyTacit('USDC → tacUSD to another address', { sym: 'USDC', out: 'tacUSD', amount: 150n * 10n ** 6n, how: 'permit', to: newWallet().address }));

console.log(`\n${n} passed`);
process.exit(0);
