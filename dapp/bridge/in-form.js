// Starting a bridge from Bitcoin on the bridge page, with the key opened here (mover.js): the TAC at the key's Bitcoin address, what picking one
// costs and arrives as, the acknowledgement that a burn can't be undone, and the burn itself. A note held in an older form is first sent to
// the key's own address, and a note over the limit is split. Once started, the bridge is one of the rows above and goes on as any other does.
// With several notes it also merges them or bridges them all (bridge-all.js plans it, bridge-in.js runs it, the front page runs the same). Bridging a note
// for the holder when it is ready, paying the minted TAC out and sending it to someone else stay on the front page: the line below links there.
import { esc, parseUnits, fmtUnits, short } from '/trade/util.js?cb=509d6618';
import { TAC_BTC_ID, noteId, bridgeError, checkText, firstStep, overCap, marked, listNotes, checkNote, priceNote, freeCoins, begin, toSelf, planSet, burnMaxRate, mergeSend, startNote, tryAgain, bulkFee, runMerge, runAll } from '/bridge-in.js?cb=5a42e68b';
import { planMerge, planAll, countAll, opsCompared } from '/bridge-all.js?cb=4b6de3ff';
import { hexToBytes } from '/vendor/tacit-deps.min.js';

const said = (m) => Object.assign(new Error(m), { said: true });
let RUNNING = false;                                                              // a run of Merge or Bridge all is under way, whichever form began it
const MEMPOOL = 'https://mempool.space';
const plainError = (e) => String(e?.message || e || 'Something went wrong').replace(/^(burndep-ux|crossout-ux):\s*/, '').slice(0, 240);
const FRESH = 5 * 60e3;                                                                  // a check older than this is read again before a press goes on with it
const sats = (v) => `${Number(v).toLocaleString('en-US')} sats`;

