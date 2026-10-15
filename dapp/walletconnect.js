// WalletConnect (v2) as one more Ethereum wallet. It is announced the way browser wallets announce themselves (EIP-6963), so
// a page's wallet picker lists it beside them with no special case, and on a phone with no wallet extension it is the
// one wallet offered. Its bundle loads the first time it is used, or on a reload that finds a session kept in this browser.
// Pairing shows through the page's own sheet: `onPair` gets the pairing link, a QR code of it, and `cancel`, and returns a
// function that puts the sheet away when pairing ends (approved, refused or cancelled). A request the wallet app has to
// approve shows the same way: `onAsk` gets the app's name and, where it gave one, a link that opens it, and returns a
// function called once the app answers. `wcSheets` draws both sheets for any page that can give it a place to show them.
//
//   announceWalletConnect({ projectId, chains, rpcMap, metadata, onPair, onAsk }) → { provider, disconnect }
//   wcSheets(open) → { onPair, onAsk }        open(title, onClose) → { body, close }
//   dialogHost({ dialog, title, body }) → open    for a page that keeps its sheets in a <dialog>
//   overlayHost() → open                          for a page with no sheets of its own: a <dialog> that brings its own look

// The project is zSwap's, shared: an allowlist set on it must name tacit.finance too.
export const WC_PROJECT_ID = '1e8390ef1c1d8a185e035912a1409749';
const BUNDLE = '/vendor/tacit-walletconnect.min.js?cb=e850e423';
const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#3B99FC"/>'
  + '<path transform="translate(10 18.5) scale(.147)" fill="#fff" d="M61.4 36.3c48.9-47.9 128.3-47.9 177.2 0l5.9 5.8c2.4 2.4 2.4 6.3 0 8.7l-20.1 19.7c-1.2 1.2-3.2 1.2-4.4 0l-8.1-7.9c-34.1-33.4-89.4-33.4-123.5 0l-8.7 8.5c-1.2 1.2-3.2 1.2-4.4 0L55.2 51.4c-2.4-2.4-2.4-6.3 0-8.7l6.2-6.4zm218.9 40.8l17.9 17.5c2.4 2.4 2.4 6.3 0 8.7l-80.7 79c-2.4 2.4-6.4 2.4-8.9 0l-57.3-56.1c-.6-.6-1.6-.6-2.2 0L91.8 182.3c-2.4 2.4-6.4 2.4-8.9 0L1.8 103.3c-2.4-2.4-2.4-6.3 0-8.7l17.9-17.5c2.4-2.4 6.4-2.4 8.9 0l57.3 56.1c.6.6 1.6.6 2.2 0l57.3-56.1c2.4-2.4 6.4-2.4 8.9 0l57.3 56.1c.6.6 1.6.6 2.2 0l57.3-56.1c2.4-2.4 6.4-2.4 8.9 0z"/></svg>');
// Requests the wallet app answers, which is where they are approved.
const ASKS = new Set(['personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_watchAsset']);
const rejected = (message) => Object.assign(new Error(message), { code: 4001 });
// A chain id the way a wallet extension gives it: 0x-prefixed hex. The provider answers eth_chainId with a number, which a page that compares it with '0x1' (or reads it as hex) takes for another network.
const hexChain = (c) => `0x${BigInt(c).toString(16)}`;

// Whether this browser keeps a session, known without loading the bundle: its expiry (unix seconds) when it does, 0 when it does not. A browser that has
// never noted it (a session made before this was kept) is asked once.
const KEPT = 'tacit-wc-session';
const kept = {
  get() { try { return localStorage.getItem(KEPT); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEPT, String(v)); } catch { /* storage is a convenience */ } },
};

