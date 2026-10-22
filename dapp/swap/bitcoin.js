// The swap page's Bitcoin lane: tETH and TAC swapped in the Bitcoin pool, signed by a Tacit key. The page loads this when the lane is first opened. tacit.js
// comes with it through the trade page's Bitcoin module, which also holds the key's sign-in. Nothing here builds or signs a transaction: tacit.js does.
import { esc, fmtUnits, parseUnits, plain } from '/trade/util.js?cb=509d6618';

const BTC_MODULE = '/trade/btc.js?cb=32bedf68';
const TETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const TOKENS = { [TETH]: { sym: 'tETH', icon: 'teth', dec: 8 }, [TAC]: { sym: 'TAC', icon: 'tac', dec: 8 } };
const SLIPS = [50, 100, 300];
const MOVE_SATS = 5000, DUST = 546, IMPACT_WARN = 0.05, IMPACT_ACK = 0.1;
const STAGES = { check: 'Checking the pool…', prepare: 'Cutting the exact amount (one Bitcoin transaction pair)…', send: 'Sending the swap…' };
const MEMPOOL = 'https://mempool.space';
const SLIP_KEY = 'tacit-swap-btc-slip-v1';

const tidy = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const fmt = (v, aid, max = 8) => fmtUnits(v, TOKENS[aid].dec, max);

