// Trading TAC on Bitcoin from the trade page: the market page's own module (btc-market.js: the order book, the ticket, your orders) with the
// executors and the book's data from tacit.js, mounted in a sheet. The module plans and tacit.js settles; this file supplies what the classic
// app supplies around them and a page like this one does not have: signing in, a confirmation, a notice, the sats and TAC the key holds,
// and where a purchase that stopped halfway is recovered. Nothing here builds or signs a transaction.
import { makeBtcSession, short, Cancelled } from '/trade/btc-session.js?cb=3463a86d';

const MARKET_URL = '/btc-market.js?cb=e07ed7ab', CSS_URL = '/trade/btc-market.css?cb=359753e6';
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A sheet over the page. The market module's own confirmations are fixed layers at z-index 1005, so this one sits below them and the small
// dialogs (sign-in, picker, confirm) above them.
function overlay({ title, wide = false, top = false, onClose = null }) {
  const root = document.createElement('div');
  root.className = `bsheet${wide ? ' wide' : ''}${top ? ' top' : ''}`;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', title);
  root.innerHTML = `<div class="bsheet-in"><div class="bsheet-head"><h2 tabindex="-1">${esc(title)}</h2><button class="x" type="button" aria-label="Close">×</button></div><div class="bsheet-body"></div></div>`;
  document.body.append(root);
  const prev = document.activeElement, body = root.querySelector('.bsheet-body');
  let closed = false;
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.bm-modal') && !root.nextElementSibling?.classList.contains('bsheet')) { e.stopPropagation(); close(); } };
  const close = () => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey, true); root.remove(); try { prev?.focus?.(); } catch { /* the opener may be gone */ } onClose?.(); };
  document.addEventListener('keydown', onKey, true);
  root.querySelector('.x').onclick = close;
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  setTimeout(() => root.querySelector('h2')?.focus(), 0);
  return { root, body, close, get closed() { return closed; } };
}

