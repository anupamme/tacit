// What zQuoter may hand back for zRouter to run, read against the terms that were asked for. A quoter answers with ready-made
// calldata, and zRouter runs each call as the sender. The answer is accepted only when it is a swap, a short chain of swaps, a split of
// the input across side-by-side swaps, or a mix of those (paths side by side, each a swap or a chain), through zRouter's own routes,
// that takes the asked token from the sender and pays the asked recipient: no executor call, no sweep, no permit, no other function. worker-relay/src/lib/zrouter-guard.js is the same file (tests/zrouter-guard.test.mjs).

export const ZROUTER = '0x000000000000fb114709235f1ccbffb925f600e4';
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const ETH = '0x0000000000000000000000000000000000000000';
// Curve pools in Curve's registry that the quoter has routed through. A route through another pool is refused unless the caller adds it.
export const CURVE_POOLS = [
  '0x828b154032950c8ff7cf8085d841723db2696056', // stETH / ETH
  '0x80466c64868e1ab14a1ddf27a676c3fcbe638fe5', // USDT / WBTC / WETH
];

const NAMES = { '6e0a4f98': 'swapV2', afeae12b: 'swapV3', '21c0dad2': 'swapV4', '9d5b5af8': 'swapVZ', '12db224a': 'swapCurve', ac9650d8: 'multicall' };
// The head of each swap: its length in 32-byte words and where each term sits.
const LAYOUT = {
  swapV2: { words: 7, tokenIn: 2, tokenOut: 3, amount: 4, limit: 5, deadline: 6 },
  swapV3: { words: 8, tokenIn: 3, tokenOut: 4, amount: 5, limit: 6, deadline: 7 },
  swapV4: { words: 9, tokenIn: 4, tokenOut: 5, amount: 6, limit: 7, deadline: 8 },
  swapVZ: { words: 10, tokenIn: 3, tokenOut: 4, amount: 7, limit: 8, deadline: 9 },
  swapCurve: { words: 41, amount: 38, limit: 39, deadline: 40 },
};
const MAX_LEGS = 3;

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const strip = (h) => { const s = lc(h).replace(/^0x/, ''); if (!/^[0-9a-f]*$/.test(s) || s.length % 2) throw new Error('calldata is not hex'); return s; };
const word = (h, i) => h.slice(8 + i * 64, 8 + (i + 1) * 64);
const num = (w) => BigInt('0x' + w);
const addr = (w) => { if (!/^0{24}[0-9a-f]{40}$/.test(w)) throw new Error('a word is not an address'); return '0x' + w.slice(24); };
const flag = (w) => { const v = num(w); if (v > 1n) throw new Error('a word is not a flag'); return v === 1n; };

function decodeSwap(h, fn) {
  const L = LAYOUT[fn];
  if (h.length !== 8 + L.words * 64) throw new Error(`${fn} has the wrong length`);
  const out = { fn, to: addr(word(h, 0)), exactOut: flag(word(h, 1)), amount: num(word(h, L.amount)), limit: num(word(h, L.limit)), deadline: num(word(h, L.deadline)) };
  if (fn === 'swapCurve') {
    const route = [];
    for (let k = 0; k < 11; k++) route.push(addr(word(h, 2 + k)));
    let last = -1;
    for (let i = 0; i < 5 && route[i * 2 + 1] !== ETH; i++) last = i;
    if (last < 0) throw new Error('the curve route has no pool');
    out.tokenIn = route[0]; out.tokenOut = route[(last + 1) * 2];
    out.pools = []; for (let i = 0; i <= last; i++) out.pools.push(route[i * 2 + 1]);
    return out;
  }
  out.tokenIn = addr(word(h, L.tokenIn)); out.tokenOut = addr(word(h, L.tokenOut));
  if (fn === 'swapVZ') {
    if (num(word(h, 5)) !== 0n || num(word(h, 6)) !== 0n) throw new Error('swapVZ names a multi-token id');
    if (num(word(h, 2)) > 10000n) throw new Error('swapVZ names a hook');
  }
  return out;
}

