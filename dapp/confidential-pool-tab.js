
import { secp, sha256, keccak_256, bytesToHex } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { confidentialPoolReady, confidentialUnavailableHTML, esc, formatErr, formatSpecErr, notify, proveUpdater, evmAccountHint, shownTicker } from './confidential-deployments.js';
import { formatUnits as fmtUnits } from './confidential-payout.js';
import { classifyFinality, finalityBadgeHtml, listProvisional } from './confidential-finality.js';
import { scanHealthHtml, inboundBadgeHtml, inboundSummaryHtml, recoveryCoverageHtml, recoveryCoverage, pendingWrapRowsHtml, notifyPendingWrapsOnce } from './confidential-scan-health.js';
import { renderLanePanel } from './cross-chain-lane.js';

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256}));
}

const el = (id) => document.getElementById(id);

function ethToWei(s) {
  s = String(s == null ? '' : s).trim();
  if (!s || !/^\d*\.?\d*$/.test(s)) return '0';
  const [i, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(18)).slice(0, 18);
  return (BigInt(i || '0') * (10n ** 18n) + BigInt(frac || '0')).toString();
}

function wireWrap(wallet, ux, { ticker = 'cETH', idPrefix = 'cpool-wrap', noteName = 'tETH' } = {}) {
  const btn = el(`${idPrefix}-btn`);
  if (!btn) return;
  btn.onclick = async () => {
    const st = el(`${idPrefix}-status`);
    if (!wallet || !wallet.priv) { if (st) st.textContent = 'Unlock your wallet first.'; return; }
    const wei = ethToWei(el(`${idPrefix}-amount`) ? el(`${idPrefix}-amount`).value : '');
    if (!wei || wei === '0') { if (st) st.textContent = 'Enter an amount.'; return; }
    btn.disabled = true;
    if (st) st.textContent = 'Building + broadcasting the deposit…';
    let r;
    try {
      r = ux.cfg.router
        ? await ux.routerWrap({ walletPriv: wallet.priv, amountWei: wei, ticker })
        : await ux.wrap({ walletPriv: wallet.priv, amountWei: wei, ticker });
      if (st) st.innerHTML = `Deposit broadcast${ux.cfg.router ? ' (one-tx router)' : ''}: <code class="addr">${esc(r.txHash)}</code> — waiting for it to confirm…`;
      await ux.waitReceipt(r.txHash);
      if (st) st.innerHTML = `Deposit confirmed: <code class="addr">${esc(r.txHash)}</code> — submitting for settle (proving your ${esc(noteName)} note; can take a minute)…`;
      await ux.submitWrapSettle({ built: r });
      if (st) st.innerHTML = `Settled: <code class="addr">${esc(r.txHash)}</code> — your ${esc(noteName)} note is ready.`;
      notify(`Wrap settled — ${noteName} note ready`, 'ok');
    } catch (e) {
      const m = formatSpecErr(e, 'Wrap');
      if (st) st.textContent = r && r.txHash && !(e && e.reverted)
        ? `${m} — the deposit (${r.txHash}) is on-chain; do not re-wrap the same amount. Reload this tab — the pending deposit will show below with a Resume button.`
        : m;
      notify(m, 'error');
    } finally {
      btn.disabled = false;
    }
  };
}

