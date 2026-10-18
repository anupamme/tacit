// tacit.finance/vault: where TACD and TACE sell.
//
// What a borrower takes out is worth what it sells for, so each vault's token has one Precision pool against a liquid asset (TACE against ETH, TACD against USDC; deployments.js
// names them). A pool is a market whose fee and price band are fixed when it is opened: this module builds that market from deployments.js, reads it, opens it (once, by the
// address deployments.js names, because a market with a front end is named so that nobody else can open it at a price of their own) and adds to it or takes from it. The pool's
// arithmetic is repeated here only to say what a deposit will cost before it is sent; the pool settles every figure, and each transaction is tested with eth_call first.
import { word, addrWord, wordAt, SEL, encApprove } from '/vault/chain.js?cb=446cc436';
import * as M from '/vault/math.js?cb=ac1ed53e';
import { MULTICALL3 } from '/vault/batch.js?cb=457d6163';

const WAD = 10n ** 18n, ZERO = '0x0000000000000000000000000000000000000000';
const MIN_LIQUIDITY = 1000n;                                     // the pool keeps this much of the first deposit for good
const SLACK_BPS = 50n;                                           // what a deposit into a live pool may cost over the figure shown (the pool refunds what it does not use)
const GAS_KEEP = 2n * 10n ** 15n;                                // ETH left in the wallet by "Max"
const SELS = { poolFor: '0x83bd1387', isPool: '0x5b16ebb7', createAndSeed: '0x7163352a', seed: '0xbdc5ef29', reserve0: '0x443cb4bc', reserve1: '0x5a76f25e', totalSupply: '0x18160ddd', sqrtPriceCurrent: '0x2af1f249', removeLiquidity: '0xe39b0eb5', ethBalance: '0x4d2301cc' };
const REVERTS = {
  '0x93687c0b': 'Only the address that owns this market can open it.', '0x846ec056': 'This market is already open.', '0xbb55fd27': 'That amount is too small for this market.',
  '0x37c8a83c': 'The price is outside this market’s range.', '0x1f2a2005': 'That amount is too small for this market.', '0xa9e4150c': 'The tokens did not arrive. Nothing was sent.', '0xbb2875c3': 'The market moved. Try again.',
  '0xe143a034': 'The market does not accept this.', '0xf591b277': 'This market is not open yet.',
};

const ceilDiv = (a, b) => (a + b - 1n) / b;
const isqrt = (n) => { if (n < 2n) return n; let x = 1n << BigInt((n.toString(2).length + 1) >> 1); for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; } };
// "9/10", "1.0004" or "1" as [numerator, denominator].
const frac = (t) => {
  const part = (s) => { const [w, f = ''] = String(s).trim().split('.'); return [BigInt(w + f), 10n ** BigInt(f.length)]; };
  const [a, b = '1'] = String(t).split('/'), [an, ad] = part(a), [bn, bd] = part(b);
  return [an * bd, ad * bn];
};
const sameAddr = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