// `mover` is the opened mover (its session holds the key, tacit.js and the explorer reads); `say(text)` is the page's status line; `repaint()` reads
// the bridges again. Returns { destroy }.
export function mountInForm(el, { mover, say = () => {}, repaint = () => {} }) {
  if (!mover?.open) { el.hidden = true; return { destroy() {} }; }
  const { key, TS, esplora } = mover.session, fmt = (v, max = 4) => fmtUnits(v, 8, max);
  // every use of the key goes through here: a key that was locked, or another opened, since the form was drawn stops the step before it signs
  const pub = key.key.pubHex, priv = () => {
    if (!key.unlocked || key.key.pubHex !== pub) throw Object.assign(said('Your Tacit key was locked or changed, so this stopped before its next step. Nothing further was sent.'), { halt: true });
    return key.priv();
  };
  let notes = null, loadErr = null, loading = null, pick = null, seq = 0, busy = false, gone = false, rv = null, capRaw = 0n, act = null, bseq = 0;
  const deep = new Map(), reviews = new Map(), flying = new Map();      // flying: the checks being read now, by note, so a second look at the same note joins the first

  el.hidden = false;
  el.innerHTML = `<div class="bo-top"><span>TAC at your Bitcoin address</span><button type="button" id="bi-re">Refresh</button></div>
    <div class="bi-notes" id="bi-notes" role="radiogroup" aria-label="TAC to bridge"><p class="bo-n">Reading your TAC on Bitcoin…</p></div>
    <div class="bi-bulk" id="bi-bulk" hidden><button type="button" id="bi-merge" aria-pressed="false">Merge notes</button><button type="button" id="bi-all" aria-pressed="false">Bridge all</button></div>
    <div class="bo-r" id="bi-bulkp" hidden></div>
    <div class="bo-r" id="bi-rcpt" hidden></div>
    <label class="bo-ack" id="bi-ackrow" hidden><input type="checkbox" id="bi-ack"><span>I understand a bridge can’t be undone once its burn confirms on Bitcoin.</span></label>
    <button class="go" type="button" id="bi-go" disabled><span>Bridge to Ethereum</span><span aria-hidden="true">→</span></button>
    <p class="bo-s" id="bi-s" role="status" hidden></p>
    <p class="bo-n"><a href="/#bridge">Make the minted TAC public, or send it to someone else: the front page →</a></p>`;
  const $ = (s) => el.querySelector(s), bar = $('#bi-bulk'), bulkp = $('#bi-bulkp'), list = $('#bi-notes'), rc = $('#bi-rcpt'), go = $('#bi-go'), ack = $('#bi-ack'), ackRow = $('#bi-ackrow'), st = $('#bi-s'), re = $('#bi-re');
  const status = (h, cls = '') => { st.hidden = !h; st.className = `bo-s ${cls}`; st.innerHTML = h; };
  const gate = () => { go.disabled = busy || !rv?.r?.ok || rv.r.short || !ack.checked; };
  const warn = (html) => { rc.hidden = false; rc.insertAdjacentHTML('beforeend', `<p class="bo-n bo-e">${html}</p>`); };
  // the review and its acknowledgement are void as soon as another note is picked, not when the new one has been read; a check still being read for
  // the note before is void with them (it would otherwise show an acknowledgement for a receipt that is no longer on the page)
  const stale = () => { seq++; rv = null; ack.checked = false; ackRow.hidden = true; gate(); };
  const mem = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* the plan is a convenience */ } } };
  const open = () => (notes || []).filter((n) => n.reason !== 'already bridging').map((n) => marked(n, deep));

  const reasonHtml = (n) => (n.reason === 'unconfirmed' ? 'Waiting for its Bitcoin confirmation'
    : /stealth/.test(n.reason || '') ? 'Received privately: <a href="/classic.html" target="_blank" rel="noopener">open it in the classic app</a> first.' : esc(n.reason || ''));
  function paintNotes() {
    if (gone) return;
    if (!busy) paintBulk();
    if (loadErr) { list.innerHTML = `<p class="bo-n bo-e">${esc(plainError(loadErr))}</p>`; return; }
    if (!notes) { list.innerHTML = '<p class="bo-n">Reading your TAC on Bitcoin…</p>'; return; }
    const ns = open();
    if (!ns.length) { list.innerHTML = '<p class="bo-n">No TAC at this key’s Bitcoin address. <a href="/#bitcoin/receive">Receive TAC on Bitcoin</a>. TAC bridged from Ethereum is under To Bitcoin.</p>'; return; }
    list.innerHTML = ns.map((n) => {
      const id = noteId(n), amount = `${fmt(BigInt(n.amount))} TAC`;
      if (overCap(n)) {
        return `<div class="bi-note bi-over"><span><b>${esc(amount)}</b><small>Over 1,000 TAC, the most one bridge takes. Split some off to your own address, then bridge that.</small></span>
          <span class="bi-split"><input data-split-in="${esc(id)}" inputmode="decimal" value="1000" autocomplete="off" aria-label="TAC to split off"><button type="button" data-split="${esc(id)}">Split off</button></span></div>`;
      }
      const note = !n.eligible ? reasonHtml(n) : esc(firstStep(n));
      return `<label class="bi-note${n.eligible ? '' : ' off'}"><input type="radio" name="bi-note" value="${esc(id)}" ${n.eligible ? '' : 'disabled'} ${pick === id ? 'checked' : ''}>
        <span><b>${esc(amount)}</b>${note ? `<small>${note}</small>` : ''}</span></label>`;
    }).join('');
  }

  // ── Merge notes and Bridge all (bridge-all.js plans them) ────────────────────────────────────────────────────────────
  const tac = (v) => `${fmt(BigInt(v))} TAC`;
  const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const noteCount = (n) => `${n} note${n === 1 ? '' : 's'}`;
  const bulkPlans = () => {
    const ns = open();
    if (!capRaw || ns.filter((n) => n.eligible).length < 2) return null;
    const all = planAll(ns, { capRaw });
    return countAll(all) > 1 ? { merge: planMerge(ns, { capRaw }), all } : null;
  };
  const recentLine = (skipped) => { const n = skipped.filter((x) => x.why === 'recent').length; return n ? `<p class="bo-n">${noteCount(n)} too recent for Bitcoin’s proof to have seen ${n === 1 ? 'stays' : 'stay'} out of this.</p>` : ''; };
  const bulkHtml = (kind, bulk) => {
    if (kind === 'merge') {
      const g = bulk.merge.groups, count = g.reduce((t, x) => t + x.notes.length, 0);
      return `<div class="kv"><span>Merge</span><b>${noteCount(count)} into ${noteCount(g.length)}: ${esc(and(g.map((x) => tac(x.total))))}</b></div>
        <div class="kv"><span>Bitcoin fee</span><b id="bi-bfee">Checking…</b></div>
        <div class="kv"><span>Then</span><b>Each can be bridged here once Bitcoin’s proof on Ethereum has seen it, usually within a few hours</b></div>
        ${recentLine(bulk.merge.skipped)}
        <button class="go" type="button" id="bi-bgo"><span>Merge ${noteCount(count)}</span></button>`;
    }
    const a = bulk.all, sent = a.sends.reduce((t, g) => t + g.notes.length, 0) + a.privates.length, nSends = a.sends.length + a.privates.length, count = countAll(a), ops = opsCompared(bulk.merge, a);
    const total = [...a.burns, ...a.sends.flatMap((g) => g.notes), ...a.privates, ...a.checks].reduce((t, n) => t + BigInt(n.amount), 0n);
    return `<div class="kv"><span>Bridge</span><b>${esc(tac(total))} from ${noteCount(count)}</b></div>
      ${a.burns.length ? `<div class="kv"><span>Burned now</span><b>${noteCount(a.burns.length)}, one Bitcoin transaction each</b></div>` : ''}
      ${nSends ? `<div class="kv"><span>Sent first</span><b>${noteCount(sent)} in ${nSends} send${nSends === 1 ? '' : 's'} to your own address; bridge them here once they are ready</b></div>` : ''}
      ${a.checks.length ? `<div class="kv"><span>Checked one by one</span><b>${noteCount(a.checks.length)}: a move, then a burn through a miner, sent for you while this page is open</b></div>` : ''}
      <div class="kv"><span>Bitcoin fee</span><b id="bi-bfee">Checking…</b></div>
      <div class="kv"><span>Arrives</span><b>Within a few hours of each burn${nSends ? '; the notes sent first take a few hours longer' : ''}</b></div>
      ${ops.merge < ops.all ? `<p class="bo-n">Merge notes first would take ${ops.merge} Bitcoin transactions in all instead of ${ops.all}, and a few hours longer.</p>` : ''}
      ${recentLine(a.skipped)}
      <label class="bo-ack"><input type="checkbox" id="bi-ball"><span>I understand a bridge can’t be undone once its burn confirms on Bitcoin.</span></label>
      <button class="go" type="button" id="bi-bgo" disabled><span>Bridge ${noteCount(count)}</span></button>`;
  };
  function paintBulk() {
    const bulk = bulkPlans(), my = ++bseq;
    if (act && (!bulk || (act === 'merge' && !bulk.merge.groups.length))) act = null;
    bar.hidden = !bulk;
    $('#bi-merge').hidden = !bulk?.merge.groups.length;
    for (const k of ['merge', 'all']) $(`#bi-${k}`).setAttribute('aria-pressed', String(act === k));
    go.hidden = !!act;
    if (!bulk || !act) { bulkp.hidden = true; bulkp.innerHTML = ''; return; }
    if (busy) return;
    bulkp.hidden = false; bulkp.innerHTML = bulkHtml(act, bulk);
    const bgo = $('#bi-bgo'), box = $('#bi-ball'), kind = act;
    let short = false, quotedAt = 0;                                                   // the press waits for the fee, and for a fee read lately
    const gateB = () => { bgo.disabled = busy || short || !quotedAt || (!!box && !box.checked); };
    gateB();
    if (box) box.addEventListener('change', gateB);
    TS.withKey((t) => freeCoins(t), pub).then(async (coins) => bulkFee(await TS.load(), { bulk, kind, coins })).then((q) => {
      if (!q || my !== bseq || gone) return;
      short = q.short; quotedAt = Date.now();
      const fee = $('#bi-bfee');
      if (fee) fee.textContent = `≈ ${q.fee.toLocaleString('en-US')} sats${q.later ? `, and about ${q.later.toLocaleString('en-US')} for the burns after` : ''}`;
      if (short) bulkp.insertAdjacentHTML('beforeend', `<p class="bo-n bo-e">This key’s Bitcoin address has ${esc(q.free.toLocaleString('en-US'))} sats free for fees, short of the about ${esc(q.need.toLocaleString('en-US'))} sats this needs. <a href="/#bitcoin/receive">Add bitcoin to it</a></p>`);
      gateB();
    }).catch(() => { if (my === bseq) { const fee = $('#bi-bfee'); if (fee) fee.textContent = 'not quoted just now: close this and open it again'; } });
    bgo.addEventListener('click', () => {
      if (Date.now() - quotedAt > FRESH) { paintBulk(); return status('The fees were read again. Look them over, then press once more.'); }
      runBulk(kind, bulk);
    });
  }
  // the transactions of one press, sent under the key one after another; what was sent is said, and what was not, with why
  async function runBulk(kind, bulk) {
    if (busy) return;
    if (RUNNING) return status('A run of Merge or Bridge all is still under way. Wait for it to finish.', 'bo-e');
    busy = true; RUNNING = true; gate(); re.disabled = true; bar.querySelectorAll('button').forEach((b) => { b.disabled = true; }); $('#bi-bgo').disabled = true;
    // with the form closed meanwhile, the run stops before its next transaction and says how it ended on the page's own line
    const textOf = (h) => new DOMParser().parseFromString(h, 'text/html').body.textContent;
    const out = (h, cls = '') => (gone ? say(textOf(h)) : status(h, cls));
    const say2 = (m) => { if (!gone) status(esc(m)); }, plan = { at: Date.now() };
    const live = () => { if (gone) throw Object.assign(said('This form was closed, so the run stopped before its next step.'), { halt: true }); priv(); };
    const withKey = (fn) => TS.withKey(fn, pub), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const again = (fn, sent) => tryAgain({ fn, sentBefore: sent, fresh: () => withKey((t) => { t.invalidateHoldingsCache?.(); }), sleep });
    const merge = async (ns) => { live(); return mergeSend({ withKey, mem, pub, notes: ns, plan }); };
    try {
      priv();
      const T = await TS.load();
      if (kind === 'merge') {
        const { did, left } = await runMerge({ groups: bulk.merge.groups, merge, tryAgain: again, say: say2, errText: plainError });
        const n = did.reduce((t, d) => t + d.n, 0);
        out(`${did.length ? `<span class="bo-ok">✓ ${noteCount(n)} merged into ${noteCount(did.length)}: ${esc(and(did.map((d) => tac(d.amount))))}.</span> They can be bridged from here once they confirm and Bitcoin’s proof on Ethereum has seen them, usually within a few hours.` : ''}${left.length ? `${did.length ? '<br>' : ''}<span class="bo-e">${left.length === 1 ? esc(left[0]) : esc(`${noteCount(left.length)} were not merged: ${left.join('; ')}`)}</span>` : ''}`);
      } else {
        const start = async (n) => { live(); return startNote(T, { withKey, mem, pub, walletPub: hexToBytes(pub), priv: () => priv(), note: n, errText: plainError }); };
        const { did, left } = await runAll({ all: bulk.all, merge, start, tryAgain: again, say: say2, errText: plainError, amountText: (n) => tac(n.amount) });
        const parts = [did.burns ? `${noteCount(did.burns)} bridging` : '', did.sends ? `${noteCount(did.sent)} sent to your own address in ${did.sends} send${did.sends === 1 ? '' : 's'}, to be bridged from here once ready` : ''].filter(Boolean);
        out(`${parts.length ? `<span class="bo-ok">✓ ${esc(parts.join('; '))}.</span> The bridges show under Your bridges and finish on their own while this page is open with your key.` : ''}${left.length ? `${parts.length ? '<br>' : ''}<span class="bo-e">${left.length === 1 ? esc(left[0]) : esc(`${noteCount(left.length)} were left: ${left.join('; ')}`)}</span>` : ''}`);
      }
      act = null; reviews.clear();
      mover.tick(true);
    } catch (e) { out(esc(bridgeError(e, plainError)), 'bo-e'); }
    finally { busy = false; RUNNING = false; if (!gone) { re.disabled = false; bar.querySelectorAll('button').forEach((b) => { b.disabled = false; }); gate(); repaint(); notes = null; paintNotes(); load(true); } else repaint(); }
  }

  function load(force = false) {
    if (loading) return loading;
    loadErr = null;
    return (loading = TS.withKey((t) => { capRaw = BigInt(t.bridgeUx().BURNDEP_BETA_CAP_RAW); return listNotes(t, { force, esplora }); }, pub).then((ns) => { if (!gone) notes = ns; }, (e) => { if (!gone) { notes = null; loadErr = e; } })
      .finally(() => {
        loading = null;
        if (gone) return;
        const ok = open().filter((n) => n.eligible);
        if (pick && !ok.some((n) => noteId(n) === pick)) { pick = null; stale(); rc.hidden = true; }
        if (!pick && !act && ok.length === 1) pick = noteId(ok[0]);
        paintNotes();
        if (pick && !rv && !flying.has(pick)) check();
      }));
  }

  async function check() {
    stale(); rc.innerHTML = '';
    const my = ++seq, id = pick;
    const n = open().find((x) => noteId(x) === id && x.eligible);
    if (!n) { rc.hidden = true; return; }
    rc.hidden = false; rc.innerHTML = '<p class="bo-n">Checking this TAC and Bitcoin’s fees…</p>';
    try {
      const T = await TS.load();
      let r = reviews.get(id);
      r = r && Date.now() - r.at < 120e3 ? r : null;
      if (!r) {
        // a long history is read in parts over a minute or more: the line says how far it has got, and a second look at the note joins the reading
        let p = flying.get(id);
        if (!p) {
          p = checkNote(T, { note: n, walletPub: hexToBytes(pub),
            onProgress: (read) => { if (pick === id && !gone && !rc.querySelector('.kv, .bo-e')) rc.innerHTML = `<p class="bo-n">Reading this TAC’s history from Bitcoin: ${Number(read).toLocaleString('en-US')} transfers so far…</p>`; } })
            .finally(() => { if (flying.get(id) === p) flying.delete(id); });
          flying.set(id, p);
        }
        const checked = await p;
        r = { at: Date.now(), r: checked };
        if (checked.ok) reviews.set(id, r);
      }
      if (my !== seq || gone || pick !== id) return;
      if (!r.r.ok) { rc.innerHTML = ''; return notOk(n, r.r, my); }
      // the coins free for fees are read after the check, every time: they change while a long history is read, and while the receipt sits on the page
      const got = priceNote(T, { note: n, pf: r.r.pf, coins: await TS.withKey((t) => freeCoins(t), pub) });
      if (my !== seq || gone || pick !== id) return;
      rc.innerHTML = '';
      const one = got.one, c = got.cost;
      rc.innerHTML = `<div class="kv"><span>You get</span><b>${esc(fmt(BigInt(n.amount)))} private TAC on Ethereum</b></div>
        <div class="kv"><span>Bitcoin fee</span><b>≈ ${esc(sats(c.fee))}${one ? '' : `, and about ${esc(sats(c.later))} for the burn later`}</b></div>
        <div class="kv"><span>Relay fee</span><b>None</b></div>
        <div class="kv"><span>How</span><b>${one ? 'One Bitcoin transaction' : 'A move, then a burn through a miner'}</b></div>
        <div class="kv"><span>Arrives</span><b>${one ? 'Usually within a few hours, once Bitcoin’s proof on Ethereum records the burn' : 'A move, then a burn, each waiting for Bitcoin’s proof on Ethereum: usually within a day'}</b></div>
        ${one ? '' : '<label class="bo-ack"><input type="checkbox" id="bi-selfburn" checked><span>Send the burn for me once the move is ready. This page must be open with my key.</span></label>'}`;
      if (got.short) {
        const have = BigInt(c.have || 0);
        warn(one ? `This key’s Bitcoin address has ${esc(fmtUnits(have, 8, 8))} BTC free for fees, short of the ${esc(sats(c.need))} this needs. <a href="/#bitcoin/receive">Add bitcoin to it</a>`
          : `The move spends one coin whole: the largest free coin on this key’s Bitcoin address holds ${esc(fmtUnits(have, 8, 8))} BTC, and this needs one of ${esc(sats(c.need))}. <a href="/#bitcoin/receive">Add bitcoin to it</a>`);
      }
      rv = { at: r.at, r: got, id };                                                   // `at`: when the rates were read, which is what goes stale
      ackRow.hidden = false; gate();
    } catch (e) { if (my === seq && !gone) { rc.innerHTML = ''; warn(esc(bridgeError(e, plainError))); } }
  }

  // a note the check would not pass: what it said, and for the two forms that go to the key's own address first, the way to do that
  async function notOk(n, got, my) {
    const bad = got.pf.steps.find((s) => !s.ok) || { name: '' };
    warn(esc(checkText(bad, plainError)));
    if (bad.tooLong || bad.unprovable) { deep.set(noteId(n), bad); pick = null; paintNotes(); return; }
    if (bad.name !== 'reflected' && bad.name !== 'old-leaf') return;
    const coins = await TS.withKey((t) => freeCoins(t), pub);
    if (my !== seq || gone) return;
    if (coins && !coins.some((c) => Number(c?.value) > 0)) {
      warn('The send pays a small Bitcoin fee, and this key’s Bitcoin address has no BTC free for it. <a href="/#bitcoin/receive">Add bitcoin to it</a>, then pick this note again.');
      return;
    }
    rc.insertAdjacentHTML('beforeend', `<p class="bo-n">After it confirms, it is listed here and can be bridged, usually within a few hours.</p>
      <button class="go ghost" type="button" id="bi-prep"><span>Send it to my own address</span></button>`);
    $('#bi-prep').addEventListener('click', () => prepare(n));
  }

  // the Bitcoin transactions of this form (the send to one's own address, a split) are sent under the key, one at a time
  async function send(n, amount) {
    if (busy) return;
    busy = true; gate(); re.disabled = true;
    const shown = `${fmt(amount)} TAC`, split = amount < BigInt(n.amount);
    try {
      priv();
      status(split ? `Splitting ${esc(shown)} off…` : 'Sending it to your own address…');
      const { txid } = await TS.withKey((t) => toSelf(t, TAC_BTC_ID, [n], amount, 'TAC note'), pub);
      pick = null; reviews.clear(); stale(); rc.hidden = true;
      status(`<span class="bo-ok">✓ ${split ? `${esc(shown)} split off to your own address` : `${esc(shown)} sent to your own address`}.</span> <a href="${MEMPOOL}/tx/${esc(txid)}" target="_blank" rel="noopener">${esc(short(txid, 6))} ↗</a> It is listed here once it confirms, and can be bridged then.`);
    } catch (e) {
      status(esc(/insufficient (plain )?sats|no plain-sats/i.test(String(e?.message)) ? 'Not enough BTC for this and its Bitcoin fee.' : bridgeError(e, plainError)), 'bo-e');
    } finally { busy = false; re.disabled = false; gate(); notes = null; paintNotes(); load(true); }
  }
  const prepare = (n) => send(n, BigInt(n.amount));
  function split(id) {
    const n = open().find((x) => noteId(x) === id), box = list.querySelector(`[data-split-in="${CSS.escape(id)}"]`);
    if (!n || !box) return;
    const v = parseUnits(box.value, 8);
    if (!v || v > capRaw) return status('Enter an amount up to 1,000 TAC.', 'bo-e');
    if (v >= BigInt(n.amount)) return status('Enter less than this note holds.', 'bo-e');
    return send(n, v);
  }

  async function start() {
    const x = rv;
    if (!x?.r?.ok || x.r.short || busy || !ack.checked) return;
    const n = x.r.note, id = x.id;
    // fees read a while ago are read again, and the holder presses once more on what they now see
    if (Date.now() - x.at > FRESH) { reviews.delete(id); status('The fees were read again. Look them over, then press once more.'); return check(); }
    busy = true; gate(); re.disabled = true;
    const amount = `${fmt(BigInt(n.amount))} TAC`, one = x.r.pf.path === 'reflected';
    try {
      priv();
      status(one ? 'Signing the burn and sending it to Bitcoin…' : 'Signing the move to its burn address and sending it to Bitcoin…');
      const selfBurn = !one && !!$('#bi-selfburn')?.checked;
      const rec = await TS.withKey((t) => begin(t, { review: x.r, priv: priv() }), pub);
      if (selfBurn) planSet(mem, pub, rec.id, { at: Date.now(), burn: { maxRate: burnMaxRate(x.r.pf) } });
      const tx = rec.burn?.txid || rec.migrate?.revealTxid, sent = !/-signed$/.test(rec.stage);
      pick = null; reviews.clear(); stale(); rc.innerHTML = ''; rc.hidden = true;
      status(sent
        ? `<span class="bo-ok">✓ ${one ? 'Burn' : 'Move'} sent.</span>${tx ? ` <a href="${MEMPOOL}/tx/${esc(tx)}" target="_blank" rel="noopener">${esc(short(tx, 6))} ↗</a>` : ''} ${esc(amount)} shows under Your bridges and ${one ? 'finishes on its own, even if you close this page' : `goes on from there: ${selfBurn ? 'its burn is sent for you once Bitcoin’s proof reaches the move, while this page is open with your key' : 'its burn is sent from its row once Bitcoin’s proof reaches the move'}`}.`
        : `<span class="bo-e">Signed, but Bitcoin did not take it yet.</span> Try again from its row under Your bridges.`);
      mover.tick(true);
    } catch (e) {
      status(esc(bridgeError(e, plainError)), 'bo-e');
      // after a failure the check is read again before another press, and acknowledged again
      reviews.delete(id); stale();
    } finally { busy = false; re.disabled = false; gate(); repaint(); notes = null; paintNotes(); load(true); }
  }

  list.addEventListener('change', (e) => {
    const r = e.target.closest('input[name="bi-note"]');
    if (busy) return paintNotes();                                                   // the receipt on the page is the burn's: the list goes back to the note it is for
    if (!r) return;
    if (act) { act = null; paintBulk(); }
    pick = r.value; status(''); check();
  });
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-split]'); if (b && !busy) split(b.dataset.split); });
  for (const k of ['merge', 'all']) $(`#bi-${k}`).addEventListener('click', () => {
    if (busy) return;
    act = act === k ? null : k;
    if (act) { pick = null; stale(); rc.hidden = true; status(''); }
    paintNotes();
  });
  ack.addEventListener('change', gate);
  go.addEventListener('click', start);
  re.addEventListener('click', () => { if (busy) return; notes = null; reviews.clear(); stale(); rc.hidden = true; paintNotes(); load(true); });
  load();
  return { destroy() { gone = true; seq++; el.hidden = true; el.innerHTML = ''; } };
}
