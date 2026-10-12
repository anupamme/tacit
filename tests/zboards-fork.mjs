#!/usr/bin/env node
// dapp/zboards.js against an anvil fork of Ethereum mainnet: TAC orders are placed on all four zSwap boards from fresh accounts, read back
// as an order book, and filled through refine + buildFill (buys with ETH, sells with an approval and with an EIP-2612 permit), then the clock
// is moved to see an order expire and Dutchboard's price fall. Needs foundry (`anvil`, `cast`) and a mainnet RPC that serves state (default:
// Tenderly's public gateway). Nothing leaves the fork.
//
//   node tests/zboards-fork.mjs                    # FORK=<rpc url>  PORT=8612  to override
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3';
import { ZB, readBook, planBuy, planSell, refine, buildFill } from '../dapp/zboards.js';

const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', Z = '0x0000000000000000000000000000000000000000';
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', PORT = Number(process.env.PORT || 8612), URL = `http://127.0.0.1:${PORT}`;
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
const E18 = 10n ** 18n, tac = (n) => BigInt(n) * E18, eth = (milli) => BigInt(milli) * 10n ** 15n;   // eth(10) is 0.01 ETH
const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: o.value } : {}) }, block]);
const balanceOf = async (token, who) => BigInt(await ethCall(token, '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0')));
const ethBal = async (who) => BigInt(await rpc('eth_getBalance', [who, 'latest']));
const cast = (...args) => execFileSync('cast', args, { encoding: 'utf8' }).trim();
const newWallet = () => { const j = JSON.parse(cast('wallet', 'new', '--json'))[0]; return { address: j.address, key: j.private_key }; };
async function fund(who, ethWei, tacWei) {
  await rpc('anvil_impersonateAccount', [who]);
  await rpc('anvil_setBalance', [who, hex(ethWei)]);
  if (tacWei) {
    const slot = '0x' + Buffer.from(keccak_256(Buffer.from(who.slice(2).toLowerCase() + '0000000000000000' + '87a211a2', 'hex'))).toString('hex');
    await rpc('anvil_setStorageAt', [TAC, slot, '0x' + tacWei.toString(16).padStart(64, '0')]);
    assert.equal(await balanceOf(TAC, who), tacWei, 'TAC credited');
  }
}
async function send(from, tx) {
  const h = await rpc('eth_sendTransaction', [{ from, to: tx.to, data: tx.data, ...(tx.value ? { value: hex(tx.value) } : {}), gas: hex(3_000_000) }]);
  let rc = null;
  for (let i = 0; i < 40 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [h]); if (!rc) await sleep(250); }
  if (!rc) throw new Error(`no receipt for ${h}`);
  return { ok: rc.status === '0x1', gasUsed: BigInt(rc.gasUsed), gasPrice: BigInt(rc.effectiveGasPrice), hash: h };
}
async function reverts(from, tx) { try { await ethCall(tx.to, tx.data, 'latest', { from, ...(tx.value ? { value: hex(tx.value) } : {}) }); return false; } catch { return true; } }
const withSnapshot = async (fn) => { const snap = await rpc('evm_snapshot'); try { return await fn(); } finally { await rpc('evm_revert', [snap]); } };
const chainNow = async () => Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));
const advance = async (secs) => { await rpc('evm_increaseTime', [secs]); await rpc('evm_mine'); };
const enc = (sig, ...args) => cast('calldata', sig, ...args.map(String));
const run = async (from, to, sig, args = [], value = 0n) => { const r = await send(from, { to, data: enc(sig, ...args), value }); assert.ok(r.ok, `${sig} succeeds`); return r; };
const approve = (from, token, spender, amt) => run(from, token, 'approve(address,uint256)', [spender, amt]);
const nextId = async (board, sig) => BigInt(await ethCall(board, cast('sig', sig)));
const stash = async () => ({ zr: await ethBal(ZB.ZROUTER), zrt: await balanceOf(TAC, ZB.ZROUTER), sb: await ethBal(ZB.SWAPBOL), sbt: await balanceOf(TAC, ZB.SWAPBOL), sbw: await balanceOf(ZB.WETH, ZB.SWAPBOL), zrw: await balanceOf(ZB.WETH, ZB.ZROUTER) });
const near = (got, want, tol = 0.01) => Math.abs(got / want - 1) < tol;
const readTheBook = async (now) => readBook({ ethCall, base: TAC, now: now ?? (await chainNow()) });

