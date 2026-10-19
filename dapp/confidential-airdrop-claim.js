
import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { confidentialPoolReady, activeNetwork, esc, formatErr, notify } from './confidential-deployments.js';
import { checksumAddress } from './confidential-payout.js';

export const BANNER_ID = 'tac-airdrop-claim-banner';
const TAB_BODY_ID = 'airdrop-body';
const DISMISS_PREFIX = 'tacit-tac-airdrop-dismissed:';
const CLAIM_WAIT_TIMEOUT_MS = 120000;
const CLAIM_WAIT_INTERVAL_MS = 4000;

const lc = (s) => String(s == null ? '' : s).toLowerCase();

function shortStr(s, n = 6) {
  const x = String(s || '');
  return x.length > n * 2 + 3 ? `${x.slice(0, n + 2)}…${x.slice(-n)}` : x;
}
function checksummedOrShort(address) {
  try { return shortStr(checksumAddress(address, keccak_256)); } catch { return shortStr(address); }
}
function fmtDate(iso) {
  if (!iso) return 'unknown';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return iso; }
}
function fmtLeft(seconds) {
  const s = Number(seconds || 0);
  if (s <= 0) return 'closed';
  const days = Math.floor(s / 86400);
  if (days >= 2) return `${days} days left`;
  const hours = Math.floor(s / 3600);
  if (hours >= 2) return `${hours} hours left`;
  return 'closing soon';
}
function quietNote(status) {
  if (status.reason === 'paused') return 'claims are temporarily paused by the airdrop guardian';
  if (status.reason === 'unfunded') return 'the airdrop contract is temporarily short of funds for this claim';
  return null;
}

function defaultStorage() {
  try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch { return null; }
}
function isDismissed(storage, key) {
  try { return !!storage && storage.getItem(DISMISS_PREFIX + key) === '1'; }
  catch { return false; }
}
function setDismissed(storage, key) {
  try { if (storage) storage.setItem(DISMISS_PREFIX + key, '1'); } catch {}
}

export function makeAirdropState() {
  let address = null;
  let inflight = false;
  let lastResult = null;
  const statusCache = new Map();
  const inFlightFetch = new Map();
  const listeners = new Set();
  const notify_ = () => { for (const fn of [...listeners]) { try { fn(); } catch {} } };

  const self = {
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get address() { return address; },
    get status() { return address ? statusCache.get(address) || null : null; },
    get checking() { return address ? inFlightFetch.has(address) : false; },
    get inflight() { return inflight; },
    get lastResult() { return lastResult; },
    setInflight(v) { inflight = !!v; notify_(); },
    setLastResult(r) { lastResult = r; notify_(); },
    resetStatusCache() { statusCache.clear(); inFlightFetch.clear(); notify_(); },
    async setAddress(addr, air) {
      const next = addr ? lc(addr) : null;
      if (next === address) { if (next) await self.refresh(air); return; }
      address = next;
      lastResult = null;
      notify_();
      if (next) await self.refresh(air);
    },
    async refresh(air, { force = false } = {}) {
      if (!address) return null;
      const key = address;
      if (!force) {
        if (statusCache.has(key)) return statusCache.get(key);
        if (inFlightFetch.has(key)) return inFlightFetch.get(key);
      }
      notify_();
      const p = (async () => {
        try { return await air.status(key); }
        catch (e) {
          const message = (e && e.message) || String(e);
          console.error('tac-airdrop status', e);
          return { address: key, eligible: false, claimable: false, reason: 'error', message, error: { code: 'error', message } };
        }
      })();
      inFlightFetch.set(key, p);
      const st = await p;
      if (inFlightFetch.get(key) === p) {
        inFlightFetch.delete(key);
        if (address === key) { statusCache.set(key, st); notify_(); }
      }
      return st;
    },
  };
  return self;
}

let _sharedState = null;
function sharedState() { return _sharedState || (_sharedState = makeAirdropState()); }