function wireResumeWraps(wallet, ux, diag) {
  const pending = (diag && diag.wrap && diag.wrap.pending) || [];
  if (!pending.length) return;
  const byKey = new Map(pending.map((p) => [`${String(p.asset).toLowerCase()}:${p.index}`, p]));
  for (const row of document.querySelectorAll('[data-pending-asset]')) {
    const btn = row.querySelector('.cpool-resume-wrap');
    if (!btn) continue;
    const key = `${row.getAttribute('data-pending-asset').toLowerCase()}:${row.getAttribute('data-pending-index')}`;
    const p = byKey.get(key);
    if (!p) continue;
    btn.onclick = async () => {
      btn.disabled = true;
      const prevText = btn.textContent;
      btn.textContent = 'Settling…';
      try {
        const ticker = ux.tickerOf(p.asset) || 'cETH';
        const meta = ux.assets.find((x) => x.assetId.toLowerCase() === String(p.asset).toLowerCase());
        const unitScale = BigInt((meta && meta.unitScale) || '1');
        const built = ux.buildWrap({ walletPriv: wallet.priv, amountWei: (BigInt(p.value) * unitScale).toString(), ticker, index: p.index });
        await ux.submitWrapSettle({ built });
        notify(`Settled — ${fmtUnits(p.value, meta ? (meta.tacitDecimals ?? meta.decimals) : 8)} ${shownTicker(ticker)} note ready`, 'ok');
        setTimeout(() => renderConfidentialPoolTab(wallet), 1500);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = prevText;
        notify(formatSpecErr(e, 'Resume wrap'), 'error');
      }
    };
  }
}

function wireExit(wallet, ux, notes) {
  const listEl = el('cpool-exit-list');
  const statusEl = el('cpool-exit-status');
  if (!listEl) return;
  if (!notes || !notes.length) { listEl.textContent = 'No notes to exit yet.'; return; }

  const decOf = (assetId) => {
    const m = ux.assets.find((x) => x.assetId.toLowerCase() === String(assetId).toLowerCase());
    return m ? (m.tacitDecimals ?? m.decimals) : 8;
  };
  const byLeaf = new Map(notes.map((n) => [String(n.leafIndex), n]));

  const recField = el('cpool-exit-recipient'), linkNote = el('cpool-exit-linknote');
  const own = String(ux.account(wallet.priv).address).toLowerCase();
  const noteLink = () => {
    if (!linkNote) return;
    const v = String(recField && recField.value || '').trim().toLowerCase();
    linkNote.textContent = !v || v === own
      ? 'This exits to your own account, where your deposits come from, so it can be matched to them on chain. A fresh address keeps them apart.'
      : '';
  };
  if (recField) recField.oninput = noteLink;
  noteLink();

  listEl.innerHTML = notes.map((n) => {
    const ticker = ux.tickerOf(n.asset) || 'cETH';
    const dec = decOf(n.asset);
    let preview = '';
    try {
      const q = ux.quoteUnwrapFee(n.value, ticker);
      preview = q.net > 0n
        ? `→ receive ${fmtUnits(q.net, dec)} (fee ${fmtUnits(q.fee, dec)})`
        : '→ too small for a fee exit — tick “No fee”';
    } catch { }
    return `<div class="list-row">`
      + `<span>${fmtUnits(n.value, dec)} ${esc(shownTicker(ticker))}${inboundBadgeHtml(n)} <span class="muted">${esc(preview)}</span></span>`
      + `<button data-leaf="${n.leafIndex}" class="cpool-exit-one" style="padding:4px 10px;font-size:10px;flex:0 0 auto;">Exit</button></div>`;
  }).join('') + inboundSummaryHtml(notes);

  for (const btn of listEl.querySelectorAll('.cpool-exit-one')) {
    btn.onclick = async () => {
      const note = byLeaf.get(btn.getAttribute('data-leaf'));
      if (!note) return;
      const recInput = el('cpool-exit-recipient');
      const recipient = (recInput && recInput.value || '').trim() || undefined;
      const noFee = !!(el('cpool-exit-selfsettle') && el('cpool-exit-selfsettle').checked);
      const selfSettle = noFee
        ? ({ publicValues, proof, memos, pair }) => ux.settleFromAccount({ settlerPriv: wallet.priv, publicValues, proof, memos, pair })
        : null;
      const setBtns = (d) => listEl.querySelectorAll('.cpool-exit-one').forEach((b) => { b.disabled = d; });
      setBtns(true);
      if (statusEl) statusEl.textContent = noFee ? 'The relay is proving your exit; your Tacit account then sends it…' : 'Submitting your exit to the relayer…';
      try {
        const r = await ux.unwrap({
          note, walletPriv: wallet.priv, recipient, selfSettle,
          waitOpts: { onUpdate: proveUpdater(statusEl, 'Exiting') },
        });
        const dec = decOf(note.asset);
        const ticker = ux.tickerOf(note.asset) || 'cETH';
        if (statusEl) {
          statusEl.innerHTML = `Exit settled — ${fmtUnits(r.net, dec)} ${esc(shownTicker(ticker))} sent to <code class="addr">${esc(r.recipient)}</code>`
            + (r.txHash ? ` (<code class="addr">${esc(r.txHash)}</code>)` : '') + '.';
        }
        notify(`Exit settled — ${fmtUnits(r.net, dec)} ${shownTicker(ticker)}`, 'ok');
        setTimeout(() => renderConfidentialPoolTab(wallet), 1500);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        const full = 'Exit failed: ' + msg + (/too small/.test(msg) ? ' — tick “No fee” to exit this note.' : '');
        if (statusEl) statusEl.textContent = full; notify(full, 'error');
        setBtns(false);
      }
    };
  }
}

