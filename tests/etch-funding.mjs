#!/usr/bin/env node
// dapp/etch/ with its real wallet door (/trade/btc.js, its sign-in sheet and its Add sats sheet) and only the key session and tacit.js behind it stubbed: how a key
// that holds sats at its address, sats in silent payments, a Bitcoin wallet's sats, or none, gets to an etch.
//   checks: opening the key with a Bitcoin wallet and then funding from that wallet in one press (the wallet's own transfer to the key's address); a key opened another
//   way is offered the address alone; silent payments are counted, shown and moved to the address by the etch's own press; a balance that has arrived since it was read
//   is not spent on by the press that finds it (the button changes and waits); coming back to the page reads the balance again.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/etch-funding.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// The key session and tacit.js: a key opened through the sheet, a few sats, and the calls the page makes recorded.
const SESSION = `
const W = window.__w = { calls: [], sats: 0, silent: 0, need: 4000 };
const rec = (name, args) => W.calls.push({ name, args });
const ADDR = 'bc1qtestaddress0000000000000000000000000';
let key = null; const listeners = new Set(); const emit = () => listeners.forEach((f) => f());
const T = {
  wallet: { pub: new Uint8Array(33), address: () => ADDR },
  hash160: () => new Uint8Array(20), bytesToHex: () => 'ab'.repeat(20),
  getUtxos: async () => (W.sats ? [{ txid: 'ee'.repeat(32), vout: 0, value: W.sats }] : []),
  scanHoldings: async () => new Map(), bridgedAtTaproot: async () => ({ count: 0 }),
  extWallet: { state: { provider: 'sats-connect', address: 'bc1qext' }, sendSats: async (to, n) => { rec('sendSats', { to, n }); if (W.refuse) throw new Error('User rejected the request'); W.sats += n; return 'ab'.repeat(32); } },
  etchQuote: async () => ({ rate: 5, fee: 2100, need: W.need }),
  silentSats: async () => W.silent,
  gatherSats: async (n) => { rec('gather', n); W.sats += n; W.silent -= n; return 'dd'.repeat(32); },
  etchAsset: async (o) => { rec('etch', { ticker: o.ticker }); return { commitTxid: 'c1'.repeat(32), revealTxid: 'e2'.repeat(32), assetIdHex: 'a7'.repeat(32), metadataPinned: true, supplyPublished: true }; },
};
const opener = (mode) => async () => { key = { mode, pubHex: '02' + 'ab'.repeat(32), address: 'bc1qext' }; emit(); };
export const short = (a) => a;
export class Cancelled extends Error { constructor() { super('Cancelled.'); this.unlockCancelled = true; } }
export function makeBtcSession() {
  return {
    load: async () => T, get T() { return T; }, get key() { return key; }, get unlocked() { return !!key; }, get address() { return key ? ADDR : null; },
    known: () => null, other: () => null, passkeyAvailable: () => false, btcSeen: () => true, ethAvailable: () => true,
    open: { btc: opener('btc'), eth: opener('eth'), passkey: opener('passkey'), newPasskey: opener('passkey') },
    lock() { key = null; emit(); }, onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const b = await chromium.launch();
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());
const calls = (page, name) => page.evaluate((nm) => window.__w.calls.filter((c) => c.name === nm), name);
const label = (page) => text(page, '#go');
const type = async (page, sel, v) => { await page.fill(sel, ''); await page.type(sel, v, { delay: 5 }); };

async function fresh(w = {}) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.route(/\/trade\/btc-session\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: SESSION }));
  await page.goto(`${BASE}/etch/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tk');
  await type(page, '#tk', 'orange');
  await type(page, '#sup', '1000');
  await page.waitForFunction(() => window.__w);
  await page.evaluate((o) => Object.assign(window.__w, o), w);
  return { page, errs };
}
async function signIn(page, way) {
  await page.click('#go');
  await page.waitForSelector(`.bsheet [data-in="${way}"]`);
  await page.click(`.bsheet [data-in="${way}"]`);
  await page.waitForFunction(() => !document.querySelector('.bsheet'));
}

