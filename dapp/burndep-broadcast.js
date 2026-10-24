
const SLIPSTREAM_BASE = 'https://slipstream.mara.com';
const JOURNAL_KEY = 'tacit-burndep-pending-v1';

function defaultJournal() {
  const ls = (() => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } })();
  let mem = [];
  return {
    load() { if (!ls) return mem; try { const r = JSON.parse(ls.getItem(JOURNAL_KEY) || '[]'); return Array.isArray(r) ? r : []; } catch { return []; } },
    save(list) { mem = list; if (ls) { try { ls.setItem(JOURNAL_KEY, JSON.stringify(list)); } catch {} } },
  };
}

export function makeBurnDepositBroadcaster({ workerBase, fetchImpl, slipstreamBase = SLIPSTREAM_BASE, slipstreamHeaders = null, journal = null } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!f) throw new Error('burndep-broadcast: no fetch implementation');
  const store = journal || defaultJournal();
  const mhdrs = (extra) => ({ ...(slipstreamHeaders || {}), ...extra });

  function pendingBurnDeposits() { return store.load(); }
  function journalPut(rec) {
    const list = store.load().filter((r) => r.txid !== rec.txid);
    list.push(rec);
    store.save(list);
    return rec;
  }
  function journalDrop(txid) { store.save(store.load().filter((r) => r.txid !== txid)); }

  async function submitToSlipstream(txHex) {
    if (!txHex || typeof txHex !== 'string') throw new Error('burndep-broadcast: txHex required');
    const res = await f(`${slipstreamBase}/api/transactions`, {
      method: 'POST',
      headers: mhdrs({ 'content-type': 'application/json' }),
      body: JSON.stringify({ tx_hex: txHex }),
    });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    // the status rides on the error, so a busy or failing miner (429, 5xx) is told from one that refused the transaction (a 400 names why)
    if (!res.ok) throw Object.assign(new Error(`burndep-broadcast: slipstream submit failed (${res.status}): ${text.slice(0, 300)}`), { status: res.status });
    if (body.status !== 'success') throw new Error(`burndep-broadcast: slipstream submit refused: ${body.message || JSON.stringify(body)}`);
    return body;
  }

  async function slipstreamStatus(txid) {
    if (!txid) throw new Error('burndep-broadcast: txid required');
    const res = await f(`${slipstreamBase}/api/transactions/status?tx_id=${txid}`, { headers: mhdrs({}) });
    if (!res.ok) throw Object.assign(new Error(`burndep-broadcast: slipstream status failed (${res.status})`), { status: res.status });
    return res.json();
  }

  async function slipstreamRates() {
    const res = await f(`${slipstreamBase}/api/rates`, { headers: mhdrs({}) });
    if (!res.ok) throw new Error(`burndep-broadcast: slipstream rates failed (${res.status})`);
    return res.json();
  }

  async function testSlipstreamAccept(txHex) {
    if (!txHex || typeof txHex !== 'string') throw new Error('burndep-broadcast: txHex required');
    const res = await f(`${slipstreamBase}/api/mempool/tests`, {
      method: 'POST',
      headers: mhdrs({ 'content-type': 'application/json' }),
      body: JSON.stringify({ tx_hexes: [txHex] }),
    });
    if (!res.ok) throw new Error(`burndep-broadcast: slipstream mempool test failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const results = await res.json();
    return Array.isArray(results) ? results[0] : results;
  }

  async function waitForBurnDepositMined({ txid, checkConfirmed, intervalMs = 30000, timeoutMs = 6 * 60 * 60 * 1000, onUpdate, sleep } = {}) {
    if (!txid) throw new Error('burndep-broadcast: txid required');
    if (typeof checkConfirmed !== 'function') throw new Error('burndep-broadcast: inject checkConfirmed(txid) => Promise<boolean>');
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      const confirmed = await checkConfirmed(txid);
      if (confirmed) {
        if (onUpdate && last !== 'confirmed') onUpdate({ status: 'confirmed', txid });
        return { confirmed: true, txid };
      }
      let slipstream = null;
      try { slipstream = await slipstreamStatus(txid); } catch { }
      const tx = slipstream && slipstream.transaction;
      const label = slipstream && slipstream.is_next_block ? 'next-block' : tx && tx.position ? 'queued' : 'unseen';
      if (label !== last) { last = label; if (onUpdate) onUpdate({ status: label, txid, slipstream }); }
      if (Date.now() > deadline) {
        throw new Error(`burndep-broadcast: not confirmed after ${Math.round(timeoutMs / 60000)}min — check ${slipstreamBase}/api/transactions/status?tx_id=${txid} before resubmitting`);
      }
      await wait(intervalMs);
    }
  }

  async function registerBurnDeposit({ burnTxidDisplay, bundle, network = 'mainnet' } = {}) {
    if (!workerBase) throw new Error('burndep-broadcast: registerBurnDeposit needs workerBase');
    if (!burnTxidDisplay || !bundle) throw new Error('burndep-broadcast: burnTxidDisplay and bundle required');
    const res = await f(`${workerBase}/reflection/burndep?network=${network}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ burnTxidDisplay, bundle }),
    });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok || !body || !body.ok) throw Object.assign(new Error(`burndep-broadcast: registration failed${body ? '' : ` (${res.status})`}: ${body ? JSON.stringify(body) : String(text).replace(/\s+/g, ' ').slice(0, 120)}`), { status: res.status });
    return body;
  }

  async function completeBurnDepositToEthereum({ txHex, txid, burnTxidDisplay, bundle, network = 'mainnet', checkConfirmed, waitOpts } = {}) {
    const submitResult = await submitToSlipstream(txHex);
    journalPut({ txid, txHex, burnTxidDisplay: burnTxidDisplay || txid, bundle, network, stage: 'submitted', at: Date.now() });
    await waitForBurnDepositMined({ txid, checkConfirmed, ...waitOpts });
    journalPut({ txid, txHex, burnTxidDisplay: burnTxidDisplay || txid, bundle, network, stage: 'confirmed', at: Date.now() });
    const registered = await registerBurnDeposit({ burnTxidDisplay: burnTxidDisplay || txid, bundle, network });
    journalDrop(txid);
    return { submitResult, registered };
  }

  async function resumeBurnDeposit({ txid, checkConfirmed, waitOpts, resubmit = false } = {}) {
    const rec = store.load().find((r) => r.txid === txid);
    if (!rec) throw new Error(`burndep-broadcast: no pending burn deposit for ${txid}`);
    if (resubmit && rec.txHex) await submitToSlipstream(rec.txHex);
    await waitForBurnDepositMined({ txid: rec.txid, checkConfirmed, ...waitOpts });
    const registered = await registerBurnDeposit({ burnTxidDisplay: rec.burnTxidDisplay, bundle: rec.bundle, network: rec.network });
    journalDrop(rec.txid);
    return { resumed: rec, registered };
  }

  async function resumePendingBurnDeposits({ checkConfirmed, waitOpts, resubmit = false } = {}) {
    const out = [];
    for (const rec of store.load()) {
      try { out.push({ txid: rec.txid, ...(await resumeBurnDeposit({ txid: rec.txid, checkConfirmed, waitOpts, resubmit })) }); }
      catch (e) { out.push({ txid: rec.txid, error: String((e && e.message) || e) }); }
    }
    return out;
  }

  return { submitToSlipstream, waitForBurnDepositMined, registerBurnDeposit, completeBurnDepositToEthereum,
    pendingBurnDeposits, resumeBurnDeposit, resumePendingBurnDeposits,
    slipstreamStatus, slipstreamRates, testSlipstreamAccept };
}
