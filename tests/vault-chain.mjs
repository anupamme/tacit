#!/usr/bin/env node
// dapp/vault/chain.js: the selectors and calldata the vault page sends, compared byte for byte with foundry's `cast`, and the Multicall3 reads it
// makes, answered by a fake chain whose values are encoded by `cast abi-encode` (a view that fails comes back null, which is how "no price yet" reaches the page).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();

// The module imports the shared venues helpers by their address on the site; here they are the same file by its path.
const dapp = new URL('../dapp/', import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'vault-chain-'));
const src = readFileSync(new URL('vault/chain.js', dapp), 'utf8').replace(/'\/evm-trade-venues\.js\?cb=[^']*'/, `'${new URL('evm-trade-venues.js', dapp).href}'`);
writeFileSync(join(tmp, 'chain.mjs'), src);
const C = await import(pathToFileURL(join(tmp, 'chain.mjs')).href);

const ORACLE = '0x000000cE58D7d49319252DaFB0ABdB3F02101271', FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const E18 = 10n ** 18n, A = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', VAULT = '0xdc64a140aa3e981100a9beca4e685f962f0cf6c9', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', SYN = '0x856e4424f806d16e8cbc702b3c0f2ede5468eae5';

// ── selectors ──
const SIGS = {
  TAC: 'TAC()', SYNTH: 'SYNTH()', MINT_RATIO_BPS: 'MINT_RATIO_BPS()', LIQ_RATIO_BPS: 'LIQ_RATIO_BPS()', OWNER_WINDOW: 'OWNER_WINDOW()', AUCTION_DURATION: 'AUCTION_DURATION()',
  MIN_DEBT: 'MIN_DEBT()', REDEMPTION_FEE_BPS: 'REDEMPTION_FEE_BPS()', DEPTH_BPS: 'DEPTH_BPS()',
  totalDebt: 'totalDebt()', debtCeiling: 'debtCeiling()', depthCeiling: 'depthCeiling()', borrowFeeBps: 'borrowFeeBps()', valueOf: 'valueOf(uint256,bool)', liquidationPrice: 'liquidationPrice()', offerPrice: 'offerPrice()',
  vaults: 'vaults(address)', recovered: 'recovered(address)', onOffer: 'onOffer(address)', pausedUntil: 'pausedUntil()', auctionTime: 'auctionTime()', queuedParam: 'queuedParam(uint8)', pendingOracleEta: 'pendingOracleEta()', pendingMinterEta: 'pendingMinterEta()',
  deposit: 'deposit(uint256)', withdraw: 'withdraw(uint256)', borrow: 'borrow(uint256,uint256)', repay: 'repay(address,uint256)', cancel: 'cancel(address)',
  permitTac: 'permitTac(uint256,uint256,uint8,bytes32,bytes32)', permitSynth: 'permitSynth(uint256,uint256,uint8,bytes32,bytes32)', multicall: 'multicall(bytes[])',
  balanceOf: 'balanceOf(address)', allowance: 'allowance(address,address)', approve: 'approve(address,uint256)', nonces: 'nonces(address)', name: 'name()', symbol: 'symbol()', timestamp: 'getCurrentBlockTimestamp()',
  ORACLE: 'ORACLE()', ETH_USD: 'ETH_USD()', FEED_MAX_STALENESS: 'FEED_MAX_STALENESS()', spot: 'spot()', latestRoundData: 'latestRoundData()', decimals: 'decimals()',
};
for (const [k, sig] of Object.entries(SIGS)) assert.equal(C.SEL[k], cast('sig', sig), `selector of ${sig}`);
assert.deepEqual(Object.keys(C.SEL).sort(), Object.keys(SIGS).sort(), 'every selector is checked');
ok(`${Object.keys(SIGS).length} selectors are the ones foundry computes`);