// The swaps in `callData`: one swap, or the legs of a multicall that holds only swaps. Throws on anything else.
export function decodeZRouterCall(callData) {
  const h = strip(callData);
  const fn = NAMES[h.slice(0, 8)];
  if (!fn) throw new Error(`the call is not a swap (selector ${h.slice(0, 8)})`);
  if (fn !== 'multicall') return [decodeSwap(h, fn)];
  // multicall(bytes[]): offset, then the array: its length, an offset per element, then each element's length and bytes.
  const at = Number(num(word(h, 0))) / 32;
  const n = Number(num(word(h, at)));
  if (!Number.isInteger(at) || n < 1 || n > MAX_LEGS) throw new Error('the multicall has an unexpected number of calls');
  const base = at + 1, legs = [];
  for (let i = 0; i < n; i++) {
    const rel = Number(num(word(h, base + i))) / 32;
    const lenAt = base + rel;
    const len = Number(num(word(h, lenAt)));
    const start = 8 + (lenAt + 1) * 64;
    if (!Number.isInteger(rel) || start + len * 2 > h.length) throw new Error('a multicall call is out of range');
    const leg = '0x' + h.slice(start, start + len * 2);
    const s = strip(leg), f = NAMES[s.slice(0, 8)];
    if (!f || f === 'multicall') throw new Error(`a multicall call is not a swap (selector ${s.slice(0, 8)})`);
    legs.push(decodeSwap(s, f));
  }
  return legs;
}

