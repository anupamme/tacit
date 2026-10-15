// Checks the tip splitter page (dapp/splitter/) in a real browser against a local chain: no fork, anvil as chain 1, so nothing here
// touches a live network. The page's public RPC hosts are routed to anvil, the relay API's quote is stubbed, and window.ethereum is an
// EIP-1193 stub that sends as one of anvil's own accounts. It deploys the page's own compiled splitter, sends it ETH, sends it on, changes
// the list (alone, and after sending what waits), and checks what an account that is not the owner is shown.
//
//   PLAYWRIGHT=<path to playwright-core> node tools/splitter-check.mjs   (SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { encSetShares, encDistribute, SEL, decodeShares, decodeAddress } from '../dapp/splitter/abi.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const WEB = 22000 + Math.floor(Math.random() * 2000), CHAIN = 24000 + Math.floor(Math.random() * 2000);
const ROOT = `http://127.0.0.1:${WEB}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', A1 = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const DEPLOYER = '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', SETTLE = '0x7a0f0511e1dcf399c2f7bbe8414b6a0d1abc4331', MULTISIG = '0x006cd14f36f65ecbb29b2519ccbe63a0dc8549f2';
const ETH = 10n ** 18n;

let fails = 0;
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };

// ---- anvil ----
const anvil = spawn('anvil', ['--chain-id', '1', '--port', String(CHAIN), '--silent'], { stdio: 'ignore' });
const rpcRaw = (body) => fetch(`http://127.0.0.1:${CHAIN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.text());
const chain = async (method, params = []) => { const j = JSON.parse(await rpcRaw(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))); if (j.error) throw new Error(j.error.message); return j.result; };
const bal = async (a) => BigInt(await chain('eth_getBalance', [a, 'latest']));
for (let i = 0; i < 50; i++) { try { await chain('eth_chainId'); break; } catch { await sleep(200); } }

// ---- the page, served from dapp/ ----
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const u = new URL(req.url, ROOT);
  let f = normalize(join(DAPP, decodeURIComponent(u.pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(WEB, r));

// ---- the browser ----
let quote = MULTISIG, account = A0;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
await ctx.route(/^https:\/\/(ethereum-rpc\.publicnode\.com|eth\.drpc\.org|1rpc\.io|mainnet\.gateway\.tenderly\.co)\//, async (route) => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: await rpcRaw(route.request().postData()) });
});
await ctx.route(/^https:\/\/api\.tacit\.finance\/confidential\/quote/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ticker: 'cETH', recommendedTipRecipient: quote }) }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const sent = [];
await page.exposeFunction('__wallet', async (method, params) => {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
  if (method === 'eth_chainId') return '0x1';
  if (method === 'wallet_switchEthereumChain') return null;
  if (method === 'eth_sendTransaction') { sent.push(params[0]); return chain('eth_sendTransaction', [{ ...params[0], from: account }]); }
  return chain(method, params);
});
await page.addInitScript(() => { window.ethereum = { request: ({ method, params }) => window.__wallet(method, params || []), on() {}, removeListener() {} }; });

