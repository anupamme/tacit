#!/usr/bin/env node
// tools/deploy-router/ in a real browser against an anvil fork of Ethereum mainnet (so CreateX and the two vaults are the real ones): the checks, the address and
// hash the page shows against the ones Foundry's script gives, then the deployment itself through a stub wallet, and the page's second look at what it deployed.
//   FORK_URL=https://ethereum-rpc.publicnode.com node tests/deploy-router-page.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const REPO = new URL('../', import.meta.url).pathname;
const FORK_URL = process.env.FORK_URL || 'https://ethereum-rpc.publicnode.com';
const PW = existsSync('/Users/z/zFi/node_modules/playwright-core') ? '/Users/z/zFi/node_modules/playwright-core' : 'playwright-core';
const { chromium } = createRequire(import.meta.url)(PW);
const PORT = 22000 + Math.floor(Math.random() * 900), WEB = PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
const EXPECT = { address: '0x21ce4fECbD2CFe0141317EE6d088f0704C37Eee1', hash: '0x50454a8e9106642aed979db84a63b45ac8c4bbc59da68a0853d5be88be72c28d' };   // from `forge script script/DeployTacVaultRouter.s.sol`

const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(PORT), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
let server, n = 0, fails = 0;
const finish = (code) => { anvil.kill('SIGKILL'); server?.close(); process.exit(code); };
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params = []) => { const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) { console.log('FAIL   the fork did not start'); finish(1); } await sleep(500); } }
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
server = http.createServer((req, res) => {
  const f = join(REPO, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = existsSync(f) && statSync(f).isDirectory() ? join(f, 'index.html') : f;
  if (!file.startsWith(REPO) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(WEB);

const [account] = await rpc('eth_accounts');
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  await ctx.route('https://ethereum-rpc.publicnode.com/**', async (route) => {
    const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }, body: await r.text() });
  });
  const sent = [];
  await ctx.exposeFunction('__chain', async (method, params) => { if (method === 'eth_sendTransaction') sent.push(params[0]); return rpc(method, params); });
  await ctx.addInitScript((acct) => { window.ethereum = { request: async ({ method, params }) => (method === 'eth_requestAccounts' || method === 'eth_accounts' ? [acct] : method === 'eth_chainId' ? '0x1' : window.__chain(method, params)) }; }, account);
  const open = async () => { const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); await p.goto(`http://127.0.0.1:${WEB}/tools/deploy-router/`); return { p, errs }; };
  const text = (p, sel) => p.evaluate((s) => (document.querySelector(s)?.textContent || '').trim(), sel);

  let { p, errs } = await open();
  await p.waitForFunction(() => document.querySelectorAll('#checklist .row').length >= 8, null, { timeout: 60000 });
  ok(await text(p, '#hash') === EXPECT.hash, 'the init code hash is the one Foundry gives');
  ok(await text(p, '#addr') === EXPECT.address, 'and so is the address it lands at');
  ok((await p.$$('#checklist .bad')).length === 0 && (await p.$$('#checklist .ok')).length >= 8, `every check passes (${(await p.$$('#checklist .ok')).length} ok)`);
  ok(await p.$eval('#deploy', (b) => b.disabled), 'deploying needs a wallet and the box ticked');
  await p.fill('#tail', '00');
  await sleep(300);
  ok((await text(p, '#addr')) === '—' && (await p.$eval('#deploy', (b) => b.disabled)), 'a salt that is not 11 bytes gives no address');
  await p.fill('#tail', '7461632d726f7574657231');
  await p.click('#connect');
  await p.check('#agree');
  await p.waitForFunction(() => !document.querySelector('#deploy').disabled, null, { timeout: 30000 });
  ok(true, 'with a wallet, the checks and the box, the button is ready');
  await p.click('#deploy');
  await p.waitForFunction(() => /Deployed and checked/.test(document.querySelector('#log')?.textContent || ''), null, { timeout: 120000 });
  ok(sent.length === 1 && sent[0].to.toLowerCase() === '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed' && sent[0].data.startsWith('0x26307668'), 'one transaction, to CreateX, deployCreate2');
  const code = await rpc('eth_getCode', [EXPECT.address, 'latest']);
  ok(code !== '0x' && code.length > 6000, `the router is at its address (${(code.length - 2) / 2} bytes of code)`);
  ok(/router: '0x21ce4fECbD2CFe0141317EE6d088f0704C37Eee1'/.test(await text(p, '#log')), 'and the page prints the line for deployments.js');
  ok(errs.length === 0, `no page errors (${errs.join(' | ')})`);
  await p.close();

  ({ p, errs } = await open());
  await p.waitForFunction(() => /already deployed/.test(document.querySelector('#checklist')?.textContent || ''), null, { timeout: 60000 });
  ok(/bound to these two vaults\s*ok/.test(await text(p, '#checklist')), 'looked at again, it is found, and found bound to the two vaults');
  await p.click('#connect'); await p.check('#agree'); await sleep(300);
  ok(await p.$eval('#deploy', (b) => b.disabled) && /Already deployed/.test(await text(p, '#deploy')), 'and cannot be deployed twice');
  ok(errs.length === 0, 'no page errors');
} catch (e) { fails++; console.log('FAIL   ' + (e.stack || e).toString().slice(0, 500)); }
await browser.close();
console.log(fails ? `${fails} failed, ${n} passed` : `${n} checks passed`);
finish(fails ? 1 : 0);
