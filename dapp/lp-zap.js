// One transaction from ETH to a private LP position in a Tacit pool (ConfidentialRouter.zapETHIntoShieldedLP): part of the ETH is swapped for
// the pool's other coin inside the same pool (zRouter's snwap calling TacitPublicAmm.swapPublic), both legs are added, and the LP shares are
// shielded into a pending deposit bound to a share note's commitment, which the relay then settles into the note (OP_WRAP) for the farm.
//
// The commitment fixes the share count, and the pool keeps no way back for a deposit no note opens, so the legs are sized to mint exactly S
// shares: each leg alone floors to S at the reserves the swap leaves, and minShares is S. A trade or a liquidity move that lands first cannot
// raise both legs' shares (a swap never lowers k, adds and removes round for the pool), and after it the zap's own swap leaves one leg short,
// so the add mints exactly S or the whole transaction reverts. tests/lp-zap.test.mjs checks this against the pool's own arithmetic.
// zapPlan sizes the zap for an amount of ETH; zapPlanFor sizes it for an S fixed first, so the note's proof can be made before it is sent.
//
// The B leg stays at least a unit under what the swap pays, so the router always refunds some B to the sender: that Transfer is the log a
// key finds its zaps by (the pool keeps no event for shielded shares), and the zap's calldata holds the shares and the commitment.

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const b32 = (h) => String(h).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const bytes = (h) => { const s = String(h).replace(/^0x/, ''); return word(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0'); };
const ceil = (x, y) => (x + y - 1n) / y;
function isqrt(n) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }

// TacitPublicAmm._ammOut: the fee comes off the input; the whole input joins the reserve.
export function ammOut(rIn, rOut, vIn, feeBps) {
  const g = vIn * (10000n - BigInt(feeBps));
  const out = (rOut * g) / (rIn * 10000n + g);
  return out > 0n && out < rOut ? out : 0n;
}

// The shares of an add at reserves (ra, rb) and supply t, and what it takes of each leg (TacitPublicAmm.createPairAndAddLiquidityPublic).
export function addShares(a, b, ra, rb, t) {
  const sA = (a * t) / ra, sB = (b * t) / rb, s = sA < sB ? sA : sB;
  return { s, sA, sB, takeA: s ? ceil(s * ra, t) : 0n, takeB: s ? ceil(s * rb, t) : 0n };
}

// Legs that each floor to the same S at (ra, rb, t), using at most `aMax` of A and `bMax` of B: S is read off the coarser leg (the one worth
// more shares a unit; at most one leg can be worth more than one), and the finer leg is the least that floors to it. → { a, b, s } or null.
export function exactLegs(aMax, bMax, ra, rb, t) {
  const coarseA = ra < rb;                                                              // t/ra > t/rb
  // the coarse leg starts no higher than the shares the fine leg's cap allows, so a short fine leg is not walked down a unit at a time
  const [cMax, fMax, rc, rf] = coarseA ? [aMax, bMax, ra, rb] : [bMax, aMax, rb, ra];
  const sCap = (fMax * t) / rf, cCap = ((sCap + 1n) * rc - 1n) / t;
  for (let i = 0n, top = cMax < cCap ? cMax : cCap; i < 4096n && top - i > 0n; i++) {
    const c = top - i, s = coarseA ? (c * t) / ra : (c * t) / rb;
    if (s <= 0n) return null;
    const f = coarseA ? ceil(s * rb, t) : ceil(s * ra, t);
    if (f > (coarseA ? bMax : aMax)) continue;
    const a = coarseA ? c : f, b = coarseA ? f : c;
    if ((a * t) / ra === s && (b * t) / rb === s) return { a, b, s };
  }
  return null;
}

// The zap for `eth` wei into a pool whose A side is tETH: reserves and supply in pool units (8 decimals), `unitA`/`unitB` the wei per unit.
// → { swapIn, ethLeg, bLeg, value (wei, all multiples of the units), shares, out (B the swap pays, in wei), spare (B refunded, never none),
// left (ETH not sent), impact } or null when the amount is too small to mint a share.
export function zapPlan({ eth, ra, rb, total, feeBps = 30n, unitA = 10n ** 10n, unitB = 10n ** 10n }) {
  ra = BigInt(ra); rb = BigInt(rb); total = BigInt(total);
  const E = BigInt(eth) / BigInt(unitA), f = BigInt(feeBps);
  if (E < 2n || !(ra > 0n && rb > 0n && total > 0n)) return null;
  // the swap that leaves the rest in the pool's new ratio: x² (1-f) + x·ra·(2-f) - E·ra = 0, with f = feeBps/1e4 (Uniswap's single-sided zap)
  const g = 10000n - f, two = 20000n - f;
  const disc = ra * ra * two * two + 4n * g * E * ra * 10000n;
  let x0 = (isqrt(disc) - ra * two) / (2n * g);
  if (x0 < 1n) x0 = 1n;
  let best = null;
  const tryX = (x) => {
    if (x < 1n || x >= E) return;
    const out = ammOut(ra, rb, x, f);
    if (out < 2n) return;
    const ra2 = ra + x, rb2 = rb - out, legs = exactLegs(E - x, out - 1n, ra2, rb2, total);
    if (legs && (!best || legs.s > best.s || (legs.s === best.s && legs.a + x < best.a + best.x))) best = { x, out, ra2, rb2, ...legs };
  };
  for (let d = -48n; d <= 48n; d++) tryX(x0 + d);
  return best && planShape({ ra, rb, total, f, unitA, unitB }, best, eth);
}

// A plan from its swap (x units of A paying `out` units of B) and legs (a, b) that each floor to s at the reserves the swap leaves; `left`
// is what of `cap` wei it does not send (none without a cap).
function planShape({ ra, rb, total, f, unitA, unitB }, { x, out, a, b, s }, cap) {
  const uA = BigInt(unitA), uB = BigInt(unitB), value = (x + a) * uA, mid = (Number(rb) * Number(x) * Number(10000n - f)) / (Number(ra) * 10000);
  return {
    swapIn: x * uA, ethLeg: a * uA, bLeg: b * uB, floor: (b + 1n) * uB, value, shares: s,
    out: out * uB, spare: (out - b) * uB, left: cap == null ? 0n : BigInt(cap) - value,
    // what the swap gets under the pool's price before it (its fee aside), as a share: as the farm's one-sided join says it
    impact: mid > 0 ? Math.max(0, 1 - Number(out) / mid) : 0, reservesAfter: { ra: ra + x, rb: rb - out }, shareOfPool: Number(s) / Number(total + s),
  };
}

// A leg of v units floors to S at reserve r (supply t) when S·r ≤ v·t < (S+1)·r, so it does at the reserves (v·t/(S+1), v·t/S]. On the
// pool's larger side (a unit worth at most a share) some leg does at every reserve; on the smaller side only at some. → the nearest reserve
// to r, at or above it (`up`) or at or below it, at which some leg floors to S, or null.
function legFit(S, t, r, up) {
  let v = up ? ceil(S * r, t) : (r * (S + 1n) - 1n) / t;           // the first leg whose reserves reach r from that side
  for (let i = 0; i < 65536 && v > 0n; i++, v += up ? 1n : -1n) {
    const lo = (v * t) / (S + 1n) + 1n, hi = (v * t) / S, at = up ? (r > lo ? r : lo) : (r < hi ? r : hi);
    if (lo <= at && at <= hi) return at;
  }
  return null;
}

// The zap that mints exactly `shares` (S), fixed before the reserves are known, with the least ETH. The note's proof binds only the LP
// asset, S and the commitment, so a page that fixes S can have the proof made while the zap waits, and size the zap when it is sent to
// mint exactly S at whatever the reserves are then. It keeps zapPlan's rules (each leg alone floors to S at the reserves the swap leaves,
// the B leg a unit under what the swap pays). The least swap pays a unit over the least B leg; from there the swap grows only as far as
// both legs can floor to S (the smaller side's leg, worth over a share a unit, does only at some reserves: the A reserve rises with the
// swap, the B reserve falls). Each swap passed over breaks a rule and each larger one sends more, so no zap for S sends less.
// → zapPlan's shape (`left` what of maxEth it does not send), or null: no exact zap for S (fewer shares than a unit of the smaller side is
// worth are often out of reach) or none within maxEth wei.
export function zapPlanFor({ shares, ra, rb, total, feeBps = 30n, unitA = 10n ** 10n, unitB = 10n ** 10n, maxEth = null }) {
  ra = BigInt(ra); rb = BigInt(rb);
  const t = BigInt(total), S = BigInt(shares), f = BigInt(feeBps), g = 10000n - f;
  if (S < 1n || !(ra > 0n && rb > 0n && t > 0n)) return null;
  // the least swap paying o (ammOut floors rb·x·g / (ra·1e4 + x·g)); the swap must pay out with out - 1 ≥ ceil(S·(rb - out)/t)
  const swapFor = (o) => (o < rb ? ceil(o * ra * 10000n, g * (rb - o)) : null);
  let x = swapFor(ceil(S * rb + t, t + S));
  for (let i = 0; i < 4096 && x !== null; i++) {
    if (x < 1n) x = 1n;
    const out = ammOut(ra, rb, x, f), ra2 = ra + x, rb2 = rb - out, a = ceil(S * ra2, t);
    if (!out || (maxEth != null && (x + a) * BigInt(unitA) > BigInt(maxEth))) return null;
    const r = legFit(S, t, ra2, true);
    if (r === null) return null;
    if (r > ra2) { x = r - ra; continue; }                         // the A reserve rises one unit a unit of swap
    const y = legFit(S, t, rb2, false);
    if (y === null) return null;
    if (y < rb2) { x = swapFor(rb - y); continue; }               // the least swap leaving at most y of B
    return planShape({ ra, rb, total: t, f, unitA, unitB }, { x, out, a, b: ceil(S * rb2, t), s: S }, maxEth);
  }
  return null;
}

// A zap whose swap is split: `ammIn` wei of it through this pool (whose output, and the reserves it leaves, are known exactly) and `extIn`
// wei through another venue that pays at least `extMin` wei of B. The legs are sized at the reserves this pool's part leaves, as zapPlan's
// are, against the least both parts pay together: so the add mints exactly S or reverts as zapPlan's does (the other venue moves nothing
// the add reads), and what it pays over its least comes back with the rest. → zapPlan's shape (`out` the least the swap pays), or null.
export function zapSplitPlan({ eth, ra, rb, total, feeBps = 30n, ammIn, extIn, extMin, unitA = 10n ** 10n, unitB = 10n ** 10n }) {
  ra = BigInt(ra); rb = BigInt(rb); total = BigInt(total); ammIn = BigInt(ammIn); extIn = BigInt(extIn); extMin = BigInt(extMin);
  const uA = BigInt(unitA), uB = BigInt(unitB), x = ammIn / uA, f = BigInt(feeBps), swapWei = ammIn + extIn;
  if (ammIn % uA !== 0n || x < 1n || extIn < 0n || extMin < 0n || swapWei >= BigInt(eth) || !(ra > 0n && rb > 0n && total > 0n)) return null;
  const out = ammOut(ra, rb, x, f), least = out + extMin / uB;
  if (!out || least < 2n) return null;
  const ra2 = ra + x, rb2 = rb - out, legs = exactLegs((BigInt(eth) - swapWei) / uA, least - 1n, ra2, rb2, total);
  if (!legs) return null;
  const mid = (Number(rb) * (Number(swapWei) / Number(uA)) * Number(10000n - f)) / (Number(ra) * 10000);
  return {
    swapIn: swapWei, ammIn, extIn, ethLeg: legs.a * uA, bLeg: legs.b * uB, floor: (legs.b + 1n) * uB, value: swapWei + legs.a * uA, shares: legs.s,
    out: out * uB + extMin, ammOut: out * uB, spare: out * uB + extMin - legs.b * uB, left: BigInt(eth) - swapWei - legs.a * uA,
    impact: mid > 0 ? Math.max(0, 1 - Number(least) / mid) : 0, reservesAfter: { ra: ra2, rb: rb2 }, shareOfPool: Number(legs.s) / Number(total + legs.s),
  };
}

// The calldata, for ConfidentialRouter.zapETHIntoShieldedLP with zRouter.snwap → TacitPublicAmm.swapPublic as its swap leg; the swap's floor
// is a unit over the B leg, so it pays what the add takes and some comes back. `to` of the swap is the router, which holds both legs.
// `swapData` is another zRouter call for the swap (a split's), which must pay the router at least the plan's floor.
export function zapCalldata({ plan, router, amm, tokenB, assetA, assetB, feeBps = 30, deadline, commit, swapData = null }) {
  return '0xf9d1fa01' + addr(tokenB) + word(feeBps) + word(plan.ethLeg) + word(plan.bLeg) + word(plan.shares) + word(deadline) + b32(commit) + word(8 * 32)
    + bytes(zapSwap({ plan, router, amm, tokenB, assetA, assetB, feeBps, deadline, swapData }));
}
// The zap's swap leg: the trade venues' own call where given (a split), else zRouter's snwap into this pool's swapPublic.
function zapSwap({ plan, router, amm, tokenB, assetA, assetB, feeBps, deadline, swapData }) {
  if (swapData) return String(swapData).replace(/^0x/, '');
  const swap = 'cfdf9dcc' + b32(assetA) + b32(assetB) + word(feeBps) + word(plan.swapIn) + word(plan.floor) + word(deadline) + addr(router);
  return '5f3bd1c8' + addr('0x0') + word(0) + addr(router) + addr(tokenB) + word(plan.floor) + addr(amm) + word(7 * 32) + bytes(swap);
}
// ConfidentialRouter.zapETHIntoFarm: the same zap, then in the same call the settle of a proof that consumes its share deposit (the share
// note's OP_WRAP, proved before anything was sent; the router settles it fee-free, as wrapAndSettleETH does a wrap's). One transaction
// from any wallet: the shares are minted, shielded and made a private note together, or nothing happens.
export function zapSettleCalldata({ plan, router, amm, tokenB, assetA, assetB, feeBps = 30, deadline, commit, swapData = null, publicValues, proof, memos = [] }) {
  const tails = [bytes(zapSwap({ plan, router, amm, tokenB, assetA, assetB, feeBps, deadline, swapData })), bytes(publicValues), bytes(proof), bytesArray(memos)];
  let off = 11 * 32;
  const heads = tails.map((t) => { const h = word(off); off += t.length / 2; return h; });
  return '0x' + ZAP_FARM_SEL + addr(tokenB) + word(feeBps) + word(plan.ethLeg) + word(plan.bLeg) + word(plan.shares) + word(deadline) + b32(commit) + heads.join('') + tails.join('');
}
// zapETHIntoFarm(address,uint32,uint256,uint256,uint256,uint64,bytes32,bytes,bytes,bytes,bytes[])
export const ZAP_FARM_SEL = 'c4294fac';
const bytesArray = (xs) => {
  const items = xs.map((x) => bytes(x));
  let off = xs.length * 32;
  const heads = items.map((t) => { const h = word(off); off += t.length / 2; return h; });
  return word(xs.length) + heads.join('') + items.join('');
};

// What a zap ends with at the pool's price before it, in A units: the position (its share of the pool after the swap's own part and the add)
// and what comes back (A not sent or not taken, and B over what the add takes, at `backPrice` A per B if given: the price the swap paid for
// it, so B bought only to come back is no gain), per unit of A sent. Plans that send different amounts compare by this.
export function zapWorth({ ra, rb, total }, plan, unitA = 10n ** 10n, unitB = 10n ** 10n, backPrice = null) {
  ra = BigInt(ra); rb = BigInt(rb); total = BigInt(total);
  const uA = BigInt(unitA), uB = BigInt(unitB), x = (plan.ammIn ?? plan.swapIn) / uA, outU = (plan.ammOut ?? plan.out) / uB;
  const ra2 = ra + x, rb2 = rb - outU, S = plan.shares, takeA = (S * ra2 + total - 1n) / total, takeB = (S * rb2 + total - 1n) / total;
  const price = Number(ra) / Number(rb), pos = (Number(S) / Number(total + S)) * (Number(ra2 + takeA) + Number(rb2 + takeB) * price);
  const back = Number(plan.ethLeg / uA - takeA) + (Number(plan.paid ?? plan.out) / Number(uB) - Number(takeB)) * (backPrice ?? price);
  const sent = Number(plan.value) / Number(uA);
  return { worth: pos + back, sent, perSent: (pos + back) / sent, left: Number(plan.left) / Number(uA) };
}

// The best split of a zap's swap between this pool and another venue: `quote(X)` divides a swap of X wei (→ { ammIn, extIn, extOut } or
// null, ammIn a whole number of units), and the other venue's part counts at `slipBps` under its quote. The total swapped is the one at
// which the add takes about all of the ETH and about all of the B: found by secant from the all-in-pool swap and 15% more (or 15% less, or
// 35% more, to bracket it), refined once. Only a plan that sends at least 99.5% of the ETH and sends back no more than `maxBackBps` of it
// as B over the other venue's room is taken: B over that was bought at a cost only to come back. → { plan, worth }, plan.paid the B
// expected, or null (no such plan: the zap swaps all in the pool).
export async function zapSplitSearch({ eth, ra, rb, total, feeBps = 30n, x0, quote, slipBps = 50n, maxBackBps = 100n, unitA = 10n ** 10n, unitB = 10n ** 10n }) {
  const st = { ra: BigInt(ra), rb: BigInt(rb), total: BigInt(total) }, uA = BigInt(unitA), uB = BigInt(unitB), E = Number(BigInt(eth)), slip = BigInt(slipBps);
  const planOf = (q) => {
    if (!q) return null;
    const extMin = (q.extOut * (10000n - slip)) / 10000n, p = zapSplitPlan({ eth, ...st, feeBps, ammIn: q.ammIn, extIn: q.extIn, extMin, unitA, unitB });
    if (!p) return null;
    const paid = p.ammOut + q.extOut;
    // the B back beyond the other venue's room, in wei of A at the price the swap paid for it
    return { ...p, paid, q, backA: (Number(paid - p.bLeg - (q.extOut - extMin)) * Number(p.swapIn)) / Number(paid) };
  };
  // short of B (< 0: the ETH left unsent) or over (> 0: the B back), in wei of A: zero where the add takes about all of both
  const gap = (p) => (Number(p.left) > E / 10000 ? -Number(p.left) : p.backA);
  const at = (k) => (BigInt(x0) * BigInt(k)) / 1000n, tried = [];
  const ask = (X) => Promise.resolve().then(() => quote((X / uA) * uA)).then(planOf, () => null).then((p) => { if (p) tried.push(p); return p; });
  let [lo, hi] = await Promise.all([ask(at(1000)), ask(at(1150))]);
  if (lo && gap(lo) > 0) { const p = await ask(at(850)); if (p && gap(p) < 0) { hi = lo; lo = p; } }
  else if (hi && gap(hi) < 0) { const p = await ask(at(1350)); if (p && gap(p) > 0) { lo = hi; hi = p; } }
  for (let i = 0; i < 2 && lo && hi && gap(lo) < 0 && gap(hi) > 0; i++) {
    const X = lo.swapIn + ((hi.swapIn - lo.swapIn) * BigInt(Math.round((-gap(lo) / (gap(hi) - gap(lo))) * 1e6))) / 1000000n, p = await ask(X);
    if (!p || Math.abs(gap(p)) <= E * 0.002) break;
    if (gap(p) < 0) lo = p; else hi = p;
  }
  const fit = tried.filter((p) => Number(p.left) <= E * 0.005 && p.backA <= (E * Number(maxBackBps)) / 10000);
  if (!fit.length) return null;
  const scored = fit.map((p) => ({ plan: p, worth: zapWorth(st, p, unitA, unitB, Number(p.swapIn) / Number(uA) / (Number(p.paid) / Number(uB))) }));
  return scored.reduce((a, b) => (b.worth.perSent > a.worth.perSent ? b : a));
}
