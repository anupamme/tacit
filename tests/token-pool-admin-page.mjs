#!/usr/bin/env node
// The token pools' admin page (dapp/admin/token-pools/) in a real browser against a Base fork: a test wallet (EIP-6963, EIP-1193,
// sending from an impersonated account on the fork) connects, a kit is checked (gas and cost shown) and sent, the row reads open; a half-open
// kit (the pool alone) sends only its router; a kit whose addresses were changed is refused before any send. Each chain's catch-up hub
// (hub.json) is a row of its own: one whose address is not what CreateX makes is refused, and Base's is checked (its cost with Base's L1
// fee), sent and read as deployed.
// The page is served as it is but for two things the test needs: its kits.json reads Base from the fork, and its CSP lets it reach the fork.
//   node tests/token-pool-admin-page.mjs      (PLAYWRIGHT=<path to playwright-core>; SHOTS=<dir> saves a screenshot)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';

const WT = new URL('../', import.meta.url).pathname;
const require = createRequire(join(WT, 'worker-relay/package.json'));
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const { keccak_256 } = await import('@noble/hashes/sha3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (v) => '0x' + BigInt(v).toString(16);
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const post = async (url, method, params) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };

const APORT = 27100 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${APORT}`, HPORT = APORT + 400;
const USER = '0x00000000000000000000000000000000000ad41a';
const head = BigInt(await post('https://base.gateway.tenderly.co', 'eth_blockNumber', [])) - 2n;
const anvil = spawn('anvil', ['--port', String(APORT), '--fork-url', 'https://base.gateway.tenderly.co', '--fork-block-number', String(head), '--chain-id', '8453', '--silent', '--gas-limit', '300000000', '--no-rate-limit', '--block-time', '1'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) { try { await post(RPC, 'eth_chainId', []); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
await post(RPC, 'anvil_setBalance', [USER, hx(10n ** 18n)]);
await post(RPC, 'anvil_impersonateAccount', [USER]);

// the kits, Base read from the fork (served as they are when asked for, so a test can change one)
const kits = JSON.parse(readFileSync(join(WT, 'dapp/admin/token-pools/kits.json'), 'utf8'));
kits.chains[8453].rpc = [RPC];
const served = () => JSON.stringify(kits);
const hubs = JSON.parse(readFileSync(join(WT, 'dapp/admin/token-pools/hub.json'), 'utf8'));
const page0 = readFileSync(join(WT, 'dapp/admin/token-pools/index.html'), 'utf8').replace('connect-src \'self\'', `connect-src 'self' ${RPC}`);
const DAPP = join(WT, 'dapp');
const server = createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/admin/token-pools/' || p === '/admin/token-pools/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page0); }
  if (p === '/admin/token-pools/kits.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(served()); }
  if (p === '/admin/token-pools/hub.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(hubs)); }
  const f = join(DAPP, p);
  if (f.startsWith(DAPP) && existsSync(f) && !f.endsWith('/')) { res.writeHead(200, { 'content-type': { '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[extname(f)] || 'application/octet-stream' }); return res.end(readFileSync(f)); }
  res.writeHead(404); res.end();
}).listen(HPORT);

// the test wallet: announced over EIP-6963; its reads and sends go to the fork, from the impersonated account
const wallet = `(() => {
  let chain = 1; const listeners = {};
  const rpc = async (method, params) => { const j = await (await fetch(${JSON.stringify(RPC)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result; };
  window.__sent = [];
  const provider = {
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [${JSON.stringify(USER)}];
      if (method === 'eth_chainId') return '0x' + chain.toString(16);
      if (method === 'wallet_switchEthereumChain') { const c = Number(params[0].chainId); if (c !== 8453 && c !== 1) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 }); chain = c; (listeners.chainChanged || []).forEach((f) => f(params[0].chainId)); return null; }
      if (method === 'eth_sendTransaction') { if (chain !== 8453) throw new Error('the test wallet sends on Base only, and is on ' + chain); window.__sent.push(params[0]); return rpc(method, params); }
      return rpc(method, params);
    },
    on(e, f) { (listeners[e] ||= []).push(f); },
  };
  const info = { uuid: 'test-wallet', name: 'Test wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'test.wallet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(wallet);
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const URL_ = `http://127.0.0.1:${HPORT}/admin/token-pools/`;
await page.goto(URL_);
const rowOf = (chain, sym) => page.locator('tbody tr', { has: page.locator('td', { hasText: new RegExp(`^${chain}$`) }) }).filter({ has: page.locator('td.tok b', { hasText: new RegExp(`^${sym}$`) }) });
const textOf = async (chain, sym) => (await rowOf(chain, sym).innerText()).replace(/\s+/g, ' ');
const until = async (f, ms = 60000) => { const t = Date.now(); for (;;) { if (await f()) return true; if (Date.now() - t > ms) return false; await sleep(300); } };

const rowsWant = kits.kits.length + hubs.length;
ok(await until(async () => (await page.locator('tbody tr').count()) === rowsWant && (await page.locator('.st').count()) === rowsWant), `the page lists the ${hubs.length} hubs and ${kits.kits.length} kits, each with its state read from its chain`);
for (const k of kits.kits) ok(/not open/.test(await textOf(k.chain, k.sym)), `${k.chain} ${k.sym}: not open (${(await textOf(k.chain, k.sym)).slice(0, 90)})`);
const HUB = 'Catch-up hub', chainName = (id) => kits.chains[id].name;
const hubOnFork = async () => (await post(RPC, 'eth_getCode', [hubs.find((h) => h.chainId === 8453).expected, 'latest'])).length > 2;
const baseHubThere = await hubOnFork();
for (const h of hubs) {
  // Base from the fork, the others from their own nodes (a read: nothing is sent to them)
  const text = await textOf(chainName(h.chainId), HUB), live = (await post(h.chainId === 8453 ? RPC : kits.chains[h.chainId].rpc[0], 'eth_getCode', [h.expected, 'latest'])).length > 2;
  ok((live ? /deployed/.test(text) && !/not deployed/.test(text) : /not deployed/.test(text)) && text.includes(`${h.expected.slice(0, 6)}…${h.expected.slice(-4)}`), `${chainName(h.chainId)} hub: ${live ? 'deployed' : 'not deployed'}, as its chain says (${text.slice(0, 90)})`);
}
ok((await page.locator(`a[href="https://basescan.org/address/${hubs.find((h) => h.chainId === 8453).expected}"]`).count()) === 1, "the Base hub's address links to the explorer");
ok((await page.locator('a[href*="basescan.org/address/0xCAf6BE2e337AEcAB4a4eA183452f78800fD1616D"]').count()) === 1, "the Base USDC pool's address links to the explorer");
ok(errors.length === 0, `no errors on load (${errors.join(' | ').slice(0, 200)})`);

// a kit checked before a wallet is connected: run from a plain address, its gas and cost shown; then the wallet connects and sends it
await rowOf('Base', 'USDC').locator('button').click();
ok(await until(async () => /M gas · .*ETH/.test(await textOf('Base', 'USDC'))), `checked: ${await textOf('Base', 'USDC')}`);
ok((await rowOf('Base', 'USDC').locator('button').innerText()) === 'Send' && await rowOf('Base', 'USDC').locator('button').isDisabled(), 'Send waits for a wallet');
await page.click('#connect');
ok(await until(async () => /Test wallet · 0x0000…d41a · Ethereum/.test(await page.locator('#who').innerText())), `the wallet connects (${await page.locator('#who').innerText()})`);
ok(await page.evaluate(() => window.__sent.length) === 0, 'nothing is sent by connecting or checking');
await rowOf('Base', 'USDC').locator('button').click();
ok(await until(async () => /Open: the pool and router are where they should be/.test(await textOf('Base', 'USDC')), 90000), `sent and confirmed: ${await textOf('Base', 'USDC')}`);
const sent = await page.evaluate(() => window.__sent);
const usdc = kits.kits.find((k) => k.chainId === 8453 && k.sym === 'USDC');
ok(sent.length === 1 && sent[0].to.toLowerCase() === usdc.open.to.toLowerCase() && sent[0].data === usdc.open.data && BigInt(sent[0].gas) >= BigInt(usdc.open.gas), 'the wallet was sent exactly the kit, with at least its gas');
ok(/Base/.test(await page.locator('#who').innerText()) && /tx 0x/.test(await textOf('Base', 'USDC')) && (await post(RPC, 'eth_getCode', [usdc.router, 'latest'])).length > 2, 'the wallet was switched to Base, the hash links to the explorer, and the router is on the fork');

// half-open: the Base USDT pool put there alone, as CreateX's first step; the page then sends only the router
const usdt = kits.kits.find((k) => k.chainId === 8453 && k.sym === 'USDT');
const { makeTokenPools, TOKEN_POOL_CHAINS } = await import(join(WT, 'dapp/evm-pool-tokens.js'));
const tp = makeTokenPools({ code: JSON.parse(readFileSync(join(WT, 'dapp/evm-pool/token-pool-code.json'), 'utf8')), keccak256: keccak_256, chain: TOKEN_POOL_CHAINS[8453] });
const [step] = tp.deploySteps(usdt.token);
await post(RPC, 'eth_sendTransaction', [{ from: USER, to: step.to, data: step.data, gas: hx(2_000_000) }]);
await sleep(2500);
await page.reload();
ok(await until(async () => /pool only/.test(await textOf('Base', 'USDT'))), `with the pool alone there the row reads half-open (${await textOf('Base', 'USDT')})`);
await page.click('#connect').catch(() => {});
await until(async () => /Test wallet/.test(await page.locator('#who').innerText()));
await rowOf('Base', 'USDT').locator('button').click();
ok(await until(async () => (await rowOf('Base', 'USDT').locator('button').innerText()) === 'Send router'), `checked, it offers its router alone (${await textOf('Base', 'USDT')})`);
await rowOf('Base', 'USDT').locator('button').click();
ok(await until(async () => /Open: the pool and router/.test(await textOf('Base', 'USDT')), 90000), `and sends it: ${await textOf('Base', 'USDT')}`);
const sent2 = await page.evaluate(() => window.__sent);
ok(sent2.length === 1 && sent2[0].to.toLowerCase() === usdt.routerOnly.to.toLowerCase() && sent2[0].data === usdt.routerOnly.data, 'what was sent is the kit\'s router-only transaction');

// a kit whose addresses do not match what its transaction makes is refused, and nothing is sent
// (Base wstETH, not open here: its router's address changed in the kits the page reads)
kits.kits.find((k) => k.chainId === 8453 && k.sym === 'wstETH').router = '0x000000000000000000000000000000000000bEEF';
await page.reload();
await until(async () => /not open/.test(await textOf('Base', 'wstETH')));
await page.click('#connect').catch(() => {});
await until(async () => /Test wallet/.test(await page.locator('#who').innerText()));
await rowOf('Base', 'wstETH').locator('button').click();
ok(await until(async () => /it would create .* not the addresses shown/.test(await textOf('Base', 'wstETH'))), `a kit whose router was changed is refused: ${await textOf('Base', 'wstETH')}`);
ok((await rowOf('Base', 'wstETH').locator('button').innerText()) === 'Check' && (await page.evaluate(() => window.__sent.length)) === 0, 'it offers no Send, and nothing was sent');
// the catch-up hub on Base: an address CreateX would not make is refused before any send; then the hub is checked, with Base's L1 fee in
// its cost, and sent, and the row reads deployed
if (baseHubThere) console.log('  (the hub is on Base already, so its send is not run here)');
else {
  const baseHub = hubs.find((h) => h.chainId === 8453), right = baseHub.expected;
  baseHub.expected = '0x000000000000000000000000000000000000bEEF';
  await page.reload();
  await until(async () => /not deployed/.test(await textOf('Base', HUB)));
  await page.click('#connect').catch(() => {});
  await until(async () => /Test wallet/.test(await page.locator('#who').innerText()));
  await rowOf('Base', HUB).locator('button').click();
  ok(await until(async () => /it would create 0x[0-9a-f]{40}, not the addresses shown/i.test(await textOf('Base', HUB))), `a hub whose address was changed is refused: ${await textOf('Base', HUB)}`);
  ok((await rowOf('Base', HUB).locator('button').innerText()) === 'Check' && (await page.evaluate(() => window.__sent.length)) === 0, 'it offers no Send, and nothing was sent');
  baseHub.expected = right;
  const calls = [];
  page.on('request', (q) => { if (q.url().startsWith(RPC) && q.method() === 'POST') { try { calls.push(JSON.parse(q.postData())); } catch { /* not JSON */ } } });
  await page.reload();
  await until(async () => /not deployed/.test(await textOf('Base', HUB)));
  await page.click('#connect').catch(() => {});
  await until(async () => /Test wallet/.test(await page.locator('#who').innerText()));
  await rowOf('Base', HUB).locator('button').click();
  ok(await until(async () => /M gas · .*ETH/.test(await textOf('Base', HUB))), `checked: ${await textOf('Base', HUB)}`);
  const l1 = calls.find((c) => c.method === 'eth_call' && c.params?.[0]?.to?.toLowerCase() === '0x420000000000000000000000000000000000000f' && c.params[0].data.includes(baseHub.data.slice(2, 202)));
  ok(!!l1 && calls.some((c) => c.method === 'eth_estimateGas' && c.params?.[0]?.to?.toLowerCase() === baseHub.to.toLowerCase() && c.params[0].data === baseHub.data), "its check ran the deploy, estimated its gas and asked Base's oracle for the L1 fee on its bytes");
  ok((await rowOf('Base', HUB).locator('button').innerText()) === 'Send', 'and offers Send');
  await rowOf('Base', HUB).locator('button').click();
  ok(await until(async () => /Deployed: the hub is where it should be/.test(await textOf('Base', HUB)), 90000), `sent and confirmed: ${await textOf('Base', HUB)}`);
  const sentHub = await page.evaluate(() => window.__sent);
  ok(sentHub.length === 1 && sentHub[0].to.toLowerCase() === baseHub.to.toLowerCase() && sentHub[0].data === baseHub.data && BigInt(sentHub[0].gas) >= BigInt(baseHub.gas), "the wallet was sent exactly the hub's transaction, with at least its gas");
  ok(await hubOnFork() && /deployed/.test(await textOf('Base', HUB)) && (await rowOf('Base', HUB).locator('button').count()) === 0, 'the hub has code at its address on the fork, and the row offers nothing more');
  const sel = (sig) => '0x' + Buffer.from(keccak_256(sig)).toString('hex').slice(0, 8);
  const viaHub = BigInt(await post(RPC, 'eth_call', [{ to: right, data: sel('latest(address)') + '000000c2a20657ce25f2ba99737933d031afbee9'.padStart(64, '0') }, 'latest']));
  const viaReg = BigInt(await post(RPC, 'eth_call', [{ to: '0x00000000C3267616ED5E0DAA6F6490D109d6844D', data: sel('latest()') }, 'latest']));
  ok(viaHub === viaReg, `and it reads the ETH pool's newest point through from the registry (${viaHub} leaves)`);
}
// a phone's width: no page-wide scroll, the table scrolls in its card
await page.setViewportSize({ width: 390, height: 844 });
ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'at a phone width the page does not scroll sideways');
ok(errors.length === 0, `no errors (${errors.join(' | ').slice(0, 300)})`);
if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'token-pool-admin-page.png'), fullPage: true });

await browser.close(); server.close(); anvil.kill('SIGKILL');
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
