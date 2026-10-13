#!/usr/bin/env node
// Connecting a wallet on dapp/trade/ for someone who arrives straight at it, in a real browser under the page's own CSP: the header chip,
// the wallet picker, WalletConnect's pairing sheet (its provider is a stand-in that announces itself the way dapp/walletconnect.js does and
// pairs when the test says so: WalletConnect itself needs a relay and a phone), the account sheet with Disconnect, and on a phone the bar at
// the foot that leads to the ticket.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-connect.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, FX = new URL('./fixtures/', import.meta.url).pathname;
const WEB = 22900 + Math.floor(Math.random() * 90);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const json = (n) => JSON.parse(readFileSync(join(FX, n), 'utf8'));
const soon = Math.floor(Date.now() / 1000) + 7 * 86400;
const asset = json('tac-asset-2026-10-12.json'), sales = json('tac-sales-2026-10-12.json'), bids = json('tac-bids-2026-10-12.json');
sales.sales = sales.sales.map((x) => ({ ...x, expiry: soon, expired: false, seller_pubkey: '02' + 'ab'.repeat(32) }));
bids.intents = bids.intents.map((x) => ({ ...x, expiry: soon }));
const ACCOUNT = '0x1234567890abcdef1234567890abcdef12345678', OTHER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

// What dapp/walletconnect.js gives the page: a provider announced through EIP-6963 when the browser has no wallet of its own, whose
// eth_requestAccounts shows the page's pairing sheet and waits.
const WC_STUB = `
export function announceWalletConnect({ onPair, onAsk }) {
  window.__wc = { cancelled: 0, disconnected: 0, approve: null };
  const provider = {
    isWalletConnect: true,
    async request({ method }) {
      if (method === 'eth_requestAccounts') {
        let reject;
        const done = onPair({ uri: 'wc:stub@2?relay-protocol=irn', qrSvg: '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>', cancel: () => { window.__wc.cancelled++; reject(Object.assign(new Error('Connection cancelled'), { code: 4001 })); } });
        await new Promise((res, rej) => { reject = rej; window.__wc.approve = () => res(); });
        done();
        return ['${ACCOUNT}'];
      }
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_accounts') return [];
      throw new Error('stub: ' + method);
    },
    on() { return provider; }, removeListener() { return provider; },
  };
  const detail = Object.freeze({ info: Object.freeze({ uuid: 'wc-stub', name: 'WalletConnect', icon: '', rdns: 'com.walletconnect' }), provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  return { provider, disconnect: async () => { window.__wc.disconnected++; } };
}`;
// A browser wallet that announces itself through EIP-6963.
const BROWSER_WALLET = `(() => {
  // It allows this site once asked (kept across a reload, as a wallet does), and counts the prompts it shows.
  const provider = { async request({ method }) {
    if (method === 'eth_requestAccounts') { window.__prompts = (window.__prompts || 0) + 1; localStorage.setItem('stub-allowed', '1'); return ['${OTHER}']; }
    if (method === 'eth_accounts') return localStorage.getItem('stub-allowed') ? ['${OTHER}'] : [];
    if (method === 'eth_chainId') return '0x1'; throw new Error('stub: ' + method); }, on() {}, removeListener() {} };
  const detail = Object.freeze({ info: Object.freeze({ uuid: 'browser-stub', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
})();`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
const until = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout });

async function openPage(viewport, { browserWallet = false, phone = false } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: 'light', ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  if (browserWallet) await ctx.addInitScript(BROWSER_WALLET);
  const ok200 = (body) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  for (const h of ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co']) await ctx.route(`https://${h}/**`, (r) => r.fulfill(ok200({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'not served in this test' } })));
  await ctx.route(/^https:\/\/api\.tacit\.finance\//, (r) => { const p = new URL(r.request().url()).pathname; return r.fulfill(ok200(/preauth-sales$/.test(p) ? sales : /bid-intents$/.test(p) ? bids : asset)); });
  await ctx.route('**/walletconnect.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: WC_STUB }));
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t); else if (!/Failed to load resource/.test(t)) errors.push(t); } });
  await page.goto(`http://127.0.0.1:${WEB}/trade/tac/`);
  await page.waitForSelector('#wallet-chip');
  await page.waitForTimeout(800);
  return { browser, page, errors, blocked };
}
const chip = (p) => p.evaluate(() => ({ label: document.querySelector('#wallet-label').textContent, on: document.querySelector('#wallet-dot').classList.contains('on') }));

