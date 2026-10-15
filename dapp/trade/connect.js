// The browser wallet on a trade page: the header chip, the picker, WalletConnect's pairing sheets, and the account sheet with Disconnect. The page
// says what to show in the account sheet and what to do when the account changes; the wallet itself (sending, signing, receipts) is wallet.js.
import { announceWalletConnect } from '/walletconnect.js?cb=31f53606';
import { makeWallet, UserStopped } from '/trade/wallet.js?cb=a6b2910e';
import { overlay, esc } from '/trade/sheet.js?cb=84cda8f2';
import { rpc, RPCS, short, $ } from '/trade/util.js?cb=dd68ca48';

// WalletConnect joins the browser wallets in the picker, and is the one wallet offered where the browser has none (a phone): a wallet app signs
// and sends for this page. The project is zSwap's, shared: an allowlist set on it must name tacit.finance too.
const WC_PROJECT_ID = '1e8390ef1c1d8a185e035912a1409749';
const coarse = () => matchMedia('(pointer: coarse)').matches;

export { UserStopped };

// `describe`: what the page is, for the wallet app. `rows()`: extra lines for the account sheet (html). `busy()`: an action in progress, which
// keeps the account from being left. `say(text)`: a notice on the page. `onChange()`: the account or network changed.
export function makeConnect({ describe, rows = () => '', busy = () => false, say = () => {}, onChange = () => {} }) {
  function showPairing({ uri, qrSvg, cancel }) {
    let over = false;
    const o = overlay({ title: 'Connect a wallet app', top: true, onClose: () => { if (!over) cancel(); } });
    o.body.innerHTML = `<p style="margin:0 0 12px">${coarse() ? 'Open your wallet app to connect, or scan the code from another device.' : 'Scan the code with a wallet app on your phone: MetaMask, Rainbow, Trust, Zerion or any WalletConnect wallet.'}</p><div class="wc-qr">${qrSvg}</div><div class="bsheet-actions">${coarse() ? `<a class="btn" href="${esc(uri)}">Open wallet app</a>` : ''}<button class="btn ghost" type="button" data-copy>Copy link</button></div><p class="note">This waits until the wallet app approves. Connecting costs nothing.</p>`;
    o.body.querySelector('[data-copy]').onclick = (e) => navigator.clipboard?.writeText(uri).then(() => { e.target.textContent = 'Copied'; }, () => { e.target.textContent = 'Could not copy'; });
    return () => { over = true; o.close(); };
  }
  // A request waiting in the wallet app, where it is approved: on a phone a button opens the app (a browser follows that link only from a tap).
  function showAsk({ name, link }) {
    const o = overlay({ title: 'Approve in your wallet', top: true });
    o.body.innerHTML = `<p style="margin:0 0 12px">${coarse() ? `Open ${esc(name)} to approve the request, then come back here.` : `Approve the request in ${esc(name)} on your phone.`}</p>${coarse() && link ? `<div class="bsheet-actions"><a class="btn" href="${esc(link)}"${/^https:/i.test(link) ? ' target="_blank" rel="noopener"' : ''}>Open ${esc(name)}</a></div>` : ''}<p class="note">This closes once the wallet answers.</p>`;
    return () => o.close();
  }
  const WC = announceWalletConnect({
    projectId: WC_PROJECT_ID, chains: [1], rpcMap: { 1: RPCS[0] },
    metadata: { name: 'tacit trade', description: describe, url: location.origin, icons: [`${location.origin}/tac-logo.png`] },
    onPair: showPairing, onAsk: showAsk,
  });
  const wallet = makeWallet({ rpc, leave: (p) => (p?.isWalletConnect ? WC.disconnect() : null) });
  const W = wallet.state;

  function pickWallet(list) {
    return new Promise((resolve) => {
      const o = overlay({ title: 'Choose a wallet', top: true, onClose: () => resolve(null) });
      o.body.innerHTML = `<div class="picker">${list.map((w, i) => `<button class="way" type="button" data-i="${i}"><span class="way-t">${/^data:image\//.test(w.info?.icon || '') ? `<img src="${esc(w.info.icon)}" alt="" width="20" height="20">` : ''}${esc(w.info?.name || 'Wallet')}</span></button>`).join('')}</div>`;
      o.body.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { resolve(Number(b.dataset.i)); o.close(); }; });
    });
  }
  // Several wallets (or one and WalletConnect): the person chooses. One: it connects at once. → true once connected.
  async function connect() {
    const list = wallet.available();
    if (!list.length) { say('No wallet was found in this browser. Open this page in a wallet app\'s browser, or use tacit.finance.'); return false; }
    try {
      let w = list[0];
      if (list.length > 1) { const i = await pickWallet(list); if (i == null) return false; w = list[i]; }
      await wallet.connect(w);                                                    // connecting reaches the page through onChange, as any account change does
      return true;
    } catch (e) { say(esc(e instanceof UserStopped ? 'Not connected.' : (e.message || 'The wallet did not connect.')), true); return false; }
  }
  function renderChip() {
    const on = !!W.account, wrong = on && W.chain && W.chain !== '0x1';                  // a transaction switches the wallet to Ethereum itself; the chip says so first
    $('#wallet-dot').classList.toggle('on', on && !wrong); $('#wallet-dot').classList.toggle('warn', !!wrong);
    $('#wallet-label').textContent = on ? short(W.account, 4) : 'Connect';
    $('#wallet-chip').setAttribute('aria-label', on ? `Wallet ${W.account}${wrong ? ', on another network' : ''}` : 'Connect a wallet');
    $('#wallet-chip').title = wrong ? 'Your wallet is on another network. It is asked to switch to Ethereum when you send.' : '';
  }
  function accountSheet() {
    const o = overlay({ title: 'Wallet', top: true });
    const wrong = W.chain && W.chain !== '0x1', stop = busy();
    o.body.innerHTML = `<div class="kv"><span>Connected with</span><b>${esc(W.name)}</b></div><div class="kv"><span>Account</span><b class="addr-s">${esc(W.account)}</b></div>${wrong ? '<div class="kv"><span>Network</span><b>Not Ethereum <button class="linkbtn" type="button" data-switch>Switch</button></b></div>' : ''}${rows()}<div class="bsheet-actions" style="margin-top:14px"><button class="btn ghost" type="button" data-copy>Copy address</button><button class="btn" type="button" data-leave${stop ? ' disabled' : ''}>Disconnect</button></div>${stop ? '<p class="note">Something is in progress; disconnect when it ends.</p>' : ''}`;
    const addr = W.account;
    o.body.querySelector('[data-switch]')?.addEventListener('click', (e) => { e.target.disabled = true; wallet.ensureMainnet().then(() => { o.close(); renderChip(); }, () => { e.target.disabled = false; }); });
    o.body.querySelector('[data-copy]').onclick = (e) => navigator.clipboard?.writeText(addr).then(() => { e.target.textContent = 'Copied'; }, () => { e.target.textContent = 'Could not copy'; });
    o.body.querySelector('[data-leave]').onclick = async () => { o.close(); await wallet.disconnect(); };       // the wallet's own change event redraws the chip and tells the page
  }
  $('#wallet-chip').addEventListener('click', () => { if (W.account) accountSheet(); else connect(); });
  wallet.onChange(() => { renderChip(); onChange(); });
  wallet.restore().catch(() => {});                                                 // the wallet connected last time, back without a prompt when it still allows this site
  renderChip();
  return { wallet, W, connect, renderChip };
}
