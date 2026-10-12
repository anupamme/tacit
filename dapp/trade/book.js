// The pure arithmetic of an order book, for both of the TAC trade page's books (the Bitcoin order book and zSwap's boards on Ethereum): orders
// as a staircase by price, and how much of it an amount would fill. No DOM and no network, so a node test can feed it orders.

// Orders of one side as a staircase: [{ price, cum, size, i }] with the running total, best price first. Orders at one price are one step.
export function cumulative(orders, side) {
  const sorted = [...orders].filter((o) => o.size > 0 && o.price > 0).sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price));
  const steps = [];
  let cum = 0;
  for (const o of sorted) {
    cum += o.size;
    const last = steps[steps.length - 1];
    if (last && last.price === o.price) { last.cum = cum; last.size += o.size; last.orders.push(o); } else steps.push({ price: o.price, cum, size: o.size, orders: [o] });
  }
  return steps;
}

// How much of a staircase an amount fills: the steps it reaches and the part of the last one it takes.
export function filled(steps, size) {
  const out = [];
  let left = size;
  for (const s of steps) {
    if (left <= 0) break;
    const part = Math.min(left, s.size);
    out.push({ price: s.price, part, whole: part >= s.size });
    left -= part;
  }
  return { levels: out, filled: size - Math.max(0, left), short: Math.max(0, left) };
}
