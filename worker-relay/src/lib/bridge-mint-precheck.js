// Before a bridge mint is paid for, compare the burn root it was built on with the one the pool holds now. ConfidentialPool.settle
// takes a mint only on the current root (knownBitcoinBurnRoot, storage slot 80; StaleBitcoinBurnRoot otherwise), and the reflection
// moves that root every time it folds a Bitcoin block that holds a burn. A mint that waited in the queue, or was sent back in line
// hours after it failed, is built on an older root and can only revert, whatever its proof, so it is failed without proving, with a
// reason the page reads as "built again from the newest state". Anything unreadable lets the job through, so the check only ever
// skips work that cannot succeed.
const BURN_ROOT_SLOT = '0x50';
const isRoot = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

// A reason string when the mint's settle can only revert, else null.
export async function bridgeMintBlocker({ type, op }, { client, pool }) {
  if (!['bridgemint', 'bridgestealthmint'].includes(type) || !op || !isRoot(op.bitcoinBurnRoot)) return null;
  try {
    const held = await client.getStorageAt({ address: pool, slot: BURN_ROOT_SLOT });
    if (!isRoot(held) || BigInt(held) === 0n) return null;
    if (BigInt(held) === BigInt(op.bitcoinBurnRoot)) return null;
    return 'Bitcoin’s proof on Ethereum moved on while this mint was waiting, so it was not proved and nothing was spent. It is built again from the newest state.';
  } catch { return null; }
}