export function makeBitcoin({ notify = () => {}, onTraded = () => {} } = {}) {
  const session = makeBtcSession();
  let main = null, host = null, ctl = null, meState = null, meTimer = 0, off = null;

  // ── signing in ──
  const via = (k) => ({ eth: `Ethereum ${short(k.address || '')}`, btc: `Bitcoin ${short(k.address || '', 6)}`, passkey: `passkey “${k.label || 'Tacit'}”` })[k?.mode] || 'your wallet';
  function pickWallet(list) {
    return new Promise((resolve) => {
      const o = overlay({ title: 'Choose a wallet', top: true, onClose: () => resolve(null) });
      o.body.innerHTML = `<div class="picker">${list.map((w) => `<button class="way" type="button" data-uuid="${esc(w.uuid)}"><span class="way-t">${/^data:image\//.test(w.icon || '') ? `<img src="${esc(w.icon)}" alt="" width="20" height="20">` : ''}${esc(w.name)}</span></button>`).join('')}</div>`;
      o.body.querySelectorAll('[data-uuid]').forEach((b) => { b.onclick = () => { resolve(b.dataset.uuid); o.close(); }; });
    });
  }
  function signIn() {
    return new Promise((resolve, reject) => {
      const known = session.known(), other = session.other();
      const o = overlay({ title: 'Open your Tacit wallet', top: true, onClose: () => { if (!session.unlocked) reject(new Cancelled()); } });
      const opt = (k, t, m, cls = '') => `<button class="way ${cls}" type="button" data-in="${k}"><span class="way-t">${t}</span><span class="way-m">${m}</span></button>`;
      const pk = session.passkeyAvailable(), hasBtc = session.btcSeen(), hasEth = session.ethAvailable();
      o.body.innerHTML = `<p class="note" style="margin-top:0">Buying and selling on Bitcoin signs with your Tacit wallet's key. This page never stores the key.</p><div class="ways">
        ${known ? opt('known', 'Continue with your Tacit wallet', `Opens with ${esc(via(known))}, the same key as on tacit.finance.`, 'main') : ''}
        ${other ? opt('other', 'Your other Tacit key', `A different key, opened here before with ${esc(via(other))}.`) : ''}
        ${opt('eth', 'Ethereum wallet', hasEth ? 'MetaMask, Rabby, Rainbow or any browser wallet. One signature, two the first time on this browser.' : 'MetaMask, Rabby, Rainbow or any browser wallet. None found in this browser.')}
        ${opt('btc', 'Bitcoin wallet', hasBtc ? 'Xverse, Leather or UniSat. One signature, two the first time.' : 'Xverse, Leather or UniSat. None found in this browser.')}
        ${pk ? opt('passkey', 'Passkey', 'Touch ID, Windows Hello or a security key.') : ''}
        <p class="ways-err" role="alert" hidden></p>
        ${pk ? '<p class="more"><button class="linkbtn" type="button" data-in="new">New passkey wallet</button></p>' : ''}
      </div>`;
      const err = o.body.querySelector('.ways-err');
      let busy = false;
      o.body.querySelectorAll('[data-in]').forEach((b) => { b.onclick = async () => {
        if (busy) return;
        busy = true; err.hidden = true; b.setAttribute('aria-busy', 'true'); o.body.querySelectorAll('[data-in]').forEach((x) => { x.disabled = true; });
        try {
          const k = b.dataset.in;
          if (k === 'known') await session.open[known.mode](known, pickWallet);
          else if (k === 'other') await session.open[other.mode](other, pickWallet);
          else if (k === 'new') await session.open.newPasskey();
          else await session.open[k](undefined, pickWallet);
          o.close(); resolve();
        } catch (e) {
          if (!/cancel/i.test(e?.message || '') && e?.name !== 'NotAllowedError' && !e?.unlockCancelled) { err.textContent = e?.message || 'That did not open a wallet.'; err.hidden = false; }
        } finally { busy = false; b.removeAttribute('aria-busy'); o.body.querySelectorAll('[data-in]').forEach((x) => { x.disabled = false; }); }
      }; });
    });
  }
  // The market module's unlock: a key already open is used as it is.
  // Two asks at once (a double click, or the module and a recovery) share one prompt.
  let signing = null;
  function unlock() {
    return (signing ||= (async () => {
      await session.load();
      if (session.unlocked) return;
      await signIn();
      await refreshMe();
    })().finally(() => { signing = null; }));
  }

  // ── what the module asks the page for ──
  function confirmDialog({ title = 'Confirm', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', hideCancel = false } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => { if (!answered) { answered = true; resolve(v); } };
      const o = overlay({ title, top: true, onClose: () => done(false) });
      o.body.innerHTML = `<p style="white-space:pre-line;margin:0 0 16px">${esc(body)}</p><div class="bsheet-actions">${hideCancel ? '' : `<button class="btn ghost" type="button" data-no>${esc(cancelLabel)}</button>`}<button class="btn" type="button" data-yes>${esc(confirmLabel)}</button></div>`;
      o.body.querySelector('[data-yes]').onclick = () => { done(true); o.close(); };
      o.body.querySelector('[data-no]')?.addEventListener('click', () => { done(false); o.close(); });
    });
  }
  function fundDialog() {
    const addr = session.address;
    const o = overlay({ title: 'Add sats', top: true });
    o.body.innerHTML = addr ? `<p style="margin:0 0 12px">Send sats to this Bitcoin address from any wallet. It is the address of the key you opened, and buying takes sats from it.</p><p class="addr"><code>${esc(addr)}</code></p><div class="bsheet-actions"><button class="btn" type="button" data-copy>Copy address</button></div>` : '<p style="margin:0">Open your wallet first: the address is the one of the key you open.</p>';
    const c = o.body.querySelector('[data-copy]');
    if (c) c.onclick = () => navigator.clipboard?.writeText(addr).then(() => { c.textContent = 'Copied'; }, () => { c.textContent = 'Could not copy'; });
  }
  // A purchase that stopped after its commit went out holds sats until they are swept back; the record that sweeps them is in this browser.
  async function recovery(err) {
    const msg = err?.message || String(err || '');
    if (!/Commit tx broadcast|locked at|recovery record/.test(msg)) return;
    const m = /locked at ([0-9a-f]{64}):0/i.exec(msg);
    if (!m) { notify('The purchase stopped after its commit went out. The sats it holds can be recovered in the classic app, under Holdings.', 'error', 12000); return; }
    const v = /(?:Commit tx broadcast — |locked\s+)(\d+)\s*sats/i.exec(msg), sats = v ? Number(v[1]) : 0;
    const yes = await confirmDialog({
      title: 'Purchase stopped · sats recoverable',
      body: `Your commit broadcast on Bitcoin, but the settlement never landed. The ${sats.toLocaleString('en-US')} sats it holds are not lost: one Bitcoin transaction (with a small fee) sweeps them back to your wallet.\n\nIf you leave it, it stays in the classic app under Holdings, where you can recover it later.`,
      confirmLabel: `Recover ${sats.toLocaleString('en-US')} sats now`, cancelLabel: 'Later',
    });
    if (!yes) return;
    try {
      if (!session.unlocked) await unlock();                                                // tacit.js would otherwise open the classic app's own wallet prompt
      const r = await session.T.recoverPreauthCommit(m[1].toLowerCase());
      notify(`Recovered ${Number(r.recovered_sats).toLocaleString('en-US')} sats (sweep fee ${r.fee_sats} sats).`, 'success', 9000);
      await refreshMe(); ctl?.refresh?.({ soft: true });
    } catch (e) { notify(`Could not recover them yet: ${e?.message || e}. They stay recoverable in the classic app under Holdings.`, 'error', 12000); }
  }

  // The sats at the key's address and the TAC it holds, which the module reads synchronously through ctx.me().
  async function refreshMe() {
    if (!session.unlocked) { meState = null; return; }
    const T = session.T, my = session.key;
    const [utxos, holdings] = await Promise.all([T.getUtxos(T.wallet.address()).catch(() => null), T.scanHoldings().catch(() => null)]);
    if (session.key !== my) return;                                                        // the key changed while this was read
    const h = holdings instanceof Map ? holdings.get(TAC) : null;
    meState = {
      pubHex: my.pubHex, h160: T.bytesToHex(T.hash160(T.wallet.pub)), unlocked: true,
      sats: Array.isArray(utxos) ? utxos.reduce((a, u) => a + Number(u.value || 0), 0) : null,
      assetBase: h && typeof h.balance === 'bigint' ? h.balance : (holdings ? 0n : null),
    };
  }

  // The asset's ticker and decimals come with the market data, and the module reads them once when it mounts, so the data is loaded first.
  async function buildCtx() {
    const T = session.T;
    if (typeof T._btcMarketCtx !== 'function') throw new Error('the wallet library served to this browser is older than the page: reload in a minute');
    await T._btcMarketCtx(TAC).loadListings();
    const base = T._btcMarketCtx(TAC);
    if (!base.asset()?.ticker || base.asset().ticker === '?') throw new Error('the market data did not load');
    const logo = (h) => (typeof h === 'string' ? h.replace('src="tac-logo.png"', 'src="/tac-logo.png"') : h);      // tacit.js names the logo relative to the classic app's address
    const settled = (fn) => async (...a) => { try { await fn?.(...a); } finally { try { await refreshMe(); ctl?.refresh?.({ soft: true }); } catch { /* the next refresh reads it */ } onTraded(); } };
    return {
      ...base,
      mountEth: null, initialLane: 'btc', onLane: null,
      asset: () => { const a = base.asset(); return { ...a, iconHtml: logo(a.iconHtml), identityHtml: logo(a.identityHtml) }; },
      me: () => meState,
      unlock, fundSats: fundDialog,
      confirm: confirmDialog,
      toast: (m, k, ms) => notify(m, k, ms),
      onError: (e) => { recovery(e).catch(() => {}); },
      goBack: () => main?.close(),
      onAct: () => {},
      after: { bought: settled(base.after.bought), sold: settled(base.after.sold), listed: settled(base.after.listed) },
    };
  }

  // ── the sheet ──
  // Which key is open, with a way to lock it, beside the close button.
  function paintHead() {
    const head = main?.root.querySelector('.bsheet-head');
    if (!head) return;
    let who = head.querySelector('.who');
    if (!who) { who = document.createElement('span'); who.className = 'who'; head.insertBefore(who, head.querySelector('.x')); }
    who.innerHTML = session.unlocked ? `<span class="mute" title="The Bitcoin address of the key you opened">${esc(short(session.address, 6))}</span><button class="linkbtn" type="button" data-lock>Lock</button>` : '';
    who.querySelector('[data-lock]')?.addEventListener('click', () => { session.lock(); meState = null; ctl?.refresh?.({ soft: true }); });
  }
  let cssP = null;
  const ensureCss = () => (cssP ||= new Promise((res) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = CSS_URL;
    l.onload = l.onerror = () => res(); document.head.append(l);
  }));
  function destroy() { try { ctl?.destroy?.(); } catch { /* it is going away */ } ctl = null; host = null; main = null; clearInterval(meTimer); off?.(); off = null; }
  // `prime` sets the ticket once the book has loaded: { side, type, receiveBase, sellBase, spendSats }. A sheet that was closed while it loaded
  // (and maybe opened again) is not mounted into: each step checks that it is still the current one.
  async function open(prime = null) {
    if (main) { if (prime) await primeWhenReady(prime); return; }
    const mine = overlay({ title: 'TAC on Bitcoin', wide: true, onClose: () => { if (main === mine) destroy(); } });
    main = mine;
    const box = document.createElement('div'); box.className = 'bm-skin'; box.innerHTML = '<p class="note">Loading the Bitcoin market…</p>';
    mine.body.append(box); host = box;
    try {
      await Promise.all([session.load(), ensureCss()]);
      const market = await import(MARKET_URL);
      if (main !== mine) return;
      await refreshMe();
      const ctx = await buildCtx();
      if (main !== mine) return;
      box.replaceChildren();
      ctl = market.mountBtcMarket(box, ctx);
      meTimer = setInterval(() => { if (!document.hidden && session.unlocked) refreshMe().then(() => ctl?.refresh?.({ soft: true })).catch(() => {}); }, 45e3);
      off = session.onChange(() => { paintHead(); refreshMe().then(() => ctl?.refresh?.({ soft: true })).catch(() => {}); });
      box.insertAdjacentHTML('beforeend', '<p class="note bm-after">TAC held on Ethereum is bridged to Bitcoin before it can be sold here. <a href="/#bridge">Bridge →</a></p>');
      paintHead();
      if (prime) await primeWhenReady(prime);
    } catch (e) {
      if (main === mine) box.innerHTML = `<p class="err">The Bitcoin market could not be loaded just now: ${esc(e?.message || e)}</p>`;
    }
  }
  async function primeWhenReady(opts) {
    for (let i = 0; i < 80; i++) {
      if (!ctl) return;
      if (ctl.state?.loadedOnce) { ctl.prime(opts); return; }
      await sleep(150);
    }
  }
  return { open, session, recovery, get isOpen() { return !!main; } };
}
