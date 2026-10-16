// The relay's first lane for a settle proof: Tacit's prover board (the API's /prover/* routes, worker/src/prover-board.js),
// where a worker holding a token proves the input on its own machine. A proof that comes back is checked against the pool
// (a simulated settle with the memos the proof must commit to) before the relay uses it; a board that has no worker, a
// worker that fails or a proof the pool refuses hands the job on to the prover network, so the board can only add a lane,
// never lose a job. `post`, `status`, `cancel` and `verify` are injected (lib/worker-client.js and the chain), so this is
// tested without either.

export function makeBoardProver({ post, status, cancel, verify, waitMs = 240_000, pollMs = 3000, now = Date.now, sleep, log = () => {} } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const miss = (reason, extra = {}) => Object.assign(new Error(`prover board: ${reason}`), { code: 'board_miss', reason, ...extra });

  // `stdin`: bincode SP1Stdin bytes. `cls`: 'private' for a user's witness. `memos`: what the settle will carry, so the proof's
  // memo root is checked. → { publicValues, proof, worker, jobId }, or an error with code 'board_miss'.
  async function prove({ stdin, cycleLimit, gasLimit, cls = 'private', label = null, memos = [], timeoutMs = waitMs } = {}) {
    if (!(stdin instanceof Uint8Array) || !stdin.length) throw new Error('prover board: stdin must be the input bytes');
    const budget = Math.min(waitMs, timeoutMs);
    const t0 = now();
    // The job's deadline sits a minute past this wait: a worker that answers just late is not paid for by the network too.
    const posted = await post({ class: cls, program: 'confidential', stdin: Buffer.from(stdin).toString('base64'), cycleLimit: Number(cycleLimit), gasLimit: Number(gasLimit),
      deadline: Math.floor(now() / 1000) + Math.ceil(budget / 1000) + 60, label }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    if (!posted || !posted.ok || !posted.jobId) throw miss(`not posted: ${(posted && posted.error) || 'no answer from the API'}`);
    const { jobId } = posted;
    let lastSeen = null;
    for (;;) {
      const st = await status(jobId).catch(() => null);
      const s = st && st.status;
      if (s && s !== lastSeen) { lastSeen = s; log(`prover board: job ${jobId.slice(0, 10)} ${s}${st.worker ? ` (${st.worker})` : ''}`); }
      if (s === 'proved') {
        const ok = await Promise.resolve(verify({ publicValues: st.publicValues, proof: st.proof, memos })).catch(() => false);
        if (!ok) {
          await cancel(jobId, 'bad').catch(() => {});
          throw miss(`the proof from ${st.worker || 'a worker'} did not pass the settle check`, { jobId, worker: st.worker });
        }
        return { publicValues: st.publicValues, proof: st.proof, worker: st.worker, jobId };
      }
      if (s === 'failed') throw miss(`${st.worker || 'the worker'} could not prove it: ${st.error || 'no reason given'}`, { jobId, worker: st.worker });
      if (s === 'expired' || s === 'cancelled') throw miss(`the job is ${s}`, { jobId });
      if (now() - t0 >= budget) {
        await cancel(jobId, 'timeout').catch(() => {});
        throw miss(`nobody proved it within ${Math.round(budget / 1000)} s${s === 'claimed' ? ` (${st.worker} had claimed it)` : ''}`, { jobId });
      }
      await wait(pollMs);
    }
  }
  return { prove };
}