console.log('A key opened with a Bitcoin wallet, with no sats:');
{
  const { page, errs } = await fresh({ sats: 0 });
  await signIn(page, 'btc');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  ok(true, 'the button says Add sats');
  ok(/Needs about 4,000 sats at your wallet’s address\. It holds 0\./.test(await text(page, '#q')), 'and the line says how many');
  await page.click('#go');
  await page.waitForSelector('.bsheet [data-send]');
  ok(/Add sats/.test(await text(page, '.bsheet h2')), 'a sheet opens');
  ok((await text(page, '.bsheet [data-send]')) === 'Send 5,000 sats from your wallet', 'offering that wallet’s own transfer, in whole 500s and not under 5,000');
  ok(/bc1qtestaddress/.test(await text(page, '.bsheet .addr')) && !!(await page.$('.bsheet [data-copy]')), 'beside the address to copy');
  ok((await calls(page, 'sendSats')).length === 0, 'nothing is sent by opening it');
  await page.click('.bsheet [data-send]');
  await page.waitForFunction(() => window.__w.calls.some((c) => c.name === 'sendSats'));
  const s = (await calls(page, 'sendSats'))[0].args;
  ok(s.to === 'bc1qtestaddress0000000000000000000000000' && s.n === 5000, 'the wallet is asked for 5,000 sats to the key’s address');
  await page.waitForFunction(() => !document.querySelector('.bsheet'), null, { timeout: 15000 });
  ok(true, 'the sheet closes once the address shows them');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch ORANGE');
  ok((await calls(page, 'etch')).length === 0, 'and the etch waits for its own press');
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  ok((await calls(page, 'etch')).length === 1, 'which etches');
  ok(errs.length === 0, 'no script errors' + (errs[0] ? `: ${errs[0]}` : ''));
  await page.close();
}
{
  const { page } = await fresh({ sats: 0, refuse: true });
  await signIn(page, 'btc');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.click('#go');
  await page.click('.bsheet [data-send]');
  await page.waitForFunction(() => /Nothing was sent/.test(document.querySelector('.bsheet [data-st]')?.textContent || ''));
  ok(!(await page.$eval('.bsheet [data-send]', (e) => e.disabled)), 'a transfer declined in the wallet says nothing was sent, and can be asked again');
  await page.close();
}

console.log('\nA key opened another way:');
{
  const { page } = await fresh({ sats: 0 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.click('#go');
  await page.waitForSelector('.bsheet [data-copy]');
  ok(!(await page.$('.bsheet [data-send]')), 'is offered the address to send to, and no wallet transfer');
  await page.close();
}

console.log('\nSats in silent payments:');
{
  const { page } = await fresh({ sats: 0, silent: 40000 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => /silent payments/.test(document.querySelector('#q').textContent));
  ok((await label(page)) === 'Etch ORANGE', 'they count: the button offers the etch, not Add sats');
  ok(/In your wallet0 sats \+ 40,000 silent/.test((await page.$$eval('#rcpt div', (d) => d.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))).join('|')), 'the receipt shows them');
  ok(/silent payments: etching first moves them to your wallet’s address, in one more transaction/.test(await text(page, '#q')), 'and says what the press does');
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  const order = await page.evaluate(() => window.__w.calls.filter((c) => c.name === 'gather' || c.name === 'etch').map((c) => c.name));
  ok(order.join() === 'gather,etch', `they are moved first, then the etch is sent (${order})`);
  ok((await calls(page, 'gather'))[0].args === 4000, 'enough to cover what the etch needs');
  await page.close();
}
{
  const { page } = await fresh({ sats: 0, silent: 4500 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  ok(true, 'silent payments that leave too little after the move are not counted as enough');
  await page.close();
}

console.log('\nSats that arrive after the balance was read:');
{
  const { page } = await fresh({ sats: 0 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.evaluate(() => { window.__w.sats = 60000; });
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch ORANGE');
  ok((await calls(page, 'etch')).length === 0 && !(await page.$('.bsheet')), 'the press that finds them changes the button and sends nothing');
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  ok((await calls(page, 'etch')).length === 1, 'the next press etches');
  await page.close();
}
{
  const { page } = await fresh({ sats: 0 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.evaluate(() => { window.__w.sats = 60000; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch ORANGE', null, { timeout: 8000 });
  ok(true, 'coming back to the page reads the balance again, and the button follows');
  ok((await calls(page, 'etch')).length === 0, 'with nothing sent');
  await page.close();
}

await b.close();
server.close();
console.log(`\n${n} ok, ${fails} failed`);
process.exit(fails ? 1 : 0);