const CROSSOUT_STAGE_LABEL = {
  settling: 'Sent to Ethereum — waiting for the settle to land',
  settled: 'Settled on Ethereum — waiting for the reflection worker to see it',
  covered: 'Visible to the reflection worker — ready to sign the Bitcoin-side mint',
  'mint-signed': 'Signed — ready to broadcast on Bitcoin',
  'mint-submitted': 'Broadcast on Bitcoin — waiting for a confirmation',
  'mint-confirmed': 'Confirmed on Bitcoin — waiting for the note to be credited',
  'mint-rejected': 'Confirmed on Bitcoin, but the note was not credited — keep this record and ask for help',
  minted: 'Minted on Bitcoin — the usual forward reflection pass will pick it up from here',
};

function crossoutRecordsHtml(records, network) {
  if (!records.length) return '';
  const mempoolBase = network === 'signet' ? 'https://mempool.space/signet/tx/' : 'https://mempool.space/tx/';
  const rows = records.map((r) => {
    const label = CROSSOUT_STAGE_LABEL[r.stage] || r.stage;
    const revealLink = r.mint && r.mint.revealTxid
      ? ` · <a href="${mempoolBase}${esc(r.mint.revealTxid)}" target="_blank" rel="noopener">Bitcoin tx</a>` : '';
    const err = r.lastError ? `<div class="muted" style="font-size:10px;color:var(--red,#c33);">${esc(r.lastError.message)}</div>` : '';
    const showContinue = r.stage !== 'minted';
    return `<div class="list-row" style="flex-direction:column;align-items:flex-start;gap:2px;">`
      + `<div style="display:flex;justify-content:space-between;width:100%;align-items:center;gap:6px;">`
      + `<span style="font-size:11px;">${r.source && r.source.ticker && r.source.ticker !== 'TAC' ? `${esc(r.source.ticker)} · ` : ''}${esc(label)}${revealLink}</span>`
      + `<span style="display:flex;gap:4px;flex:0 0 auto;">`
      + (showContinue ? `<button data-id="${esc(r.id)}" class="cpool-crossout-continue" style="padding:2px 8px;font-size:10px;">Continue</button>` : '')
      + `<button data-id="${esc(r.id)}" data-txhash="${esc(r.settle && r.settle.txHash || '')}" class="cpool-crossout-abandon muted" title="Remove from this list only — does not undo anything on chain" style="padding:2px 8px;font-size:10px;">✕</button>`
      + `</span></div>${err}</div>`;
  }).join('');
  return `<div style="margin-bottom:4px;"><b style="font-size:11px;">Bridges to Bitcoin</b></div>${rows}`;
}