let _ux = null, _uxNet = null;
function getUx() {
  const net = activeNetwork();
  if (!_ux || _uxNet !== net) {
    const hadPrior = _uxNet !== null;
    _ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: net });
    _uxNet = net;
    if (hadPrior) {
      const st = sharedState();
      st.resetStatusCache();
      if (st.address) st.refresh(_ux.tacAirdrop, { force: true }).catch(() => {});
    }
  }
  return _ux;
}
function safeUx() {
  if (!confidentialPoolReady()) return null;
  try { return getUx(); } catch (e) { console.error('confidential pool ux', e); return null; }
}

async function detectSilentAddress() {
  try {
    const provider = (typeof window !== 'undefined') ? window.ethereum : null;
    if (!provider || typeof provider.request !== 'function') return null;
    const accounts = await provider.request({ method: 'eth_accounts' });
    return (Array.isArray(accounts) && accounts[0]) ? lc(accounts[0]) : null;
  } catch { return null; }
}
let _latestAccountsChangedHandler = null;
function bindAccountsChanged(onChange) {
  _latestAccountsChangedHandler = onChange;
  try {
    const provider = (typeof window !== 'undefined') ? window.ethereum : null;
    if (!provider || typeof provider.on !== 'function' || provider._tacitAirdropClaimBound) return;
    provider._tacitAirdropClaimBound = true;
    provider.on('accountsChanged', (accounts) => {
      const addr = (Array.isArray(accounts) && accounts[0]) ? lc(accounts[0]) : null;
      if (_latestAccountsChangedHandler) _latestAccountsChangedHandler(addr);
    });
  } catch {}
}

function explainSendError(e) {
  const msg = (e && e.message) || String(e);
  if (/switch your wallet to ethereum mainnet/i.test(msg)) return 'Switch your wallet to Ethereum mainnet to send this claim.';
  return msg;
}

function makeSend(eth) {
  return async ({ from, to, data }) => {
    if (!eth || typeof eth.sendTx !== 'function') throw new Error('No Ethereum wallet is connected.');
    try { return await eth.sendTx({ from, to, data }); }
    catch (e) { throw new Error(explainSendError(e)); }
  };
}

async function estimateGas(ux, tx) {
  try {
    const raw = await ux.rpc('eth_estimateGas', [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value || '0x0' }]);
    return BigInt(raw);
  } catch { return null; }
}

async function runClaim({ air, state, eth }, { say, toast = notify } = {}) {
  const address = state.address;
  state.setInflight(true);
  try {
    say('Checking the claim would go through…');
    const r = await air.claim(address, { send: makeSend(eth), from: address });
    say('Sent — waiting for it to confirm on-chain…');
    toast('TAC claim sent — waiting for confirmation', '');
    const w = await air.waitClaimed(address, { timeoutMs: CLAIM_WAIT_TIMEOUT_MS, intervalMs: CLAIM_WAIT_INTERVAL_MS });
    state.setLastResult({ action: 'claim', txHash: r.txHash, confirmed: !!w.claimed });
    say(w.claimed ? 'Claimed.' : `Sent (${shortStr(r.txHash)}) — not yet confirmed on-chain. Refresh to check.`);
    if (w.claimed) toast('TAC claim confirmed on-chain', 'ok');
    await state.refresh(air, { force: true });
  } catch (e) {
    const m = formatErr(e, 'Claim');
    say(m); toast(m, 'error');
    await state.refresh(air, { force: true }).catch(() => {});
  } finally {
    state.setInflight(false);
  }
}

