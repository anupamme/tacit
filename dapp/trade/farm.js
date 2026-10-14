// The Precision pool's farm on the trade page: what it streams, what a deposit would earn, and the deposit itself (ETH alone,
// TAC alone or both), the stake's claim and withdrawal. The same contracts and calls as the front page's farm sheet: the lens
// previews a deposit, the farm zaps ETH or TAC into the pool and stakes the shares in one transaction (TAC by permit where it
// has no allowance), and a withdrawal comes back as both assets or as one of them. Shielded farms are the front page's; their
// stream is named here with a link.
const POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E', FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0', LENS = '0x000000956bf20A41C54BaE4a4b6F5C8A166DAB4E';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11', ZERO = '0x0000000000000000000000000000000000000000';
const SEL = {
  reserve0: '0x443cb4bc', reserve1: '0x5a76f25e', totalSupply: '0x18160ddd', sqrtPrice: '0x2af1f249', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', timestamp: '0x0f28c97d',
  totalStaked: '0x817b1cd2', rewardRate: '0x7b0a47ee', periodFinish: '0xebe2b12b', staked: '0x98807d84', earned: '0x008cc262',
  previewZap: '0xe7cddab0', previewAdd: '0xe03ec807', zapETH: '0x8703a0d8', zapToken: '0x9376f34e', zapTokenWithPermit: '0x51291e77', addAndStake: '0x6d15c09b', addAndStakeWithPermit: '0xddd9f3fb',
  claim: '0x4e71d92d', stake: '0xa694fc3a', stakeWithPermit: '0xecd9ba82', exitAndRemove: '0xbccbe38a', withdrawAndRemove: '0xbd8196a9', exitTo: '0x6ae36ea7', withdrawTo: '0x47d1eebd', nonces: '0x7ecebe00',
};
const REWARD_PAID = '0xe2403640ba68fed3a2f88b7557551d1993f84b99bb10ff833f0cf8db0c5e0486';
const GAS = 3n * 10n ** 15n;                                                     // ETH kept back for the network fee by Max
const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => strip(a).toLowerCase().padStart(64, '0');
const wordAt = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, (i + 1) * 64) || '0'));
const now = () => Math.floor(Date.now() / 1000);

