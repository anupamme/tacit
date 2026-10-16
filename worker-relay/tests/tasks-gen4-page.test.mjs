// The /tasks page for the anon-wei-4 job in a real browser, with no chain behind it but a small model of what each step leaves
// there: the page reads each chain through its own nodes, asks a wallet to switch to (or add) the chain of each step, sends the
// plan's transactions in order, fetches the first points from the chain's keeper when it sends them, and names each transaction
// to the points service on its own chain. The wallet is a stand-in that knows Ethereum and Base and has never seen the others.
//   node worker-relay/tests/tasks-gen4-page.test.mjs      (Google Chrome; the job files built by scripts/tasks-gen4.mjs)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { chromium } from 'playwright-core';
import { openStore } from '../src/lib/points-store.js';
import { createTasks } from '../src/lib/points-tasks-service.js';
import { checkJob } from '../src/lib/points-tasks.js';

const PORT = Number(process.env.PORT || 8789), SITE = `http://127.0.0.1:${PORT}`;
const TAC = 10n ** 18n, GWEI = 10n ** 9n;
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
assert.ok(CHROME, 'a Chrome to drive');
const root = new URL('../../', import.meta.url);
const pageJobs = JSON.parse(readFileSync(new URL('dapp/tasks/jobs.json', root), 'utf8')).jobs.find((j) => j.id === 'anon-wei-4');
const serviceJob = checkJob(JSON.parse(readFileSync(new URL('worker-relay/src/lib/points-tasks-jobs.json', root), 'utf8')).jobs.find((j) => j.id === 'anon-wei-4'));
const payload = JSON.parse(readFileSync(new URL('dapp/tasks/anon-wei-4-payload.json', root), 'utf8'));
const chainOf = (s) => s.chainId ?? 1;
const REG = serviceJob.steps.find((s) => s.kind === 'post').to;
const NAMES = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood Chain', 4326: 'MegaETH' };