async function runClaimTo({ air, state, eth }, to, { say, toast = notify } = {}) {
  const address = state.address;
  state.setInflight(true);
  try {
    say('Checking the claim would go through…');
    const r = await air.claimTo(address, to, { send: makeSend(eth) });
    say('Sent — waiting for it to confirm on-chain…');
    toast('TAC claim sent — waiting for confirmation', '');
    const w = await air.waitClaimed(address, { timeoutMs: CLAIM_WAIT_TIMEOUT_MS, intervalMs: CLAIM_WAIT_INTERVAL_MS });
    state.setLastResult({ action: 'claimTo', to: lc(to), txHash: r.txHash, confirmed: !!w.claimed });
    say(w.claimed ? `Claimed — sent to ${checksummedOrShort(to)}.` : `Sent (${shortStr(r.txHash)}) — not yet confirmed on-chain. Refresh to check.`);
    if (w.claimed) toast('TAC claim confirmed on-chain', 'ok');
    await state.refresh(air, { force: true });
  } catch (e) {
    const m = formatErr(e, 'Claim');
    say(m); toast(m, 'error');
    await state.refresh(air, { force: true }).catch(() => {});
  } finally {
    state.setInflight(false);
  }
}

async function runConnect({ air, state, eth }, { say, toast = notify, button } = {}) {
  if (button) { if (button.disabled) return; button.disabled = true; }
  const orig = button ? button.textContent : null;
  if (button) button.textContent = 'connecting…';
  try {
    if (!eth || typeof eth.connect !== 'function') throw new Error('No Ethereum wallet connector is available.');
    say('Connecting your Ethereum wallet…');
    const { address } = await eth.connect();
    await state.setAddress(address, air);
    say('');
  } catch (e) {
    const m = formatErr(e, 'Connect');
    say(m); toast(m, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = orig; }
  }
}

function defaultGoToTab() {
  if (typeof document === 'undefined') return;
  const tabBtn = document.querySelector('.tab[data-tab="airdrop"]');
  if (tabBtn) tabBtn.click();
}

export function bannerTemplateHtml() {
  return `<button type="button" class="tacit-warn-banner__close" id="tac-airdrop-banner-close" aria-label="Dismiss" title="Dismiss">×</button>`
    + `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:space-between;">`
    + `<span id="tac-airdrop-banner-headline"></span>`
    + `<span style="display:flex;gap:6px;flex-wrap:wrap;">`
    + `<button type="button" id="tac-airdrop-banner-connect" class="btn-go" style="font-size:11px;padding:3px 10px;display:none;">Connect wallet</button>`
    + `<button type="button" id="tac-airdrop-banner-claim" class="btn-go" style="font-size:11px;padding:3px 10px;display:none;">Claim</button>`
    + `<button type="button" id="tac-airdrop-banner-claimto-toggle" style="font-size:11px;padding:3px 10px;display:none;">Claim to…</button>`
    + `<a href="#" id="tac-airdrop-banner-view" style="display:none;">View details →</a>`
    + `</span>`
    + `</div>`
    + `<div id="tac-airdrop-banner-claimto-row" style="display:none;margin-top:8px;">`
    + `<input type="text" id="tac-airdrop-banner-claimto-addr" placeholder="0x… recipient address" style="font-size:11px;padding:3px 6px;width:220px;max-width:100%;">`
    + ` <button type="button" id="tac-airdrop-banner-claimto-go" style="font-size:11px;padding:3px 10px;">Send to this address</button>`
    + `</div>`
    + `<div id="tac-airdrop-banner-status" class="muted" style="margin-top:4px;font-size:10px;"></div>`;
}

function ensureBannerTemplate(container) {
  if (container._airdropBuilt) return;
  container._airdropBuilt = true;
  container.innerHTML = bannerTemplateHtml();
}

function bannerParts(el) {
  return {
    close: el('tac-airdrop-banner-close'), headline: el('tac-airdrop-banner-headline'),
    connect: el('tac-airdrop-banner-connect'), claim: el('tac-airdrop-banner-claim'),
    claimtoToggle: el('tac-airdrop-banner-claimto-toggle'), view: el('tac-airdrop-banner-view'),
    claimtoRow: el('tac-airdrop-banner-claimto-row'), claimtoAddr: el('tac-airdrop-banner-claimto-addr'),
    claimtoGo: el('tac-airdrop-banner-claimto-go'), status: el('tac-airdrop-banner-status'),
  };
}

