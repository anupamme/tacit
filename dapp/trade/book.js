// The pure arithmetic of an order book, for both of the TAC trade page's books (the Bitcoin order book and zSwap's boards on Ethereum): orders
// as a staircase by price. No DOM and no network, so a node test can feed it orders.

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