function crossoutResumeBoxHtml(hasRecords) {
  return `<details style="${hasRecords ? 'margin-top:10px;padding-top:8px;border-top:1px solid var(--ink-faint);' : ''}">`
    + `<summary class="muted" style="cursor:pointer;font-size:11px;">${hasRecords ? "Don't see a bridge you expect? " : ''}Recover a bridge from its Ethereum settle tx hash →</summary>`
    + `<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">`
    + `<input type="text" data-crossout-resume-txhash placeholder="Ethereum settle tx hash" style="flex:1;min-width:160px;font-size:11px;">`
    + `<input type="text" data-crossout-resume-amount placeholder="Amount (e.g. 250)" style="width:100px;font-size:11px;">`
    + `<button data-crossout-resume-btn style="font-size:11px;padding:5px 10px;white-space:nowrap;">Recover</button>`
    + `</div>`
    + `<div class="muted" data-crossout-resume-status style="font-size:11px;margin-top:4px;"></div>`
    + `</details>`;
}

function wireCrossoutResume(wallet, crossoutUx) {
  const btn = document.querySelector('[data-crossout-resume-btn]');
  if (!btn) return;
  btn.onclick = async () => {
    const txInput = document.querySelector('[data-crossout-resume-txhash]');
    const amountInput = document.querySelector('[data-crossout-resume-amount]');
    const statusEl = document.querySelector('[data-crossout-resume-status]');
    const txHash = (txInput?.value || '').trim().toLowerCase();
    const amountStr = (amountInput?.value || '').trim();
    if (!/^(0x)?[0-9a-f]{64}$/.test(txHash)) { if (statusEl) statusEl.textContent = 'Enter a valid Ethereum transaction hash.'; return; }
    const amountTac = Number(amountStr);
    if (!Number.isFinite(amountTac) || amountTac <= 0) { if (statusEl) statusEl.textContent = 'Enter the TAC amount this bridge carries.'; return; }
    btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Checking the settle and rebuilding this bridge from chain data…';
    try {
      const amountRaw = BigInt(Math.round(amountTac * 1e8));
      await crossoutUx.recoverFromEthTx(txHash.startsWith('0x') ? txHash : '0x' + txHash, wallet.priv, { amount: amountRaw });
      notify('Bridge recovered from its transaction hash', 'ok');
      setTimeout(() => renderConfidentialPoolTab(wallet, crossoutUx), 1500);
    } catch (e) {
      if (statusEl) statusEl.textContent = `Could not recover: ${e?.message || e}`;
      btn.disabled = false;
    }
  };
}

const CROSSOUT_POLL_INTERVAL_MS = 75 * 1000;
let _crossoutPollTimer = null;
let _crossoutPollNetwork = null;
function _startCrossoutAutoRefresh(wallet, crossoutUx) {
  if (_crossoutPollTimer) {
    if (_crossoutPollNetwork === crossoutUx.network) return;
    _stopCrossoutAutoRefresh();
  }
  _crossoutPollNetwork = crossoutUx.network;
  _crossoutPollTimer = setInterval(async () => {
    if (document.hidden) return;
    if (!wallet || !wallet.priv) { _stopCrossoutAutoRefresh(); return; }
    const walletPub = bytesToHex(secp.getPublicKey(wallet.priv, true));
    let records;
    try { records = crossoutUx.list(walletPub).filter((r) => r.stage !== 'minted'); }
    catch { return; }
    if (!records.length) { _stopCrossoutAutoRefresh(); return; }
    let changed = false;
    for (const rec of records) {
      if (rec.stage === 'covered') continue;
      try { const after = await crossoutUx.advance(walletPub, rec.id); if (after.stage !== rec.stage) changed = true; }
      catch { changed = true; }
    }
    if (changed && document.getElementById('tab-confidential-pool')?.classList.contains('active')) renderConfidentialPoolTab(wallet, crossoutUx);
  }, CROSSOUT_POLL_INTERVAL_MS);
}
function _stopCrossoutAutoRefresh() {
  if (_crossoutPollTimer) { clearInterval(_crossoutPollTimer); _crossoutPollTimer = null; }
  _crossoutPollNetwork = null;
}

