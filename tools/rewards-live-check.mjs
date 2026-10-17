#!/usr/bin/env node
// A read-only check of the live airdrop and points pages in a real browser: nothing is signed or sent. The wallet is a stub that only answers
// account reads (it is set to the Precision pool's own address, which holds TAC and ETH, so the farm card has something to show).
//
//   PLAYWRIGHT=/path/to/node_modules/playwright-core node tools/rewards-live-check.mjs [https://tacit.finance]
//
// It reads the page, a lookup by address and by name, the folds, the links into the page (the lander's airdrop line, /airdrop, another page's
// wallet sheet), and the farm card with its private farms; it fails on a console error, a CSP violation or a page error. Exit 1 on any failure.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const BASE = (process.argv[2] || 'https://tacit.finance').replace(/\/$/, '');
const POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E', TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', SEEN = '0xd59c2f78d5e6ad8c69ef11e39af7b8cfdb9faf36';
let fails = 0;
const bad = [];
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const stub = (acct) => `window.ethereum = { request: async ({ method }) => { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${acct}']; if (method === 'eth_chainId') return '0x1'; throw Object.assign(new Error('a read-only check sends nothing'), { code: 4001 }); }, on() {}, removeListener() {} };`;
const browser = await chromium.launch();
const open = async (wallet) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  if (wallet) await ctx.addInitScript(stub(wallet));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => bad.push(`page error: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text().slice(0, 150)}`); });
  return p;
};
const wait = (p, fn, ms = 30000) => p.waitForFunction(fn, null, { timeout: ms });
const connectBrowserWallet = async (p) => {
  await p.click('#wallet-chip');
  await p.waitForSelector('.bsheet .way', { timeout: 15000 }).then(() => p.click('.bsheet .way:has-text("Browser wallet")')).catch(() => {});
};
try {
  // the page, a lookup by address and by name, the token row, the APR on the Farm link
  let p = await open();
  await p.goto(`${BASE}/rewards/`);
  await p.waitForSelector('#tok');
  ok((await p.$eval('#tok [data-copy]', (e) => e.dataset.copy)) === TAC && (await p.$eval('#tok a', (e) => e.href)).endsWith(`/token/${TAC}`), 'the TAC token row: address, copy, and its Etherscan token page');
  await wait(p, () => /^\d[\d,]*%/.test(document.querySelector('.uses .apr')?.textContent || '')).catch(() => {});
  ok(/^\d/.test(await p.textContent('.uses .apr')), `the Farm link carries the APR (${(await p.textContent('.uses .apr')).trim()})`);
  await p.fill('#q', SEEN);
  await wait(p, () => document.querySelector('#c-pts') && !document.querySelector('#c-pts .sk') && /points/.test(document.querySelector('#c-pts').textContent));
  ok(/Rank #\d+/.test(await p.textContent('#c-pts')) || /No points yet/.test(await p.textContent('#c-pts')), 'a lookup by address reads its points');
  await p.fill('#q', 'vitalik.eth');
  await wait(p, () => /vitalik/.test(document.querySelector('.who')?.textContent || '') && !document.querySelector('#c-air .sk'));
  ok(/Airdrop/.test(await p.textContent('#c-air')), 'a lookup by .eth name reads its airdrop');
  // the folds, on an address with points
  await p.fill('#q', SEEN);
  await p.waitForSelector('#c-pts [data-days]', { timeout: 30000 });
  await p.click('#c-pts [data-days] > summary'); await p.waitForSelector('#c-pts .rows li', { timeout: 20000 });
  await p.click('#earn > summary'); await p.waitForSelector('#earn-b .ways li', { timeout: 20000 });
  await p.click('#lb > summary'); await p.waitForSelector('#lb-b .board li', { timeout: 20000 });
  ok(true, `the folds read: ${await p.$$eval('#c-pts .rows li', (a) => a.length)} days, ${await p.$$eval('#earn-b .ways li', (a) => a.length)} ways to earn, ${await p.$$eval('#lb-b .board li', (a) => a.length)} on the board`);
  // the ways in
  p = await open();
  await p.goto(`${BASE}/`);
  ok((await p.getAttribute('#air-news', 'href')) === '/rewards/', "the lander's airdrop line links to the rewards page");
  await p.goto(`${BASE}/airdrop`);
  await p.waitForURL('**/rewards/**', { timeout: 15000 }).catch(() => {});
  ok(new URL(p.url()).pathname === '/rewards/', `/airdrop lands on the rewards page (${p.url()})`);
  p = await open(POOL);
  await p.goto(`${BASE}/swap/`);
  await p.waitForSelector('#wallet-chip');
  await connectBrowserWallet(p);
  await wait(p, () => /0x[0-9a-f]{4}/i.test(document.querySelector('#wallet-label')?.textContent || ''), 20000);
  await wait(p, () => !document.querySelector('.bsheet'), 15000);
  await p.click('#wallet-chip');
  await p.waitForSelector('.bsheet a[href^="/rewards/?q=0x"]', { timeout: 15000 });
  ok(true, "another page's wallet sheet links to the account's airdrop and points");
  // the farm card, for a wallet that holds TAC: it appears, opens, fills, and lists the private farms
  p = await open(POOL);
  await p.goto(`${BASE}/rewards/?q=${POOL}`);
  await p.waitForSelector('#tok');
  await p.waitForTimeout(1500);
  await connectBrowserWallet(p);
  await wait(p, () => !document.querySelector('#farm').hidden);
  await p.click('#farm > summary');
  await wait(p, () => /Deposit/.test(document.querySelector('#fm-rcpt')?.textContent || '') && Number(document.querySelector('#fm-tacamt')?.value) > 0, 60000);
  ok(/Farm with/.test(await p.textContent('#fm-go')) && !(await p.$eval('#fm-go', (b) => b.disabled)), `the farm opens filled in (${await p.inputValue('#fm-amt')} ETH + ${await p.inputValue('#fm-tacamt')} TAC)`);
  await wait(p, () => document.querySelectorAll('#fm-prog .fm-pf').length > 0, 30000).catch(() => {});
  ok((await p.$$eval('#fm-prog .fm-pf', (a) => a.length)) > 0, 'and lists the private farms with their APRs');
} catch (e) {
  fails++; console.log('FAIL', e.message.split('\n')[0]);
} finally { await browser.close(); }
ok(bad.length === 0, `no page errors, console errors or CSP violations${bad.length ? `: ${bad.slice(0, 4).join(' | ')}` : ''}`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