// ── what a refused call means ──
const REASONS = { 'Undercollateralized()': 'limit', 'OverCeiling()': 'room', 'InAuction()': 'auction', 'BadAmount()': 'amount', 'FeeTooHigh()': 'fee', 'NoPrice()': 'paused', 'TooFewSamples()': 'paused', 'StaleFeed()': 'paused', 'BadFeed()': 'paused', 'BadWindow()': 'paused', 'NoAuction()': 'noauction', 'StillUnhealthy()': 'unhealthy', 'Healthy()': 'healthy', 'OwnerWindow()': 'ownerwindow', 'InsufficientAllowance()': 'access', 'TransferFromFailed()': 'access', 'InsufficientBalance()': 'balance' };
for (const [sig, why] of Object.entries(REASONS)) assert.equal(C.refusal({ data: cast('sig', sig) + '00'.repeat(4) }), why, sig);
assert.equal(C.refusal({ data: '0x08c379a0' }), null); assert.equal(C.refusal(new Error('x')), null); assert.equal(C.refusal(null), null);
ok('a refused call is told apart by its error: limits, room, auction, a missing price or fee (paused), the token not being available');

// ── calldata ──
const amount = 1234567890123456789012n;
assert.equal(C.encDeposit(amount), cast('calldata', 'deposit(uint256)', String(amount)));
assert.equal(C.encWithdraw(amount), cast('calldata', 'withdraw(uint256)', String(amount)));
assert.equal(C.encWithdraw((1n << 256n) - 1n), cast('calldata', 'withdraw(uint256)', String((1n << 256n) - 1n)));
assert.equal(C.encBorrow(amount, 100n), cast('calldata', 'borrow(uint256,uint256)', String(amount), '100'));
assert.equal(C.encRepay(A, (1n << 256n) - 1n), cast('calldata', 'repay(address,uint256)', A, String((1n << 256n) - 1n)));
assert.equal(C.encCancel(A), cast('calldata', 'cancel(address)', A));
assert.equal(C.encApprove(VAULT, amount), cast('calldata', 'approve(address,uint256)', VAULT, String(amount)));
ok('deposit, withdraw, borrow (with its fee ceiling), repay (all as the largest number), cancel and approve are the calldata cast builds');
const sig = { value: amount, deadline: 1_900_000_000n, v: 28, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) };
for (const w of ['permitTac', 'permitSynth']) assert.equal(C.encPermit(w, sig), cast('calldata', `${w}(uint256,uint256,uint8,bytes32,bytes32)`, String(amount), String(sig.deadline), '28', sig.r, sig.s));
const inner = [C.encPermit('permitTac', sig), C.encDeposit(amount)];
assert.equal(C.encMulticall(inner), cast('calldata', 'multicall(bytes[])', `[${inner.join(',')}]`));
assert.equal(C.encMulticall([C.encPermit('permitSynth', sig), C.encRepay(A, amount)]), cast('calldata', 'multicall(bytes[])', `[${C.encPermit('permitSynth', sig)},${C.encRepay(A, amount)}]`));
ok('a permit and the call it unlocks, batched in multicall, are the calldata cast builds');

