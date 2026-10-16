// Catch-up points: the keeper posts the pool's tree edge to the registry (TacitEvmPoolCheckpoints) when the pool has
// grown by `pointsEvery` leaves, or `pointsMaxAgeSecs` have passed, since the newest point there, so a wallet opening on
// a new device can start from a recent point rather than the pool's first block. The point is the confirmed tree (the
// persisted leaves) and the block they are read through, never the unconfirmed tail. The registry keeps a post only if
// the pool held the edge's root at that count, and one per count: a post that loses a race reverts in the simulation
// the send does first, and costs nothing.
//
// chain: { hasCode, pointLatest, pointPostedAt, blockTime, canFront, send } (makeKeeperChain).
// cfg: { pointsAddress, pointsEvery, pointsMaxAgeSecs, pointsGas }.
import { safeErr } from './safe-err.js';

const b32 = (x) => `0x${BigInt(x).toString(16).padStart(64, '0')}`;

export function makePointPoster({ chain, cfg, log = () => {}, now = () => Date.now() }) {
  let enabled = null, lastTry = 0;
  // → the hash of a post sent, or null when none was due or possible.
  async function maybePost(synced) {
    if (!cfg.pointsAddress || !synced?.confirmed) return null;
    if (enabled === null) {
      enabled = await chain.hasCode(cfg.pointsAddress).catch(() => null);
      if (enabled === false) log(`catch-up registry ${cfg.pointsAddress} has no code on this chain; not posting points`);
    }
    if (!enabled) return null;
    // One attempt every ten minutes at most: a failed send (short of ETH, a race) is not retried every tick.
    if (now() - lastTry < 600_000) return null;
    const { tree, block } = synced.confirmed, size = Number(tree.size);
    if (!size || size % 2 || !(Number(block) > 0)) return null;
    const latest = await chain.pointLatest();
    if (size <= latest) return null;
    let due = !latest || size - latest >= cfg.pointsEvery;
    if (!due) {
      const t = await chain.blockTime(await chain.pointPostedAt(latest));
      due = now() / 1000 - t >= cfg.pointsMaxAgeSecs;
    }
    if (!due) return null;
    lastTry = now();
    const front = await chain.canFront(cfg.pointsGas);
    if (!front.ok) { log(`catch-up point at ${size} leaves not posted: ${safeErr(front)}`); return null; }
    const filled = tree.toJSON().filled.map(b32);
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