const show = (node, on) => { if (node) node.style.display = on ? '' : 'none'; };

function paintBanner(container, ctx, el) {
  const p = bannerParts(el);
  const { state, air, storage } = ctx;
  const { address, status, checking, inflight, lastResult } = state;

  const hide = () => { container.style.display = 'none'; container.removeAttribute('data-tone'); };

  if (!address) {
    if (!air.config.deployed || isDismissed(storage, 'invite')) return hide();
    container.className = 'tacit-warn-banner tacit-warn-banner--warn';
    container.dataset.tone = 'invite';
    container.style.display = '';
    show(p.close, true);
    if (p.headline) p.headline.innerHTML = `<strong>The TAC (EVM) airdrop is live.</strong> Connect your wallet to check if you're eligible.`;
    show(p.connect, true); show(p.claim, false); show(p.claimtoToggle, false); show(p.view, false); show(p.claimtoRow, false);
    return;
  }

  const key = lc(address);
  if (isDismissed(storage, key)) return hide();

  if (checking && !status) {
    container.className = 'tacit-warn-banner tacit-warn-banner--warn';
    container.removeAttribute('data-tone');
    container.style.display = '';
    show(p.close, false);
    if (p.headline) p.headline.textContent = `Checking the TAC airdrop for ${checksummedOrShort(address)}…`;
    show(p.connect, false); show(p.claim, false); show(p.claimtoToggle, false); show(p.view, false); show(p.claimtoRow, false);
    return;
  }
  if (!status || status.error) return hide();
  if (!status.eligible) return hide();
  if (status.reason === 'claimed' || status.reason === 'closed') return hide();

  const note = quietNote(status);
  if (note) {
    container.className = 'tacit-warn-banner tacit-warn-banner--warn';
    container.dataset.tone = key;
    container.style.display = '';
    show(p.close, true);
    if (p.headline) p.headline.innerHTML = `<strong>TAC airdrop</strong> — you have ${esc(status.amountTac)} TAC allocated, but ${esc(note)}. Check back soon.`;
    show(p.connect, false); show(p.claim, false); show(p.claimtoToggle, false); show(p.view, false); show(p.claimtoRow, false);
    return;
  }

  if (lastResult && lastResult.confirmed) return hide();

  container.className = 'tacit-warn-banner tacit-warn-banner--green';
  container.dataset.tone = key;
  container.style.display = '';
  show(p.close, true);
  if (p.headline) p.headline.innerHTML = `<strong>You can claim ${esc(status.amountTac)} TAC.</strong> Claim by ${esc(fmtDate(status.claimByISO))} (${esc(fmtLeft(status.secondsLeft))}).`;
  show(p.connect, false); show(p.claim, true); show(p.claimtoToggle, true); show(p.view, true);
  if (p.claim) p.claim.disabled = inflight;
  if (p.claimtoToggle) p.claimtoToggle.disabled = inflight;
  if (p.claimtoGo) p.claimtoGo.disabled = inflight;
}

function wireBannerButtons(container, ctx, el, goToTab) {
  const p = bannerParts(el);
  const say = (t) => { if (p.status) p.status.textContent = t; };
  if (p.close) p.close.onclick = () => {
    const key = container.dataset.tone;
    if (key) setDismissed(ctx.storage, key);
    paintBanner(container, ctx, el);
  };
  if (p.view) p.view.onclick = (e) => { if (e && e.preventDefault) e.preventDefault(); goToTab(); };
  if (p.connect) p.connect.onclick = () => runConnect(ctx, { say, button: p.connect });
  if (p.claimtoToggle) p.claimtoToggle.onclick = () => { if (p.claimtoRow) show(p.claimtoRow, p.claimtoRow.style.display === 'none'); };
  if (p.claim) p.claim.onclick = () => runClaim(ctx, { say });
  if (p.claimtoGo) p.claimtoGo.onclick = () => {
    const to = p.claimtoAddr ? String(p.claimtoAddr.value || '').trim() : '';
    if (!to) { say('Enter a recipient address.'); return; }
    return runClaimTo(ctx, to, { say });
  };
}

