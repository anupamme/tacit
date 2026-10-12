#!/usr/bin/env node
// dapp/trade/ in a real browser, under its own CSP: Ethereum is an anvil fork of mainnet (so the price tape, the pools and the
// quotes are the chain's own), the Bitcoin order book is the fixtures captured from the API on 2026-10-12 with their expiry moved
// forward. Checks the head, the lanes, the chart in each lane and size, the ticket's routes (a split among them), the venues table,
// the order book and the facts, at a desktop and a phone width, and that nothing was blocked or logged as an error.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-page.mjs        (SHOTS=dir saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, FX = new URL('./fixtures/', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co', SHOTS = process.env.SHOTS || null;
const PORT = 21000 + Math.floor(Math.random() * 1000), WEB = PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
let server;
const done = () => { anvil.kill('SIGKILL'); server?.close(); };
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) { try { await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })).json(); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  // As the host does: a directory is served at its address with the slash; without it, or with no file at all, the front page answers and its head script sends the visitor on.
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');            // as the host does: an address with no file of its own is the front page, which sends it on
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const asset = JSON.parse(readFileSync(join(FX, 'tac-asset-2026-10-12.json'), 'utf8')), sales = JSON.parse(readFileSync(join(FX, 'tac-sales-2026-10-12.json'), 'utf8'));
const soon = Math.floor(Date.now() / 1000) + 7 * 86400;
sales.sales = sales.sales.map((x) => ({ ...x, expiry: soon, expired: false, seller_pubkey: '02' + 'ab'.repeat(32) }));
const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co'];

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const until = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout });

const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();
const rpcA = async (method, params = []) => { const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result; };
const TACADDR = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', ROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const tacBal = async (a) => BigInt(await rpcA('eth_call', [{ to: TACADDR, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
const ethBal = async (a) => BigInt(await rpcA('eth_getBalance', [a, 'latest']));

// A wallet in the page: window.ethereum answers as an EIP-1193 provider, signs TAC's permit with a real key and sends through the fork.
async function stubWallet(ctx, { account, key, refuseSends = false }) {
  const log = { sends: [], signs: 0, connects: 0 };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    if (method === 'eth_requestAccounts') { log.connects++; return [account]; }
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') { if (log.onChainId) { const f = log.onChainId; log.onChainId = null; await f(); } return '0x1'; }
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_signTypedData_v4') { log.signs++; return cast('wallet', 'sign', '--private-key', key, '--data', params[1]); }
    if (method === 'eth_sendTransaction') {
      if (refuseSends) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      log.sends.push(params[0]);
      return rpcA('eth_sendTransaction', [{ ...params[0], gas: '0x3d0900' }]);
    }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => { window.__h = {}; window.ethereum = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on(ev, fn) { window.__h[ev] = fn; }, removeListener() {} }; });
  return log;
}
async function fundedWallet(eth, tac) {
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], who = j.address;
  await rpcA('anvil_setBalance', [who, '0x' + eth.toString(16)]);
  if (tac) {
    const slot = cast('keccak', '0x' + who.slice(2).toLowerCase() + '0000000000000000' + '87a211a2');     // Solady's balance slot
    await rpcA('anvil_setStorageAt', [TACADDR, slot, '0x' + tac.toString(16).padStart(64, '0')]);
  }
  await rpcA('anvil_impersonateAccount', [who]);
  return { account: who, key: j.private_key };
}

async function openPage(viewport, wallet = null, hash = '', path = '/trade/') {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
  const walletLog = wallet ? await stubWallet(ctx, wallet) : null;
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    try {
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
    } catch (e) { await route.fulfill({ status: 502, headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
  });
  await ctx.route(/^https:\/\/api\.tacit\.finance\/assets\//, (route) => {
    const body = /preauth-sales/.test(route.request().url()) ? sales : asset;
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); (/Content Security Policy|Refused to/i.test(t) ? blocked : errors).push(t); } });
  if (walletLog) await page.clock.install();                                   // the wallet pages' timers can be moved on by a test
  await page.goto(`http://127.0.0.1:${WEB}${path}${hash}`);
  return { browser, page, errors, blocked, walletLog };
}

