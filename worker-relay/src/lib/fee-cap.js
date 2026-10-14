// The fee cap a settle sends with, and the ETH a node wants on hand before it takes the send. A node refuses a transaction
// whose gas limit times fee cap the wallet cannot cover, although only base fee plus tip is ever paid and the rest is
// refunded, so the CAP is the headroom the wallet needs, not the cost. Three base fees survives a climb over the few minutes
// the submit rounds span; a settle that costs 0.0006 ETH then asks 0.0016 ETH of headroom, and a wallet between the two sat
// idle with a queue of users behind it (2026-10-14). Every round reprices against the live base fee, so a lower cap loses
// at most a round when the base fee jumps, which is a better trade than not sending: a short wallet settles at the highest
// cap it can stand behind, down to a floor, and a funded one still sends at the full cap.
//
// Multipliers are in thousandths (3000 = 3 base fees), so the arithmetic stays in whole wei.

export const toMult = (x) => BigInt(Math.round(Number(x) * 1000));

// The cap per gas at a multiplier.
export const capAt = (base, tip, mult) => (BigInt(base) * BigInt(mult)) / 1000n + BigInt(tip);

// The ETH a node wants behind a send of `gas` at the lowest cap we will use: below this a settle cannot be sent.
export function fundsNeed({ gas, base, tip, minMult }) {
  return BigInt(gas) * capAt(base, tip, minMult);
}

// → { maxFee, mult, ok }: the full cap when the wallet covers it, otherwise the highest multiplier between minMult and
// maxMult it can stand behind. `ok` is false only when even minMult is more than the wallet holds.
export function feeCapFor({ balance, gas, base, tip, maxMult, minMult }) {
  const g = BigInt(gas), b = BigInt(base), t = BigInt(tip), bal = BigInt(balance);
  const full = capAt(b, t, maxMult);
  if (g * full <= bal) return { maxFee: full, mult: Number(maxMult) / 1000, ok: true };
  const perGas = g > 0n ? bal / g : 0n;                       // the most per gas the wallet can stand behind
  let mult = b > 0n && perGas > t ? ((perGas - t) * 1000n) / b : 0n;
  if (mult > BigInt(maxMult)) mult = BigInt(maxMult);
  if (mult < BigInt(minMult)) mult = BigInt(minMult);
  const maxFee = capAt(b, t, mult);
  return { maxFee, mult: Number(mult) / 1000, ok: g * maxFee <= bal };
}