export function wireAirdropAnnouncement({ ux, eth, state = sharedState(), el = (id) => document.getElementById(id), goToTab = defaultGoToTab, storage = defaultStorage(), autoDetect = true } = {}) {
  const container = el(BANNER_ID);
  if (!container || !ux || !ux.tacAirdrop) return;
  const air = ux.tacAirdrop;
  const ctx = { air, ux, eth, state, storage };
  ensureBannerTemplate(container);
  wireBannerButtons(container, ctx, el, goToTab);
  if (container._airdropUnsub) container._airdropUnsub();
  const repaint = () => paintBanner(container, ctx, el);
  container._airdropUnsub = state.onChange(repaint);
  repaint();
  if (autoDetect && !state.address) {
    detectSilentAddress().then((addr) => { if (addr) state.setAddress(addr, air); });
  }
  bindAccountsChanged((addr) => state.setAddress(addr, air));
}

export function mountAirdropAnnouncement(helpers = {}) {
  try {
    const ux = safeUx();
    if (!ux) return;
    wireAirdropAnnouncement({ ux, eth: helpers.eth });
  } catch (e) { console.error('airdrop banner', e); }
}

const INTRO_HTML = `<div class="note-concept"><b>One-time TAC (EVM) distribution.</b> A merkle airdrop to every address that`
  + ` held one of seven tokens at snapshot, one claim per address. Claim it to your address, send it on, or wrap it`
  + ` into the shielded pool yourself afterward.</div>`
  + `<dl class="kv" style="margin:14px 0;">`
  + `<dt>Distributing</dt><dd>999,999 TAC <span class="muted">— the Ethereum ERC-20, separate from TAC's Bitcoin-native issuance</span></dd>`
  + `<dt>Recipients</dt><dd>8,652 addresses</dd>`
  + `<dt>Claim by</dt><dd id="airdrop-window">—</dd>`
  + `</dl>`;

export function tabTemplateHtml() {
  return INTRO_HTML
    + `<div id="airdrop-connect-row" style="display:none;">`
    + `<div class="muted" style="margin-bottom:10px;">Connect the Ethereum wallet that might be on the recipient list.</div>`
    + `<button type="button" id="airdrop-connect-btn" class="primary">Connect Ethereum wallet</button>`
    + `<details style="margin-top:10px;"><summary class="muted" style="cursor:pointer;font-size:11px;">Compatible wallets</summary>`
    + `<div class="muted" style="font-size:11px;margin-top:6px;line-height:1.5;">Most Ethereum wallets work: MetaMask, Rainbow, Rabby, Coinbase Wallet, Trust, Frame. Smart-contract wallets`
    + ` (Safe, Argent, Ambire) work too — claiming is a plain transaction, not a signature.</div>`
    + `</details>`
    + `</div>`
    + `<div id="airdrop-head" style="display:none;">Connected: <code class="addr" id="airdrop-address"></code>`
    + ` <button type="button" id="airdrop-refresh-btn" style="font-size:10px;padding:2px 8px;margin-left:6px;">↻ Refresh</button></div>`
    + `<div id="airdrop-message" class="muted" style="margin-top:8px;"></div>`
    + `<div id="airdrop-claim-card" class="info-card" style="display:none;margin-top:10px;">`
    + `<div><span class="amount" id="airdrop-amount"></span> <span class="unit">TAC</span></div>`
    + `<div id="airdrop-claim-meta" class="muted" style="font-size:11px;margin-top:2px;"></div>`
    + `<div class="flex" style="margin-top:10px;"><button type="button" id="airdrop-claim-btn" class="primary">Claim to my address</button></div>`
    + `<div id="airdrop-gas-claim" class="muted" style="font-size:10px;margin-top:4px;"></div>`
    + `<details style="margin-top:10px;"><summary class="muted" style="cursor:pointer;font-size:11px;">Claim to a different address ▾</summary>`
    + `<div style="padding-top:8px;">`
    + `<div id="airdrop-claimto-from" class="muted" style="font-size:11px;margin-bottom:6px;"></div>`
    + `<input type="text" id="airdrop-claimto-addr" placeholder="0x… recipient address" style="width:100%;max-width:360px;">`
    + `<div><button type="button" id="airdrop-claimto-go-btn" style="margin-top:6px;">Claim to this address</button></div>`
    + `<div id="airdrop-gas-claimto" class="muted" style="font-size:10px;margin-top:4px;"></div>`
    + `</div></details>`
    + `<div id="airdrop-status" class="muted field-status" style="margin-top:8px;"></div>`
    + `</div>`;
}