// A fork that has just started reads each contract from the upstream node on first use; a read that fails then looks like a board that does not answer.
for (let i = 0; ; i++) {
  const b = await readBook({ ethCall, base: TAC, now: await chainNow() }).catch(() => null);
  if (b?.answered === 8) break;
  if (i >= 12) throw new Error('the fork never answered every board view');
  await sleep(4000);
}

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };

// ── fresh makers, each placing one TAC order ──
const names = ['a1', 'a2', 'a2x', 'a3', 'b1', 'b2', 'b3', 'b4', 'priv', 'cp'];
const m = {}; for (const k of names) { m[k] = newWallet(); await fund(m[k].address, 100n * E18, tac(1_000_000)); }
const mine = new Set(Object.values(m).map((x) => x.address.toLowerCase()));
const own = (o) => mine.has(o.maker.toLowerCase());
const t0now = await chainNow();
// ids come from the boards' counters, in the order the orders are placed below: v1 a1, b1; v2 a2, a2x, b2, priv; Dutchboard a3, b3; Floorboard b4
const ids = { a1: await nextId(ZB.V1, 'nextOrderId()'), a2: await nextId(ZB.V2, 'nextOrderId()'), a3: await nextId(ZB.DUTCH, 'nextId()'), b4: await nextId(ZB.FLOOR, 'nextId()') };
ids.b1 = ids.a1 + 1n; ids.b2 = ids.a2 + 2n; ids.b3 = ids.a3 + 1n;
// asks: v1 1000 TAC for 0.01 ETH (1e-5); v2 2000 for 0.04 (2e-5, partial); v2 500 for 0.02 expiring in 30 min (4e-5); Dutch 1000 falling 0.03 → 0.01 ETH over an hour
await approve(m.a1.address, TAC, ZB.V1, tac(1000));
await run(m.a1.address, ZB.V1, 'createOrder(address,uint256,address,uint256)', [TAC, tac(1000), ZB.WETH, eth(10)]);
await approve(m.a2.address, TAC, ZB.V2, tac(2000));
await run(m.a2.address, ZB.V2, 'createOrder(address,uint256,address,uint256,bool,uint64,bool,bool,address)', [TAC, tac(2000), ZB.WETH, eth(40), true, 0, false, false, Z]);
await approve(m.a2x.address, TAC, ZB.V2, tac(500));
await run(m.a2x.address, ZB.V2, 'createOrder(address,uint256,address,uint256,bool,uint64,bool,bool,address)', [TAC, tac(500), ZB.WETH, eth(20), true, t0now + 1800, false, false, Z]);
await approve(m.a3.address, TAC, ZB.DUTCH, tac(1000));
await run(m.a3.address, ZB.DUTCH, 'listERC20(address,address,uint128,uint256,uint256,uint40,uint40,uint40)', [TAC, Z, tac(1000), eth(30), eth(10), 0, 3600, 0]);
// bids: v1 0.02 ETH for 1000 TAC (2e-5); v2 0.015 ETH for 1000 (1.5e-5, partial); Dutch 0.01 ETH lot priced 2000 → 1000 TAC; Floor 1000 TAC climbing 0.005 → 0.01 ETH
await run(m.b1.address, ZB.V1, 'createOrderWithEth(address,uint256)', [TAC, tac(1000)], eth(20));
await run(m.b2.address, ZB.V2, 'createOrderWithEth(address,uint256,bool,uint64,bool,address)', [TAC, tac(1000), true, 0, false, Z], eth(15));
await run(m.b3.address, ZB.DUTCH, 'listETH(address,uint256,uint256,uint40,uint40,uint40)', [TAC, tac(2000), tac(1000), 0, 3600, 0], eth(10));
await run(m.b4.address, ZB.FLOOR, 'bid((address,address,uint128,uint256,uint256,uint40,uint40,bool,uint256[]))', [`(${TAC},${Z},${tac(1000)},${eth(5)},${eth(10)},0,3600,false,[])`], eth(10));
// an order addressed to one account: the public book must not offer it
await approve(m.priv.address, TAC, ZB.V2, tac(100));
await run(m.priv.address, ZB.V2, 'createOrder(address,uint256,address,uint256,bool,uint64,bool,bool,address)', [TAC, tac(100), ZB.WETH, eth(1), true, 0, false, false, m.cp.address]);

