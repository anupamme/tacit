// A settle proof's witness can go to the Succinct network as a private input (PRIVATE_STDIN=1), which only provers that
// fetch it with the signed GetStdinUri call can read; PROVER_WHITELIST names those. These decide how lib/prover.js tries
// it, and are kept apart so they can be tested without the relay's wallets (tests/private-prove.test.mjs).

// How a prove is attempted: with PRIVATE_STDIN=1 and PRIVATE_FALLBACK_PUBLIC not '0', a private attempt gets at most
// PRIVATE_ATTEMPT_MS (default 6 minutes) or 60% of the job's time, and the rest is left for one public attempt.
export function privateProvePlan(env, timeoutMs) {
  const priv = env.PRIVATE_STDIN === '1';
  if (!priv || env.PRIVATE_FALLBACK_PUBLIC === '0') return { fallback: false };
  const cap = Number(env.PRIVATE_ATTEMPT_MS) > 0 ? Number(env.PRIVATE_ATTEMPT_MS) : 6 * 60_000;
  return { fallback: true, privateMs: Math.max(60_000, Math.min(cap, Math.floor(timeoutMs * 0.6))) };
}
// A private attempt is worth repeating in public only when no prover proved it (none bid, the one that won never
// delivered, it timed out here); one the network could not execute fails the same way in public.
export function retryPublic(e) {
  const m = String(e && e.message || e);
  return !/unexecutable|execution failed|failed to execute|exceeded cycle limit|VKEY DRIFT|EXPECT_VKEY mismatch/i.test(m);
}
