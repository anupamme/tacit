// A stand-in for the vendored WalletConnect bundle (dapp/vendor/tacit-walletconnect.min.js), so a page runs the real dapp/walletconnect.js and its
// sheets with no relay and no phone. It behaves as the real provider does where the page can tell: eth_chainId answers with a number, a session
// outlives a reload (kept in localStorage here, in IndexedDB there), connect() waits until the test approves, and a cancelled pairing ends it.
// The test drives it through window.__wcfake: approve(), reject(error), and counters of what the page did.
//
//   const hits = await useWcFake(ctx, { account })      hits.bundle counts the times the page fetched the bundle
//   window.__wcRequest(method, params) → result         (exposeFunction) answers a request the fake would otherwise answer by default

export const WC_FAKE_BUNDLE = `
const ACCOUNT = window.__WC_ACCOUNT || '0x1234567890abcdef1234567890abcdef12345678';
const KEY = 'fake-wc-session';
export const qrcode = () => ({ addData() {}, make() {}, createSvgTag: () => '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>' });
export const EthereumProvider = {
  async init(opts) {
    const w = (window.__wcfake ||= { inits: 0, pairs: 0, cancelled: 0, disconnected: 0, requests: [], approve: null, reject: null, chain: 1, peerName: 'Test Phone Wallet', opts: null });
    w.inits++; w.opts = opts;
    const handlers = {};
    const emit = (ev, ...a) => (handlers[ev] || []).forEach((f) => f(...a));
    let saved = null; try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    const p = {
      session: saved || undefined,
      get accounts() { return p.session ? [ACCOUNT] : []; },
      signer: { abortPairingAttempt() { w.cancelled++; w.reject?.(Object.assign(new Error('Connection request reset. Please try again.'), {})); } },
      on(ev, f) { (handlers[ev] ||= []).push(f); return p; },
      removeListener(ev, f) { handlers[ev] = (handlers[ev] || []).filter((x) => x !== f); return p; },
      async connect() {
        w.pairs++;
        emit('display_uri', 'wc:fake' + w.pairs + '@2?relay-protocol=irn&symKey=00');
        await new Promise((res, rej) => { w.approve = res; w.reject = rej; });
        p.session = { expiry: Math.floor(Date.now() / 1000) + 7 * 86400, peer: { metadata: { name: w.peerName, redirect: { native: 'testphone://' } } } };
        localStorage.setItem(KEY, JSON.stringify(p.session));
      },
      async request({ method, params }) {
        w.requests.push(method);
        if (window.__wcRequest) { const r = await window.__wcRequest(method, params); if (r !== undefined) return r; }
        if (method === 'eth_accounts') return p.accounts;
        if (method === 'eth_chainId') return w.chain;
        if (method === 'wallet_switchEthereumChain') { w.chain = parseInt(params[0].chainId, 16); emit('chainChanged', params[0].chainId); return null; }
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
