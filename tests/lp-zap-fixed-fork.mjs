#!/usr/bin/env node
// The ETH → private LP zap for a share count fixed first (dapp/lp-zap.js zapPlanFor), against the live contracts on an anvil fork of mainnet,
// into each farmed Tacit pool. The shares are planned at the pool's reserves (when the share note's proof would start) and the deposit they
// and the commitment make is named; a public swap then moves the pool, making the other coin dearer or cheaper. The zap sized before the move
// reverts after it; sized again by zapPlanFor for the same shares at the new reserves, it lands, mints exactly those shares and leaves the
// same deposit pending, so a proof made for that deposit before the move settles it.
//   node tests/lp-zap-fixed-fork.mjs [fork rpc]      (or FORK_URL=<rpc url>)
import { spawn, spawnSync } from 'node:child_process';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { zapPlan, zapPlanFor, zapCalldata } from '../dapp/lp-zap.js';

if (spawnSync('anvil', ['--version']).status !== 0) { console.log('skip - needs anvil'); process.exit(0); }
const FORK = process.env.FORK_URL || process.argv[2] || 'https://eth.drpc.org', PORT = 27000 + Math.floor(Math.random() * 3000), RPC = `http://127.0.0.1:${PORT}`;
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
const hex = (b) => Buffer.from(b).toString('hex'), sel = (s) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 8);
const word = (v) => BigInt(v).toString(16).padStart(64, '0'), b32 = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const TETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', U = 10n ** 10n;
const POOLS = [
  { name: 'tETH/TAC', id: '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00', token: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', asset: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b' },
  { name: 'tETH/cUSD', id: '0x5925c0c2954c5b11bedd20e444f0cb22f3827f6197814f97d193e7a44e909da7', token: '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564', asset: '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d' },
  { name: 'tETH/cBTC', id: '0x8359cd1f812e3a9040129e186e1477f60f2188bad1bd6a56e5506b22bf5cd331', token: '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696', asset: '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8' },
];
const ERRORS = Object.fromEntries(['SlippageExceeded()', 'ShortSwapOutput()', 'InsufficientLiquidity()', 'InsufficientOutput()', 'AmountNotAligned()'].map((e) => ['0x' + sel(e), e]));
const rpc = async (method, params) => { const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data }); return j.result; };
const call = (to, data, from, value = 0n) => rpc('eth_call', [{ to, data, ...(from ? { from } : {}), value: '0x' + BigInt(value).toString(16) }, 'latest']);
async function poolState(id) { const h = (await call(POOL, '0x' + sel('pools(bytes32)') + b32(id))).slice(2), w = (i) => BigInt('0x' + h.slice(i * 64, i * 64 + 64)); return { ra: w(3), rb: w(4), fee: w(5), t: w(6) }; }
const lpShareId = (poolId) => '0x' + hex(keccak_256(Buffer.from(b32(poolId) + '6c70', 'hex')));
const depositId = (poolId, shares, commit) => '0x' + hex(keccak_256(Buffer.from(b32(lpShareId(poolId)) + word(shares) + b32(commit), 'hex')));
const balanceOf = async (token, who) => BigInt(await call(token, '0x70a08231' + b32(who)));
async function send(from, to, data, value = 0n) {
  const h = await rpc('eth_sendTransaction', [{ from, to, data, value: '0x' + BigInt(value).toString(16), gas: '0x' + (3_000_000).toString(16) }]);
  let r = null;
  for (let i = 0; i < 120 && !r; i++) { r = await rpc('eth_getTransactionReceipt', [h]); if (!r) await new Promise((x) => setTimeout(x, 500)); }
  return { status: r?.status, gas: BigInt(r?.gasUsed || 0) };
}
// the zap simulated as it would be sent → { dep, shares } or { reverted: the error's name or selector }
async function simulate(data, from, value) {
  try { const out = (await call(ROUTER, data, from, value)).slice(2); return { dep: '0x' + out.slice(0, 64), shares: BigInt('0x' + out.slice(64, 128)) }; }
  catch (e) { const d = String(e.data?.data ?? e.data ?? '').slice(0, 10); return { reverted: ERRORS[d] || d || e.message }; }
}
const eth = (w) => (Number(w) / 1e18).toFixed(6);

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i++) { try { await rpc('eth_blockNumber', []); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const who = '0x' + '5c'.repeat(19) + '01', other = '0x' + '5c'.repeat(19) + '02';
  for (const a of [who, other]) { await rpc('anvil_setBalance', [a, '0x' + (100n * 10n ** 18n).toString(16)]); await rpc('anvil_impersonateAccount', [a]); }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600), SEND = 5n * 10n ** 16n, CAP = 10n ** 17n;
  const swapIn = (p, fee, assetIn, assetOut, amount, to) => '0x' + sel('swapPublic(bytes32,bytes32,uint32,uint256,uint256,uint64,address)') + b32(assetIn) + b32(assetOut) + word(fee) + word(amount) + word(1) + word(deadline) + b32(to);
  for (const p of POOLS) for (const move of ['dearer', 'cheaper']) {
    const label = `${p.name}, the other coin ${move}`;
    // someone else's trades: a tenth of the pool's tETH buys the other coin (dearer); for cheaper they buy first and, once the shares are
    // planned, sell all of it they hold
    let st = await poolState(p.id);
    const buy = (st.ra / 10n) * U;
    if (move === 'cheaper') {
      ok((await send(other, AMM, swapIn(p, st.fee, TETH, p.asset, buy, other), buy)).status === '0x1', `${label}: someone buys the other coin first`);
      await send(other, p.token, '0x095ea7b3' + b32(AMM) + word((1n << 256n) - 1n));
      st = await poolState(p.id);
    }
    // the shares fixed now, at these reserves: what 0.05 ETH buys, and the deposit they and the note's commitment make
    const z = zapPlan({ eth: SEND, ra: st.ra, rb: st.rb, total: st.t, feeBps: st.fee }), S = z.shares;
    const commit = '0x' + hex(keccak_256(new TextEncoder().encode(`fixed:${p.name}:${move}:${Date.now()}`))), dep = depositId(p.id, S, commit);
    const old = zapCalldata({ plan: z, router: ROUTER, amm: AMM, tokenB: p.token, assetA: TETH, assetB: p.asset, feeBps: Number(st.fee), deadline, commit });
    const f0 = zapPlanFor({ shares: S, ra: st.ra, rb: st.rb, total: st.t, feeBps: st.fee, maxEth: CAP }), s0 = await simulate(old, who, z.value);
    ok(s0.shares === S && s0.dep === dep && f0 && f0.value <= z.value, `${label}: before the move the zap for ${S} shares mints them into the deposit named (${eth(z.value)} ETH; zapPlanFor at these reserves ${f0 && eth(f0.value)})`);

    // the move
    const mv = move === 'dearer' ? await send(other, AMM, swapIn(p, st.fee, TETH, p.asset, buy, other), buy) : await send(other, AMM, swapIn(p, st.fee, p.asset, TETH, (await balanceOf(p.token, other) / U) * U, other));
    const st1 = await poolState(p.id), price = (s) => Number(s.ra) / Number(s.rb);
    ok(mv.status === '0x1' && st1.t === st.t, `${label}: a public swap moves the other coin's price ${((price(st1) / price(st) - 1) * 100).toFixed(1)}% in tETH`);

    // the zap sized before the move now reverts: nothing is minted that the note could not open
    const s1 = await simulate(old, who, z.value);
    ok(s1.reverted, `${label}: the zap sized before the move reverts after it (${s1.reverted ?? `minted ${s1.shares}`})`);

    // sized again for the same shares at the new reserves: exactly S, into the deposit named before the move
    const f1 = zapPlanFor({ shares: S, ra: st1.ra, rb: st1.rb, total: st1.t, feeBps: st1.fee, maxEth: CAP });
    ok(f1 && f1.shares === S && f1.value <= CAP && f1.left === CAP - f1.value, `${label}: zapPlanFor sizes the same ${S} shares at the new reserves (${f1 ? eth(f1.value) : '—'} ETH, against ${eth(z.value)} before; swap ${f1 ? eth(f1.swapIn) : '—'}, ETH leg ${f1 ? eth(f1.ethLeg) : '—'})`);
    if (!f1) continue;
    const data = zapCalldata({ plan: f1, router: ROUTER, amm: AMM, tokenB: p.token, assetA: TETH, assetB: p.asset, feeBps: Number(st1.fee), deadline, commit });
    const s2 = await simulate(data, who, f1.value);
    ok(s2.shares === S && s2.dep === dep, `${label}: simulated, it mints exactly ${S} shares into the deposit named before the move (${s2.reverted ?? s2.dep.slice(0, 12)})`);
    const tokBefore = await balanceOf(p.token, who), sent = await send(who, ROUTER, data, f1.value), st2 = await poolState(p.id);
    const status = BigInt(await call(POOL, '0x' + sel('depositStatus(bytes32)') + b32(dep))), back = (await balanceOf(p.token, who)) - tokBefore;
    ok(sent.status === '0x1' && st2.t - st1.t === S && status === 1n, `${label}: sent, it lands, the pool's shares rise by exactly ${S} and the deposit named before the move is pending (${sent.gas} gas)`);
    ok(back === f1.spare && back >= U, `${label}: what the swap paid over the B leg comes back to the sender (${back} = ${f1.spare})`);
  }
  console.log(`${n} checks`);
} finally { anvil.kill(); }
