// Catch-up points: the keeper posts the pool's tree edge to the registry (TacitEvmPoolCheckpoints) when the pool has
// grown by `pointsEvery` leaves, or `pointsMaxAgeSecs` have passed (with some growth), since the newest point there, so a
// wallet opening on a new device can start from a recent point rather than the pool's first block. The point is the
// confirmed tree (the persisted leaves) and the block they are read through, never the unconfirmed tail. The registry keeps
// a post only if the pool held the edge's root at that count, and one per count: a post that loses a race reverts in the
// simulation the send does first, and costs nothing.
//
// chain: { hasCode, pointLatest, pointPostedAt, canFront, send } (makeKeeperChain); pointPostedAt is the registry's
// timestamp for the newest point (a block number would be the wrong layer's on an Arbitrum chain).
// cfg: { pointsAddress, pointsEvery, pointsMaxAgeSecs, pointsGas }.
import { safeErr } from './safe-err.js';

const b32 = (x) => `0x${BigInt(x).toString(16).padStart(64, '0')}`;
const RECHECK_MS = 30 * 60_000, RETRY_MS = 10 * 60_000;

export function makePointPoster({ chain, cfg, log = () => {}, now = () => Date.now() }) {
  let enabled = null, checkedAt = 0, lastTry = 0;
  // → the hash of a post sent, or null when none was due or possible.
  async function maybePost(synced) {
    if (!cfg.pointsAddress || !synced?.confirmed) return null;
    // What is posted is taken now, before anything is awaited: the tree behind `synced` can move on while the chain is asked.
    const { tree, block } = synced.confirmed, size = Number(tree.size), filled = tree.toJSON().filled.map(b32);
    // A keeper that started before the registry was deployed on its chain looks again from time to time.
    if (enabled !== true && now() - checkedAt >= RECHECK_MS) {
      checkedAt = now();
      const was = enabled;
      enabled = await chain.hasCode(cfg.pointsAddress).catch(() => null);
      if (enabled === false && was !== false) log(`catch-up registry ${cfg.pointsAddress} has no code on this chain yet; not posting points`);
      // the registry keeps one pool's points: a keeper for another pool on the chain (a token pool) leaves it alone
      if (enabled && chain.pointPool && chain.pool) {
        const p = await chain.pointPool().catch(() => null);
        if (!p) enabled = null;
        else if (p.toLowerCase() !== chain.pool.toLowerCase()) { enabled = false; checkedAt = Infinity; log(`catch-up registry ${cfg.pointsAddress} keeps pool ${p}'s points, not this pool's; not posting points`); }
      }
    }
    if (!enabled) return null;
    // One attempt every ten minutes at most: a failed send (short of ETH, a race) is not retried every tick.
    if (now() - lastTry < RETRY_MS) return null;
    if (!size || size % 2 || !(Number(block) > 0)) return null;
    const latest = await chain.pointLatest();
    if (size <= latest) return null;
    // Growth alone is a reason once it is large; time alone is a reason only with some growth worth a post's gas.
    let due = !latest || size - latest >= cfg.pointsEvery;
    if (!due && size - latest >= Math.max(2, Math.ceil(cfg.pointsEvery / 10))) due = now() / 1000 - (await chain.pointPostedAt(latest)) >= cfg.pointsMaxAgeSecs;
    if (!due) return null;
    lastTry = now();
    // Affordable with room to spare: a post is never what leaves the keeper unable to send a user's payment.
    const front = await chain.canFront(cfg.pointsGas);
    if (!front.ok || front.balance < 3n * front.need) { log(`catch-up point at ${size} leaves not posted: the keeper holds ${front.balance} wei and a ${cfg.pointsGas}-gas post needs ${front.need} now`); return null; }
    try {
      const hash = await chain.send('checkpoints.post', [BigInt(size), BigInt(block), filled], { gas: cfg.pointsGas });
      log(`posted catch-up point at ${size} leaves (block ${block}): ${hash}`);
      return hash;
    } catch (e) {
      log(`catch-up point at ${size} leaves not posted: ${safeErr(e)}`);
      return null;
    }
  }
  return { maybePost };
}
