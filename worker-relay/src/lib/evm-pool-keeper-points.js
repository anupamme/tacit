// Catch-up points: the keeper posts the pool's tree edge when the pool has grown by `pointsEvery` leaves, or `pointsMaxAgeSecs`
// have passed (with some growth), since the newest point, so a wallet opening on a new device can start from a recent point rather
// than the pool's first block. The point is the confirmed tree (the persisted leaves) and the block they are read through, never
// the unconfirmed tail. It goes to the registry (TacitEvmPoolCheckpoints) when the registry is this pool's (the ETH pool, whose
// points earlier wallets read there), and to the hub (TacitEvmPoolCheckpointsHub) for any other pool (a token pool, the TAC
// pools), which reads the registry through for the ETH pool, so that pool needs no post of its own there. Either keeps a post only
// if the pool held the edge's root at that count, and one per count: a post that loses a race reverts in the simulation the send
// does first, and costs nothing.
//
// chain: { pool, hasCode, pointPool, pointLatest, pointPostedAt, hubLatest, hubPostedAt, canFront, send } (makeKeeperChain);
// the posted-at reads give the post's timestamp (a block number would be the wrong layer's on an Arbitrum chain).
// cfg: { pointsAddress, pointsHub, pointsEvery, pointsMaxAgeSecs, pointsGas }.
// gate: one per key on a chain (signerGate), shared by every pool's poster that signs with it, so their posts go out a few minutes
// apart: several pools' points never leave together, each sure of the float its own check found.
import { safeErr } from './safe-err.js';

const b32 = (x) => `0x${BigInt(x).toString(16).padStart(64, '0')}`;
const RECHECK_MS = 30 * 60_000, RETRY_MS = 10 * 60_000;
export const SPACING_MS = 5 * 60_000;

const GATES = new Map();
// The gate every poster signing with `address` on `chainId` shares.
export function signerGate(chainId, address) {
  const k = `${chainId}:${String(address).toLowerCase()}`;
  if (!GATES.has(k)) GATES.set(k, { at: -Infinity });
  return GATES.get(k);
}

export function makePointPoster({ chain, cfg, log = () => {}, now = () => Date.now(), gate = { at: -Infinity } }) {
  let target = null, checkedAt = -Infinity, lastTry = -Infinity, notOurs = false;
  const said = new Set(), once = (k, m) => { if (!said.has(k)) { said.add(k); log(m); } };
  const registry = {
    name: 'registry', latest: () => chain.pointLatest(), postedAt: (size) => chain.pointPostedAt(size),
    post: (size, block, filled) => chain.send('checkpoints.post', [BigInt(size), BigInt(block), filled], { gas: cfg.pointsGas }),
  };
  const hub = {
    name: 'hub', latest: () => chain.hubLatest(), postedAt: (size) => chain.hubPostedAt(size),
    post: (size, block, filled) => chain.send('hub.post', [chain.pool, BigInt(size), BigInt(block), filled], { gas: cfg.pointsGas }),
  };
  const hubOn = () => !!cfg.pointsHub && !!chain.hubLatest;

  // Where this pool's points go: the registry when it is this pool's, else the hub once it has code; null to look again later, false
  // for never (the registry is another pool's and there is no hub to post to).
  async function find() {
    if (cfg.pointsAddress && !notOurs) {
      const has = await chain.hasCode(cfg.pointsAddress).catch(() => null);
      if (has === null) return null;
      if (has) {
        if (!chain.pointPool || !chain.pool) return registry;
        const p = await chain.pointPool().catch(() => null);
        if (!p) return null;
        if (p.toLowerCase() === chain.pool.toLowerCase()) return registry;
        // the registry keeps one pool's points: a keeper for another pool on the chain leaves it alone, and never asks it again
        notOurs = true;
        log(`catch-up registry ${cfg.pointsAddress} keeps pool ${p}'s points, not this pool's; ${hubOn() ? `posting to the catch-up hub ${cfg.pointsHub}` : 'not posting points'}`);
      } else if (!hubOn()) {
        once('registry', `catch-up registry ${cfg.pointsAddress} has no code on this chain yet; not posting points`);
        return null;
      }
    }
    if (!hubOn()) return notOurs ? false : null;
    // A keeper that started before the hub was deployed on its chain looks again from time to time; once it has code, it is the
    // hub's for good.
    const has = await chain.hasCode(cfg.pointsHub).catch(() => null);
    if (has) return hub;
    if (has === false) once('hub', `catch-up hub ${cfg.pointsHub} has no code on this chain yet; not posting points`);
    return null;
  }

  // → the hash of a post sent, or null when none was due or possible.
  async function maybePost(synced) {
    if ((!cfg.pointsAddress && !cfg.pointsHub) || !synced?.confirmed) return null;
    // What is posted is taken now, before anything is awaited: the tree behind `synced` can move on while the chain is asked.
    const { tree, block } = synced.confirmed, size = Number(tree.size), filled = tree.toJSON().filled.map(b32);
    if (!target && now() - checkedAt >= RECHECK_MS) {
      checkedAt = now();
      const t = await find();
      if (t === false) checkedAt = Infinity;
      else target = t;
    }
    if (!target) return null;
    // One attempt every ten minutes at most: a failed send (short of ETH, a race) is not retried every tick; and one post at a time
    // from a key several pools share.
    if (now() - lastTry < RETRY_MS || now() - gate.at < SPACING_MS) return null;
    if (!size || size % 2 || !(Number(block) > 0)) return null;
    const latest = await target.latest();
    if (size <= latest) return null;
    // Growth alone is a reason once it is large; time alone is a reason only with some growth worth a post's gas.
    let due = !latest || size - latest >= cfg.pointsEvery;
    if (!due && size - latest >= Math.max(2, Math.ceil(cfg.pointsEvery / 10))) due = now() / 1000 - (await target.postedAt(latest)) >= cfg.pointsMaxAgeSecs;
    if (!due) return null;
    lastTry = now();
    gate.at = now();
    // Affordable with room to spare: a post is never what leaves the keeper unable to send a user's payment.
    const front = await chain.canFront(cfg.pointsGas);
    if (!front.ok || front.balance < 3n * front.need) { log(`catch-up point at ${size} leaves not posted: the keeper holds ${front.balance} wei and a ${cfg.pointsGas}-gas post needs ${front.need} now`); return null; }
    try {
      const hash = await target.post(size, block, filled);
      log(`posted catch-up point at ${size} leaves (block ${block}) to the ${target.name}: ${hash}`);
      return hash;
    } catch (e) {
      log(`catch-up point at ${size} leaves not posted to the ${target.name}: ${safeErr(e)}`);
      return null;
    }
  }
  // Where points go, once found: 'registry', 'hub', or null.
  return { maybePost, target: () => target?.name ?? null };
}
