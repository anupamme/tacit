// Starting a bridge to Bitcoin from the bridge page, with the key opened here (mover.js): the amount, what it costs and arrives as, the
// acknowledgement that a burn can't be undone, and the burn itself, proved by the relay. A note of exactly the amount is spent whole; if none is,
// the relay cuts one to size first. Anything the relay will not take, and proving the burn oneself, is the front page's: the status line links there.
import { getUx } from '/trade/poolux.js?cb=e792b253';
import { esc, parseUnits, fmtUnits, plain, short } from '/trade/util.js?cb=509d6618';
import { OUT_ASSETS, ladder, feeShort, makeOutFee, limitText, proofWarn, proofProblem, fundingText } from '/bridge-out.js?cb=3e9b426a';
import { notesOf, exactOf, cutPick, cut } from '/farm-ops.js?cb=4470442d';
import { advanceOut, waitRanOut } from '/bridge-tick.js?cb=84475d9e';

const API = 'https://api.tacit.finance';
const outFee = makeOutFee({ api: API });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refused = (e) => e?.code === 'relay_held' || e?.code === 'relay_paused' || e?.httpStatus === 429 || /relay (4\d\d|held|paused)|can’t take this one|free (relayed )?settles/i.test(String(e?.message || ''));
const said = (m) => Object.assign(new Error(m), { said: true });