function wireCrossout(wallet, ux, crossoutUx, notes) {
  const listEl = el('cpool-crossout-list');
  const statusEl = el('cpool-crossout-status');
  const inflightEl = el('cpool-crossout-inflight');
  if (!listEl) return;
  if (!crossoutUx) { listEl.textContent = 'Not available in this build.'; return; }

  const walletPub = bytesToHex(secp.getPublicKey(wallet.priv, true));
  const pendingRecords = (() => { try { return crossoutUx.list(walletPub).filter((r) => r.stage !== 'minted'); } catch { return []; } })();
  const refresh = () => {
    try {
      const records = crossoutUx.list(walletPub);
      if (inflightEl) inflightEl.innerHTML = crossoutRecordsHtml(records, crossoutUx.network) + crossoutResumeBoxHtml(records.length > 0);
      wireCrossoutResume(wallet, crossoutUx);
    } catch {}
  };
  if (pendingRecords.length) _startCrossoutAutoRefresh(wallet, crossoutUx);

  const tacAsset = ux.assetByTicker && ux.assetByTicker.cTAC && ux.assetByTicker.cTAC.assetId;
  const tacNotes = tacAsset ? (notes || []).filter((n) => String(n.asset).toLowerCase() === String(tacAsset).toLowerCase()) : [];
  const decOf = () => { const m = ux.assets.find((x) => x.assetId.toLowerCase() === String(tacAsset).toLowerCase()); return m ? (m.tacitDecimals ?? m.decimals) : 8; };

  if (!tacNotes.length) { listEl.textContent = 'No cTAC notes to bridge yet.'; refresh(); return; }

  const elig = crossoutUx.eligibleNotes(tacNotes);
  const byLeaf = new Map(elig.map((n) => [String(n.leafIndex), n]));
  listEl.innerHTML = elig.map((n) => {
    const dec = decOf();
    const reason = n.eligible ? '' : ` <span class="muted" style="font-size:10px;">(${esc(n.reason)})</span>`;
    return `<div class="list-row">`
      + `<span>${fmtUnits(n.value, dec)} cTAC${reason}</span>`
      + `<button data-leaf="${n.leafIndex}" class="cpool-crossout-one" ${n.eligible ? '' : 'disabled'} style="padding:4px 10px;font-size:10px;flex:0 0 auto;">Bridge</button></div>`;
  }).join('');

  for (const btn of listEl.querySelectorAll('.cpool-crossout-one')) {
    btn.onclick = async () => {
      const note = byLeaf.get(btn.getAttribute('data-leaf'));
      if (!note) return;
      const amountStr = `${fmtUnits(note.value, decOf())} cTAC`;
      if (!window.confirm(`Bridge ${amountStr} to Bitcoin?\n\nThis settles on Ethereum immediately and cannot be undone. It arrives at this wallet's own Bitcoin key once the reflection worker sees the settle and the Bitcoin-side mint confirms — usually not instant.`)) return;
      listEl.querySelectorAll('.cpool-crossout-one').forEach((b) => { b.disabled = true; });
      if (statusEl) statusEl.textContent = 'Settling on Ethereum…';
      try {
        const rec = await crossoutUx.start({ note, walletPriv: wallet.priv });
        if (statusEl) statusEl.textContent = `Settled (${rec.settle.txHash}) — waiting for the reflection worker to see it before the Bitcoin-side mint can broadcast.`;
        notify('Cross-out settled on Ethereum', 'ok');
        try { await crossoutUx.advance(walletPub, rec.id, { walletPriv: wallet.priv }); } catch {}
        setTimeout(() => renderConfidentialPoolTab(wallet, crossoutUx), 1500);
      } catch (e) {
        const msg = formatSpecErr(e, 'Bridge');
        if (statusEl) statusEl.textContent = msg; notify(msg, 'error');
        listEl.querySelectorAll('.cpool-crossout-one').forEach((b) => { b.disabled = false; });
      }
    };
  }

  refresh();
  if (inflightEl) {
    for (const btn of inflightEl.querySelectorAll('.cpool-crossout-continue')) {
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'Working…';
        try {
          await crossoutUx.advance(walletPub, btn.getAttribute('data-id'), { walletPriv: wallet.priv });
          notify('Cross-out advanced', 'ok');
        } catch (e) {
          notify(formatSpecErr(e, 'Continue'), 'error');
        } finally {
          setTimeout(() => renderConfidentialPoolTab(wallet, crossoutUx), 800);
        }
      };
    }
    for (const btn of inflightEl.querySelectorAll('.cpool-crossout-abandon')) {
      btn.onclick = () => {
        const txHash = btn.getAttribute('data-txhash');
        const recoveryLine = txHash
          ? ` It already settled on Ethereum — if you change your mind, bring it back with "Recover a bridge from its Ethereum settle tx hash" using ${txHash}.`
          : '';
        if (!window.confirm(`Remove this bridge from your list?\n\nThis only removes it here — it does not undo anything on chain.${recoveryLine}`)) return;
        crossoutUx.abandon(walletPub, btn.getAttribute('data-id'));
        renderConfidentialPoolTab(wallet, crossoutUx);
      };
    }
  }
}