const candles = (page) => page.$$eval('#chart .body', (b) => b.length);
const lines = (page) => page.$$eval('#chart polyline', (b) => b.length);
let r;
try {
  r = await openPage({ width: 1280, height: 900 });
  const p = r.page;
  await until(p, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || '') && document.querySelectorAll('#lanes .lane .v').length === 4 && !document.querySelector('#lanes .sk') && document.querySelectorAll('#chart .body').length > 5 && document.querySelectorAll('#depth .dep').length > 3, null, 240000).catch(async (e) => {
    console.log('     page at the first wait:', JSON.stringify(await p.evaluate(() => ({ url: location.href, px: document.querySelector('#px-usd')?.textContent, lanes: document.querySelectorAll('#lanes .lane .v').length, skeleton: !!document.querySelector('#lanes .sk'), candles: document.querySelectorAll('#chart .body').length, asks: document.querySelectorAll('#depth .dep').length, chart: document.querySelector('#chart')?.textContent.slice(0, 80) }))), 'errors:', r.errors.slice(0, 3), 'blocked:', r.blocked.slice(0, 2));
    throw e;
  });

  const head = (await text(p, '#px-usd')).trim(), sub = (await text(p, '#px-sub')).replace(/\s+/g, ' ');
  ok(/^\$0\.\d{2,}/.test(head), `the head shows TAC's price in dollars (${head})`);
  ok(/[\d.]+ ETH · [\d,]+ TAC to the ETH/.test(sub) && /traded in the last day/.test(sub), `and in ETH, TAC to the ETH and the day's volume (${sub.slice(0, 120)})`);
  const lanes = await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  ok(lanes.length === 4 && /Precision pool.*\$0\.\d+.*ETH.*the reference/.test(lanes[0]) && /Tacit pool.*\$0\.\d+.*ETH.*against the Precision pool/.test(lanes[1]) && /Bitcoin, last trade.*\$0\.\d+.*150 sats/.test(lanes[2]) && /Bitcoin, cheapest listing.*\$0\.\d+.*157 sats/.test(lanes[3]), `four prices, each in dollars with ETH or sats and its gap against Precision (${lanes.map((l) => l.slice(0, 60)).join(' | ')})`);
  ok(/On Ethereum TAC costs \d+% (more|less) than on the Bitcoin order book/.test(await text(p, '#gapnote')), `the gap between the two lanes is said in words (${(await text(p, '#gapnote')).slice(0, 110)})`);

  // the chart
  const c4 = await candles(p);
  ok(c4 >= 30 && c4 <= 90, `the Ethereum lane draws the 4-hour tape as candles (${c4})`);
  ok((await p.$$eval('#chart .tagtext', (t) => t.map((x) => x.textContent))).includes('Precision'), 'with the Precision pool\'s price at the edge');
  await p.click('[data-range="7"]'); await until(p, () => document.querySelectorAll('#chart .body').length > 20 && document.querySelectorAll('#chart .body').length < 50);
  ok((await candles(p)) <= 43 && (await candles(p)) >= 30, `7 days of 4-hour candles is at most 42 (${await candles(p)})`);
  await p.click('[data-range="0"]');
  await p.click('[data-log="1"]'); await until(p, () => document.querySelector('[data-log="1"]').getAttribute('aria-pressed') === 'true');
  const logAxis = await p.$$eval('#chart .axis:not(.mid)', (t) => t.map((x) => x.textContent));
  ok(logAxis.length >= 3 && logAxis.every((x) => /^\$0\.\d+$/.test(x)) && logAxis.some((x) => /^\$0\.[1-9]00?$|^\$0\.[1-9]$|^\$0\.\d{1,2}0?$/.test(x)), `the log axis names round dollar prices (${logAxis.join(' ')})`);
  await p.click('[data-log="1"]');
  await p.click('[data-tf="86400"]'); await until(p, () => document.querySelectorAll('#chart .body').length > 5 && document.querySelectorAll('#chart .body').length < 30);
  const c1d = await candles(p);
  ok(c1d < c4 && c1d >= 15, `a day's candles are fewer than 4 hours' (${c1d} against ${c4})`);
  await p.click('[data-tf="3600"]'); await until(p, () => document.querySelectorAll('#chart .body').length > 0);
  ok((await candles(p)) > 0 && (await candles(p)) <= 21, `an hour's candles come from the 5-minute tape, about a day back (${await candles(p)})`);
  await p.click('[data-unit="native"]'); await until(p, () => /ETH/.test(document.querySelector('#chart .axis')?.textContent || ''));
  ok(/ETH/.test(await p.$eval('#chart .axis', (e) => e.textContent)), 'the price can be shown in ETH instead of dollars');
  await p.click('[data-unit="usd"]');
  await p.click('[data-lane="btc"]'); await until(p, () => document.querySelectorAll('#chart .body').length > 20);
  const cb = await candles(p);
  ok(cb > 20, `the Bitcoin lane draws the order book's trades as candles (${cb})`);
  ok(/Every trade on the Bitcoin order book since 2026-05-24/.test(await text(p, '#chart-note')), 'and says where they come from');
  await p.click('[data-lane="cmp"]'); await until(p, () => document.querySelectorAll('#chart polyline').length === 2);
  ok((await lines(p)) === 2 && !(await p.$('#chart .body')), 'Compare draws the two lanes as lines in dollars');
  ok(/Both lanes in dollars at today's ETH and BTC prices/.test(await text(p, '#chart-note')), 'and says they are at today\'s rates');
  ok(/Precision pool \(Ethereum\).*Bitcoin order book.*Tacit pool, public or private/.test((await text(p, '#legend')).replace(/\s+/g, ' ')), 'the legend names the lanes and the Tacit pool\'s place against Precision');
  await p.hover('#chart svg', { position: { x: 400, y: 150 } });
  await until(p, () => !document.querySelector('.chart-tip')?.hidden, null, 5000).catch(() => {});
  ok(/UTC/.test(await text(p, '.chart-tip')), 'hovering the chart shows the time and prices');
  await p.click('[data-lane="eth"]');
  ok(await p.evaluate(() => { const e = document.querySelector('[data-lane="eth"]'), c = getComputedStyle(e); return e.matches(':hover') && c.color !== c.backgroundColor; }), 'the chosen lane stays readable with the pointer on it');
  if (SHOTS) await p.screenshot({ path: join(SHOTS, 'trade-desktop-top.png') });

  // the ticket: a purchase large enough to split
  await p.fill('#amt', '2');
  await until(p, () => /Split:/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph'), null, 240000);
  const route = (await text(p, '#route')).replace(/\s+/g, ' ');
  ok(/Split: \d+% Precision pool, \d+% Tacit pool/.test(route) && /more TAC than the better pool alone/.test(route), `2 ETH is quoted as a split (${route.slice(0, 160)})`);
  ok(/^[\d,]+(\.\d+)?$/.test((await text(p, '#out')).trim()) && Number((await text(p, '#out')).replace(/,/g, '')) > 2 * 3000, `with the TAC it pays (${await text(p, '#out')}: at least 3,000 TAC to the ETH even after the price impact of 2 ETH)`);
  const rows = await p.$$eval('#venues tbody tr', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length >= 5 && rows.length <= 7, `the quotes table holds the places that quote: the pools, the split, the private swap and the Bitcoin book (${rows.length} rows)`);
  ok(rows.some((x) => /^Precision pool.*fee 0\.30%/.test(x)) && rows.some((x) => /^Tacit pool.*public swap/.test(x)) && rows.some((x) => /^Both, split.*best/.test(x)), 'the pools and the split are there (the Precision fee as 0.30%), the split tagged best');
  ok(rows.some((x) => /^Tacit pool, private.*estimate.*shielded note/.test(x)), 'the private swap is an estimate, from the same reserves');
  await until(p, () => !/being checked/.test(document.querySelector('#absent')?.textContent || ''), null, 60000);
  const absent = (await text(p, '#absent')).replace(/\s+/g, ' ');
  ok(/^Not quoting: Uniswap v4's 3 ETH\/TAC pools hold no liquidity/.test(absent), `what holds no TAC is one line, with Uniswap v4's three empty pools in it (${absent.slice(0, 120)})`);
  // zQuoter's scan is heavy for a forked node, which may not answer inside the page's budget: either answer is said.
  ok(/no Uniswap v2\/v3, Sushi or Curve pool lists TAC|Uniswap v2\/v3, Sushi and Curve did not answer in time/.test(absent) && /zSwap has no TAC orders/.test(absent), 'and so are zQuoter\'s search and the empty zSwap boards');
  ok(rows.some((x) => /^Bitcoin order book.*pay [\d,]+ sats/.test(x)), 'the Bitcoin order book (paid in sats) is a row too');
  ok(/Connect wallet/.test(await text(p, '#go')) && !(await p.$eval('#go', (b) => b.disabled)), 'with a quote and no wallet the button asks to connect one');

  // a small purchase is not split, and says why a split would not pay
  await p.fill('#amt', '0.02');
  await until(p, () => !/Split:/.test(document.querySelector('#route')?.textContent || '') && /Precision pool|Tacit public pool/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph'), null, 120000);
  ok(/^Route.*Precision pool/.test((await text(p, '#route')).replace(/\s+/g, ' ')), `0.02 ETH runs on one pool (${(await text(p, '#route')).replace(/\s+/g, ' ').slice(0, 100)})`);

  // amounts: a lone comma is a decimal point, as on the front page; 1,500 is ambiguous and not read
  ok(/this ticket/.test((await text(p, '#venues')).replace(/\s+/g, ' ')), 'the venues table says which row the ticket runs');
  await p.fill('#amt', '0,05'); await until(p, () => !document.querySelector('#out').classList.contains('ph'), null, 120000);
  const withComma = (await text(p, '#out')).trim();
  await p.fill('#amt', '0.05'); await until(p, (x) => !document.querySelector('#out').classList.contains('ph') && document.querySelector('#out').textContent.trim() !== '…', null, 120000);
  ok(withComma === (await text(p, '#out')).trim() && Number(withComma.replace(/,/g, '')) < 2000, `0,05 ETH reads as 0.05 (both quote ${withComma} TAC), not 5`);
  await p.fill('#amt', '1,500'); await until(p, () => /cannot be read/.test(document.querySelector('#status')?.textContent || ''), null, 10000);
  ok(await p.$eval('#out', (e) => e.classList.contains('ph')), 'an ambiguous 1,500 is said to be unreadable, with no quote');
  await p.fill('#amt', '1,500.25'); await until(p, () => !document.querySelector('#out').classList.contains('ph'), null, 120000);
  ok(true, 'and 1,500.25 reads as one thousand five hundred and a quarter');
  await p.fill('#amt', '');

  // selling
  await p.click('[data-side="sell"]'); await p.fill('#amt', '12000');
  await until(p, () => /Split:/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph'), null, 240000);
  const sell = (await text(p, '#route')).replace(/\s+/g, ' ');
  ok(/Split:/.test(sell) && /more ETH than the better pool alone/.test(sell) && /TAC$/.test((await text(p, '#in-unit')).trim()), `selling 12,000 TAC is quoted as a split, paid in ETH (${sell.slice(0, 120)})`);
  ok(/a sale is a listing at your price/.test((await text(p, '#venues')).replace(/\s+/g, ' ')), 'the Bitcoin row says a sale there is a listing');

  // the order book and the facts
  const dep = await p.$$eval('#depth .dep', (d) => d.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(dep.length === 10 && /sats.*\$0\.\d+.*TAC · [\d,]+ sats/.test(dep[0]), `the ten cheapest listings, with their prices (${dep[0]})`);
  ok(/168 listings hold [\d,]+ TAC for [\d,]+ sats in all/.test(await text(p, '#depth-note')) && !!(await p.$('#depth-note a[href="/tac/#buy"]')), 'with how deep the book is and where to buy');
  const facts = (await text(p, '#facts')).replace(/\s+/g, ' '), more = (await text(p, '#facts-more')).replace(/\s+/g, ' ');
  ok(/21,000,000/.test(await text(p, '#about')) && /ERC-20.*0xA1313e.*TAC minted there/.test(facts) && /2,032 holders/.test(facts) && /Precision pool.*holds [\d.,]+ ETH and [\d,]+ TAC/.test(more), `the facts are live (${facts.slice(0, 120)})`);
  ok(/Uniswap v4.*3 hookless ETH\/TAC pools.*None holds liquidity now/.test(more) && /TacBuyback/.test(more) && !(await p.$eval('details.more:has(#facts-more)', (d) => d.open)), 'Uniswap v4\'s pools and the buyback are named, behind a "more" that starts closed');

  ok(r.errors.length === 0, `no page errors (${r.errors.slice(0, 3).join(' | ')})`);
  ok(r.blocked.length === 0, `nothing blocked by the page's CSP (${r.blocked.slice(0, 2).join(' | ')})`);
  if (SHOTS) await (await p.$('.grid')).screenshot({ path: join(SHOTS, 'trade-desktop-grid.png') }).catch(() => {});
  await r.browser.close();


  // ── trading from the page: a wallet in the browser, backed by the fork ──
  const E18 = 10n ** 18n;
  {
    const me = await fundedWallet(10n * E18, 30000n * E18);
    const w = await openPage({ width: 1280, height: 900 }, me);
    const q = w.page;
    await until(q, () => document.querySelectorAll('#chart .body').length > 5 && /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    ok(/Connect wallet/.test(await text(q, '#go')), 'with no wallet connected the button says Connect wallet');
    await q.click('#go');
    await until(q, () => /Balance [\d.,]+ ETH/.test(document.querySelector('#in-bal')?.textContent || ''), null, 60000);
    ok(w.walletLog.connects === 1 && /Balance 10 ETH/.test(await text(q, '#in-bal')) && /Enter an amount/.test(await text(q, '#go')), `connecting shows the balance and asks for an amount (${await text(q, '#in-bal')})`);
    await q.click('#in-bal'); await until(q, () => document.querySelector('#amt').value !== '', null, 10000);
    ok(Number(await q.inputValue('#amt')) > 9.9 && Number(await q.inputValue('#amt')) < 10, `Max leaves 0.004 ETH for the network fee (${await q.inputValue('#amt')})`);
    await q.fill('#amt', '99');
    await until(q, () => /Not enough ETH/.test(document.querySelector('#go')?.textContent || ''), null, 120000);
    ok(await q.$eval('#go', (b) => b.disabled), 'more ETH than the wallet holds says so and cannot be reviewed');

    // a purchase that splits
    await q.fill('#amt', '2');
    await until(q, () => /Split:/.test(document.querySelector('#route')?.textContent || '') && /Review buy/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    await q.click('#go');
    await q.waitForSelector('#review:not([hidden]) #rv-go');
    const rv = (await text(q, '#review')).replace(/\s+/g, ' ');
    ok(/Buy TAC/.test(rv) && /You pay2 ETH/.test(rv) && /At least[\d,.]+ TAC/.test(rv) && /Split: \d+% Precision pool, \d+% Tacit pool/.test(rv) && /Price impact/.test(rv) && /tested without sending first/.test(rv) && !!(await q.$('#slip-seg')), `the review says what runs and the least it takes (${rv.slice(0, 200)})`);
    const floorTxt = (rv.match(/At least([\d,.]+) TAC/) || [])[1];
    ok(await q.$eval('#go', (b) => b.hidden), 'and the main button gives way to its Back and Confirm');
    await q.click('#rv-back'); ok(await q.$eval('#review', (e) => e.hidden), 'Back closes the review without sending anything');
    await q.click('#go'); await q.waitForSelector('#rv-go');
    // the page refreshes its readings each minute: a review being read is left as it is
    await q.clock.fastForward(61000); await q.waitForTimeout(2500);
    ok(!(await q.$eval('#review', (e) => e.hidden)) && !!(await q.$('#rv-go')), 'a minute passing (the page\'s own refresh) leaves an open review as it was');
    ok(await q.$eval('#rv-go', (b) => b.disabled) && /I accept losing about \d+%/.test(await text(q, '#review')), 'a purchase that moves the price over 10% waits for the box to be ticked');
    await q.check('#ack');
    const t0 = await tacBal(me.account), e0 = await ethBal(me.account), n0 = BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest'])), mc0 = await tacBal(MC3), rt0 = await ethBal(ROUTER);
    await q.click('#rv-go');
    await until(q, () => /Bought\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
    const got = (await tacBal(me.account)) - t0, floor = Number(floorTxt.replace(/,/g, ''));
    ok(/Bought\. Received [\d,.]+ TAC/.test(await text(q, '#status')) && Number(got / 10n ** 16n) / 100 >= floor, `2 ETH bought through the split: ${Number(got / 10n ** 16n) / 100} TAC, at least the ${floorTxt} it showed (${(await text(q, '#status')).slice(0, 80)})`);
    ok(BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest'])) === n0 + 1n && w.walletLog.sends.length === 1 && w.walletLog.sends[0].to.toLowerCase() === ROUTER.toLowerCase(), 'in one transaction, sent to zRouter');
    ok(e0 - (await ethBal(me.account)) >= 2n * E18 && e0 - (await ethBal(me.account)) < 2n * E18 + E18 / 50n && (await tacBal(MC3)) === mc0 && (await ethBal(ROUTER)) === rt0, 'the ETH spent is the 2 ETH and its gas, and nothing is left in Multicall3 or the router');
    ok(/Balance [\d.,]+ ETH/.test(await text(q, '#in-bal')) && (await q.inputValue('#amt')) === '', 'the balance and the form are refreshed');

    // a sale that splits: the permit is signed in the wallet, then one transaction
    await q.click('[data-side="sell"]');
    await q.fill('#amt', '12000');
    await until(q, () => /Split:/.test(document.querySelector('#route')?.textContent || '') && /Review sell/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    await q.click('#go'); await q.waitForSelector('#rv-go');
    ok(await q.$eval('#rv-go', (b) => b.disabled) && /I accept losing about \d+%/.test(await text(q, '#review')), 'a sale that moves the price over 10% waits for the box to be ticked');
    await q.check('#ack'); ok(!(await q.$eval('#rv-go', (b) => b.disabled)), 'ticking it lets the sale be confirmed');
    const e1 = await ethBal(me.account), t1 = await tacBal(me.account), n1 = BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest']));
    await q.click('#rv-go');
    await until(q, () => /Sold\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
    ok(/Sold\. Received about [\d.,]+ ETH/.test(await text(q, '#status')) && t1 - (await tacBal(me.account)) === 12000n * E18 && (await ethBal(me.account)) > e1 + 5n * 10n ** 17n, `12,000 TAC sold through the split for ETH (${(await text(q, '#status')).slice(0, 70)})`);
    ok(w.walletLog.sends.every((t) => t.from.toLowerCase() === me.account.toLowerCase()), 'every transaction was sent from the account that was reviewed');
    ok(w.walletLog.signs === 1 && BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest'])) === n1 + 1n, 'with the permit signed once in the wallet and one transaction sent: no approval, no allowance');
    ok((await tacBal(MC3)) === mc0, 'and Multicall3 holds no TAC');
    ok(w.errors.length === 0 && w.blocked.length === 0, `no page errors or blocked requests while trading (${[...w.errors, ...w.blocked].slice(0, 2).join(' | ')})`);
    await w.browser.close();

    // a wallet that says no
    const refuser = await fundedWallet(5n * E18, 0n), rf = await openPage({ width: 1280, height: 900 }, { ...refuser, refuseSends: true });
    await until(rf.page, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    await rf.page.click('#go'); await until(rf.page, () => /Balance/.test(document.querySelector('#in-bal')?.textContent || ''), null, 60000);
    await rf.page.fill('#amt', '0.1'); await until(rf.page, () => /Review buy/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    await rf.page.click('#go'); await rf.page.waitForSelector('#rv-go'); await rf.page.click('#rv-go');
    await until(rf.page, () => /Cancelled in your wallet/.test(document.querySelector('#status')?.textContent || ''), null, 120000);
    ok(/Nothing was sent/.test(await text(rf.page, '#status')) && (await tacBal(refuser.account)) === 0n && (await ethBal(refuser.account)) === 5n * E18, 'a wallet that refuses the transaction ends with Cancelled, nothing sent, nothing spent');
    await rf.browser.close();

    // the card's link: the side and the amount both arrive
    const dl = await openPage({ width: 1280, height: 900 }, null, '#side=sell&amount=1500');
    await until(dl.page, () => document.querySelector('#amt')?.value === '1500' && document.querySelector('[data-side="sell"]').getAttribute('aria-pressed') === 'true' && !document.querySelector('#out').classList.contains('ph'), null, 240000);
    ok(/TAC$/.test((await text(dl.page, '#in-unit')).trim()), 'a link to #side=sell&amount=1500 opens the sale with the 1,500 TAC quoted');
    await dl.browser.close();

    // an account that changes while a trade is being made: nothing is sent for the other
    const swapper = await fundedWallet(5n * E18, 0n), sw = await openPage({ width: 1280, height: 900 }, swapper);
    await until(sw.page, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    await sw.page.click('#go'); await until(sw.page, () => /Balance/.test(document.querySelector('#in-bal')?.textContent || ''), null, 60000);
    await sw.page.fill('#amt', '0.1'); await until(sw.page, () => /Review buy/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    await sw.page.click('#go'); await sw.page.waitForSelector('#rv-go');
    if (await sw.page.$('#ack')) await sw.page.check('#ack');
    sw.walletLog.onChainId = () => sw.page.evaluate(() => window.__h.accountsChanged(['0x000000000000000000000000000000000000dEaD']));
    await sw.page.click('#rv-go');
    await until(sw.page, () => /account changed/.test(document.querySelector('#status')?.textContent || ''), null, 120000);
    ok(sw.walletLog.sends.length === 0 && (await tacBal(swapper.account)) === 0n && (await ethBal(swapper.account)) === 5n * E18, 'a wallet whose account changes after the review is sent nothing: the trade stops, and nothing is spent');
    await sw.browser.close();
  }


  // the addresses: TAC's own, and the bare ones people type
  {
    const own = await openPage({ width: 1280, height: 900 }, null, '', '/trade/tac/');
    await until(own.page, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || '') && document.querySelectorAll('#chart .body').length > 5, null, 240000);
    ok(own.page.url().endsWith('/trade/tac/') && (await own.page.title()) === 'tacit trade' && (await own.page.getAttribute('link[rel="canonical"]', 'href')) === 'https://tacit.finance/trade/tac/', '/trade/tac/ is the trade page at its own address, naming itself as its canonical one');
    ok((await own.page.getAttribute('meta[property="og:url"]', 'content')) === 'https://tacit.finance/trade/tac/' && own.errors.length === 0 && own.blocked.length === 0, 'and its shared link says so too, with nothing blocked');
    await own.browser.close();
    const bare = await openPage({ width: 1280, height: 900 }, null, '#side=sell&amount=1500', '/trade/tac');
    await until(bare.page, () => /\/trade\/tac\/#side=sell/.test(location.href) && document.querySelector('#amt')?.value === '1500' && !document.querySelector('#out')?.classList.contains('ph'), null, 240000);
    ok(/\/trade\/tac\/#side=sell&amount=1500$/.test(bare.page.url()) && (await bare.page.title()) === 'tacit trade', '/trade/tac, without the slash, arrives at /trade/tac/ with the link\'s fragment kept: the sale of 1,500 TAC is quoted');
    await bare.browser.close();
    const root = await openPage({ width: 1280, height: 900 }, null, '', '/trade');
    await until(root.page, () => /\/trade\/$/.test(location.pathname) && /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    ok((await root.page.title()) === 'tacit trade', '/trade arrives at /trade/');
    await root.browser.close();
  }

  // dark
  if (SHOTS) {
    const d = await chromium.launch(), dctx = await d.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }), dp = await dctx.newPage();
    for (const h of RPC_HOSTS) await dctx.route(`https://${h}/**`, async (route) => { const x = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() }); await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await x.text() }); });
    await dctx.route(/^https:\/\/api\.tacit\.finance\/assets\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(/preauth-sales/.test(route.request().url()) ? sales : asset) }));
    await dp.goto(`http://127.0.0.1:${WEB}/trade/`);
    await until(dp, () => document.querySelectorAll('#chart .body').length > 5 && document.querySelectorAll('#depth .dep').length > 3, null, 240000);
    await dp.click('[data-lane="cmp"]'); await dp.fill('#amt', '0.5');
    await until(dp, () => !document.querySelector('#out').classList.contains('ph'), null, 120000);
    await dp.screenshot({ path: join(SHOTS, 'trade-dark.png') });
    await d.close();
  }

  // a phone
  r = await openPage({ width: 390, height: 844 });
  const m = r.page;
  await until(m, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || '') && document.querySelectorAll('#chart .body').length > 5, null, 240000);
  ok(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scroll at 390px (${await m.evaluate(() => document.documentElement.scrollWidth)})`);
  const order = await m.evaluate(() => ['.p-chart', '.p-ticket', '.p-venues', '.p-depth', '.p-info'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top)));
  ok(order.every((t, i) => i === 0 || t > order[i - 1]), `the panels stack chart, ticket, venues, book, facts (${order})`);
  ok((await m.$eval('#chart', (e) => e.getBoundingClientRect().width)) > 300, 'the chart takes the phone\'s width');
  if (SHOTS) await m.screenshot({ path: join(SHOTS, 'trade-phone.png'), fullPage: true });
  ok(r.errors.length === 0 && r.blocked.length === 0, `and no errors or blocked requests there (${[...r.errors, ...r.blocked].slice(0, 2).join(' | ')})`);
  await r.browser.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' / '));
  if (r) console.log('     errors:', r.errors.slice(0, 4), 'blocked:', r.blocked.slice(0, 3));
  await r?.browser.close().catch(() => {});
} finally { done(); }
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} trade-page checks passed`);
process.exit(fails ? 1 : 0);