export function makeBitcoinLane({ host, notify = () => {}, wallet = () => null }) {
  let slip = 100;
  try { const s = Number(localStorage.getItem(SLIP_KEY)); if (SLIPS.includes(s)) slip = s; } catch { /* storage is a convenience */ }
  const L = { pay: TETH, get: TAC, amt: '', q: null, pool: null, noPool: false, bal: {}, sats: null, need: null, notes: [], unread: 0, bridgedAt: 0, ack: false, busy: false, sent: null, asking: null, line: '', cls: '', open: false };
  let bitcoin = null, T = null, mounted = false, seq = 0, qTimer = 0, poll = 0, refreshTimer = 0, reading = null;
  const $ = (id) => host.querySelector(`#${id}`);

  host.innerHTML = `
    <div class="f" id="b-pay">
      <div class="fh"><span>You pay</span><span class="where">on Bitcoin</span></div>
      <div class="fm"><input class="amt" id="b-amt" inputmode="decimal" placeholder="0" autocomplete="off" spellcheck="false" aria-label="Amount to pay"><span class="coin" id="b-pay-coin"></span></div>
      <div class="ff"><span id="b-bal" class="num"></span><span class="quick" id="b-quick"></span></div>
    </div>
    <div class="mid"><button class="flip" id="b-flip" type="button" aria-label="Swap the two sides"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v17m0 0-4-4m4 4 4-4M16 21V4m0 0-4 4m4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    <div class="f" id="b-get">
      <div class="fh"><span>You get</span><span class="where">on Bitcoin</span></div>
      <div class="fm"><output class="big ph num" id="b-out" for="b-amt">0</output><span class="coin" id="b-get-coin"></span></div>
      <div class="ff"><span id="b-get-bal" class="num"></span><span></span></div>
    </div>
    <dl class="rcpt" id="b-rcpt" hidden></dl>
    <div class="brd" id="b-brd" hidden></div>
    <div class="act">
      <div class="ack" id="b-ack" hidden><label><input type="checkbox" id="b-ackbox"> <span id="b-acktext"></span></label></div>
      <button class="go" id="b-go" type="button" disabled>Open your Tacit wallet</button>
      <p class="q" id="b-q" role="status"></p>
    </div>
    <div class="sw-foot"><span>Slippage</span><span class="slip" id="b-slip" role="group" aria-label="Slippage"></span></div>`;

  const say = (h, cls = '') => { L.line = h; L.cls = cls; const q = $('b-q'); q.className = `q${cls ? ` ${cls}` : ''}`; q.innerHTML = h; };

  // ── the library, the key and the pool ──
  async function ensure() {
    if (!bitcoin) {
      const m = await import(BTC_MODULE);
      bitcoin = m.makeBitcoin({ notify, wallet, onChange: () => { if (L.open) { paint(); readMe(true); } }, asset: { id: TETH, title: 'tETH on Bitcoin', after: '' } });
    }
    T ||= await bitcoin.session.load();
    return T;
  }
  const unlocked = () => !!bitcoin?.session.unlocked;

  async function readPool() {
    const pools = await T.bitcoinSwapPools();
    const p = pools.find((x) => [x.asset_a, x.asset_b].sort().join() === [TETH, TAC].sort().join());
    L.pool = p ? { id: String(p.pool_id).toLowerCase(), a: String(p.asset_a).toLowerCase(), ra: BigInt(p.reserve_a), rb: BigInt(p.reserve_b), fee: p.fee_bps } : null;
    L.noPool = !p;
  }
  // The sats a swap can spend and what the key holds: the coins that carry a token are not counted as sats.
  const spendable = (utxos, holdings) => {
    const keep = new Set();
    if (holdings instanceof Map) {
      const add = (x) => { const t = x?.utxo?.txid || x?.txid, v = x?.utxo?.vout ?? x?.vout; if (t != null) keep.add(`${t}:${v}`); };
      for (const h of holdings.values()) for (const k of ['utxos', 'ghosts', 'inflated', 'pending', 'unverified']) for (const x of (h[k] || [])) add(x);
      for (const k of (holdings.unclassified || [])) keep.add(k);
    }
    return utxos.reduce((a, u) => a + (Number(u.value || 0) > DUST && !keep.has(`${u.txid}:${u.vout}`) ? Number(u.value) : 0), 0);
  };
  function readMe(quiet = false) {
    if (!unlocked()) return Promise.resolve();
    if (reading) return reading;
    const key = bitcoin.session.key?.pubHex;
    reading = (async () => {
      try {
        const [utxos, holdings] = await Promise.all([T.getUtxos(T.wallet.address()).catch(() => null), T.scanHoldings().catch(() => null)]);
        if (bitcoin.session.key?.pubHex !== key) return;
        if (Array.isArray(utxos)) L.sats = spendable(utxos, holdings);
        if (holdings instanceof Map) for (const aid of [TETH, TAC]) L.bal[aid] = holdings.get(aid)?.balance ?? 0n;
        L.need = await T.bitcoinSwapFundsNeeded().catch(() => L.need);
        paint();
        readBridged();
      } catch (e) { if (!quiet) say(esc(e?.message || e), 'err'); }
      finally { reading = null; }
    })();
    return reading;
  }
  // Tokens bridged to Bitcoin sit at the key's Taproot address, which a swap does not spend from: they are listed here with the move.
  async function readBridged() {
    if (!unlocked() || Date.now() - L.bridgedAt < 60e3) return;
    L.bridgedAt = Date.now();
    try {
      const { count } = await T.bridgedAtTaproot({ force: true });
      if (!count) { L.notes = []; L.unread = 0; paint(); return; }
      const [a, b] = await Promise.all([T.bridgedNotes(TETH), T.bridgedNotes(TAC)]);
      L.notes = [...a.notes.map((n) => ({ ...n, aid: TETH })), ...b.notes.map((n) => ({ ...n, aid: TAC }))];
      L.unread = a.unread + b.unread;
    } catch { L.bridgedAt = 0; }
    paint();
  }

  // ── the quote ──
  const amountBase = () => { const v = parseUnits(L.amt, TOKENS[L.pay].dec); return v && v > 0n ? v : null; };
  function requote(now = false) {
    clearTimeout(qTimer);
    L.q = null;
    const din = amountBase();
    if (!din || !T || L.noPool) { paint(); return; }
    const run = async () => {
      const my = ++seq;
      try {
        const q = await T.bitcoinSwapQuote({ fromAid: L.pay, toAid: L.get, amountIn: din, slipBps: slip });
        if (my !== seq) return;
        L.q = q ? { ...q, din } : { kind: 'none', error: 'no pool', din };
      } catch (e) { if (my !== seq) return; L.q = { kind: 'none', error: e?.message || String(e), din }; }
      L.ack = false; paint();
    };
    paint();
    if (now) run(); else qTimer = setTimeout(run, 300);
  }
  // How much worse the quote is than the pool's own price at its reserves (the swap's size moving the price, and the fee).
  const impact = (q) => {
    if (!q || q.kind !== 'direct') return 0;
    const spot = q.direction === 0 ? Number(q.reserveB) / Number(q.reserveA) : Number(q.reserveA) / Number(q.reserveB);
    const got = Number(q.deltaOut) / Number(q.din);
    return spot > 0 ? Math.max(0, 1 - got / spot) : 0;
  };

  // ── painting ──
  const coin = (aid) => `<svg class="tk" aria-hidden="true"><use href="#tk-${TOKENS[aid].icon}"/></svg>${TOKENS[aid].sym}`;
  function gate() {
    const din = amountBase(), q = L.q, bal = L.bal[L.pay];
    if (L.busy) return { label: 'Swapping…', off: true };
    if (!T) return { label: 'Loading…', off: true };
    if (L.noPool) return { label: 'No pool yet', off: true };
    if (!unlocked()) return { label: 'Open your Tacit wallet', act: 'unlock' };
    if (!L.amt) return { label: 'Enter an amount', off: true };
    if (!din) return { label: 'Enter a valid amount', off: true };
    if (bal != null && din > bal) return { label: `Not enough ${TOKENS[L.pay].sym} on Bitcoin`, off: true };
    if (!q) return { label: 'Getting a quote…', off: true };
    if (q.kind !== 'direct') return { label: q.kind === 'multihop' ? 'Not offered here' : 'The pool cannot take this', off: true };
    if (q.minOut < 1n) return { label: 'Too small', off: true };
    if (L.sats != null && L.need != null && L.sats < L.need) return { label: 'Add sats for the Bitcoin fees', act: 'fund' };
    if (impact(q) > IMPACT_ACK && !L.ack) return { label: 'Swap', off: true };
    return { label: 'Swap', act: 'swap' };
  }
  function paint() {
    if (!mounted) return;
    $('b-pay-coin').innerHTML = coin(L.pay); $('b-get-coin').innerHTML = coin(L.get);
    $('b-pay-coin').setAttribute('aria-label', `Pay with ${TOKENS[L.pay].sym}`); $('b-get-coin').setAttribute('aria-label', `Get ${TOKENS[L.get].sym}`);
    const bp = L.bal[L.pay], bg = L.bal[L.get];
    $('b-bal').textContent = !unlocked() ? '' : bp == null ? 'Reading your balance…' : `Balance ${tidy(fmt(bp, L.pay))} ${TOKENS[L.pay].sym}`;
    $('b-get-bal').textContent = !unlocked() || bg == null ? '' : `Balance ${tidy(fmt(bg, L.get))} ${TOKENS[L.get].sym}`;
    $('b-quick').innerHTML = bp > 0n ? [25, 50, 100].map((p) => `<button type="button" data-quick="${tidy(plain((bp * BigInt(p)) / 100n, TOKENS[L.pay].dec))}">${p === 100 ? 'Max' : `${p}%`}</button>`).join('') : '';
    $('b-slip').innerHTML = SLIPS.map((b) => `<button type="button" data-slip="${b}" aria-pressed="${slip === b}">${b / 100}%</button>`).join('');
    const q = L.q, out = $('b-out'), rc = $('b-rcpt');
    if (q?.kind === 'direct') {
      out.textContent = tidy(fmt(q.deltaOut, L.get)); out.classList.remove('ph');
      const imp = impact(q), px = (Number(q.deltaOut) / 10 ** TOKENS[L.get].dec) / (Number(q.din) / 10 ** TOKENS[L.pay].dec);
      rc.hidden = false;
      rc.innerHTML = [
        ['Price', `1 ${TOKENS[L.pay].sym} ≈ ${px >= 1 ? px.toPrecision(6).replace(/\.?0+$/, '') : px.toPrecision(4)} ${TOKENS[L.get].sym}`, ''],
        ['Least you get', `${tidy(fmt(q.minOut, L.get))} ${TOKENS[L.get].sym}`, ''],
        ['Worse than the pool’s price by', `${(imp * 100).toFixed(imp < 0.1 ? 1 : 0)}%`, imp > IMPACT_ACK ? 'err' : imp > IMPACT_WARN ? 'warn' : ''],
        ['Pool fee', `${(q.feeBps / 100).toFixed(2)}%`, ''],
        ['Pool holds', `${tidy(fmt(L.pool.a === TETH ? L.pool.ra : L.pool.rb, TETH))} tETH · ${tidy(fmt(L.pool.a === TAC ? L.pool.ra : L.pool.rb, TAC))} TAC`, ''],
        ...(q.pending ? [['In flight', `${q.pending} swap${q.pending > 1 ? 's' : ''} counted`, '']] : []),
        ['Settles', 'in the next Bitcoin block', ''],
      ].map(([k, v, c]) => `<div><dt>${esc(k)}</dt><dd${c ? ` class="${c}"` : ''}>${esc(v)}</dd></div>`).join('');
      const needAck = imp > IMPACT_ACK;
      $('b-ack').hidden = !needAck;
      $('b-acktext').textContent = `I accept ${(imp * 100).toFixed(0)}% less than the pool’s price. This pool is small.`;
      $('b-ackbox').checked = L.ack;
    } else {
      out.textContent = '0'; out.classList.add('ph'); $('b-ack').hidden = true;
      if (L.pool && !q) {
        rc.hidden = false;
        rc.innerHTML = `<div><dt>Pool holds</dt><dd>${esc(tidy(fmt(L.pool.a === TETH ? L.pool.ra : L.pool.rb, TETH)))} tETH · ${esc(tidy(fmt(L.pool.a === TAC ? L.pool.ra : L.pool.rb, TAC)))} TAC</dd></div><div><dt>Pool fee</dt><dd>${(L.pool.fee / 100).toFixed(2)}%</dd></div>`;
      } else rc.hidden = true;
    }
    paintBridged();
    const g = gate(), go = $('b-go');
    go.textContent = g.label; go.disabled = !!g.off; go.dataset.act = g.act || '';
    if (!L.busy && !L.sent && !L.asking && !L.line && L.noPool) say('There is no pool for tETH and TAC on Bitcoin yet.');
  }
  function paintBridged() {
    const box = $('b-brd');
    const rows = L.notes.map((n, i) => {
      const what = n.amount != null ? `${tidy(fmt(n.amount, n.aid))} ${TOKENS[n.aid].sym}` : `A note of ${TOKENS[n.aid].sym}`;
      if (L.asking === i) return `<div><span>Move ${esc(what)} to your trading address? One Bitcoin transaction, about ${MOVE_SATS.toLocaleString('en-US')} sats in fees.</span> <button class="link" type="button" data-move-yes="${i}">Move</button> <button class="link" type="button" data-move-no>Cancel</button></div>`;
      const ready = n.amount != null && n.confirmed;
      return `<div><span>${esc(what)} you bridged sits at your Taproot address, which a swap does not spend from.${ready ? '' : ` <em>${esc(n.amount == null ? 'Its amount is not readable yet.' : 'Waiting for its Bitcoin confirmation.')}</em>`}</span>${ready && !L.busy ? ` <button class="link" type="button" data-move="${i}">Move to trade</button>` : ''}</div>`;
    });
    if (L.unread && !L.notes.length) rows.push('<div><span>Part of your Taproot address could not be read just now.</span></div>');
    box.hidden = !rows.length; box.innerHTML = rows.join('');
  }

  // ── actions ──
  async function unlock() {
    try { await bitcoin.signIn(); } catch (e) { if (!e?.unlockCancelled) say(esc(e?.message || e), 'err'); return; }
    L.bridgedAt = 0; say(''); paint(); await readMe();
  }
  function fund() { bitcoin.fund(); }
  async function swap() {
    const q = L.q; if (!q || q.kind !== 'direct' || L.busy) return;
    L.busy = true; L.sent = null; say(STAGES.check); paint();
    try {
      const r = await T.bitcoinSwap({ fromAid: L.pay, toAid: L.get, amountIn: q.din, minOut: q.minOut, onProgress: (s) => { if (STAGES[s]) say(STAGES[s]); } });
      L.sent = { txid: r.revealTxid, from: L.pay, to: L.get, floor: q.minOut, quoted: q.deltaOut, din: q.din };
      L.amt = ''; $('b-amt').value = ''; L.q = null; L.ack = false;
      follow();
    } catch (e) { say(esc(e?.message || e), 'err'); }
    finally { L.busy = false; paint(); }
    readMe(true);
  }
  function follow() {
    clearTimeout(poll);
    const s = L.sent; if (!s) return;
    const link = `<a href="${MEMPOOL}/tx/${esc(s.txid)}" target="_blank" rel="noopener noreferrer">${esc(s.txid.slice(0, 10))}…↗</a>`;
    say(`Sent ${link}. It settles in the next Bitcoin block, at the pool’s price then, never below ${tidy(fmt(s.floor, s.to))} ${TOKENS[s.to].sym}; if the pool has moved past that, your ${TOKENS[s.from].sym} comes back.`);
    const t0 = Date.now();
    const tick = async () => {
      if (L.sent !== s || Date.now() - t0 > 45 * 60e3) return;
      const o = await T.bitcoinSwapOutcome(s.txid);
      if (L.sent !== s) return;
      if (o.state === 'filled') { say(`Filled ${link}: ${tidy(fmt(o.got ?? s.quoted, s.to))} ${TOKENS[s.to].sym}. It shows in your balance once Bitcoin has confirmed it.`, 'ok'); L.bridgedAt = 0; readMe(true); return; }
      if (o.state === 'refunded') { say(`The pool had moved past your floor, so your ${TOKENS[s.from].sym} was returned${o.refund != null ? ` (${tidy(fmt(o.refund, s.from))})` : ''} ${link}. Quote it again to retry.`, 'err'); readMe(true); return; }
      poll = setTimeout(tick, 20e3);
    };
    poll = setTimeout(tick, 20e3);
  }
  async function move(i) {
    const n = L.notes[i]; if (!n || L.busy) return;
    if (L.sats != null && L.sats < MOVE_SATS) { L.asking = null; say(`Moving takes about ${MOVE_SATS.toLocaleString('en-US')} sats for the Bitcoin fee, paid from the sats at your trading address. Add sats, then try again.`, 'err'); paint(); fund(); return; }
    L.busy = true; L.asking = null; say('Moving it to your trading address…'); paint();
    try {
      await T.moveBridgedNote({ txid: n.txid, assetIdHex: n.aid, onProgress: (s) => say(s === 'reveal-start' ? 'Sending the second transaction…' : 'Sending the first transaction…') });
      say(`Moved ${esc(tidy(fmt(n.amount, n.aid)))} ${TOKENS[n.aid].sym}. It confirms with the next Bitcoin block, and then it shows in your balance here, ready to swap.`, 'ok');
      L.notes = L.notes.filter((_, j) => j !== i);
    } catch (e) { say(esc(/insufficient sats/i.test(e?.message || '') ? `You need about ${MOVE_SATS.toLocaleString('en-US')} sats at your trading address for the fee. Add sats, then try again.` : (e?.message || e)), 'err'); }
    finally { L.busy = false; L.bridgedAt = 0; paint(); }
  }

  // ── events ──
  const setAmt = (v) => { L.amt = v; if (L.cls === 'err' && !L.busy) say(''); requote(); };
  host.addEventListener('input', (e) => { if (e.target.id === 'b-amt') setAmt(e.target.value.trim()); });
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'b-amt' && !$('b-go').disabled) $('b-go').click(); });
  host.addEventListener('change', (e) => { if (e.target.id === 'b-ackbox') { L.ack = e.target.checked; paint(); } });
  host.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#b-flip')) { [L.pay, L.get] = [L.get, L.pay]; L.amt = ''; $('b-amt').value = ''; L.q = null; L.ack = false; if (L.cls === 'err' && !L.busy) say(''); paint(); return; }
    const sl = t.closest('[data-slip]'); if (sl) { slip = Number(sl.dataset.slip); try { localStorage.setItem(SLIP_KEY, String(slip)); } catch { /* storage is a convenience */ } requote(true); return; }
    const qk = t.closest('[data-quick]'); if (qk) { $('b-amt').value = qk.dataset.quick; setAmt(qk.dataset.quick); return; }
    const mv = t.closest('[data-move]'); if (mv) { L.asking = Number(mv.dataset.move); paint(); return; }
    const yes = t.closest('[data-move-yes]'); if (yes) { move(Number(yes.dataset.moveYes)); return; }
    if (t.closest('[data-move-no]')) { L.asking = null; paint(); return; }
    if (t.closest('#b-go')) { const a = $('b-go').dataset.act; if (a === 'unlock') unlock(); else if (a === 'fund') fund(); else if (a === 'swap') swap(); }
  });

  return {
    // The lane opens: tacit.js loads (once), the pool is read, and a key that is already open is read for its balances.
    async show() {
      L.open = true; mounted = true; paint();
      if (!T) say('Loading…');
      try { await ensure(); await readPool(); } catch (e) { say(`Could not load the Bitcoin lane: ${esc(e?.message || e)}`, 'err'); return; }
      if (L.line === 'Loading…') say('');
      paint(); requote(true); readMe();
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => { if (!document.hidden && L.open) { readPool().then(() => requote(true)).catch(() => {}); readMe(true); } }, 45e3);
    },
    hide() { L.open = false; clearInterval(refreshTimer); },
    get unlocked() { return unlocked(); },
  };
}
