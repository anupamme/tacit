// The tasks page: jobs anyone can do for TAC from the points program's separate task budget. A job is a list of steps (transactions);
// the page shows what each does, checks in the browser that the transactions it would send are the plan's, sends the ones still
// open from the visitor's wallet, and names each one to the points service, which reads it from the chain, prices it from the gas
// of its own block and the TAC price around it, and credits the account that sent it. Nothing the page reads or sends depends
// on the service except the reward: the deployment is the same from any browser.
import { makeConnect, UserStopped } from '/trade/connect.js?cb=f4bd67db';
import { esc } from '/trade/sheet.js?cb=84cda8f2';
import { rpc, $, short, fmtUnits } from '/trade/util.js?cb=c3dc39b3';
import { checkPayload, checkStep } from '/tasks/verify.js?cb=25dba64d';

const POINTS = 'https://tacit-points.onrender.com';
const ETHERSCAN = 'https://etherscan.io';
const STORE = 'tacit.tasks.v1';
const HASH = /^0x[0-9a-fA-F]{64}$/;
const tac = (wei, max = 2) => (wei == null ? '—' : fmtUnits(BigInt(wei), 18, max));
// A whole number of TAC, rounded to the nearest (the figures a person reads at a glance).
const tacR = (wei) => (wei == null ? '—' : fmtUnits(BigInt(wei) + 5n * 10n ** 17n, 18, 0));

const S = { jobs: [], api: null, done: {}, payload: {}, verdict: {}, running: false, hashes: {}, mine: [], jobId: null };

// ── what the browser remembers: the transactions this visitor sent or named, until the service has answered for each ──
const remembered = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const remember = (o) => { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch { /* private window: the page works without it */ } };
S.hashes = remembered();

// ── the wallet ──
// The notice under the ticket. It is kept, because the panel is drawn again whenever something it shows changes.
let notice = { text: '', bad: false };
const say = (text, bad = false) => { notice = { text, bad }; paintNotice(); };
const paintNotice = () => { const el = $('#status'); if (el) { el.className = `status${notice.bad ? ' err' : ''}`; el.innerHTML = notice.text; } };
const conn = makeConnect({
  describe: 'Tasks: do a listed job from your wallet and earn TAC', say: (t, b) => say(t, b),
  busy: () => S.running, onChange: () => { renderAll(); loadApi(); },
});
const W = conn.W;
$('#wallet-chip').hidden = false;

