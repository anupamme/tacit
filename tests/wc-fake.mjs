// A stand-in for the vendored WalletConnect bundle (dapp/vendor/tacit-walletconnect.min.js), so a page runs the real dapp/walletconnect.js and its
// sheets with no relay and no phone. It behaves as the real provider (2.24.0) does where the page can tell: eth_chainId answers with a number, a
// session outlives a reload (kept in localStorage here, in IndexedDB there), connect() waits until the test approves, abortPairingAttempt does
// nothing, and a pending pairing deleted through signer.cleanupPendingPairings({ deletePairings: true }) can no longer be approved (connect()
// then waits on, as a proposal does until it expires). The session holds the chains the page asked for (or __wcfake.approveChains), with an
// account on each, and a switch to a chain it holds is made by the provider itself: only a switch to another reaches the wallet app.
// The test drives it through window.__wcfake: approve(), reject(error), and counters of what the page did (cancelled: pairings deleted).
//
//   const hits = await useWcFake(ctx, { account })      hits.bundle counts the times the page fetched the bundle
//   window.__wcRequest(method, params) → result         (exposeFunction) answers a request the fake would otherwise answer by default

export const WC_FAKE_BUNDLE = `
const ACCOUNT = window.__WC_ACCOUNT || '0x1234567890abcdef1234567890abcdef12345678';
const KEY = 'fake-wc-session';
export const qrcode = () => ({ addData() {}, make() {}, createSvgTag: () => '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>' });
export const EthereumProvider = {
  async init(opts) {
    const w = (window.__wcfake ||= { inits: 0, pairs: 0, cancelled: 0, disconnected: 0, requests: [], approve: null, reject: null, chain: 1, peerName: 'Test Phone Wallet', approveChains: null, opts: null });
    w.inits++; w.opts = opts;
    const handlers = {};
    const emit = (ev, ...a) => (handlers[ev] || []).forEach((f) => f(...a));
    let saved = null; try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    let pending = null;                                   // the pairing a wallet app can approve, until it is approved or deleted
    const holds = (n) => (p.session?.namespaces?.eip155?.accounts || []).some((a) => a.split(':')[1] === String(n));
    const p = {
      session: saved || undefined,
      get accounts() { return p.session ? [ACCOUNT] : []; },
      signer: {
        abortPairingAttempt() {},
        async cleanupPendingPairings({ deletePairings } = {}) { if (deletePairings && pending) { pending = null; w.cancelled++; } },
      },
      on(ev, f) { (handlers[ev] ||= []).push(f); return p; },
      removeListener(ev, f) { handlers[ev] = (handlers[ev] || []).filter((x) => x !== f); return p; },
      async connect() {
        w.pairs++;
        const mine = pending = {};
        emit('display_uri', 'wc:fake' + w.pairs + '@2?relay-protocol=irn&symKey=00');
        await new Promise((res, rej) => { w.approve = () => { if (pending === mine) res(); }; w.reject = rej; });
        pending = null;
        const chains = (w.approveChains || opts.optionalChains || [1]).map((c) => 'eip155:' + c);
        p.session = {
          expiry: Math.floor(Date.now() / 1000) + 7 * 86400, peer: { metadata: { name: w.peerName, redirect: { native: 'testphone://' } } },
          namespaces: { eip155: { chains, accounts: chains.map((c) => c + ':' + ACCOUNT), methods: ['personal_sign', 'eth_sendTransaction'], events: ['accountsChanged', 'chainChanged'] } },
        };
        localStorage.setItem(KEY, JSON.stringify(p.session));
      },
      async request({ method, params }) {
        w.requests.push(method);
        const switching = method === 'wallet_switchEthereumChain' ? parseInt(params[0].chainId, 16) : null;
        const switched = () => { w.chain = switching; emit('chainChanged', params[0].chainId); return null; };
        if (switching && holds(switching)) return switched();
        if (window.__wcRequest) { const r = await window.__wcRequest(method, params); if (r !== undefined && !switching) return r; }
        if (method === 'eth_accounts') return p.accounts;
        if (method === 'eth_chainId') return w.chain;
        if (switching) return switched();
        if (method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32);
        return null;
      },
      async disconnect() { w.disconnected++; p.session = undefined; localStorage.removeItem(KEY); emit('disconnect', {}); },
    };
    return p;
  },
};
`;

export async function useWcFake(ctx, { account } = {}) {
  const hits = { bundle: 0 };
  if (account) await ctx.addInitScript(`window.__WC_ACCOUNT = ${JSON.stringify(account)};`);
  await ctx.route('**/vendor/tacit-walletconnect.min.js*', (r) => { hits.bundle++; return r.fulfill({ status: 200, contentType: 'text/javascript', body: WC_FAKE_BUNDLE }); });
  return hits;
}
