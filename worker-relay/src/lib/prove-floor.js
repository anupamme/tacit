// How much prover credit a free prove-only job needs on hand before the relay will prove it. Most are held to the full reserve, kept for the
// bridge's attests and for paid work; the exits (a holder getting their own funds out) are held to a lower floor, so they are the last
// thing the reserve stops. The API applies the same two figures at submit (PROVE_MODE_MIN_CREDIT, PROVE_MODE_EXIT_MIN_CREDIT in
// worker/src/index.js handleConfidentialSubmit); a test keeps the two lists of exit types equal.

export const EXIT_TYPES = ['unwrap', 'sendunwrap'];

export function proveFloorWei(type, { reserveWei, exitWei }) {
  return EXIT_TYPES.includes(type) && exitWei < reserveWei ? exitWei : reserveWei;
}
