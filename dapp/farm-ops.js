// A private farm position, the same on every page that shows one: when it can be harvested or unbonded, and the two calls themselves. The
// page brings the pool module (t), the key and its way of proving (waitOpts); nothing here holds state or draws anything.
//   const { canHarvest, canUnbond, harvest, unbond } = await import('/farm-ops.js');

// A position whose pending reward is at most this many units has earned nothing worth harvesting first: unbonding gives it up.
export const UNBOND_DUST = 100000n;
// A reward of at most this many units is worth less than turning it into TAC costs: an unbond refused over it is sent again giving it up.
export const HARVEST_WORTH = 1000000n;

const units = (pos) => { try { return BigInt(pos?.pendingUnits || 0); } catch { return 0n; } };
export const unharvested = (pos) => units(pos) > UNBOND_DUST;
export const locked = (pos, now = Date.now() / 1000) => Number(pos?.unlockAt || 0) > now;
// what the buttons say: harvest once anything is pending; unbond once the bond is over and what is pending is dust
export const canHarvest = (pos) => units(pos) > 0n;
export const canUnbond = (pos, now) => !locked(pos, now) && !unharvested(pos);

// the reward a harvest pays, as a wTAC note (one for one with TAC; turning it into TAC is a step of its own)
export const harvest = (t, priv, pos, waitOpts) => t.farmHarvest({ walletPriv: priv, position: pos, waitOpts });

// Unbonding: the position's liquidity comes back as a private note. The pool refuses one that would forfeit a pending reward; if that reward
// is no more than HARVEST_WORTH (dust left by the farm paying every second since the last harvest), it is sent again giving it up.
export async function unbond(t, priv, pos, waitOpts, again = (p) => p) {
  try { return await t.farmUnbond({ walletPriv: priv, position: pos, forfeitPending: false, waitOpts }); }
  catch (e) {
    const u = /farm-unbond: (\d+) reward units/.exec(String(e?.message || ''));
    if (!u || BigInt(u[1]) > HARVEST_WORTH) throw e;
    return t.farmUnbond({ walletPriv: priv, position: again(pos), forfeitPending: true, waitOpts });
  }
}