// ── reads, from a fake chain ──
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
function decodeAggregate3Call(data) {
  const h = data.replace(/^0x/, '').slice(8), word = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
  const cnt = Number(word(1)), subs = [];
  for (let i = 0; i < cnt; i++) {
    const t = 2 + Number(word(2 + i)) / 32, bo = t + Number(word(t + 2)) / 32, len = Number(word(bo));
    subs.push({ to: '0x' + h.slice(t * 64 + 24, t * 64 + 64), data: '0x' + h.slice((bo + 1) * 64, (bo + 1) * 64 + len * 2) });
  }
  return subs;
}
function encReturns(rets) {
  const bodies = rets.map((r) => { const d = r ? r.replace(/^0x/, '') : ''; return w(r ? 1 : 0) + w(64) + w(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0'); });
  let head = '', tail = '', off = rets.length * 32;
  for (const b of bodies) { head += w(off); tail += b; off += b.length / 2; }
  return '0x' + w(32) + w(rets.length) + head + tail;
}
const enc = (types, ...vals) => cast('abi-encode', `f(${types})`, ...vals);
// the answers by selector: a vault's terms and totals, the account's vault, prices; `gone` names the views that fail
function fake({ gone = [], over = {} } = {}) {
  const S = C.SEL, ask = [];
  const answers = {
    [S.TAC]: enc('address', TAC), [S.SYNTH]: enc('address', SYN), [S.MINT_RATIO_BPS]: enc('uint256', '35000'), [S.LIQ_RATIO_BPS]: enc('uint256', '20000'), [S.OWNER_WINDOW]: enc('uint256', '1200'),
    [S.AUCTION_DURATION]: enc('uint256', '5400'), [S.MIN_DEBT]: enc('uint256', String(100n * E18)), [S.REDEMPTION_FEE_BPS]: enc('uint256', '50'), [S.DEPTH_BPS]: enc('uint256', '500'),
    [S.totalDebt]: enc('uint256', String(52000n * E18)), [S.debtCeiling]: enc('uint256', String((1n << 256n) - 1n)), [S.depthCeiling]: enc('uint256', String(250000n * E18)), [S.borrowFeeBps]: enc('uint256', '100'),
    [S.valueOf]: enc('uint256', String(E18 / 4n)), [S.liquidationPrice]: enc('uint256', String(E18 / 4n + E18 / 100n)), [S.offerPrice]: enc('uint256', String(E18 / 4n + E18 / 50n)),
    [S.vaults]: enc('uint256,uint256,uint256', String(100000n * E18), String(3030n * E18), '1800000000'), [S.recovered]: enc('bool', 'true'), [S.onOffer]: enc('uint256', String(50000n * E18)),
    [S.balanceOf]: enc('uint256', String(900000n * E18)), [S.allowance]: enc('uint256', '0'), [S.symbol]: enc('string', 'TACD'), [S.timestamp]: enc('uint256', '1800000123'), [S.pausedUntil]: enc('uint256', '1800003600'), [S.auctionTime]: enc('uint256', '1799990000'),
    [S.queuedParam]: enc('uint256,uint256', '0', '0'), [S.pendingOracleEta]: enc('uint256', '0'), [S.pendingMinterEta]: enc('uint256', '0'),
    [S.ORACLE]: enc('address', ORACLE), [S.ETH_USD]: enc('address', FEED), [S.FEED_MAX_STALENESS]: enc('uint256', '3900'), [S.spot]: enc('uint256', String(10n ** 14n)),
    [S.latestRoundData]: enc('uint80,int256,uint256,uint256,uint80', '7', '244834000000', '1800000000', '1800000050', '7'), [S.decimals]: enc('uint8', '8'), ...over,
  };
  const gonesel = new Set(gone.map((g) => S[g]));
  const chain = async (to, data) => {
    const subs = decodeAggregate3Call(data);
    ask.push(...subs);
    return encReturns(subs.map((s) => (gonesel.has(s.data.slice(0, 10)) ? null : answers[s.data.slice(0, 10)] || null)));
  };
  return { chain, ask };
}
const rpc = (chain) => async (method, params) => { assert.equal(method, 'eth_call'); return chain(params[0].to, params[0].data); };
const V = { addr: VAULT, tac: TAC, synth: SYN, oracle: ORACLE, feed: FEED };

{
  const f = fake(), { batch } = C.makeReader(rpc(f.chain));
  const st = C.parseStatic(await batch(C.staticCalls(VAULT)));
  assert.deepEqual(st, { tac: TAC.toLowerCase(), synth: SYN.toLowerCase(), mint: 35000n, liq: 20000n, ownerWindow: 1200, auctionDuration: 5400, minDebt: 100n * E18, redemptionFee: 50n, depthBps: 500n, oracle: ORACLE.toLowerCase(), feed: FEED.toLowerCase(), staleness: 3900 });
  assert.ok(f.ask.every((s) => s.to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11' || s.to.toLowerCase() === VAULT), 'static reads go to the vault');
  ok('a vault\'s terms (both tokens, 350% and 200%, the owner window, the auction, the minimum debt, the redemption fee) are read in one batch');
  const calls = [C.timestampCall(), ...C.dynamicCalls(V, A)], res = await batch(calls);
  const d = C.parseDynamic(V, A, res.slice(1));
  assert.equal(BigInt(res[0]), 1800000123n);
  assert.deepEqual({ ...d, me: undefined }, { totalDebt: 52000n * E18, debtCeiling: (1n << 256n) - 1n, depthCeiling: 250000n * E18, feeBps: 100n, pB: E18 / 4n, pL: E18 / 4n + E18 / 100n, pO: E18 / 4n + E18 / 50n, symbol: 'TACD', pausedUntil: 1800003600n, auctionTime: 1799990000, announced: [], oracleEta: 0, minterEta: 0, held: 900000n * E18, spot: 10n ** 14n, feed: { answer: 244834000000n, updatedAt: 1800000050, decimals: 8 }, me: undefined, recovered: true, onOffer: 50000n * E18, tacBal: 900000n * E18, tacAllow: 0n, synBal: 900000n * E18, synAllow: 0n });
  assert.deepEqual(d.me, { collateral: 100000n * E18, debt: 3030n * E18, auctionStart: 1800000000 });
  // the borrow price is the vault's own valueOf(1e18, true): one wei of TAC is one wei of price
  const vo = f.ask.find((s) => s.data.startsWith(C.SEL.valueOf));
  assert.equal(vo.data, cast('calldata', 'valueOf(uint256,bool)', String(E18), 'true'));
  ok('the totals, fees, prices, symbol and one account\'s vault, balances and allowances are read in one batch, the borrow price as valueOf(1e18, true)');
  // the vault's own oracle and ETH/USD feed are asked for what the board shows: the TAC held, the price now and the feed's answer, age and decimals
  const oc = f.ask.find((x) => x.data.startsWith(C.SEL.spot)), fc = f.ask.find((x) => x.data.startsWith(C.SEL.latestRoundData)), hc = f.ask.find((x) => x.data.startsWith(C.SEL.balanceOf + w(VAULT)));
  assert.equal(oc.to.toLowerCase(), ORACLE.toLowerCase()); assert.equal(fc.to.toLowerCase(), FEED.toLowerCase()); assert.equal(hc.to.toLowerCase(), TAC.toLowerCase());
  ok('the TAC a vault holds, its oracle\'s price now and its ETH/USD feed are read from the contracts the vault names');
  {
    // an owner's announcement: a term and when it may be made (every term answers the same here), and a new oracle's time
    const S = C.SEL, g = fake({ over: { [S.queuedParam]: enc('uint256,uint256', '15000', '1800172800'), [S.pendingOracleEta]: enc('uint256', '1800259200'), [S.pendingMinterEta]: enc('uint256', '1800345600') } });
    const dd = C.parseDynamic(V, null, await C.makeReader(rpc(g.chain)).batch(C.dynamicCalls(V, null)));
    assert.equal(dd.announced.length, 7); assert.deepEqual(dd.announced[2], { id: 2, value: 15000n, eta: 1800172800 }); assert.equal(dd.oracleEta, 1800259200); assert.equal(dd.minterEta, 1800345600);
    ok('the changes the owner has announced (each of the seven terms) and the times a new oracle and a new synth minter may be put in are read with the rest');
    const old = C.parseDynamic(V, null, await C.makeReader(rpc(fake({ gone: ['queuedParam', 'pendingOracleEta', 'pendingMinterEta'] }).chain)).batch(C.dynamicCalls(V, null)));
    assert.deepEqual(old.announced, []); assert.equal(old.oracleEta, 0); assert.equal(old.minterEta, 0);
    ok('a vault that has no announcements to read gives none');
  }
  const nobody = C.parseDynamic(V, null, (await batch(C.dynamicCalls(V, null))));
  assert.equal(nobody.me, undefined); assert.equal(nobody.tacBal, undefined); assert.equal(nobody.pB, E18 / 4n);
  ok('without an account only the public numbers are asked');
}
{
  // no price recorded: the views that need one fail, and the page reads them as null
  const f = fake({ gone: ['depthCeiling', 'valueOf', 'recovered'] }), { batch } = C.makeReader(rpc(f.chain));
  const d = C.parseDynamic(V, A, await batch(C.dynamicCalls(V, A)));
  assert.equal(d.depthCeiling, null); assert.equal(d.pB, null); assert.equal(d.recovered, null);
  assert.equal(d.totalDebt, 52000n * E18); assert.equal(d.pL, E18 / 4n + E18 / 100n); assert.deepEqual(d.me, { collateral: 100000n * E18, debt: 3030n * E18, auctionStart: 1800000000 });
  ok('with no price recorded the failing views are null and the rest still read (what is owed is the chain\'s, price or none)');
  const dead = fake({ gone: ['TAC'] }), r2 = C.makeReader(rpc(dead.chain));
  assert.equal(C.parseStatic(await r2.batch(C.staticCalls(VAULT))), null);
  ok('a vault whose terms cannot be read is no vault');
  assert.equal(C.decString(enc('string', 'TAC Dollar')), 'TAC Dollar'); assert.equal(C.decString(null), null);
  ok('a token\'s name is read as the contract writes it');
}

// ── the pool of nodes ──
// Fake nodes behind a fake fetch, a clock the pool's rests are measured on and a sleep that moves it, so waits cost nothing.
{
  const clock = { t: 0 };
  const result = (v) => ({ body: { jsonrpc: '2.0', id: 1, result: v } });
  const refuse = (code, message, status = 200) => ({ status, body: { jsonrpc: '2.0', id: 1, error: { code, message } } });
  const LIMIT = refuse(-32005, 'You reached Public endpoint rate limit, please upgrade to paid plan');
  const pool = (replies, sources = ['https://a.test', 'https://b.test', 'https://c.test'], o = {}) => {
    const calls = [], slept = [];
    const fetchImpl = async (url, init) => {
      const host = new URL(url).host, body = JSON.parse(init.body);
      calls.push(host);
      const r = typeof replies[host] === 'function' ? replies[host](body) : replies[host];
      return { status: r.status ?? 200, json: async () => { if (r.html) throw new SyntaxError('Unexpected token <'); return r.body; } };
    };
    const sleep = async (ms) => { slept.push(ms); clock.t += ms; };
    return { calls, slept, replies, rpc: C.makeRpc(sources, { fetchImpl, now: () => clock.t, sleep, ...o }) };
  };

  // A node that is rate limited rests: the call goes on to the next, and the next call does not queue behind the first.
  let p = pool({ 'a.test': LIMIT, 'b.test': result('0xb'), 'c.test': result('0xc') });
  assert.equal(await p.rpc('eth_blockNumber', []), '0xb');
  assert.equal(await p.rpc('eth_blockNumber', []), '0xb');
  assert.deepEqual(p.calls, ['a.test', 'b.test', 'b.test'], 'the second call goes straight to the node that answered');
  clock.t += 16e3;
  p.replies['a.test'] = result('0xa');
  assert.equal(await p.rpc('eth_blockNumber', []), '0xa');
  ok('a node that says it is rate limited rests, the next call goes to the next node, and the first is asked again once its rest is over');

  // A second failure in a row doubles the rest.
  clock.t = 0;
  p = pool({ 'a.test': LIMIT, 'b.test': result('0xb'), 'c.test': result('0xc') });
  await p.rpc('x', []); clock.t += 16e3; await p.rpc('x', []); clock.t += 16e3; await p.rpc('x', []);
  assert.deepEqual(p.calls, ['a.test', 'b.test', 'a.test', 'b.test', 'b.test'], 'a failed again after its first rest and now rests for twice as long');
  ok('a node that fails again after its rest rests twice as long');

  // A revert is the contract's answer, not a node's failure.
  p = pool({ 'a.test': { body: { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0xdeadbeef' } } }, 'b.test': result('0xb') });
  await assert.rejects(p.rpc('eth_call', []), (e) => e.revert === true && e.data === '0xdeadbeef');
  assert.deepEqual(p.calls, ['a.test'], 'no other node is asked about a revert');
  ok('a revert ends the call with the revert data, and no other node is asked');

  // Every node busy: the call waits for the first to return, then says so plainly (not in the node\'s words).
  clock.t = 0;
  p = pool({ 'a.test': LIMIT, 'b.test': refuse(-32005, 'Too many requests', 429), 'c.test': { status: 429, html: true } });
  await assert.rejects(p.rpc('eth_getProof', []), (e) => /nodes are busy/.test(e.message) && !/paid plan/.test(e.message));
  assert.ok(p.slept.length >= 1 && p.slept.every((ms) => ms <= 30e3), 'it waited for the nodes to come back, not longer than its patience');
  ok('when every node is busy the call waits for one to return and then says the nodes are busy');

  // A node\'s error wrapped in a successful reply, and a page that is not JSON, are not answers.
  clock.t = 0;
  p = pool({ 'a.test': result({ code: 503, message: 'server unavailable' }), 'b.test': { status: 525, html: true }, 'c.test': result('0xc') });
  assert.equal(await p.rpc('eth_blockNumber', []), '0xc');
  assert.deepEqual(p.calls, ['a.test', 'b.test', 'c.test']);
  assert.equal(await p.rpc('eth_blockNumber', []), '0xc');
  assert.deepEqual(p.calls.slice(3), ['c.test'], 'both rest');
  ok('an error dressed as a result and an answer that is no JSON make a node rest; the next one is asked');

  // A reply that fails the caller\'s check rests that node for that method only.
  clock.t = 0;
  p = pool({ 'a.test': (b) => result(b.method === 'eth_getBlockByNumber' ? { ok: false } : '0xa'), 'b.test': result({ ok: true }) });
  assert.deepEqual(await p.rpc('eth_getBlockByNumber', ['0x1', false], { check: (r) => r.ok }), { ok: true });
  assert.equal(await p.rpc('eth_call', []), '0xa', 'the same node still answers the methods it answered');
  await p.rpc('eth_getBlockByNumber', ['0x2', false], { check: (r) => r.ok });
  assert.deepEqual(p.calls, ['a.test', 'b.test', 'a.test', 'b.test'], 'and is not asked for the one it got wrong');
  await assert.rejects(pool({ 'a.test': result(1) }, ['https://a.test']).rpc('x', [], { check: () => { throw new Error('the header did not rebuild'); } }), /did not rebuild/);
  ok('a reply that fails the check rests the node for that method only, and the next node is asked');

  // Spread: each call starts at the next node.
  p = pool({ 'a.test': result(1), 'b.test': result(1), 'c.test': result(1) }, undefined, { spread: true });
  for (let i = 0; i < 6; i++) await p.rpc('x', []);
  assert.deepEqual(p.calls, ['a.test', 'b.test', 'c.test', 'a.test', 'b.test', 'c.test']);
  ok('with spread each call starts at the next node, so none takes all the traffic');

  // skip: a retry leaves out the nodes first in line.
  p = pool({ 'a.test': result('a'), 'b.test': result('b'), 'c.test': result('c') });
  assert.equal(await p.rpc('x', [], { skip: 1 }), 'b'); assert.equal(await p.rpc('x', [], { skip: 2 }), 'c'); assert.equal(await p.rpc('x', [], { skip: 9 }), 'c', 'never past the last');
  ok('skip leaves out the nodes first in line, never all of them');

  // A source that is not a URL (the wallet): asked first when preferred, left out when it cannot serve, rested for a method it does not know, timed out when it hangs.
  clock.t = 0;
  let connected = false, mode = 'works'; const asked = [];
  const wallet = { id: 'wallet', prefer: true, timeout: 40, usable: (m) => connected && m === 'eth_getProof', send: async (m) => { asked.push(m); if (mode === 'works') return 'from the wallet'; if (mode === 'unknown') throw Object.assign(new Error('The method eth_getProof does not exist'), { code: -32601 }); return new Promise(() => {}); } };
  p = pool({ 'a.test': result('a') }, [wallet, 'https://a.test']);
  assert.equal(await p.rpc('eth_getProof', []), 'a'); assert.deepEqual(asked, [], 'not asked while it cannot serve');
  connected = true;
  assert.equal(await p.rpc('eth_getProof', []), 'from the wallet'); assert.equal(await p.rpc('eth_blockNumber', []), 'a', 'and not asked for a method it does not serve');
  mode = 'unknown'; clock.t += 1;
  assert.equal(await p.rpc('eth_getProof', []), 'a'); assert.equal(await p.rpc('eth_getProof', []), 'a');
  assert.equal(asked.filter((m) => m === 'eth_getProof').length, 2, 'a method it said it does not have is not asked of it again for a while');
  clock.t += 301e3; mode = 'hangs';
  const t0 = Date.now();
  assert.equal(await p.rpc('eth_getProof', []), 'a'); assert.ok(Date.now() - t0 < 2000, 'a wallet that never answers is given up on after its time');
  ok('the wallet is a source like the others: preferred, left out when it cannot serve, rested for what it does not know, timed out when it hangs');

  // A wallet\'s revert ends the call as a node\'s does.
  const reverting = { id: 'wallet', send: async () => { throw Object.assign(new Error('execution reverted: BadAmount'), { code: -32000, data: '0x749b5939' }); } };
  await assert.rejects(pool({}, [reverting]).rpc('eth_call', []), (e) => e.revert === true && e.data === '0x749b5939');
  ok('a revert from the wallet carries its data too');
}
console.log(`${n} checks passed`);
