
export function makeCrossLaneGuard({ keccak256 }) {
  const strip = (h) => String(h == null ? '' : h).replace(/^0x/, '');
  const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const hexToBytes = (h) => {
    const s = strip(h);
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  const NULLIFIER_SPENT_SLOT = 70;

  function spentSlot(nullifierHex) {
    const nu = strip(nullifierHex).padStart(64, '0');
    if (nu.length !== 64) throw new Error('crosslane: nullifier must be 32 bytes');
    const slot = NULLIFIER_SPENT_SLOT.toString(16).padStart(64, '0');
    return '0x' + toHex(keccak256(hexToBytes(nu + slot)));
  }

  async function evmNullifierSpent(ethGetStorageAt, poolAddress, nullifierHex, blockTag = 'latest') {
    const slot = spentSlot(nullifierHex);
    const raw = await ethGetStorageAt(String(poolAddress).toLowerCase(), slot, blockTag);
    const hex = strip(raw);
    if (hex.length < 64) throw new Error('crosslane: malformed nullifierSpent storage read');
    return BigInt('0x' + hex.slice(0, 64)) !== 0n;
  }

  async function bitcoinSpendBlocked(ethGetStorageAt, poolAddress, nullifierHex, opts = {}) {
    if (!poolAddress) return { blocked: false, reason: 'crosslane-inactive' };
    const blockTag = opts.blockTag || 'latest';
    try {
      const spent = await evmNullifierSpent(ethGetStorageAt, poolAddress, nullifierHex, blockTag);
      return spent
        ? { blocked: true, reason: 'evm-spent' }
        : { blocked: false, reason: 'evm-unspent' };
    } catch (e) {
      return { blocked: true, reason: 'evm-unverifiable', error: String((e && e.message) || e) };
    }
  }

  async function bitcoinSpendBlockedAny(ethGetStorageAt, poolAddress, nullifierHexes, opts = {}) {
    if (!poolAddress) return { blocked: false, reason: 'crosslane-inactive' };
    const list = (nullifierHexes || []).filter(Boolean);
    if (!list.length) {
      return { blocked: true, reason: 'evm-unverifiable', error: 'no nullifier candidates supplied' };
    }
    for (const nu of list) {
      const v = await bitcoinSpendBlocked(ethGetStorageAt, poolAddress, nu, opts);
      if (v.blocked) return { ...v, nullifier: nu };
    }
    return { blocked: false, reason: 'evm-unspent' };
  }

  return { NULLIFIER_SPENT_SLOT, spentSlot, evmNullifierSpent, bitcoinSpendBlocked, bitcoinSpendBlockedAny };
}
