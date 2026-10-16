// The prover network credit, which proving spends: when it reaches zero every network proof fails (settles, reflection,
// eth-state). The relay's replenish run reads it and reports it with its heartbeat; the monitor reads it back (the API
// returns it to the relay's own token only) and says when it is low, early enough to top it up.

// PROVE wei -> whole PROVE as the text the heartbeat carries ("78.24"), or null when it is unknown.
export const creditText = (wei) => (wei == null ? null : (Number(wei) / 1e18).toFixed(2));

// A heartbeat's credit field, as the API keeps it: digits with up to four decimals, else not kept.
export const creditField = (v) => (typeof v === 'string' && /^\d{1,12}(\.\d{1,4})?$/.test(v) ? v : null);

// How low it is, in whole PROVE: 'critical' under `critical` (proofs are about to stop), 'warning' under `warn` (top it
// up). A proof spends about 2-3 PROVE (an attest ~2, a settle ~3), and replenish buys toward its own floor
// (PROVE_CREDIT_FLOOR_WEI) only from ETH above the settle wallet's gas float, so the credit normally runs between a few
// PROVE and a few tens; these thresholds sit below that band rather than at replenish's target.
export function creditLevel(whole, { warn, critical } = {}) {
  const w = Number(whole), hi = Number(warn), lo = Number(critical);
  if (!Number.isFinite(w) || !(hi > 0) || !(lo >= 0) || lo > hi) return null;
  return w < lo ? 'critical' : w < hi ? 'warning' : null;
}