// ── reading ──
const get = (url) => fetch(url, { signal: AbortSignal.timeout(15e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const ZERO = `0x${'0'.repeat(64)}`;
const flagged = (r) => String(r).slice(2, 66) === `${'0'.repeat(63)}1`;

// Whether each step is already on the chain: code at a deployment's address, the asset or the pool in the confidential pool's registry.
async function readDone(job) {
  const out = {};
  await Promise.all(job.steps.map(async (s) => {
    try {
      if (s.kind === 'createx') out[s.id] = (await rpc('eth_getCode', [s.expected, 'latest'])) !== '0x';
      else if (s.kind === 'register') out[s.id] = flagged(await call(s.to, `0x9fda5b66${s.asset.slice(2)}`));
      else out[s.id] = flagged(await call(s.to, `0xb5217bb4${s.poolId.slice(2)}`));
    } catch { out[s.id] = null; }
  }));
  return out;
}
async function loadApi() {
  S.api = await get(`${POINTS}/tasks${W.account ? `?address=${W.account}` : ''}`);
  renderAll();
}
async function refresh() {
  const job = current();
  if (job && !S.running) S.done = await readDone(job);
  renderAll();
}

const current = () => S.jobs.find((j) => j.id === S.jobId) || S.jobs[0] || null;
const apiJob = (job) => S.api?.enabled ? S.api.jobs?.find((j) => j.id === job.id) : null;
const isOpen = (job) => !!(S.api?.enabled && job.opensAt && Date.now() / 1000 >= job.opensAt);

// ── drawing ──
const when = (t) => new Date(t * 1000).toUTCString().replace(/ GMT$/, ' UTC').replace(/^\w+, /, '');
function renderAll() {
  renderTiles();
  const typed = $('#hashes')?.value ?? '';
  renderJob();
  if (typed && $('#hashes')) $('#hashes').value = typed;
  paintNotice();
}

const doneOf = (job) => job.steps.filter((s) => S.done[s.id]).length;
function pill(job) {
  if (doneOf(job) === job.steps.length) return ['All done', 'ok'];
  if (!S.api) return ['Rewards offline', 'mute'];
  if (!isOpen(job)) return ['Opens soon', 'mute'];
  return ['Open', 'ok'];
}
// What the job pays now, from the gas of its steps at the service's latest slow-mode gas price and TAC price: the gas, with the tip, held to the job's floor and cap.
function economics(job) {
  const q = S.api?.quote, t = S.api?.terms;
  if (!S.api?.enabled || !q?.fresh || !q.tacPerEthWei || !t) return null;
  const gas = job.steps.reduce((n, s) => n + BigInt(s.gas), 0n);
  const eth = gas * BigInt(q.gasPriceWei), plain = (eth * BigInt(q.tacPerEthWei)) / 10n ** 18n;
  const tipped = (plain * (10000n + BigInt(t.tipBps))) / 10000n, floor = BigInt(t.floorWei), cap = BigInt(t.capWei);
  const pays = tipped < floor ? floor : tipped > cap ? cap : tipped;
  return { gas, eth, plain, tipped, floor, cap, pays, by: tipped < floor ? 'floor' : tipped > cap ? 'cap' : 'gas' };
}
function renderTiles() {
  const cur = current();
  $('#tiles').innerHTML = S.jobs.map((j) => {
    const [label, cls] = pill(j), n = doneOf(j), eco = economics(j), on = j.id === cur?.id;
    return `<button class="tile${on ? ' on' : ''}" type="button" data-job="${esc(j.id)}" aria-pressed="${on}">
      <span class="tile-top"><b>${esc(j.title)}</b><span class="pill ${cls}">${label}</span></span>
      <span class="tile-sub">${esc(j.tagline)}</span>
      <span class="tile-fig"><span class="big num">${eco ? `≈ ${tacR(eco.pays)}<small>TAC</small>` : '—'}</span><span class="cap">${eco ? 'for the whole job, at today\'s gas' : 'shown when rewards are open'}</span></span>
      <span class="bar" role="img" aria-label="${n} of ${j.steps.length} steps on the chain"><i style="width:${(100 * n) / j.steps.length}%"></i></span>
      <span class="tile-foot"><span>${n} of ${j.steps.length} steps on the chain</span><span>${(job_gas(j) / 1e6).toFixed(1)}M gas</span></span>
    </button>`;
  }).join('');
  $('#tiles').querySelectorAll('[data-job]').forEach((b) => { b.onclick = () => { S.jobId = b.dataset.job; history.replaceState(null, '', `#${S.jobId}`); refresh(); }; });
}
const job_gas = (j) => j.steps.reduce((n, s) => n + s.gas, 0);

function renderRewards(job) {
  const a = S.api, eco = economics(job);
  const how = `<ol class="how">
    <li><span><b>Connect and send.</b> The page checks each transaction against the plan first, then your wallet signs it.</span></li>
    <li><span><b>Twelve confirmations.</b> The service reads the step from the chain and fixes its reward from the gas price of its block.</span></li>
    <li><span><b>Paid with your daily rewards.</b> It is credited to the account that sent the step and claimed from the <a href="/#points">rewards page</a>.</span></li>
  </ol>`;
  if (!a) return `<p class="eyebrow">Rewards</p>${how}<p class="note">The rewards service did not answer. The steps can still be read; ask again in a moment for what they pay.</p>`;
  if (!a.enabled) return `<p class="eyebrow">Rewards</p>${how}<p class="note">Rewards are not switched on yet. Nothing sent now is paid for later.</p>`;
  const left = BigInt(a.budget.remainingWei);
  return `<p class="eyebrow"><span>Rewards</span><span class="who">${a.quote?.fresh ? 'live' : 'price not fresh'}</span></p>
    <p class="sum num">${eco ? `≈ ${tacR(eco.pays)}<small>TAC for the job</small>` : '—'}</p>
    ${eco ? `<div class="eq">
      <div class="l"><span>Gas for the whole job</span><b class="num">${(Number(eco.eth) / 1e18).toFixed(4)} ETH ≈ ${tac(eco.plain)} TAC</b></div>
      <div class="l"><span>With the ${Number(a.terms.tipBps) / 100}% tip</span><b class="num">${tac(eco.tipped)} TAC</b></div>
      <div class="l"><span>Floor · cap for the job</span><b class="num">${tac(eco.floor, 0)} · ${tac(eco.cap, 0)} TAC</b></div>
      <div class="l tot"><span>${eco.by === 'floor' ? 'Pays the floor' : eco.by === 'cap' ? 'Pays the cap' : 'Pays'}</span><b class="num">${tac(eco.pays)} TAC</b></div>
    </div>` : ''}
    <p class="note">Each step takes its share by gas, fixed from the gas price of the block it lands in. Gas is priced slow-mode, in TAC at the ${a.quote ? esc(a.quote.venue) : 'deepest'} venue's price${a.quote?.tacPerEthWei ? ` (${tac(a.quote.tacPerEthWei, 0)} TAC per ETH)` : ''}.</p>
    ${how}
    <div class="rows"><div class="kv"><span>Task budget left</span><b class="num">${tac(left, 0)} of ${tac(a.budget.totalWei, 0)} TAC</b></div><div class="kv"><span>Open until</span><b>${esc(when(a.endSec))}</b></div></div>`;
}

const chipFor = (c, done) => (c ? (c.state === 'credited' ? ['credited', 'Credited'] : ['claimed', 'Claimed']) : done ? ['deployed', 'On the chain'] : done === null ? ['unknown', 'Unknown'] : ['open', 'Open']);
function stepRow(job, s, i) {
  const aj = apiJob(job)?.steps.find((x) => x.id === s.id);
  const done = S.done[s.id], c = aj?.claim;
  const [cls, label] = chipFor(c, done);
  const est = !done && aj?.estimateWei != null ? ` · ≈ ${tac(aj.estimateWei)} TAC` : '';
  const bad = S.verdict[job.id]?.problems.find((p) => p.step === s.id);
  const addr = s.kind === 'createx' ? `<a href="${ETHERSCAN}/address/${esc(s.expected)}" target="_blank" rel="noopener noreferrer">${esc(s.expected)}</a>` : 'Call to the confidential pool';
  return `<li class="step${done ? ' is-done' : ''}">
    <span class="n num">${i + 1}</span>
    <span class="what"><b>${esc(s.label)}</b><small>${addr}${bad ? ` <span class="err">· ${esc(bad.bad.join('; '))}</span>` : ''}</small></span>
    <span class="chip-s ${cls}">${label}${est}</span>
    ${c ? `<span class="by">${c.state === 'credited' ? 'Credited' : 'Claimed'} to <a href="${ETHERSCAN}/address/${esc(c.address)}" target="_blank" rel="noopener noreferrer">${esc(short(c.address))}</a> · ${tac(c.wei)} TAC</span>` : ''}
  </li>`;
}

function renderJob() {
  const job = current(), el = $('#job');
  if (!job) { el.hidden = true; return; }
  el.hidden = false;
  const todo = job.steps.filter((s) => !S.done[s.id]);
  const aj = apiJob(job), open = isOpen(job), n = doneOf(job);
  const gas = todo.reduce((x, s) => x + s.gas, 0);
  const verdict = S.verdict[job.id];
  const deploys = job.steps.map((s, i) => [s, i]).filter(([s]) => s.kind === 'createx'), calls = job.steps.map((s, i) => [s, i]).filter(([s]) => s.kind !== 'createx');
  const eco = economics(job);
  const payNow = !open || !aj ? null : todo.length === job.steps.length && eco ? eco.pays : todo.reduce((x, s) => x + BigInt(aj.steps.find((y) => y.id === s.id)?.estimateWei ?? 0), 0n);
  el.innerHTML = `
    <div class="grid">
      <div class="col">
        <section class="panel p-about" aria-labelledby="j-h">
          <p class="eyebrow" id="j-h">The job</p>
          <h2 class="jt">${esc(job.title)}</h2>
          ${job.about.map((x) => `<div class="sec"><h3>${esc(x.h)}</h3><p>${esc(x.p)}</p></div>`).join('')}
          <div class="links">${job.links.map((l) => `<a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join('')}<a href="${esc(job.payloadUrl)}" target="_blank" rel="noopener noreferrer">The transactions (JSON) ↗</a></div>
        </section>
        <section class="panel p-steps" aria-labelledby="s-h">
          <p class="eyebrow" id="s-h"><span>Steps, in order</span><span class="who">${n} of ${job.steps.length} on the chain</span></p>
          <div class="meter"><span class="bar" role="img" aria-label="${n} of ${job.steps.length} steps on the chain"><i style="width:${(100 * n) / job.steps.length}%"></i></span></div>
          <p class="grp-h"><span>Contracts</span><span>${deploys.filter(([s]) => S.done[s.id]).length} of ${deploys.length}</span></p>
          <ol class="steps">${deploys.map(([s, i]) => stepRow(job, s, i)).join('')}</ol>
          <p class="grp-h"><span>Confidential pool</span><span>${calls.filter(([s]) => S.done[s.id]).length} of ${calls.length}</span></p>
          <ol class="steps">${calls.map(([s, i]) => stepRow(job, s, i)).join('')}</ol>
          <p class="note">${verdict ? (verdict.ok ? '<span class="ok">Checked in your browser: every transaction is the plan\'s, with the same code, salt, settings and address the job names.</span>' : '<span class="err">A transaction does not match the plan; nothing will be sent.</span>') : 'Before anything is sent, this page checks each transaction against the plan in your browser.'} <button class="linkbtn" type="button" id="verify">Check now</button></p>
        </section>
      </div>
      <div class="col">
        <section class="panel p-ticket" aria-labelledby="t-h">
          <p class="eyebrow" id="t-h">Do it</p>
          <div class="rows flat">
            <div class="kv"><span>Steps left</span><b class="num">${todo.length} of ${job.steps.length}</b></div>
            <div class="kv"><span>Gas for them</span><b class="num">${(gas / 1e6).toFixed(1)}M<small id="gasnote"></small></b></div>
            <div class="kv"><span>Pays, about</span><b class="num">${payNow != null ? `${tacR(payNow)} TAC` : '—'}</b></div>
          </div>
          <p class="hint">${!S.api ? 'The rewards service did not answer, so sending is paused: a step sent now might not be paid.' : !open ? 'Rewards for this job are not open yet, so the steps are not sent from here. They stay open to anyone later.' : todo.length ? 'Most wallets let you pick a slower speed: it costs you less than it pays.' : 'Everything in this job is on the chain.'}</p>
          <button class="btn" id="go" type="button" ${!todo.length || !open || S.running ? 'disabled' : ''}>${S.running ? 'Sending…' : !W.account ? 'Connect wallet' : todo.length ? `Send ${todo.length === job.steps.length ? 'all' : 'the remaining'} ${todo.length} steps` : 'Done'}</button>
          <div class="status" id="status" role="status"></div>
        </section>
        <section class="panel p-rewards" aria-labelledby="r-h">${renderRewards(job).replace('<p class="eyebrow"', '<p class="eyebrow" id="r-h"')}</section>
        <section class="panel p-mine" aria-labelledby="m-h">
          <p class="eyebrow" id="m-h">Your steps</p>
          ${renderMine(job)}
          <form id="paste" class="paste" autocomplete="off">
            <label class="lbl" for="hashes"><span>Sent a step yourself? Name its transaction</span></label>
            <textarea id="hashes" rows="2" spellcheck="false" placeholder="0x… (one or more transaction hashes)"></textarea>
            <button class="btn ghost" type="submit">Claim</button>
          </form>
        </section>
      </div>
    </div>`;
  el.querySelector('#go').onclick = go;
  el.querySelector('#verify').onclick = () => verify(job, true);
  el.querySelector('#paste').onsubmit = (e) => { e.preventDefault(); const found = [...new Set(el.querySelector('#hashes').value.match(/0x[0-9a-fA-F]{64}/g) || [])]; if (!found.length) { say('No transaction hash found there.', true); return; } found.forEach((h) => track(h)); el.querySelector('#hashes').value = ''; say(`Naming ${found.length} transaction${found.length > 1 ? 's' : ''} to the rewards service…`); settle(); };
  gasNote(gas);
}

function renderMine(job) {
  const a = S.api?.claims ?? [];
  const mine = a.filter((c) => c.job === job.id);
  const waiting = Object.entries(S.hashes).filter(([, v]) => v.state === 'pending');
  if (!mine.length && !waiting.length) return `<p class="empty">${W.account ? 'None yet.' : 'Connect a wallet to see the steps credited to it.'}</p>`;
  const label = (id) => job.steps.find((s) => s.id === id)?.label ?? id;
  const total = mine.reduce((x, c) => x + BigInt(c.wei), 0n);
  return `<ul class="mine">${mine.map((c) => `<li><span>${esc(label(c.step))}</span><span class="num">${tac(c.wei)} TAC · ${c.state === 'credited' ? 'credited' : 'waiting for the budget'}</span></li>`).join('')}${waiting.map(([h, v]) => `<li><a href="${ETHERSCAN}/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(short(h, 6))}</a><span>${esc(v.note || 'waiting for confirmations')}</span></li>`).join('')}</ul>${mine.length ? `<div class="rows"><div class="kv"><span>Yours so far</span><b class="num">${tac(total)} TAC</b></div></div>` : ''}`;
}

async function gasNote(gas) {
  try {
    const p = BigInt(await rpc('eth_gasPrice', []));
    const el = $('#gasnote'); if (el) el.textContent = `≈ ${(Number(BigInt(gas) * p) / 1e18).toFixed(4)} ETH at ${(Number(p) / 1e9).toFixed(3)} gwei`;
  } catch { /* the note is only a convenience */ }
}

// ── checking the plan ──
async function loadPayload(job) {
  if (!S.payload[job.id]) {
    const r = await fetch(job.payloadUrl, { signal: AbortSignal.timeout(30e3) });
    if (!r.ok) throw new Error('The transactions could not be loaded.');
    S.payload[job.id] = await r.json();
  }
  return S.payload[job.id];
}
async function verify(job, show = false) {
  try {
    S.verdict[job.id] = checkPayload(job, await loadPayload(job));
  } catch (e) { S.verdict[job.id] = { ok: false, problems: [{ step: '*', bad: [e.message] }] }; }
  renderAll();
  if (show && S.verdict[job.id].ok) say('Every transaction matches the plan: the same code, salts, settings and addresses the job names.');
  return S.verdict[job.id].ok;
}

// ── sending ──
async function go() {
  const job = current();
  if (!job || S.running) return;
  if (!W.account) { await conn.connect(); return; }
  S.running = true; renderAll();
  try {
    if (!(await verify(job))) { say('A transaction does not match the plan, so nothing was sent.', true); return; }
    const payload = S.payload[job.id];
    for (const [i, s] of job.steps.entries()) {
      S.done = await readDone(job);
      if (S.done[s.id]) continue;
      const tx = payload.steps[i];
      if (checkStep(job, s, tx).length) throw new Error('A transaction no longer matches the plan.');
      say(`Step ${i + 1} of ${job.steps.length}: ${esc(s.label)}. Confirm it in your wallet.`);
      const hash = await conn.wallet.sendTx({ to: tx.to, data: tx.data, value: 0n, from: W.account });
      say(`Step ${i + 1} sent: <a href="${ETHERSCAN}/tx/${esc(hash)}" target="_blank" rel="noopener noreferrer">${esc(short(hash, 6))}</a>. Waiting for it to land…`);
      const rc = await conn.wallet.receipt(hash);
      if (rc.status !== '0x1') throw new Error(`Step ${i + 1} failed on the chain. Nothing more was sent.`);
      track(hash);
      renderAll();
    }
    S.done = await readDone(job);
    renderAll();
    say('Everything is sent. Each step is named to the rewards service once it has twelve confirmations.');
  } catch (e) {
    say(esc(e instanceof UserStopped ? 'Stopped. Send again to carry on from where it left off.' : (e.message || 'The wallet did not send it.')), !(e instanceof UserStopped));
  } finally { S.running = false; S.done = await readDone(job).catch(() => S.done); renderAll(); settle(); }
}

// ── naming steps to the service ──
function track(hash) {
  const h = hash.toLowerCase();
  if (!S.hashes[h]) S.hashes[h] = { state: 'pending', note: 'waiting for confirmations' };
  remember(S.hashes);
}
let settling = false;
async function settle() {
  if (settling) return;
  const waiting = Object.keys(S.hashes).filter((h) => S.hashes[h].state === 'pending');
  if (!waiting.length) return;
  settling = true;
  try {
    for (let i = 0; i < waiting.length; i += 25) {
      const batch = waiting.slice(i, i + 25);
      const r = await fetch(`${POINTS}/tasks/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHashes: batch }), signal: AbortSignal.timeout(60e3) }).catch(() => null);
      if (!r || !r.ok) { for (const h of batch) S.hashes[h].note = r?.status === 429 ? 'the service asked to slow down' : 'the rewards service did not answer'; continue; }
      for (const res of (await r.json()).results) {
        const h = res.txHash.toLowerCase(), steps = res.steps.filter((x) => x.state);
        if (res.status === 'ok' && steps.length && steps.every((x) => ['queued', 'credited'].includes(x.status))) S.hashes[h] = { state: 'done' };
        else if (res.status === 'no step') S.hashes[h] = { state: 'void', note: 'not a step of a listed job' };
        else if (res.status === 'failed') S.hashes[h] = { state: 'void', note: 'the transaction failed' };
        else if (res.status === 'ok') S.hashes[h].note = steps.map((x) => x.status).filter((x) => !['queued', 'credited'].includes(x))[0] ?? 'waiting';
        else S.hashes[h].note = res.status === 'confirming' ? `${res.confirmationsLeft} confirmations to go` : res.status;
      }
    }
  } finally { remember(S.hashes); settling = false; loadApi(); }
}

// ── start ──
async function start() {
  const file = await get('/tasks/jobs.json');
  if (!file?.jobs?.length) { $('#tiles').innerHTML = '<p class="empty">The jobs could not be loaded.</p>'; return; }
  S.jobs = file.jobs;
  S.jobId = location.hash.slice(1) || S.jobs[0].id;
  renderAll();
  await Promise.all([loadApi(), refresh()]);
  setInterval(() => { if (!document.hidden && !S.running) { refresh(); loadApi(); } }, 30e3);
  setInterval(() => { if (!document.hidden) settle(); }, 20e3);
  settle();
}
start();
