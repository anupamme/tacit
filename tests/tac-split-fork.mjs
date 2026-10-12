#!/usr/bin/env node
// Runs the split route (dapp/evm-trade-venues.js) against an anvil fork of Ethereum mainnet and measures what a fresh account
// actually receives: TAC for ETH and ETH for TAC, single venue against split, at several sizes. Needs foundry (`anvil`, `cast`)
// and a mainnet RPC that serves state (default: Tenderly's public gateway). Nothing leaves the fork.
//
//   node tests/tac-split-fork.mjs                  # FORK=<rpc url>  PORT=8611  to override
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  ZERO_ADDR, TAC_ERC20, ZROUTER, MULTICALL3, SAFE_EXECUTOR, PRECISION_POOL, TACIT_AMM, makeEvmTradeVenues,
} from '../dapp/evm-trade-venues.js';

const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', PORT = Number(process.env.PORT || 8611), URL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data });
  return j.result;
}
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const hex = (v) => '0x' + BigInt(v).toString(16);
const E18 = 10n ** 18n;
const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: o.value } : {}), ...(o.gas ? { gas: o.gas } : {}) }, block]);
const keccak = (b) => keccak_256(b);
const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak });
const balanceOf = async (token, who) => BigInt(await ethCall(token, '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0')));
const ethBal = async (who) => BigInt(await rpc('eth_getBalance', [who, 'latest']));
const cast = (...args) => execFileSync('cast', args, { encoding: 'utf8' }).trim();

// A fresh account: the anvil keys carry sweeper code on mainnet, which forwards ETH on before a test can count it.
const newWallet = () => { const o = cast('wallet', 'new', '--json'); const j = JSON.parse(o)[0]; return { address: j.address, key: j.private_key }; };
async function fund(who, eth, tac) {
  await rpc('anvil_impersonateAccount', [who]);
  await rpc('anvil_setBalance', [who, hex(eth)]);
  if (tac) {
    // Solady ERC20 balance slot: keccak256(owner (20 bytes) ++ 8 zero bytes ++ 0x87a211a2)
    const slot = '0x' + Buffer.from(keccak_256(Buffer.from(who.slice(2).toLowerCase() + '0000000000000000' + '87a211a2', 'hex'))).toString('hex');
    await rpc('anvil_setStorageAt', [TAC_ERC20, slot, '0x' + tac.toString(16).padStart(64, '0')]);
    assert.equal(await balanceOf(TAC_ERC20, who), tac, 'TAC credited');
  }
}
async function send(from, tx) {
  const h = await rpc('eth_sendTransaction', [{ from, to: tx.to, data: tx.data, ...(tx.value ? { value: hex(tx.value) } : {}), gas: hex(3_000_000) }]);
  let rc = null;
  for (let i = 0; i < 40 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [h]); if (!rc) await sleep(250); }
  if (!rc) throw new Error(`no receipt for ${h}: ${JSON.stringify(await rpc('eth_getTransactionByHash', [h]))}`);
  return { ok: rc.status === '0x1', gasUsed: BigInt(rc.gasUsed), gasPrice: BigInt(rc.effectiveGasPrice), hash: h };
}
async function reverts(from, tx) { try { await ethCall(tx.to, tx.data, 'latest', { from, ...(tx.value ? { value: hex(tx.value) } : {}) }); return false; } catch { return true; } }
const withSnapshot = async (fn) => { const snap = await rpc('evm_snapshot'); try { return await fn(); } finally { await rpc('evm_revert', [snap]); } };
const pct = (a, b) => (b === 0n ? '-' : `${(Number((a - b) * 1000000n / b) / 10000).toFixed(3)}%`);
const f = (x, d = 4) => (Number(x) / 1e18).toFixed(d);

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const rows = [];
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const stash = async () => ({ mc: await balanceOf(TAC_ERC20, MULTICALL3), mce: await ethBal(MULTICALL3), zr: await ethBal(ZROUTER), zrt: await balanceOf(TAC_ERC20, ZROUTER), se: await ethBal(SAFE_EXECUTOR) });

// ── ETH → TAC ──
for (const eth of [E18 / 50n, E18 / 10n, E18 / 2n, 2n * E18]) {
  const w = newWallet();
  await fund(w.address, 10n * E18);
  const dir = 'ETH_TO_TAC';
  const all = await venues.quoteAll({ dir, amountIn: eth, account: w.address, includeZQuoter: false });
  const split = await venues.quoteSplit({ dir, amountIn: eth, account: w.address });
  assert.ok(all.best, 'a single venue quotes');
  const singleTx = venues.build({ quote: all.best, dir, account: w.address, slippageBps: 50, deadline });
  const before = await stash();
  const single = await withSnapshot(async () => { const t0 = await balanceOf(TAC_ERC20, w.address); const r = await send(w.address, singleTx); assert.ok(r.ok, 'single venue tx succeeds'); return { out: (await balanceOf(TAC_ERC20, w.address)) - t0, gas: r.gasUsed }; });
  if (!split) { rows.push([`${f(eth, 2)} ETH`, f(single.out, 2), '(no split pays more)', '-', single.gas, '-']); continue; }
  const splitTx = venues.buildSplit({ split, account: w.address, slippageBps: 50, deadline });
  const res = await withSnapshot(async () => {
    assert.ok(!(await reverts(w.address, splitTx)), 'the split simulates clean');
    const t0 = await balanceOf(TAC_ERC20, w.address), e0 = await ethBal(w.address);
    const r = await send(w.address, splitTx); assert.ok(r.ok, 'split tx succeeds');
    const out = (await balanceOf(TAC_ERC20, w.address)) - t0, spent = e0 - (await ethBal(w.address)) - r.gasUsed * r.gasPrice;
    return { out, spent, gas: r.gasUsed };
  });
  assert.equal(res.spent, eth, 'exactly the order was spent: no ETH left behind in the router or Multicall3');
  assert.ok(res.out >= split.amountOut * 9999n / 10000n && res.out <= split.amountOut * 10001n / 10000n, `received ${res.out} vs quoted ${split.amountOut}`);
  assert.ok(res.out > single.out, `the split pays more than the best single venue (${res.out} vs ${single.out})`);
  const after = await stash();
  assert.deepEqual(after, before, 'the router, Multicall3 and SafeExecutor hold nothing new');
  assert.ok(await reverts(w.address, { ...splitTx, value: splitTx.value + 1n }), 'a wrong msg.value reverts');
  assert.ok(await reverts(w.address, venues.buildSplit({ split, account: w.address, deadline: 1n })), 'an expired deadline reverts');
  assert.ok(await reverts(w.address, venues.buildSplit({ split: { ...split, amountOut: split.amountOut * 2n }, account: w.address, deadline })), 'a floor the bundle cannot meet reverts');
  const planned = await venues.plan({ dir, amountIn: eth, account: w.address, deadline, verify: true });
  rows.push([`${f(eth, 2)} ETH`, f(single.out, 2), f(res.out, 2), pct(res.out, single.out), single.gas, res.gas, `${Number(split.shareBps) / 100}% Precision`, planned.kind]);
}
ok('ETH to TAC: the split delivers its quote (within 0.01%), beats the best single venue, spends exactly the order, leaves nothing in the router or Multicall3, and reverts on a wrong value, an expired deadline or an unmeetable floor');