// ── reading ──
const book = await readTheBook();
{
  assert.equal(book.answered, 8); assert.equal(book.partial, false);
  const pick = (list, key) => { const o = list.find((x) => x.key === key); assert.ok(o, `${key} is in the book`); return o; };
  const a1 = pick(book.asks, `v1:${ids.a1}`), a2 = pick(book.asks, `v2:${ids.a2}`), a3 = pick(book.asks, `dutch:${ids.a3}`), a2x = pick(book.asks, `v2:${ids.a2 + 1n}`);
  assert.equal(a1.base, tac(1000)); assert.equal(a1.quote, eth(10)); assert.ok(near(a1.price, 1e-5, 1e-9), `a1 price ${a1.price}`); assert.equal(a1.partial, false); assert.equal(a1.side, 'ask');
  assert.equal(a2.base, tac(2000)); assert.equal(a2.quote, eth(40)); assert.ok(near(a2.price, 2e-5, 1e-9), `a2 price ${a2.price}`); assert.equal(a2.partial, true);
  assert.equal(a2x.base, tac(500)); assert.ok(near(a2x.price, 4e-5, 1e-9), `a2x price ${a2x.price}`); assert.equal(a2x.expiry, t0now + 1800);
  assert.equal(a3.base, tac(1000)); assert.ok(a3.quote <= eth(30) && a3.quote >= eth(29), `a Dutchboard lot starts near its top price (${a3.quote})`); assert.ok(a3.partial);
  const b1 = pick(book.bids, `v1:${ids.b1}`), b2 = pick(book.bids, `v2:${ids.b2}`), b3 = pick(book.bids, `dutch:${ids.b3}`), b4 = pick(book.bids, `floor:${ids.b4}`);
  assert.equal(b1.base, tac(1000)); assert.equal(b1.quote, eth(20)); assert.ok(near(b1.price, 2e-5, 1e-9), `b1 price ${b1.price}`); assert.equal(b1.side, 'bid');
  assert.equal(b2.base, tac(1000)); assert.equal(b2.quote, eth(15)); assert.ok(near(b2.price, 1.5e-5, 1e-9), `b2 price ${b2.price}`); assert.equal(b2.partial, true);
  assert.equal(b3.quote, eth(10)); assert.ok(near(Number(b3.base), 2000e18, 0.01), `the Dutch bid wants about 2000 TAC for its ETH at the start (${b3.base})`);
  assert.equal(b4.base, tac(1000)); assert.ok(b4.quote >= eth(5) && b4.quote < eth(6), `a Floorboard bid starts near its low price (${b4.quote})`); assert.ok(b4.partial);
  assert.ok(near(b3.price, 5e-6, 0.02) && near(b4.price, 5e-6, 0.05), 'the climbing bids start near 5e-6 ETH per TAC');
  ok('orders on all four boards, both sides, read back with their amounts, prices, partial flags and expiry');
  assert.ok(!book.asks.some((o) => o.maker.toLowerCase() === m.priv.address.toLowerCase()), 'an order addressed to one account is not in the public book');
  const mineAsks = book.asks.filter(own).map((o) => o.price), mineBids = book.bids.filter(own).map((o) => o.price);
  assert.deepEqual(mineAsks, [...mineAsks].sort((x, y) => x - y)); assert.deepEqual(mineBids, [...mineBids].sort((x, y) => y - x));
  ok('asks run cheapest first, bids dearest first, and an order addressed to one account is not offered');
}

