// The browser wallet on a trade page: the header chip, the picker, WalletConnect's pairing sheets, and the account sheet with Disconnect. The page
// says what to show in the account sheet and what to do when the account changes; the wallet itself (sending, signing, receipts) is wallet.js.
import { announceWalletConnect, wcSheets, WC_PROJECT_ID } from '/walletconnect.js?cb=92886522';
import { makeWallet, UserStopped } from '/trade/wallet.js?cb=595c892a';
import { overlay, esc } from '/trade/sheet.js?cb=84cda8f2';
import { rpc, RPCS, short, $ } from '/trade/util.js?cb=c3dc39b3';

// WalletConnect joins the browser wallets in the picker, and is the one wallet offered where the browser has none (a phone): a wallet app signs
// and sends for this page.

export { UserStopped };

// `describe`: what the page is, for the wallet app. `rows()`: extra lines for the account sheet (html), `rewards: false` for the page that is itself the airdrop and points page (every other page's sheet links to it), and `wire(root, close)` the handlers of
// whatever they hold. `busy()`: an action in progress, which keeps the account from being left. `leave(account)`: called as the account is left.
// `say(text)`: a notice on the page. `onChange()`: the account or network changed. A page that is not ready to hear of a restored wallet
// at once passes `restore: false` and calls `restore()` when it is.
export function makeConnect({ describe, rows = () => '', wire = () => {}, leave = () => {}, busy = () => false, say = () => {}, onChange = () => {}, restore = true, rewards = true }) {
  const sheets = wcSheets((title, onClose) => overlay({ title, top: true, onClose }));
  const WC = announceWalletConnect({
    projectId: WC_PROJECT_ID, chains: [1], rpcMap: { 1: RPCS[0] },
    metadata: { name: 'tacit trade', description: describe, url: location.origin, icons: [`${location.origin}/tac-logo.png`] },
    onPair: sheets.onPair, onAsk: sheets.onAsk,
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
    const wrong = W.chain && W.chain !== '0x1', stop = busy(), app = W.prov?.peerName?.();
    o.body.innerHTML = `<div class="kv"><span>Connected with</span><b>${esc(W.name)}${app ? ` · ${esc(app)}` : ''}</b></div><div class="kv"><span>Account</span><b class="addr-s">${esc(W.account)}</b></div>${wrong ? '<div class="kv"><span>Network</span><b>Not Ethereum <button class="linkbtn" type="button" data-switch>Switch</button></b></div>' : ''}${rows()}${rewards ? `<a class="btn ghost" href="/rewards/?q=${esc(W.account)}">Airdrop and points</a>` : ''}<div class="bsheet-actions" style="margin-top:14px"><button class="btn ghost" type="button" data-copy>Copy address</button><button class="btn" type="button" data-leave${stop ? ' disabled' : ''}>Disconnect</button></div>${stop ? '<p class="note">Something is in progress; disconnect when it ends.</p>' : ''}`;
    const addr = W.account;
    o.body.querySelector('[data-switch]')?.addEventListener('click', (e) => { e.target.disabled = true; wallet.ensureMainnet().then(() => { o.close(); renderChip(); }, () => { e.target.disabled = false; }); });
    o.body.querySelector('[data-copy]').onclick = (e) => navigator.clipboard?.writeText(addr).then(() => { e.target.textContent = 'Copied'; }, () => { e.target.textContent = 'Could not copy'; });
    wire(o.body, o.close);
    o.body.querySelector('[data-leave]').onclick = async () => { o.close(); await leave(addr); await wallet.disconnect(); };       // the wallet's own change event redraws the chip and tells the page
  }
  $('#wallet-chip').addEventListener('click', () => { if (W.account) accountSheet(); else connect(); });
  wallet.onChange(() => { renderChip(); onChange(); });
  const restoreLast = () => wallet.restore().catch(() => {});                       // the wallet connected last time, back without a prompt when it still allows this site
  if (restore) restoreLast();
  renderChip();
  return { wallet, W, connect, renderChip, restore: restoreLast };
}
