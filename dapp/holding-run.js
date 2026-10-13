// The holding reward's daily round for one key (see holding-claim.js): ask the points service which days are open, and
// for each open day and chain where this key's pool wallet held a note at the snapshot, prove it and send the claim. A day
// and chain is done once every claim it owed was answered, and is not proven again.
//
// Everything it reads from the service is public and the same for every caller; what it sends is a proof that names
// only the claim address. Does nothing while the service says the reward is off.
//
//   api: the points service's base URL. wallets: { [chainId]: pool wallet (evm-pool-wallet.js) }. claimAddress: where the points
//   go, an address that can send its own transactions (the distributor pays only the account that claims); keys, when no
//   address is given, name a key-derived one instead.
//   prove(input) → { proof, publicSignals }. kv: { get, set } (localStorage-like), for the days already done and a short log of
//   what was sent, which holdingLog reads back for the page to show.

import { holdingClaims, holdingClaimKey } from './holding-claim.js';

const plain = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const doneKey = (address, chainId, epoch) => `tacit-holding-done:${address}:${chainId}:${epoch}`;
const logKey = (address) => `tacit-holding-log:${String(address).toLowerCase()}`;
const LOG_KEEP = 60;

// What was sent for an address, newest first: [{ epoch, chainId, bucketWei, points, credited, status, at }].
export function holdingLog(kv, address) {
  try { const l = JSON.parse(kv.get(logKey(address)) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
}
function remember(kv, address, row) {
  const l = holdingLog(kv, address).filter((x) => !(x.epoch === row.epoch && x.chainId === row.chainId && x.bucketWei === row.bucketWei));
  try { kv.set(logKey(address), JSON.stringify([row, ...l].slice(0, LOG_KEEP))); } catch { /* storage full or blocked: the round still ran */ }
}

export async function runHolding({ api, wallets, keys, claimAddress: to = null, zk, prove, kv, fetchImpl = globalThis.fetch?.bind(globalThis), log = () => {}, onStep = () => {}, now = () => Date.now() }) {
  const get = async (path) => {
    const r = await fetchImpl(`${api}${path}`);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  };
  const status = await get('/holding');
  if (!status?.enabled) return { enabled: false, sent: [] };
  const buckets = (status.buckets || []).map(BigInt);
  const smallest = buckets[0];
  const claimAddress = to || holdingClaimKey(keys).address;
  const sent = [];
  for (const { epoch, chains = [] } of status.epochs || []) {
    for (const snap of chains) {
      const W = wallets[snap.chainId], asset = status.assets?.[snap.chainId];
      if (!W || asset === undefined || kv.get(doneKey(claimAddress, snap.chainId, epoch))) continue;
      // Only fetch the snapshot when one of this wallet's notes could be in it.
      const notes = W.notes();
      if (!notes.some((n) => Number(n.index) < Number(snap.leaves) && smallest !== undefined && BigInt(n.v) >= smallest)) {
        kv.set(doneKey(claimAddress, snap.chainId, epoch), '1');
        continue;
      }
      const body = await get(`/holding/nullifiers/${snap.chainId}/${epoch}`);
      const claims = holdingClaims({ zk, asset: BigInt(asset), chainId: snap.chainId, epoch, snapshot: body, leaves: body.leaves, nullifiers: body.nullifiers, notes, buckets, claimAddress });
      let answered = 0;
      for (const c of claims) {
        onStep({ epoch, chainId: snap.chainId, bucketWei: c.bucketWei, step: 'proving' });
        const { proof, publicSignals } = await prove(plain(c.input));
        const r = await fetchImpl(`${api}/holding/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: snap.chainId, epoch, claimAddress, proof, publicSignals }) });
        const out = await r.json().catch(() => ({}));
        sent.push({ chainId: snap.chainId, epoch, bucketWei: c.bucketWei, status: r.status, ...out });
        if (r.ok || r.status === 422) remember(kv, claimAddress, { epoch, chainId: snap.chainId, bucketWei: String(c.bucketWei), points: Number(out.points) || 0, credited: !!out.credited, status: r.status, error: r.ok ? null : out.error || null, at: now() });
        if (r.ok || r.status === 422) answered += 1;                          // credited, already credited, or refused for good
        else log(`holding claim for day ${epoch} on chain ${snap.chainId}: ${r.status} ${out.error || ''}`);
      }
      if (answered === claims.length) kv.set(doneKey(claimAddress, snap.chainId, epoch), '1');
    }
  }
  return { enabled: true, claimAddress, sent };
}

