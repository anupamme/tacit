// The Bitcoin lane's schedule (src/bitcoin-lane.js): one process runs the eth-state producer, the reflection folder and the header
// feeder in turn, never two at once, so their proofs (each a child process of over a gigabyte) and their sends from the one relay key
// are serialised by construction. Pure, so the order and the pacing are tested without a chain (tests/lane-schedule.test.mjs).
//
//   stages: [{ name, run: () => Promise<boolean worked>, everySecs, idle?: () => Promise }], in the order they go
//   `idle` is called after a run that found nothing to do (the stage's own idle heartbeat, which its single-service loop used to send).
//   A stage runs when its interval has passed since its last run; one that worked runs again at once next round (it is catching up).
//   A stage that threw backs off: its interval doubles each consecutive failure, up to `maxBackoffSecs`, and one success resets it.
//   A round that did no work sleeps `idleSecs`.

export function makeLaneSchedule(stages, { now = Date.now, idleSecs = 30, maxBackoffSecs = 1800, log = () => {} } = {}) {
  const st = stages.map((s) => ({ ...s, lastAt: 0, failures: 0, worked: false }));
  const due = (s, t) => {
    const every = s.failures > 0 ? Math.min(maxBackoffSecs, (s.everySecs || idleSecs) * 2 ** Math.min(s.failures, 12)) : (s.worked ? 0 : s.everySecs || 0);
    return t - s.lastAt >= every * 1000;
  };
  return {
    // One round: each stage that is due, in order. -> { worked, ran: [names], sleepSecs }
    async round() {
      let worked = false;
      const ran = [];
      for (const s of st) {
        const t = now();
        if (!due(s, t)) continue;
        s.lastAt = t;
        ran.push(s.name);
        try {
          const w = await s.run();
          s.worked = !!w;
          if (s.failures) log(`${s.name}: recovered after ${s.failures} failure(s)`);
          s.failures = 0;
          if (w) worked = true;
          else if (s.idle) { try { await s.idle(); } catch {} }
        } catch (e) {
          s.worked = false;
          s.failures++;
          const wait = Math.min(maxBackoffSecs, (s.everySecs || idleSecs) * 2 ** Math.min(s.failures, 12));
          log(`${s.name}: cycle error (continuing): ${e?.message || e} — ${s.failures} consecutive failure(s), next attempt in ${wait}s`);
        }
      }
      return { worked, ran, sleepSecs: worked ? 0 : idleSecs };
    },
    state: () => st.map((s) => ({ name: s.name, lastAt: s.lastAt, failures: s.failures, worked: s.worked })),
  };
}