const until = (fn, arg, ms = 30000) => page.waitForFunction(fn, arg, { timeout: ms });
const text = (sel) => page.$eval(sel, (e) => e.textContent).catch(() => '');
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/splitter-${n}.png`, fullPage: true }); };
const shares = async (addr) => decodeShares(await chain('eth_call', [{ to: addr, data: SEL.shares }, 'latest']));

try {
  // ── deploy ──
  await page.goto(`${ROOT}/splitter/`);
  await page.waitForSelector('#p-deploy .row');
  ok(await page.$eval('#p-state', (e) => e.hidden) && !(await page.$eval('#p-deploy', (e) => e.hidden)), 'deploy: with no splitter chosen, only the deploy form shows');
  const rows = await page.$$eval('#p-deploy .row input', (els) => els.map((e) => e.value));
  ok(rows[0].toLowerCase() === DEPLOYER && rows[1] === '70' && rows[2].toLowerCase() === SETTLE && rows[3] === '30', `deploy: it starts at 70% to the deployer wallet and 30% to the settle wallet (${rows.join(' ')})`);
  ok(!(await page.$eval('#p-deploy .btn', (b) => b.disabled)) && (await text('#p-deploy .hint')) === '', 'deploy: a valid list can be deployed, with no complaint');
  await page.fill('#dep-owner', A0);
  await page.click('#wallet-chip');
  await until(() => /f39f/i.test(document.querySelector('#wallet-label').textContent));
  ok(true, 'deploy: the wallet chip shows the connected account');
  await page.click('#p-deploy .btn');
  await until(() => !document.querySelector('#p-state').hidden && /ETH waiting/.test(document.querySelector('#p-state').textContent), null, 60000);
  const addr = (await page.$eval('#addr-in', (i) => i.value)).toLowerCase();
  ok(/^0x[0-9a-f]{40}$/.test(addr) && (await chain('eth_getCode', [addr, 'latest'])).length > 100, `deploy: a contract is at the address the page then shows (${addr.slice(0, 10)}…)`);
  const owner = decodeAddress(await chain('eth_call', [{ to: addr, data: SEL.owner }, 'latest']));
  const sh0 = await shares(addr);
  ok(owner === A0 && sh0.to.join() === `${DEPLOYER},${SETTLE}` && sh0.weight.join() === '70,30', 'deploy: on chain the owner is the address typed and the list is 70 / 30');
  ok(/^Deploy/.test(await text('#p-deploy .eyebrow')) && (await page.$eval('#p-next', (e) => !e.hidden)), 'deploy: the next steps appear');
  ok(/Constructor arguments: 0x/.test(await text('#p-next')), 'deploy: the constructor arguments are shown for Etherscan');
  await shot('deployed');

  // ── tips arrive ──
  await chain('eth_sendTransaction', [{ from: A1, to: addr, value: '0x' + (ETH / 2n).toString(16) }]);
  await page.click('#pick button');
  await until(() => /0\.5/.test(document.querySelector('#p-state .room')?.textContent || ''));
  const prev = await text('#p-state');
  ok(/→ Deployer wallet0\.35 ETH/.test(prev) && /→ Settle wallet0\.15 ETH/.test(prev), 'state: what waits is shown with what each wallet will get (0.35 and 0.15)');
  ok(/Wrap tips do not come here yet/.test(prev) && /Ops multisig/.test(prev), 'state: while the relay quote names the multisig, the page says tips do not come here yet and names the multisig');
  const d0 = await bal(DEPLOYER), s0 = await bal(SETTLE);

  // ── send it on ──
  await page.click('#p-state .btn');
  await until(() => /Sent on\./.test(document.querySelector('#p-state .status')?.textContent || ''), null, 60000);
  ok((await bal(DEPLOYER)) - d0 === (ETH * 35n) / 100n && (await bal(SETTLE)) - s0 === (ETH * 15n) / 100n && (await bal(addr)) === 0n, 'send on: the deployer wallet got 0.35 ETH, the settle wallet 0.15 ETH, and nothing is left');
  await until(() => /^0ETH waiting/.test((document.querySelector('#p-state .room')?.textContent || '').trim()));
  ok((await page.$eval('#p-state .btn', (b) => b.disabled)), 'send on: with nothing waiting the button is off');
  await until(() => document.querySelectorAll('#p-state .log').length >= 1);
  ok(/Sent on .* ago/.test(await text('#p-state .log')), 'send on: the recent list shows it');

  // ── the relay quote names the splitter ──
  quote = addr;
  await page.click('#pick button');
  await until(() => /Wrap tips come here/.test(document.querySelector('#p-state')?.textContent || ''));
  ok(true, 'state: once the quote names this splitter the page says tips come here');

  // ── change the list, nothing waiting ──
  const w = await page.$$('#p-edit .row input');
  ok(w.length === 4, 'edit: two wallets, each with a weight');
  await w[1].fill('1'); await w[3].fill('1');
  await until(() => /50%/.test(document.querySelector('#p-edit .row .pc')?.textContent || ''));
  ok(/Deployer wallet · 50%/.test(await text('#p-edit .row .pc')), 'edit: typing weights updates the share at once');
  await page.click('#p-edit .btn:not(.ghost)');
  await until(() => /The list is changed/.test(document.querySelector('#p-edit .status')?.textContent || ''), null, 60000);
  const sh1 = await shares(addr);
  ok(sh1.weight.join() === '1,1', 'edit: the new weights are on chain');

  // ── change the list with something waiting: it goes out under the old list first ──
  await chain('eth_sendTransaction', [{ from: A1, to: addr, value: '0x' + (ETH / 5n).toString(16) }]);
  await page.click('#pick button');
  await until(() => /Send what waits, then set the list/.test(document.querySelector('#p-edit .btn:not(.ghost)')?.textContent || ''));
  const w2 = await page.$$('#p-edit .row input');
  await w2[1].fill('3'); await w2[3].fill('1');
  const d1 = await bal(DEPLOYER), s1 = await bal(SETTLE), nTx = sent.length;
  await page.click('#p-edit .btn:not(.ghost)');
  await until(() => /The list is changed/.test(document.querySelector('#p-edit .status')?.textContent || ''), null, 60000);
  ok(sent.length - nTx === 2 && sent[sent.length - 2].data === encDistribute(), 'edit: with a balance waiting, two transactions go: a distribute, then the new list');
  ok((await bal(DEPLOYER)) - d1 === ETH / 10n && (await bal(SETTLE)) - s1 === ETH / 10n, 'edit: what waited went out under the old list (0.1 and 0.1)');
  const sh2 = await shares(addr);
  ok(sh2.weight.join() === '3,1', 'edit: and the list is now 3 : 1');

  // ── a problem in the list ──
  await until(() => /75%/.test(document.querySelector('#p-state')?.textContent || ''));          // the page has read the new list back and drawn it
  ok(/The list is changed/.test(await text('#p-edit .status')), 'edit: the result stays on screen after the panel is drawn again');
  const w3 = await page.$$('#p-edit .row input');
  await w3[0].fill('0x1234');
  await until(() => /is not an address/.test(document.querySelector('#p-edit .hint')?.textContent || ''));
  ok(await page.$eval('#p-edit .btn:not(.ghost)', (b) => b.disabled), 'edit: a bad address is named and the button is off');
  await w3[0].fill(DEPLOYER);

  // ── an account that is not the owner ──
  account = A1;
  await page.evaluate(() => { document.querySelector('#wallet-chip').click(); });
  await until(() => /7099/i.test(document.querySelector('#wallet-label').textContent));
  ok(!/owner/.test(await text('#wallet-label')), 'not the owner: the chip does not say owner');
  ok(await page.$eval('#p-edit .btn:not(.ghost)', (b) => b.disabled) && /Only the owner/.test(await text('#p-edit')), 'not the owner: the change button is off and the page says who can change it');
  await page.click('#p-edit details summary');
  await w3[1].fill('3');
  const batch = JSON.parse(await page.$eval('#p-edit textarea', (t) => t.value));
  ok(batch.chainId === '1' && batch.transactions.length === 1 && batch.transactions[0].to.toLowerCase() === addr && batch.transactions[0].data === encSetShares([DEPLOYER, SETTLE], [3n, 1n]), 'not the owner: the Safe batch carries the setShares call for the list on screen');
  await shot('edit');

  // ── a phone ──
  await page.setViewportSize({ width: 390, height: 900 });
  await sleep(200);
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: no sideways scroll');
  await shot('phone');

  // ── an address that is no splitter ──
  await page.fill('#addr-in', '0x000000000000000000000000000000000000dEaD');
  await page.click('#pick button');
  await until(() => /No splitter answers/.test(document.querySelector('#p-state')?.textContent || ''));
  ok(await page.$eval('#p-edit', (e) => e.hidden), 'open: an address with no splitter says so and shows no edit form');
  ok(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);
} catch (e) {
  fails++;
  console.log('FAIL', e.message.split('\n')[0]);
  await shot('failure').catch(() => {});
} finally {
  await browser.close();
  server.close();
  anvil.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
