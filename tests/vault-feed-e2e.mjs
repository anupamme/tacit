// The vault page's price-feed button in a real browser, against an anvil fork of mainnet taken before anything was recorded: the page reads what is
// missing, builds every record from an archive node's headers and proofs (real ones, from mainnet), sends them ten at a time through the wallet, and the
// oracles on the fork accept all of them, after which the vaults can price and say how much there is to borrow.
//   anvil --fork-url https://eth.drpc.org --fork-block-number 26203780 --port 8547 --chain-id 1 &
//   FORK_RPC=http://127.0.0.1:8547 node tests/vault-feed-e2e.mjs
// 26203780 is after the vaults were deployed and before their first interval was recorded. The headers and proofs of the past are read from the real chain through the
// nodes the page asks for them, so this needs the network; everything it sends goes to the fork. In this run eth.drpc.org answers every one of those with a rate limit,
// the connected wallet serves them for the first batches and then says it has no such method, and the page carries on with the other nodes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const FORK = process.env.FORK_RPC;
if (!FORK) { console.log('skipped - set FORK_RPC to an anvil mainnet fork taken at block 26203780'); process.exit(0); }
const PORT = Number(process.env.PORT || 8792), SITE = `http://127.0.0.1:${PORT}`;
const rpc = async (method, params = []) => {
  const r = await (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
assert.ok(CHROME, 'a Chrome to drive');
const USD = '0x00000087ac9ed3E1Bd443E00FBe18B4EdcAEeb1F';
const ORACLES = ['0x0000002C48F347Fc4245226b71457E6bC85A5724', '0x000000cD99De6AD4079F9e327c2A61eD58AB8551'];

const server = spawn('node', [new URL('../tools/serve-dapp.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const snap = await rpc('evm_snapshot');
let browser;
try {
  await new Promise((r) => setTimeout(r, 800));
  const [account] = await rpc('eth_accounts');
  assert.equal(await rpc('eth_getCode', [USD, 'latest']) === '0x', false, 'the vault exists on this fork');
  const sampleCount = async (oracle) => {
    const head = Number(BigInt(await rpc('eth_blockNumber')));
    const top = Math.floor((head - 1) / 50) - 1;
    let n = 0;
    for (let k = top; k > top - 48; k--) {
      const r = await rpc('eth_call', [{ to: oracle, data: `0x89906360${k.toString(16).padStart(64, '0')}` }, 'latest']);
      if (BigInt(`0x${r.slice(2, 66)}`) !== 0n) n++;
    }
    return n;
  };
  const before = [await sampleCount(ORACLES[0]), await sampleCount(ORACLES[1])];
  assert.ok(before.every((n) => n < 5), `almost nothing is recorded at this block: ${before}`);

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  // The page's reads and sends go to the fork; headers and proofs of past blocks come from the real chain (the fork's node would have to be an archive), from whichever
  // real node the page asked, except that eth.drpc.org says it is rate limited.
  const PAST = new Set(['eth_getProof', 'eth_getBlockByNumber']), served = {}, limitedAnswers = { n: 0 };
  const realNode = async (url, postData) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: postData }); return { status: r.status, text: await r.text() }; };
  for (const host of ['ethereum-rpc.publicnode.com', 'eth.drpc.org', 'rpc.mevblocker.io', 'eth-mainnet.public.blastapi.io', 'ethereum-json-rpc.stakely.io', 'eth.rpc.blxrbdn.com', '1.rpc.thirdweb.com', '1rpc.io', 'mainnet.gateway.tenderly.co']) {
    await ctx.route(`https://${host}/**`, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const body = JSON.parse(req.postData() || '{}');
      if (PAST.has(body.method)) {
        if (host === 'eth.drpc.org') {
          limitedAnswers.n++;
          return route.fulfill({ status: 429, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, error: { code: 429, message: 'You reached Public endpoint rate limit, please upgrade to paid plan' } }) });
        }
        const r = await realNode(req.url(), req.postData());
        if (r.status === 200 && /"result":\{/.test(r.text)) served[host] = (served[host] || 0) + 1;
        return route.fulfill({ status: r.status, headers: { ...cors, 'content-type': 'application/json' }, body: r.text });
      }
      const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.postData() });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: await r.text() });
    });
  }
  await ctx.route(/^(wss|https):\/\/(relay|verify)\.walletconnect\.(org|com)/, (route) => route.abort());
  await ctx.exposeFunction('__fork', (method, params) => rpc(method, params));
  const walletReads = { n: 0 };
  await ctx.exposeFunction('__past', async (method, params) => {                              // the wallet's own node: the real chain
    walletReads.n++;
    const r = JSON.parse((await realNode('https://rpc.mevblocker.io', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))).text);
    if (r.error) throw new Error(r.error.message);
    return r.result;
  });
  await ctx.addInitScript((acct) => {
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_getBlockByNumber' || method === 'eth_getProof') {
        if (window.__walletMode === 'none') throw Object.assign(new Error(`The method ${method} does not exist`), { code: -32601 });
        return window.__past(method, params);
      }
      if (method === 'eth_sendTransaction') {
        window.__sends = (window.__sends || 0) + 1;
        if (window.__stallAt === window.__sends) return new Promise(() => {});          // a wallet that never answers this one
        return window.__fork('eth_sendTransaction', params);
      }
      throw Object.assign(new Error(`unsupported ${method}`), { code: -32601 });
    }, on() {}, removeListener() {} };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test-wallet', name: 'Test wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'test.wallet' }, provider } }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  }, account);

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${SITE}/vault/`);
  await page.waitForFunction(() => /to record/.test(document.querySelector('#feed')?.innerText || ''), null, { timeout: 60000 });
  const panel = await page.locator('#feed').innerText();
  const missing = Number(/(\d+) to record/.exec(panel)[1]);
  assert.ok(missing >= 90, `the whole window is missing on this fork: ${missing}`);
  await page.waitForFunction(() => /Borrowing waits for \d+ prices? to be recorded/.test(document.querySelector('#board')?.innerText || ''), null, { timeout: 60000 });   // borrowing cannot price yet
  console.log(`ok - before: ${missing} prices to record, borrowing paused`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/feed-before.png`, fullPage: true });

  // Connect, then record.
  await page.locator('#feed-go').click();
  await page.waitForTimeout(600);
  if (await page.locator('.picker .way').count()) await page.locator('.picker .way', { hasText: 'Test wallet' }).click();
  await page.waitForFunction(() => /^Record \d+ price/.test(document.querySelector('#feed-go')?.textContent || ''), null, { timeout: 20000 });
  // The Borrow button says the same thing and is ready to do it: prices first.
  await page.locator('#acts [data-t="borrow"]').click();
  await page.waitForFunction(() => /^Record \d+ prices? to open borrowing$/.test(document.querySelector('#go')?.textContent || '') && !document.querySelector('#go')?.disabled, null, { timeout: 20000 });
  console.log('ok - the Borrow button says to record the prices first, and is ready to');

  // The wallet answers the first batch and never the second: the page says which batch it waits on, then offers a way out, and the panel is usable again.
  await page.evaluate(() => { window.__stallAt = 2; });
  await page.locator('#feed-go').click();
  const status = () => page.locator('#feed-status').innerText();
  await page.waitForFunction(() => /Confirm batch 2 of \d+ in your wallet/.test(document.querySelector('#feed-status')?.innerText || ''), null, { timeout: 120000 });
  const left = Number(/(\d+) to record/.exec(await page.locator('#feed').innerText())[1]);
  assert.ok(left <= missing - 8, `the counts follow the first batch: ${missing} then ${left}`);
  assert.equal(await page.locator('[data-feed-stop]').count(), 0, 'no way out offered while the wallet has had only a moment');
  await page.waitForFunction(() => /Waiting for your wallet to confirm batch 2/.test(document.querySelector('#feed-status')?.innerText || ''), null, { timeout: 40000 });
  assert.match(await status(), /stop waiting/);
  await page.locator('[data-feed-stop]').click();
  await page.waitForFunction(() => /Stopped waiting/.test(document.querySelector('#feed-status')?.innerText || '') && !document.querySelector('#feed-go')?.disabled, null, { timeout: 30000 });
  assert.equal(await page.locator('#feed-status.err').count(), 0, 'stopping the wait is not an error');
  console.log(`ok - a wallet that never answers batch 2: the page offers to stop waiting, says so, and the button works again (${left} still to record)`);
  await page.evaluate(() => { window.__stallAt = 0; window.__walletMode = 'none'; });         // the wallet now says it has no such method
  const readsBefore = walletReads.n;
  await page.locator('#feed-go').click();
  await page.waitForFunction(() => /up to date/.test(document.querySelector('#feed')?.innerText || ''), null, { timeout: 420000 });
  console.log('ok - the page built, tested and sent every batch; the feed reads up to date');

  assert.ok(readsBefore > 0, `the connected wallet served the first batches\' headers and proofs (${readsBefore} reads)`);
  const hosts = Object.keys(served);
  assert.ok(limitedAnswers.n > 0, 'eth.drpc.org was asked and said it was rate limited');
  assert.ok(hosts.length >= 2, `once the wallet had none, the headers and proofs came from several nodes at once, not one: ${JSON.stringify(served)}`);
  console.log(`ok - ${readsBefore} reads served by the wallet, then ${hosts.map((h) => `${h} ${served[h]}`).join(', ')}; eth.drpc.org rate limited ${limitedAnswers.n} calls`);
  const after = [await sampleCount(ORACLES[0]), await sampleCount(ORACLES[1])];
  assert.deepEqual(after, [48, 48], 'both oracles hold all 48 intervals on the fork');
  const ceiling = BigInt(await rpc('eth_call', [{ to: USD, data: '0x16275096' }, 'latest']));
  assert.ok(ceiling > 0n, 'the vault now answers how much it can lend');
  await page.waitForFunction(() => /\d+\.\d+\s*TACD/.test(document.querySelector('#board')?.innerText || ''), null, { timeout: 60000 });
  const cap = await page.locator('#board').innerText();
  assert.doesNotMatch(cap, /not recorded/);
  await page.waitForFunction(() => /^(Enter an amount|Deposit [\d,.]+ TAC and borrow|Borrow \w+)$/.test(document.querySelector('#go')?.textContent || ''), null, { timeout: 30000 });
  console.log('ok - and the Borrow button now asks for an amount (or offers the deposit and borrow it was filled with): borrowing is open');
  console.log(`ok - both oracles hold 48 of 48 and the vault shows its room: ${cap.split('\n').find((l) => /TACD/.test(l)) ?? ''}`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/feed-after.png`, fullPage: true });
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  console.log('ok - no errors on the page');
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await rpc('evm_revert', [snap]).catch(() => {});
}
