#!/usr/bin/env node
// WalletConnect on the Secret Sats page, which signs in through tacit.js's Ethereum wallet (the same module the classic app uses): with no wallet in the
// browser the Ethereum option still works, offering WalletConnect in a sheet that brings its own look (the page has none for it); a wallet app opens the
// key with two signatures, and tacit.js ending the Ethereum wallet ends the session in the wallet app. The page runs the real dapp/walletconnect.js over a
// stand-in for its bundle (tests/wc-fake.mjs); no network.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/sats-walletconnect.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { useWcFake } from './wc-fake.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const secp = await import('@noble/secp256k1'), { keccak_256 } = await import('@noble/hashes/sha3'), { hmac } = await import('@noble/hashes/hmac'), { sha256 } = await import('@noble/hashes/sha256');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const DAPP = new URL('../dapp/', import.meta.url).pathname, WEB = 23100 + Math.floor(Math.random() * 90);
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
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await useWcFake(ctx, { account: ADDR });
  const page = await ctx.newPage(), errors = [], asked = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text().slice(0, 160)); });
  await page.exposeFunction('__wcRequest', async (method, params) => { if (method !== 'personal_sign') return undefined; asked.push(method); return personalSign(params[0]); });
  await page.goto(`http://127.0.0.1:${WEB}/sats/`);
  await page.waitForSelector('#btn-eth');
  await page.click('#btn-eth');
  await page.waitForSelector('dialog.wcx[open] .wc-qr svg', { timeout: 60000 });
  const sheet = (await page.textContent('dialog.wcx[open]')).replace(/\s+/g, ' ');
  ok(/Connect a wallet app/.test(sheet) && /Copy link/.test(sheet), `with no wallet in the browser, the Ethereum option opens WalletConnect's pairing sheet (${sheet.slice(0, 70)})`);
  ok(await page.$eval('dialog.wcx[open]', (d) => { const r = d.getBoundingClientRect(); return r.width > 300 && r.width <= 470 && getComputedStyle(d).backgroundColor !== 'rgba(0, 0, 0, 0)'; }), 'the sheet has its own look: a card of a readable width over the page');
  await page.evaluate(() => window.__wcfake.approve());
  await page.waitForFunction(() => !/^(Sign in|Open wallet)$/.test(document.querySelector('#chip-label')?.textContent || 'Sign in'), null, { timeout: 90000 });
  ok(asked.length === 2 && !(await page.$('dialog.wcx[open]')), `the wallet app opens the key with two signatures and the sheet goes (${await page.textContent('#chip-label')})`);
  // tacit.js ending its Ethereum wallet ends the session in the wallet app
  const url = readFileSync(join(DAPP, 'sats/app.js'), 'utf8').match(/const TACIT_URL = '([^']+)'/)[1];
  await page.evaluate(async (u) => { (await import(u)).ethWallet.disconnect(); }, url);
  await page.waitForFunction(() => window.__wcfake.disconnected === 1, null, { timeout: 15000 });
  ok(true, 'ending the Ethereum wallet ends the WalletConnect session');
  ok(!errors.length, `no page errors or blocked requests (${errors.slice(0, 2).join(' | ')})`);
} catch (e) { fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' / ')); }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} sats-walletconnect checks passed`);
process.exit(fails ? 1 : 0);
