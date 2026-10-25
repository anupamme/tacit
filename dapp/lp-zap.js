// One transaction from ETH to a private LP position in a Tacit pool (ConfidentialRouter.zapETHIntoShieldedLP): part of the ETH is swapped for
// the pool's other coin inside the same pool (zRouter's snwap calling TacitPublicAmm.swapPublic), both legs are added, and the LP shares are
// shielded into a pending deposit bound to a share note's commitment, which the relay then settles into the note (OP_WRAP) for the farm.
//
// The commitment fixes the share count, and the pool keeps no way back for a deposit no note opens, so the legs are sized to mint exactly S
// shares: each leg alone floors to S at the reserves the swap leaves, and minShares is S. A trade or a liquidity move that lands first cannot
// raise both legs' shares (a swap never lowers k, adds and removes round for the pool), and after it the zap's own swap leaves one leg short,
// so the add mints exactly S or the whole transaction reverts. tests/lp-zap.test.mjs checks this against the pool's own arithmetic.
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
  for (let i = 0n, top = coarseA ? aMax : bMax; i < 4096n && top - i > 0n; i++) {
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
  if (!best) return null;
  const mid = (ra * 10n ** 18n) / rb, after = (best.ra2 * 10n ** 18n) / best.rb2;
  return {
    swapIn: best.x * unitA, ethLeg: best.a * unitA, bLeg: best.b * unitB, floor: (best.b + 1n) * unitB, value: (best.x + best.a) * unitA, shares: best.s,
    out: best.out * unitB, spare: (best.out - best.b) * unitB, left: BigInt(eth) - (best.x + best.a) * unitA,
    // the price the swap moves the pool by (A per B), as a share
    impact: Number(after - mid) / Number(mid), reservesAfter: { ra: best.ra2, rb: best.rb2 }, shareOfPool: Number(best.s) / Number(total + best.s),
  };
}

// The calldata, for ConfidentialRouter.zapETHIntoShieldedLP with zRouter.snwap → TacitPublicAmm.swapPublic as its swap leg; the swap's floor
// is a unit over the B leg, so it pays what the add takes and some comes back. `to` of the swap is the router, which holds both legs.
export function zapCalldata({ plan, router, amm, tokenB, assetA, assetB, feeBps = 30, deadline, commit }) {
  const swap = 'cfdf9dcc' + b32(assetA) + b32(assetB) + word(feeBps) + word(plan.swapIn) + word(plan.floor) + word(deadline) + addr(router);
  const snwap = '5f3bd1c8' + addr('0x0') + word(0) + addr(router) + addr(tokenB) + word(plan.floor) + addr(amm) + word(7 * 32) + bytes(swap);
  return '0xf9d1fa01' + addr(tokenB) + word(feeBps) + word(plan.ethLeg) + word(plan.bLeg) + word(plan.shares) + word(deadline) + b32(commit) + word(8 * 32) + bytes(snwap);
}
