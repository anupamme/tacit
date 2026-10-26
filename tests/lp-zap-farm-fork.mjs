#!/usr/bin/env node
// An LP voucher sent as ONE transaction, on an anvil fork of mainnet: ConfidentialRouter.zapETHIntoFarm with a real share-note proof made
// ahead (tests/fixtures/lp-zap/share-wrap.json: the tETH/TAC pool's OP_WRAP of a fixed share count, proved by the board worker through
// the proof pool). The live verifier takes the proof; the ETH legs sized at the fork's reserves (lp-zap.js zapPlanFor) mint exactly that
// share count; one transaction from a fresh account mints the shares, shields them and settles the proof (the deposit goes 0 → 2, the
// note's leaf is inserted), the account pays no more than planned and the router keeps nothing. A proof of another share count is refused.
//   node tests/lp-zap-farm-fork.mjs [fork rpc]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { zapPlanFor, zapSettleCalldata } from '../dapp/lp-zap.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/lp-zap/share-wrap.json', import.meta.url), 'utf8'));
const FORK = process.argv[2] || 'https://ethereum-rpc.publicnode.com', PORT = 21000 + Math.floor(Math.random() * 3000), RPC = `http://127.0.0.1:${PORT}`;
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
const hex = (b) => Buffer.from(b).toString('hex'), sel = (s) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 8);
const word = (v) => BigInt(v).toString(16).padStart(64, '0'), b32 = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', TETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const TAC_ASSET = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const VERIFIER = '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2', VKEY = '0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3';
const rpcAt = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message} ${j.error.data || ''}`); return j.result; };
const rpc = (m, p) => rpcAt(RPC, m, p);
async function poolState(id) { const h = (await rpc('eth_call', [{ to: POOL, data: '0x' + sel('pools(bytes32)') + b32(id) }, 'latest'])).slice(2), w = (i) => BigInt('0x' + h.slice(i * 64, i * 64 + 64)); return { ra: w(3), rb: w(4), fee: w(5), total: w(6) }; }
const status = async (id) => BigInt(await rpc('eth_call', [{ to: POOL, data: '0x7da9874f' + b32(id) }, 'latest']));
const enc = (pv, pr) => { const b = (h) => { const s = h.replace(/^0x/, ''); return word(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0'); }; const a = b(pv), c = b(pr); return '0x41493c60' + VKEY.slice(2) + word(0x60) + word(0x60 + a.length / 2) + a + c; };

await rpcAt(FORK, 'eth_call', [{ to: VERIFIER, data: enc(FX.publicValues, FX.proof) }, 'latest']).then(() => ok(true, 'the live verifier takes the share-note proof'), (e) => ok(false, `the live verifier: ${e.message}`));
const anvil = spawn('anvil', ['--fork-url', FORK, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 90; i++) { try { await rpc('eth_blockNumber', []); break; } catch { await new Promise((x) => setTimeout(x, 1000)); } }
  const me = '0x' + 'f1'.repeat(20);
  await rpc('anvil_setBalance', [me, '0xde0b6b3a7640000']); await rpc('anvil_impersonateAccount', [me]);
  const st = await poolState(FX.poolId), shares = BigInt(FX.shares);
  // the pool's assets in id order, as the router's swap leg names them
  const [assetA, assetB] = BigInt(TETH) < BigInt(TAC_ASSET) ? [TETH, TAC_ASSET] : [TAC_ASSET, TETH];
  const plan = zapPlanFor({ shares, ra: st.ra, rb: st.rb, total: st.total, feeBps: st.fee, maxEth: 10n ** 17n });
  ok(!!plan && plan.shares === shares, `the ETH legs sized at the reserves now mint exactly the ${shares} shares proved (${plan ? Number(plan.value) / 1e18 : 'none'} ETH)`);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const args = { plan, router: ROUTER, amm: AMM, tokenB: TAC, assetA, assetB, feeBps: Number(st.fee), deadline, commit: FX.commit, publicValues: FX.publicValues, proof: FX.proof, memos: FX.memos };
  // a proof for another share count: the deposit the zap makes is not the one the proof consumes, so the settle refuses it and nothing happens
  const other = zapPlanFor({ shares: shares + 1000n, ra: st.ra, rb: st.rb, total: st.total, feeBps: st.fee, maxEth: 10n ** 17n });
  await rpc('eth_call', [{ from: me, to: ROUTER, data: zapSettleCalldata({ ...args, plan: other }), value: '0x' + other.value.toString(16) }, 'latest'])
    .then(() => ok(false, 'a zap of another share count with this proof is refused'), () => ok(true, 'a zap of another share count with this proof is refused'));
  const data = zapSettleCalldata(args), before = await status(FX.depositId);
  const h = await rpc('eth_sendTransaction', [{ from: me, to: ROUTER, data, value: '0x' + plan.value.toString(16), gas: '0x' + (2_000_000).toString(16) }]);
  let r = null;
  for (let i = 0; i < 120 && !r; i++) { r = await rpc('eth_getTransactionReceipt', [h]); if (!r) await new Promise((x) => setTimeout(x, 500)); }
  ok(r?.status === '0x1', `one transaction (${BigInt(r?.gasUsed || 0)} gas)`);
  ok(before === 0n && await status(FX.depositId) === 2n, 'the share deposit goes 0 → 2: minted, shielded and settled into the private note in that transaction');
  ok(JSON.stringify(r.logs).toLowerCase().includes(FX.leaf.slice(2).toLowerCase()), 'the share note\'s leaf is inserted');
  ok(BigInt(await rpc('eth_getBalance', [ROUTER, 'latest'])) === 0n, 'the router keeps no ETH');
} finally { anvil.kill(); }
console.log(process.exitCode ? 'failed' : `all ${n} passed`);