function wireRestore(wallet, ux) {
  const btn = el('cpool-restore-btn');
  const out = el('cpool-restore-out');
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    if (out) out.textContent = 'Rebuilding everything your key can reach from the chain…';
    try {
      const r = await ux.recover({ walletPriv: wallet.priv });
      const n = (x) => (x || []).length;
      const line = `Found ${n(r.notes)} note${n(r.notes) === 1 ? '' : 's'}`
        + `, ${n(r.farmPositions)} farm position${n(r.farmPositions) === 1 ? '' : 's'}`
        + `, ${n(r.cdpPositions)} borrow position${n(r.cdpPositions) === 1 ? '' : 's'}`
        + `, ${n(r.receivedLocks)} claimable payment${n(r.receivedLocks) === 1 ? '' : 's'}.`;
      if (out) out.innerHTML = recoveryCoverageHtml(r.diagnostics, { style: 'margin:0 0 6px;' }) + `<div>${esc(line)}</div>`;
      const cov = recoveryCoverage(r.diagnostics);
      notify(cov.complete ? 'Restore complete' : 'Restore incomplete — some of the scan did not finish', cov.complete ? 'ok' : '');
    } catch (e) {
      if (out) out.textContent = formatErr(e, 'Restore');
    } finally {
      btn.disabled = false;
    }
  };
}

let _finalityTimer = null;

function renderFinality() {
  const box = el('cpool-finality');
  if (!box) return;
  const now = Date.now();
  const pending = listProvisional().map((a) => ({
    a, s: classifyFinality({ settledAtMs: a.settledAtMs, nowMs: now, anchored: a.anchored, anchorWindowMs: a.anchorWindowMs }),
  }));
  const model = 'Finality: Ethereum pool actions (wrap, transfer, exit) are final in seconds. '
    + 'Cross-chain (Bitcoin-homed) value is fast-final on Ethereum, then settles to Bitcoin over ~1 hr — '
    + 'reversible by a deep Bitcoin reorg until anchored.';
  const safeLabel = (l) => String(l == null ? 'Cross-chain action' : l).replace(/[<>&]/g, '');
  const rows = pending.map(({ a, s }) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;">`
    + `<span>${safeLabel(a.label)}</span>${finalityBadgeHtml(s)}</div>`
    + `<div class="muted" style="font-size:10px;margin-top:2px;">${s.detail}</div>`).join('');
  box.innerHTML = `<div class="muted" style="border:1px solid var(--hairline);padding:8px;">`
    + `<div>${model}</div>${rows}</div>`;

  if (_finalityTimer) { clearInterval(_finalityTimer); _finalityTimer = null; }
  if (pending.some(({ s }) => s.tone === 'pending')) _finalityTimer = setInterval(renderFinality, 30000);
}

