#!/usr/bin/env node
// The zQuoter answer guard (dapp/zrouter-guard.js): real quoter outputs for each route shape pass against the terms asked for,
// and every way of redirecting, widening or replacing the call is refused.
//   node tests/zrouter-guard.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { checkZRouterCall, decodeZRouterCall, CURVE_POOLS, ZROUTER, WETH } from '../dapp/zrouter-guard.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/zrouter-quotes.json', import.meta.url), 'utf8'));
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };

const OTHER = '0x' + 'ba'.repeat(20);
const pad = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const wordN = (v) => BigInt(v).toString(16).padStart(64, '0');

// Every real answer is accepted for the terms it was asked for.
for (const f of fixtures) ok(checkZRouterCall(f.callData, f.want) === null, `accepts: ${f.label}`);

const single = fixtures.find((f) => f.label.startsWith('USDC->WETH exact-out'));
const curve = fixtures.find((f) => f.label.startsWith('stETH->WETH exact-in'));
const chain = fixtures.find((f) => f.label.startsWith('wstETH->PROVE via ETH'));
const usdtChain = fixtures.find((f) => f.label.startsWith('USDT->PROVE via ETH'));
const ethIn = fixtures.find((f) => f.label.startsWith('ETH->PROVE exactOut=false'));

// The terms must match the call.
for (const f of fixtures) {
  ok(checkZRouterCall(f.callData, { ...f.want, to: OTHER }) !== null, `refuses another recipient: ${f.label}`);
  ok(checkZRouterCall(f.callData, { ...f.want, tokenOut: OTHER }) !== null, `refuses another output token: ${f.label}`);
  ok(checkZRouterCall(f.callData, { ...f.want, tokenIn: OTHER }) !== null, `refuses another input token: ${f.label}`);
}
ok(checkZRouterCall(single.callData, { ...single.want, amount: BigInt(single.want.amount) + 1n }) !== null, 'refuses another amount');
ok(checkZRouterCall(single.callData, { ...single.want, exactOut: false }) !== null, 'refuses the other kind of swap');
ok(checkZRouterCall(single.callData, { ...single.want, deadline: 1 }) !== null, 'refuses another deadline');

// The recipient inside the bytes is what is read: rewriting it to another address is refused.
{
  const bent = single.callData.replaceAll(pad(single.want.to), pad(OTHER));
  ok(bent !== single.callData && checkZRouterCall(bent, single.want) !== null, 'refuses a recipient rewritten inside the call');
  const bentChain = chain.callData.replaceAll(pad(chain.want.to), pad(OTHER));
  ok(bentChain !== chain.callData && checkZRouterCall(bentChain, chain.want) !== null, 'refuses a chain whose last recipient is rewritten');
  const bentMid = chain.callData.replaceAll(pad(ZROUTER), pad(OTHER));
  ok(bentMid !== chain.callData && checkZRouterCall(bentMid, chain.want) !== null, 'refuses a chain whose middle swap pays another address');
}

// Only swaps: other zRouter functions in the selector slot are refused, whole or inside a multicall.
for (const [name, sel] of [['snwap', '5f3bd1c8'], ['sweep', 'cb019b84'], ['permit', '7ac2ff7b'], ['permitDAI', '230390f4'], ['execute', 'bd7f1ba4']]) {
  ok(checkZRouterCall('0x' + sel + single.callData.slice(10), single.want) !== null, `refuses ${name} in place of a swap`);
}
function encMulticall(legs) {
  const bodies = legs.map((l) => { const b = l.replace(/^0x/, ''); return wordN(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); });
  let off = legs.length * 32; const offs = [];
  for (const b of bodies) { offs.push(wordN(off)); off += b.length / 2; }
  return '0xac9650d8' + wordN(32) + wordN(legs.length) + offs.join('') + bodies.join('');
}
{
  const swapLeg = single.callData;
  const sweepLeg = '0xcb019b84' + pad(WETH) + wordN(0) + wordN(0) + pad(OTHER);
  ok(checkZRouterCall(encMulticall([swapLeg]), single.want) === null, 'a multicall of one swap is read like the swap');
  ok(checkZRouterCall(encMulticall([swapLeg, sweepLeg]), single.want) !== null, 'refuses a sweep riding in a multicall');
  const snwapLeg = '0x5f3bd1c8' + wordN(0).repeat(7);
  ok(checkZRouterCall(encMulticall([snwapLeg, swapLeg]), single.want) !== null, 'refuses an executor call riding in a multicall');
  ok(checkZRouterCall(encMulticall([swapLeg, swapLeg, swapLeg, swapLeg]), single.want) !== null, 'refuses a multicall of too many calls');
}