export function announceWalletConnect({ projectId, chains, rpcMap, metadata, onPair, onAsk }) {
  const listeners = new Map();                                    // event → handlers, kept until the provider exists
  let wc = null, loading = null, pairing = null;
  const load = () => (wc ? Promise.resolve(wc) : (loading ||= (async () => {
    const { EthereumProvider, qrcode } = await import(BUNDLE).catch(() => { throw new Error('WalletConnect did not load. Check your connection and try again.'); });
    const p = await EthereumProvider.init({ projectId, optionalChains: chains, rpcMap, metadata, showQrModal: false, telemetryEnabled: false });
    for (const [ev, fns] of listeners) for (const fn of fns) p.on(ev, fn);
    // A session ended from the wallet app reads to the page as the wallet locking.
    p.on('disconnect', () => { kept.set(0); for (const fn of listeners.get('accountsChanged') || []) fn([]); });
    kept.set(p.session?.expiry || 0);
    wc = { p, qrcode };
    return wc;
  })().catch((e) => { loading = null; throw e; })));

  async function pair({ p, qrcode }) {
    let cancel, done = null;
    const cancelled = new Promise((_, reject) => { cancel = () => { try { p.signer?.abortPairingAttempt?.(); } catch { /* already ended */ } reject(rejected('Connection cancelled')); }; });
    cancelled.catch(() => {});
    const shown = (uri) => {
      const q = qrcode(0, 'M');
      q.addData(uri); q.make();
      done = onPair?.({ uri, qrSvg: q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }), cancel }) || null;
    };
    p.on('display_uri', shown);
    const connecting = p.connect();
    connecting.catch(() => {});                                   // settles after a cancel too, with no one waiting
    try { await Promise.race([connecting, cancelled]); }
    catch (e) {
      const m = e?.message || '';
      if (e?.code === 4001 || /reject|denied|cancel/i.test(m)) throw rejected(m || 'Connection refused');
      if (/expire|time(d)? ?out/i.test(m)) throw Object.assign(new Error('The code ran out before a wallet app approved it. Connect again for a new one.'), { expired: true });
      throw e;
    }
    finally { p.removeListener('display_uri', shown); done?.(); }
    kept.set(p.session?.expiry || 0);
  }

  // The wallet app as it named itself when it paired, and the link that opens it: its own scheme, else its https link.
  // A browser opens either only from a tap, so the page shows it as a button rather than following it here.
  function peer(p) {
    const m = p.session?.peer?.metadata, r = m?.redirect;
    const native = /^[a-z][a-z0-9+.-]*:/i.test(r?.native || '') && !/^(https?|javascript|data|file|blob|about|vbscript):/i.test(r.native) ? r.native : null;
    return { name: String(m?.name || '').slice(0, 40), link: native || (/^https:\/\//i.test(r?.universal || '') ? r.universal : null) };
  }

  const provider = {
    isWalletConnect: true,
    async request(args) {
      const method = args?.method;
      const unpaired = () => Object.assign(new Error('Connect a wallet through WalletConnect first.'), { code: 4100 });
      // Nothing was ever paired here: answered without loading the bundle, so a page that asks for accounts on each load costs a returning visitor nothing.
      if (!wc && kept.get() === '0' && method !== 'eth_requestAccounts') { if (method === 'eth_accounts') return []; throw unpaired(); }
      const w = await load();
      if (!w.p.session) {
        if (method === 'eth_accounts') return [];
        if (method !== 'eth_requestAccounts') throw unpaired();
        await (pairing ||= pair(w).finally(() => { pairing = null; }));            // a second press joins the pairing under way
      }
      if (method === 'eth_requestAccounts') return w.p.accounts;
      if (method === 'eth_chainId') return hexChain(await w.p.request(args));
      if (!ASKS.has(method)) return w.p.request(args);
      const p = peer(w.p), done = onAsk?.({ name: p.name || 'your wallet app', link: p.link }) || null;
      try { return await w.p.request(args); } finally { done?.(); }
    },
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); wc?.p.on(ev, fn); return provider; },
    removeListener(ev, fn) { listeners.get(ev)?.delete(fn); wc?.p.removeListener(ev, fn); return provider; },
    // The wallet app the session is with, by the name it gave; '' before a session.
    peerName: () => (wc?.p.session ? peer(wc.p).name : ''),
    endSession: () => disconnect(),
  };
  // Ends the session in the wallet app too, and reads to the page as the wallet locking. Nothing to do when WalletConnect
  // was never used here.
  async function disconnect() {
    if (!wc?.p.session) return;
    try { await wc.p.disconnect(); } catch { /* already gone */ }
    kept.set(0);
    for (const fn of listeners.get('accountsChanged') || []) fn([]);
  }

  // Listed beside the wallets that announce themselves, or alone where there is no wallet in the page at all. A wallet
  // app's own browser that only sets window.ethereum keeps being the wallet used there, as before.
  const detail = Object.freeze({ info: Object.freeze({ uuid: crypto.randomUUID(), name: 'WalletConnect', icon: ICON, rdns: 'com.walletconnect' }), provider });
  const others = new Set();
  window.addEventListener('eip6963:announceProvider', (e) => { const u = e.detail?.info?.uuid; if (u && u !== detail.info.uuid) others.add(u); });
  const announce = () => { if (others.size || !window.ethereum) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })); };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  return { provider, disconnect };
}

// ── the sheets ──
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const phone = () => matchMedia('(pointer: coarse)').matches;
// Wallet apps that open a pairing from a link of their own scheme. Such a link goes to no server, so the pairing's key stays on the phone.
const APPS = [['MetaMask', 'metamask'], ['Rainbow', 'rainbow'], ['Trust Wallet', 'trust']];
export const appLinks = (uri) => APPS.map(([name, scheme]) => ({ name, href: `${scheme}://wc?uri=${encodeURIComponent(uri)}` }));

