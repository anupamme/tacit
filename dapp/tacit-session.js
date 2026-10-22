// tacit.js, the full wallet library, on a page that holds its own Tacit key: loaded once on first use, its calls taken one at a time, and
// the key put into its wallet only for a call made under that key. tacit.js keeps its wallet's identity in shared storage (the keys below);
// a call here leaves those as they were unless another tab changed them meanwhile, so a page using it never signs another tab out or in.
//   const TS = makeTacitSession({ url: '/tacit.js?cb=…', key: () => <the open key: { pubHex, priv }>, secp, bytesToHex, hexToBytes });
//   await TS.withKey((t) => t.bridgeUx().advance(pub, id), pub);
const SHARED_NET = 'tacit-network-v1', PREV_NET = 'tacit-lite-prev-net-v1';
const SHARED_WALLET_KEYS = ['tacit-eth-identity', 'tacit-btc-identity', 'tacit-active-mode-v1', 'tacit-ext-mode-v1', 'tacit-ext-state-v1',
  ...['mainnet', 'signet'].flatMap((n) => [`tacit-eth-identity:${n}`, `tacit-btc-identity:${n}`, `tacit-active-mode-v1:${n}`])];

export function makeTacitSession({ url, key, secp, bytesToHex, hexToBytes, onLoad = () => {} }) {
  let T = null, loading = null, q = Promise.resolve();

  // tacit.js reads the network from shared storage: it is pinned to mainnet while this page is open, and put back as it was when it closes
  function load() {
    return (loading ||= (async () => {
      try { const cur = localStorage.getItem(SHARED_NET); if (sessionStorage.getItem(PREV_NET) === null && cur !== 'mainnet') sessionStorage.setItem(PREV_NET, cur ?? ''); localStorage.setItem(SHARED_NET, 'mainnet'); } catch {}
      globalThis.__TACIT_NO_INIT__ = true;
      T = await import(url);
      onLoad(T);
      return T;
    })().catch((e) => { loading = null; throw e; }));
  }
  window.addEventListener('pagehide', () => {
    try { const p = sessionStorage.getItem(PREV_NET); if (p !== null) { p === '' ? localStorage.removeItem(SHARED_NET) : localStorage.setItem(SHARED_NET, p); sessionStorage.removeItem(PREV_NET); } } catch {}
  });

  async function keepShared(fn) {
    let snap = [];
    try { snap = SHARED_WALLET_KEYS.map((k) => [k, localStorage.getItem(k)]); } catch {}
    const theirs = new Set(), seen = (e) => { if (e.storageArea === localStorage) theirs.add(e.key); };
    window.addEventListener('storage', seen);
    try { return await fn(); } finally {
      window.removeEventListener('storage', seen);
      for (const [k, v] of snap) { if (theirs.has(k) || theirs.has(null)) continue; try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
    }
  }
  function turn(fn) {
    const run = q.then(async () => { await load(); return keepShared(fn); });
    q = run.catch(() => {});
    return run;
  }

  // a call under the key `pub`, refused if the page's key is another by then
  function withKey(fn, pub = key()?.pubHex) {
    return turn(async () => {
      const k = key();
      if (!k || k.pubHex !== pub) throw new Error('Your Tacit wallet changed, so nothing was done.');
      if (!T.wallet.priv || bytesToHex(T.wallet.pub || new Uint8Array()) !== pub) {
        const priv = hexToBytes(k.priv);
        T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true);
        try { T.invalidateHoldingsCache({ fromPoll: true }); } catch {}
      }
      return fn(T);
    });
  }
  // the key out of tacit.js's wallet, when the page's key is locked or changed
  function drop() {
    if (!T) return;
    turn(() => { T.wallet.priv?.fill(0); T.wallet.priv = null; T.wallet.pub = null; try { T.invalidateHoldingsCache({ fromPoll: true }); } catch {} }).catch(() => {});
  }
  // the key tacit.js's wallet just loaded, taken out of it (as hex)
  const tPriv = () => { const h = bytesToHex(T.wallet.priv); T.wallet.priv.fill(0); T.wallet.priv = null; return h; };

  return { load, turn, withKey, drop, tPriv, get T() { return T; } };
}
