// dapp/evm-pool-tokens.js: a token's private pool and router at the addresses CreateX gives them under its salts, the one transaction that
// opens them, read back against viem's encoding and against a fork deploy of the USDC pool (0x6C0b…e908, router 0xe77D…5FE4).
//   node --test tests/evm-pool-tokens.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeTokenPools, poolState, keeperIdOf, encodeAggregate3, decodeAggregate3, FIXED, SERVED, CREATEX, MULTICALL3 } from '../dapp/evm-pool-tokens.js';

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { decodeFunctionData, parseAbi, keccak256, concat, toHex, encodeAbiParameters, getAddress } = require('viem');
const code = JSON.parse(readFileSync(new URL('../dapp/evm-pool/token-pool-code.json', import.meta.url), 'utf8'));
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const tp = makeTokenPools({ code, keccak256: keccak_256 });

test("a token's pool and router are where the fork's deploy put them, checksummed, with the keeper route its token names", () => {
  const p = tp.poolOf(USDC.toLowerCase());
  assert.strictEqual(p.pool, '0x6C0be904750Fe1b50cd7207cc94731642d99e908');
  assert.strictEqual(p.router, '0xe77D82b9A7B686ADc5F31F4cb83286981AC55FE4');
  assert.strictEqual(p.token, USDC); assert.strictEqual(p.fixed, false);
  assert.strictEqual(p.id, '1-xa0b86991c6'); assert.strictEqual(p.keeper, 'https://tacit-evm-pool-keepers.onrender.com/1-xa0b86991c6/evm-pool/keeper');
  assert.ok(tp.isPool(USDC, p.pool.toLowerCase()) && tp.isRouter(USDC, p.router) && !tp.isPool(TAC, p.pool));
});

test('the pools the relay serves are where the salts put them, and the logged salt is the guarded one', () => {
  for (const [t, v] of Object.entries(SERVED)) {
    const p = tp.poolOf(t);
    assert.strictEqual(p.pool, v.pool); assert.strictEqual(p.router, v.router); assert.ok(!FIXED[t]);
    assert.strictEqual(p.poolGuard, keccak256(p.poolSalt));
  }
});

test('the salts are open (20 zero bytes and 0x00) and differ by kind, token and nothing else', () => {
  const a = tp.saltOf('pool', USDC), b = tp.saltOf('router', USDC), c = tp.saltOf('pool', TAC);
  for (const s of [a, b, c]) assert.match(s, /^0x0{42}[0-9a-f]{22}$/);
  assert.notStrictEqual(a, b); assert.notStrictEqual(a, c);
  // the address is CREATE2's over CreateX, the guarded salt keccak256(salt) and the init code's hash, as viem computes it
  const want = getAddress('0x' + keccak256(concat(['0xff', CREATEX, keccak256(a), keccak256(tp.poolInit(USDC))])).slice(-40));
  assert.strictEqual(tp.poolOf(USDC).pool, want);
});

test('TAC and the synths keep their own pools, and nothing opens them', () => {
  const p = tp.poolOf(TAC);
  assert.strictEqual(p.pool, FIXED[TAC.toLowerCase()].pool); assert.strictEqual(p.id, '1-tac'); assert.strictEqual(p.fixed, true);
  assert.strictEqual(tp.openTx(TAC), null);
  assert.strictEqual(keeperIdOf(TAC), '1-tac');
});

test('the opening transaction: both through Multicall3, or only the router once the pool is there, or nothing once both are', () => {
  const mc = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
  const cx = parseAbi(['function deployCreate2(bytes32 salt, bytes initCode) payable returns (address)']);
  const p = tp.poolOf(USDC), both = tp.openTx(USDC);
  assert.strictEqual(both.to, MULTICALL3);
  const { args: [calls] } = decodeFunctionData({ abi: mc, data: both.data });
  assert.strictEqual(calls.length, 2);
  assert.ok(calls.every((c) => c.target === CREATEX && c.allowFailure === false));
  const [d0, d1] = calls.map((c) => decodeFunctionData({ abi: cx, data: c.callData }).args);
  assert.strictEqual(d0[0], p.poolSalt); assert.strictEqual(d0[1], tp.poolInit(USDC).toLowerCase());
  assert.strictEqual(d1[0], p.routerSalt); assert.strictEqual(d1[1], tp.routerInit(p.pool).toLowerCase());
  const r = tp.openTx(USDC, { pool: true, router: false });
  assert.strictEqual(r.to, CREATEX);
  assert.deepStrictEqual(decodeFunctionData({ abi: cx, data: r.data }).args, [p.routerSalt, tp.routerInit(p.pool).toLowerCase()]);
  assert.strictEqual(tp.openTx(USDC, { pool: true, router: true }), null);
});

