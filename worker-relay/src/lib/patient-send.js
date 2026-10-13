// A transaction that is in no hurry (Bitcoin headers: nobody waits on a given block of them) offers the least a builder will
// take, and raises the offer only if nobody does. Paying a median tip for a transaction a few minutes late would have cost
// nothing in time and was a third to a half of what a header batch paid (0.05 gwei on a 0.08 gwei base fee).
//
//   tipLadder  the offers to make, in order: the cheap one, halfway to what an ordinary transaction pays, then that
//   sendPatient  sends the first, gives it `waitMs` to land, and replaces it at the same nonce with the next, each fee raised
//                enough for a node to accept the replacement. The last offer is waited on without limit, as before.

// A node takes a replacement that raises both fees by 10%; 15% clears it with room.
export const BUMP_NUM = 115n;
export const BUMP_DEN = 100n;
export const raised = (v) => (BigInt(v) * BUMP_NUM) / BUMP_DEN + 1n;

// Offers in wei per gas, ascending, each a clear raise on the one before, none over `capWei`. A market at or under the cheap
// offer, or one that cannot be read, gives a single offer.
export function tipLadder({ patient, market, capWei = 0n }) {
  const cap = BigInt(capWei);
  const clamp = (v) => (cap > 0n && v > cap ? cap : v);
  const first = clamp(BigInt(patient));
  const top = clamp(BigInt(market));
  const out = [first];
  const mid = clamp((first + top) / 2n);
  for (const t of [mid, top]) if (t >= raised(out[out.length - 1]) && t > out[out.length - 1]) out.push(t);
  return out;
}

// send({ tip, nonce? }) → tx hash (a replacement carries the first send's nonce); wait(hash, ms) → receipt or null at ms;
// nonceOf(hash) → the nonce the first send took; found(hashes) → { hash, receipt } for any of them that has landed, else null.
// → { hash, receipt, tip, raises }
export async function sendPatient({ send, wait, nonceOf, found, tips, waitMs, log = () => {} }) {
  const hashes = [];
  let hash = await send({ tip: tips[0] });
  hashes.push(hash);
  let nonce = null;
  for (let i = 0; i < tips.length; i++) {
    const last = i === tips.length - 1;
    // The last offer is waited on as long as it takes, in slices, so an earlier one that lands instead is noticed.
    for (;;) {
      const receipt = await wait(hash, waitMs);
      if (receipt) return { hash: receipt.transactionHash ?? hash, receipt, tip: tips[i], raises: i };
      const done = await found(hashes);
      if (done) return { hash: done.hash, receipt: done.receipt, tip: tips[i], raises: i };
      if (!last) break;
    }
    nonce ??= await nonceOf(hash);
    log(`  not taken at ${tips[i]} wei per gas tip after ${Math.round(waitMs / 1000)} s — offering ${tips[i + 1]}`);
    try {
      hash = await send({ tip: tips[i + 1], nonce });
      hashes.push(hash);
    } catch (e) {
      // The earlier offer may have landed while this one was signed: that ends it, not an error.
      const done = await found(hashes);
      if (done) return { hash: done.hash, receipt: done.receipt, tip: tips[i], raises: i };
      throw e;
    }
  }
  throw new Error('unreachable');
}
