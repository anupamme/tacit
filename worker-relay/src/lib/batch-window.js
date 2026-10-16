// How long the oldest queued op may wait for company before its settle is proved. Several ops in one proof and one settle
// cost what one costs (the proof's fixed work and the settle's base gas are paid once) and hide each op among the others,
// so it is worth holding a lone op a little while another is likely to arrive, and not worth it when none is: the wait is
// taken from the rate at which jobs have been arriving. Expected gap = an hour over the jobs seen in the last hour; the
// oldest op waits min(gap, maxWait), and only when the gap is inside maxWait at all, so a quiet hour holds nobody.
// Pure, with the clock injected (worker-relay/tests/batch-window.test.mjs).

export function makeBatchWindow({ maxWaitMs = 90_000, horizonMs = 60 * 60_000, minSeen = 2, now = Date.now } = {}) {
  const seenAt = new Map(); // jobId → when the relay first saw it

  // A job the relay has taken (claimed or settled): one arrival. The same id twice is one.
  function seen(jobId, at = now()) {
    if (!jobId || seenAt.has(jobId)) return;
    seenAt.set(jobId, at);
    const cut = at - horizonMs;
    for (const [id, t] of seenAt) if (t < cut) seenAt.delete(id);
  }

  // Jobs per hour over the horizon, 0 until a few have been seen.
  function ratePerHour() {
    const t = now(), cut = t - horizonMs;
    let n = 0, first = t;
    for (const at of seenAt.values()) if (at >= cut) { n++; if (at < first) first = at; }
    if (n < minSeen) return 0;
    const span = Math.max(t - first, 60_000);
    return n / (span / 3_600_000);
  }

  // The wait, in ms, before claiming what is queued (0 = claim now). `pending` queued settle jobs, the oldest of them
  // `oldestPendingSec` old; `batchMax` the batch ceiling.
  function wait({ pending = 0, oldestPendingSec = 0, batchMax = 16 } = {}) {
    if (pending <= 0 || pending >= batchMax) return 0;
    const rate = ratePerHour();
    if (rate <= 0) return 0;
    const gapMs = 3_600_000 / rate;
    if (gapMs > maxWaitMs) return 0;                       // another op is not expected soon: nobody waits
    const window = pending >= 2 ? Math.min(gapMs, maxWaitMs) / 2 : Math.min(gapMs, maxWaitMs); // company already there: half as long
    return Math.max(0, Math.round(window - oldestPendingSec * 1000));
  }

  return { seen, ratePerHour, wait, size: () => seenAt.size };
}