// ── buying: ETH in, TAC out ──
const now0 = await chainNow(), deadline = BigInt(now0 + 3600);
{
  const rows = [];
  await withSnapshot(async () => {
    const t = newWallet(); await fund(t.address, 10n * E18);
    const plan = planBuy(book.asks, eth(60), { skip: (o) => !own(o) });
    assert.deepEqual(plan.fills.map((f) => f.order.board), ['v1', 'v2', 'dutch'], 'a 0.06 ETH buy takes v1 whole, v2 whole, and a part of the Dutchboard lot');
    const refined = await refine({ ethCall, plan });
    assert.ok(refined, 'every fill still holds');
    const tx = buildFill({ plan: refined, side: 'buy', token: TAC, account: t.address, deadline, slipBps: 50 });
    assert.ok(!(await reverts(t.address, tx)), 'the fill simulates clean');
    const before = await stash(), tac0 = await balanceOf(TAC, t.address), e0 = await ethBal(t.address);
    const r = await send(t.address, tx); assert.ok(r.ok, 'the fill succeeds');
    const got = (await balanceOf(TAC, t.address)) - tac0, spent = e0 - (await ethBal(t.address)) - r.gasUsed * r.gasPrice;
    assert.ok(got >= tx.minOut, `received ${got} against a floor of ${tx.minOut}`);
    assert.equal(got, refined.get, 'the TAC received is what refine said');
    assert.ok(spent <= tx.value && spent >= refined.pay * 99n / 100n, `spent ${spent} of ${tx.value}`);
    assert.deepEqual(await stash(), before, 'zRouter and Swapbol hold nothing new');
    rows.push(['buy 0.06 ETH, three boards', Number(got) / 1e18, Number(spent) / 1e18, r.gasUsed]);
    const after = await readTheBook();
    assert.ok(!after.asks.some((o) => o.key === `v1:${ids.a1}`) && !after.asks.some((o) => o.key === `v2:${ids.a2}`), 'the two whole fills left the book');
    const left = after.asks.find((o) => o.key === `dutch:${ids.a3}`);
    assert.ok(left && left.base === tac(1000) - plan.fills[2].get || left.base === tac(1000) - refined.fills[2].get, 'the Dutchboard lot shrank by what was taken');
    assert.ok(await reverts(t.address, { ...tx, data: buildFill({ plan: refined, side: 'buy', token: TAC, account: t.address, deadline, slipBps: 50 }).data }), 'the same fill again reverts: the v1 order is gone');
  });
  ok('a buy across v1, v2 and Dutchboard: one transaction, exactly the TAC refine quoted, ETH spent within the value sent, nothing left in zRouter or Swapbol, filled orders gone and the lot reduced');

  await withSnapshot(async () => {
    const t = newWallet(); await fund(t.address, 10n * E18);
    const plan = planBuy(book.asks, eth(15), { skip: (o) => !own(o) });
    assert.equal(plan.fills.length, 2, 'v1 whole and a part of v2');
    const refined = await refine({ ethCall, plan });
    const tx = buildFill({ plan: refined, side: 'buy', token: TAC, account: t.address, deadline });
    const tac0 = await balanceOf(TAC, t.address), r = await send(t.address, tx); assert.ok(r.ok);
    const got = (await balanceOf(TAC, t.address)) - tac0;
    assert.equal(got, refined.get); assert.ok(got >= tx.minOut);
    const after = await readTheBook(), a2 = after.asks.find((o) => o.key === `v2:${ids.a2}`);
    assert.equal(a2.base, tac(2000) - refined.fills[1].get, 'Swapboard v2 kept the unfilled part of the order');
    rows.push(['buy 0.015 ETH, v1 + part of v2', Number(got) / 1e18, null, r.gasUsed]);
  });
  ok('a buy that ends inside a Swapboard v2 order takes a part of it and the rest stays on the board');

  await withSnapshot(async () => {
    const t = newWallet(); await fund(t.address, 10n * E18);
    const plan = planBuy(book.asks, eth(10), { skip: (o) => !own(o) });
    const refined = await refine({ ethCall, plan });
    const good = buildFill({ plan: refined, side: 'buy', token: TAC, account: t.address, deadline });
    assert.ok(await reverts(t.address, buildFill({ plan: refined, side: 'buy', token: TAC, account: t.address, deadline: 1n })), 'an expired deadline reverts');
    assert.ok(await reverts(t.address, { ...good, value: good.value - 1n }), 'a payment short of the fills reverts');
    // v1 has no per-order floor (it fills whole at its price, and the bundle's floor guards it), so the floor is tried on a plan that ends in v2
    const wide = await refine({ ethCall, plan: planBuy(book.asks, eth(15), { skip: (o) => !own(o) }) });
    const greedy = buildFill({ plan: { ...wide, fills: wide.fills.map((f) => ({ ...f, get: f.get * 2n })) }, side: 'buy', token: TAC, account: t.address, deadline });
    assert.ok(await reverts(t.address, greedy), 'a floor the boards cannot meet reverts');
    // someone else takes the v1 order first: the planned transaction then reverts instead of filling something else
    const other = newWallet(); await fund(other.address, 10n * E18);
    await run(other.address, ZB.V1, 'fillOrderWithEth(uint256,uint256)', [ids.a1, 0], eth(10));
    assert.ok(await reverts(t.address, good), 'a plan for an order that was just filled reverts');
    const again = await readTheBook();
    assert.ok(!again.asks.some((o) => o.key === `v1:${ids.a1}`), 'and the next read no longer lists it');
  });
  ok('an expired deadline, a short payment, an unmeetable floor and an order filled by someone else each revert rather than fill wrongly');

  const priv = planBuy(book.asks, eth(60), { skip: (o) => own(o) });
  assert.ok(!priv.fills.some((f) => own(f.order)));
  ok('orders the caller skips are not planned');

  // the page's own estimate against what the chain settled
  console.log('\n  buys:'); for (const r of rows) console.log('   ', r[0].padEnd(34), `got ${r[1].toFixed(2)} TAC`.padEnd(20), r[2] != null ? `spent ${r[2].toFixed(5)} ETH`.padEnd(22) : ''.padEnd(22), `gas ${r[3]}`);
}