// ── the market ──
// `kind`: one entry of deployments.js's pools.markets ({ vault, quote: { sym, addr, dec }, fee, open, low, high }, prices in tokens of the vault's synth per unit of the quote);
// `synth`: the vault's token; `recipient`: who may open the market (nobody in particular when zero). The tokens are ordered as the pool wants them (the lower address first, ETH
// being address zero), and the prices become the pool's square roots of token1 per token0 in raw units, scaled by 1e18.
export function marketOf(kind, synth, recipient = ZERO) {
  const q = kind.quote, qa = q.addr ? q.addr.toLowerCase() : ZERO, sa = synth.toLowerCase();
  const synthIs1 = BigInt(sa) > BigInt(qa), dq = BigInt(q.dec);
  const raw = ([n, d]) => (synthIs1 ? [n * 10n ** 18n, d * 10n ** dq] : [d * 10n ** dq, n * 10n ** 18n]);
  const sqrtOf = (p) => { const [a, b] = raw(p); return isqrt(a * 10n ** 36n / b); };
  const low = frac(kind.low), high = frac(kind.high), open = frac(kind.open);
  const [sLow, sHigh] = synthIs1 ? [sqrtOf(low), sqrtOf(high)] : [sqrtOf(high), sqrtOf(low)];
  return {
    kind, synth: sa, quote: { ...q, addr: q.addr ? q.addr.toLowerCase() : null }, synthIs1, recipient,
    t: { token0: synthIs1 ? qa : sa, token1: synthIs1 ? sa : qa, sqrtPLow: sLow, sqrtPHigh: sHigh, fee: BigInt(kind.fee), hook: ZERO, feeRecipient: recipient, creatorFeeBps: 0n },
    sOpen: sqrtOf(open), range: [BigInt(Math.round(1e18 * Number(high[1]) / Number(high[0]))), BigInt(Math.round(1e18 * Number(low[1]) / Number(low[0])))],   // the range as the quote per synth, E18
  };
}
const encMarket = (t) => addrWord(t.token0) + addrWord(t.token1) + word(t.sqrtPLow) + word(t.sqrtPHigh) + word(t.fee) + addrWord(t.hook) + addrWord(t.feeRecipient) + word(t.creatorFeeBps);

// The quote asset per synth, E18, from the pool's square-root price.
export function priceOf(m, sqrtNow) {
  if (!(sqrtNow > 0n)) return null;
  const dq = 10n ** BigInt(m.quote.dec), s2 = sqrtNow * sqrtNow;
  return m.synthIs1 ? 10n ** 72n / (s2 * dq) : s2 * WAD / (10n ** 36n * dq);
}

// What opening the market costs for `amount` of the typed side ('s' the synth, 'q' the quote): the pool's own seed arithmetic.
export function seedPlan(m, side, amount) {
  const { sqrtPLow: sl, sqrtPHigh: sh } = m.t, s = m.sOpen;
  const typed0 = side === 's' ? !m.synthIs1 : m.synthIs1;
  const lp = typed0 ? amount * s / (sh - s) * sh / WAD : amount * WAD / (s - sl);
  if (lp <= MIN_LIQUIDITY) return null;
  const u0 = ceilDiv(lp * (sh - s) * WAD, sh * s), u1 = ceilDiv(lp * (s - sl), WAD);
  const used = m.synthIs1 ? { s: u1, q: u0 } : { s: u0, q: u1 };
  return { lp: lp - MIN_LIQUIDITY, used, send: { [side]: amount, [side === 's' ? 'q' : 's']: used[side === 's' ? 'q' : 's'] }, minLP: (lp - MIN_LIQUIDITY) * 99n / 100n };
}
// What adding `amount` of the typed side to a live pool costs: in the pool's own proportions, the other side with a little room for the price to move.
export function addPlan(m, st, side, amount) {
  const typed0 = side === 's' ? !m.synthIs1 : m.synthIs1, rT = typed0 ? st.r0 : st.r1;
  if (!(rT > 0n) || !(st.supply > 0n)) return null;
  const lp = amount * st.supply / rT;
  if (lp === 0n) return null;
  const u0 = st.r0 ? ceilDiv(lp * st.r0, st.supply) : 0n, u1 = st.r1 ? ceilDiv(lp * st.r1, st.supply) : 0n;
  const used = m.synthIs1 ? { s: u1, q: u0 } : { s: u0, q: u1 }, other = side === 's' ? 'q' : 's';
  return { lp, used, send: { [side]: amount, [other]: used[other] * (10000n + SLACK_BPS) / 10000n }, minLP: lp * 995n / 1000n };
}
const callSeed = (m, to, plan, first) => {
  const a0 = m.synthIs1 ? plan.send.q : plan.send.s, a1 = m.synthIs1 ? plan.send.s : plan.send.q;
  return (first ? SELS.createAndSeed : SELS.seed) + encMarket(m.t) + word(first ? m.sOpen : 0n) + word(a0) + word(a1) + word(plan.minLP) + addrWord(to);
};

