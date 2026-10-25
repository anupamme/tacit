#!/usr/bin/env node
// The ETH → private LP zap's sizing (dapp/lp-zap.js) against the pool's own arithmetic (TacitPublicAmm's swap and add, the pool's pro-rata
// remove): with nothing in between, it mints exactly the shares its note commits to; with any trade, add or remove landing first, it mints at
// most that many, so with minShares set to them the transaction mints exactly them or reverts, and no deposit is left a note cannot open.
//   node tests/lp-zap.test.mjs
import { zapPlan, zapSplitPlan, zapSplitSearch, zapWorth, zapCalldata, ammOut, addShares } from '../dapp/lp-zap.js';

let n = 0; const ok = (c, m) => { if (c) { n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
let seed = 7n; const rnd = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return seed >> 11n; };
const between = (lo, hi) => lo + (rnd() % (hi - lo + 1n));
const U = 10n ** 10n, FEE = 30n;

// the pool, in units: a swap (fee off the input, the whole input joins), a public add (floors, takes the ceiling, refunds the rest), a remove
const swap = (st, x, aIn) => { const out = aIn ? ammOut(st.ra, st.rb, x, FEE) : ammOut(st.rb, st.ra, x, FEE); if (!out) return false; if (aIn) { st.ra += x; st.rb -= out; } else { st.rb += x; st.ra -= out; } return out; };
const add = (st, a, b) => { const r = addShares(a, b, st.ra, st.rb, st.t); if (!r.s) return 0n; st.ra += r.takeA; st.rb += r.takeB; st.t += r.s; return r.s; };
const remove = (st, s) => { if (s <= 0n || s >= st.t) return; st.ra -= (s * st.ra) / st.t; st.rb -= (s * st.rb) / st.t; st.t -= s; };
// the zap as the chain runs it: the swap must pay at least its floor (a unit over the B leg), the add must mint at least minShares →
// minted with what comes back (always some), or null (reverted)
function run(st, p) {
  const out = swap(st, p.swapIn / U, true);
  if (!out || out < p.floor / U) return null;
  const minted = add(st, p.ethLeg / U, p.bLeg / U);
  return minted >= p.shares && out - p.bLeg / U >= 1n ? minted : { short: minted };
}
const pool = () => { const ra = between(10n ** 6n, 10n ** 11n), price = between(1n, 10n ** 6n), rb = ra * price / between(1n, 1000n) + 1000n, t = (BigInt(Math.floor(Math.sqrt(Number(ra) * Number(rb)))) * between(500n, 1000n)) / 1000n + 1001n; return { ra, rb, t }; };

// the live pools as read on 2026-10-25
const LIVE = { 'tETH/TAC': { ra: 352091440n, rb: 5158198427799n, t: 41755593789n }, 'tETH/cUSD': { ra: 140465504n, rb: 261567636242n, t: 6028128243n }, 'tETH/cBTC': { ra: 78939932n, rb: 1398178n, t: 10476485n } };
for (const [name, st0] of Object.entries(LIVE)) for (const eth of ['0.003', '0.05', '0.5', '2']) {
  const wei = BigInt(Math.round(Number(eth) * 1e8)) * U, p = zapPlan({ eth: wei, ra: st0.ra, rb: st0.rb, total: st0.t });
  const st = { ...st0 }, m = p && run(st, p);
  ok(p && m === p.shares && p.value <= wei && p.value % U === 0n && p.bLeg % U === 0n && p.spare >= U && p.floor === p.bLeg + U, `${name} ${eth} ETH mints exactly the ${p?.shares} shares it commits to (${typeof m === 'bigint' ? m : JSON.stringify(m)})`);
}

// random pools and amounts, nothing in between: exact
let plans = 0;
for (let i = 0; i < 4000; i++) {
  const st0 = pool(), eth = between(3n, st0.ra / 2n + 3n) * U, p = zapPlan({ eth, ra: st0.ra, rb: st0.rb, total: st0.t });
  if (!p) continue;
  plans++;
  const st = { ...st0 }, m = run(st, p);
  ok(m === p.shares, `random pool ${i}: mints exactly ${p.shares} (${typeof m === 'bigint' ? m : JSON.stringify(m)}; ${JSON.stringify({ ...st0, eth: String(eth) }, (k, v) => (typeof v === 'bigint' ? String(v) : v))})`);
}
ok(plans > 3000, `most random pools take a zap (${plans} of 4000)`);

// anything landing first: never more than the shares committed to, so with minShares it is those shares or a revert
let exact = 0, reverted = 0;
for (let i = 0; i < 12000; i++) {
  const st0 = pool(), eth = between(3n, st0.ra / 3n + 3n) * U, p = zapPlan({ eth, ra: st0.ra, rb: st0.rb, total: st0.t });
  if (!p) continue;
  const st = { ...st0 };
  for (let k = 0, ops = Number(between(1n, 3n)); k < ops; k++) {
    const kind = rnd() % 4n;
    if (kind === 0n) swap(st, between(1n, st.ra / 5n + 1n), true);
    else if (kind === 1n) swap(st, between(1n, st.rb / 5n + 1n), false);
    else if (kind === 2n) add(st, between(1n, st.ra / 4n + 1n), between(1n, st.rb / 4n + 1n));
    else remove(st, between(1n, st.t / 4n + 1n));
  }
  const before = { ...st }, out = swap(st, p.swapIn / U, true);
  const minted = out ? addShares(p.ethLeg / U, p.bLeg / U, st.ra, st.rb, st.t).s : 0n;
  ok(minted <= p.shares, `race ${i}: the add would mint ${minted}, over the ${p.shares} committed to (${JSON.stringify(before, (k, v) => (typeof v === 'bigint' ? String(v) : v))})`);
  const m = run({ ...before }, p);
  if (m === p.shares) exact++; else reverted++;
}
ok(exact > 0 && reverted > 0, `with something landing first a zap is exact or reverts (${exact} exact, ${reverted} reverted)`);

// a split swap: part through this pool, part through another venue that pays at least its floor (anything from there up). With nothing in
// between it mints exactly the shares committed to and some B comes back; with anything landing first on this pool, never more than them
{
  let splits = 0, exactS = 0, revS = 0;
  for (let i = 0; i < 6000; i++) {
    const st0 = pool(), eth = between(10n, st0.ra / 2n + 10n) * U, base = zapPlan({ eth, ra: st0.ra, rb: st0.rb, total: st0.t });
    if (!base || base.swapIn / U < 2n) continue;
    const x = base.swapIn / U, ammX = between(1n, x - 1n), extX = x - ammX;
    // the other venue: a pool of its own, near this one's price, paying out on its own curve
    const depth = between(st0.ra / 4n + 1n, st0.ra * 4n + 1n), ext = { ra: depth, rb: depth * st0.rb / st0.ra + 1n };
    const extOut = ammOut(ext.ra, ext.rb, extX, FEE) || 0n, extMin = (extOut * between(9500n, 10000n)) / 10000n;
    const p = zapSplitPlan({ eth, ra: st0.ra, rb: st0.rb, total: st0.t, ammIn: ammX * U, extIn: extX * U, extMin: extMin * U });
    if (!p) continue;
    splits++;
    const runSplit = (st, paid) => {
      const out = swap(st, ammX, true);
      if (!out || out + paid < p.floor / U) return null;
      const minted = add(st, p.ethLeg / U, p.bLeg / U);
      return minted >= p.shares && out + paid - p.bLeg / U >= 1n ? minted : { short: minted };
    };
    const quiet = runSplit({ ...st0 }, extMin + between(0n, extOut - extMin));
    ok(quiet === p.shares && p.value <= eth && p.spare >= U, `split ${i}: with nothing in between it mints exactly ${p.shares} (${typeof quiet === 'bigint' ? quiet : JSON.stringify(quiet)})`);
    const st = { ...st0 };
    for (let k = 0, ops = Number(between(1n, 3n)); k < ops; k++) {
      const kind = rnd() % 4n;
      if (kind === 0n) swap(st, between(1n, st.ra / 5n + 1n), true);
      else if (kind === 1n) swap(st, between(1n, st.rb / 5n + 1n), false);
      else if (kind === 2n) add(st, between(1n, st.ra / 4n + 1n), between(1n, st.rb / 4n + 1n));
      else remove(st, between(1n, st.t / 4n + 1n));
    }
    const before = { ...st }, o = swap(st, ammX, true), minted = o ? addShares(p.ethLeg / U, p.bLeg / U, st.ra, st.rb, st.t).s : 0n;
    ok(minted <= p.shares, `split race ${i}: the add would mint ${minted}, over the ${p.shares} committed to`);
    const m = runSplit({ ...before }, extMin);
    if (m === p.shares) exactS++; else revS++;
  }
  ok(splits > 3000 && revS > 0, `split zaps are exact, or revert with something landing first (${splits} splits, ${exactS} exact, ${revS} reverted)`);
  // splitting the swap with a venue about as deep keeps more of a 1 ETH deposit than swapping all of it in the pool, and sends about all of it
  const L = LIVE['tETH/TAC'], eth = 10n ** 18n, inPool = zapPlan({ eth, ra: L.ra, rb: L.rb, total: L.t }), ext = { ra: L.ra * 11n / 10n, rb: L.rb * 11n / 10n };
  const quote = async (X) => {          // the division of X between the two that pays the most B
    let top = null;
    for (let f = 1n; f < 40n; f++) {
      const ammX = (X / U) * f / 40n, extX = X / U - ammX, o = ammOut(L.ra, L.rb, ammX, FEE) + ammOut(ext.ra, ext.rb, extX, FEE);
      if (!top || o > top.o) top = { o, ammIn: ammX * U, extIn: extX * U, extOut: ammOut(ext.ra, ext.rb, extX, FEE) * U };
    }
    return top;
  };
  const best = await zapSplitSearch({ eth, ra: L.ra, rb: L.rb, total: L.t, x0: inPool.swapIn, quote }), wIn = zapWorth({ ra: L.ra, rb: L.rb, total: L.t }, inPool);
  ok(best && best.worth.perSent > wIn.perSent + 0.015 && best.plan.value * 1000n >= eth * 995n, `a 1 ETH zap into tETH/TAC split with a venue as deep keeps ${best ? (best.worth.perSent * 100).toFixed(2) : '—'}% of what it sends, against ${(wIn.perSent * 100).toFixed(2)}% all in the pool`);
}

// the calldata: the zap's selector, the legs, the shares as minShares, the swap's floor a unit over the B leg, the router paid the swap
{
  const p = zapPlan({ eth: 5n * 10n ** 16n, ...{ ra: LIVE['tETH/TAC'].ra, rb: LIVE['tETH/TAC'].rb, total: LIVE['tETH/TAC'].t } });
  const router = '0x000000005dA3E3B73726af3c774Deeb9472D4992', amm = '0x00000000E36C7EC997CC59DCda9E03673B448119', tac = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
  const cd = zapCalldata({ plan: p, router, amm, tokenB: tac, assetA: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', assetB: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', deadline: 2n ** 40n, commit: '0x' + 'ab'.repeat(32) });
  const w = (i) => BigInt('0x' + cd.slice(10 + i * 64, 10 + (i + 1) * 64));
  const floorWord = p.floor.toString(16).padStart(64, '0'), swapAt = cd.indexOf('cfdf9dcc');
  ok(cd.startsWith('0xf9d1fa01') && w(2) === p.ethLeg && w(3) === p.bLeg && w(4) === p.shares && w(7) === 256n && cd.includes('5f3bd1c8') && swapAt > 0 && cd.slice(swapAt + 8 + 4 * 64, swapAt + 8 + 5 * 64) === floorWord && cd.toLowerCase().includes(amm.slice(2).toLowerCase()),
    'the calldata carries the legs, the shares as minShares, and the swap through the pool with its floor a unit over the B leg');
}
console.log(`${n} checks`);