// ── TAC → ETH (approval, then a permit) ──
for (const tac of [2000n * E18, 5000n * E18, 12000n * E18]) {
  const w = newWallet();
  await fund(w.address, 5n * E18, 40000n * E18);
  const dir = 'TAC_TO_ETH';
  const all = await venues.quoteAll({ dir, amountIn: tac, account: w.address, includeZQuoter: false });
  const split = await venues.quoteSplit({ dir, amountIn: tac, account: w.address });
  assert.ok(all.best, 'a single venue quotes');
  const run = async (tx, permitFlow) => withSnapshot(async () => {
    if (tx.approval) { const r = await send(w.address, { to: tx.approval.token, data: '0x095ea7b3' + tx.approval.spender.slice(2).toLowerCase().padStart(64, '0') + tx.approval.amount.toString(16).padStart(64, '0') }); assert.ok(r.ok); }
    const e0 = await ethBal(w.address), t0 = await balanceOf(TAC_ERC20, w.address);
    const r = await send(w.address, tx); assert.ok(r.ok, 'tx succeeds');
    return { out: (await ethBal(w.address)) - e0 + r.gasUsed * r.gasPrice, tacSpent: t0 - (await balanceOf(TAC_ERC20, w.address)), gas: r.gasUsed };
  });
  const singleTx = venues.build({ quote: all.best, dir, account: w.address, slippageBps: 50, deadline });
  const single = await run(singleTx);
  if (!split) { rows.push([`${f(tac, 0)} TAC`, f(single.out, 5), '(no split pays more)', '-', single.gas, '-']); continue; }
  const splitTx = venues.buildSplit({ split, account: w.address, slippageBps: 50, deadline });
  const before = await stash();
  const res = await run(splitTx);
  assert.equal(res.tacSpent, tac, 'exactly the TAC order was spent');
  assert.ok(res.out >= split.amountOut * 9999n / 10000n && res.out <= split.amountOut * 10001n / 10000n, `received ${res.out} vs quoted ${split.amountOut}`);
  assert.ok(res.out > single.out, `the split pays more than the best single venue (${res.out} vs ${single.out})`);
  assert.deepEqual(await stash(), before, 'the router, Multicall3 and SafeExecutor hold nothing new');
  const noApproval = await withSnapshot(async () => reverts(w.address, splitTx));
  assert.ok(noApproval, 'without the approval it reverts');
  // the same order through an EIP-2612 permit instead of an approval
  const typed = JSON.stringify({
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit', domain: { name: 'Tacit Token', version: '1', chainId: 1, verifyingContract: TAC_ERC20 },
    message: { owner: w.address, spender: ZROUTER, value: tac.toString(), nonce: '0', deadline: deadline.toString() } });
  const sig = cast('wallet', 'sign', '--private-key', w.key, '--data', typed);
  const permit = { value: tac, deadline, v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) };
  const permitTx = venues.buildSplit({ split, account: w.address, slippageBps: 50, deadline, permit });
  assert.equal(permitTx.approval, null);
  const viaPermit = await run(permitTx);
  assert.equal(viaPermit.tacSpent, tac);
  assert.ok(viaPermit.out >= split.amountOut * 9999n / 10000n, 'the permit route pays the same');
  rows.push([`${f(tac, 0)} TAC`, f(single.out, 5), f(res.out, 5), pct(res.out, single.out), single.gas, res.gas, `${Number(split.shareBps) / 100}% Precision`, '']);
}
ok('TAC to ETH: the split (approval and EIP-2612 permit) delivers its quote, beats the best single venue, spends exactly the order, leaves nothing behind, and reverts without the approval');

console.log('\n  size           single      split       gain      gas single  gas split  allocation');
for (const r of rows) console.log('  ' + [String(r[0]).padEnd(13), String(r[1]).padEnd(11), String(r[2]).padEnd(11), String(r[3]).padEnd(9), String(r[4]).padEnd(11), String(r[5]).padEnd(10), r[6] || ''].join(' '));
console.log(`\n${n} tac-split-fork checks passed`);
anvil.kill('SIGKILL');