function ensureTabTemplate(body) {
  if (body._airdropBuilt) return;
  body._airdropBuilt = true;
  body.innerHTML = tabTemplateHtml();
}

function tabParts(el) {
  return {
    window: el('airdrop-window'),
    connectRow: el('airdrop-connect-row'), connectBtn: el('airdrop-connect-btn'),
    head: el('airdrop-head'), address: el('airdrop-address'), refreshBtn: el('airdrop-refresh-btn'),
    message: el('airdrop-message'), claimCard: el('airdrop-claim-card'),
    amount: el('airdrop-amount'), meta: el('airdrop-claim-meta'), claimBtn: el('airdrop-claim-btn'),
    gasClaim: el('airdrop-gas-claim'), claimtoFrom: el('airdrop-claimto-from'), claimtoAddr: el('airdrop-claimto-addr'),
    claimtoGoBtn: el('airdrop-claimto-go-btn'), gasClaimto: el('airdrop-gas-claimto'), status: el('airdrop-status'),
  };
}

function paintTab(body, ctx, el) {
  const p = tabParts(el);
  const { state, air } = ctx;
  const { address, status, checking, inflight } = state;
  const setMsg = (html) => { if (p.message) p.message.innerHTML = html; };

  if (p.window) p.window.textContent = air.config.claimByISO ? fmtDate(air.config.claimByISO) : 'not open on this network';

  show(p.claimCard, false);

  if (!air.config.deployed) {
    show(p.connectRow, false); show(p.head, false);
    setMsg('The TAC airdrop is on Ethereum mainnet only — switch network to check it.');
    return;
  }
  if (!address) {
    show(p.connectRow, true); show(p.head, false); setMsg('');
    return;
  }
  show(p.connectRow, false); show(p.head, true);
  if (p.address) p.address.textContent = checksummedOrShort(address);

  if (checking && !status) { setMsg('Checking eligibility…'); return; }
  if (!status || status.error) {
    setMsg(`Could not check eligibility right now (${esc((status && status.message) || 'network error')}). `
      + `<button type="button" id="airdrop-retry-inline" style="font:inherit;">Try again</button>`);
    const retry = el('airdrop-retry-inline');
    if (retry) retry.onclick = () => state.refresh(air, { force: true });
    return;
  }
  if (!status.eligible) { setMsg('This address is not on the airdrop list.'); return; }
  if (status.reason === 'claimed') {
    setMsg(`This allocation (${esc(status.amountTac)} TAC) has already been claimed. If that wasn't a transaction `
      + `you sent, check this address's balance — it may have gone here, or, if a claimTo() sent it elsewhere, `
      + `to that other address instead. The on-chain Claimed event for this allocation says which.`);
    return;
  }
  if (status.reason === 'closed') {
    setMsg(`The claim window closed on ${esc(fmtDate(status.claimByISO))}.`);
    return;
  }
  const note = quietNote(status);
  if (note) {
    setMsg(`You have ${esc(status.amountTac)} TAC allocated, but ${esc(note)}. `
      + `<button type="button" id="airdrop-retry-inline" style="font:inherit;">Check again</button>`);
    const retry = el('airdrop-retry-inline');
    if (retry) retry.onclick = () => state.refresh(air, { force: true });
    return;
  }

  setMsg('');
  show(p.claimCard, true);
  if (p.amount) p.amount.textContent = status.amountTac;
  const tinyNote = Number(status.amountTac) < 0.01 ? ' · this is a small allocation — gas may cost more than the TAC you\'d receive' : '';
  if (p.meta) p.meta.textContent = `Claim by ${fmtDate(status.claimByISO)} (${fmtLeft(status.secondsLeft)}) · allocation #${status.index}${tinyNote}`;
  if (p.claimtoFrom) p.claimtoFrom.textContent = `Sends from ${checksummedOrShort(address)} (this must be the connected wallet); the TAC lands at the address below instead.`;
  if (p.claimBtn) p.claimBtn.disabled = inflight;
  if (p.claimtoGoBtn) p.claimtoGoBtn.disabled = inflight;
  paintGasEstimates(p, ctx);
}

