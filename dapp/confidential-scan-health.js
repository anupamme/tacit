
import { shownTicker } from './confidential-deployments.js';

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatUnits(value, decimals) {
  const v = BigInt(value);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const int = decimals ? s.slice(0, -decimals) : s;
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + (frac ? `${int}.${frac}` : int);
}

const CHANNEL_LABEL = {
  wrap: 'the deposit scan',
  cbtc: 'the cBTC scan',
  bridge: 'the Bitcoin-bridge scan',
  change: 'the change-note scan',
  derived: 'the settle-output scan',
  derivedOutputs: 'the settle-output scan',
  locks: 'the stealth-payment scan',
  cdp: 'the borrow-position scan',
  farm: 'the farm-position scan',
};

const KEY_ONLY = { cbtc: 'cBTC', bridge: 'bridged' };

export function channelLabel(key) {
  return CHANNEL_LABEL[key] || `the ${String(key || 'pool')} scan`;
}

function joinPhrases(list) {
  const a = list.filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

export function scanHealth(diag) {
  const d = diag || {};
  const channels = Object.keys(d.errors || {});
  const truncated = (d.wrap && d.wrap.truncated) || [];
  const pendingWraps = ((d.wrap && d.wrap.pending) || []).length;
  const inboundUnverified = Number(d.inboundUnverified || 0);
  const keyOnly = channels.filter((c) => KEY_ONLY[c]);
  const out = { ok: channels.length === 0 && !truncated.length, channels, keyOnly, truncated, pendingWraps, inboundUnverified, text: '' };
  if (out.ok) return out;

  const parts = [];
  if (channels.length) parts.push(`${joinPhrases(channels.map(channelLabel))} did not finish`);
  if (truncated.length) parts.push('the deposit scan stopped at its index limit');
  let text = `Balances may be incomplete — ${joinPhrases(parts)}.`;
  if (keyOnly.length) {
    const kinds = joinPhrases(keyOnly.map((c) => KEY_ONLY[c]));
    text += ` ${kinds} notes are found from your key and the chain alone, so any you hold can be missing from the figure until that scan succeeds.`;
  }
  text += ' Scanning again is safe and costs nothing.';
  out.text = text;
  return out;
}

export function scanHealthHtml(diag, { style = 'margin:8px 0;' } = {}) {
  const h = scanHealth(diag);
  if (h.ok) return '';
  return `<div class="warn" style="${escapeHtml(style)}">${escapeHtml(h.text)}</div>`;
}

export function scanHealthSuffix(diag) {
  const h = scanHealth(diag);
  return h.ok ? '' : ' — ' + h.text;
}

export function pendingWrapRowsHtml(diag, ux) {
  const pending = (diag && diag.wrap && diag.wrap.pending) || [];
  if (!pending.length) return '';
  const rows = pending.map((p) => {
    const ticker = ux.tickerOf(p.asset) || 'cETH';
    const meta = ux.assets.find((x) => x.assetId.toLowerCase() === String(p.asset).toLowerCase());
    const dec = meta ? (meta.tacitDecimals ?? meta.decimals) : 8;
    return `<div class="list-row" data-pending-asset="${escapeHtml(p.asset)}" data-pending-index="${p.index}" style="padding:6px 0;">`
      + `<span>${formatUnits(p.value, dec)} ${escapeHtml(shownTicker(ticker))} <span class="muted">deposited, not yet settled</span></span>`
      + `<button class="cpool-resume-wrap" style="padding:4px 10px;font-size:10px;flex:0 0 auto;">Resume</button></div>`;
  }).join('');
  return `<div class="warn" style="margin:8px 0;padding:8px 10px;">`
    + `<div style="font-weight:600;margin-bottom:4px;">${pending.length} deposit${pending.length === 1 ? '' : 's'} waiting to settle</div>`
    + rows + `</div>`;
}

export function notifyPendingWrapsOnce(diag, notify) {
  const pending = (diag && diag.wrap && diag.wrap.pending) || [];
  if (!pending.length) return;
  const FLAG = 'tacit:pending-wrap-notified-v1';
  try { if (sessionStorage.getItem(FLAG)) return; sessionStorage.setItem(FLAG, '1'); } catch { }
  const n = pending.length;
  notify(
    `${n === 1 ? 'A deposit is' : `${n} deposits are`} waiting to become private. Open the Ethereum tab and press Resume to finish.`,
    '',
    { title: 'The funds are safe in the pool; only the settle step still has to run.', onClick: () => { location.hash = '#tab=csend'; } },
  );
}

export const INBOUND_LABEL = 'inbound';
export const INBOUND_TITLE = 'Known only from a memo sealed to your scan key — spendable as normal, but not re-derived from your key alone, so who created it is unverified.';

export function noteIsInbound(note) {
  return !!(note && note.inboundUnverified);
}

export function inboundBadgeHtml(note) {
  if (!noteIsInbound(note)) return '';
  return ` <span class="muted" title="${escapeHtml(INBOUND_TITLE)}">· ${escapeHtml(INBOUND_LABEL)}</span>`;
}

export function inboundBadgeText(note) {
  return noteIsInbound(note) ? ` · ${INBOUND_LABEL}` : '';
}

export function inboundSummaryText(notesOrCount) {
  const n = Array.isArray(notesOrCount) ? notesOrCount.filter(noteIsInbound).length : Number(notesOrCount || 0);
  if (!n) return '';
  return `${n} note${n === 1 ? '' : 's'} marked “${INBOUND_LABEL}” ${n === 1 ? 'was' : 'were'} found from a memo addressed to you rather than from your own key. ${n === 1 ? 'It is' : 'They are'} spendable; who created ${n === 1 ? 'it' : 'them'} is unverified.`;
}

export function inboundSummaryHtml(notesOrCount) {
  const t = inboundSummaryText(notesOrCount);
  return t ? `<div class="muted" style="margin-top:4px;">${escapeHtml(t)}</div>` : '';
}

const SKIPPED_LABEL = {
  change: 'change notes',
  derived: 'settle outputs',
  cdp: 'borrow positions',
};

export function recoveryCoverage(diagnostics) {
  const d = diagnostics || {};
  const cov = d.coverage || {};
  const complete = cov.complete === true;
  const channels = Object.keys(d.errors || {});
  const skipped = cov.skipped || {};
  const skippedParts = Object.keys(SKIPPED_LABEL)
    .map((k) => ({ k, n: (skipped[k] || []).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} settle transaction${x.n === 1 ? '' : 's'} behind your ${SKIPPED_LABEL[x.k]} could not be read`);
  const out = { complete, channels, skipped: skippedParts, text: '' };
  if (complete) {
    out.text = 'Restore complete — every channel this wallet uses was scanned.';
    return out;
  }
  const parts = [];
  if (channels.length) parts.push(`${joinPhrases(channels.map(channelLabel))} did not finish`);
  parts.push(...skippedParts);
  out.text = `Restore incomplete — ${joinPhrases(parts) || 'part of the scan did not finish'}.`
    + ' Anything it missed is still recoverable from your wallet key: run the restore again rather than treating this as the whole wallet.';
  return out;
}

export function recoveryCoverageHtml(diagnostics, { style = 'margin:8px 0;' } = {}) {
  const c = recoveryCoverage(diagnostics);
  const cls = c.complete ? 'info-card' : 'warn';
  return `<div class="${cls}" style="${escapeHtml(style)}">${escapeHtml(c.text)}</div>`;
}

export function lockScanHealth(scanned) {
  const s = scanned || {};
  const verified = s.verified === true;
  const withoutMemo = Number(s.locksWithoutMemo || 0);
  const out = { ok: verified && !withoutMemo, verified, locksWithoutMemo: withoutMemo, text: '' };
  if (out.ok) return out;
  const parts = [];
  if (!verified) {
    parts.push('the pool did not confirm the lock set this scan was built from'
      + (s.unverifiedReason ? ` (${String(s.unverifiedReason)})` : ''));
  }
  if (withoutMemo) parts.push(`${withoutMemo} lock${withoutMemo === 1 ? '' : 's'} could not be read, so a payment to you could be missing from this list`);
  out.text = `This list may be incomplete — ${joinPhrases(parts)}. Scanning again is safe and costs nothing.`;
  return out;
}

export function lockScanHealthHtml(scanned, { style = 'margin:8px 0;' } = {}) {
  const h = lockScanHealth(scanned);
  if (h.ok) return '';
  return `<div class="warn" style="${escapeHtml(style)}">${escapeHtml(h.text)}</div>`;
}