// ── selling: TAC in, ETH out ──
{
  const rows = [];
  const plan = planSell(book.bids, tac(4500), { skip: (o) => !own(o) });
  assert.deepEqual([...new Set(plan.fills.map((f) => f.order.board))].sort(), ['dutch', 'floor', 'v1', 'v2'], 'a 4500 TAC sale reaches all four boards');
  await withSnapshot(async () => {
    const t = newWallet(); await fund(t.address, 5n * E18, tac(50_000));
    const refined = await refine({ ethCall, plan });
    assert.ok(refined, 'every fill still holds');
    const tx = buildFill({ plan: refined, side: 'sell', token: TAC, account: t.address, deadline, slipBps: 100 });
    assert.ok(tx.approval && tx.approval.spender === ZB.ZROUTER, 'a sale needs the TAC approved to zRouter');
    assert.ok(await reverts(t.address, tx), 'without the approval it reverts');
    await approve(t.address, TAC, tx.approval.spender, tx.approval.amount);
    assert.ok(!(await reverts(t.address, tx)), 'with it the sale simulates clean');
    const before = await stash(), tac0 = await balanceOf(TAC, t.address), e0 = await ethBal(t.address);
    const r = await send(t.address, tx); assert.ok(r.ok, 'the sale succeeds');
    const spent = tac0 - (await balanceOf(TAC, t.address)), got = (await ethBal(t.address)) - e0 + r.gasUsed * r.gasPrice;
    assert.ok(got >= tx.minOut, `received ${got} against a floor of ${tx.minOut}`);
    assert.ok(spent <= refined.pay && spent >= refined.pay * 99n / 100n, `delivered ${spent} of ${refined.pay}`);
    assert.ok(near(Number(got), Number(refined.get), 0.01), `received ${got} against ${refined.get} quoted`);
    assert.deepEqual(await stash(), before, 'zRouter and Swapbol hold nothing new');
    assert.equal(await balanceOf(TAC, t.address), tac(50_000) - spent, 'every TAC not delivered is still the taker\'s');
    rows.push(['sell 4500 TAC, four boards (approval)', Number(spent) / 1e18, Number(got) / 1e18, r.gasUsed]);
    const after = await readTheBook();
    assert.ok(!after.bids.some((o) => o.key === `v1:${ids.b1}`), 'the v1 bid is filled and gone');
  });
  ok('a sale across v1, v2, Dutchboard and Floorboard bids: needs the approval, delivers the TAC the plan said, receives at least the floor and within 1% of the quote, leaves nothing in zRouter or Swapbol');

  await withSnapshot(async () => {
    const t = newWallet(); await fund(t.address, 5n * E18, tac(50_000));
    const refined = await refine({ ethCall, plan });
    const probe = buildFill({ plan: refined, side: 'sell', token: TAC, account: t.address, deadline, slipBps: 100 });
    const typed = JSON.stringify({
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Permit', domain: { name: 'Tacit Token', version: '1', chainId: 1, verifyingContract: TAC },
      message: { owner: t.address, spender: ZB.ZROUTER, value: probe.approval.amount.toString(), nonce: '0', deadline: deadline.toString() } });
    const sig = cast('wallet', 'sign', '--private-key', t.key, '--data', typed);
    const permit = { value: probe.approval.amount, deadline, v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) };
    const tx = buildFill({ plan: refined, side: 'sell', token: TAC, account: t.address, deadline, slipBps: 100, permit });
    assert.equal(tx.approval, null);
    assert.ok(!(await reverts(t.address, tx)), 'the permit sale simulates clean without any approval');
    const tac0 = await balanceOf(TAC, t.address), e0 = await ethBal(t.address), r = await send(t.address, tx); assert.ok(r.ok);
    const spent = tac0 - (await balanceOf(TAC, t.address)), got = (await ethBal(t.address)) - e0 + r.gasUsed * r.gasPrice;
    assert.ok(got >= tx.minOut && spent <= refined.pay);
    rows.push(['sell 4500 TAC, four boards (permit)', Number(spent) / 1e18, Number(got) / 1e18, r.gasUsed]);
  });
  ok('the same sale through an EIP-2612 permit needs no approval and settles the same');

  await withSnapshot(async () => {
    const t = newWallet(); await fund(t.address, 5n * E18, tac(50_000));
    const small = planSell(book.bids, tac(300), { skip: (o) => !own(o) });
    assert.deepEqual(small.fills.map((f) => f.order.board), ['v2'], 'a small sale is a part of the best partial bid (v1 is whole-only)');
    const refined = await refine({ ethCall, plan: small });
    const tx = buildFill({ plan: refined, side: 'sell', token: TAC, account: t.address, deadline });
    await approve(t.address, TAC, tx.approval.spender, tx.approval.amount);
    const tac0 = await balanceOf(TAC, t.address), e0 = await ethBal(t.address), r = await send(t.address, tx); assert.ok(r.ok);
    assert.equal(tac0 - (await balanceOf(TAC, t.address)), tac(300));
    rows.push(['sell 300 TAC into a v2 bid', 300, Number((await ethBal(t.address)) - e0 + r.gasUsed * r.gasPrice) / 1e18, r.gasUsed]);
    const after = await readTheBook(), b = after.bids.find((o) => o.key === `v2:${ids.b2}`);
    assert.equal(b.base, tac(1000) - tac(300), 'the v2 bid kept the rest');
  });
  ok('a small sale takes a part of a Swapboard v2 bid and the rest stays on the board');

  console.log('\n  sells:'); for (const r of rows) console.log('   ', r[0].padEnd(40), `gave ${r[1].toFixed(2)} TAC`.padEnd(22), `got ${r[2].toFixed(5)} ETH`.padEnd(20), `gas ${r[3]}`);
}