// `mover` is the opened mover (its session holds the key, tacit.js and the relay runner); `say(html, front)` is the status line; `repaint()` reads
// the bridges again. Returns { destroy }.
export function mountOutForm(el, { asset, mover, say = () => {}, repaint = () => {} }) {
  const a = OUT_ASSETS[asset];
  if (!a || !mover?.open) { el.hidden = true; return { destroy() {} }; }
  const { key, TS, run } = mover.session, fmt = (v, max = a.dp) => fmtUnits(v, 8, max);
  const pub = key.key.pubHex, priv = () => key.priv();
  let q = null, seq = 0, busy = false, bal = null, pf = null, gone = false;

  el.hidden = false;
  el.innerHTML = `<div class="bo-top"><span>Amount</span><button type="button" id="bo-max" disabled>Use the most</button></div>
    <div class="bo-amt"><input id="bo-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${esc(a.ticker)} to bridge to Bitcoin"><span>${esc(a.ticker)}</span></div>
    <div class="bo-r" id="bo-rcpt" hidden></div>
    <label class="bo-ack" id="bo-ackrow" hidden><input type="checkbox" id="bo-ack"><span>I understand a bridge can’t be undone once it is burned on Ethereum.</span></label>
    <button class="go" type="button" id="bo-go" disabled><span>Bridge to Bitcoin</span><span aria-hidden="true">→</span></button>
    <p class="bo-s" id="bo-s" role="status" hidden></p>`;
  const $ = (s) => el.querySelector(s), amt = $('#bo-amt'), rc = $('#bo-rcpt'), go = $('#bo-go'), ack = $('#bo-ack'), ackRow = $('#bo-ackrow'), maxBtn = $('#bo-max'), st = $('#bo-s');
  const status = (h, cls = '') => { st.hidden = !h; st.className = `bo-s ${cls}`; st.innerHTML = h; };
  const front = (text) => status(`${esc(text)} <a href="/#bridge/out">Do it on the front page →</a>`, 'bo-e');
  const gate = () => { go.disabled = busy || !q?.ok || !ack.checked; };
  const warn = (text) => { rc.hidden = false; rc.insertAdjacentHTML('beforeend', `<p class="bo-n bo-e">${esc(text)}</p>`); };

  async function notes(fresh = false) {
    if (!bal || fresh || Date.now() - bal.at > 30e3) bal = { at: Date.now(), v: await (await getUx()).balance(priv()) };
    return notesOf(bal.v.notes, a.id);
  }
  const held = (ns) => ns.reduce((s, n) => s + BigInt(n.value), 0n);
  async function preflight(ux, fresh = false) {
    if (!fresh && pf && Date.now() - pf.at < 120e3) return pf.v;
    const v = await TS.withKey(() => ux.preflight({ walletPriv: priv() }), pub);
    if (v.ok) pf = { at: Date.now(), v };
    return v;
  }

  async function check() {
    const my = ++seq, units = parseUnits(amt.value, 8);
    q = null; ackRow.hidden = true; ack.checked = false; gate(); rc.innerHTML = ''; status('');
    if (!units) { rc.hidden = true; return; }
    rc.hidden = false; rc.innerHTML = '<p class="bo-n">Checking the fees and the proof…</p>';
    try {
      const [t, T] = await Promise.all([getUx(), TS.load()]), ux = T.crossoutUx(), lim = ux.assetOf(a.id);
      if (!lim) throw said(`${a.ticker} cannot be bridged to Bitcoin from this deployment.`);
      const min = lim.minRaw > 0n ? lim.minRaw : a.min, fee = await outFee(t, a), ns = await notes(), exact = exactOf(ns, units);
      const size = exact ? 0n : BigInt(await t.quoteOpFee(a.pool, 'transfer')), have = held(ns), p = await preflight(ux);
      if (my !== seq || gone) return;
      rc.innerHTML = `<div><span>You get</span><b>${units > fee ? fmt(units - fee, 8) : '0'} ${esc(a.ticker)} on your Bitcoin address</b></div>
        <div><span>Relay fee</span><b>${fmt(fee, 8)} ${esc(a.ticker)}</b></div>
        ${size ? `<div><span>Relay fee to cut a note to size</span><b>${fmt(size, 8)} ${esc(a.ticker)}</b></div>` : ''}
        <div><span>Bitcoin fee, when it is sent</span><b>≈ ${p.estSats.toLocaleString('en-US')} sats from ${esc(short(p.address, 6))}</b></div>
        <div><span>Arrives</span><b>usually a few hours, sometimes up to a day</b></div>`;
      let ok = true;
      const limit = limitText({ units, fee, min, cap: lim.capRaw, ticker: a.ticker, fmt });
      if (limit) { warn(limit); ok = false; }
      else if (units + size > have) { warn(have ? `Your private ${a.ticker} is ${fmt(have, 8)}: this needs ${fmt(units + size, 8)} with the relay’s fee to cut a note to size.` : `You have no private ${a.ticker} yet.`); ok = false; }
      else if (!exact && !cutPick(ns, units, size)) { warn('Your notes do not cover this and the relay’s fee to cut one to size. Try a little less.'); ok = false; }
      if (!p.ok) { ok = false; warn(proofProblem); }
      for (const w of p.warnings) { const text = proofWarn(w, p.reflection?.lagBlocks || 0); if (text) rc.insertAdjacentHTML('beforeend', `<p class="bo-n">${esc(text)}</p>`); }
      if (ok) {
        const noCoin = p.warnings.some((w) => w.name === 'funding');
        rc.insertAdjacentHTML('beforeend', noCoin
          ? `<p class="bo-n">${esc(fundingText(p, (s) => fmtUnits(BigInt(s), 8, 8)))} Send bitcoin to it from any wallet or exchange: <code>${esc(p.address)}</code></p>`
          : `<p class="bo-n">The Bitcoin step is paid from that address when it is sent, hours from now. Keep about ${p.needSats.toLocaleString('en-US')} sats on it until then.</p>`);
      }
      q = { ok, units, fee, size };
      ackRow.hidden = !ok; gate();
    } catch (e) { if (my === seq && !gone) { rc.innerHTML = ''; warn(String(e?.message || e).replace(/^crossout-ux:\s*/, '').slice(0, 200)); } }
  }

  // a note of exactly `units`, once the cut that makes it shows in the balance
  async function noteShows(t, units) {
    for (let i = 0; i < 8; i++) { const n = exactOf(await notes(true), units); if (n) return n; await sleep(5000); }
    throw said('The note cut for this is not showing yet. It is in your private balance: press again in a minute.');
  }
  const settled = (r) => { if (r?.jobId) run().journal.put('job:' + r.jobId, { status: 'settled', hash: r.txHash || undefined }); };

  async function start() {
    const x = q;
    if (!x?.ok || busy) return;
    busy = true; gate(); maxBtn.disabled = true; amt.disabled = true;
    const amtText = `${fmt(x.units)} ${a.ticker}`;
    try {
      const [t, T] = await Promise.all([getUx(), TS.load()]), ux = T.crossoutUx();
      status('Checking Bitcoin and the proof once more…');
      if (!(await preflight(ux, true)).ok) throw said('Bitcoin or its proof could not be read, so nothing was burned. Try again in a minute.');
      const ns = await notes(true);
      let note = exactOf(ns, x.units);
      if (!note) {
        const pick = cutPick(ns, x.units, x.size);
        if (!pick) throw said(`Your private ${a.ticker} does not cover ${amtText} and the relay’s fee to cut a note to size.`);
        status(`The relay is cutting a note of ${esc(amtText)} first…`);
        settled(await cut(t, priv(), pick, x.units, x.size, run().wait(`Split a note to ${amtText}`, 15 * 60e3)));
        note = await noteShows(t, x.units);
      }
      if (String(note.asset).toLowerCase() !== a.id) throw said(`The note picked for this is not ${a.ticker}, so nothing was burned.`);
      status('The relay is proving the burn…');
      const wait = () => run().wait(`Bridge ${amtText} to Bitcoin`, 15 * 60e3), begin = (fee) => ux.start({ note, walletPriv: priv(), fee, waitOpts: wait() });
      let rec;
      try {
        try { rec = await begin(x.fee); }
        catch (e0) { const up = ladder(x.fee * 2n); if (feeShort(e0) && !waitRanOut(e0) && up * 2n < x.units) rec = await begin(up); else throw e0; }
      } catch (e) {
        if (waitRanOut(e)) throw said('The relay is taking longer than usual. If the burn went through it shows under Your bridges on its own; do not send it again.');
        if (!(refused(e) || feeShort(e))) throw e;
        if (!/relay 5\d\d\b|temporarily unavailable/i.test(String(e?.message || e))) await ux.cancelIntent(pub, note.nullifier).catch(() => {});
        return front('The relay can’t take this burn right now. Nothing was burned.');
      }
      try { rec = await advanceOut(ux, pub, rec, { withKey: TS.withKey, priv, keyPub: () => key.key?.pubHex }); } catch { /* the next pass goes on with it */ }
      amt.value = ''; q = null; bal = null; pf = null; rc.innerHTML = ''; rc.hidden = true; ackRow.hidden = true; ack.checked = false;
      status(rec.settle?.claimIdVerified === false
        ? 'Burned on Ethereum, but its claim was not matched to the record there, so the Bitcoin step is held back. It shows under Your bridges: check it again on the front page.'
        : `<span class="bo-ok">✓ Burned on Ethereum.</span>${rec.settle?.txHash ? ` <a href="https://etherscan.io/tx/0x${esc(String(rec.settle.txHash).replace(/^0x/, ''))}" target="_blank" rel="noopener">${esc(short('0x' + String(rec.settle.txHash).replace(/^0x/, ''), 6))} ↗</a>` : ''} The Bitcoin step goes on by itself while this page is open with your key.`);
      mover.tick(true);
    } catch (e) {
      const m = String(e?.message || e).replace(/^crossout-ux:\s*/, '').slice(0, 220);
      status(`${esc(m)}${e?.said ? '' : ' <a href="/#bridge/out">Try it on the front page →</a>'}`, 'bo-e');
    } finally { busy = false; amt.disabled = false; maxBtn.disabled = false; gate(); repaint(); }
  }

  notes(true).then((ns) => { if (gone) return; maxBtn.disabled = false; maxBtn.title = `${fmt(held(ns), 8)} ${a.ticker} private`; maxBtn.textContent = `Use the most (${fmt(held(ns), 4)} ${a.ticker})`; }, () => {});
  let timer = null;
  amt.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(check, 350); });
  ack.addEventListener('change', gate);
  maxBtn.addEventListener('click', async () => {
    const [ns, T] = await Promise.all([notes(), TS.load()]), cap = T.crossoutUx().assetOf(a.id)?.capRaw, h = held(ns), v = cap != null && cap < h ? cap : h;
    amt.value = v ? plain(v, 8) : ''; check();
  });
  go.addEventListener('click', start);
  return { destroy() { gone = true; seq++; clearTimeout(timer); el.hidden = true; el.innerHTML = ''; } };
}