function renderPoolPanel() {
  const intro =
    `<div class="note-concept"><b>One note, two chains.</b> Wrap <span class="eth-word">ETH</span> (or any token) into a shielded note here, or bring value over from <span class="btc-word">Bitcoin</span> — it becomes the same shielded note you can transfer, trade, or borrow against from either side.</div>`
    + `<div class="muted" style="font-size:11px;"><span style="color:var(--green)">●</span> Independently reviewed — no open fund-impacting findings · <a href="#tab=about">details →</a></div>`
    + `<div>Your confidential account: <code id="cpool-address" class="addr" style="font-size:11px;">—</code></div>`
    + evmAccountHint()
    + `<div id="cpool-status" class="muted">—</div>`
    + `<div id="cpool-balance"></div>`
    + `<div style="margin-top:6px;"><button id="cpool-restore-btn" style="padding:4px 10px;font-size:10px;">Restore everything from my key</button></div>`
    + `<div id="cpool-restore-out" class="muted field-status" style="margin-top:6px;"></div>`
    + `<div id="cpool-finality" style="font-size:11px;"></div>`;

  const wrapBody =
    `<div class="field-row">`
    + `<input id="cpool-wrap-amount" type="number" step="0.0001" min="0" placeholder="0.001">`
    + `<span class="muted" style="font-size:12px;align-self:center;">ETH</span>`
    + `<button id="cpool-wrap-btn" class="primary">Wrap</button>`
    + `</div>`
    + `<div id="cpool-wrap-status" class="muted field-status" style="margin-top:6px;"></div>`
    + `<div class="muted" style="font-size:11px;margin-top:6px;">Fund your confidential account (above) with ETH first. The deposit escrows ETH; your tETH note appears after the settle.</div>`;

  const exitBody =
    `<input id="cpool-exit-recipient" type="text" placeholder="Recipient address (a fresh one keeps it unlinked; default: your account)">`
    + `<div id="cpool-exit-linknote" class="muted" style="font-size:11px;margin:4px 0;"></div>`
    + `<label class="check-row" style="margin:8px 0;"><input id="cpool-exit-selfsettle" type="checkbox"> <span>No fee (your Tacit account sends the exit and pays its network fee)</span></label>`
    + `<div id="cpool-exit-list" class="muted" style="font-size:12px;">Unlock + wrap to see your exitable notes.</div>`
    + `<div id="cpool-exit-status" class="muted field-status" style="margin-top:6px;"></div>`
    + `<div class="muted" style="font-size:11px;margin-top:6px;">Each exit spends one whole note. The relayer settles on-chain so you need no ETH for gas; by default a small fee is taken from your withdrawal. With No fee, the full value exits to the recipient and your Tacit account pays the network fee.</div>`;

  const wrapTacBody =
    `<div class="field-row">`
    + `<input id="cpool-wrap-tac-amount" type="number" step="0.01" min="0" placeholder="100">`
    + `<span class="muted" style="font-size:12px;align-self:center;">TAC</span>`
    + `<button id="cpool-wrap-tac-btn" class="primary">Wrap</button>`
    + `</div>`
    + `<div id="cpool-wrap-tac-status" class="muted field-status" style="margin-top:6px;"></div>`
    + `<div class="muted" style="font-size:11px;margin-top:6px;">Hold the public TAC token in this wallet's Ethereum address first. The deposit escrows TAC; your cTAC note appears after the settle.</div>`;

  const btcBody =
    `<div class="muted" style="font-size:11px;">Value bridged from Bitcoin lands as the same shielded note — transfer, trade, or borrow against it on either side. Bitcoin-homed value is fast-final on Ethereum, then settles to Bitcoin over ~1 hr.</div>`;

  const crossoutBody =
    `<div id="cpool-crossout-list" class="muted" style="font-size:12px;">Unlock + wrap TAC to see your bridgeable notes.</div>`
    + `<div id="cpool-crossout-status" class="muted field-status" style="margin-top:6px;"></div>`
    + `<div id="cpool-crossout-inflight" style="margin-top:10px;"></div>`
    + `<div class="muted" style="font-size:11px;margin-top:6px;">Beta, capped at 1,000 TAC per note. Bridges to this wallet's own Bitcoin key. The Ethereum side settles in seconds; the Bitcoin-side mint waits for the reflection worker to see that settle, which can take a while — this list keeps tracking it across reloads.</div>`;

  return renderLanePanel({
    intro,
    lanes: [
      { key: 'eth', label: 'Ethereum lane', actions: [
        { title: 'Wrap ETH → tETH', dir: 'in', body: wrapBody },
        { title: 'Wrap TAC → cTAC', dir: 'in', body: wrapTacBody },
        { title: 'Exit tETH → ETH', dir: 'out', meta: 'gasless — relayer settles for a small fee', body: exitBody },
      ] },
      { key: 'btc', label: 'Bitcoin lane', actions: [
        { title: 'Bring value from Bitcoin', dir: 'over', body: btcBody },
        { title: 'Bridge TAC → Bitcoin', dir: 'out', meta: 'beta — capped at 1,000 TAC', body: crossoutBody },
      ] },
    ],
    footer: `Holding legacy alpha tETH notes? <a href="#" id="cpool-legacy-bridge">Redeem or migrate them →</a>`,
  });
}

