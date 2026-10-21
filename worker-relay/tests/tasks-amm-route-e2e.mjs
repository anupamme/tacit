// The /tasks page for the amm-route job in a real browser, against an anvil mainnet fork: the page's own code sends the one step (TacitAmmRoute through
// CreateX) from a wallet that signs as an unlocked fork account, the contract lands at the address dapp/swap/route.js names, and the points service's own
// code (not a copy of it) verifies and credits the step.
//   anvil --fork-url <mainnet rpc> --port 8546 --chain-id 1 &
//   FORK_RPC=http://127.0.0.1:8546 node worker-relay/tests/tasks-amm-route-e2e.mjs      (Google Chrome; the job files built by scripts/tasks-amm-route.mjs)
// Nothing leaves the machine except the fork's own reads of mainnet.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { chromium } from 'playwright-core';
import { openStore } from '../src/lib/points-store.js';
import { createTasks } from '../src/lib/points-tasks-service.js';
import { checkJob } from '../src/lib/points-tasks.js';
import { TACIT_AMM, TACIT_AMM_ROUTE } from '../../dapp/swap/route.js';

const FORK = process.env.FORK_RPC;
if (!FORK) { console.log('skipped - set FORK_RPC to an anvil mainnet fork'); process.exit(0); }
const PORT = Number(process.env.PORT || 8790), SITE = `http://127.0.0.1:${PORT}`;
const TAC = 10n ** 18n, JOB = 'amm-route';
const rpc = async (method, params = []) => {
  const r = await (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
assert.ok(CHROME, 'a Chrome to drive');

const server = spawn('node', [new URL('../../tools/serve-dapp.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const dir = mkdtempSync(join(tmpdir(), 'tasks-amm-route-'));
const snap = await rpc('evm_snapshot');
let browser;
try {
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await rpc('eth_getCode', [TACIT_AMM_ROUTE, 'latest']), '0x', 'TacitAmmRoute is not on the fork yet');
  const [account] = await rpc('eth_accounts');
  const pageJob = JSON.parse(readFileSync(new URL('../../dapp/tasks/jobs.json', import.meta.url), 'utf8')).jobs.find((j) => j.id === JOB);
  const serviceJob = checkJob({ ...JSON.parse(readFileSync(new URL('../src/lib/points-tasks-jobs.json', import.meta.url), 'utf8')).jobs.find((j) => j.id === JOB), opensAt: 1 });
  const store = openStore(join(dir, 'points.db'));
  const client = createPublicClient({ chain: mainnet, transport: http(FORK) });
  const now = Number((await client.getBlock()).timestamp);
  for (const dt of [-7200, -3600, -600, 0, 600]) store.saveTaskQuote({ t: now + dt, venue: 'precision', tacPerEth: 10_000n * TAC, gasPrice: 66_000_000n }, 0);
  const tasks = createTasks({
    store, jobs: [serviceJob], client, log: () => {}, quote: async (a) => [{ venue: 'precision', amountIn: a, amountOut: a * 10_000n }],
    cfg: { budgetWei: 2_500n * TAC, endSec: 4_000_000_000, tipBps: 10_000n, floorWei: 150n * TAC, capWei: 2_500n * TAC, reserveDays: 2, sampleEverySecs: 1 << 30 },
    budgetFor: () => 1111n * TAC, graceSecs: 1800, fundingInputs: async () => ({ heldWei: 50_000n * TAC, claimedWei: 0n, nextDay: 20_000 }),
  });

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const json = (body, status = 200) => ({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let open = false, tamper = false;
  const payloadFile = JSON.parse(readFileSync(new URL(`../../dapp/tasks/${JOB}-payload.json`, import.meta.url), 'utf8'));
  await ctx.route('https://tacit-points.onrender.com/**', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/tasks') return route.fulfill(json(tasks.view({ address: url.searchParams.get('address') })));
    if (url.pathname === '/tasks/claim') { const r = await tasks.claim(JSON.parse(req.postData()), { client: 'page' }); return route.fulfill(json(r.body, r.status)); }
    return route.fulfill(json({ error: 'not here' }, 404));
  });
  for (const host of ['https://ethereum-rpc.publicnode.com/**', 'https://eth.drpc.org/**', 'https://1rpc.io/**', 'https://mainnet.gateway.tenderly.co/**']) {
    await ctx.route(host, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.postData() });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: await r.text() });
    });
  }
  await ctx.route(/^(wss|https):\/\/(relay|verify)\.walletconnect\.(org|com)/, (route) => route.abort());
  await ctx.route(`${SITE}/tasks/jobs.json`, (route) => route.fulfill(json({ jobs: [{ ...pageJob, opensAt: open ? 1 : 0 }] })));
  // A payload carrying other code than the job names: one hex digit of its init code is changed.
  await ctx.route(`${SITE}/tasks/${JOB}-payload.json`, (route) => {
    if (!tamper) return route.fulfill(json(payloadFile));
    const steps = payloadFile.steps.map((x) => ({ ...x, data: `${x.data.slice(0, 600)}${x.data[600] === '0' ? '1' : '0'}${x.data.slice(601)}` }));
    return route.fulfill(json({ ...payloadFile, steps }));
  });
  await ctx.exposeFunction('__fork', (method, params) => rpc(method, params));
  await ctx.addInitScript((acct) => {
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_sendTransaction') return window.__fork('eth_sendTransaction', params);
      throw Object.assign(new Error(`unsupported ${method}`), { code: -32601 });
    }, on() {}, removeListener() {} };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test-wallet', name: 'Test wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'test.wallet' }, provider } }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  }, account);

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  const text = () => page.locator('main').innerText();
  const GO = '[data-go]', JOBS = '#jobs';
  const connectIfNeeded = async () => {
    if (/Send the step/.test(await page.locator(GO).innerText())) return;
    await page.locator(GO).click();
    await page.waitForTimeout(600);
    if (await page.locator('.picker .way').count()) await page.locator('.picker .way', { hasText: 'Test wallet' }).click();
    await page.waitForFunction(() => /Send the step/.test(document.querySelector('[data-go]')?.textContent || ''), null, { timeout: 15000 });
  };

  // 1. The job exists but its rewards are not open: the page says so and sends nothing.
  await page.goto(`${SITE}/tasks/`);
  await page.waitForSelector('.job-head');
  assert.match(await text(), /Opens soon/);
  assert.equal(await page.locator(GO).isDisabled(), true, 'nothing is sent while the job is closed');
  assert.match(await page.locator(JOBS).innerText(), /0 of 1 step on the chain/);
  console.log('ok - a job that is not open shows as closed and cannot be sent');

  // 2. Open, but the transaction is not the plan's: the page refuses to send it.
  open = true; tamper = true;
  const before = await rpc('eth_blockNumber');
  await page.reload();
  await page.waitForSelector('.job-head');
  await page.waitForFunction(() => /Open/.test(document.querySelector('.pill')?.textContent || ''));
  await connectIfNeeded();
  await page.locator(GO).click();
  await page.waitForFunction(() => /does not match the plan/.test(document.querySelector('.status')?.textContent || ''), null, { timeout: 30000 });
  assert.equal(await rpc('eth_blockNumber'), before, 'nothing was sent');
  assert.match(await page.locator(JOBS).innerText(), /deploys other code than the plan/);
  console.log('ok - a payload that differs from the plan by one digit is refused before anything is sent');

  // 3. The real payload: the page connects the wallet and sends the step, and the contract is where the swap page looks for it.
  tamper = false;
  await page.reload();
  await page.waitForSelector('.job-head');
  await page.waitForFunction(() => /Open/.test(document.querySelector('.pill')?.textContent || ''));
  await connectIfNeeded();
  await page.locator(GO).click();
  await page.waitForFunction(() => /Everything is sent/.test(document.querySelector('.status')?.textContent || ''), null, { timeout: 120000 });
  assert.notEqual(await rpc('eth_getCode', [TACIT_AMM_ROUTE, 'latest']), '0x', 'code at the address the swap page names');
  const amm = await rpc('eth_call', [{ to: TACIT_AMM_ROUTE, data: '0x44a70686' }, 'latest']);
  assert.equal(`0x${amm.slice(-40)}`, TACIT_AMM.toLowerCase(), 'wired to TacitPublicAmm');
  assert.match(await page.locator(JOBS).innerText(), /1 of 1 step on the chain/);
  console.log('ok - the page verified the plan and sent the step; TacitAmmRoute is where the swap page looks for it');

  // 4. Twelve confirmations later the page names the step to the service, which credits it on its next cycle.
  await rpc('anvil_mine', ['0x14']);
  await page.reload();
  await page.waitForSelector('.job-head');
  await page.waitForFunction(() => document.querySelector('#jobs')?.innerText.includes('1 of 1 step on the chain'));
  await page.waitForTimeout(2500);
  assert.equal(store.pendingTaskClaims().length, 1, 'the step is recorded as a claim');
  await tasks.cycle();
  const credited = store.creditedWithPrefix('task:');
  assert.equal(credited, 30n * TAC, `at a cheap gas price the step pays its least, the effort (${Number(credited) / 1e18} TAC)`);
  assert.equal(store.rewardFor(account), String(credited), 'the sender is credited');

  // 5. A job that is done is a tile with its result, which opens to the transaction.
  await page.reload();
  await page.waitForSelector('.job-head');
  await page.waitForFunction(() => /Done/.test(document.querySelector('.pill')?.textContent || ''), null, { timeout: 30000 });
  await page.locator('.job-head').click();
  assert.equal(await page.locator('.job-body a[href*="/tx/"]').count(), 1, 'the step links to its transaction');
  assert.equal(await page.locator(GO).count(), 0, 'a done job has nothing left to send');
  console.log(`ok - the service credited ${Number(credited) / 1e18} TAC to the sender; the done job opens to its transaction`);

  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  console.log('ok - no errors on the page');
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await rpc('evm_revert', [snap]).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
