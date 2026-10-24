// What a keeper may spend on gas for one pool over any 24 hours: for a token pool someone asked the relay to serve (POST /token-pools), whose
// token's price is only as sound as its thinnest market. Whoever opened such a pool could hold its price up, have fees paid in it at that price
// and leave the keeper holding tokens worth less than the gas it fronted; the allowance bounds what that can cost. A send is charged what it
// may use at the price now (its gas limit, not what it used), so the allowance is never overrun.
const DAY = 86_400_000;

export function makeGasBudget({ dayWei, now = () => Date.now() }) {
  const limit = BigInt(dayWei), spent = [];   // [time, wei]
  const used = () => { const t = now(); while (spent.length && t - spent[0][0] >= DAY) spent.shift(); return spent.reduce((n, [, w]) => n + w, 0n); };
  return {
    // → whether `wei` fits; it is charged when it does
    take(wei) { const w = BigInt(wei); if (used() + w > limit) return false; spent.push([now(), w]); return true; },
    left: () => { const l = limit - used(); return l > 0n ? l : 0n; },
    limit,
  };
}

// A chain whose sends are charged to `budget` first: a send that does not fit is refused before it is signed (`refuse()` makes the error).
export function budgeted(chain, budget, refuse, fallbackGas) {
  const send = chain.send;
  chain.send = async (functionName, args, opts = {}) => {
    const gas = BigInt(opts.gas ?? fallbackGas);
    if (!budget.take(gas * (await chain.gasPrice()))) throw refuse();
    return send(functionName, args, opts);
  };
  chain.gasBudget = budget;
  return chain;
}
