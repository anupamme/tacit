// Brings a key's on-device pool wallet up to date off the page's main thread. Replaying the pool's tree hashes every leaf
// since the last saved state (Base's history is millions of hashes), which would freeze the page for seconds at a time.
// The page sends the wallet's saved state for one chain; this runs the same wallet code's sync on it and sends back what
// each state as it is written, so a long history read partway is kept. The page stores them (still only a cache: every
// balance is found again from the key and the chain), and its own wallet, made from them, then reads only what came after.
import { makeEvmPoolZk } from '/evm-pool-zk.js?cb=2f062779';
import { makeEvmPoolWallet, evmPoolKeys, jsonRpc } from '/evm-pool-wallet.js?cb=937aa831';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from '/vendor/tacit-poseidon.min.js';

const PO = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => PO[xs.length](xs) });

self.onmessage = async ({ data: { id, priv, chain: c, pool, router, entries } }) => {
  const kept = new Map(Object.entries(entries || {}));
  const store = { get: (k) => kept.get(k) ?? null, set: (k, v) => { kept.set(k, v); self.postMessage({ id, write: [k, v] }); } };
  try {
    const W = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, priv), keeper: c.keeper, store, prove: null,
      chain: { chainId: c.chainId, pool, router, rpc: jsonRpc(c.rpc), deployBlock: c.deployBlock, confirmations: c.confirmations, logChunk: c.logChunk } });
    const s = await W.sync();
    self.postMessage({ id, ok: true, balance: String(s.balance) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e) });
  }
};
