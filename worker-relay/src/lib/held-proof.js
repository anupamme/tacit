// The proof the reflection lane has bought for a batch it has not yet landed.
//
// A proof is paid for before its attest is sent, and the send can still fail (the wallet is short of ETH, the node is down).
// The same batch is served again on the next cycle, so the proof is kept, by the batch's new digest, and used again instead
// of being bought a second time. It is only ever used for the identical batch, and the pool still checks it against its own
// state, so a proof that no longer applies is refused there. Memory only: a restarted lane buys again.

export function makeHeldProof({ now = Date.now, ttlMs = 6 * 3600 * 1000 } = {}) {
  let held = null;
  const key = (d) => String(d || '').toLowerCase();
  return {
    keep(newDigest, proof) { held = { key: key(newDigest), proof, at: now() }; },
    take(newDigest) { return held && held.key === key(newDigest) && now() - held.at < ttlMs ? held.proof : null; },
    clear() { held = null; },
  };
}
