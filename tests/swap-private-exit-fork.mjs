#!/usr/bin/env node
// A swap out of the private pool to a token (dapp/swap/private.js exitNote) on a mainnet fork, with the live ConfidentialRouter, zRouter and
// zQuoter: the recipe the card builds (one zRouter call sent exactly the ETH the unwrap pays, the token paid to the address, the escrow's ETH
// swept after), its escrow as the router computes it, then that escrow paid as an unwrap would pay it. Anyone's activateExit pays the address at
// least the quote's limit and leaves nothing in the escrow; past the deadline the swap no longer runs and reclaimExit sends the ETH to the
// address. The proof and the relay are not exercised here (the relay's activation is tests/confidential-exit-activate.mjs).
//
//   node tests/swap-private-exit-fork.mjs        (FORK=<rpc url> to fork another node)
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialRouter } from '../dapp/confidential-router.js';
import { quoteEthToToken, ZERO, ZROUTER } from '../dapp/swap/route.js';

const FORK = process.env.FORK || 'https://ethereum-rpc.publicnode.com';
const ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992';
const ETH_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TO = '0x5a5A5a5a5A5a5A5A5a5a5A5a5a5a5A5A5A5a5a5a';                // the address the swap pays: an empty one
const STRANGER = '0x00000000000000000000000000000000000Beef1';
const PORT = 23500 + Math.floor(Math.random() * 400), RPC = `http://127.0.0.1:${PORT}`;
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const rpc = async (method, params = []) => {
  const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data });
  return j.result;
};
// as the swap page's ethCall: a call that names its gas is given it (zQuoter's scan needs far more than a default call)
const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, block]);
const balOf = async (tok, who) => BigInt(await rpc('eth_call', [{ to: tok, data: '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function send(from, to, data) {
  await rpc('anvil_impersonateAccount', [from]);
  await rpc('anvil_setBalance', [from, '0xDE0B6B3A7640000']);
  const h = await rpc('eth_sendTransaction', [{ from, to, data, gas: '0x2DC6C0' }]);
  for (let i = 0; i < 50; i++) { const rc = await rpc('eth_getTransactionReceipt', [h]); if (rc) return rc; await sleep(100); }
  throw new Error('no receipt');
}

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }

const router = makeConfidentialRouter({ secp, keccak256: keccak_256, sha256, cfg: { chainId: 1, router: ROUTER, pool: '0x000000000Ed1eabD231Be41d93b719056F7febFC' } });
const now = Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));
const wei = 3n * 10n ** 16n;                                                 // what the unwrap pays the escrow: 0.03 ETH
const deadline = BigInt(now + 1800);

const sale = await quoteEthToToken({ ethCall, to: TO, tokenOut: USDC, amount: wei, slippageBps: 50, deadline });
ok(!!sale && sale.amountLimit > 0n && sale.msgValue === wei, `zQuoter sells exactly the ETH for USDC, paid to the address (${sale ? `${sale.name}, at least ${sale.amountLimit}` : 'none'})`);
ok(!(await quoteEthToToken({ ethCall, to: TO, tokenOut: ZERO, amount: wei, slippageBps: 50, deadline })), 'ETH itself is not a sale (it leaves by a plain unwrap)');

const recipeOf = (over = {}) => ({ exitedAsset: ETH_ID, feeAsset: ZERO, finalRecipient: TO.toLowerCase(), deadline: deadline.toString(), nonce: '424242',
  calls: [{ target: ZROUTER, value: wei.toString(), token: ZERO, amount: '0', push: false, data: sale.callData }], sweepTokens: [ZERO], minOuts: ['0'], ...over });
const escrowOf = async (recipe) => '0x' + String(await ethCall(ROUTER, router.escrowAddressForCalldata(recipe))).slice(-40);

// ── the swap runs ──
{
  const recipe = recipeOf(), escrow = await escrowOf(recipe);
  ok(/^0x[0-9a-f]{40}$/.test(escrow) && !/^0x0{40}$/.test(escrow), `the router names the recipe's escrow (${escrow})`);
  ok(escrow !== (await escrowOf(recipeOf({ finalRecipient: STRANGER.toLowerCase() }))), 'another address is another escrow: a relay cannot redirect the output');
  await rpc('anvil_setBalance', [escrow, '0x' + wei.toString(16)]);           // what the settle's unwrap pays it
  const before = await balOf(USDC, TO);
  const rc = await send(STRANGER, ROUTER, router.activateExitCalldata(recipe));
  ok(rc.status === '0x1', `anyone's activateExit runs it (${BigInt(rc.gasUsed)} gas)`);
  ok(BigInt(rc.gasUsed) < 450000n, 'and within the gas the card pays the relay to send it');
  const got = (await balOf(USDC, TO)) - before;
  ok(got >= sale.amountLimit, `the address got ${got} USDC units, at least the quote's limit ${sale.amountLimit}`);
  ok(BigInt(await rpc('eth_getBalance', [escrow, 'latest'])) === 0n && (await balOf(USDC, escrow)) === 0n, 'nothing is left in the escrow');
  const again = await send(STRANGER, ROUTER, router.activateExitCalldata(recipe)).catch(() => ({ status: '0x0' }));
  ok(again.status !== '0x1', 'a second activation has nothing to run');
}

// ── past its deadline: the swap no longer runs, the ETH goes on to the address ──
{
  const recipe = recipeOf({ nonce: '515151' }), escrow = await escrowOf(recipe);
  await rpc('anvil_setBalance', [escrow, '0x' + wei.toString(16)]);
  await rpc('evm_setNextBlockTimestamp', [Number(deadline) + 60]); await rpc('evm_mine');
  const late = await send(STRANGER, ROUTER, router.activateExitCalldata(recipe)).catch(() => ({ status: '0x0' }));
  ok(late.status !== '0x1', 'past the deadline the swap does not run (no stale price can be forced through)');
  const ethBefore = BigInt(await rpc('eth_getBalance', [TO, 'latest']));
  const rc = await send(STRANGER, ROUTER, router.reclaimExitCalldata(recipe, []));
  ok(rc.status === '0x1', 'reclaimExit runs, from anyone');
  ok(BigInt(await rpc('eth_getBalance', [TO, 'latest'])) - ethBefore === wei, 'and the address gets the ETH itself');
}

console.log(`\n${n} passed, ${fails} failed`);
anvil.kill('SIGKILL');
process.exit(fails ? 1 : 0);