const server = spawn('node', [new URL('../../tools/serve-dapp.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const dir = mkdtempSync(join(tmpdir(), 'tasks-gen4-page-'));
let browser;
try {
  await new Promise((r) => setTimeout(r, 800));
  // What is on each chain: the code at the planned addresses, and the registry's newest point.
  const code = new Set(), latest = new Map(), receipts = new Map(), sent = [], switched = [], added = [], claims = [];
  let n = 0;
  const NOW = Math.floor(Date.now() / 1000);
  const quoteStore = openStore(join(dir, 'points.db'));
  for (const dt of [-7200, -3600, -600, 0, 600]) quoteStore.saveTaskQuote({ t: NOW + dt, venue: 'precision', tacPerEth: 9_772n * TAC, gasPrice: 120n * 10n ** 6n }, 0);
  const stub = (id) => ({ getChainId: async () => id, getBlock: async () => ({ timestamp: BigInt(NOW), baseFeePerGas: 5_000n, transactions: [] }), getBlockNumber: async () => 10_000n,
    getTransaction: async ({ hash }) => { const r = receipts.get(hash); if (!r) throw new Error('not found'); return { from: r.from, to: r.to, input: r.input }; },
    getTransactionReceipt: async ({ hash }) => { const r = receipts.get(hash); if (!r || r.chain !== id) throw new Error('not found'); return { status: 'success', blockNumber: 100n, logs: r.logs }; } });
  const tasks = createTasks({
    store: quoteStore, jobs: [{ ...serviceJob, opensAt: 1 }], client: stub(1), clients: { 8453: stub(8453), 4663: stub(4663), 4326: stub(4326) }, log: () => {}, quote: async (a) => [{ venue: 'precision', amountIn: a, amountOut: a * 9_772n }],
    cfg: { budgetWei: 5_000n * TAC, endSec: 4_000_000_000, tipBps: 10_000n, floorWei: 150n * TAC, capWei: 2_500n * TAC, reserveDays: 2, sampleEverySecs: 1 << 30,
      chains: Object.fromEntries([8453, 4663, 4326].map((id) => [id, { confirmations: 1, minAgeSecs: 0, gas: { floor: 1000n, cap: 2n * GWEI } }])) },
    budgetFor: () => 1111n * TAC, graceSecs: 1800, fundingInputs: async () => ({ heldWei: 50_000n * TAC, claimedWei: 0n, nextDay: 20_000 }),
  });
  await tasks.cycle().catch(() => {});

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const json = (body, status = 200) => ({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const CX = '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed', CONTRACT_CREATION = keccak256(new TextEncoder().encode('ContractCreation(address,bytes32)')), POSTED = keccak256(new TextEncoder().encode('Posted(uint256,uint256,address)'));
  await ctx.route('https://tacit-points.onrender.com/**', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/tasks') return route.fulfill(json(tasks.view({ address: url.searchParams.get('address') })));
    if (url.pathname === '/tasks/claim') { const body = JSON.parse(req.postData()); claims.push(body); const r = await tasks.claim(body, { client: 'page' }); return route.fulfill(json(r.body, r.status)); }
    return route.fulfill(json({ error: 'not here' }, 404));
  });
  const HOSTS = { 1: ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co'], 8453: ['mainnet.base.org', 'base.gateway.tenderly.co', 'base-rpc.publicnode.com', 'base.drpc.org'], 4663: ['rpc.mainnet.chain.robinhood.com', 'robinhood.drpc.org'], 4326: ['mainnet.megaeth.com', 'megaeth.drpc.org'] };
  const seen = { defaults: { 1: 0, 8453: 0, 4663: 0, 4326: 0 }, custom: 0, batches: 0 };
  const serve = (id, label) => async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const one = (b) => {
      let result = null;
      if (b.method === 'eth_getCode') result = code.has(`${id}:${b.params[0].toLowerCase()}`) ? '0x6001' : '0x';
      else if (b.method === 'eth_call') result = b.params[0].data === '0x52bfe789' ? `0x${BigInt(latest.get(Number(id)) ?? 0).toString(16).padStart(64, '0')}` : '0x';
      else if (b.method === 'eth_getTransactionReceipt') result = receipts.has(b.params[0]) ? { status: '0x1', transactionHash: b.params[0], blockNumber: '0x64' } : null;
      else if (b.method === 'eth_blockNumber') result = '0x2710';
      else if (b.method === 'eth_chainId') result = `0x${Number(id).toString(16)}`;
      return { jsonrpc: '2.0', id: b.id, result };
    };
    const body = JSON.parse(req.postData() || '{}');
    if (label === 'default') seen.defaults[id]++; else if (label === 'custom') { seen.custom++; if (Array.isArray(body)) seen.batches++; }
    return route.fulfill(json(Array.isArray(body) ? body.map(one) : one(body)));
  };
  for (const [id, hosts] of Object.entries(HOSTS)) for (const h of hosts) await ctx.route(`https://${h}/**`, serve(Number(id), 'default'));
  await ctx.route('https://my-base.example/**', serve(8453, 'custom'));
  await ctx.route('https://wrong-chain.example/**', serve(1, 'wrong'));
  // The chain's keeper hands out the first point; its size is what the pool has (25,480 on Base, 2,340 on Robinhood Chain).
  await ctx.route('https://tacit-evm-pool-keepers.onrender.com/**', async (route) => {
    const m = /^\/(\d+)\/evm-pool\/keeper\/point$/.exec(new URL(route.request().url()).pathname);
    if (!m) return route.fulfill(json({ error: 'not here' }, 404));
    const size = Number(m[1]) === 8453 ? 25_480 : 2_340, word = (v) => BigInt(v).toString(16).padStart(64, '0');
    const data = `0x${keccak256(new TextEncoder().encode('post(uint256,uint256,bytes32[32])')).slice(2, 10)}${word(size)}${word(777)}${Array.from({ length: 32 }, (_, i) => word(i + 1)).join('')}`;
    return route.fulfill(json({ chainId: Number(m[1]), pool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', registry: REG, size, block: 777, filled: [], data }));
  });
  await ctx.route(/^(wss|https):\/\/(relay|verify)\.walletconnect\.(org|com)/, (route) => route.abort());
  await ctx.route(`${SITE}/tasks/jobs.json`, (route) => route.fulfill(json({ jobs: [{ ...pageJobs, opensAt: 1 }] })));
  // The wallet: Ethereum and Base are known; asked for another chain it says so until that chain is added.
  await ctx.exposeFunction('__chain', (method, params) => {
    if (method === 'switch') { switched.push(params); return params; }
    if (method === 'add') { added.push(params); return params; }
    if (method === 'send') {
      const [tx, chainId] = [params.tx, params.chainId];
      const hash = `0x${(++n).toString(16).padStart(64, '0')}`;
      sent.push({ chainId, to: tx.to, data: tx.data });
      const step = serviceJob.steps.find((s) => chainOf(s) === chainId && (s.kind === 'post' ? tx.to.toLowerCase() === s.to.toLowerCase() : tx.data === payload.steps[serviceJob.steps.indexOf(s)].data));
      assert.ok(step, `a transaction of the plan on chain ${chainId}`);
      const logs = [];
      if (step.kind === 'createx') {
        code.add(`${chainId}:${step.expected.toLowerCase()}`);
        const salt = step.bound === false ? keccak256(step.salt) : keccak256(`0x${BigInt(chainId).toString(16).padStart(64, '0')}${step.salt.slice(2)}`);
        logs.push({ address: CX, topics: [CONTRACT_CREATION, `0x${'0'.repeat(24)}${step.expected.slice(2).toLowerCase()}`, salt], logIndex: 0 });
      } else if (step.kind === 'post') {
        const size = BigInt(`0x${tx.data.slice(10, 74)}`);
        latest.set(chainId, size);
        logs.push({ address: step.to, topics: [POSTED, `0x${size.toString(16).padStart(64, '0')}`, `0x${'0'.repeat(64)}`], logIndex: 0 });
      }
      receipts.set(hash, { chain: chainId, from: '0x00000000000000000000000000000000000000aa', to: tx.to, input: tx.data, logs });
      return hash;
    }
    throw new Error('unknown');
  });
  await ctx.addInitScript(() => {
    let chain = '0x1';
    const known = new Set(['0x1', '0x2105']);
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x00000000000000000000000000000000000000aa'];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') {
        if (!known.has(params[0].chainId)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
        chain = params[0].chainId; await window.__chain('switch', params[0].chainId); return null;
      }
      if (method === 'wallet_addEthereumChain') { known.add(params[0].chainId); await window.__chain('add', params[0]); return null; }
      if (method === 'eth_sendTransaction') return window.__chain('send', { tx: params[0], chainId: parseInt(chain, 16) });
      throw Object.assign(new Error(`unsupported ${method}`), { code: -32601 });
    }, on() {}, removeListener() {} };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test-wallet', name: 'Test wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'test.wallet' }, provider } }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  const total = serviceJob.steps.length;
  await page.goto(`${SITE}/tasks/`);
  await page.waitForSelector('.job-head');
  await page.waitForFunction(() => /Open/.test(document.querySelector('.pill')?.textContent || ''));
  const text = () => page.locator('main').innerText();
  const body = await text();
  assert.match(body, /PAGE CHUNKS/i); assert.match(body, /CATCH-UP REGISTRY/i); assert.match(body, /FIRST POINTS/i);
  assert.match(body, /Base · /); assert.match(body, /Robinhood Chain · /); assert.match(body, /MegaETH · /);
  assert.match(body, new RegExp(`0 of ${total} steps on the chain`));
  assert.match(body, /at least 8 TAC a step/, 'the rewards panel says what a chunk pays at least');
  console.log(`ok - the job shows ${total} steps in three groups, each on its chain, none on the chain yet`);
  if (process.env.SHOTS) { await page.screenshot({ path: `${process.env.SHOTS}/gen4-open.png`, fullPage: true }); await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.p-steps').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOTS}/gen4-steps-mobile.png` }); await page.locator('.p-mine').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOTS}/gen4-mine-mobile.png` }); await page.setViewportSize({ width: 1280, height: 900 }); }

  // The reader's own node for Base: refused when it is on another chain, then taken; Base is read through it alone, in batches.
  await page.locator('#ends > summary').click();
  await page.fill('#e-rpc-8453', 'https://wrong-chain.example/rpc');
  await page.locator('#ends form button[type="submit"]').click();
  await page.waitForFunction(() => /is on chain 1, not Base/.test(document.querySelector('#ends-say')?.textContent || ''), null, { timeout: 15000 });
  await page.fill('#e-rpc-8453', 'https://my-base.example/rpc');
  const before = seen.defaults[8453];
  await page.locator('#ends form button[type="submit"]').click();
  await page.waitForFunction(() => /^Saved/.test(document.querySelector('#ends-say')?.textContent || ''), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#ends > summary')?.textContent === 'Endpoints: yours');
  for (let i = 0; i < 40 && !seen.custom; i++) await page.waitForTimeout(250);
  assert.ok(seen.custom > 0 && seen.batches > 0, `Base is read through the reader's node, in batches (${seen.custom} reads, ${seen.batches} batches)`);
  assert.equal(seen.defaults[8453], before, 'and no longer through the page\'s nodes');
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('tacit.tasks.endpoints.v1')).rpc[8453][0]) === 'https://my-base.example/rpc', 'kept in this browser');
  console.log('ok - the reader\'s own node is checked for its chain, then used alone for that chain, in batches');

  // Connect (the stand-in wallet announces itself), then send everything.
  const GO = '[data-go]';
  await page.locator(GO).click();
  await page.waitForTimeout(600);
  if (await page.locator('.picker .way').count()) await page.locator('.picker .way', { hasText: 'Test wallet' }).click();
  await page.waitForFunction((t) => new RegExp(`Send all ${t} steps`).test(document.querySelector('[data-go]')?.textContent || ''), total, { timeout: 15000 });
  // Someone sends one chunk only, from its own button: the rest is left to others, and each is paid to whoever sends it.
  const one = serviceJob.steps.find((x) => x.id.includes('-chunk-5'));
  await page.locator(`[data-one="${one.id}"]`).click();
  await page.waitForFunction(() => /Sent\. The step is named/.test(document.querySelector('.status')?.textContent || ''), null, { timeout: 60000 });
  assert.equal(sent.length, 1, 'only that step was sent');
  assert.equal(await page.locator(`[data-one="${one.id}"]`).count(), 0, 'and it has no button now');
  assert.ok(await page.locator('[data-one]').count() >= total - 1 - 1, 'the others still have theirs');
  // A point cannot go before the registry it is posted to.
  await page.locator(`[data-one="${serviceJob.steps.find((x) => x.kind === 'post').id}"]`).click();
  await page.waitForFunction(() => /is not on the chain yet: send its step first/.test(document.querySelector('.status')?.textContent || ''), null, { timeout: 30000 });
  assert.equal(sent.length, 1, 'nothing was sent for the point');
  console.log('ok - one step can be sent alone and paid to its sender, and a point waits for its registry');
  await page.locator(GO).click();
  await page.waitForFunction(() => /Everything is sent/.test(document.querySelector('.status')?.textContent || ''), null, { timeout: 120000 })
    .catch(async (e) => { console.log(`# stuck after ${sent.length} of ${total}: ${(await page.locator('.status').first().innerText()).slice(0, 300)} | switched ${switched.join()} added ${added.map((x) => x.chainName).join()} | errors ${errors.join(' | ').slice(0, 300)}`); throw e; });
  assert.equal(sent.length, total, `every step was sent (${sent.length} of ${total})`);
  const order = serviceJob.steps.filter((x) => x.id !== one.id).map(chainOf);
  assert.deepEqual(sent.map((s) => s.chainId), [chainOf(one), ...order], 'the lone chunk first, then the rest in the plan\'s order, each on its own chain');
  assert.ok(added.some((a) => a.chainName === 'Robinhood Chain') && added.some((a) => a.chainName === 'MegaETH'), 'the wallet was asked to add the chains it had never seen');
  assert.ok(!added.some((a) => a.chainName === 'Base'), 'and not those it knew');
  assert.ok(added.every((x) => /\/chain-icons\/\d+\.svg$/.test(x.iconUrls?.[0] || '')), 'each added chain comes with a picture of ours, for a wallet that has none');
  assert.ok(sent.filter((s) => s.data.slice(0, 10) === `0x${keccak256(new TextEncoder().encode('post(uint256,uint256,bytes32[32])')).slice(2, 10)}`).length === 2, 'two points, read from the keepers');
  console.log(`ok - the page sent all ${total} steps on four chains, adding the two chains the wallet did not have, and read both points from the keepers`);

  // Each transaction is named to the service on its own chain, and credited.
  await page.waitForFunction(() => document.querySelector('#jobs')?.innerText.includes('steps on the chain'), null, { timeout: 15000 });
  await page.waitForTimeout(25000);
  assert.deepEqual([...new Set(claims.map((c) => c.chainId ?? 1))].sort((a, b) => a - b), [1, 4326, 4663, 8453], 'claims are named per chain');
  const pending = quoteStore.pendingTaskClaims().length;
  assert.equal(pending, total, `all ${total} steps are recorded as claims (${pending})`);
  await tasks.cycle();
  assert.ok(quoteStore.creditedWithPrefix('task:') > 0n);
  console.log(`ok - ${pending} claims, on four chains, credited ${Number(quoteStore.creditedWithPrefix('task:')) / 1e18} TAC`);
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  console.log('ok - no errors on the page');
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
