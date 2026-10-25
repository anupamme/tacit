#!/usr/bin/env node
// The ETH → private LP zap with its swap split between the tETH/TAC pool and the Precision pool (dapp/lp-zap.js zapSplitPlan, the trade
// venues' quoteSplit and buildSplit as the swap leg), against the live contracts on an anvil fork of mainnet. For each deposit size the
// split is searched over the total swapped and compared with the all-in-pool zap by what the depositor ends with (the position at the
// pool's price before, plus what comes back). The best split, sent, mints exactly the shares its note commits to, leaves the deposit pending
// and refunds some TAC to the sender; a swap landing first on either venue makes the same zap revert or still mint exactly those shares.
//   node tests/lp-zap-split-fork.mjs [fork rpc]
import { spawn } from 'node:child_process';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { zapPlan, zapSplitSearch, zapWorth, zapCalldata } from '../dapp/lp-zap.js';
import { makeEvmTradeVenues } from '../dapp/evm-trade-venues.js';

const FORK = process.argv[2] || 'https://ethereum-rpc.publicnode.com', PORT = 24000 + Math.floor(Math.random() * 3000), RPC = `http://127.0.0.1:${PORT}`;
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
const hex = (b) => Buffer.from(b).toString('hex'), sel = (s) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 8);
const word = (v) => BigInt(v).toString(16).padStart(64, '0'), b32 = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const TETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC_ID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', POOL_ID = '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00', U = 10n ** 10n;
const rpc = async (method, params) => { const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data }); return j.result; };
const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: o.value } : {}), ...(o.gas ? { gas: o.gas } : {}) }, block]);
async function poolState() { const h = (await ethCall(POOL, '0x' + sel('pools(bytes32)') + b32(POOL_ID))).slice(2), w = (i) => BigInt('0x' + h.slice(i * 64, i * 64 + 64)); return { ra: w(3), rb: w(4), fee: w(5), t: w(6) }; }
const lpShareId = (poolId) => '0x' + hex(keccak_256(Buffer.from(b32(poolId) + '6c70', 'hex')));
const depositId = (shares, commit) => '0x' + hex(keccak_256(Buffer.from(b32(lpShareId(POOL_ID)) + word(shares) + b32(commit), 'hex')));
async function send(from, to, data, value) {
  const h = await rpc('eth_sendTransaction', [{ from, to, data, value: '0x' + BigInt(value).toString(16), gas: '0x' + (3_000_000).toString(16) }]);
  let r = null;
  for (let i = 0; i < 120 && !r; i++) { r = await rpc('eth_getTransactionReceipt', [h]); if (!r) await new Promise((x) => setTimeout(x, 500)); }
  return r;
}
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i++) { try { await rpc('eth_blockNumber', []); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const who = '0x' + '5b'.repeat(19) + '02', other = '0x' + '5b'.repeat(19) + '03';
  for (const a of [who, other]) { await rpc('anvil_setBalance', [a, '0x' + (100n * 10n ** 18n).toString(16)]); await rpc('anvil_impersonateAccount', [a]); }
  const venues = makeEvmTradeVenues({ ethCall, keccak256: keccak_256 });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600), SLIP = 50n;
  // the best split for `eth` (dapp/lp-zap.js zapSplitSearch), each total divided by the trade venues' quoteSplit at the farm pool's own tier
  const bestSplit = (st, eth, x0) => zapSplitSearch({ eth, ra: st.ra, rb: st.rb, total: st.t, feeBps: st.fee, x0, slipBps: SLIP, quote: async (X) => {
    const sp = await venues.quoteSplit({ dir: 'ETH_TO_TAC', amountIn: X, account: who }).catch(() => null);
    if (!sp || Number(sp.legs[1].feeBps) !== Number(st.fee)) return null;
    return { ammIn: sp.legs[1].amountIn, extIn: sp.legs[0].amountIn, extOut: sp.legs[0].amountOut, sp };
  } }).then((b) => b && { ...b, p: b.plan, sp: b.plan.q.sp, X: b.plan.swapIn, v: b.worth.perSent });
  const results = [];
  for (const eth of [3n * 10n ** 17n, 5n * 10n ** 17n, 10n ** 18n, 2n * 10n ** 18n]) {
    const st = await poolState(), inPool = zapPlan({ eth, ra: st.ra, rb: st.rb, total: st.t, feeBps: st.fee });
    const vIn = zapWorth({ ra: st.ra, rb: st.rb, total: st.t }, inPool).perSent, b = await bestSplit(st, eth, inPool.swapIn);
    results.push({ eth, vIn, b, inPool });
    console.log(`  ${Number(eth) / 1e18} ETH: all in the pool keeps ${(vIn * 100).toFixed(2)}% of what is sent (impact ${(inPool.impact * 100).toFixed(1)}%); best split ${b ? `${(b.v * 100).toFixed(2)}% (swaps ${(Number(b.X) / Number(inPool.swapIn)).toFixed(3)}× the in-pool swap, ${(Number(b.sp.legs[0].amountIn) / Number(b.X) * 100).toFixed(0)}% of it through Precision, sends ${(Number(b.p.value) / 1e18).toFixed(4)} ETH, ${(Number(b.p.paid - b.p.bLeg) / 1e18).toFixed(2)} TAC back, impact ${(b.p.impact * 100).toFixed(1)}%)` : 'none'}`);
  }
  const big = results.filter((r) => r.eth >= 10n ** 18n);
  ok(big.every((r) => r.b && r.b.v > r.vIn + 0.01 && r.b.p.value * 100n >= r.eth * 98n), `from 1 ETH the split keeps over 1% more of what is sent than all in the pool, sending at least 98% of it (${big.map((r) => `${Number(r.eth) / 1e18} ETH: +${r.b ? ((r.b.v - r.vIn) * 100).toFixed(2) : '—'} points`).join(', ')})`);

  // the best 1 ETH split, sent: exactly the committed shares, the deposit pending, TAC back to the sender
  for (const r of results.filter((x) => x.eth >= 5n * 10n ** 17n)) {
    const st = await poolState(), b = await bestSplit(st, r.eth, r.inPool.swapIn);
    const commit = '0x' + hex(keccak_256(new TextEncoder().encode(`split:${r.eth}:${Date.now()}`)));
    const [l1, l2] = b.sp.legs, split = { ...b.sp, legs: [l1, { ...l2, feeBps: Number(st.fee) }] };
    const built = venues.buildSplit({ split, account: who, to: ROUTER, minOut: b.p.out, deadline });
    ok(built.value === b.p.swapIn && built.minOut === b.p.out && b.p.out >= b.p.floor, `${Number(r.eth) / 1e18} ETH: the split's zRouter call is sent exactly the ETH the plan swaps, and must pay the least the plan counts on (over the add's leg)`);
    const data = zapCalldata({ plan: b.p, router: ROUTER, amm: AMM, tokenB: TAC, assetA: TETH, assetB: TAC_ID, feeBps: Number(st.fee), deadline, commit, swapData: built.data });
    const sim = (await ethCall(ROUTER, data, 'latest', { from: who, value: '0x' + b.p.value.toString(16) })).slice(2);
    ok(BigInt('0x' + sim.slice(64, 128)) === b.p.shares && '0x' + sim.slice(0, 64) === depositId(b.p.shares, commit), `${Number(r.eth) / 1e18} ETH: simulated, the split zap mints exactly the ${b.p.shares} shares planned`);
    const rc = await send(who, ROUTER, data, b.p.value), st2 = await poolState();
    const status = BigInt(await ethCall(POOL, '0x' + sel('depositStatus(bytes32)') + b32(depositId(b.p.shares, commit))));
    const refund = rc.logs.find((l) => l.address.toLowerCase() === TAC.toLowerCase() && l.topics[1] === '0x' + b32(ROUTER) && l.topics[2] === '0x' + b32(who));
    ok(rc.status === '0x1' && st2.t - st.t === b.p.shares && status === 1n && refund && BigInt(refund.data) >= U, `${Number(r.eth) / 1e18} ETH: sent, the pool's shares rise by exactly ${b.p.shares}, the deposit is pending and ${refund ? Number(BigInt(refund.data)) / 1e18 : 0} TAC comes back (${BigInt(rc.gasUsed)} gas)`);
  }

  // a swap landing first on either venue: the zap quoted before it reverts, or still mints exactly its shares
  for (const venue of ['tacit', 'precision']) {
    const st = await poolState(), eth = 10n ** 18n, inPool = zapPlan({ eth, ra: st.ra, rb: st.rb, total: st.t, feeBps: st.fee }), b = await bestSplit(st, eth, inPool.swapIn);
    const [l1, l2] = b.sp.legs, split = { ...b.sp, legs: [l1, { ...l2, feeBps: Number(st.fee) }] }, commit = '0x' + 'd4'.repeat(31) + (venue === 'tacit' ? '01' : '02');
    const data = zapCalldata({ plan: b.p, router: ROUTER, amm: AMM, tokenB: TAC, assetA: TETH, assetB: TAC_ID, feeBps: Number(st.fee), deadline, commit, swapData: venues.buildSplit({ split, account: who, to: ROUTER, minOut: b.p.out, deadline }).data });
    if (venue === 'tacit') await send(other, AMM, '0x' + sel('swapPublic(bytes32,bytes32,uint32,uint256,uint256,uint64,address)') + b32(TETH) + b32(TAC_ID) + word(st.fee) + word(2n * 10n ** 17n) + word(1) + word(deadline) + b32(other), 2n * 10n ** 17n);
    else {
      // someone else's buy of TAC on the Precision pool: its own guard and route legs through zRouter
      const q = await venues.quoteSplit({ dir: 'ETH_TO_TAC', amountIn: 6n * 10n ** 17n, account: other }), pl = q.legs[0];
      const leg = venues.precisionLegs({ quote: pl, account: other, minOut: 1n, deadline });
      const dyn = (h) => { const x = h.replace(/^0x/, ''); return word(x.length / 2) + x.padEnd(Math.ceil(x.length / 64) * 64, '0'); };
      let head = '', tail = '', off = leg.legs.length * 32;
      for (const c of leg.legs) { const body = dyn(c); head += word(off); tail += body; off += body.length / 2; }
      const front = await send(other, '0x000000000000FB114709235f1ccBFfb925F600e4', '0xac9650d8' + word(32) + word(leg.legs.length) + head + tail, leg.value);
      ok(front.status === '0x1', 'a buy of TAC on the Precision pool lands first');
    }
    let outcome = 'reverted';
    try {
      const sim = (await ethCall(ROUTER, data, 'latest', { from: who, value: '0x' + b.p.value.toString(16) })).slice(2);
      outcome = BigInt('0x' + sim.slice(64, 128)) === b.p.shares ? 'exact' : `minted ${BigInt('0x' + sim.slice(64, 128))}`;
    } catch { }
    ok(outcome === 'reverted' || outcome === 'exact', `with a swap landing first on the ${venue === 'tacit' ? 'tETH/TAC' : 'Precision'} pool, the split zap ${outcome === 'exact' ? 'still mints exactly its shares' : outcome}`);
  }
  console.log(`${n} checks`);
} finally { anvil.kill(); }