test('creation code that does not rebuild the live TAC pool is refused', () => {
  assert.throws(() => makeTokenPools({ code: { ...code, pool: code.pool.slice(0, -2) + '00' }, keccak256: keccak_256 }), /does not rebuild/);
  assert.throws(() => makeTokenPools({ code: { ...code, router: code.router.replace(/.{2}$/, 'ff') }, keccak256: keccak_256 }), /does not rebuild/);
});

test("a pool is there when it answers ASSET() with its token and its router answers POOL() with it", async () => {
  const p = tp.poolOf(USDC), w = (a) => '0x' + a.toLowerCase().slice(2).padStart(64, '0');
  const live = async (to, data) => (to === p.pool && data === '0x4800d97f' ? w(USDC) : to === p.router && data === '0x7535d246' ? w(p.pool) : '0x');
  assert.deepStrictEqual(await poolState(tp, USDC, live), { pool: true, router: true });
  const half = async (to, data) => (to === p.pool ? w(USDC) : (() => { throw new Error('execution reverted'); })());
  assert.deepStrictEqual(await poolState(tp, USDC, half), { pool: true, router: false });
  const wrong = async (to) => (to === p.pool ? w(TAC) : '0x');
  assert.deepStrictEqual(await poolState(tp, USDC, wrong), { pool: false, router: false });
  void toHex; void encodeAbiParameters;
});

test('one by one: the pool and then its router, each a CreateX call with its salt, code hash and address, the same as the one transaction', () => {
  const cx = parseAbi(['function deployCreate2(bytes32 salt, bytes initCode) payable returns (address)']);
  for (const t of Object.keys(SERVED)) {
    const p = tp.poolOf(t), [a, b] = tp.deploySteps(t);
    assert.deepStrictEqual([a.kind, b.kind, a.to, b.to], ['pool', 'router', CREATEX, CREATEX]);
    assert.deepStrictEqual(decodeFunctionData({ abi: cx, data: a.data }).args, [p.poolSalt, tp.poolInit(t).toLowerCase()]);
    assert.deepStrictEqual(decodeFunctionData({ abi: cx, data: b.data }).args, [p.routerSalt, tp.routerInit(p.pool).toLowerCase()]);
    assert.strictEqual(a.initCodeHash, keccak256(tp.poolInit(t))); assert.strictEqual(b.initCodeHash, keccak256(tp.routerInit(p.pool)));
    assert.deepStrictEqual([a.expected, b.expected], [SERVED[t].pool, SERVED[t].router]);
    assert.strictEqual(tp.openTx(t, { pool: true, router: false }).data, b.data);
  }
  assert.deepStrictEqual(tp.deploySteps(TAC), []);
});

test('both asked in one read (Multicall3), encoded as viem encodes it and its answer read back', async () => {
  const mc = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
  const p = tp.poolOf(USDC), w = (a) => '0x' + a.toLowerCase().slice(2).padStart(64, '0');
  const data = encodeAggregate3([[p.pool, '0x4800d97f'], [p.router, '0x7535d246']]);
  const { args: [calls] } = decodeFunctionData({ abi: mc, data });
  assert.deepStrictEqual(calls.map((c) => [c.target, c.allowFailure, c.callData]), [[p.pool, true, '0x4800d97f'], [p.router, true, '0x7535d246']]);
  const answer = (rows) => encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'bool', name: 'success' }, { type: 'bytes', name: 'returnData' }] }], [rows]);
  assert.deepStrictEqual(decodeAggregate3(answer([{ success: true, returnData: w(USDC) }, { success: false, returnData: '0x' }]).slice(2)), [{ ok: true, data: w(USDC).slice(2) }, { ok: false, data: '' }]);
  let reads = 0;
  const one = async (to, d) => { reads++; assert.strictEqual(to, MULTICALL3); assert.strictEqual(d, data); return answer([{ success: true, returnData: w(USDC) }, { success: true, returnData: w(p.pool) }]); };
  assert.deepStrictEqual(await poolState(tp, USDC, one), { pool: true, router: true }); assert.strictEqual(reads, 1, 'in one read');
  const half = async () => answer([{ success: true, returnData: w(USDC) }, { success: false, returnData: '0x' }]);
  assert.deepStrictEqual(await poolState(tp, USDC, half), { pool: true, router: false });
  const wrong = async () => answer([{ success: true, returnData: w(TAC) }, { success: true, returnData: w(p.pool) }]);
  assert.deepStrictEqual(await poolState(tp, USDC, wrong), { pool: false, router: true });
});
