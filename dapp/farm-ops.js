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

// ── what a position pays, turned into TAC ──
// A harvest pays wTAC, the farm's reward token, held privately as a note. The relay unwraps a note to an Ethereum address (wTAC there), and
// that address turns its wTAC into TAC with the token's withdraw(amount, to).
export const WTAC = '0x2018139a8fdd3666855be3315c7683b4d6ab7aef';
const word = (v) => BigInt(v).toString(16).padStart(64, '0'), addr = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
export const wtacWithdrawCall = (amount, to) => ({ to: WTAC, data: '0x00f714ce' + word(amount) + addr(to) });
export const wtacBalanceCall = (who) => ({ to: WTAC, data: '0x70a08231' + addr(who) });
export const rewardNotes = (notes, rewardAsset) => (notes || []).filter((n) => rewardAsset && String(n.asset).toLowerCase() === String(rewardAsset).toLowerCase());
// a reward note the relay can unwrap for something: what it charges leaves a remainder (a note that cannot be priced is tried)
export function relayable(t, note, rewardAsset) {
  try { return (t.quoteUnwrapFee(note.value, t.poolTickerOf(String(rewardAsset).toLowerCase()))?.net ?? 1n) > 0n; } catch { return true; }
}
// worth harvesting through the relay: its unwrap costs no more than half of it
export function worthHarvesting(t, units, rewardAsset) {
  const v = BigInt(units || 0);
  if (v <= HARVEST_WORTH) return false;
  try { return t.quoteUnwrapFee(v, t.poolTickerOf(String(rewardAsset).toLowerCase())).fee * 2n <= v; } catch { return false; }
}
export const redeem = (t, priv, note, to, waitOpts) => t.farmRedeem({ walletPriv: priv, note, to, wait: true, waitOpts });

// ── taking the liquidity out ──
// the pool's share notes, which an unbond gives back, and taking one out of the pool as its two assets
export const lpNotes = (notes, pool) => (notes || []).filter((n) => pool?.lpAsset && String(n.asset).toLowerCase() === String(pool.lpAsset).toLowerCase());
export const takeOut = (t, priv, pool, note, waitOpts) => t.lpRemove({ walletPriv: priv, assetA: pool.reserves.assetA, assetB: pool.reserves.assetB, feeBps: Number(pool.feeBps ?? 30), shareNote: note, waitOpts });

// ── joining: both sides at the pool's ratio, bonded in one ──
// the second side for `a` of the first, rounded up so the pool never takes less than its ratio; the first side for `b` of the second
export const bFor = (a, res) => (BigInt(a) * BigInt(res.reserveB) + BigInt(res.reserveA) - 1n) / BigInt(res.reserveA);
export const aFor = (b, res) => (BigInt(b) * BigInt(res.reserveA)) / BigInt(res.reserveB);
// The pool as it stands and what the relay charges to cut a note of each side to size; refused if the pool is not open or reads differently
// from the farm program.
export async function joinTerms(t, pool) {
  const tk = (id) => t.poolTickerOf(String(id).toLowerCase());
  const [res, feeA, feeB] = await Promise.all([t.poolReserves(pool.poolId), t.quoteOpFee(tk(pool.reserves.assetA), 'transfer').then(BigInt), t.quoteOpFee(tk(pool.reserves.assetB), 'transfer').then(BigInt)]);
  if (!res || !(BigInt(res.totalShares || 0) > 0n)) throw new Error('This pool is not open for liquidity yet.');
  if (String(res.assetA).toLowerCase() !== String(pool.reserves.assetA).toLowerCase()) throw new Error('This pool reads differently from the farm program. Try again in a minute.');
  return { res, feeA, feeB };
}
const byValue = (a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : BigInt(a.value) > BigInt(b.value) ? 1 : 0);
export const notesOf = (notes, asset) => (notes || []).filter((n) => String(n.asset).toLowerCase() === String(asset).toLowerCase());
export const exactOf = (notes, amount) => [...notes].sort(byValue).find((n) => BigInt(n.value) === BigInt(amount)) || null;
// The notes a cut to `amount` spends, as the front page picks them: the smallest one that covers it and the relay's fee, else the largest
// (up to 16) until they do; null when they cannot.
export function cutPick(notes, amount, fee) {
  const need = BigInt(amount) + BigInt(fee), up = [...notes].sort(byValue);
  const one = up.find((x) => BigInt(x.value) >= need);
  if (one) return [one];
  const picked = []; let sum = 0n;
  for (const x of [...up].reverse()) { if (sum >= need || picked.length === 16) break; picked.push(x); sum += BigInt(x.value); }
  return sum >= need ? picked : null;
}
// a cut: the notes picked sent to the key itself, `amount` in one note and the rest in another, the relay's fee taken from them
export const cut = (t, priv, notes, amount, fee, waitOpts) => t.transfer({ walletPriv: priv, notes, recipientPubHex: t.identity(priv).pubHex, amount: BigInt(amount), fee: BigInt(fee), waitOpts });
// the two notes added to the pool and the share note bonded in the farm, in one proof
export const bond = (t, priv, { manager, aNote, bNote, feeBps, waitOpts }) => t.lpBond({ walletPriv: priv, controller: manager, aNote, bNote, feeBps: Number(feeBps ?? 30), waitOpts });
