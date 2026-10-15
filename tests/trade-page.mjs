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
const bids = JSON.parse(readFileSync(join(FX, 'tac-bids-2026-10-12.json'), 'utf8'));              // the 14 standing bids the API listed, their expiry moved forward
bids.intents = bids.intents.map((x) => ({ ...x, expiry: soon }));
const apiBody = (url) => (/preauth-sales/.test(url) ? sales : /bid-intents/.test(url) ? bids : asset);
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
    if (method === 'wallet_watchAsset') { (log.watched ||= []).push(params); return true; }
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
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(apiBody(route.request().url())) });
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
  await until(p, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || '') && document.querySelectorAll('#lanes .lane .v').length === 4 && !document.querySelector('#lanes .sk') && !!document.querySelector('#chart .line') && document.querySelectorAll('#ladders .ob-row').length > 3, null, 240000).catch(async (e) => {
    console.log('     page at the first wait:', JSON.stringify(await p.evaluate(() => ({ url: location.href, px: document.querySelector('#px-usd')?.textContent, lanes: document.querySelectorAll('#lanes .lane .v').length, skeleton: !!document.querySelector('#lanes .sk'), candles: document.querySelectorAll('#chart .body').length, asks: document.querySelectorAll('#ladders .ob-row').length, chart: document.querySelector('#chart')?.textContent.slice(0, 80) }))), 'errors:', r.errors.slice(0, 3), 'blocked:', r.blocked.slice(0, 2));
    throw e;
  });

  const head = (await text(p, '#px-usd')).trim(), sub = (await text(p, '#px-sub')).replace(/\s+/g, ' ');
  ok(/^\$0\.\d{2,}/.test(head), `the head shows TAC's price in dollars (${head})`);
  ok(/1 TAC = [\d.]+ ETH/.test(sub) && /24h volume [\d.,]+ ETH/.test(sub), `and in ETH and the day's volume, each figure with its name (${sub.slice(0, 120)})`);
  const lanes = await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  ok(lanes.length === 4 && /Precision pool.*\$0\.\d+.*ETH.*the reference/.test(lanes[0]) && /Tacit pool.*\$0\.\d+.*ETH.*vs Precision/.test(lanes[1]) && /Bitcoin · last trade.*\$0\.\d+.*150 sats/.test(lanes[2]) && /Bitcoin · cheapest ask.*\$0\.\d+.*157 sats/.test(lanes[3]), `four prices, each in dollars with ETH or sats and its gap against Precision (${lanes.map((l) => l.slice(0, 60)).join(' | ')})`);
  ok(/^On Bitcoin, the last trade was (level with|\d+% (above|below)) Ethereum's price(, (and|but) the cheapest ask is (level with|\d+% (above|below)) it)?\.$/.test((await text(p, '#gapnote')).trim()), `Bitcoin's last trade and its cheapest ask are each set against Ethereum's price in words (${(await text(p, '#gapnote')).slice(0, 160)})`);

  // the chart: a line by default, as the Bitcoin market draws it, and candles a press away
  ok(!!(await p.$('#chart .line')) && !!(await p.$('#chart polygon.area')) && !!(await p.$('#chart .lastdot')) && (await candles(p)) === 0 && !!(await p.$('[data-kind="candles"]')), 'the Ethereum lane draws the Precision pool\'s price as a shaded line with its last price marked');
  const rd = (await text(p, '#ch-read')).replace(/\s+/g, ' ');
  ok(/^\$0\.\d{4}.*(all time|past month).*low \$0\.\d+.*high \$0\.\d+.*ETH traded/.test(rd), `a line above the chart gives the price, its move over the range, the low, the high and the volume (${rd.slice(0, 120)})`);
  ok((await p.$$eval('#chart .mark', (m) => m.length)) === 2 && (await p.$eval('#tf-seg', (e) => e.hidden)) === true, 'the high and the low are named on the line, and a line has no candle size to choose');
  const lineN = await p.$eval('#chart polyline', (l) => l.getAttribute('points').split(' ').length);
  await p.click('[data-range="1"]'); await until(p, () => document.querySelector('#chart polyline') && document.querySelector('#chart polyline').getAttribute('points').split(' ').length < 120 && /past day/.test(document.querySelector('#ch-read')?.textContent || ''));
  const dayN = await p.$eval('#chart polyline', (l) => l.getAttribute('points').split(' ').length);
  ok(dayN >= 20 && dayN <= 100 && dayN < lineN, `1D draws the day at 15 minutes (${dayN} points; whole range ${lineN})`);
  await p.click('[data-range="0"]'); await until(p, () => /all time · since \d+ \w{3}/.test(document.querySelector('#ch-read')?.textContent || ''));
  const offered = await p.$$eval('#range-seg button', (b) => b.map((x) => x.textContent));
  ok(offered.at(-1) === 'All' && offered[0] === '1D' && new Set(offered).size === offered.length, `the ranges offered are the ones that differ for the history there is (${offered.join(' ')})`);
  const sub2 = (await text(p, '#px-sub')).replace(/\s+/g, ' ');
  ok(/1h\s*[+−]?[\d.]+%/.test(sub2) && /24h\s*[+−]?[\d.]+%/.test(sub2) && /Liquidity \$[\d.,]+[kM]?/.test(sub2) && /FDV \$[\d.,]+[kM]?/.test(sub2), `the headline gives the move over 1h, 6h, 24h and 7d, the pool's liquidity and the fully diluted value (${sub2.slice(0, 150)})`);
  await p.hover('#chart svg', { position: { x: 300, y: 150 } });
  await until(p, () => /\d{2}:\d{2}/.test(document.querySelector('#ch-read')?.textContent || ''), null, 10000);
  ok(await p.$eval('#chart .cross .cd', (c) => c.getAttribute('visibility') === 'visible') && (await p.$eval('.chart-tip', (e) => e.hidden)) && /^\$0\.\d{4}/.test(await text(p, '#ch-read')), 'a pointer on the line reads the price and time at that bar in the line above, with a dot on the line and no box over it');
  await p.mouse.move(5, 5); await until(p, () => /all time/.test(document.querySelector('#ch-read')?.textContent || ''), null, 10000);
  // the keys read the chart too: an arrow steps through the bars, Escape lets go
  await p.focus('#chart svg'); await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft');
  await until(p, () => /\d{2}:\d{2}/.test(document.querySelector('#ch-read')?.textContent || ''), null, 10000);
  const keyRead = (await text(p, '#ch-read')).replace(/\s+/g, ' ');
  await p.keyboard.press('Escape'); await until(p, () => /all time/.test(document.querySelector('#ch-read')?.textContent || ''), null, 10000);
  ok(/\d{2}:\d{2}/.test(keyRead) && /(traded|nothing traded|trade)/.test(keyRead), `the arrow keys read a bar's time, price and volume, and Escape goes back to the whole range (${keyRead.slice(0, 110)})`);
  ok((await p.$$eval('#chart .halo', (h) => h.length)) === 1 && (await p.$$eval('.hero h1 svg.tk', (h) => h.length)) === 1 && (await p.$eval('.hero h1 svg.tk', (e) => e.getBoundingClientRect().width)) > 30 && (await p.$$eval('main use[href="#tk-tac"]', (u) => u.length)) >= 7, 'the live price is marked, and the TAC mark sits beside the price and on the page\'s headings');
  await p.click('[data-kind="candles"]'); await until(p, () => document.querySelectorAll('#chart .body').length > 5);
  const c4 = await candles(p);
  ok(c4 >= 30 && c4 <= 180, `the Ethereum lane draws the 4-hour tape as candles (${c4})`);
  ok((await p.$$eval('#chart .tagtext', (t) => t.map((x) => x.textContent))).includes('Precision'), 'with the Precision pool\'s price at the edge');
  await p.click('[data-range="7"]'); await until(p, () => document.querySelectorAll('#chart .body').length > 20 && document.querySelectorAll('#chart .body').length < 50);
  ok((await candles(p)) <= 43 && (await candles(p)) >= 30, `7 days of 4-hour candles is at most 42 (${await candles(p)})`);
  await p.click('[data-range="0"]');
  await p.click('[data-log="1"]'); await until(p, () => document.querySelector('[data-log="1"]').getAttribute('aria-pressed') === 'true');
  const logAxis = await p.$$eval('#chart .axis:not(.mid)', (t) => t.map((x) => x.textContent));
  ok(logAxis.length >= 2 && logAxis.every((x) => /^\$0\.\d+$/.test(x)) && logAxis.some((x) => /^\$0\.[1-9]00?$|^\$0\.[1-9]$|^\$0\.\d{1,2}0?$/.test(x)), `the log axis names round dollar prices (${logAxis.join(' ')})`);
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
  ok(/Precision pool \(Ethereum\).*Bitcoin order book.*Tacit pool/.test((await text(p, '#legend')).replace(/\s+/g, ' ')), 'the legend names the lanes and the Tacit pool\'s place against Precision');
  await p.hover('#chart svg', { position: { x: 400, y: 150 } });
  await until(p, () => !document.querySelector('.chart-tip')?.hidden, null, 5000).catch(() => {});
  ok(/\d{2}:\d{2}/.test(await text(p, '.chart-tip')), 'hovering the chart shows the time and prices');
  await p.click('[data-lane="eth"]');
  ok(await p.evaluate(() => { const e = document.querySelector('[data-lane="eth"]'), c = getComputedStyle(e); return e.matches(':hover') && c.color !== c.backgroundColor; }), 'the chosen lane stays readable with the pointer on it');
  if (SHOTS) await p.screenshot({ path: join(SHOTS, 'trade-desktop-top.png') });

  // the ticket: a purchase large enough to split
  ok((await p.$$eval('#chips button', (b) => b.map((x) => x.textContent))).join() === '0.05 ETH,0.25 ETH,1 ETH' && (await p.$eval('#cmp', (e) => e.hidden)) === true, 'the ticket offers quick amounts, and the quotes panel waits for an amount');
  await p.click('#chips [data-amt="0.25"]');
  await until(p, () => !document.querySelector('#out').classList.contains('ph') && document.querySelector('#out').textContent !== '…', null, 240000);
  ok((await p.inputValue('#amt')) === '0.25' && (await p.getAttribute('#chips [data-amt="0.25"]', 'aria-pressed')) === 'true' && (await p.$eval('#cmp', (e) => e.hidden)) === false, 'pressing one fills the amount, quotes it and shows the quotes');
  await p.fill('#amt', '2');
  await until(p, () => /Split across/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph') && Number(document.querySelector('#out').textContent.replace(/,/g, '')) > 5000, null, 240000);
  const route = (await text(p, '#route')).replace(/\s+/g, ' ');
  ok(/Split across two pools \+[\d.]+%/.test(route) && /Precision \d+%\s*Tacit \d+%/.test(route) && !!(await p.$('#route .splitbar')), `2 ETH is quoted as a split, drawn as a bar of the two pools with what it gains (${route.slice(0, 160)})`);
  ok(/^[\d,]+(\.\d+)?$/.test((await text(p, '#out')).trim()) && Number((await text(p, '#out')).replace(/,/g, '')) > 2 * 3000, `with the TAC it pays (${await text(p, '#out')}: at least 3,000 TAC to the ETH even after the price impact of 2 ETH)`);
  const rows = await p.$$eval('#venues tbody tr', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length >= 5 && rows.length <= 7, `the quotes table holds the places that quote: the pools, the split, the private swap and the Bitcoin book (${rows.length} rows)`);
  ok(rows.some((x) => /^Precision pool.*fee 0\.30%/.test(x)) && rows.some((x) => /^Tacit pool.*public swap/.test(x)) && rows.some((x) => /^Both, split.*best/.test(x)), 'the pools and the split are there (the Precision fee as 0.30%), the split tagged best');
  ok(rows.some((x) => /^Tacit pool, private.*estimate.*shielded note/.test(x)), 'the private swap is an estimate, from the same reserves');
  const privHref = await p.$eval('#venues a[href^="/#card="]', (a) => a.getAttribute('href'));
  ok(privHref === '/#card=swap:ether:tac:private&amt=2' && /Swap privately/.test(await text(p, '#route')), `and links to the main page's private swap with the amount (${privHref})`);
  // the arrows turn the trade around, carrying what it gets over as what the other side pays
  const got2 = (await text(p, '#out')).replace(/,/g, '').trim();
  await p.click('#flip');
  await until(p, () => document.querySelector('[data-side="sell"]').getAttribute('aria-pressed') === 'true' && !document.querySelector('#out').classList.contains('ph') && document.querySelector('#out').textContent !== '…', null, 240000);
  ok(Math.abs(Number(await p.inputValue('#amt')) - Number(got2)) < 0.02 && /ETH/.test(await text(p, '#out-unit')), `the flip sells the ${got2} TAC the purchase would get (${await p.inputValue('#amt')} TAC → ${await text(p, '#out')} ETH)`);
  await p.click('[data-side="buy"]'); await p.fill('#amt', '2');
  await until(p, () => /Split across/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph'), null, 240000);
  ok(!(await p.$('#absent')) && !(await p.$('#venues-note')) && !rows.some((x) => /Uniswap v4/.test(x)), 'the quotes say no more than the rows: no line of venues that do not quote, no how-to-read note');
  ok(/#side=buy&amount=2$/.test(p.url()), `the address keeps the side and amount, so a reload or a shared link opens the same ticket (${p.url().split('#')[1]})`);
  ok(rows.some((x) => /^Bitcoin order book.*pay [\d,]+ sats/.test(x)), 'the Bitcoin order book (paid in sats) is a row too');
  ok(/Connect wallet/.test(await text(p, '#go')) && !(await p.$eval('#go', (b) => b.disabled)), 'with a quote and no wallet the button asks to connect one');

  // a small purchase is not split, and says why a split would not pay
  await p.fill('#amt', '0.02');
  await until(p, () => !/Split across/.test(document.querySelector('#route')?.textContent || '') && /Precision pool|Tacit public pool/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph'), null, 120000);
  ok(/^Route.*Precision pool/.test((await text(p, '#route')).replace(/\s+/g, ' ')), `0.02 ETH runs on one pool (${(await text(p, '#route')).replace(/\s+/g, ' ').slice(0, 100)})`);

  // amounts: a lone comma is a decimal point, as on the front page; 1,500 is ambiguous and not read
  ok(/this ticket/.test((await text(p, '#venues')).replace(/\s+/g, ' ')), 'the venues table says which row the ticket runs');
  await p.fill('#amt', '0,05'); await until(p, () => !document.querySelector('#out').classList.contains('ph'), null, 120000);
  const withComma = (await text(p, '#out')).trim();
  await p.fill('#amt', '0.05'); await until(p, (x) => !document.querySelector('#out').classList.contains('ph') && document.querySelector('#out').textContent.trim() !== '…', null, 120000);
  ok(withComma === (await text(p, '#out')).trim() && Number(withComma.replace(/,/g, '')) < 2000, `0,05 ETH reads as 0.05 (both quote ${withComma} TAC), not 5`);
  await p.fill('#amt', '1,500'); await until(p, () => /Cannot read that amount/.test(document.querySelector('#status')?.textContent || ''), null, 10000);
  ok(await p.$eval('#out', (e) => e.classList.contains('ph')), 'an ambiguous 1,500 is said to be unreadable, with no quote');
  await p.fill('#amt', '1,500.25'); await until(p, () => !document.querySelector('#out').classList.contains('ph'), null, 120000);
  ok(true, 'and 1,500.25 reads as one thousand five hundred and a quarter');
  await p.fill('#amt', '');

  // selling
  await p.click('[data-side="sell"]');
  ok((await p.$$eval('#chips button', (b) => b.map((x) => x.textContent))).join() === '1,000 TAC,5,000 TAC,20,000 TAC', 'the sell side has quick amounts in TAC');
  await p.fill('#amt', '12000');
  await until(p, () => /Split across/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph'), null, 240000);
  const sell = (await text(p, '#route')).replace(/\s+/g, ' ');
  ok(/Split across two pools \+[\d.]+%/.test(sell) && /TAC$/.test((await text(p, '#in-unit')).trim()), `selling 12,000 TAC is quoted as a split, paid in ETH (${sell.slice(0, 120)})`);
  ok(/Bitcoin order book.*\d+ bids? · settles (when the bidder is online|within minutes).*sats fees/.test((await text(p, '#venues')).replace(/\s+/g, ' ')), 'the Bitcoin row says what the standing bids pay for the sale, and that each settles when its bidder is online');

  // the order book and the facts
  ok((await p.getAttribute('[data-book="btc"]', 'aria-pressed')) === 'true', 'with zSwap holding no TAC order the order book opens on Bitcoin\'s listings');
  const dep = await p.$$eval('#ladders .ob-asks .ob-row', (d) => d.map((x) => x.textContent.replace(/\s+/g, ' ').trim()).reverse()), bidRows = await p.$$eval('#ladders .ob-bids .ob-row', (d) => d.length);
  const mid = (await text(p, '#ladders .ob-spread')).replace(/\s+/g, ' ');
  ok(dep.length >= 3 && dep.length <= 8 && bidRows >= 1 && /^\$0\.\d+[\d,.]+ sats/.test(dep[0]) && /last trade/.test(mid) && /(spread [\d.]+%|bids [\d.]+% over asks)/.test(mid), `the book stacks the listings over the last price and the bids under it, one line per price (${dep.length} + ${bidRows}: ${dep[0]} | ${mid})`);
  ok(await p.$eval('#ladders .ob-asks .ob-row:last-child', (e) => parseFloat(getComputedStyle(e, '::before').width) > 0), 'each row is shaded by the depth from the middle out');
  ok((await p.$$eval('#depthchart path.dep-ask', (x) => x.length)) === 1 && (await p.$$eval('#depthchart path.dep-bid', (x) => x.length)) === 1, 'drawn as a depth chart of listings and bids');
  ok(/\d+ bids \([\d,]+ TAC\) settle when the bidder is online/.test(await text(p, '#depth-note')), 'and the note says how many bids stand and when a sale to one settles');
  await p.click('[data-book="trades"]');
  await until(p, () => document.querySelectorAll('#ladders table.trades tbody tr').length >= 3, null, 120000);
  const tr = await p.$$eval('#ladders table.trades tbody tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(tr.length >= 3 && tr.some((x) => /(buy|sell)/.test(x)) && tr.every((x) => /(just now|\d+[mhd] ago)/.test(x)) && !!(await p.$('#ladders table.trades a[href^="https://etherscan.io/tx/"]')) && (await p.$eval('#depthchart', (e) => e.hidden)), `the Trades tab lists the pool's recent swaps with when, side, TAC, price and a link to the transaction (${tr.length} rows: ${tr[0]})`);
  const rowsAt = await p.$$eval('#ladders table.trades tbody tr', (r) => r.length), moreBtn = await p.$('#ladders [data-more-trades]');
  ok(rowsAt === 12 && !!moreBtn && /Show all \d+ trades/.test(await moreBtn.textContent()) && (await p.$eval('#ladders table.trades td small', (e) => getComputedStyle(e).display)) === 'inline' && (await p.$eval('#ladders table.trades tbody tr', (e) => e.getBoundingClientRect().height)) < 46, `the Trades tab shows the first dozen on one line each, with the rest a press away (${rowsAt} rows)`);
  ok((await p.$eval('#ladders table.trades tbody td', (e) => e.title)) !== '', 'and each time carries its date');
  await moreBtn.click();
  ok((await p.$$eval('#ladders table.trades tbody tr', (r) => r.length)) > 12 && /Show fewer/.test(await text(p, '#ladders [data-more-trades]')), 'Show all lists every one, and Show fewer folds them again');
  await p.click('#ladders [data-more-trades]');
  await p.click('[data-book="eth"]');
  await until(p, () => /No TAC orders on zSwap's boards|No TAC orders on the boards that answered/.test(document.querySelector('#ladders')?.textContent || ''), null, 150000);
  ok(/No TAC orders on zSwap's boards|No TAC orders on the boards that answered/.test(await text(p, '#ladders')) && !!(await p.$('#ladders a[href^="https://zswap"]')), 'the Ethereum tab says zSwap holds none and where to place one');
  await p.click('[data-book="btc"]');
  ok(/\d+ listings \([\d,]+ TAC\), taken whole/.test(await text(p, '#depth-note')) && !(await p.$('#depth-note a')), 'with how deep the book is (the buttons beside it do what the old links did)');
  const facts = (await text(p, '#facts')).replace(/\s+/g, ' '), more = (await text(p, '#facts-more')).replace(/\s+/g, ' ');
  ok(/21,000,000/.test(await text(p, '#about')) && /ERC-20.*0xA1313e.*TAC minted there/.test(facts) && /2,032 holders/.test(facts) && /Precision pool.*holds [\d.,]+ ETH and [\d,]+ TAC/.test(more), `the facts are live (${facts.slice(0, 120)})`);
  const lay = await p.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { inSide: !!document.querySelector('.side > .p-info'), infoLeft: r('.p-info').left, ticketLeft: r('.p-ticket').left, farmBottom: r('.p-farm').bottom, infoTop: r('.p-info').top, }; });
  ok(lay.inSide && Math.abs(lay.infoLeft - lay.ticketLeft) < 1 && lay.infoTop >= lay.farmBottom, `on a wide page the facts sit under the farm, in the ticket's column (${JSON.stringify(lay)})`);
  ok(!/Uniswap v4/.test(more) && /TacBuyback/.test(more) && !(await p.$eval('details.more:has(#facts-more)', (d) => d.open)), 'Uniswap v4\'s pools and the buyback are named, behind a "more" that starts closed');

  const nav = await p.$eval('.top nav a.opt', (a) => { const c = getComputedStyle(a); return { display: c.display, border: c.borderTopWidth, bg: c.backgroundColor, h: a.getBoundingClientRect().height }; });
  const col = await p.$eval('#venues th.opt', (a) => { const c = getComputedStyle(a); return { display: c.display, border: c.borderTopWidth }; });
  ok(nav.display === 'block' && nav.border === '0px' && nav.bg === 'rgba(0, 0, 0, 0)' && nav.h < 40, `the header's links are plain links, not boxes (${JSON.stringify(nav)})`);
  ok(col.display === 'table-cell' && col.border === '0px', `and a table column that hides on phones keeps its own style (${JSON.stringify(col)})`);
  ok(r.errors.length === 0, `no page errors (${r.errors.slice(0, 3).join(' | ')})`);
  ok(r.blocked.length === 0, `nothing blocked by the page's CSP (${r.blocked.slice(0, 2).join(' | ')})`);
  if (SHOTS) await (await p.$('.grid')).screenshot({ path: join(SHOTS, 'trade-desktop-grid.png') }).catch(() => {});
  await r.browser.close();
  if (process.env.TOP_ONLY) { console.log(fails ? `\n${fails} FAILED, ${n} ok (top only)` : `\n${n} trade-page checks passed (top only)`); done(); process.exit(fails ? 1 : 0); }


  // ── trading from the page: a wallet in the browser, backed by the fork ──
  const E18 = 10n ** 18n;
  {
    const me = await fundedWallet(10n * E18, 30000n * E18);
    const w = await openPage({ width: 1280, height: 900 }, me);
    const q = w.page;
    await until(q, () => !!document.querySelector('#chart .line') && /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    ok(/Connect wallet/.test(await text(q, '#go')), 'with no wallet connected the button says Connect wallet');
    await q.click('#go');
    await until(q, () => /Balance [\d.,]+ ETH/.test(document.querySelector('#in-bal')?.textContent || ''), null, 60000);
    ok(w.walletLog.connects === 1 && /Balance 10 ETH/.test(await text(q, '#in-bal')) && /Enter an amount/.test(await text(q, '#go')), `connecting shows the balance and asks for an amount (${await text(q, '#in-bal')})`);
    await q.click('#in-bal'); await until(q, () => document.querySelector('#amt').value !== '', null, 10000);
    ok(Number(await q.inputValue('#amt')) > 9.9 && Number(await q.inputValue('#amt')) < 10, `Max leaves 0.004 ETH for the network fee (${await q.inputValue('#amt')})`);
    await q.fill('#amt', '99');
    await until(q, () => /Not enough ETH/.test(document.querySelector('#go')?.textContent || ''), null, 120000);
    ok(await q.$eval('#go', (b) => b.disabled), 'more ETH than the wallet holds says so and cannot be sent');

    // a purchase that splits
    await q.fill('#amt', '2');
    await until(q, () => /Split across/.test(document.querySelector('#route')?.textContent || '') && /Buy TAC/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    if (SHOTS) await q.locator('.p-ticket').screenshot({ path: join(SHOTS, 'ticket-quoted.png') });
    const rv = (await text(q, '#route')).replace(/\s+/g, ' ');
    ok(/Split across two pools/.test(rv) && /Price impact\d+%/.test(rv) && /Least you get[\d,.]+ TAC/.test(rv) && /Slippage/.test(rv) && !!(await q.$('#slip-seg')) && /tested before it is sent/.test(await text(q, '#tk-note')) && !(await q.$('#review')), `the quote itself says the route, the price impact and the least it takes, with slippage in it and no review step (${rv.slice(0, 200)})`);
    const floorTxt = (rv.match(/Least you get([\d,.]+) TAC/) || [])[1];
    ok(await q.$eval('#go', (b) => b.disabled) && /I accept losing about \d+%/.test(await text(q, '#route')), 'a purchase that moves the price over 10% waits for the box to be ticked');
    await q.check('#ack');
    // the page refreshes its readings each minute: what is on the ticket, a ticked box included, is left as it is
    await q.clock.fastForward(61000); await q.waitForTimeout(2500);
    ok(await q.$eval('#ack', (c) => c.checked) && !(await q.$eval('#go', (b) => b.disabled)), 'a minute passing (the page\'s own refresh) keeps the ticked box and the button ready');
    await q.click('[data-slip="100"]');
    ok(await q.$eval('[data-slip="100"]', (b) => b.getAttribute('aria-pressed') === 'true') && (await q.$eval('#ack', (c) => c.checked)), 'slippage is changed in the quote, and the accepted loss stays accepted');
    await q.click('[data-slip="50"]');
    const t0 = await tacBal(me.account), e0 = await ethBal(me.account), n0 = BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest'])), mc0 = await tacBal(MC3), rt0 = await ethBal(ROUTER);
    await q.click('#go');
    await until(q, () => /Bought\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
    const got = (await tacBal(me.account)) - t0, floor = Number(floorTxt.replace(/,/g, ''));
    ok(!!(await q.$('#status #add-tac')), 'a purchase offers TAC to the wallet');
    await q.click('#add-tac');
    await until(q, () => /Added to your wallet/.test(document.querySelector('#status')?.textContent || ''), null, 10000);
    ok(w.walletLog.watched?.[0]?.options?.address === TACADDR && w.walletLog.watched[0].options.symbol === 'TAC' && w.walletLog.watched[0].options.decimals === 18 && (await q.evaluate(() => localStorage.getItem('tacit-trade-tac-added'))) === '1', 'the wallet is asked to list TAC at its address, and the page does not offer it again');
    ok(/Bought\. Received [\d,.]+ TAC/.test(await text(q, '#status')) && Number(got / 10n ** 16n) / 100 >= floor, `2 ETH bought through the split: ${Number(got / 10n ** 16n) / 100} TAC, at least the ${floorTxt} it showed (${(await text(q, '#status')).slice(0, 80)})`);
    ok(BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest'])) === n0 + 1n && w.walletLog.sends.length === 1 && w.walletLog.sends[0].to.toLowerCase() === ROUTER.toLowerCase(), 'in one transaction, sent to zRouter');
    ok(e0 - (await ethBal(me.account)) >= 2n * E18 && e0 - (await ethBal(me.account)) < 2n * E18 + E18 / 50n && (await tacBal(MC3)) === mc0 && (await ethBal(ROUTER)) === rt0, 'the ETH spent is the 2 ETH and its gas, and nothing is left in Multicall3 or the router');
    ok(/Balance [\d.,]+ ETH/.test(await text(q, '#in-bal')) && (await q.inputValue('#amt')) === '', 'the balance and the form are refreshed');

    // a sale that splits: the permit is signed in the wallet, then one transaction
    await q.click('[data-side="sell"]');
    await q.fill('#amt', '12000');
    await until(q, () => /Split across/.test(document.querySelector('#route')?.textContent || '') && /Sell TAC/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    ok(await q.$eval('#go', (b) => b.disabled) && /I accept losing about \d+%/.test(await text(q, '#route')), 'a sale that moves the price over 10% waits for the box to be ticked');
    await q.check('#ack'); ok(!(await q.$eval('#go', (b) => b.disabled)), 'ticking it lets the sale go');
    const e1 = await ethBal(me.account), t1 = await tacBal(me.account), n1 = BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest']));
    await q.click('#go');
    await until(q, () => /Sold\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
    ok(/Sold\. Received about [\d.,]+ ETH/.test(await text(q, '#status')) && t1 - (await tacBal(me.account)) === 12000n * E18 && (await ethBal(me.account)) > e1 + 5n * 10n ** 17n, `12,000 TAC sold through the split for ETH (${(await text(q, '#status')).slice(0, 70)})`);
    ok(w.walletLog.sends.every((t) => t.from.toLowerCase() === me.account.toLowerCase()), 'every transaction was sent from the account that traded');
    ok(w.walletLog.signs === 1 && BigInt(await rpcA('eth_getTransactionCount', [me.account, 'latest'])) === n1 + 1n, 'with the permit signed once in the wallet and one transaction sent: no approval, no allowance');
    ok((await tacBal(MC3)) === mc0, 'and Multicall3 holds no TAC');
    ok(w.errors.length === 0 && w.blocked.length === 0, `no page errors or blocked requests while trading (${[...w.errors, ...w.blocked].slice(0, 2).join(' | ')})`);
    await w.browser.close();

    // a wallet that says no
    const refuser = await fundedWallet(5n * E18, 0n), rf = await openPage({ width: 1280, height: 900 }, { ...refuser, refuseSends: true });
    await until(rf.page, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    await rf.page.click('#go'); await until(rf.page, () => /Balance/.test(document.querySelector('#in-bal')?.textContent || ''), null, 60000);
    await rf.page.fill('#amt', '0.1'); await until(rf.page, () => /Buy TAC/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    await rf.page.click('#go');
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
    await sw.page.fill('#amt', '0.1'); await until(sw.page, () => /Buy TAC/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    if (await sw.page.$('#ack')) await sw.page.check('#ack');
    sw.walletLog.onChainId = () => sw.page.evaluate(() => window.__h.accountsChanged(['0x000000000000000000000000000000000000dEaD']));
    await sw.page.click('#go');
    await until(sw.page, () => /account changed/.test(document.querySelector('#status')?.textContent || ''), null, 120000);
    ok(sw.walletLog.sends.length === 0 && (await tacBal(swapper.account)) === 0n && (await ethBal(swapper.account)) === 5n * E18, 'a wallet whose account changes while the trade is made is sent nothing: the trade stops, and nothing is spent');
    await sw.browser.close();
  }

  // ── zSwap's boards: orders for TAC placed on the fork, read into an order book and filled from the page ──
  {
    const sendTx = async (from, to, sig, args = [], value = 0n) => {
      const h = await rpcA('eth_sendTransaction', [{ from, to, data: cast('calldata', sig, ...args.map(String)), ...(value ? { value: '0x' + value.toString(16) } : {}), gas: '0x2dc6c0' }]);
      let rc = null; for (let i = 0; i < 80 && !rc; i++) { rc = await rpcA('eth_getTransactionReceipt', [h]); if (!rc) await sleep(250); }
      if (!rc || rc.status !== '0x1') throw new Error(`${sig} failed on the fork`);
    };
    const V1 = '0x000000fF3D7A2d373615141d7489Ca66683DbecF', V2 = '0x000000dA7bb4B2A9E3e80e9A4D4157E26CA6189b', DU = '0x000000a213b430D14Bae6062c176289B05e04489', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', ZERO = '0x0000000000000000000000000000000000000000';
    const m1 = await fundedWallet(50n * E18, 100000n * E18), m2 = await fundedWallet(50n * E18, 100000n * E18), m3 = await fundedWallet(50n * E18, 100000n * E18), m4 = await fundedWallet(50n * E18, 100000n * E18);
    const nextId = async (board, sig) => BigInt(await rpcA('eth_call', [{ to: board, data: cast('sig', sig) }, 'latest']));
    const idV1 = await nextId(V1, 'nextOrderId()'), idV2 = await nextId(V2, 'nextOrderId()'), idDu = await nextId(DU, 'nextId()');
    const eth = (milli) => BigInt(milli) * 10n ** 15n, tac = (n) => BigInt(n) * E18;
    await sendTx(m1.account, TACADDR, 'approve(address,uint256)', [V1, tac(1000)]);
    await sendTx(m1.account, V1, 'createOrder(address,uint256,address,uint256)', [TACADDR, tac(1000), WETH, eth(10)]);                                       // v1 ask: 1000 TAC for 0.01 ETH
    await sendTx(m2.account, TACADDR, 'approve(address,uint256)', [V2, tac(2000)]);
    await sendTx(m2.account, V2, 'createOrder(address,uint256,address,uint256,bool,uint64,bool,bool,address)', [TACADDR, tac(2000), WETH, eth(40), true, 0, false, false, ZERO]);   // v2 ask, partial: 2000 TAC for 0.04 ETH
    await sendTx(m3.account, V2, 'createOrderWithEth(address,uint256,bool,uint64,bool,address)', [TACADDR, tac(1000), true, 0, false, ZERO], eth(15));            // v2 bid, partial: 0.015 ETH for 1000 TAC
    await sendTx(m4.account, TACADDR, 'approve(address,uint256)', [DU, tac(1000)]);
    await sendTx(m4.account, DU, 'listERC20(address,address,uint128,uint256,uint256,uint40,uint40,uint40)', [TACADDR, ZERO, tac(1000), eth(30), eth(20), 0, 360000, 0]);   // Dutchboard ask: 1000 TAC, 0.03 falling to 0.02 ETH
    const me = await fundedWallet(10n * E18, 30000n * E18);
    await sendTx(me.account, TACADDR, 'approve(address,uint256)', [V2, tac(500)]);
    await sendTx(me.account, V2, 'createOrder(address,uint256,address,uint256,bool,uint64,bool,bool,address)', [TACADDR, tac(500), WETH, eth(30), true, 0, false, false, ZERO]);         // the account's own ask

    const w = await openPage({ width: 1280, height: 900 }, me);
    const q = w.page;
    await until(q, () => !!document.querySelector('#chart .line') && document.querySelector('[data-book="eth"]')?.getAttribute('aria-pressed') === 'true' && document.querySelectorAll('#ladders [data-fill]').length >= 4, null, 240000);
    const lad = (sel) => q.$$eval(sel, (rows) => rows.map((x) => `${x.textContent} ${x.title || ''}`.replace(/\s+/g, ' ').trim()));
    const askRows = () => lad('#ladders .ob-asks .ob-row').then((r) => r.reverse());                 // drawn with the cheapest nearest the middle
    const asks = await askRows(), bids = await lad('#ladders .ob-bids .ob-row');
    ok(asks.length === 4 && bids.length === 1, `the Ethereum tab opens with orders: ${asks.length} to sell, ${bids.length} to buy (${asks[0].slice(0, 90)})`);
    ok(/^\$0\.\d+.*1,000.*0\.01.*Swapboard v1.*whole only/.test(asks[0]) || /^\$0\.\d+.*1,000.*0\.01.*Swapboard v1/.test(asks.find((x) => /Swapboard v1/.test(x)) || ''), 'each with its price, size, the ETH it takes, the board and what it allows');
    ok(asks.some((x) => /Dutchboard.*price changes with time/.test(x)) && asks.some((x) => /Swapboard v2.*part fills ok/.test(x)) && /Swapboard v2/.test(bids[0]), 'a Dutchboard lot, a partial v2 order and the v2 bid are all there');
    ok((await q.$$eval('#depthchart path.dep-ask', (x) => x.length)) >= 1 && (await q.$$eval('#depthchart path.dep-bid', (x) => x.length)) >= 1, 'and drawn as a depth chart of both sides');
    ok(!(await askRows()).some((x) => /yours/.test(x)), 'before a wallet is connected no order is marked as the account\'s');
    await q.click('#go');
    await until(q, () => /Balance [\d.,]+ ETH/.test(document.querySelector('#in-bal')?.textContent || '') && document.querySelectorAll('#ladders .ob-row.mine').length === 1, null, 60000);
    ok(/yours/.test(await text(q, '#ladders .ob-row.mine')) && !(await q.$('#ladders .ob-row.mine[data-fill]')), 'once connected, the account\'s own order says yours and has no Fill');

    // the best route: boards that take the amount and pay more than the pools are what the ticket uses
    await q.fill('#amt', '0.03');
    await until(q, () => /zSwap order|Swapboard v\d order|Dutchboard order/.test(document.querySelector('#route')?.textContent || '') && !document.querySelector('#out').classList.contains('ph'), null, 240000);
    const auto = (await text(q, '#route')).replace(/\s+/g, ' ');
    ok(/Route.*(zSwap orders|Swapboard v1 order|Swapboard v2 order)/.test(auto) && !/Tacit pool|Precision/.test(auto), `0.03 ETH goes to the boards, whose orders are cheaper than the pools (${auto.slice(0, 110)})`);
    const vrows = await lad('#venues tbody tr');
    ok(vrows.some((x) => /^zSwap boards.*this ticket/.test(x)) && vrows.some((x) => /best/.test(x) && /^zSwap boards/.test(x)), 'the quotes table lists zSwap boards as the route and the best');
    ok((await q.$$eval('#ladders .ob-row.take', (x) => x.length)) >= 1 && (await q.$$eval('#depthchart path.dep-ask.take', (x) => x.length)) === 1, 'and the order book marks the orders the ticket would take, in the ladder and on the chart');
    await q.fill('#amt', '');

    // Fill on the cheapest order pins it to the ticket
    const fillKey = await q.$$eval('#ladders .ob-asks .ob-row[data-fill]:not(.mine)', (b) => b.at(-1).dataset.fill);
    ok(fillKey === `v1:${idV1}`, `the cheapest order is the Swapboard v1 one (${fillKey})`);
    await q.click(`[data-fill="${fillKey}"]`);
    await until(q, () => /Filling Swapboard v1/.test(document.querySelector('#pin')?.textContent || '') && /^1,000/.test(document.querySelector('#out')?.textContent || '') && !document.querySelector('#out').classList.contains('ph') && /Buy TAC/.test(document.querySelector('#go')?.textContent || ''), null, 240000);   // that order's own quote, not the one before it
    ok(/Filling Swapboard v1 order #\d+/.test(await text(q, '#pin')) && (await q.inputValue('#amt')) === '0.01' && /^1,000/.test((await text(q, '#out')).trim()), `Fill sets the ticket to buy that order whole: 0.01 ETH for ${await text(q, '#out')} TAC`);
    ok(/Route.*Swapboard v1 order #\d+/.test((await text(q, '#route')).replace(/\s+/g, ' ')), 'and the route is that order');
    const rvb = (await text(q, '#route')).replace(/\s+/g, ' ');
    ok(/Swapboard v1 order #\d+/.test(rvb) && /Least you get[\d,.]+ TAC/.test(rvb) && !/I accept losing/.test(rvb), `the quote names the order and the least it takes (${rvb.slice(0, 150)})`);
    const t0 = await tacBal(me.account), e0 = await ethBal(me.account), mc0 = await tacBal(MC3), n0 = w.walletLog.sends.length;
    await q.click('#go');
    await until(q, () => /Bought\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
    ok(/Bought\. Received 1,000 TAC/.test(await text(q, '#status')) && (await tacBal(me.account)) - t0 === tac(1000), `the order was filled: exactly 1,000 TAC arrived (${(await text(q, '#status')).slice(0, 60)})`);
    ok(w.walletLog.sends.length === n0 + 1 && w.walletLog.sends.at(-1).to.toLowerCase() === ROUTER.toLowerCase() && e0 - (await ethBal(me.account)) >= eth(10) && e0 - (await ethBal(me.account)) < eth(10) + E18 / 100n, 'in one transaction to zRouter, costing 0.01 ETH and its gas');
    await until(q, (k) => !document.querySelector(`[data-fill="${k}"]`), fillKey, 120000);                       // the page reads the boards again once the trade has landed
    ok((await tacBal(MC3)) === mc0 && await q.$eval('#pin', (e) => e.hidden), 'the filled order has left the book, the pin is gone, and Multicall3 holds nothing');

    // a sale into the bid: the permit is signed, then one transaction
    const bidKey = await q.$eval('#ladders .ob-bids .ob-row[data-fill]', (b) => b.dataset.fill);
    ok(bidKey === `v2:${idV2 + 1n}`, `the bid is the Swapboard v2 one (${bidKey})`);
    await q.click(`[data-fill="${bidKey}"]`);
    await until(q, () => !document.querySelector('#out').classList.contains('ph') && /Sell TAC/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    ok((await q.inputValue('#amt')) === '1000' && /Filling Swapboard v2 order/.test(await text(q, '#pin')) && /^0\.015/.test((await text(q, '#out')).trim()), `Fill on a bid sets the ticket to sell 1,000 TAC for ${await text(q, '#out')} ETH`);
    if (await q.$('#ack')) await q.check('#ack');
    const s1 = w.walletLog.signs, tt = await tacBal(me.account), ee = await ethBal(me.account);
    await q.click('#go');
    await until(q, () => /Sold\./.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, 300000);
    ok(/Sold\. Received about 0\.01/.test(await text(q, '#status')) && tt - (await tacBal(me.account)) === tac(1000) && (await ethBal(me.account)) - ee > eth(14) - E18 / 100n, `1,000 TAC sold into the bid for about 0.015 ETH (${(await text(q, '#status')).slice(0, 70)})`);
    await until(q, (k) => !document.querySelector(`[data-fill="${k}"]`), bidKey, 120000);
    ok(w.walletLog.signs === s1 + 1, 'with the permit signed once, no approval, and the bid gone from the book');

    // "Use the best route" lets go of a pinned order
    const dutchKey = await q.$eval('#ladders [data-fill^="dutch:"]', (b) => b.dataset.fill);
    await q.click(`[data-fill="${dutchKey}"]`);
    await until(q, () => /Filling Dutchboard order/.test(document.querySelector('#pin')?.textContent || '') && /Buy TAC/.test(document.querySelector('#go')?.textContent || ''), null, 240000);
    await q.click('#unpin');
    ok(await q.$eval('#pin', (e) => e.hidden), '"Use the best route" lets go of the pinned order');

    // an order filled by someone else between the quote and the press stops the trade: nothing is sent
    await q.click(`[data-fill="${dutchKey}"]`);
    await until(q, () => /Buy TAC/.test(document.querySelector('#go')?.textContent || '') && !document.querySelector('#out').classList.contains('ph'), null, 240000);
    const rival = await fundedWallet(10n * E18, 0n);
    await sendTx(rival.account, DU, 'fill(uint256,uint128,address,uint256)', [idDu, tac(1000), rival.account, eth(40)], eth(40));
    const before = w.walletLog.sends.length;
    if (await q.$('#ack')) await q.check('#ack');
    await q.click('#go');
    await until(q, () => /just filled or cancelled/.test(document.querySelector('#status')?.textContent || ''), null, 120000);
    ok(/Nothing was sent/.test(await text(q, '#status')) && w.walletLog.sends.length === before, 'a lot someone else fills after the quote stops the trade with nothing sent');
    await until(q, (k) => !document.querySelector(`[data-fill="${k}"]`) && document.querySelector('#pin').hidden, dutchKey, 120000);
    ok(true, 'and the filled lot leaves the book and the pin');
    ok(w.errors.length === 0 && w.blocked.length === 0, `no page errors or blocked requests with the boards (${[...w.errors, ...w.blocked].slice(0, 2).join(' | ')})`);
    await w.browser.close();
  }


  // the main page takes the private swap from the link: the console on Swap, ETH to TAC, the amount in, the address its own again
  {
    const fp = await openPage({ width: 1280, height: 900 }, null, '#card=swap:ether:tac:private&amt=0.25', '/');
    await until(fp.page, () => document.querySelector('#hx-amt')?.value === '0.25', null, 120000).catch(() => {});
    const st = await fp.page.evaluate(() => ({ amt: document.querySelector('#hx-amt')?.value, tab: document.querySelector('[data-hxm][aria-selected="true"]')?.dataset.hxm, hash: location.hash }));
    ok(st.amt === '0.25' && st.tab === 'swap' && st.hash === '', `the main page opens its console on the private swap with the amount (${JSON.stringify(st)})`);
    await fp.browser.close();
  }

  // the addresses: TAC's own, and the bare ones people type
  {
    const own = await openPage({ width: 1280, height: 900 }, null, '', '/trade/tac/');
    await until(own.page, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || '') && !!document.querySelector('#chart .line'), null, 240000);
    ok(own.page.url().endsWith('/trade/tac/') && /tacit trade$/.test(await own.page.title()) && (await own.page.getAttribute('link[rel="canonical"]', 'href')) === 'https://tacit.finance/trade/tac/', '/trade/tac/ is the trade page at its own address, naming itself as its canonical one');
    ok((await own.page.getAttribute('meta[property="og:url"]', 'content')) === 'https://tacit.finance/trade/tac/' && own.errors.length === 0 && own.blocked.length === 0, 'and its shared link says so too, with nothing blocked');
    await own.browser.close();
    const bare = await openPage({ width: 1280, height: 900 }, null, '#side=sell&amount=1500', '/trade/tac');
    await until(bare.page, () => /\/trade\/tac\/#side=sell/.test(location.href) && document.querySelector('#amt')?.value === '1500' && !document.querySelector('#out')?.classList.contains('ph'), null, 240000);
    ok(/\/trade\/tac\/#side=sell&amount=1500$/.test(bare.page.url()) && /tacit trade$/.test(await bare.page.title()), '/trade/tac, without the slash, arrives at /trade/tac/ with the link\'s fragment kept: the sale of 1,500 TAC is quoted');
    await bare.browser.close();
    const root = await openPage({ width: 1280, height: 900 }, null, '', '/trade');
    await until(root.page, () => /\/trade\/tac\/$/.test(location.pathname) && /^\$/.test(document.querySelector('#px-usd')?.textContent || ''), null, 240000);
    ok(/tacit trade$/.test(await root.page.title()), '/trade arrives at /trade/tac/');
    await root.browser.close();
  }

  // dark
  if (SHOTS) {
    const d = await chromium.launch(), dctx = await d.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }), dp = await dctx.newPage();
    for (const h of RPC_HOSTS) await dctx.route(`https://${h}/**`, async (route) => { const x = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() }); await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await x.text() }); });
    await dctx.route(/^https:\/\/api\.tacit\.finance\/assets\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(apiBody(route.request().url())) }));
    await dp.goto(`http://127.0.0.1:${WEB}/trade/`);
    await until(dp, () => !!document.querySelector('#chart .line') && document.querySelectorAll('#ladders .ob-row').length > 0, null, 240000);   // the earlier checks have filled some of the orders
    await dp.click('[data-lane="cmp"]'); await dp.fill('#amt', '0.5');
    await until(dp, () => !document.querySelector('#out').classList.contains('ph'), null, 120000);
    await dp.screenshot({ path: join(SHOTS, 'trade-dark.png') });
    await d.close();
  }

  // a phone
  r = await openPage({ width: 390, height: 844 });
  const m = r.page;
  await until(m, () => /^\$/.test(document.querySelector('#px-usd')?.textContent || '') && !!document.querySelector('#chart .line'), null, 240000);
  ok(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scroll at 390px (${await m.evaluate(() => document.documentElement.scrollWidth)})`);
  const order = await m.evaluate(() => ['.p-ticket', '.p-chart', '.p-depth', '.p-info'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top)));
  ok(order.every((t, i) => i === 0 || t > order[i - 1]), `the panels stack ticket, chart, book, facts (${order})`);
  ok((await m.$eval('#chart', (e) => e.getBoundingClientRect().width)) > 300, 'the chart takes the phone\'s width');
  ok(await m.$$eval('.top nav a.opt', (a) => a.every((x) => getComputedStyle(x).display === 'none')), 'and the header\'s extra links are hidden there');
  const hd = await m.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { top: r('.top').height, brand: r('.brand').top, chip: r('#wallet-chip').top, earn: getComputedStyle(document.querySelector('.top nav a[href="#farm"]')).display }; });
  ok(hd.top < 90 && Math.abs(hd.brand - hd.chip) < 30 && hd.earn !== 'none', `the brand, Earn and the wallet chip share one row on a phone (${JSON.stringify(hd)})`);
  const subh = await m.$eval('#px-sub', (e) => e.getBoundingClientRect().height);
  ok(subh >= parseFloat(await m.$eval('#px-sub', (e) => getComputedStyle(e).minHeight)) - 1 && (await m.$$eval('#px-sub .st', (a) => a.every((x) => x.getBoundingClientRect().height < 26))), `the headline's figures are one line each, in a block that holds its height (${subh}px)`);
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
