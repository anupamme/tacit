// Whether a relayed bridge mint is the mint of a real, recorded burn, checked from the op alone and the one root the pool holds.
//
// The relay spends a free settle (and a day's proof) on any accepted submit, and before this it looked at nothing in a bridge mint's op:
// a few junk posts used up the day's onboarding allowance, and a holder whose mint was then refused needs ETH to send it himself. A
// real mint carries, in its own op, the proof that its burn is in the set the pool holds: the burn's id (from the burned note's leaf
// and outpoint), the destination note's leaf, and the burn set's path to bitcoinBurnRoot. Nobody can build those for a burn that is
// not recorded, nor for a recorded one without the destination note's commitment, which only its holder (and the relay he sent it to)
// has. The check mirrors the guest's OP_BRIDGE_MINT (contracts/sp1/confidential/src/main.rs): it does not prove the mint (the kernel
// and the range proof are the guest's), it keeps junk from costing a settle.
//
//   pool: makeConfidentialPool(); op: the 'bridgemint' op as the client built it; knownRoot: the pool's knownBitcoinBurnRoot (storage
//   slot 80) or null when it could not be read, in which case nothing is refused (a mint is never held back by a failed read).
//   → { ok: true, burnId } | { ok: false, code, status, error }
//
// A stealth bridge mint (OP_BRIDGE_STEALTH_MINT, a burn that pays someone else) is the same check with its fields where that op keeps them:
// the burned note is inCx/inCy/inOwner, the burn set's path is bmNext/bmIndex/bmPath, and the destination the burn pinned is a stealth lock
// (lCx, lCy, ownerPub, deadline, locker) rather than a note. `stealth` is the stealth kit, for its stealthLockLeafBlind.
const HEX32 = /^0x[0-9a-f]{64}$/;
export const BURN_ROOT_SLOT = '0x50';
const lc = (x) => String(x == null ? '' : x).toLowerCase();

const PLAIN = {
  what: 'a bridge mint',
  input: (op) => op.input,
  membership: (op) => op.burnMembership,
  fields: (op) => [['output.cx', op.output && op.output.cx], ['output.cy', op.output && op.output.cy], ['output.owner', op.output && op.output.owner]],
  shape: () => null,
  destLeaf: (pool, op) => pool.leaf(lc(op.asset), op.output.cx, op.output.cy, op.output.owner),
};
const stealthView = (stealth) => ({
  what: 'a stealth bridge mint',
  input: (op) => ({ cx: op.inCx, cy: op.inCy, owner: op.inOwner }),
  membership: (op) => ({ next: op.bmNext, index: op.bmIndex, path: op.bmPath }),
  fields: (op) => [['lCx', op.lCx], ['lCy', op.lCy], ['ownerPub', op.ownerPub], ['locker', op.locker]],
  shape: (op) => (Number.isSafeInteger(Number(op.deadline)) && Number(op.deadline) > 0 ? null : 'a stealth bridge mint names the lock’s deadline'),
  destLeaf: (pool, op) => stealth.stealthLockLeafBlind(lc(op.asset), op.lCx, op.lCy, op.ownerPub, Number(op.deadline), op.locker),
});

export function admitBridgeMint({ pool, op, knownRoot = null }) { return admit(PLAIN, { pool, op, knownRoot }); }
export function admitBridgeStealthMint({ pool, stealth, op, knownRoot = null }) { return admit(stealthView(stealth), { pool, op, knownRoot }); }

function admit(view, { pool, op, knownRoot }) {
  const bad = (code, error, status = 400) => ({ ok: false, code, status, error });
  try {
    if (!op || typeof op !== 'object') return bad('not_a_burn', `this is not ${view.what}`);
    const input = view.input(op), bm = view.membership(op);
    const cls = Number(op.sourceClass), vout = Number(op.spentVout);
    for (const [k, v] of [['chainBinding', op.chainBinding], ['asset', op.asset], ['bitcoinBurnRoot', op.bitcoinBurnRoot], ['spentTxid', op.spentTxid],
      ['input.cx', input && input.cx], ['input.cy', input && input.cy], ['input.owner', input && input.owner],
      ...view.fields(op), ['burnMembership.next', bm && bm.next]]) {
      if (!HEX32.test(lc(v))) return bad('not_a_burn', `${view.what} needs ${k} as 32 bytes of hex`);
    }
    const shape = view.shape(op);
    if (shape) return bad('not_a_burn', shape);
    if (![0, 1, 2].includes(cls) || !Number.isInteger(vout) || vout < 0) return bad('not_a_burn', `${view.what} names its burned note by class and outpoint`);
    if (!bm || !Array.isArray(bm.path) || bm.path.length !== 32 || !bm.path.every((p) => HEX32.test(lc(p))) || !Number.isInteger(Number(bm.index))) {
      return bad('not_a_burn', `${view.what} carries the burn set path to its burn`);
    }
    // The root first: a mint built on an older burn set is refused by the pool after the proof is bought, so it is turned back here, and
    // the client rebuilds it from the newest state.
    if (knownRoot && lc(op.bitcoinBurnRoot) !== lc(knownRoot)) {
      return bad('stale_root', 'Bitcoin’s proof on Ethereum moved on while this mint was being built, so it was not taken: it is built again from the newest state', 409);
    }
    const asset = lc(op.asset), chainBinding = lc(op.chainBinding);
    let srcLeaf;
    if (cls === 0) {
      const own = pool.outpointKey(lc(op.spentTxid), vout);
      if (lc(input.owner) !== lc(own)) return bad('not_a_burn', 'a burn-deposit note is owned by its own outpoint');
      srcLeaf = pool.leaf(asset, input.cx, input.cy, own);
    } else if (cls === 1) srcLeaf = pool.btcNoteLeaf(asset, input.cx, input.cy, input.owner);
    else srcLeaf = pool.btcNoteLeafBound(asset, input.cx, input.cy, input.owner, chainBinding);
    const burnId = pool.bridgeBurnId(cls === 0 ? 2 : 1, lc(op.spentTxid), vout, srcLeaf, chainBinding);
    const destLeaf = view.destLeaf(pool, op);
    const root = knownRoot ? lc(knownRoot) : lc(op.bitcoinBurnRoot);
    // Without the pool's own root a self-consistent set proves nothing, so the burn is then not checked at all.
    if (knownRoot && !pool.verifyPath(pool.utxoLeaf(burnId, bm.next, destLeaf), Number(bm.index), bm.path.map(lc), root)) {
      return bad('not_a_burn', 'this is not the mint of a recorded burn, or not to the destination that burn pinned');
    }
    return { ok: true, burnId };
  } catch (e) {
    return bad('not_a_burn', `this is not ${view.what} the relay can read: ${(e && e.message) || e}`);
  }
}
