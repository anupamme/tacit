// A token pool in the EVM-pool wallet: its asset names the token, the router calls that pay a deposit take exactly the deposit's
// amount, and the ETH-only actions refuse.
import assert from 'node:assert/strict';
import { makeEvmPoolWallet, evmPoolKeys, routerDeposit, approveCall } from '../dapp/evm-pool-wallet.js';
import { poolAsset, makeEvmPoolZk } from '../dapp/evm-pool-zk.js';
import { selector } from '../dapp/evm-pool-gateway.js';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const ZERO = '0x0000000000000000000000000000000000000000';
const POOL = '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe', ROUTER = '0x000000fA029Eaf69840C1490Bf9AA6C094794D5a', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const hex = (b) => Buffer.from(b).toString('hex');
const keys = evmPoolKeys(zk, new Uint8Array(32).fill(7));
const rpc = async () => { throw new Error('no node here'); };
const wallet = (chain) => makeEvmPoolWallet({ zk, keys, keeper: null, store: null, prove: null, chain: { chainId: 1, pool: POOL, router: ROUTER, rpc, deployBlock: 1, ...chain } });

const tx = (extAmount) => ({ pA: ['1', '2'], pB: [['3', '4'], ['5', '6']], pC: ['7', '8'], publicInputs: Array.from({ length: 11 }, (_, i) => String(i + 1)), recipient: ZERO, extAmount: String(extAmount), relayer: ZERO, fee: '0', memo0: '0x' + 'ab'.repeat(65), memo1: '0x' });
const body = (c) => c.data.slice(10); // after the selector
const words = (c) => body(c).match(/.{64}/g);

await check('a token pool\'s asset names the token, an ETH pool\'s does not', async () => {
  const eth = wallet({}), tok = wallet({ token: TAC });
  assert.equal(eth.asset, poolAsset({ chainId: 1n, pool: POOL, token: ZERO }));
  assert.equal(tok.asset, poolAsset({ chainId: 1n, pool: POOL, token: TAC }));
  assert.notEqual(eth.asset, tok.asset);
});

await check('the receive box, the bridges and the move into V1 refuse on a token pool', async () => {
  const tok = wallet({ token: TAC });
  await assert.rejects(tok.sweep(), /ETH pools/);
  await assert.rejects(tok.bridgeOut({ toChainId: 8453, amount: 1n }), /ETH pools/);
  await assert.rejects(tok.toV1({ amount: 10n ** 10n, commit: '0x' + '11'.repeat(32) }), /ETH pools/);
  await assert.rejects(tok.withdrawAndCall({ intent: { calls: [] }, amount: 1n }), /ETH pools/);
});

const amount = 5n * 10n ** 18n;
await check('an allowance in place: depositWithPermit with an empty, expired permit (the router skips it)', async () => {
  const c = routerDeposit(ROUTER, tx(amount), { kind: 'allowance' });
  assert.equal(c.to, ROUTER);
  assert.equal(c.data.slice(0, 10), '0x' + hex(selector('depositWithPermit((uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes),uint256,uint8,bytes32,bytes32)')));
  assert.equal(c.before, undefined);
});

await check('a permit rides in the call, and one for another amount is refused', async () => {
  const p = { kind: 'permit', value: amount, deadline: 1900000000n, v: 28, r: '0x' + '0a'.repeat(32), s: '0x' + '0b'.repeat(32) };
  const c = routerDeposit(ROUTER, tx(amount), p), w = words(c);
  assert.ok(w.includes(BigInt(p.deadline).toString(16).padStart(64, '0')) && w.includes('0a'.repeat(32)) && w.includes('0b'.repeat(32)));
  assert.throws(() => routerDeposit(ROUTER, tx(amount + 1n), p), /another amount/);
  assert.throws(() => routerDeposit(ROUTER, tx(0), { kind: 'allowance' }), /positive/);
});

await check('a Permit2 signature rides in the call, and one for another amount is refused', async () => {
  const permitSingle = { details: { token: TAC, amount, expiration: 1900000000n, nonce: 3n }, spender: ROUTER, sigDeadline: 1900000000n };
  const c = routerDeposit(ROUTER, tx(amount), { kind: 'permit2', permitSingle, sig: '0x' + 'cd'.repeat(65) });
  assert.equal(c.data.slice(0, 10), '0x' + hex(selector('depositWithPermit2((uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes),((address,uint160,uint48,uint48),address,uint256),bytes)')));
  assert.ok(body(c).includes('cd'.repeat(65)) && body(c).includes(TAC.slice(2).toLowerCase().padStart(64, '0')));
  assert.throws(() => routerDeposit(ROUTER, tx(amount - 1n), { kind: 'permit2', permitSingle, sig: '0x' + 'cd'.repeat(65) }), /another amount/);
});

await check('a batch approves exactly the deposit\'s amount to the router, ahead of the call', async () => {
  const c = routerDeposit(ROUTER, tx(amount), { kind: 'batch', token: TAC });
  assert.equal(c.before.length, 1);
  const a = c.before[0], approve = approveCall(TAC, ROUTER, amount);
  assert.deepEqual(a, approve);
  assert.equal(a.to, TAC);
  assert.equal(a.data, '0x095ea7b3' + ROUTER.slice(2).toLowerCase().padStart(64, '0') + amount.toString(16).padStart(64, '0'));
  assert.equal(a.value, 0n);
  assert.equal(c.to, ROUTER);
});

await check('an unknown way is refused', async () => {
  assert.throws(() => routerDeposit(ROUTER, tx(amount), { kind: 'unlimited' }), /unknown way/);
});

console.log(`${n} passed`);