// Shape: truncated or padded calldata, garbage, and a short selector are refused.
ok(checkZRouterCall(single.callData.slice(0, -64), single.want) !== null, 'refuses a truncated swap');
ok(checkZRouterCall(single.callData + '00'.repeat(32), single.want) !== null, 'refuses a swap with trailing bytes');
ok(checkZRouterCall('0x', single.want) !== null && checkZRouterCall('0xzz', single.want) !== null && checkZRouterCall('', single.want) !== null, 'refuses empty and non-hex calldata');
ok(checkZRouterCall(single.callData.slice(0, 10) + 'ff'.repeat(32) + single.callData.slice(74), single.want) !== null, 'refuses a word that is not an address');
assert.throws(() => decodeZRouterCall('0x12345678'), /not a swap/);

// Curve: the pools must be known; the caller may add one.
{
  const pool = decodeZRouterCall(curve.callData)[0].pools[0];
  ok(CURVE_POOLS.includes(pool), 'the captured curve route uses a listed pool');
  const bent = curve.callData.replaceAll(pad(pool), pad(OTHER));
  ok(checkZRouterCall(bent, curve.want) !== null, 'refuses a curve route through an unlisted pool');
  const bentWanted = { ...curve.want };
  ok(checkZRouterCall(bent.replaceAll(pad(OTHER), pad(OTHER)), { ...bentWanted, curvePools: [OTHER] }) === null, 'accepts the same route once the caller lists the pool');
  const usdt = decodeZRouterCall(usdtChain.callData);
  ok(usdt.length === 2 && usdt[0].fn === 'swapCurve' && usdt[1].fn === 'swapV3', 'a curve leg followed by a v3 leg reads as a chain');
}

// Bounds the caller may set on what is spent and paid.
{
  const d = decodeZRouterCall(single.callData)[0];
  ok(checkZRouterCall(single.callData, { ...single.want, maxIn: d.limit }) === null, 'maxIn equal to the limit is accepted');
  ok(checkZRouterCall(single.callData, { ...single.want, maxIn: d.limit - 1n }) !== null, 'maxIn under the limit is refused');
  ok(checkZRouterCall(single.callData, { ...single.want, minOut: d.amount }) === null, 'minOut equal to what is bought is accepted');
  ok(checkZRouterCall(single.callData, { ...single.want, minOut: d.amount + 1n }) !== null, 'minOut over what is bought is refused');
  const e = decodeZRouterCall(ethIn.callData)[0];
  ok(checkZRouterCall(ethIn.callData, { ...ethIn.want, minOut: e.limit }) === null && checkZRouterCall(ethIn.callData, { ...ethIn.want, minOut: e.limit + 1n }) !== null, 'minOut reads the limit of an exact-in swap');
  ok(checkZRouterCall(ethIn.callData, { ...ethIn.want, maxIn: e.amount }) === null && checkZRouterCall(ethIn.callData, { ...ethIn.want, maxIn: e.amount - 1n }) !== null, 'maxIn reads the amount of an exact-in swap');
  const c = decodeZRouterCall(chain.callData);
  ok(checkZRouterCall(chain.callData, { ...chain.want, maxIn: c[0].amount }) === null && checkZRouterCall(chain.callData, { ...chain.want, maxIn: c[0].amount - 1n }) !== null, 'maxIn bounds the first swap of a chain');
  ok(checkZRouterCall(chain.callData, { ...chain.want, minOut: c[1].limit + 1n }) !== null, 'minOut bounds the last swap of a chain');
}

// swapVZ: a plain fee is accepted, a hook or a multi-token id is not.
{
  const vz = (fee, idIn = 0, idOut = 0) => '0x9d5b5af8' + [pad(single.want.to), wordN(1), wordN(fee), pad(single.want.tokenIn), pad(WETH), wordN(idIn), wordN(idOut), wordN(10n ** 17n), wordN(10n ** 9n), wordN(single.want.deadline)].join('');
  const want = { ...single.want, amount: 10n ** 17n };
  ok(checkZRouterCall(vz(3000), want) === null, 'swapVZ with a plain fee is accepted');
  ok(checkZRouterCall(vz(BigInt('0x' + 'ab'.repeat(20))), want) !== null, 'swapVZ naming a hook is refused');
  ok(checkZRouterCall(vz(3000, 1), want) !== null && checkZRouterCall(vz(3000, 0, 7), want) !== null, 'swapVZ with a multi-token id is refused');
}

// The relay's copy is the same file.
{
  const a = readFileSync(new URL('../dapp/zrouter-guard.js', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../worker-relay/src/lib/zrouter-guard.js', import.meta.url), 'utf8');
  ok(a === b, 'worker-relay/src/lib/zrouter-guard.js is identical to dapp/zrouter-guard.js');
}
console.log(`${n} checks`);