// The pairing sheet and the sheet for a request waiting in the wallet app, drawn into whatever place `open` gives: `open(title, onClose)` shows a sheet
// and returns its `body` and a `close()`; `onClose` is called when the person closes it.
export function wcSheets(open) {
  const lede = (t) => `<p class="lede-s" style="margin:0 0 12px">${t}</p>`;
  return {
    onPair({ uri, qrSvg, cancel }) {
      let over = false;
      const o = open('Connect a wallet app', () => { if (!over) cancel(); });
      const on = phone();
      // On a phone the apps come first: the code is for scanning from another device.
      const apps = on ? `<div style="display:grid;gap:8px;margin:0 0 14px">${appLinks(uri).map((a) => `<a class="btn" style="margin:0" href="${esc(a.href)}">Open ${esc(a.name)}</a>`).join('')}<a class="btn ghost" style="margin:0" href="${esc(uri)}">Other wallet app</a></div>` : '';
      const qr = `<div class="wc-qr">${qrSvg}</div>`;
      o.body.innerHTML = `${lede(on ? 'Open your wallet app to connect, or scan the code from another device.' : 'Scan the code with a wallet app on your phone: MetaMask, Rainbow, Trust, Zerion or any WalletConnect wallet.')}${on ? apps + qr : qr}<button class="btn ghost" type="button" style="margin-top:0" data-copy>Copy link</button><p class="note">This waits until the wallet app approves. Connecting costs nothing, and the code works for a few minutes.</p>`;
      o.body.querySelector('[data-copy]').onclick = (e) => navigator.clipboard?.writeText(uri).then(() => { e.target.textContent = 'Copied'; }, () => { e.target.textContent = 'Could not copy'; });
      return () => { over = true; o.close(); };
    },
    onAsk({ name, link }) {
      const o = open('Approve in your wallet');
      const on = phone();
      o.body.innerHTML = `${lede(on ? `Open ${esc(name)} to approve the request, then come back here.` : `Approve the request in ${esc(name)} on your phone.`)}${on && link ? `<a class="btn" style="margin-top:0" href="${esc(link)}"${/^https:/i.test(link) ? ' target="_blank" rel="noopener"' : ''}>Open ${esc(name)}</a>` : ''}<p class="note">This closes once the wallet answers.</p>`;
      return () => o.close();
    },
  };
}

// A <dialog> as the place the sheets show in. Each sheet fills it and shows it; closing one puts the dialog away only while that sheet is the one in it.
export function dialogHost({ dialog, title, body }) {
  let use = 0;
  return (text, onClose) => {
    const mine = ++use;
    title.textContent = text; body.replaceChildren();
    dialog.addEventListener('close', () => { if (use === mine) onClose?.(); }, { once: true });
    if (!dialog.open) dialog.showModal();
    return { body, close: () => { if (use === mine && dialog.open) dialog.close(); } };
  };
}

// A <dialog> that brings its own look, for a page with none of its own (it takes the page's text and background colours). Its content is the same as any other host's.
const OVERLAY_CSS = `.wcx { width: min(460px, calc(100vw - 32px)); max-height: 90vh; padding: 22px 22px 26px; overflow: auto; color: CanvasText; background: Canvas; border: 1px solid currentColor; font: 14px/1.5 system-ui, sans-serif; }
.wcx::backdrop { background: rgba(0,0,0,.45); }
.wcx .wcx-head { display: flex; align-items: center; gap: 12px; margin: 0 0 14px; }
.wcx h2 { margin: 0; font-size: 22px; font-weight: 500; }
.wcx h2:focus { outline: none; }
.wcx .wcx-x { margin-left: auto; width: 40px; height: 40px; font-size: 22px; line-height: 1; color: inherit; background: none; border: 1px solid transparent; cursor: pointer; }
.wcx .lede-s, .wcx .note { margin: 0 0 12px; font-size: 13px; opacity: .75; }
.wcx .wc-qr { width: min(264px, 100%); margin: 6px auto 16px; padding: 14px; background: #fff; border: 1px solid #0003; }
.wcx .wc-qr svg { display: block; width: 100%; height: auto; }
.wcx .btn { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 48px; padding: 8px 14px; box-sizing: border-box; font: inherit; color: Canvas; background: CanvasText; border: 1px solid CanvasText; text-decoration: none; cursor: pointer; }
.wcx .btn.ghost { color: CanvasText; background: transparent; }
@media (max-width: 560px) { .wcx { width: 100vw; max-width: 100vw; margin: auto 0 0; max-height: 92vh; border-width: 1px 0 0; } }`;
export function overlayHost() {
  let open = null;
  return (text, onClose) => {
    if (!open) {
      const dialog = document.createElement('dialog');
      dialog.className = 'wcx';
      dialog.setAttribute('aria-labelledby', 'wcx-h');
      if (!document.getElementById('wcx-style')) document.head.append(Object.assign(document.createElement('style'), { id: 'wcx-style', textContent: OVERLAY_CSS }));
      dialog.innerHTML = `<div class="wcx-head"><h2 id="wcx-h" tabindex="-1"></h2><button class="wcx-x" type="button" aria-label="Close">×</button></div><div class="wcx-body"></div>`;
      const title = dialog.querySelector('h2'), body = dialog.querySelector('.wcx-body');
      dialog.querySelector('.wcx-x').onclick = () => dialog.close();
      dialog.addEventListener('mousedown', (e) => { if (e.target === dialog) dialog.close(); });
      document.body.append(dialog);
      open = dialogHost({ dialog, title, body });
    }
    return open(text, onClose);
  };
}
