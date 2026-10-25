#!/usr/bin/env node
// The ETH → private LP zap (dapp/lp-zap.js) against the live contracts, on an anvil fork of mainnet: ConfidentialRouter.zapETHIntoShieldedLP
// with zRouter's snwap calling TacitPublicAmm.swapPublic for its swap leg, into each farmed Tacit pool. A zap simulated as it is sent returns
// exactly the shares planned and the deposit those shares and the note's commitment make; sent, it registers that deposit as pending and adds
// exactly those shares to the pool; with a public swap landing first, the same zap reverts instead of minting another share count.
//   node tests/lp-zap-fork.mjs [fork rpc]
import { spawn } from 'node:child_process';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { zapPlan, zapCalldata } from '../dapp/lp-zap.js';

const FORK = process.argv[2] || 'https://ethereum-rpc.publicnode.com', PORT = 21000 + Math.floor(Math.random() * 3000), RPC = `http://127.0.0.1:${PORT}`;
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
const hex = (b) => Buffer.from(b).toString('hex'), sel = (s) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 8);
const word = (v) => BigInt(v).toString(16).padStart(64, '0'), b32 = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const TETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const POOLS = [
  { name: 'tETH/TAC', id: '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00', token: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', asset: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b' },
  { name: 'tETH/cUSD', id: '0x5925c0c2954c5b11bedd20e444f0cb22f3827f6197814f97d193e7a44e909da7', token: '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564', asset: '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d' },
  { name: 'tETH/cBTC', id: '0x8359cd1f812e3a9040129e186e1477f60f2188bad1bd6a56e5506b22bf5cd331', token: '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696', asset: '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8' },
];
const rpc = async (method, params) => { const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data }); return j.result; };
const call = (to, data, from, value = 0n) => rpc('eth_call', [{ to, data, ...(from ? { from } : {}), value: '0x' + BigInt(value).toString(16) }, 'latest']);
async function poolState(id) { const h = (await call(POOL, '0x' + sel('pools(bytes32)') + b32(id))).slice(2), w = (i) => BigInt('0x' + h.slice(i * 64, i * 64 + 64)); return { ra: w(3), rb: w(4), fee: w(5), t: w(6) }; }
const lpShareId = (poolId) => '0x' + hex(keccak_256(Buffer.from(b32(poolId) + '6c70', 'hex')));
const depositId = (poolId, shares, commit) => '0x' + hex(keccak_256(Buffer.from(b32(lpShareId(poolId)) + word(shares) + b32(commit), 'hex')));
async function send(from, to, data, value) {
  const h = await rpc('eth_sendTransaction', [{ from, to, data, value: '0x' + BigInt(value).toString(16), gas: '0x' + (3_000_000).toString(16) }]);
  let r = null;
  for (let i = 0; i < 120 && !r; i++) { r = await rpc('eth_getTransactionReceipt', [h]); if (!r) await new Promise((x) => setTimeout(x, 500)); }
  return { status: r?.status, gas: BigInt(r?.gasUsed || 0) };
}

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i++) { try { await rpc('eth_blockNumber', []); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const who = '0x' + '5a'.repeat(19) + '01';
  await rpc('anvil_setBalance', [who, '0x' + (100n * 10n ** 18n).toString(16)]);
  await rpc('anvil_impersonateAccount', [who]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  for (const p of POOLS) for (const eth of [3n * 10n ** 15n, 5n * 10n ** 16n, 3n * 10n ** 17n]) {
    const st = await poolState(p.id), plan = zapPlan({ eth, ra: st.ra, rb: st.rb, total: st.t, feeBps: st.fee });
    const commit = '0x' + hex(keccak_256(new TextEncoder().encode(`${p.name}:${eth}:${Date.now()}`)));
    const data = zapCalldata({ plan, router: ROUTER, amm: AMM, tokenB: p.token, assetA: TETH, assetB: p.asset, feeBps: Number(st.fee), deadline, commit });
    const out = (await call(ROUTER, data, who, plan.value)).slice(2), simShares = BigInt('0x' + out.slice(64, 128)), simDep = '0x' + out.slice(0, 64);
    const want = depositId(p.id, plan.shares, commit);
    ok(simShares === plan.shares && simDep === want, `${p.name} ${Number(eth) / 1e18} ETH: simulated, the zap mints exactly the ${plan.shares} shares planned and makes the deposit they and the commitment name`);
    const tokBefore = BigInt(await call(p.token, '0x70a08231' + b32(who)));
    const sent = await send(who, ROUTER, data, plan.value), st2 = await poolState(p.id);
    const status = BigInt(await call(POOL, '0x' + sel('depositStatus(bytes32)') + b32(want))), tokAfter = BigInt(await call(p.token, '0x70a08231' + b32(who)));
    ok(sent.status === '0x1' && st2.t - st.t === plan.shares && status === 1n, `${p.name} ${Number(eth) / 1e18} ETH: sent, the pool's shares rise by exactly ${plan.shares} and the deposit is pending (${sent.gas} gas)`);
    ok(tokAfter - tokBefore === plan.spare, `${p.name}: what the swap paid over the B leg comes back to the sender (${tokAfter - tokBefore} = ${plan.spare})`);
  }
  // a swap landing first: the zap quoted before it reverts, nothing is minted to a note that could not open it
  for (const p of POOLS) {
    const st = await poolState(p.id), plan = zapPlan({ eth: 10n ** 17n, ra: st.ra, rb: st.rb, total: st.t, feeBps: st.fee });
    const commit = '0x' + 'c3'.repeat(32), data = zapCalldata({ plan, router: ROUTER, amm: AMM, tokenB: p.token, assetA: TETH, assetB: p.asset, feeBps: Number(st.fee), deadline, commit });
    const swap = '0x' + sel('swapPublic(bytes32,bytes32,uint32,uint256,uint256,uint64,address)') + b32(TETH) + b32(p.asset) + word(st.fee) + word(2n * 10n ** 16n) + word(1) + word(deadline) + b32(who);
    const front = await send(who, AMM, swap, 2n * 10n ** 16n);
    let reverted = false;
    try { await call(ROUTER, data, who, plan.value); } catch { reverted = true; }
    ok(front.status === '0x1' && reverted, `${p.name}: with a swap landing first, the zap quoted before it reverts`);
  }
  console.log(`${n} checks`);
} finally { anvil.kill(); }
