// The /tasks page in a real browser, against an anvil mainnet fork: the page's own code sends the TAC vault package's twenty-one steps through a
// wallet (a stand-in that signs as an unlocked fork account), and the points service's own code (not a copy of it) verifies and credits each one.
//   anvil --fork-url <mainnet rpc> --port 8546 --chain-id 1 &
//   FORK_RPC=http://127.0.0.1:8546 node worker-relay/tests/tasks-page-e2e.mjs
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

const FORK = process.env.FORK_RPC;
if (!FORK) { console.log('skipped - set FORK_RPC to an anvil mainnet fork'); process.exit(0); }
const PORT = Number(process.env.PORT || 8788), SITE = `http://127.0.0.1:${PORT}`;
const TAC = 10n ** 18n;
const rpc = async (method, params = []) => {
  const r = await (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
assert.ok(CHROME, 'a Chrome to drive');

const server = spawn('node', [new URL('../../tools/serve-dapp.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const dir = mkdtempSync(join(tmpdir(), 'tasks-e2e-'));
const snap = await rpc('evm_snapshot');
let browser;
try {
  await new Promise((r) => setTimeout(r, 800));
  const [account] = await rpc('eth_accounts');
  const pageJobs = JSON.parse(readFileSync(new URL('../../dapp/tasks/jobs.json', import.meta.url), 'utf8'));
  const serviceJob = checkJob({ ...JSON.parse(readFileSync(new URL('../src/lib/points-tasks-jobs.json', import.meta.url), 'utf8')).jobs[0], opensAt: 1 });
  const store = openStore(join(dir, 'points.db'));
  const client = createPublicClient({ chain: mainnet, transport: http(FORK) });
  const now = Math.floor(Date.now() / 1000);
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
  let jobsOpen = false, tamper = false;
  const payloadFile = JSON.parse(readFileSync(new URL('../../dapp/tasks/tac-vaults-payload.json', import.meta.url), 'utf8'));
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
  await ctx.route(`${SITE}/tasks/jobs.json`, (route) => route.fulfill(json({ jobs: pageJobs.jobs.map((j) => ({ ...j, opensAt: jobsOpen ? 1 : 0 })) })));
  // A payload whose first step carries other code than the job names: one hex digit of its init code is changed.
  await ctx.route(`${SITE}/tasks/tac-vaults-payload.json`, (route) => {
    if (!tamper) return route.fulfill(json(payloadFile));
    const steps = payloadFile.steps.map((x, i) => (i ? x : { ...x, data: `${x.data.slice(0, 600)}${x.data[600] === '0' ? '1' : '0'}${x.data.slice(601)}` }));
    return route.fulfill(json({ ...payloadFile, steps }));
  });
  // A wallet that signs as the fork's first account: it announces itself as EIP-6963 wallets do, and forwards what the page asks.
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

  // 1. The job exists but its rewards are not open: the page says so and sends nothing.
  await page.goto(`${SITE}/tasks/`);
  await page.waitForSelector('.tile');
  assert.match(await text(), /Opens soon/);
  assert.equal(await page.locator('#go').isDisabled(), true, 'nothing is sent while the job is closed');
  assert.match(await page.locator('#job').innerText(), /0 of 21 on the chain/);
  console.log('ok - a job that is not open shows as closed and cannot be sent');

  // 2. Open, but the transactions are not the plan's: the page refuses to send anything.
  jobsOpen = true; tamper = true;
  const before = await rpc('eth_blockNumber');
  await page.reload();
  await page.waitForSelector('.tile');
  await page.waitForFunction(() => /Open/.test(document.querySelector('.pill')?.textContent || ''));
  await page.locator('#go').click();
  await page.waitForTimeout(600);
  if (await page.locator('.picker .way').count()) await page.locator('.picker .way', { hasText: 'Test wallet' }).click();
  await page.waitForFunction(() => /Send all 21 steps/.test(document.querySelector('#go')?.textContent || ''), null, { timeout: 15000 });
  await page.locator('#go').click();
  await page.waitForFunction(() => /does not match the plan/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 30000 });
  assert.equal(await rpc('eth_blockNumber'), before, 'nothing was sent');
  assert.match(await page.locator('#job').innerText(), /deploys other code than the plan/);
  console.log('ok - a payload that differs from the plan by one digit is refused before anything is sent');

  // 3. The real payload: the page connects the wallet and sends every step.
  tamper = false;
  await page.reload();
  if (process.env.SHOTS) {                                                 // pictures of the open page, before anything is sent
    await page.waitForSelector('.tile');
    await page.waitForFunction(() => /Open/.test(document.querySelector('.pill')?.textContent || ''));
    await page.waitForTimeout(1500);
    for (const [name, scheme, vp] of [['light', 'light', [1280, 900]], ['dark', 'dark', [1280, 900]], ['mobile', 'light', [390, 844]]]) {
      await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width: vp[0], height: vp[1] });
      await page.screenshot({ path: `${process.env.SHOTS}/open-${name}.png`, fullPage: name !== 'mobile' });
    }
    await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.waitForSelector('.tile');
  await page.waitForFunction(() => /Open/.test(document.querySelector('.pill')?.textContent || ''));
  assert.match(await page.locator('#job').innerText(), /Send all 21 steps|Connect wallet/);
  if (!/Send all 21 steps/.test(await page.locator('#go').innerText())) {                 // the wallet stays connected across the reload when it allows the site
    await page.locator('#go').click();
    await page.waitForTimeout(600);
    if (await page.locator('.picker .way').count()) await page.locator('.picker .way', { hasText: 'Test wallet' }).click();
    await page.waitForFunction(() => /Send all 21 steps/.test(document.querySelector('#go')?.textContent || ''), null, { timeout: 15000 });
  }
  await page.locator('#go').click();                                       // send
  await page.waitForFunction(() => /Everything is sent/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 240000 });
  const afterSend = await page.locator('#job').innerText();
  assert.match(afterSend, /21 of 21 on the chain/);
  assert.match(afterSend, /Everything is sent/);
  console.log('ok - the page verified the plan and sent all 21 steps through the wallet');

  // 4. Twelve confirmations later the page names the steps to the service, which credits them on its next cycle.
  await rpc('anvil_mine', ['0x14']);
  await page.reload();
  await page.waitForSelector('.tile');
  await page.waitForFunction(() => document.querySelector('#job')?.innerText.includes('21 of 21 on the chain'));
  await page.waitForTimeout(2500);
  const queued = store.pendingTaskClaims().length;
  assert.equal(queued, 21, 'all 21 steps are recorded as claims');
  await tasks.cycle();
  const credited = store.creditedWithPrefix('task:');
  assert.ok(credited > 0n && store.rewardFor(account) === String(credited), 'the sender is credited for every step');
  await page.reload();
  await page.waitForSelector('.tile');
  await page.waitForFunction(() => (document.querySelector('#job')?.innerText.match(/Credited/g) || []).length >= 21, null, { timeout: 30000 });
  assert.match(await page.locator('#job').innerText(), /Credited/);
  console.log(`ok - the service credited ${Number(credited) / 1e18} TAC to the sender, and the page shows all 21 steps credited`);

  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  await page.screenshot({ path: process.env.SHOT || join(dir, 'tasks.png'), fullPage: true });
  console.log('ok - no errors on the page');
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await rpc('evm_revert', [snap]).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
