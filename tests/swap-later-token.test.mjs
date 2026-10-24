// "Swap privately" from a token, the parts that need no chain: the zap's call (TacitEvmPoolZap) for each way it takes the token, read back
// against the deployed contract's ABI; the token amount sized so its route pays at least the deposit; the swap's ETH in three figures; and
// for a token's own pool, that only the relay's tokens are opened and a fee is taken only from the keeper answering for that pool.
//   node --test tests/swap-later-token.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { decodeFunctionData } = createRequire(new URL('../worker-relay/package.json', import.meta.url))('viem');
const { zapDeposit } = await import('../dapp/evm-pool-wallet.js');
const { sizeIn, swapOf, ZAP, makeLater, relayFee, SERVED } = await import('../dapp/swap/later.js');

const abi = JSON.parse(readFileSync(new URL('../docs/evm-pool/abi/TacitEvmPoolZap.json', import.meta.url)));
const ABI = Array.isArray(abi) ? abi : abi.abi;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', SWAP = '0xac9650d8' + 'ab'.repeat(40);
const tx = { pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n], publicInputs: Array.from({ length: 11 }, (_, i) => BigInt(100 + i)), recipient: '0x0000000000000000000000000000000000000000',
  extAmount: '84000000000000000', relayer: '0x0000000000000000000000000000000000000000', fee: 0n, memo0: '0x' + '11'.repeat(65), memo1: '0x' + '22'.repeat(65) };
const read = (c) => decodeFunctionData({ abi: ABI, data: c.data });

test('the zap takes an allowance with zapToken: the proof as given, the token, exactly the amount, the route; sent no ETH', () => {
  const c = zapDeposit(ZAP, tx, { token: USDC, amountIn: 200_966_332n, swap: SWAP });
  const d = read(c);
  assert.strictEqual(c.to, ZAP); assert.strictEqual(c.value, 0n);
  assert.strictEqual(d.functionName, 'zapToken');
  const [t, token, amountIn, swap] = d.args;
  assert.strictEqual(t.extAmount, 84_000_000_000_000_000n); assert.deepStrictEqual(t.publicInputs.map(BigInt), tx.publicInputs); assert.strictEqual(t.memo1, tx.memo1);
  assert.strictEqual(token.toLowerCase(), USDC.toLowerCase()); assert.strictEqual(amountIn, 200_966_332n); assert.strictEqual(swap, SWAP);
});

test('an EIP-2612 permit rides with zapTokenWithPermit, and one for another amount is refused', () => {
  const p = { kind: 'permit', value: 5n * 10n ** 6n, deadline: 1_900_000_000n, v: 27, r: '0x' + '33'.repeat(32), s: '0x' + '44'.repeat(32) };
  const d = read(zapDeposit(ZAP, tx, { token: USDC, amountIn: 5n * 10n ** 6n, swap: SWAP, pull: p }));
  assert.strictEqual(d.functionName, 'zapTokenWithPermit');
  assert.strictEqual(d.args[1].toLowerCase(), USDC.toLowerCase());
  assert.deepStrictEqual(d.args.slice(2), [5n * 10n ** 6n, 1_900_000_000n, 27, p.r, p.s, SWAP]);
  assert.throws(() => zapDeposit(ZAP, tx, { token: USDC, amountIn: 6n * 10n ** 6n, swap: SWAP, pull: p }), /another amount/);
});

test('a Permit2 signature transfer rides with zapTokenWithPermit2: its nonce, deadline and signature', () => {
  const sig = '0x' + '55'.repeat(65), d = read(zapDeposit(ZAP, tx, { token: USDC, amountIn: 7n, swap: SWAP, pull: { kind: 'permit2', nonce: (1n << 120n) + 9n, deadline: 1_900_000_000n, sig } }));
  assert.strictEqual(d.functionName, 'zapTokenWithPermit2');
  assert.deepStrictEqual(d.args.slice(2), [7n, (1n << 120n) + 9n, 1_900_000_000n, sig, SWAP]);
});

test('a withdrawal is no deposit, and an unknown way is refused', () => {
  assert.throws(() => zapDeposit(ZAP, { ...tx, extAmount: '-5' }, { token: USDC, amountIn: 1n, swap: SWAP }), /positive amount/);
  assert.throws(() => zapDeposit(ZAP, tx, { token: USDC, amountIn: 1n, swap: SWAP, pull: { kind: 'batch' } }), /unknown way/);
});

// a route that pays less per token as it grows: out = k·a / (1 + a/depth), its floor 1% under
const curve = (k, depth) => async (a) => { const out = (k * a * 10_000n) / (10_000n + (a * 10_000n) / depth); return { amountIn: a, out, min: (out * 99n) / 100n }; };

test('the token sold is sized so its route pays at least the deposit, from the floor quoted for the amount typed', async () => {
  const route = curve(4n * 10n ** 8n, 10n ** 12n), typed = 150n * 10n ** 6n, q = await route(typed);
  for (const dep of [q.min, (q.min * 13n) / 10n, q.min * 2n, q.min * 5n]) {
    const asked = [];
    const r = await sizeIn({ route: (a) => { asked.push(a); return route(a); }, amountIn: typed, min: q.min, depositWei: dep });
    assert.ok(r && r.min >= dep, `${r?.min} covers the deposit ${dep}`);
    assert.ok(r.amountIn <= (typed * dep * 1003n) / (q.min * 1000n) * 2n, 'and asks no more than it needs, give or take the curve');
    assert.ok(asked.length <= 3, `in at most three asks (${asked.length})`);
  }
});

test('a route that never pays the deposit, or none at all, is no route', async () => {
  assert.strictEqual(await sizeIn({ route: async (a) => ({ amountIn: a, out: 10n, min: 9n }), amountIn: 100n, min: 9n, depositWei: 10n ** 18n }), null);
  assert.strictEqual(await sizeIn({ route: async () => null, amountIn: 100n, min: 9n, depositWei: 10n }), null);
  assert.strictEqual(await sizeIn({ route: async (a) => ({ amountIn: a, min: a }), amountIn: 0n, min: 9n, depositWei: 10n }), null);
});

test('the swap is three significant figures of what the route into the pool pays, never more', () => {
  for (const [w, want] of [[50_637_430_135_075_603n, 50_600_000_000_000_000n], [95_699_999n, 95_600_000n], [999n, 999n], [12n, 12n], [1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n]]) {
    assert.strictEqual(swapOf(w), want); assert.ok(swapOf(w) <= w);
  }
});

test("a token's own pool is opened only for a token the relay serves, and a fee only from the keeper that answers for that pool", async () => {
  let sent = 0;
  const L = makeLater({ keyHex: async () => '11'.repeat(32), signer: { address: '0x' + '22'.repeat(20), send: async () => { sent++; return '0x'; } }, ethCall: async () => '0x', store: null });
  await assert.rejects(L.openPool('0x' + '33'.repeat(20)), /would not be relayed/);
  assert.strictEqual(sent, 0);
  const usdc = SERVED[USDC.toLowerCase()];
  const get = (pool) => async () => ({ ok: true, json: async () => ({ fee: '1500000', pool }) });
  assert.strictEqual(await relayFee(1_420_000, get(usdc.pool), 'https://k/1-xa0b86991c6/evm-pool/keeper', usdc.pool), 1_500_000n);
  await assert.rejects(relayFee(1_420_000, get('0x' + '44'.repeat(20)), 'https://k/1-xa0b86991c6/evm-pool/keeper', usdc.pool), /could not quote/);
});
