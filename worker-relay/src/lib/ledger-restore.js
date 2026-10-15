// Takes the relay's books back after a restart (lib/income-ledger.js `restore`), from what the API kept of the last process's heartbeats.
//
// Until the API has answered once, `ready()` is false and the heartbeat leaves the ledger out: a fresh, empty ledger posted first would
// overwrite the books being waited for. A worker that cannot be asked is retried in the background; one that has nothing stored, or
// predates the route, counts as answered. Settling never waits on any of this beyond the short first attempts.

export function makeBooksRestorer({ ledger, fetchBooks, tries = 3, waitMs = 3000, retryMs = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); }, log = () => {} } = {}) {
  let ready = false;
  const attempt = async () => {
    let r = null;
    try { r = await fetchBooks(); } catch { r = null; }
    if (r === null || r === undefined) return false;
    if (r && r.ledger && ledger.restore(r.ledger)) log(`books taken back from ${r.ledger.since}`);
    ready = true;
    return true;
  };
  const later = async () => { if (ready) return; if (!(await attempt())) schedule(later, retryMs); };
  return {
    ready: () => ready,
    // The first attempts, a few seconds apart; the rest in the background. Never throws.
    async start() {
      for (let i = 0; i < tries && !ready; i++) {
        if (i) await sleep(waitMs);
        if (await attempt()) return true;
      }
      log('books: the API could not be asked yet; the ledger stays out of heartbeats until it can');
      schedule(later, retryMs);
      return false;
    },
  };
}
