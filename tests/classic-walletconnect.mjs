#!/usr/bin/env node
// WalletConnect in the classic app (dapp/classic.html): with no wallet in the browser the welcome sheet's Ethereum option still works, offering
// WalletConnect in a sheet that brings its own look; a wallet app opens the key with two signatures, the app's Ethereum disconnect ends the session in
// the wallet app, and the page loads under its CSP with no errors. The page runs the real dapp/walletconnect.js over a stand-in for its bundle
// (tests/wc-fake.mjs); no network.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/classic-walletconnect.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { useWcFake } from './wc-fake.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const secp = await import('@noble/secp256k1'), { keccak_256 } = await import('@noble/hashes/sha3'), { hmac } = await import('@noble/hashes/hmac'), { sha256 } = await import('@noble/hashes/sha256');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const DAPP = new URL('../dapp/', import.meta.url).pathname, WEB = 23300 + Math.floor(Math.random() * 90);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const KEY = Buffer.from('7'.repeat(63) + '1', 'hex');
const ADDR = '0x' + Buffer.from(keccak_256(secp.getPublicKey(KEY, false).slice(1)).slice(12)).toString('hex');
const personalSign = (hex) => { const m = Buffer.from(hex.replace(/^0x/, ''), 'hex'); const sg = secp.sign(keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m])), KEY); return '0x' + sg.toCompactHex() + (27 + sg.recovery).toString(16); };
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await useWcFake(ctx, { account: ADDR });
  const page = await ctx.newPage(), errors = [], asked = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text().slice(0, 160)); });
  await page.exposeFunction('__wcRequest', async (method, params) => { if (method !== 'personal_sign') return undefined; asked.push(method); return personalSign(params[0]); });
  await page.goto(`http://127.0.0.1:${WEB}/classic.html`);
  await page.waitForSelector('#welcome-eth', { state: 'visible', timeout: 60000 });
  ok(true, 'with no wallet in the browser the welcome sheet still offers the Ethereum wallet');
  await page.click('#welcome-eth');
  await page.waitForSelector('dialog.wcx[open] .wc-qr svg', { timeout: 60000 });
  ok(/Connect a wallet app/.test(await page.textContent('dialog.wcx[open] h2')), 'it opens WalletConnect\'s pairing sheet');
  await page.evaluate(() => window.__wcfake.approve());
  await page.waitForFunction(() => /ETH WALLET/i.test(document.body.textContent), null, { timeout: 90000 });
  for (let i = 0; i < 100 && asked.length < 2; i++) await page.waitForTimeout(100);
  ok(asked.length === 2 && !(await page.$('dialog.wcx[open]')), 'the wallet app opens the key with two signatures and the sheet goes');
  ok(await page.evaluate(() => !!localStorage.getItem('fake-wc-session')), 'and the session is kept');
  // the app's own Disconnect (in the Ethereum wallet's panel) asks, ends the wallet and reloads
  await page.evaluate(() => document.getElementById('btn-eth-disconnect').click());
  await page.click('#tcm-confirm');
  await page.waitForLoadState('load');
  await page.waitForFunction(() => !localStorage.getItem('fake-wc-session'), null, { timeout: 15000 });
  ok(true, 'the app\'s Ethereum disconnect ends the WalletConnect session');
  ok(!errors.length, `no page errors or blocked requests (${errors.slice(0, 2).join(' | ')})`);
} catch (e) { fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' / ')); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} classic-walletconnect checks passed`);
process.exit(fails ? 1 : 0);