let r;
try {
  // someone with no wallet in the browser, at a desktop
  r = await openPage({ width: 1280, height: 900 });
  let p = r.page;
  let c = await chip(p);
  ok(c.label === 'Connect' && !c.on && (await text(p, '#go')) === 'Connect wallet', 'the header has a Connect button beside the page\'s links, and the ticket asks to connect');
  ok(!(await p.$eval('#stick', (e) => e.offsetParent !== null)), 'a desktop has no bar at the foot');
  await p.click('#wallet-chip');
  await p.waitForSelector('.bsheet.top .wc-qr svg');
  const sheet = (await text(p, '.bsheet.top')).replace(/\s+/g, ' ');
  ok(/Connect a wallet app/.test(sheet) && /Scan the code with a wallet app on your phone/.test(sheet) && /Copy link/.test(sheet) && !/Open wallet app/.test(sheet), `with no wallet in the browser, Connect opens WalletConnect's pairing sheet with a code to scan (${sheet.slice(0, 90)})`);
  await p.click('.bsheet.top .x');
  await until(p, () => !document.querySelector('.bsheet'), null, 5000);
  ok((await p.evaluate(() => window.__wc.cancelled)) === 1 && (await chip(p)).label === 'Connect', 'closing the sheet cancels the pairing and nothing is connected');
  await p.click('#go');
  await p.waitForSelector('.bsheet.top .wc-qr');
  await p.evaluate(() => window.__wc.approve());
  await until(p, () => !document.querySelector('.bsheet') && document.querySelector('#wallet-dot').classList.contains('on'), null, 10000);
  await until(p, () => document.querySelector('#go').textContent === 'Enter an amount', null, 15000).catch(() => {});
  c = await chip(p);
  ok(c.on && c.label === '0x1234…5678' && (await text(p, '#go')) === 'Enter an amount', `the ticket's own button connects too, and the header shows the account (${c.label})`);
  await p.click('#wallet-chip');
  await p.waitForSelector('.bsheet.top [data-leave]');
  const acct = (await text(p, '.bsheet.top')).replace(/\s+/g, ' ');
  ok(/WalletConnect/.test(acct) && acct.includes(ACCOUNT) && /Copy address/.test(acct) && /Disconnect/.test(acct), `the account sheet names the wallet and the account and offers Disconnect (${acct.slice(0, 100)})`);
  await p.click('.bsheet.top [data-leave]');
  await until(p, () => !document.querySelector('.bsheet') && document.querySelector('#wallet-label').textContent === 'Connect', null, 10000);
  ok((await p.evaluate(() => window.__wc.disconnected)) === 1 && (await text(p, '#go')) === 'Connect wallet' && !(await chip(p)).on, 'Disconnect ends the WalletConnect session and puts the page back to asking for a wallet');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page errors or blocked requests (${[...r.errors, ...r.blocked].slice(0, 2).join(' | ')})`);
  await r.browser.close();

  // a browser wallet and WalletConnect both found: the person chooses
  r = await openPage({ width: 1280, height: 900 }, { browserWallet: true });
  p = r.page;
  await p.evaluate(() => window.dispatchEvent(new Event('eip6963:requestProvider')));                  // as a wallet announcing late would
  await p.click('#wallet-chip');
  await p.waitForSelector('.bsheet.top .picker');
  const names = await p.$$eval('.bsheet.top .picker .way', (b) => b.map((x) => x.textContent.trim()));
  ok(names.length === 2 && names.includes('Test Wallet') && names.includes('WalletConnect'), `with a browser wallet and WalletConnect found, a short list asks which (${names.join(', ')})`);
  await p.click('.bsheet.top .picker .way:has-text("Test Wallet")');
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on'), null, 10000);
  ok((await chip(p)).label === '0xabcd…abcd' && !(await p.$('.bsheet')), 'choosing one connects it with no pairing sheet');
  // a reload: the wallet chosen last time is connected again, with no prompt
  await p.reload(); await p.waitForSelector('#wallet-chip');
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on'), null, 10000).catch(() => {});
  ok((await chip(p)).label === '0xabcd…abcd' && !(await p.evaluate(() => window.__prompts || 0)) && !(await p.$('.bsheet')), `a reload reconnects the same wallet without asking again (${(await chip(p)).label})`);
  await p.click('#wallet-chip'); await p.click('.bsheet.top [data-leave]');
  await p.reload(); await p.waitForSelector('#wallet-chip'); await p.waitForTimeout(1200);
  ok((await chip(p)).label === 'Connect', 'after Disconnect a reload stays disconnected');
  await r.browser.close();

  // a phone: nothing to tap in the first screen but the bar at the foot, which leads to the ticket
  r = await openPage({ width: 390, height: 844 }, { phone: true });
  p = r.page;
  ok(await p.$eval('.p-ticket', (e) => e.getBoundingClientRect().top < window.innerHeight * 0.75) && (await p.$eval('#stick', (e) => e.hidden)), 'on a phone the ticket comes right after the prices, so it is on the first screen and the bar waits');
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await until(p, () => !document.querySelector('#stick').hidden, null, 10000);
  ok(await p.$eval('#stick', (e) => getComputedStyle(e).display === 'block' && e.getBoundingClientRect().bottom <= window.innerHeight + 1), 'further down the bar at the foot leads back to it');
  await p.click('#stick-go');
  await until(p, () => document.querySelector('#stick').hidden, null, 10000);
  ok(await p.$eval('.p-ticket', (e) => { const r = e.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; }), 'pressing it brings the ticket into view, and the bar goes away');
  await p.click('#go');
  await p.waitForSelector('.bsheet.top .wc-qr');
  const href = await p.$eval('.bsheet.top a.btn', (a) => a.getAttribute('href'));
  ok(/^wc:/.test(href) && /Open wallet app/.test(await text(p, '.bsheet.top')), 'on a phone the pairing sheet has a button that opens the wallet app');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'and nothing scrolls sideways');
  await r.browser.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' / '));
  if (r) console.log('     errors:', r.errors.slice(0, 4), 'blocked:', r.blocked.slice(0, 3));
  await r?.browser.close().catch(() => {});
} finally { server.close(); }
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} trade-connect checks passed`);
process.exit(fails ? 1 : 0);