export function mountFarm(host, ctx) {
  const { ethCall, batch, api, wallet, W, connect, fmtUnits: fmt, parseUnits, esc, usd, ethUsd, txLink, onDone } = ctx;
  const F = { rseq: 0, ackKey: null, x: null, prog: null, mode: 'eth', outPct: '100', outAs: 'both', q: null, seq: 0, w: null, wseq: 0, busy: false, tick: 0, err: false };
  const $ = (s) => host.querySelector(s);
  const plain = (v) => { const n = BigInt(v), b = 10n ** 18n, f = (n % b).toString().padStart(18, '0').replace(/0+$/, ''); return `${n / b}${f ? `.${f}` : ''}`; };
  // An amount with at least its first two significant digits, so a small stake does not read as 0.
  const amt = (v, dp) => { let d = dp; const n = BigInt(v); while (n > 0n && d < 12 && fmt(n, 18, d).replace(/[^1-9]/g, '').length < 2) d++; return fmt(n, 18, d); };
  const share = (num, den) => { if (!den || !num) return '0%'; const bp = Number(num * 1000000n / den) / 10000; return bp > 0 && bp < 0.01 ? 'under 0.01%' : `${bp.toFixed(2)}%`; };
  const cut = (v, dp) => { const u = 10n ** BigInt(18 - dp); return (v / u) * u; };
  const dayFmt = (t) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const usdOfEth = (wei) => (ethUsd() ? usd((Number(wei) / 1e18) * ethUsd()) : '');
  const tacUsd = (tac, x = F.x) => (x?.tacEth ? usdOfEth(Number(tac) * x.tacEth) : '');
  const aprTxt = (a) => (a == null ? '—' : a >= 100000 ? 'over 100,000%' : `${Math.round(a).toLocaleString('en-US')}%`);
  const say = (el, h) => { if (el) el.innerHTML = h; };
  const errMsg = (e) => esc(e?.userStopped ? e.message : String(e?.message || e).slice(0, 220));

  host.innerHTML = `
    <p class="eyebrow" id="fm-h"><span class="pairtk"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg><svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg></span>Earn · Precision pool farm</p>
    <div class="fm-stats" id="fm-stats"><p class="note">Reading the farm…</p></div>
    <p class="note fm-prog" id="fm-prog"></p>
    <div class="fm-pos" id="fm-pos" hidden></div>
    <div class="status" id="fm-pos-status" role="status"></div>
    <div class="fm-add">
      <h3 id="fm-add-h">Farm TAC/ETH</h3>
        <div class="seg big" id="fm-mode" role="group" aria-label="Deposit with">
          <button type="button" data-fm="eth" aria-pressed="true">ETH</button><button type="button" data-fm="tac" aria-pressed="false">TAC</button><button type="button" data-fm="pair" aria-pressed="false">ETH + TAC</button>
        </div>
        <p class="note fm-how" id="fm-how"></p>
        <div id="fm-eth"><div class="lbl"><span>ETH</span><button class="linkbtn" type="button" id="fm-emax" hidden></button></div>
          <div class="amt"><input id="fm-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="ETH to deposit"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg>ETH</span></div></div>
        <div id="fm-tac" hidden><div class="lbl"><span>TAC</span><button class="linkbtn" type="button" id="fm-tmax" hidden></button></div>
          <div class="amt"><input id="fm-tacamt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="TAC to deposit"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>TAC</span></div></div>
        <div class="fm-rcpt" id="fm-rcpt" hidden></div>
        <button class="btn" type="button" id="fm-go">Connect wallet</button>
        <div class="status" id="fm-status" role="status"></div>
    </div>`;
  const ethIn = $('#fm-amt'), tacIn = $('#fm-tacamt'), go = $('#fm-go'), rc = $('#fm-rcpt'), status = $('#fm-status');

  // ── reading the farm ──
  async function read() {
    const who = W.account, my = ++F.rseq;
    const calls = [
      { to: POOL, data: SEL.reserve0 }, { to: POOL, data: SEL.reserve1 }, { to: POOL, data: SEL.totalSupply }, { to: POOL, data: SEL.sqrtPrice },
      { to: FARM, data: SEL.totalStaked }, { to: FARM, data: SEL.rewardRate }, { to: FARM, data: SEL.periodFinish }, { to: MC3, data: SEL.timestamp },
    ];
    if (who) calls.push({ to: FARM, data: SEL.staked + addr(who) }, { to: FARM, data: SEL.earned + addr(who) }, { to: TAC, data: SEL.balanceOf + addr(who) },
      { to: TAC, data: SEL.allowance + addr(who) + addr(FARM) }, { to: POOL, data: SEL.balanceOf + addr(who) }, { to: POOL, data: SEL.allowance + addr(who) + addr(FARM) });
    const [r, bal] = await Promise.all([batch(calls), who ? ctx.rpc('eth_getBalance', [who, 'latest']).then(BigInt, () => null) : null]);
    if (!r[0] || !r[2] || !r[4]) throw new Error('the farm did not answer');
    const w = (i) => (r[i] ? wordAt(r[i], 0) : 0n);
    const x = { who, r0: w(0), r1: w(1), supply: w(2), sp: w(3), totalStaked: w(4), rate: w(5), finish: Number(w(6)), t: Number(w(7)) || now(), staked: w(8), earned: w(9), tac: w(10), allowance: w(11), lp: w(12), lpAllow: w(13), bal, at: now() };
    const s = Number(x.sp) / 1e18;
    x.live = x.t < x.finish;
    x.perDay = x.live ? x.rate * 86400n : 0n;
    x.tacEth = s > 0 ? 1 / (s * s) : 0;                                             // ETH per TAC at the pool's price
    x.value = Number(x.r0) + Number(x.r1) * x.tacEth;                              // the pool's worth in ETH wei
    x.stakedEth = x.supply ? x.value * Number(x.totalStaked) / Number(x.supply) : 0;
    x.apr = x.live && x.stakedEth > 0 ? Number(x.perDay) * 365 * x.tacEth / x.stakedEth * 100 : null;
    x.mine = x.supply ? { eth: x.staked * x.r0 / x.supply, tac: x.staked * x.r1 / x.supply } : { eth: 0n, tac: 0n };
    if (my !== F.rseq || W.account !== who) return;                                // a newer read, or another account's, is the one to keep
    F.x = x; F.err = false;
  }
  const readProgram = () => api('/farm/program?network=mainnet').then((p) => { if (p?.epoch) F.prog = p; });

  // What the stake has earned by now, counted at its share of the stream since the read.
  const earnedNow = (x) => (!x?.live || !(x.staked > 0n) || !x.totalStaked ? x?.earned ?? 0n
    : x.earned + x.rate * x.staked / x.totalStaked * BigInt(Math.max(0, Math.min(now() + (x.t - x.at), x.finish) - x.t)));

  // ── the farm's figures and the private farms' stream ──
  function renderStats() {
    const x = F.x, el = $('#fm-stats');
    if (!x) { el.innerHTML = `<p class="note">${F.err ? 'The farm could not be read just now.' : 'Reading the farm…'}</p>`; return; }
    const cell = (k, v, s = '') => `<div><span class="k">${k}</span><b class="num">${v}</b>${s ? `<span class="s">${s}</span>` : ''}</div>`;
    el.innerHTML = cell('APR now', aprTxt(x.apr), 'paid in TAC, swap fees on top')
      + cell('Rewards', x.live ? `<svg class="tk xs inl" aria-hidden="true"><use href="#tk-tac"/></svg>${fmt(x.perDay, 18, 0)} TAC a day` : 'between periods', x.live ? tacUsd(x.perDay) ? `about ${tacUsd(x.perDay)} a day` : '' : '')
      + cell('Staked', ethUsd() ? usd(x.stakedEth / 1e18 * ethUsd()) : `${(x.stakedEth / 1e18).toFixed(2)} ETH`, x.supply ? `${Math.round(Number(x.totalStaked * 1000n / x.supply)) / 10}% of the pool` : '')
      + cell('Stream ends', x.live ? dayFmt(x.finish) : '—');
    // The farming program's private farms: shielded pools whose positions say nothing of who holds them. Each opens on the front page,
    // which signs in with a Tacit wallet and adds from private tETH, the paired asset, or both.
    const p = F.prog, e = p?.epoch;
    const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
    const pairName = (pair) => { const k = String(pair).split('/').map((y) => (y === 'cETH' ? 'tETH' : y)); if (k[1] === 'tETH') k.reverse(); return k.join(' / '); };
    const aprOf = (pool) => {
      const r = pool.reserves || {}, total = Number(r.lpTotalShares || 0);
      if (String(r.assetA).toLowerCase() !== CETH || !total || !x.tacEth) return null;
      const bonded = 2 * Number(r.reserveA) / 1e8 * Number(pool.totalShares) / total;            // ETH: the tETH side, twice, for the shares bonded
      return bonded > 0 ? Number(pool.tacPerDayForPool) * 365 * x.tacEth / bonded * 100 : null;
    };
    $('#fm-prog').innerHTML = e?.active && p.pools?.length
      ? `<div class="fm-ph"><b>Private farms</b><span>${Math.round(Number(e.ratePerDayTac)).toLocaleString('en-US')} TAC a day more, to ${dayFmt(e.periodFinish)}</span></div>`
        + p.pools.filter((pool) => Number(pool.tacPerDayForPool) > 0).map((pool) => `<a class="fm-pf" href="/#farm/private-${Number(pool.pid)}"><span class="pair">${esc(pairName(pool.pair))}</span><span class="d">${Math.round(Number(pool.tacPerDayForPool)).toLocaleString('en-US')} TAC a day</span><b class="num">${aprTxt(aprOf(pool))}</b><i aria-hidden="true">→</i></a>`).join('')
        + '<p class="note">Shielded positions: who farms and how much stays private. Opens with your Tacit wallet on the main page.</p>'
      : '';
  }

  // ── a stake: what it holds and earns, claim, stake loose shares, withdraw ──
  function renderPos() {
    const x = F.x, el = $('#fm-pos');
    clearInterval(F.tick);
    if (!x || !W.account || x.who !== W.account || !(x.staked > 0n || x.lp > 0n)) { el.hidden = true; el.innerHTML = ''; $('#fm-add-h').textContent = 'Farm TAC/ETH'; return; }
    el.hidden = false; $('#fm-add-h').textContent = 'Add more';
    const day = x.totalStaked ? x.perDay * x.staked / x.totalStaked : 0n, has = x.staked > 0n;
    el.innerHTML = (has ? `<h3>Your stake</h3>
      <div class="kv"><span>In the farm</span><b>${amt(x.mine.eth, 4)} ETH + ${amt(x.mine.tac, 0)} TAC</b></div>
      <div class="kv"><span>Earning</span><b>${amt(day, 2)} TAC a day${tacUsd(day) ? ` · ${tacUsd(day)}` : ''}</b></div>
      <div class="kv"><span>Your share</span><b>${share(x.staked, x.totalStaked)}</b></div>
      <div class="kv"><span>Earned</span><b class="num" id="fm-earned">${fmt(earnedNow(x), 18, 4)} TAC</b></div>
      <button class="btn ghost" type="button" id="fm-claim">Claim TAC</button>
      <div class="lbl"><span>Withdraw</span></div>
      <div class="fm-out"><div class="seg" id="fm-pct" role="group" aria-label="How much">${[['25', '25%'], ['50', '50%'], ['100', 'All']].map(([v, l]) => `<button type="button" data-pct="${v}" aria-pressed="${F.outPct === v}">${l}</button>`).join('')}</div>
      <div class="seg" id="fm-as" role="group" aria-label="As">${[['both', 'ETH + TAC'], ['eth', 'ETH'], ['tac', 'TAC']].map(([v, l]) => `<button type="button" data-as="${v}" aria-pressed="${F.outAs === v}">${l}</button>`).join('')}</div></div>
      <div class="fm-rcpt" id="fm-out-rcpt" hidden></div>
      <button class="btn ghost" type="button" id="fm-exit" disabled>Withdraw</button>` : '')
      + (x.lp > 0n ? `<div class="kv"><span>LP shares not staked</span><b>${fmt(x.lp, 18, 6)}</b></div><button class="btn ghost" type="button" id="fm-stake">Stake them</button>` : '');
    if (has && x.live) F.tick = setInterval(() => { const e = $('#fm-earned'); if (!e || F.x !== x) return clearInterval(F.tick); e.textContent = `${fmt(earnedNow(x), 18, 4)} TAC`; }, 1000);
    if (has) previewOut();
  }

  // ── adding ──
  function renderForm() {
    const x = F.x, m = F.mode;
    $('#fm-mode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fm === m)));
    $('#fm-eth').hidden = m === 'tac'; $('#fm-tac').hidden = m === 'eth';
    $('#fm-how').textContent = m === 'pair' ? 'Both go in at the pool’s ratio, nothing swapped, then the shares are staked.' : `About half is swapped to ${m === 'eth' ? 'TAC' : 'ETH'} inside the pool, then both go in and the shares are staked. One transaction.`;
    const em = $('#fm-emax'), tm = $('#fm-tmax'), mine = x && W.account && x.who === W.account;
    em.hidden = !(mine && x.bal != null); tm.hidden = !mine;
    if (mine && x.bal != null) em.textContent = `Balance ${fmt(x.bal, 18, 4)} · Max`;
    if (mine) tm.textContent = `Balance ${fmt(x.tac, 18, 2)} · Max`;
    gate();
  }
  function gate() {
    const q = F.q, x = F.x;
    if (F.busy) return;
    go.disabled = false;
    if (!W.account) { go.textContent = 'Connect wallet'; return; }
    go.textContent = { eth: 'Farm with ETH', tac: 'Farm with TAC', pair: 'Farm with ETH + TAC' }[F.mode];
    const ack = $('#fm-ack');
    go.disabled = !q || q.over || !x || (q.loss >= 15 && !(ack && ack.checked));
  }
  const up = (v, dp) => { const u = 10n ** BigInt(18 - dp); return ((v + u - 1n) / u) * u; };
  const mineX = (x) => !!W.account && x?.who === W.account;
  const spendEth = (x) => (x.bal != null && x.bal > GAS ? x.bal - GAS : 0n);
  const capTac = (v, x) => (mineX(x) && v > x.tac ? x.tac : v), capEth = (v, x) => (mineX(x) && x.bal != null && v > spendEth(x) ? spendEth(x) : v);
  const tacFor = (wei, x) => (x.r0 > 0n ? (wei * x.r1 + x.r0 - 1n) / x.r0 : 0n);   // TAC at the pool's ratio
  const ethFor = (tac, x) => (x.r1 > 0n ? (tac * x.r0 + x.r1 - 1n) / x.r1 : 0n);
  async function requote(src = null) {
    const my = ++F.seq, x = F.x, m = F.mode;
    // The other side follows at the pool's ratio, rounded up so the pair is whole, but never past what the wallet holds.
    if (m === 'pair' && x && src === ethIn) { const v = parseUnits(ethIn.value); tacIn.value = !ethIn.value ? '' : v != null ? plain(capTac(up(tacFor(v, x), 2), x)) : tacIn.value; }
    if (m === 'pair' && x && src === tacIn) { const v = parseUnits(tacIn.value); ethIn.value = !tacIn.value ? '' : v != null ? plain(capEth(up(ethFor(v, x), 6), x)) : ethIn.value; }
    const wei = m !== 'tac' ? parseUnits(ethIn.value) || 0n : 0n, tac = m !== 'eth' ? parseUnits(tacIn.value) || 0n : 0n;
    F.q = null; gate();
    if (!x || (!wei && !tac)) { rc.hidden = true; rc.innerHTML = ''; return; }
    try {
      let lp, loss = 0;
      if (m === 'pair') {
        const r = await ethCall(LENS, SEL.previewAdd + addr(POOL) + word(wei) + word(tac));
        if (wordAt(r, 0) !== 1n || wordAt(r, 1) === 0n) throw new Error('The pool would refuse this deposit.');
        lp = wordAt(r, 1);
      } else {
        const amount = m === 'eth' ? wei : tac;
        const r = await ethCall(LENS, SEL.previewZap + addr(POOL) + addr(m === 'eth' ? ZERO : TAC) + word(amount));
        if (wordAt(r, 0) !== 1n || wordAt(r, 2) === 0n) throw new Error('The pool would refuse this deposit.');
        lp = wordAt(r, 2);
        const ideal = Number(x.supply) * (m === 'eth' ? Number(amount) : Number(amount) * x.tacEth) / x.value;     // shares a balanced deposit of the same worth gets
        loss = ideal > 0 ? Math.max(0, (1 - Number(lp) / ideal) * 100) : 0;
      }
      if (my !== F.seq) return;
      const day = x.perDay * lp / (x.totalStaked + lp);
      const inEth = Number(wei) + Number(tac) * x.tacEth, apr = x.live && inEth > 0 ? Number(day) * 365 * x.tacEth / inEth * 100 : null;
      const mine = W.account && x.who === W.account, over = mine && ((x.bal != null && wei > x.bal) || tac > x.tac);
      const ackKey = `${m}|${wei}|${tac}|${Math.round(loss)}`;
      F.q = { m, wei, tac, lp, loss, over };
      rc.hidden = false;
      rc.innerHTML = `${m === 'pair' ? `<div class="kv"><span>Deposit</span><b>${fmt(wei, 18, 5)} ETH + ${fmt(tac, 18, 2)} TAC</b></div>` : ''}
        <div class="kv"><span>Earns about</span><b>${amt(day, 2)} TAC a day${tacUsd(day) ? ` · ${tacUsd(day)}` : ''}</b></div>
        <div class="kv"><span>APR on this deposit</span><b>${aprTxt(apr)}</b></div>
        <div class="kv"><span>Share of the farm</span><b>${share(lp, x.totalStaked + lp)}</b></div>
        ${loss >= 0.5 ? `<div class="kv"><span>Price impact of the swap</span><b class="${loss >= 5 ? 'err' : ''}">${loss.toFixed(loss < 10 ? 1 : 0)}%</b></div>` : ''}
        ${x.live ? `<p class="note">At today’s TAC price and stake, while the stream runs to ${dayFmt(x.finish)}. It falls as more joins.</p>` : '<p class="note">The farm is between reward periods: nothing streams until the next one starts.</p>'}
        ${over ? `<p class="note err">Not enough ${(x.bal != null && wei > x.bal) ? 'ETH' : 'TAC'} in this wallet.</p>` : loss >= 5 ? `<p class="note">The swap inside the pool costs a lot at this size. A smaller deposit${m !== 'pair' ? ', or ETH + TAC,' : ''} costs less.</p>` : ''}
        ${loss >= 15 ? `<label class="ack"><input type="checkbox" id="fm-ack"${F.ackKey === ackKey ? ' checked' : ''}><span>I accept losing about ${Math.round(loss)}% of this deposit to the swap.</span></label>` : ''}`;
      $('#fm-ack')?.addEventListener('change', (e) => { F.ackKey = e.target.checked ? ackKey : null; gate(); });
      gate();
    } catch (e) { if (my === F.seq) { rc.hidden = false; rc.innerHTML = `<p class="note err">${errMsg(e)}</p>`; } }
  }

  // The farm's transaction, tested once before the wallet is asked to send it, then waited for.
  async function send(tx, label, at, from) {
    say(at, 'Testing it first…');
    await ethCall(FARM, tx.data, 'latest', { from, value: tx.value ? '0x' + tx.value.toString(16) : undefined }).catch((e) => { throw new Error(e?.revert ? 'This would fail right now, so it was not sent. Try a smaller amount or again soon.' : 'The farm could not be reached to test this. Nothing was sent.'); });
    say(at, 'Confirm in your wallet.');
    const hash = await wallet.sendTx({ to: FARM, data: tx.data, value: tx.value || 0n, from });                 // the wallet refuses if its account has changed since
    say(at, `${label}… ${txLink(hash)}`);
    const r = await wallet.receipt(hash);
    if (r.status !== '0x1') throw new Error(`The transaction failed on chain (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`);
    return { hash, r };
  }
  const permit = async (token, name, value, dl, from) => {
    const nonce = wordAt(await ethCall(token, SEL.nonces + addr(from)), 0);
    const s = await wallet.signPermit({ token, name, spender: FARM, value, deadline: dl, nonce, owner: from });
    return word(s.v) + strip(s.r) + strip(s.s);
  };
  const deadline = () => BigInt((F.x ? F.x.t + (now() - F.x.at) : now()) + 1800);          // on the chain's clock, which a computer's can be off from
  const run = async (btn, at, f) => {
    if (F.busy) return;
    F.busy = true; btn.disabled = true; btn.setAttribute('aria-busy', 'true'); lock(true);
    try { await f(); } catch (e) { say(at, `<span class="err">${errMsg(e)}</span>`); }
    finally { F.busy = false; btn.removeAttribute('aria-busy'); lock(false); await refresh(); }
  };
  const lock = (b) => { [ethIn, tacIn].forEach((i) => { i.disabled = b; }); host.querySelectorAll('#fm-mode button, #fm-pct button, #fm-as button').forEach((x) => { x.disabled = b; }); };

  go.onclick = () => {
    if (!W.account) return connect();
    const z = F.q, x = F.x, from = W.account;
    if (!z || z.over || !x || x.who !== from || (z.loss >= 15 && !$('#fm-ack')?.checked)) return;
    run(go, status, async () => {
      const minShares = z.lp * 995n / 1000n, dl = deadline(), tail = word(minShares) + word(dl);
      const needPermit = z.tac > 0n && x.allowance < z.tac;
      if (needPermit) say(status, 'Sign the permit for your TAC in your wallet. It costs no gas.');
      const sig = needPermit ? await permit(TAC, 'Tacit Token', z.tac, dl, from) : '';
      const tx = z.m === 'eth' ? { data: SEL.zapETH + word(0) + tail, value: z.wei }
        : z.m === 'tac' ? { data: (needPermit ? SEL.zapTokenWithPermit : SEL.zapToken) + word(z.tac) + word(0) + tail + sig }
        : { data: (needPermit ? SEL.addAndStakeWithPermit : SEL.addAndStake) + word(z.tac) + tail + sig, value: z.wei };
      const { hash } = await send(tx, 'Farming', status, from);
      ethIn.value = ''; tacIn.value = ''; F.q = null; rc.hidden = true;
      say(status, `<span class="ok">Farming.</span> TAC streams to you every second. ${txLink(hash)}`);
      onDone();
    });
  };

  host.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || F.busy) return;
    if (b.dataset.fm) { F.mode = b.dataset.fm; F.q = null; if (F.mode === 'pair' && ethIn.value) requote(ethIn); else requote(); renderForm(); return; }
    if (b.dataset.pct) { F.outPct = b.dataset.pct; renderPos(); return; }
    if (b.dataset.as) { F.outAs = b.dataset.as; renderPos(); return; }
    const x = F.x;
    // Max: the whole balance of one side; with both, the largest pair the two balances cover, each side within its balance.
    if ((b.id === 'fm-emax' || b.id === 'fm-tmax') && x && mineX(x)) {
      if (F.mode !== 'pair') {
        if (b.id === 'fm-emax' && x.bal != null) { const wei = cut(spendEth(x), 6); ethIn.value = wei > 0n ? plain(wei) : ''; }
        if (b.id === 'fm-tmax') { const tac = cut(x.tac, 2); tacIn.value = tac > 0n ? plain(tac) : ''; }
      } else if (x.bal != null) {
        let wei = cut(spendEth(x), 6), tac = capTac(up(tacFor(wei, x), 2), x);
        if (tacFor(wei, x) > x.tac) { tac = cut(x.tac, 2); wei = capEth(up(ethFor(tac, x), 6), x); }
        ethIn.value = wei > 0n ? plain(wei) : ''; tacIn.value = tac > 0n ? plain(tac) : '';
      }
      requote();
    }
    const ps = () => $('#fm-pos-status'), from = W.account;
    if (['fm-claim', 'fm-stake', 'fm-exit'].includes(b.id) && (!from || x?.who !== from)) return;
    if (b.id === 'fm-claim') run(b, ps(), async () => {
      const { hash, r } = await send({ data: SEL.claim }, 'Claiming', ps(), from);
      const got = (r.logs || []).filter((l) => l.address.toLowerCase() === FARM.toLowerCase() && l.topics[0] === REWARD_PAID).reduce((t, l) => t + BigInt(l.data), 0n);
      say(ps(), `<span class="ok">Claimed${got ? ` ${fmt(got, 18, 2)} TAC` : ''}.</span> ${txLink(hash)}`); onDone();
    });
    if (b.id === 'fm-stake') run(b, ps(), async () => {
      const dl = deadline(), sig = x.lpAllow < x.lp ? await permit(POOL, 'Precision LP', x.lp, dl, from) : '';
      const { hash } = await send({ data: sig ? SEL.stakeWithPermit + word(x.lp) + word(dl) + sig : SEL.stake + word(x.lp) }, 'Staking', ps(), from);
      say(ps(), `<span class="ok">Staked.</span> ${txLink(hash)}`); onDone();
    });
    if (b.id === 'fm-exit' && F.w && !(F.w.loss >= 15 && !$('#fm-out-ack')?.checked)) run(b, ps(), async () => {
      const z = F.w, dl = deadline();
      const sim = await ethCall(FARM, outData(z, 0n, 0n, dl), 'latest', { from });
      const m0 = wordAt(sim, 0) * 995n / 1000n, m1 = z.as === 'both' ? wordAt(sim, 1) * 995n / 1000n : 0n;
      const { hash } = await send({ data: outData(z, m0, m1, dl) }, 'Withdrawing', ps(), from);
      say(ps(), `<span class="ok">Withdrawn.</span> ${txLink(hash)}`); onDone();
    });
  });
  // All of it goes through exit*, which also pays what was earned; part of it through withdraw*, which leaves the rest staked.
  const outData = ({ all, as, shares }, m0, m1, dl) => (as === 'both'
    ? (all ? SEL.exitAndRemove : SEL.withdrawAndRemove + word(shares)) + word(m0) + word(m1) + word(dl)
    : (all ? SEL.exitTo + word(as === 'eth' ? 1 : 0) : SEL.withdrawTo + word(as === 'eth' ? 1 : 0) + word(shares)) + word(m0) + word(dl));
  async function previewOut() {
    const x = F.x, my = ++F.wseq, all = F.outPct === '100', as = F.outAs, shares = all ? x.staked : x.staked * BigInt(F.outPct) / 100n, el = $('#fm-out-rcpt'), ex = $('#fm-exit');
    F.w = null;
    try {
      const r = await ethCall(FARM, outData({ all, as, shares }, 0n, 0n, deadline()), 'latest', { from: W.account });
      if (my !== F.wseq || !ex?.isConnected) return;
      const worth = x.value * Number(shares) / Number(x.supply), got = as === 'both' ? null : Number(wordAt(r, 0));      // in ETH wei at the pool's price
      const loss = got == null || !worth ? 0 : Math.max(0, (1 - got / (as === 'eth' ? worth : worth / x.tacEth)) * 100);
      F.w = { all, as, shares, loss };
      el.hidden = false;
      el.innerHTML = `<div class="kv"><span>You get about</span><b>${as === 'both' ? `${amt(wordAt(r, 0), 5)} ETH + ${amt(wordAt(r, 1), 2)} TAC` : `${amt(wordAt(r, 0), as === 'eth' ? 5 : 2)} ${as === 'eth' ? 'ETH' : 'TAC'}`}</b></div>${all && x.earned > 0n ? `<div class="kv"><span>Plus earned</span><b>${fmt(earnedNow(x), 18, 2)} TAC</b></div>` : ''}`
        + (loss >= 0.5 ? `<div class="kv"><span>Price impact of the swap</span><b class="${loss >= 5 ? 'err' : ''}">${loss.toFixed(loss < 10 ? 1 : 0)}%</b></div>` : '')
        + (loss >= 15 ? `<label class="ack"><input type="checkbox" id="fm-out-ack"><span>I accept losing about ${Math.round(loss)}% of this withdrawal to the swap.</span></label>` : '');
      ex.textContent = all ? 'Withdraw all' : `Withdraw ${F.outPct}%`;
      const outGate = () => { ex.disabled = F.busy || (loss >= 15 && !$('#fm-out-ack')?.checked); };
      $('#fm-out-ack')?.addEventListener('change', outGate); outGate();
    } catch { if (my === F.wseq && el) { el.hidden = false; el.innerHTML = '<p class="note err">The withdrawal could not be previewed just now.</p>'; } }
  }

  let t = 0;
  ethIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => requote(ethIn), 300); });
  tacIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => requote(tacIn), 300); });

  // A read of the farm and the account: the figures and the stake redrawn, the form kept as typed and quoted again.
  async function refresh() {
    await Promise.allSettled([read().catch(() => { if (!F.x) F.err = true; }), F.prog ? null : readProgram()]);
    renderStats(); renderForm();
    if (!F.busy) { renderPos(); if (ethIn.value || tacIn.value) requote(); }
  }
  renderForm(); refresh();
  return { refresh, paint: renderStats, busy: () => F.busy };
}
