// A bridge mint the pool's burn root has moved past is renewed before it is proved, not turned back: the API reads the op's public half
// again (the burn set's path under the root the pool holds), keeping the holder's half and the memos, and the relay proves that. The renewal
// waits a moment when the saved reflected state is not yet the pool's (a proof saved but not landed), and gives up quietly otherwise: the
// stale-root check that follows turns a mint that could not be renewed back, as it always did.
//   blocker(job) → a reason when the mint's settle can only revert (lib/bridge-mint-precheck.js), else null
//   refresh(jobId) → { ok, op } | { ok: false, code } (POST /confidential/refresh)
const NOT_YET = new Set(['reflection_not_current', 'chain_unreadable', 'reflection_unavailable', 'no_answer']);

export async function renewStaleMint(job, { blocker, refresh, sleep, log = () => {}, tries = 3, waitSecs = 20 }) {
  if (!job || job.type !== 'bridgemint' || !job.op || job.mode === 'preproven') return false;
  if (!(await blocker(job))) return false;                                   // on the root the pool holds: nothing to renew
  for (let i = 0; i < tries; i++) {
    const r = await refresh(job.jobId);
    if (r && r.ok && r.op) { job.op = r.op; log(`job ${job.jobId} type=bridgemint renewed on the burn root the pool holds`); return true; }
    if (!r || !NOT_YET.has(r.code)) return false;                            // a verdict (the burn is not recorded, the destination differs …)
    if (i < tries - 1) await sleep(waitSecs);
  }
  return false;
}
