// EVM-lane balance reader — the Ethereum-side holdings for the unified surface (task #6;
// feeds dapp/unified-holdings.js scanHoldingsUnified).
// For each asset the resolver knows on the Ethereum lane, it reads the user's canonical-ERC20 balance
// (`canonicalTokenFor(assetId)` → `balanceOf(evmAddress)`) and normalizes the 18-dec amount to the
// asset's in-system base units (the unified-holdings UNIT CONTRACT). Confidential-pool notes + tETH
// are additional lanes that plug in as `extraReaders`. INERT (returns []) until a pool + evm address
// are set, so it is safe to wire before the ConfidentialPool deploys.
//
// `ethCall(to, dataHex) => Promise<hexResult>` is injected (tacit.js provides `_ethRpcCall`-based);
// `keccak256` = the @noble keccak_256 (for ABI selectors); `resolver` = cross-chain-asset-resolver.

import { unitScaleFor } from './cross-chain-asset-resolver.js';

const _selector = (keccak256, sig) =>
  '0x' + Array.from(keccak256(new TextEncoder().encode(sig))).slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
const _pad32 = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const _isZeroAddr = (a) => !a || /^0x0*$/.test(a);

// A balance read that fails (every node busy or down) is not a zero balance. The last balance read for that token and
// address stands in for it, marked `stale`, and with none read yet the row is left out as before. A pool's canonical
// token never changes once set, so it is read once.
const _lastBalance = new Map();   // token|address → bigint
const _canonicalOf = new Map();   // pool|assetId → token address

export function makeEvmLaneReader({ ethCall, keccak256, resolver, evmAddress, pool, externalErc20 = [], extraReaders = [] } = {}) {
  if (!ethCall || !keccak256 || !resolver || !evmAddress || !pool) {
    return { readEvmLanes: async () => [] }; // inert until configured
  }
  const canonSel = _selector(keccak256, 'canonicalTokenFor(bytes32)'); // pool view: id → ERC20 address
  const balSel = _selector(keccak256, 'balanceOf(address)');

  async function canonicalToken(d) {
    if (d.canonicalErc20 && !_isZeroAddr(d.canonicalErc20)) return d.canonicalErc20;
    const key = `${String(pool).toLowerCase()}|${d.assetId}`;
    if (_canonicalOf.has(key)) return _canonicalOf.get(key);
    const r = await ethCall(pool, canonSel + _pad32(d.assetId)).catch(() => null);
    if (!r || r === '0x') return null;
    const addr = '0x' + r.replace(/^0x/, '').slice(-40);
    if (_isZeroAddr(addr)) return null;
    _canonicalOf.set(key, addr);
    return addr;
  }

  // → { raw, stale } for `token` at evmAddress, or null when it can't be read and never has been.
  async function balanceOf(token) {
    const key = `${String(token).toLowerCase()}|${String(evmAddress).toLowerCase()}`;
    try {
      const hex = await ethCall(token, balSel + _pad32(evmAddress));
      const raw = hex && hex !== '0x' ? BigInt(hex) : 0n;
      _lastBalance.set(key, raw);
      return { raw, stale: false };
    } catch {
      return _lastBalance.has(key) ? { raw: _lastBalance.get(key), stale: true } : null;
    }
  }

  // The canonical-ERC20 EVM lane for every resolver asset with an Ethereum lane (normalized to base units).
  async function readCanonicalErc20() {
    const out = [];
    for (const d of resolver.all()) {
      if (!Array.isArray(d.lanes) || !d.lanes.includes('ethereum')) continue;
      const token = await canonicalToken(d);
      if (!token) continue;
      const b = await balanceOf(token);
      if (!b || b.raw === 0n) continue;
      const scale = d.unitScale ?? unitScaleFor(d.tacitDecimals ?? 8);
      out.push({ assetId: d.assetId, ticker: d.ticker, decimals: d.tacitDecimals, balance: b.raw / scale, source: 'eth-canonical', lane: 'ethereum', ...(b.stale ? { stale: true } : {}) });
    }
    return out;
  }

  // Display-only external ERC20s (USDC/USDT/wstETH) — public tokens the user holds but that are NOT tacit
  // assets. Each row carries `external: true` and a synthetic assetId (the token address) so the unified
  // merge keeps it as its own standalone row and never folds it into a cross-lane tacit-asset sum. `balance`
  // stays in the token's own base units (rawBalance) — there is no in-system unit contract to honor here, so
  // we also pass `decimals` for display formatting.
  async function readExternalErc20() {
    const out = [];
    for (const t of (externalErc20 || [])) {
      if (!t || _isZeroAddr(t.address)) continue;
      const b = await balanceOf(t.address);
      if (!b || b.raw === 0n) continue;
      out.push({ assetId: t.address.toLowerCase(), ticker: t.ticker, decimals: t.decimals, balance: b.raw, rawBalance: b.raw, source: 'eth-external', lane: 'ethereum', external: true, ...(b.stale ? { stale: true } : {}) });
    }
    return out;
  }

  // The full EVM lane = canonical ERC20 + external watch-tokens + any injected readers (pool notes, tETH).
  // A failing reader is skipped (the unified view degrades, never sinks the other lanes).
  async function readEvmLanes() {
    const parts = [readCanonicalErc20(), readExternalErc20(), ...extraReaders.map((r) => Promise.resolve().then(r))];
    const settled = await Promise.allSettled(parts);
    return settled.flatMap((s) => (s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : []));
  }

  return { readEvmLanes, readCanonicalErc20, readExternalErc20 };
}