export async function renderConfidentialPoolTab(wallet, crossoutUx = null) {
  const body = el('cpool-body');
  if (!body) return;
  if (!confidentialPoolReady()) { body.innerHTML = confidentialUnavailableHTML('The shielded pool'); return; }

  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock your wallet to view your confidential account and move value across chains.</div>';
    renderFinality();
    return;
  }

  const acct = ux.account(wallet.priv);
  body.innerHTML = renderPoolPanel();
  const addrEl = el('cpool-address');
  const statusEl = el('cpool-status');
  const balEl = el('cpool-balance');
  if (addrEl) addrEl.textContent = acct.address;
  const legacy = el('cpool-legacy-bridge');
  if (legacy) legacy.onclick = (e) => { e.preventDefault(); if (window._openBridgeModal) window._openBridgeModal(); };
  wireWrap(wallet, ux);
  wireWrap(wallet, ux, { ticker: 'cTAC', idPrefix: 'cpool-wrap-tac', noteName: 'cTAC' });
  wireRestore(wallet, ux);
  if (statusEl) statusEl.textContent = 'Scanning the pool for your notes…';
  if (balEl) balEl.innerHTML = '';

  if (statusEl) statusEl.textContent = 'Scanning the pool…';
  try {
    const { byAsset, notes, diag } = await ux.balance(wallet.priv);
    const assets = Object.values(byAsset);
    if (statusEl) {
      statusEl.textContent = notes.length
        ? `${notes.length} shielded note${notes.length === 1 ? '' : 's'} recovered`
        : 'No shielded notes yet — wrap ETH to mint your first tETH note.';
    }
    notifyPendingWrapsOnce(diag, notify);
    if (balEl) {
      balEl.innerHTML = scanHealthHtml(diag)
        + pendingWrapRowsHtml(diag, ux)
        + assets.map((a) => {
          const meta = ux.assets.find((x) => x.assetId.toLowerCase() === a.asset);
          const dec = meta ? (meta.tacitDecimals ?? meta.decimals) : 8;
          return `<div class="list-row">`
            + `<span>${esc(shownTicker(a.ticker) || (a.asset.slice(0, 10) + '…'))}</span><strong>${fmtUnits(a.value, dec)}</strong></div>`;
        }).join('');
    }
    wireExit(wallet, ux, notes);
    wireCrossout(wallet, ux, crossoutUx, notes);
    wireResumeWraps(wallet, ux, diag);
    renderFinality();
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Could not scan the pool: ' + formatErr(e);
  }
}
