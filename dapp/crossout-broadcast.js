
import { encodeCrossoutMint } from './confidential-crossout-consumer.js';

export function makeCrossoutBroadcaster({ buildAndBroadcastEnvelope, postHint, workerBase, fetchImpl } = {}) {
  if (typeof buildAndBroadcastEnvelope !== 'function') throw new Error('crossout-broadcast: inject buildAndBroadcastEnvelope');
  const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  async function broadcastCrossoutMint({ assetId, claimId, cx, cy, owner }) {
    const payload = encodeCrossoutMint({ assetId, claimId, cx, cy, owner });
    const res = (await buildAndBroadcastEnvelope(payload)) || {};
    const txid = res.txid;
    const vout = res.vout ?? 0;
    if (!txid) throw new Error('crossout-broadcast: no txid from broadcast');
    let hinted = true;
    if (postHint) { try { await postHint(txid, vout); } catch { hinted = false; } }
    return { txid, vout, claimId, payloadLen: payload.length, status: 'broadcast', hinted };
  }

  async function waitForCrossOutCoverage({ network = 'mainnet', block, intervalMs = 60000, timeoutMs = 3 * 60 * 60 * 1000, onUpdate, sleep } = {}) {
    if (!workerBase) throw new Error('crossout-broadcast: waitForCrossOutCoverage needs workerBase');
    if (!f) throw new Error('crossout-broadcast: no fetch implementation');
    if (!Number.isFinite(block) || block <= 0) throw new Error('crossout-broadcast: block (the crossOut settle\'s own block number) is required');
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let throttled = 0;
    for (;;) {
      let res = null, body = null;
      try { res = await f(`${workerBase}/reflection/eth-state/covers?network=${network}&block=${block}`); } catch { res = null; }
      if (res) { try { body = await res.json(); } catch { body = null; } }
      if (!body || typeof body.covered !== 'boolean') {
        throttled += 1;
        const retryAfter = Number(body && body.retryAfter) || Number(res && res.headers && res.headers.get && res.headers.get('Retry-After')) || 0;
        if (Date.now() > deadline) break;
        await wait(Math.max(intervalMs, retryAfter * 1000));
        continue;
      }
      const status = body.covered ? 'covered' : 'waiting';
      if (status !== last) { last = status; if (onUpdate) onUpdate(body); }
      if (body.covered) return body;
      if (Date.now() > deadline) break;
      await wait(intervalMs);
    }
    const why = throttled
      ? ` — ${throttled} poll(s) were rate-limited or unreadable, so this may be a polling problem rather than a protocol state; slow intervalMs down`
      : '';
    throw new Error(`crossOut coverage wait timed out after ${Math.round(timeoutMs / 60000)}min${why} — check /reflection/eth-state before retrying rather than assuming it's safe to broadcast`);
  }

  async function completeCrossOutOnBitcoin({ block, assetId, claimId, cx, cy, owner, network = 'mainnet', waitOpts, claimIdVerified, claimIdNote } = {}) {
    if (claimIdVerified !== true) {
      throw new Error('refusing to broadcast a crossOut mint whose claimId was not corroborated against the '
        + `CrossOutRecorded event (${claimIdNote || 'claimIdVerified was not set'}). A reveal built from a wrong `
        + 'claimId can never fold and fails silently — re-read the settle receipt and retry, or pass '
        + 'claimIdVerified: true if you have corroborated it yourself.');
    }
    await waitForCrossOutCoverage({ network, block, ...waitOpts });
    return broadcastCrossoutMint({ assetId, claimId, cx, cy, owner });
  }

  broadcastCrossoutMint.waitForCrossOutCoverage = waitForCrossOutCoverage;
  broadcastCrossoutMint.completeCrossOutOnBitcoin = completeCrossOutOnBitcoin;
  return broadcastCrossoutMint;
}