// ── the module ──
// `cfg`: deployments.js's pools ({ factory, recipient, markets }); `synthOf(key)`: the vault's token once it is read; the rest is the page's own.
export function makePools({ el, cfg, esc, rpc, ethCall, batch, wallet, W, synthOf, symOf, iconOf, connect, txLink, onChange }) {
  const P = { by: {}, busy: false, key: null, side: 's', text: { s: '', q: '' }, shape: '', seq: 0, busyRead: {} };
  const kindOf = (key) => cfg?.markets?.find((k) => k.vault === key) || null;
  const marketFor = (key) => { const k = kindOf(key), s = synthOf(key); return k && s ? marketOf(k, s, cfg.recipient || ZERO) : null; };
  const stateOf = (key) => P.by[key] || null;
  const fee = (m) => `${(Number(m.t.fee) / 1e4).toLocaleString('en-US', { maximumFractionDigits: 3 })}%`;
  // Figures for reading, to the nearest place (a pool that holds 999.9999 TACD of the 1,000 put in says 1,000).
  const near = (v, dec, dp) => M.fmtUnits(v + 5n * 10n ** BigInt(Math.max(0, dec - dp - 1)), dec, dp);
  const qFmt = (m, v, max = 4) => near(v, m.quote.dec, Math.min(max, m.quote.dec)), sFmt = (v, max = 4) => near(v, 18, max);

  // The market's chain state and the account's holdings in it, in two batches (the pool's address first).
  async function read(key = P.key, force = false) {
    const m = key && marketFor(key);
    if (!m || (P.busyRead[key] && !force)) return;
    P.busyRead[key] = true;
    try {
      const old = P.by[key], acc = W.account;
      let pool = old?.pool;
      if (!pool) {
        const out = await ethCall(cfg.factory, SELS.poolFor + encMarket(m.t));
        if (!/^0x0{24}[0-9a-f]{40}$/i.test(out || '')) throw new Error('the factory gave no pool address');                  // nothing there: do not ask for the pool's state
        pool = '0x' + out.slice(-40);
      }
      const q = m.quote, qErc = !!q.addr, acct = acc ? addrWord(acc) : null;
      const calls = [
        { to: cfg.factory, data: SELS.isPool + addrWord(pool) }, { to: pool, data: SELS.reserve0 }, { to: pool, data: SELS.reserve1 }, { to: pool, data: SELS.totalSupply }, { to: pool, data: SELS.sqrtPriceCurrent },
        ...(acc ? [
          { to: pool, data: SEL.balanceOf + acct }, { to: m.synth, data: SEL.balanceOf + acct }, { to: m.synth, data: SEL.allowance + acct + addrWord(cfg.factory) },
          ...(qErc ? [{ to: q.addr, data: SEL.balanceOf + acct }, { to: q.addr, data: SEL.allowance + acct + addrWord(cfg.factory) }] : [{ to: MULTICALL3, data: SELS.ethBalance + acct }]),
        ] : []),
      ];
      const r = await batch(calls), w = (i) => (r[i] == null ? null : wordAt(r[i], 0));
      P.by[key] = {
        m, pool, exists: w(0) === 1n, r0: w(1) ?? 0n, r1: w(2) ?? 0n, supply: w(3) ?? 0n, sqrtNow: w(4), acc,
        mine: acc ? w(5) ?? 0n : 0n, balS: acc ? w(6) ?? 0n : null, allowS: acc ? w(7) ?? 0n : null, balQ: acc ? w(8) ?? 0n : null, allowQ: acc ? (qErc ? w(9) ?? 0n : (2n ** 256n - 1n)) : null, at: Date.now(),
      };
      if (key === P.key) P.failed = false;
    } catch (e) { if (key === P.key) P.failed = true; console.warn('pool read:', e?.message || e); } finally { P.busyRead[key] = false; }
    draw(); onChange?.();
  }

  // Which side of the pool is which: the synth's and the quote's reserve.
  const reserves = (st) => (st.m.synthIs1 ? { s: st.r1, q: st.r0 } : { s: st.r0, q: st.r1 });
  const seeded = (st) => st.exists && st.supply > 0n;
  const mayOpen = (st) => !seeded(st) && (sameAddr(st.acc, st.m.recipient) || st.m.recipient === ZERO);

  // The plan for what is typed now, against the state read: { ok, plan, why }.
  function planNow(st) {
    const m = st.m, side = P.side, dec = side === 's' ? 18 : m.quote.dec, text = P.text[side];
    const amount = M.parseUnits(text, dec);
    if (!amount || amount <= 0n) return { ok: false, why: 'Enter an amount' };
    const first = !seeded(st), plan = first ? seedPlan(m, side, amount) : addPlan(m, st, side, amount);
    if (!plan) return { ok: false, why: 'Too small for this market' };
    return { ok: true, plan, first, amount };
  }
  // The most of one side that the account can put in, given what it holds of the other (ETH keeps a little back for the fee).
  function maxOf(st, side) {
    const m = st.m, first = !seeded(st), bq = st.balQ ?? 0n, keep = m.quote.addr ? 0n : (GAS_KEEP < bq ? GAS_KEEP : bq);
    const hold = { s: st.balS ?? 0n, q: bq - keep };
    const over = (a) => { const p = first ? seedPlan(m, side, a) : addPlan(m, st, side, a); return !!p && (p.send.s > hold.s || p.send.q > hold.q); };
    let lo = 0n, hi = hold[side];
    if (!over(hi)) return hi;
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (over(mid)) hi = mid - 1n; else lo = mid; }
    return lo;
  }

  // ── drawing ──
  const bit = (s) => el.querySelector(s);
  const setText = (s, h) => { const n = bit(s); if (n && n.__h !== h) { n.__h = h; n.innerHTML = h; } };
  function draw() {
    const key = P.key, m = key && marketFor(key), st = key && stateOf(key);
    if (!m) { el.hidden = true; return; }
    el.hidden = false;
    const sym = symOf(key), qs = m.quote.sym, head = `<p class="eyebrow" id="pl-h"><span>${esc(sym)} / ${esc(qs)} market</span><span class="who">${esc(fee(m))} fee</span></p>`;
    if (!st) { shapeSet(P.failed ? 'failed' : 'loading', `${head}<p class="empty">${P.failed ? 'Could not read the market. Try again in a moment.' : 'Reading the market…'}</p>${statusBox()}`); return; }
    const open = seeded(st), canOpen = mayOpen(st), mine = st.mine > 0n && open;
    const shape = [key, open, canOpen, mine, !!st.acc, !!m.quote.addr].join();
    if (!open && !canOpen) { shapeSet(shape, `${head}<p class="empty">Not open yet. ${esc(sym)} cannot be sold for ${esc(qs)} here until it is.</p>${statusBox()}`); return; }
    if (P.shape !== shape) {
      const sBal = '<button class="linkbtn" id="pl-bs" type="button"></button>', qBal = '<button class="linkbtn" id="pl-bq" type="button"></button>';
      shapeSet(shape, `${head}
        <div class="rows flat" id="pl-rows">${open
          ? '<div class="kv"><span>Price</span><b class="num" id="pl-px"></b></div><div class="kv"><span>In the pool</span><b class="num" id="pl-depth"></b></div>' + (mine ? '<div class="kv"><span>Yours</span><b class="num" id="pl-mine"></b></div>' : '')
          : '<div class="kv"><span>Opens at</span><b class="num" id="pl-px"></b></div><div class="kv"><span>Range</span><b class="num" id="pl-range"></b></div>'}</div>
        <div class="lbl"><span>${esc(sym)}</span>${sBal}</div>
        <div class="amt"><input id="pl-s" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${esc(sym)} to add"><span class="u">${iconOf(key)}${esc(sym)}</span></div>
        <div class="lbl"><span>${esc(qs)}</span>${qBal}</div>
        <div class="amt"><input id="pl-q" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${esc(qs)} to add"><span class="u">${esc(qs)}</span></div>
        <p class="hint" id="pl-hint"></p>
        <button class="btn" id="pl-go" type="button"></button>
        ${mine ? '<div class="chips" id="pl-rm" role="group" aria-label="Take liquidity out"><button type="button" data-rm="25">Take 25%</button><button type="button" data-rm="50">50%</button><button type="button" data-rm="100">All</button></div>' : ''}
        ${statusBox()}`);
      bit('#pl-s').value = P.text.s; bit('#pl-q').value = P.text.q;
    }
    const r = reserves(st), px = priceOf(m, st.sqrtNow);
    if (open) {
      setText('#pl-px', px ? `1 ${esc(sym)} = ${esc(near(px, 18, 4))} ${esc(qs)}` : '—');
      setText('#pl-depth', `${esc(qFmt(m, r.q, 2))} ${esc(qs)} · ${esc(sFmt(r.s, 2))} ${esc(sym)}`);
      if (mine) setText('#pl-mine', `${esc((Number((st.mine * 10000n + st.supply / 2n) / st.supply) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }))}% · ${esc(qFmt(m, st.mine * r.q / st.supply, 4))} ${esc(qs)} + ${esc(sFmt(st.mine * r.s / st.supply, 4))} ${esc(sym)}`);
    } else {
      setText('#pl-px', `1 ${esc(sym)} = ${esc(near(priceOf(m, m.sOpen), 18, 4))} ${esc(qs)}`);
      setText('#pl-range', `${esc(near(m.range[0], 18, 3))} – ${esc(near(m.range[1], 18, 3))} ${esc(qs)}`);
    }
    setText('#pl-bs', st.balS == null ? '' : `Balance ${esc(sFmt(st.balS, 4))} · Max`);
    setText('#pl-bq', st.balQ == null ? '' : `Balance ${esc(qFmt(m, st.balQ, 4))} · Max`);
    drawButton(st);
  }
  function shapeSet(shape, html) { if (P.shape !== shape) { P.shape = shape; el.innerHTML = html; } }
  const statusBox = () => `<div class="status" id="pl-status" role="status">${P.msg || ''}</div>`;
  function drawButton(st) {
    const go = bit('#pl-go'), hint = bit('#pl-hint');
    if (!go) return;
    const m = st.m, sym = symOf(P.key), qs = m.quote.sym, open = seeded(st), verb = open ? 'Add liquidity' : 'Open the market';
    let label = verb, why = '', dis = false, note = '';
    if (!st.acc) label = 'Connect wallet';
    else {
      const pl = planNow(st);
      if (!pl.ok) { label = pl.why === 'Enter an amount' ? 'Enter an amount' : verb; dis = true; if (pl.why !== 'Enter an amount') why = pl.why; }
      else {
        if (pl.plan.send.s > st.balS) { label = `Not enough ${sym}`; dis = true; why = `Borrow ${sym} above, then add it here.`; }
        else if (pl.plan.send.q > st.balQ) { label = `Not enough ${qs}`; dis = true; }
        else {
          const steps = (st.allowS < pl.plan.send.s ? 1 : 0) + (m.quote.addr && st.allowQ < pl.plan.send.q ? 1 : 0);
          if (steps) note = `${steps} approval${steps > 1 ? 's' : ''} first, then the deposit. Each is a confirmation.`;
        }
      }
    }
    if (P.busy) dis = true;
    setText('#pl-go', esc(label)); go.disabled = dis;
    if (hint) { const h = esc(why || note); if (hint.__h !== h) { hint.__h = h; hint.textContent = why || note; } }
    for (const b of el.querySelectorAll('#pl-rm button')) b.disabled = P.busy;
  }
  // The other box follows the one being typed in.
  function mirror(st) {
    const m = st.m, other = P.side === 's' ? 'q' : 's', pl = planNow(st);
    const box = bit(`#pl-${other}`);
    if (!box) return;
    const v = pl.ok ? pl.plan.used[other] : null;
    const dec = other === 's' ? 18 : m.quote.dec;
    P.text[other] = v == null ? '' : M.fmtUnits(v, dec, dec === 18 ? 6 : dec).replace(/,/g, '');
    box.value = P.text[other];
  }

  // ── acting ──
  const say = (h) => { P.msg = h; const n = bit('#pl-status'); if (n) n.innerHTML = h; };
  const stopped = (e) => e?.code === 4001 || /user (rejected|denied)|rejected the request|request rejected|denied (transaction|message)/i.test(e?.message || '');
  const why = (e) => REVERTS[String(e?.data || '').slice(0, 10).toLowerCase()] || null;
  async function call(from, to, data, value = 0n) {
    return rpc('eth_call', [{ from, to, data, ...(value ? { value: '0x' + value.toString(16) } : {}) }, 'latest']);
  }
  const approve = async (from, token, amount) => {
    say(`Approve in your wallet. It lets the market take exactly this amount.`);
    const h = await wallet.sendTx({ to: token, data: encApprove(cfg.factory, amount), from });
    say(`Waiting for the approval ${txLink(h)}`);
    if ((await wallet.receipt(h)).status !== '0x1') throw new Error('The approval did not go through.');
  };
  // Sends one transaction after testing it as the account; `again` retries the test (a node a block behind has not seen the approval yet).
  async function send(from, to, data, value, done, again = 0) {
    let err = null;
    for (let i = 0; i <= again; i++) {
      try { await call(from, to, data, value); err = null; break; } catch (e) { err = e; if (i < again) await new Promise((r) => setTimeout(r, 2000)); }
    }
    if (err) throw Object.assign(new Error(why(err) || 'This would fail. Nothing was sent; the figures above are current.'), { sim: true });
    say('Confirm in your wallet.');
    const h = await wallet.sendTx({ to, data, value, from });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    if ((await wallet.receipt(h)).status !== '0x1') throw new Error(`The transaction failed (${h.slice(0, 10)}…).`);
    say(`${done} ${txLink(h)}`);
  }
  const guard = async (fn) => {
    if (P.busy) return;
    P.busy = true; draw();
    try { await fn(); } catch (e) { say(`<span class="err">${esc(stopped(e) ? 'Cancelled. Nothing was sent.' : String(e?.message || e).slice(0, 220))}</span>`); } finally { P.busy = false; await read(); }
  };

  async function add() {
    if (!W.account) { connect(); return; }
    const key = P.key, from = W.account;
    await guard(async () => {
      say('Reading the market again…');
      const shown = planNow(stateOf(key)), mm = stateOf(key).m;
      await read(key, true);
      const st = stateOf(key);
      if (!st || st.acc?.toLowerCase() !== from.toLowerCase()) throw new Error('The wallet’s account changed. Nothing was sent.');
      const pl = planNow(st);
      if (!pl.ok) throw new Error(pl.why);
      if (!shown.ok) throw new Error('Enter an amount.');
      const other = P.side === 's' ? 'q' : 's', was = shown.plan.used[other], now = pl.plan.used[other];
      if (was > 0n && (now > was ? now - was : was - now) * 200n > was) throw new Error('The market moved. Nothing was sent; the figures above are current.');
      if (pl.first && !mayOpen(st)) throw new Error(REVERTS['0x93687c0b']);
      if (pl.plan.send.s > st.balS || pl.plan.send.q > st.balQ) throw new Error('The balance is not enough.');
      const sym = symOf(key);
      let approved = false;
      if (st.allowS < pl.plan.send.s) { await approve(from, mm.synth, pl.plan.send.s); approved = true; }
      if (mm.quote.addr && st.allowQ < pl.plan.send.q) { await approve(from, mm.quote.addr, pl.plan.send.q); approved = true; }
      const a0 = mm.synthIs1 ? pl.plan.send.q : pl.plan.send.s, native = !mm.quote.addr;
      await send(from, cfg.factory, callSeed(mm, from, pl.plan, pl.first), native ? a0 : 0n, pl.first ? `The ${sym} market is open.` : 'Added.', approved ? 3 : 0);
      P.text = { s: '', q: '' };
      const sb = bit('#pl-s'), qb = bit('#pl-q'); if (sb) sb.value = ''; if (qb) qb.value = '';
    });
  }
  async function take(pct) {
    if (!W.account) { connect(); return; }
    const key = P.key, from = W.account;
    await guard(async () => {
      say('Reading the market again…');
      await read(key, true);
      const st = stateOf(key);
      if (!st || !(st.mine > 0n)) throw new Error('There is nothing to take out.');
      const lp = st.mine * BigInt(pct) / 100n, o0 = lp * st.r0 / st.supply, o1 = lp * st.r1 / st.supply;
      if (!(lp > 0n)) throw new Error('That is too small.');
      const data = SELS.removeLiquidity + word(lp) + word(o0 * 99n / 100n) + word(o1 * 99n / 100n) + addrWord(from);
      await send(from, st.pool, data, 0n, 'Taken out.');
    });
  }

  // ── the page's hooks ──
  el.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id !== 'pl-s' && id !== 'pl-q') return;
    const st = stateOf(P.key);
    if (!st) return;
    P.side = id === 'pl-s' ? 's' : 'q'; P.text[P.side] = e.target.value;
    mirror(st); drawButton(st);
    if (P.msg && !P.busy) say('');
  });
  el.addEventListener('click', (e) => {
    const st = stateOf(P.key);
    if (!st) return;
    const b = e.target.closest('#pl-bs, #pl-bq'), rm = e.target.closest('[data-rm]');
    if (b && !P.busy) {
      const side = b.id === 'pl-bs' ? 's' : 'q', a = maxOf(st, side), dec = side === 's' ? 18 : st.m.quote.dec;
      P.side = side; P.text[side] = a > 0n ? M.plain(a, dec) : ''; bit(`#pl-${side}`).value = P.text[side];
      mirror(st); drawButton(st); return;
    }
    if (rm && !P.busy) { take(Number(rm.dataset.rm)); return; }
    if (e.target.closest('#pl-go') && !P.busy) add();
  });
  // The vault whose market is shown follows the page's; its state is read when it has none yet (and again by `read`, which the page repeats).
  function show(key) {
    if (key !== P.key) { P.key = key; P.text = { s: '', q: '' }; P.side = 's'; P.shape = ''; P.msg = ''; }
    draw();
    for (const k of cfg?.markets || []) if (!stateOf(k.vault) && marketFor(k.vault)) read(k.vault);
  }
  // The board's cell for a vault: what it sells for and how deep, or that nothing does yet.
  function cell(key) {
    const m = marketFor(key);
    if (!m) return null;
    const st = stateOf(key);
    if (!st) return `<span class="mute">…</span>`;
    if (!seeded(st)) return 'Not open yet';
    const r = reserves(st);
    return `<b>${esc(qFmt(m, r.q, 2))}</b> ${esc(m.quote.sym)}<small>in the ${esc(symOf(key))} pool</small>`;
  }
  // Every configured market (the board has a row for each vault).
  return { show, read: () => Promise.all((cfg?.markets || []).map((k) => read(k.vault))), draw, cell };
}