// `want`: { to, tokenIn, tokenOut } always, plus any of { exactOut, amount, maxIn, minOut, deadline, router, curvePools }.
//   amount  the swapAmount of the (first) swap: what is spent when exact-in, what is bought when exact-out; for a chain, that of its first swap when it is exact-in.
//   A chain is exact-in swaps, each after the first with an amount of 0 (it spends what the one before paid): an amount of its own would make the router pull the difference from the sender.
//   A split is exact-in swaps side by side, each taking the asked token and paying the asked token to the asked recipient: its
//   amounts add up to what is spent and its limits to the least it pays.
//   A mix is paths side by side: each path starts with an exact-in swap of the asked token (an amount of its own), goes on in swaps that
//   each take what the one before left with the router (an amount of 0), and ends paying the asked token to the asked recipient; the
//   amounts of the paths' first swaps add up to what is spent and the limits of their last swaps to the least it pays.
//   maxIn   the most the sender may be made to spend on the first swap (its amount when exact-in, its limit when exact-out).
//   minOut  the least the last swap may pay (its limit when exact-in, its amount when exact-out).
// → null when the call is acceptable, else the reason it is refused.
export function checkZRouterCall(callData, want) {
  let legs;
  try { legs = decodeZRouterCall(callData); } catch (e) { return String((e && e.message) || e); }
  const router = lc(want.router || ZROUTER), pools = new Set([...CURVE_POOLS, ...(want.curvePools || []).map(lc), WETH]);
  const first = legs[0], last = legs[legs.length - 1];
  const split = legs.length > 1 && legs.every((l) => lc(l.tokenIn) === lc(want.tokenIn) && lc(l.tokenOut) === lc(want.tokenOut) && lc(l.to) === lc(want.to));
  if (split) return checkSplit(legs, want, pools);
  // a chain leaves each swap's output with the router; a swap that pays elsewhere before the last is a path of its own: paths side by side
  if (legs.length > 1 && !legs.slice(0, -1).every((l) => lc(l.to) === router)) return checkPaths(legs, want, pools, router);
  if (lc(first.tokenIn) !== lc(want.tokenIn)) return 'the swap does not take the asked token';
  if (lc(last.tokenOut) !== lc(want.tokenOut)) return 'the swap does not pay the asked token';
  if (lc(last.to) !== lc(want.to)) return 'the swap does not pay the asked recipient';
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (i < legs.length - 1) {
      if (lc(l.to) !== router) return 'a middle swap does not stay with the router';
      if (lc(l.tokenOut) !== lc(legs[i + 1].tokenIn)) return 'the swaps do not chain';
    }
    if (l.pools) for (const p of l.pools) if (!pools.has(p)) return 'the curve route uses a pool that is not allowed';
    if (want.deadline != null && l.deadline !== BigInt(want.deadline)) return 'the swap has another deadline';
  }
  if (legs.length > 1) {
    if (first.exactOut) return 'a chain starts with an exact-out swap';
    for (let i = 1; i < legs.length; i++) if (legs[i].exactOut || legs[i].amount !== 0n) return 'a later swap names an amount of its own';
  }
  if (want.exactOut != null && legs.length === 1 && first.exactOut !== !!want.exactOut) return 'the swap is not the asked kind';
  if (want.amount != null && (legs.length === 1 || !first.exactOut) && first.amount !== BigInt(want.amount)) return 'the swap has another amount';
  if (want.maxIn != null) {
    const spent = first.exactOut ? first.limit : first.amount;
    if (spent > BigInt(want.maxIn)) return 'the swap can spend more than allowed';
  }
  if (want.minOut != null) {
    const paid = last.exactOut ? last.amount : last.limit;
    if (paid < BigInt(want.minOut)) return 'the swap can pay less than allowed';
  }
  return null;
}
function checkPaths(legs, want, pools, router) {
  const paths = [];
  for (const l of legs) {
    if (l.exactOut) return 'a multi-path swap holds an exact-out swap';
    const cur = paths[paths.length - 1], end = cur && cur[cur.length - 1];
    if (l.amount === 0n) {
      // it goes on from the swap before it: that one left its output with the router, and this one takes exactly that token
      if (!end || lc(end.to) !== router || lc(end.tokenOut) !== lc(l.tokenIn)) return 'a later swap does not follow the one before it';
      cur.push(l);
    } else {
      if (end && lc(end.to) === router) return 'a swap left its output with the router';
      paths.push([l]);
    }
  }
  const tail = paths[paths.length - 1];
  if (lc(tail[tail.length - 1].to) === router) return 'a swap left its output with the router';
  let spent = 0n, paid = 0n;
  for (const p of paths) {
    const a = p[0], z = p[p.length - 1];
    if (lc(a.tokenIn) !== lc(want.tokenIn)) return 'the swap does not take the asked token';
    if (lc(z.tokenOut) !== lc(want.tokenOut)) return 'the swap does not pay the asked token';
    if (lc(z.to) !== lc(want.to)) return 'the swap does not pay the asked recipient';
    for (const l of p) {
      if (l.pools) for (const q of l.pools) if (!pools.has(q)) return 'the curve route uses a pool that is not allowed';
      if (want.deadline != null && l.deadline !== BigInt(want.deadline)) return 'the swap has another deadline';
    }
    spent += a.amount; paid += z.limit;
  }
  if (want.exactOut) return 'the swap is not the asked kind';
  if (want.amount != null && spent !== BigInt(want.amount)) return 'the swap has another amount';
  if (want.maxIn != null && spent > BigInt(want.maxIn)) return 'the swap can spend more than allowed';
  if (want.minOut != null && paid < BigInt(want.minOut)) return 'the swap can pay less than allowed';
  return null;
}
function checkSplit(legs, want, pools) {
  let spent = 0n, paid = 0n;
  for (const l of legs) {
    if (l.exactOut) return 'a split holds an exact-out swap';
    if (l.amount === 0n) return 'a split leg spends nothing of its own';
    if (l.pools) for (const p of l.pools) if (!pools.has(p)) return 'the curve route uses a pool that is not allowed';
    if (want.deadline != null && l.deadline !== BigInt(want.deadline)) return 'the swap has another deadline';
    spent += l.amount; paid += l.limit;
  }
  if (want.exactOut) return 'the swap is not the asked kind';
  if (want.amount != null && spent !== BigInt(want.amount)) return 'the swap has another amount';
  if (want.maxIn != null && spent > BigInt(want.maxIn)) return 'the swap can spend more than allowed';
  if (want.minOut != null && paid < BigInt(want.minOut)) return 'the swap can pay less than allowed';
  return null;
}