function paintGasEstimates(p, ctx) {
  const { state, air, ux } = ctx;
  const address = state.address;
  if (p.gasClaim) p.gasClaim.textContent = 'estimating gas…';
  if (p.gasClaimto) p.gasClaimto.textContent = 'estimating gas…';
  air.buildClaim(address).then((tx) => estimateGas(ux, tx)).then((g) => {
    const text = g != null ? `~${g.toLocaleString()} gas` : '';
    const toText = g != null ? `~${g.toLocaleString()} gas (claimTo costs about the same)` : '';
    if (p.gasClaim) p.gasClaim.textContent = text;
    if (p.gasClaimto) p.gasClaimto.textContent = toText;
  }).catch(() => {
    if (p.gasClaim) p.gasClaim.textContent = '';
    if (p.gasClaimto) p.gasClaimto.textContent = '';
  });
}

function wireTabButtons(ctx, el) {
  const p = tabParts(el);
  const say = (t) => { if (p.status) p.status.textContent = t; };
  if (p.connectBtn) p.connectBtn.onclick = () => runConnect(ctx, { say, button: p.connectBtn });
  if (p.refreshBtn) p.refreshBtn.onclick = () => ctx.state.refresh(ctx.air, { force: true });
  if (p.claimBtn) p.claimBtn.onclick = () => runClaim(ctx, { say });
  if (p.claimtoGoBtn) p.claimtoGoBtn.onclick = () => {
    const to = p.claimtoAddr ? String(p.claimtoAddr.value || '').trim() : '';
    if (!to) { say('Enter a recipient address.'); return; }
    return runClaimTo(ctx, to, { say });
  };
}

export function wireAirdropTab({ ux, eth, state = sharedState(), el = (id) => document.getElementById(id), autoDetect = true } = {}) {
  const body = el(TAB_BODY_ID);
  if (!body || !ux || !ux.tacAirdrop) return;
  const air = ux.tacAirdrop;
  const ctx = { air, ux, eth, state };
  ensureTabTemplate(body);
  wireTabButtons(ctx, el);
  if (body._airdropUnsub) body._airdropUnsub();
  const repaint = () => paintTab(body, ctx, el);
  body._airdropUnsub = state.onChange(repaint);
  repaint();
  if (autoDetect && !state.address) {
    detectSilentAddress().then((addr) => { if (addr) state.setAddress(addr, air); });
  }
  bindAccountsChanged((addr) => state.setAddress(addr, air));
}

export async function renderAirdropTab(wallet, helpers = {}) {
  const body = document.getElementById(TAB_BODY_ID);
  if (!body) return;
  const ux = safeUx();
  if (!ux) {
    body.innerHTML = '<div class="muted">The TAC airdrop needs this page’s confidential-pool configuration, which isn’t set up on this network.</div>';
    body._airdropBuilt = false;
    return;
  }
  try { wireAirdropTab({ ux, eth: helpers.eth }); }
  catch (e) {
    console.error('airdrop tab', e);
    body.innerHTML = '<div class="muted">Could not load the airdrop right now.</div>';
    body._airdropBuilt = false;
  }
}