// ── the clock ──
{
  await withSnapshot(async () => {
    await advance(1900);                                                         // past the 30-minute v2 order
    const later = await readTheBook();
    assert.ok(!later.asks.some((o) => o.key === `v2:${ids.a2 + 1n}`), 'the expired v2 order is not offered');
    assert.ok(later.asks.some((o) => o.key === `v2:${ids.a2}`), 'the open-ended one still is');
    const a3 = later.asks.find((o) => o.key === `dutch:${ids.a3}`), a3then = book.asks.find((o) => o.key === `dutch:${ids.a3}`);
    assert.ok(a3.quote < a3then.quote, 'the Dutchboard price has fallen');
    assert.ok(near(Number(a3.quote), Number(eth(30) - (eth(20) * 1900n) / 3600n), 0.01), `about half way down its curve (${a3.quote})`);
    const b4 = later.bids.find((o) => o.key === `floor:${ids.b4}`), b4then = book.bids.find((o) => o.key === `floor:${ids.b4}`);
    assert.ok(b4.quote > b4then.quote, 'the Floorboard bid has climbed');
    // a plan made before the clock moved: refined now, it is the cheaper figure, and the old transaction still fills
    const t = newWallet(); await fund(t.address, 10n * E18);
    const old = planBuy(book.asks, eth(5), { skip: (o) => !own(o) || o.board !== 'dutch' });
    const refined = await refine({ ethCall, plan: old });
    assert.ok(refined.get > old.get, `the same ETH now buys more TAC (${refined.get} against ${old.get})`);
    const tx = buildFill({ plan: refined, side: 'buy', token: TAC, account: t.address, deadline: BigInt((await chainNow()) + 600) });
    const tac0 = await balanceOf(TAC, t.address), r = await send(t.address, tx); assert.ok(r.ok);
    assert.equal((await balanceOf(TAC, t.address)) - tac0, refined.get);
    const expired = planBuy(book.asks.filter((o) => o.key === `v2:${ids.a2 + 1n}`), eth(20));
    assert.ok(expired.fills.length === 1);
    assert.ok(await reverts(t.address, buildFill({ plan: { fills: expired.fills.map((f) => ({ ...f, get: f.get })), pay: expired.pay, get: expired.get }, side: 'buy', token: TAC, account: t.address, deadline: BigInt((await chainNow()) + 600) })), 'filling the expired v2 order reverts');
    await advance(2000);                                                         // past the hour
    const end = await readTheBook();
    assert.ok(!end.bids.some((o) => o.key === `floor:${ids.b4}`), 'a Floorboard bid is gone when its window ends');
    const floorEnd = end.asks.find((o) => o.key === `dutch:${ids.a3}`);
    assert.ok(floorEnd && near(Number(floorEnd.quote), Number(eth(10) * floorEnd.base / tac(1000)), 0.001), `a Dutchboard lot rests at its floor price per TAC (${floorEnd?.quote} for ${floorEnd?.base})`);
  });
  ok('with the clock moved: an expired v2 order drops out and no longer fills, Dutchboard\'s price falls along its curve (and a plan made earlier buys more with the same ETH), Floorboard\'s bid climbs and then ends');
}

console.log(`\n${n} zboards-fork checks passed`);
anvil.kill('SIGKILL');
