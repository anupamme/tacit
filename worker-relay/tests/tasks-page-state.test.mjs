// The /tasks page's reading of what is done, in a real browser, with the chain's nodes and the rewards service stubbed so that every request is counted:
// a step the service has claimed is shown done with no read of the chain (a visit used to download the code of every deployed contract), a step it has not is
// read from the chain, finished jobs list the newest first, a done job nobody has claimed says so, a service that does not answer does not hold the page, and
// none of it moves the page.
//   node worker-relay/tests/tasks-page-state.test.mjs      (Google Chrome)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.PORT || 8791), SITE = `http://127.0.0.1:${PORT}`;
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
assert.ok(CHROME, 'a Chrome to drive');
const TAC = 10n ** 18n, NOW = Math.floor(Date.now() / 1000);
const all = JSON.parse(readFileSync(new URL('../../dapp/tasks/jobs.json', import.meta.url), 'utf8')).jobs;
const jobs = ['tac-vaults', 'amm-route-v1', 'amm-route'].map((id) => ({ ...all.find((j) => j.id === id), opensAt: { 'tac-vaults': NOW - 9e5, 'amm-route-v1': NOW - 5e4, 'amm-route': NOW - 4e4 }[id] }));
const claim = (s, who) => ({ address: who, wei: String(30n * TAC), txHash: `0x${'ab'.repeat(32)}`, state: 'credited' });
const view = (claimed) => ({
  enabled: true, endSec: NOW + 1e6, budget: { totalWei: String(1150n * TAC), creditedWei: String(420n * TAC), pendingWei: '0', remainingWei: String(730n * TAC) }, terms: { tipBps: '10000', floorWei: String(150n * TAC), capWei: String(2500n * TAC) }, quote: null,
  jobs: jobs.map((j) => ({ id: j.id, estimateWei: String(30n * TAC), steps: j.steps.map((s) => ({ id: s.id, chainId: 1, estimateWei: String(TAC), claim: claimed.has(j.id) ? claim(s, '0x1307143d6cff54b2c6daf7d5619420f78e364bad') : null })) })),
  claims: jobs.filter((j) => claimed.has(j.id)).flatMap((j) => j.steps.map((s) => ({ job: j.id, step: s.id, ...claim(s, '0x1307143d6cff54b2c6daf7d5619420f78e364bad'), blockTime: NOW - 3000 }))),
});

const server = spawn('node', [new URL('../../tools/serve-dapp.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
let browser;
try {
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  async function open({ service, deployed = new Set(), viewport = { width: 1280, height: 900 } }) {
    const ctx = await browser.newContext({ viewport });
    const calls = [], errors = [];
    await ctx.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); });
    await ctx.route('https://tacit-points.onrender.com/**', async (route) => {
      const u = new URL(route.request().url());
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (u.pathname !== '/tasks') return route.fulfill({ status: 404, headers: cors, body: '{}' });
      if (service === 'down') return new Promise(() => {});
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(service) });
    });
    for (const host of ['https://ethereum-rpc.publicnode.com/**', 'https://eth.drpc.org/**', 'https://1rpc.io/**', 'https://mainnet.gateway.tenderly.co/**', 'https://mainnet.base.org/**', 'https://base.gateway.tenderly.co/**', 'https://base-rpc.publicnode.com/**', 'https://base.drpc.org/**', 'https://rpc.mainnet.chain.robinhood.com/**', 'https://robinhood.drpc.org/**', 'https://mainnet.megaeth.com/**', 'https://megaeth.drpc.org/**']) {
      await ctx.route(host, async (route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const body = JSON.parse(req.postData() || '[]'), batch = Array.isArray(body), list = batch ? body : [body];
        const out = list.map((c) => { calls.push({ method: c.method, to: String(c.params?.[0]?.to || c.params?.[0] || '').toLowerCase() }); return { jsonrpc: '2.0', id: c.id, result: c.method === 'eth_getCode' ? (deployed.has(String(c.params[0]).toLowerCase()) ? '0x6000' : '0x') : '0x' }; });
        return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(batch ? out : out[0]) });
      });
    }
    await ctx.route(/^(wss|https):\/\/(relay|verify)\.walletconnect\.(org|com)/, (route) => route.abort());
    await ctx.route(`${SITE}/tasks/jobs.json`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs }) }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${SITE}/tasks/`);
    return { ctx, page, calls, errors };
  }
  const titles = (page) => page.locator('.job-head b').allInnerTexts();
  const ready = (page) => page.waitForFunction(() => !!document.querySelector('.job-head') && !/Reading the chain/.test(document.querySelector('#jobs')?.textContent || ''), null, { timeout: 30000 });

  // 1. every step claimed: no read of the chain, newest first, and the page does not move
  {
    const { ctx, page, calls, errors } = await open({ service: view(new Set(jobs.map((j) => j.id))) });
    await ready(page); await page.waitForTimeout(1500);
    assert.equal(calls.filter((c) => c.method === 'eth_getCode').length, 0, `no code was read from the chain (${calls.map((c) => c.method).join(',')})`);
    assert.deepEqual(await titles(page), ['Deploy the swap route', 'Deploy the swap route (earlier address)', 'Deploy the TAC vaults'], 'finished jobs list the newest first');
    assert.match(await page.locator('#stats').innerText(), /3 of 3\s+jobs done/);
    assert.match(await page.locator('#jobs').innerText(), /No open jobs right now/);
    assert.ok((await page.evaluate(() => window.__cls)) < 0.02, `the page did not move (${await page.evaluate(() => window.__cls)})`);
    assert.deepEqual(errors, []);
    console.log('ok - jobs the service has claimed are shown done with no read of the chain, the newest first, without the page moving');
    await ctx.close();
  }
  // 2. nothing claimed, one deployed: the chain is asked, and a done job nobody has claimed says so
  {
    const route = jobs.find((j) => j.id === 'amm-route').steps[0].expected.toLowerCase();
    const { ctx, page, calls } = await open({ service: view(new Set()), deployed: new Set([route]) });
    await ready(page); await page.waitForTimeout(1000);
    const reads = calls.filter((c) => c.method === 'eth_getCode');
    assert.ok(reads.some((c) => c.to === route), 'the chain was asked for the contract');
    const text = await page.locator('#jobs').innerText();
    assert.match(text, /no reward claimed yet/, 'a done job nobody has claimed says so');
    assert.match(text, /OPEN JOBS\s*2/i, 'the two jobs not on the chain are open');
    console.log('ok - steps the service has not claimed are read from the chain, and a done job with no claim says so');
    await ctx.close();
  }
  // 3. a service that does not answer does not hold the page
  {
    const t0 = Date.now();
    const { ctx, page } = await open({ service: 'down' });
    await ready(page);
    const took = Date.now() - t0;
    assert.ok(took < 9000, `the jobs are drawn without the service (${took} ms)`);
    assert.match(await page.locator('#jobs').innerText(), /Rewards offline/, 'and say the rewards are offline');
    console.log(`ok - with no answer from the service the page draws its jobs from the chain after ${Math.round(took / 100) / 10} s`);
    await ctx.close();
  }
  // 4. a phone
  {
    const { ctx, page } = await open({ service: view(new Set(jobs.map((j) => j.id))), viewport: { width: 390, height: 844 } });
    await ready(page); await page.waitForTimeout(1500);
    assert.ok((await page.evaluate(() => window.__cls)) < 0.02, 'a phone is not moved either');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no sideways scroll');
    console.log('ok - the phone layout does not move and does not scroll sideways');
    await ctx.close();
  }
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}
