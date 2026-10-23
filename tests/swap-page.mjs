#!/usr/bin/env node
// dapp/swap/ in a real browser, under its own CSP, with Ethereum an anvil fork of mainnet (zQuoter's scan of every pool, a read a fork
// makes slowly, goes to the upstream node at the fork's block). Checks the page loads clean; the quotes for ETH → TAC (with its routes),
// USDC → TAC, ETH → tacUSD (a price far under the market has to be accepted first) and a private swap (priced here, made on the card
// once the Tacit key is opened there); then, with a wallet that signs with a real key, buys TAC with ETH, buys TAC with USDC by permit, sells TAC by permit,
// and opens the farm on what was bought. A phone and a dark screen have no sideways scroll.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/swap-page.mjs        (SHOTS=dir saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ammRouteDeployTx, ammRouteAddress, ammRouteAddressMatches } from './amm-route-deploy.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://ethereum-rpc.publicnode.com', SHOTS = process.env.SHOTS || null;
const PORT = 22000 + Math.floor(Math.random() * 1000), WEB = PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ZQUOTER = '0x000000bd2db80567c23e353ca95a251c573cbf9b';
// A node that caps a call's gas below what zQuoter's scan asks for (50M on some public nodes), or that is unreachable, is followed by the next.
const UPSTREAMS = [FORK, 'https://mainnet.gateway.tenderly.co'];
const up = async (method, params) => {
  let last;
  for (const url of UPSTREAMS) {
    for (let a = 0; a < 2; a++) {
      try {
        const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
        if (j.error && /gas required exceeds|out of gas/i.test(j.error.message || '')) { last = j; break; }
        return j;
      } catch (e) { last = { error: { message: e.message } }; }
    }
  }
  return last;
};
const FORK_BLOCK = BigInt((await up('eth_blockNumber', [])).result) - 2n;

const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(FORK_BLOCK), '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
let server;
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) { try { await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })).json(); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);
const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co'];

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const until = (page, fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout });
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();
const rpcA = async (method, params = []) => { const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
// Whether TacitAmmRoute is already on the chain the fork was made from (it is on mainnet now): the pairs that need it are then offered from the start.
const DEPLOYED = (await rpcA('eth_getCode', [ammRouteAddress(), 'latest'])) !== '0x';
const bal = async (t, a) => BigInt(await rpcA('eth_call', [{ to: t, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));

async function stubWallet(ctx, { account, key }) {
  const log = { sends: [], signs: 0 };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'wallet_watchAsset') { (log.watched ||= []).push(params); return true; }
    if (method === 'eth_signTypedData_v4') { log.signs++; (log.typed ||= []).push(JSON.parse(params[1])); return cast('wallet', 'sign', '--private-key', key, '--data', params[1]); }
    if (method === 'eth_sendTransaction') { log.sends.push(params[0]); return rpcA('eth_sendTransaction', [{ ...params[0], gas: '0x4c4b40' }]); }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => { window.ethereum = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on() {}, removeListener() {} }; });
  return log;
}
async function fundedWallet() {
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], who = j.address;
  await rpcA('anvil_setBalance', [who, '0x' + (5n * 10n ** 18n).toString(16)]);
  await rpcA('anvil_dealERC20', [who, USDC, '0x' + (2000n * 10n ** 6n).toString(16)]);
  await rpcA('anvil_impersonateAccount', [who]);
  return { account: who, key: j.private_key };
}

async function openPage(viewport, { wallet = null, path = '/swap/', scheme = 'light', fontDelay = 0, shifts = false } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const walletLog = wallet ? await stubWallet(ctx, wallet) : null;
  await ctx.addInitScript(() => { try { localStorage.setItem('tacit-trade-hedge-ms', '0'); } catch { /* storage is a convenience */ } });
  if (fontDelay) await ctx.route('**/*.woff2', async (route) => { await sleep(fontDelay); await route.continue(); });
  if (shifts) await ctx.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); });
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    try {
      const body = route.request().postData() || '{}', j = JSON.parse(body);
      // zQuoter's scan reads too many slots for a fork: the upstream node answers it at the fork's block.
      // and so does the token list's registry, whose JSON a fork would read one storage slot at a time.
      const toZq = j.method === 'eth_call' && (String(j.params?.[0]?.to || '').toLowerCase() === ZQUOTER || body.toLowerCase().includes('0000006013df75a31678b786061c2b54bf531524'));
      const r = toZq ? JSON.stringify({ ...(await up('eth_call', [j.params[0], '0x' + FORK_BLOCK.toString(16)])), id: j.id }) : await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text();
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: r });
    } catch (e) { await route.fulfill({ status: 502, headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
  });
  // The points program's terms, stubbed so a pass shows they are read: ETH swapped into TAC pays 1,000 points an ETH.
  await ctx.route(/api\.tacit\.finance\/leaderboard/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ day: 1, programDay: 1, programDays: 90, program: { startDay: 1, days: 90, dayBudgetWei: '1111111111111111111111', rates: { zswapeth: 1000 }, weights: [{ fromDay: 1, weights: {} }] }, totalPoints: 0, dayBudgetWei: '1111111111111111111111', taking: 0, rows: [] }) }));
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); (/Content Security Policy|Refused to/i.test(t) ? blocked : errors).push(t); } });
  await page.goto(`http://127.0.0.1:${WEB}${path}`);
  return { browser, page, errors, blocked, walletLog };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const typeAmt = async (page, v) => { await page.fill('#amt', ''); await page.type('#amt', v); };
const quoted = (page) => until(page, () => { const o = document.querySelector('#out'); return o && !o.classList.contains('busy') && !o.classList.contains('ph') && document.querySelector('#go').textContent !== 'Finding the best price…'; });
// A price far under the market has to be accepted before a swap: ticked where a test is about something else.
const ackIf = async (page) => {
  for (let i = 0; i < 20; i++) {
    const a = await page.$('#ack:not(:checked)');
    if (a) await a.check();
    else if ((await page.textContent('#go')) !== 'Accept the price above to swap') return;
    await sleep(250);
  }
};
// The tooltip of each receipt row (the detail a row keeps out of its text).
const rowTips = (page) => page.$$eval('#rcpt div', (ds) => ds.map((d) => d.title).filter(Boolean));
// Each side's Wallet / Private switch.
const sidePriv = (page, side, on) => page.click(`.sides[data-side="${side}"] [data-p="${on ? 1 : 0}"]`);
const pick = async (page, side, sym) => { await page.click(side === 'pay' ? '#pay-coin' : '#get-coin'); await page.click(`.pk-r:has(b:text-is("${sym}"))`); };

// ── no wallet: the page, the quotes, the gate, a private swap's receipt ──
{
  const { browser, page, errors, blocked } = await openPage({ width: 1280, height: 900 });
  await until(page, () => document.querySelector('#pxs')?.classList.contains('on'));
  ok(/TAC \$[\d.,]+/.test(await page.textContent('#pxs')) && /ETH \$[\d,]+/.test(await page.textContent('#pxs')), 'prices: TAC, ETH and BTC in dollars');
  ok((await page.textContent('#go')) === 'Enter an amount', 'the button asks for an amount');
  await typeAmt(page, '0.5');
  await quoted(page);
  const out = Number((await page.textContent('#out')).replace(/,/g, ''));
  ok(out > 100, `0.5 ETH quotes ${out} TAC`);
  ok(await page.isVisible('#rows') && (await page.$$('#rows [data-route]')).length >= 2, 'ETH → TAC offers its routes (Precision, Tacit, maybe both)');
  ok(/At least/.test(await page.textContent('#rcpt')) && /Network fee/.test(await page.textContent('#rcpt')), 'the receipt has the floor and the network fee');
  // Only ETH put into the Precision pool scores: its row says at least what 0.5 ETH earns, the Tacit pool's says nothing, and a split earns on its Precision leg.
  await until(page, () => /points/.test(document.querySelector('#rows [data-route="precision"]')?.textContent || ''));
  const rowText = async (k) => ((await page.textContent(`#rows [data-route="${k}"]`).catch(() => '')) || '').replace(/\s+/g, ' ');
  const pr = await rowText('precision'), ta = await rowText('tacit-amm'), sp = await rowText('split');
  ok(/500\+ points/.test(pr) && !/points/.test(ta), `ETH → TAC says what the Precision pool earns (500+ for 0.5 ETH) and the Tacit pool nothing (${pr.slice(0, 70)} | ${ta.slice(0, 50)})`);
  { const rt = await page.textContent('#rows'); ok(/\d+\.\d+% less/.test(rt) && !/−\d/.test(rt), `a route that pays less says by how much, in words, against the best (${rt.replace(/\s+/g, ' ').slice(0, 110)})`); }
  ok(!sp || (/\d+% \/ \d+% · [\d,]+\+ points/.test(sp) && Number(sp.match(/([\d,]+)\+ points/)[1].replace(/,/g, '')) < 500), `a split earns on its Precision leg only (${sp.slice(0, 80) || 'no split offered'})`);
  ok((await page.textContent('#go')) === 'Connect wallet', 'without a wallet the button connects one');
  // The route picked follows the amount: 0.5 ETH after a small amount is routed as a fresh 0.5 ETH is, and a route the visitor clicked stays.
  const picked = () => page.evaluate(() => document.querySelector('#rows [role="radio"][aria-checked="true"]')?.dataset.route || null);
  const fresh = await picked();
  await typeAmt(page, '0.001'); await sleep(900); await quoted(page);
  await typeAmt(page, '0.5'); await sleep(900); await quoted(page);
  ok((await picked()) === fresh, `a route picked for a small amount does not stay for 0.5 ETH (${fresh})`);
  await page.click('#rows [data-route="precision"]');
  await typeAmt(page, '0.4'); await sleep(900); await quoted(page);
  ok((await picked()) === 'precision', 'a route the visitor clicked stays when the amount changes');
  await typeAmt(page, '0.5'); await sleep(900); await quoted(page);
  ok(/from=|amt=0\.5/.test(page.url()), `the address carries the swap (${page.url().split('/swap/')[1]})`);
  await shot(page, 'desktop-eth-tac');

  // Any token: the picker lists token.list.wei's mainnet tokens with their logos; USDC → TAC through zQuoter and PrecisionRoute.
  await page.click('#pay-coin');
  await until(page, () => document.querySelectorAll('.pk-r img.tk').length >= 8, null, 60000);
  ok(await page.$$eval('.pk-r b', (x) => x.some((e) => e.textContent === 'rETH') && !x.some((e) => e.textContent === 'stETH')), 'the picker lists the onchain token list (rETH in, stETH left out) with its logos');
  await page.keyboard.press('Escape');
  await pick(page, 'pay', 'USDC');
  ok((await page.textContent('#get-coin')).includes('TAC'), 'USDC buys TAC');
  await typeAmt(page, '500');
  await quoted(page);
  const usdcOut = Number((await page.textContent('#out')).replace(/,/g, ''));
  ok(usdcOut > 100, `500 USDC quotes ${usdcOut} TAC`);
  ok(/Route.*(Uniswap|Curve|Sushi|zAMM).*Precision/.test(await page.textContent('#rcpt')), 'USDC: the receipt names the pool zQuoter found, then Precision');
  ok(!(await page.textContent('#q')).trim(), 'no line under the button when nothing is wrong');
  await shot(page, 'desktop-usdc-tac');

  // Choosing tacUSD while paying USDC puts ETH on the pay side: the 500 typed in USDC is not kept as 500 ETH.
  await pick(page, 'get', 'tacUSD');
  if (DEPLOYED) {
    ok((await page.textContent('#pay-coin')).includes('USDC') && (await page.inputValue('#amt')) === '500', 'with TacitAmmRoute on chain, choosing tacUSD while paying USDC keeps the pair and the amount');
    await pick(page, 'pay', 'ETH');
  }
  ok((await page.textContent('#pay-coin')).includes('ETH') && (await page.inputValue('#amt')) === '', 'a pay side that follows a choice clears the amount typed in the old asset');

  // tacUSD from the Tacit pool, priced far from a dollar: accepted first.
  await typeAmt(page, '0.05');
  await quoted(page);
  const gated = await page.isVisible('#ack');
  if (gated) {
    await page.check('#ack');
    await page.evaluate(() => document.querySelector('#slip [data-slip="50"]').click());          // a refresh of the same quote
    await quoted(page);
    ok(await page.isChecked('#ack'), 'the acceptance holds across a refresh of the same quote');
    await typeAmt(page, '0.06'); await quoted(page);
    ok(!(await page.isChecked('#ack')), 'a new amount asks for it again');
  }
  ok(gated ? /under/.test(await page.textContent('#ackbox')) : true, `tacUSD: ${gated ? 'a price far under the market is gated' : 'priced near the market, no gate'}`);
  if (gated) {
    ok(/Borrow cUSD at \$1, then make it public/.test(await page.textContent('#ackbox')), 'the gate offers to borrow cUSD and make it public');
    ok((await page.textContent('#go')).startsWith('Connect') || await page.isDisabled('#go'), 'the button waits for the acceptance (or a wallet)');
  }
  await shot(page, 'desktop-cusd');

  // Private: priced here, made on the card. The get side private: what is bought lands in the private balance.
  await sidePriv(page, 'get', true);
  await page.click('#get-coin');
  ok(await page.$('.pk-r:has(b:text-is("cUSD"))') && await page.$('.pk-r:has(b:text-is("cBTC"))') && !(await page.$('.pk-r:has(b:text-is("tacUSD"))')), 'private: the picker names the notes cUSD and cBTC');
  await page.click('.pk-x');
  await pick(page, 'pay', 'ETH');
  await pick(page, 'get', 'TAC');
  await typeAmt(page, '0.25');
  await quoted(page);
  ok((await page.textContent('#go')) === 'Swap privately', 'private: the swap is made on this card');
  ok(/Fees\s*about/.test(await page.textContent('#rcpt')), 'private: the fees are said once');
  ok(await page.$eval('#f-get', (e) => e.classList.contains('priv')), 'private: the get field is dashed');
  { const rc = (await page.textContent('#rcpt')).replace(/\s+/g, ' ');
    ok(/Chain seesyour 0\.25 ETH deposited/.test(rc), `private from the wallet: the receipt says what the chain sees (${rc})`);
    ok((await rowTips(page)).some((t) => /Pool depth: [\d.,]+ tETH · [\d.,]+ TAC/.test(t)), 'private: the price row keeps how deep the pool is');
    ok(!/Pool/.test(rc) && (await page.$$('#rcpt div')).length <= 6, `private: the receipt stays short (${(await page.$$('#rcpt div')).length} rows)`); }
  await shot(page, 'desktop-private');
  // paid from the private balance too: the card offers to read it, and the chain sees a swap, not whose
  await sidePriv(page, 'pay', true);
  ok((await page.textContent('#pay-coin')).includes('tETH'), 'the pay side made private: the wallet\'s ETH becomes private tETH');
  await pick(page, 'pay', 'cUSD');
  await typeAmt(page, '50');
  await quoted(page);
  ok(await page.isVisible('#pv-open'), 'private balance: the card offers to read it');
  ok(/Chain seesa swap, not whose/.test((await page.textContent('#rcpt')).replace(/\s+/g, ' ')), 'private balance: the chain sees a swap, not whose');
  ok(!/Deposit tip/.test(await page.textContent('#rcpt')), 'private balance: no deposit, no deposit tip');
  // out of the pool to an address: private cBTC to USDC, through an exit recipe; with no wallet here the address is asked for, and never taken from the address bar
  await pick(page, 'pay', 'cBTC');
  await sidePriv(page, 'get', false);
  await page.click('#get-coin');
  ok(!!(await page.$('.pk-r:has(b:text-is("USDC"))')) && !!(await page.$('.pk-r:has(b:text-is("ETH"))')), 'the get side public: any token is offered, out of the pool');
  await page.click('.pk-r:has(b:text-is("USDC"))');
  await typeAmt(page, '0.001');
  await quoted(page);
  ok(await page.isVisible('#to-in') && (await page.textContent('#go')) === 'Add the address it goes to', `out of the pool: the address is asked for (${await page.textContent('#go')})`);
  ok(!(await page.$eval('#f-get', (e) => e.classList.contains('priv'))) && (await page.textContent('#get-where')) === 'to an address', 'out of the pool: the get side is not drawn as private');
  await page.fill('#to-in', '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a');
  await until(page, () => /^Swap privately → 0x5a5a…5a5a$|^Accept the price/.test(document.querySelector('#go').textContent));
  await ackIf(page);
  ok((await page.textContent('#go')) === 'Swap privately → 0x5a5a…5a5a', `out of the pool: the button names where it goes (${await page.textContent('#go')})`);
  { const rc = (await page.textContent('#rcpt')).replace(/\s+/g, ' ');
    const tips = await rowTips(page);
    ok(/At least[\d.,]+ USDC/.test(rc) && /Fees\s*about/.test(rc) && tips.some((t) => /Relay fee [\d.]+ cBTC/.test(t) && /Exit fee [\d.]+ tETH/.test(t)), `out of the pool: the least it pays, and the route's and the exit's fee as one row (${rc})`);
    ok(/Chain seesUSDC to 0x5a5a…5a5a, not from whom/.test(rc), 'out of the pool: the chain sees USDC arriving, not from whom');
    ok(tips.some((t) => /Pool depth: [\d.,]+ cBTC · [\d.,]+ tETH/.test(t)), 'out of the pool: routed through the cBTC pool to tETH first'); }
  ok(!/0x5a5a/.test(page.url()), 'the address is not put in the address bar');
  await shot(page, 'desktop-private-out');
  // a wallet token into the private balance: swapped for ETH on the best onchain route, that ETH made private, then swapped in the pool
  await sidePriv(page, 'pay', false);
  await sidePriv(page, 'get', true);
  await pick(page, 'pay', 'USDC');
  await pick(page, 'get', 'TAC');
  await typeAmt(page, '100');
  await quoted(page);
  { const rc = (await page.textContent('#rcpt')).replace(/\s+/g, ' ');
    ok(/Fees\s*about/.test(rc) && (await rowTips(page)).some((t) => /Relay fee [\d.]+ tETH/.test(t) && /Deposit tip/.test(t)), `USDC into private TAC: the relay's fee in tETH and the deposit's tip, as one row (${rc})`);
    ok(/Chain seesyour 100 USDC for ETH, then a deposit/.test(rc) && /Route.* → Tacit pool/.test(rc), 'and the chain sees the USDC swapped for ETH, then a deposit'); }
  ok((await page.textContent('#go')) === 'Connect wallet', 'it needs the wallet');
  // any token to any token: zQuoter's best onchain route, compared with each pool
  await sidePriv(page, 'get', false);
  await pick(page, 'pay', 'ETH');
  await pick(page, 'get', 'USDC');
  await typeAmt(page, '1');
  await quoted(page);
  { const rc = (await page.textContent('#rcpt')).replace(/\s+/g, ' ');
    ok(/Route(Uniswap|Sushi|Curve|zAMM)/.test(rc) && /At least[\d.,]+ USDC/.test(rc) && (await rowTips(page)).some((t) => /Compared with \d+ pools?/.test(t)), `ETH → USDC: the route and the least it pays, with the pools it was compared with in a tooltip (${rc})`);
    ok(!/Chain sees/.test(rc) && (await page.$$('#rcpt div')).length <= 6, `a public swap needs no line on what the chain sees, and a short receipt (${(await page.$$('#rcpt div')).length} rows)`); }
  ok(await page.isVisible('.sw-foot'), 'a public swap has its slippage row');
  // Swap privately: the wallet's ETH deposited now into the private ETH pool, swapped later from it to an address
  ok(await page.isVisible('#later') && /Swap privately/.test(await page.textContent('#later')), 'a wallet ETH swap on the onchain route offers to swap privately');
  ok((await page.getAttribute('#later-on', 'role')) === 'switch' && (await page.getAttribute('#later-on', 'aria-checked')) === 'false', 'Swap privately is a switch, off to start');
  await page.click('#later-on');
  ok((await page.getAttribute('#later-on', 'aria-checked')) === 'true' && /Deposit/.test(await page.textContent('#later .pre')) && /Wait/.test(await page.textContent('#later .pre')) && /Swap/.test(await page.textContent('#later .pre')), 'turned on, it shows the three steps it takes');
  await until(page, () => /ETH$|unavailable/.test(document.querySelector('#later-dep')?.textContent || ''), null, 30000);
  { const d0 = await page.textContent('#later-dep');
    ok(/^[\d.]+ ETH$/.test(d0) && /^\+[\d.]+ ETH$/.test(await page.textContent('#later-xv')) && !/\d\.\d{4,}/.test(await page.textContent('#later-xv')), `the deposit is the swap, the relay's fee and a buffer a slider sets, shown in two figures (${d0}, ${await page.textContent('#later-xv')})`);
    await page.$eval('#later-x', (el) => { el.value = '80'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    ok(Number((await page.textContent('#later-dep')).split(' ')[0]) > Number(d0.split(' ')[0]), 'a larger extra makes a larger deposit');
    ok(await page.isVisible('#to-in') && /Address it goes to/.test(await page.getAttribute('#to-in', 'placeholder')), 'it asks for the address it goes to: never the wallet that deposits'); }
  await page.click('#later-on');
  ok(await page.isHidden('#later-x'), 'turned off, the card is an ordinary swap again');
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  ok(!blocked.length, `nothing blocked by the CSP${blocked.length ? ': ' + blocked.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
}

// ── a wallet in Private: a private amount has 8 decimals (Max and long amounts are cut there, not refused), the wallet's ETH is held to, a comma is a point ──
{
  const w = await fundedWallet();
  const { browser, page, errors, walletLog } = await openPage({ width: 1280, height: 900 }, { wallet: w });
  await page.click('#wallet-chip');
  await until(page, () => /Balance/.test(document.querySelector('#pay-side').textContent));
  const settled = () => until(page, () => { const o = document.querySelector('#out'), g = document.querySelector('#go').textContent; return o && !o.classList.contains('busy') && !/^(Finding the best price…|Enter an amount)$/.test(g); });
  // an amount typed for a public swap that is longer than a private one can be is cut when the get side turns private
  await typeAmt(page, '0.123456789012345678');
  await sidePriv(page, 'get', true);
  ok((await page.inputValue('#amt')) === '0.12345678', `choosing Private cuts a longer amount to 8 decimals (${await page.inputValue('#amt')})`);
  await pick(page, 'get', 'cUSD');
  await quoted(page);
  { const gated = !!(await page.$('#ack'));
    ok(!gated || (await page.textContent('#go')) === 'Accept the price above to swap', `a private swap far under the market waits for its acceptance too (${await page.textContent('#go')})`); }
  await ackIf(page);
  ok((await page.textContent('#go')) === 'Swap privately', 'private ETH → cUSD quotes the cut amount');
  // typing past 8 decimals stops at 8
  await typeAmt(page, '0.0035162701');
  await settled(); await ackIf(page);
  ok((await page.inputValue('#amt')) === '0.00351627' && (await page.textContent('#go')) === 'Swap privately', `a ninth decimal is not kept (${await page.inputValue('#amt')})`);
  // Max on the wallet's ETH is an amount the private quote takes, and it leaves the gas
  await page.click('#max');
  await quoted(page); await ackIf(page);
  { const v = await page.inputValue('#amt'), all = BigInt(await rpcA('eth_getBalance', [w.account, 'latest']));
    ok(/^\d+(\.\d{1,8})?$/.test(v) && (await page.textContent('#go')) === 'Swap privately', `Max in Private is a quoted amount of at most 8 decimals (${v}, ${await page.textContent('#go')})`);
    ok(BigInt(Math.round(Number(v) * 1e8)) * 10n ** 10n < all, 'and it is under the balance'); }
  // the wallet's ETH is the one balance known here
  await typeAmt(page, '9'); await settled();
  ok((await page.textContent('#go')) === 'Not enough ETH' && await page.isDisabled('#go'), `more ETH than the wallet holds (${await page.textContent('#go')})`);
  { const all = BigInt(await rpcA('eth_getBalance', [w.account, 'latest'])), cut = all - (all % 10n ** 10n), whole = cut / 10n ** 18n, frac = (cut % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    await typeAmt(page, `${whole}${frac ? '.' + frac : ''}`); await settled();
    ok((await page.textContent('#go')) === 'Leave some ETH for the network fee', `all of it leaves nothing for the deposit's gas (${await page.textContent('#go')})`); }
  // a comma is a decimal point where the amount is read
  await typeAmt(page, '0,5'); await quoted(page); await ackIf(page);
  ok(/your 0\.5 ETH deposited/.test(await page.textContent('#rcpt')), '"0,5" is priced as 0.5 ETH, not 5');
  // the press opens the Tacit key on this page; closing it sends nothing and leaves the card as it was
  { const sent = walletLog.sends.length;
    await page.click('#go');
    await until(page, () => /Open your Tacit wallet/.test(document.querySelector('.bsheet')?.textContent || ''), null, 60000);
    ok(true, 'pressing opens the Tacit key here');
    await page.click('.bsheet .x');
    await until(page, () => !document.querySelector('.bsheet') && document.querySelector('#go').textContent === 'Swap privately', null, 20000);
    ok(walletLog.sends.length === sent, `closing it sends nothing (${walletLog.sends.length - sent} sent)`); }
  await browser.close();
  const t = await openPage({ width: 1280, height: 900 }, { path: '/swap/?private&from=TAC&to=cUSD&amt=0.01' });
  await until(t.page, () => { const o = document.querySelector('#out'), g = document.querySelector('#go').textContent; return o && !o.classList.contains('busy') && !/^(Finding the best price…|Enter an amount)$/.test(g); });
  ok((await t.page.textContent('#go')) === 'Amount too small' && /Swap more than/.test(await t.page.textContent('#q')), `an amount under the relay's fee says so, not "No route" (${await t.page.textContent('#go')})`);
  await t.browser.close();
  // a small private swap: the relay's fee is said as a share of it, and the price impact is the pool's, not the fee's; Private has no slippage to set
  const u = await openPage({ width: 1280, height: 900 }, { path: '/swap/?private&from=ETH&to=TAC&amt=0.005' });
  await until(u.page, () => document.querySelector('#pxs')?.classList.contains('on'));
  await until(u.page, () => { const o = document.querySelector('#out'); return o && !o.classList.contains('busy') && !/^(Finding the best price…|Enter an amount)$/.test(document.querySelector('#go').textContent); });
  { const rc = (await u.page.textContent('#rcpt')).replace(/\s+/g, ' '), impact = Number((/Price impact\s*([\d.]+)%/.exec(rc) || [])[1]);
    ok(/Fees\s*about \$[\d.,]+ · \d+% of the swap/.test(rc), `a small private swap says what share of it the fees are (${rc || await u.page.textContent('#go')})`);
    ok(impact < 10, `and its price impact is the pool's, not the fee's (${impact}%)`); }
  ok(await u.page.isHidden('.sw-foot'), 'Private has no slippage row: there is nothing to set');
  await sidePriv(u.page, 'get', false);
  ok(await u.page.isVisible('.sw-foot'), 'and a public swap has it');
  await u.browser.close();
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
}

// ── a swap kept for later: its deposit, its wait and its swap out, drawn again from this browser on a later visit ──
{
  const { browser, page, errors } = await openPage({ width: 1280, height: 900 });
  await page.evaluate(() => localStorage.setItem('tacit-swap-later-v1', JSON.stringify([{ id: 'p1', at: Date.now() - 30 * 60e3, depositedAt: Date.now() - 30 * 60e3, from: '0x' + '11'.repeat(20), swapWei: '20000000000000000', extraWei: '5000000000000000', depositWei: '26000000000000000', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', sym: 'USDC', dec: 6, to: '0x' + '22'.repeat(20), state: 'waiting', leaves0: 500, depositTx: '0x' + 'ab'.repeat(32) }])));
  await page.reload();
  await until(page, () => !document.querySelector('#steps').hidden);
  const t = (await page.textContent('#steps')).replace(/\s+/g, ' ');
  ok(/0\.02 ETH → USDC\s*to 0x2222…2222/.test(t) && /Deposit/.test(t) && /Wait\s*30 min/.test(t) && /Swap now/.test(t), `a kept swap shows its deposit, how long it has waited and a way to swap it out (${t.slice(0, 160)})`);
  ok((await page.$$eval('#steps .st li', (l) => l.map((x) => x.className))).join(',') === 'done,now,todo' && (await page.getAttribute('#steps .st li.now', 'aria-current')) === 'step', 'its steps read done, now, to do, the current one marked for a screen reader');
  ok(!!(await page.$('#steps use[href="#tk-peth"]')), 'drawn with the private ETH mark');
  // Swap now reads the price and shows it; nothing is sent until it is confirmed, and Cancel drops it
  await page.click('[data-later-go="p1"]');
  await until(page, () => !!document.querySelector('[data-later-ok]'), null, 120000);
  { const t2 = (await page.textContent('#steps')).replace(/\s+/g, ' ');
    ok(/At least [\d.,]+ USDC/.test(t2) && /Confirm/.test(t2) && /Cancel/.test(t2), `Swap now shows the least it pays before anything is sent (${t2.slice(0, 200)})`); }
  ok((await page.textContent('#q')).trim() === '', 'and the status line under the swap button does not repeat it');
  await page.click('[data-later-no="p1"]');
  ok(!(await page.$('[data-later-ok]')) && !!(await page.$('[data-later-go="p1"]')), 'Cancel drops the price and offers Swap now again');
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
}

// ── every state of a kept swap, on a phone: what each shows and offers, and nothing runs off the card ──
{
  const { browser, page, errors } = await openPage({ width: 390, height: 900 }, { scheme: 'dark' });
  const T = Date.now(), base = { from: '0x' + '11'.repeat(20), swapWei: '500000000000000000', extraWei: '125000000000000000', depositWei: '660000000000000000', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', sym: 'USDC', dec: 6, to: '0x' + '22'.repeat(20), leaves0: 500 };
  const tx = (c) => '0x' + c.repeat(32);
  const plans = [
    { ...base, id: 'dep', at: T - 20e3, state: 'depositing' },
    { ...base, id: 'wait', at: T - 42 * 60e3, depositedAt: T - 42 * 60e3, state: 'waiting', depositTx: tx('ab') },
    { ...base, id: 'swp', at: T - 50 * 60e3, depositedAt: T - 50 * 60e3, swapAt: T - 30e3, state: 'swapping', depositTx: tx('ab') },
    { ...base, id: 'uns', at: T - 50 * 60e3, depositedAt: T - 50 * 60e3, state: 'unsure', depositTx: tx('ab'), err: 'The relay did not answer, and it may still have sent your payment.' },
    { ...base, id: 'don', at: T - 70 * 60e3, depositedAt: T - 70 * 60e3, doneAt: T - 60e3, state: 'done', depositTx: tx('ab'), swapTx: tx('cd') },
    { ...base, id: 'stp', at: T - 5 * 60e3, state: 'stopped', err: 'Cancelled in your wallet. Nothing was sent.' },
  ];
  await page.evaluate((v) => localStorage.setItem('tacit-swap-later-v1', JSON.stringify(v)), plans);
  await page.reload();
  await until(page, () => document.querySelectorAll('#steps .plan').length === 6);
  const cls = (id) => page.$$eval(`#steps .plan:nth-of-type(${id}) .st li`, (l) => l.map((x) => x.className).join(','));
  const plan = (n) => page.locator(`#steps .plan:nth-of-type(${n})`);
  ok((await cls(1)) === 'now,todo,todo', `a deposit being sent: it is the current step (${await cls(1)})`);
  ok((await cls(2)) === 'done,now,todo' && (await plan(2).locator('[data-later-go]').count()) === 1 && (await plan(2).locator('.x').count()) === 1, 'a waiting swap offers Swap now and a way to remove it');
  ok((await cls(3)) === 'done,done,now' && /sending…/.test(await plan(3).textContent()) && (await plan(3).locator('button').count()) === 0, 'a swap being sent offers nothing to press');
  ok((await cls(4)) === 'done,done,fail' && (await plan(4).locator('[data-later-check]').count()) === 1 && (await plan(4).locator('.note.err').count()) === 1 && /may still have sent/.test(await plan(4).locator('.note').textContent()), 'a swap in doubt says so in its own note and offers Check it, not Swap now');
  ok((await cls(5)) === 'done,done,done' && (await plan(5).locator('a[href*="etherscan.io/tx/"]').count()) === 2, 'a finished swap shows both transactions');
  ok((await cls(6)) === 'fail,todo,todo' && (await plan(6).locator('.x').count()) === 1 && (await plan(6).locator('.note.err').count()) === 1, 'a deposit that did not go through says so and can be removed');
  { const over = await page.evaluate(() => { const c = document.querySelector('#sw').getBoundingClientRect(); return [...document.querySelectorAll('#steps *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > c.right + 0.5 || r.left < c.left - 0.5); }).length; });
    ok(over === 0 && (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)), `nothing in the steps runs off the card or the page at 390 px (${over} elements)`); }
  await page.evaluate(() => { document.querySelector('#steps').scrollIntoView(); });
  await shot(page, 'phone-later-steps');
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
}

// ── a wallet: any token to any token on zQuoter's best route, sent on the fork: ETH → USDC, then USDC → DAI with its permit ahead of the swaps ──
{
  const w = await fundedWallet();
  const { browser, page, errors, walletLog } = await openPage({ width: 1280, height: 900 }, { wallet: w });
  const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
  await page.click('#wallet-chip');
  await until(page, () => /Balance/.test(document.querySelector('#pay-side').textContent));
  const swapped = async (what) => { await page.click('#go'); await until(page, () => /Done|failed|would fail|Nothing was sent/i.test(document.querySelector('#q').textContent), null, 180000); return (await page.textContent('#q')).trim(); };
  await pick(page, 'get', 'USDC');
  await typeAmt(page, '0.1'); await quoted(page); await ackIf(page);
  ok((await page.textContent('#go')).trim() === 'Buy USDC', `ETH → USDC is a buy of USDC (${(await page.textContent('#go')).trim()})`);
  { const u0 = await bal(USDC, w.account), said = await swapped(), u1 = await bal(USDC, w.account);
    ok(/Done/.test(said) && u1 > u0, `ETH → USDC landed on the best route: ${Number(u1 - u0) / 1e6} USDC (${said.slice(0, 80)})`); }
  await pick(page, 'pay', 'USDC'); await pick(page, 'get', 'DAI');
  await typeAmt(page, '50'); await quoted(page); await ackIf(page);
  { const d0 = await bal(DAI, w.account), u0 = await bal(USDC, w.account), signs = walletLog.signs, said = await swapped(), d1 = await bal(DAI, w.account), u1 = await bal(USDC, w.account);
    ok(/Done/.test(said) && d1 > d0 && u0 - u1 === 50n * 10n ** 6n, `USDC → DAI: exactly 50 USDC spent, ${Number(d1 - d0) / 1e18} DAI got (${said.slice(0, 80)})`);
    ok(walletLog.signs > signs || walletLog.sends.length >= 2, 'the USDC reached zRouter by its permit or an allowance'); }
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
}

// ── a wallet: ETH → TAC, USDC → TAC by permit, TAC → ETH by permit, then the farm ──
{
  const w = await fundedWallet();
  const { browser, page, errors, blocked, walletLog } = await openPage({ width: 1280, height: 900 }, { wallet: w });
  await page.click('#wallet-chip');
  await until(page, () => /0x/.test(document.querySelector('#wallet-label').textContent));
  await until(page, () => /Balance/.test(document.querySelector('#pay-side').textContent));
  ok(true, 'the wallet connects and its balance shows');

  // Paying all the ETH held leaves nothing for the network fee: the button says so instead of failing its test.
  { const all = BigInt(await rpcA('eth_getBalance', [w.account, 'latest'])), whole = all / 10n ** 18n, frac = (all % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    await typeAmt(page, `${whole}${frac ? '.' + frac : ''}`); await quoted(page);
    ok((await page.textContent('#go')) === 'Leave some ETH for the network fee', `the whole ETH balance leaves room for gas (${await page.textContent('#go')})`); }
  // ETH → TAC
  await typeAmt(page, '0.2');
  await quoted(page);
  ok(/^Buy TAC$/.test(await page.textContent('#go')), 'the button buys TAC');
  const t0 = await bal(TAC, w.account);
  await page.click('#go');
  await until(page, () => /Done/.test(document.querySelector('#q').textContent), null, 180000);
  const t1 = await bal(TAC, w.account);
  ok(t1 > t0, `ETH → TAC landed: +${Number(t1 - t0) / 1e18} TAC`);

  // ETH → TAC to another address: the address is checked, then the TAC goes there and the wallet gets none of it
  {
    const other = JSON.parse(cast('wallet', 'new', '--json'))[0].address, good = cast('to-check-sum-address', other);
    const flip = (a) => { const i = a.slice(2).search(/[a-fA-F]/) + 2; return a.slice(0, i) + (a[i] === a[i].toUpperCase() ? a[i].toLowerCase() : a[i].toUpperCase()) + a.slice(i + 1); };
    const note = async () => (await page.textContent('#to-note')).trim(), go = async () => (await page.textContent('#go')).trim();
    ok(await page.isHidden('#to-in') && (await page.textContent('#get-where')).trim() === 'to your wallet', 'the get side says "to your wallet" and keeps the address field closed');
    await page.click('#get-where');
    ok(await page.isVisible('#to-in') && (await page.getAttribute('#get-where', 'aria-expanded')) === 'true', 'it opens the address field');
    await typeAmt(page, '0.2'); await quoted(page);
    await page.fill('#to-in', '0x1234');
    ok(/Paste a full 0x address/.test(await note()) && (await go()) === 'Check the address' && await page.isDisabled('#go'), 'a short address is refused, and the button says to check it');
    await page.fill('#to-in', flip(good));
    ok(/checksum/.test(await note()) && await page.isDisabled('#go'), 'capitals that do not match the checksum are refused');
    await page.fill('#to-in', TAC);
    ok(/contract this swap uses/.test(await note()) && await page.isDisabled('#go'), 'the TAC token itself is not a wallet to send to');
    await page.fill('#to-in', '0x0000000000000000000000000000000000000000');
    ok(/contract this swap uses/.test(await note()), 'the zero address is refused');
    await page.fill('#to-in', other.toLowerCase());
    ok((await note()) === good && /^to 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/.test((await page.textContent('#get-where')).trim()) && !(await page.isDisabled('#go')), 'a right address typed in lowercase shows its checksummed form, and its short form on the get side');
    await page.fill('#to-in', good);
    ok((await note()) === '' && !(await page.isDisabled('#go')), 'the checksummed form needs no second line');
    ok(/^Buy TAC → 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/.test(await go()), `the button names where it sends (${await go()})`);
    ok(!page.url().toLowerCase().includes(other.slice(2, 12).toLowerCase()), 'the address is not put in the address bar');
    ok(!(await page.textContent('#get-side')).trim(), 'the get side shows no "You have" for the other address');
    const r0 = await bal(TAC, other), p0 = await bal(TAC, w.account), eb0 = BigInt(await rpcA('eth_getBalance', [w.account, 'latest']));
    const signs = walletLog.signs;
    await page.click('#go');
    await until(page, () => /Done/.test(document.querySelector('#q').textContent), null, 180000);
    const r1 = await bal(TAC, other), p1 = await bal(TAC, w.account), eb1 = BigInt(await rpcA('eth_getBalance', [w.account, 'latest']));
    ok(r1 > r0 && p1 === p0, `the TAC went to the other address (+${Number(r1 - r0) / 1e18}) and none to the wallet`);
    ok(eb0 - eb1 >= 2n * 10n ** 17n, 'the wallet paid the ETH');
    ok(/sent to 0x/.test(await page.textContent('#q')) && !(await page.$('[data-farm-it]')) && !(await page.$('[data-watch]')), 'the receipt says where it went, with no "Farm it" or "Add to wallet" for TAC that is not the wallet\'s');
    ok(await page.isHidden('#to-in') && (await page.inputValue('#to-in')) === '' && (await page.textContent('#get-where')).trim() === 'to your wallet', 'afterwards the address is cleared, so the next swap goes to the wallet');

    // the swaps are listed, newest first, and kept in this browser
    ok(await page.isVisible('#recent') && (await page.textContent('#recent summary')).trim() === 'Recent swaps', 'the page lists recent swaps once there are some');
    await page.click('#recent summary');
    const items = await page.$$eval('#recent-l li', (a) => a.map((li) => ({ t: li.textContent, h: li.querySelector('a')?.getAttribute('href') })));
    ok(items.length === 2 && /to 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/.test(items[0].t) && /^0\.2 ETH → [\d,.]+ TAC$/.test(items[1].t.replace(/just now.*$/, '').replace(/\d+ min ago$/, '').trim()) && items.every((x) => /^https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/.test(x.h)), `two swaps listed with their transactions, the one to another address first (${items.map((x) => x.t).join(' | ')})`);
    const p2 = await page.context().newPage();
    await p2.goto(page.url());
    await until(p2, () => !document.querySelector('#recent')?.hidden);
    ok((await p2.$$('#recent-l li')).length === 2, 'a new page in the same browser lists them again');
    await p2.close();
  }

  // USDC → TAC, signed for
  await pick(page, 'pay', 'USDC');
  await typeAmt(page, '300');
  await quoted(page);
  const signs0 = walletLog.signs, u0 = await bal(USDC, w.account);
  await page.click('#go');
  await until(page, () => /Done/.test(document.querySelector('#q').textContent), null, 180000);
  const t2 = await bal(TAC, w.account), u1 = await bal(USDC, w.account);
  ok(walletLog.signs === signs0 + 1 && walletLog.typed.at(-1).primaryType === 'Permit' && walletLog.typed.at(-1).domain.version === '2', 'USDC: one EIP-2612 permit signed (version 2), no approval sent');
  ok(t2 > t1 && u0 - u1 <= 300n * 10n ** 6n && u0 - u1 > 290n * 10n ** 6n, `USDC → TAC landed: +${Number(t2 - t1) / 1e18} TAC for ${Number(u0 - u1) / 1e6} USDC`);
  ok(await page.isVisible('[data-farm-it]'), 'after buying TAC: Farm it');
  await shot(page, 'wallet-done');

  // Farm it: the Precision farm opens on TAC with what was bought.
  await page.click('[data-farm-it]');
  await until(page, () => !document.querySelector('#p-earn').hidden && document.querySelector('#fm-tacamt') && document.querySelector('#fm-tacamt').value !== '');
  ok(true, 'Farm it opens the Precision farm on TAC, with the amount bought');
  // and the farm takes it: TAC's permit signed, zapped and staked in one transaction
  await until(page, () => /Farm with TAC/.test(document.querySelector('#fm-go')?.textContent || '') && !document.querySelector('#fm-go').disabled, null, 60000);
  const tf0 = await bal(TAC, w.account);
  await page.click('#fm-go');
  await until(page, () => /Farming\./.test(document.querySelector('#fm-status')?.textContent || ''), null, 180000);
  const tf1 = await bal(TAC, w.account);
  ok(tf1 < tf0, `the bought TAC is farmed from the swap page: ${Number(tf0 - tf1) / 1e18} TAC zapped and staked`);
  await until(page, () => document.querySelectorAll('#farms [data-farm]').length >= 2, null, 60000).catch(() => {});
  ok((await page.$$('#farms [data-farm]')).length >= 2, 'Earn lists the Precision farm and the private farms');
  const names = await page.$$eval('#farms [data-farm] .rt b', (a) => a.map((b) => b.textContent.trim()));
  ok(names.length >= 2 && names.slice(1).every((n) => /^tETH \/ \S+/.test(n)), `the private farms are named tETH first, as on the other pages (${names.join(' | ')})`);
  ok(await page.$eval('#farm .fm-prog', (e) => getComputedStyle(e).display === 'none').catch(() => false), 'the farm does not list the private farms a second time under its form: the picker above does');
  await (await page.$$('#farms [data-farm]'))[1].click();
  ok(/^\/#farm\/private-\d+$/.test(await page.$eval('#privfarm a', (a) => a.getAttribute('href'))), 'a private farm\'s link opens the farm itself, ready to join, not the card');
  await (await page.$$('#farms [data-farm]'))[0].click();
  await shot(page, 'wallet-earn');

  // TAC → ETH, signed for
  await page.click('#tab-swap');
  await pick(page, 'pay', 'TAC');
  ok((await page.textContent('#get-coin')).includes('ETH'), 'TAC sells for ETH');
  await typeAmt(page, '50');
  await quoted(page);
  const e0 = BigInt(await rpcA('eth_getBalance', [w.account, 'latest'])), t3 = await bal(TAC, w.account);
  await page.click('#go');
  await until(page, () => /Done/.test(document.querySelector('#q').textContent), null, 180000);
  const t4 = await bal(TAC, w.account);
  ok(t3 - t4 === 50n * 10n ** 18n, 'TAC → ETH spent exactly 50 TAC');
  // TAC → USDC: a Tacit asset sold for any token on the list, in one transaction
  {
    await pick(page, 'pay', 'TAC');
    await page.click('#get-coin');
    ok(await page.isVisible('.pk-r:has(b:text-is("USDC"))') && await page.isVisible('#pk-q'), 'with TAC to sell, the Get list offers the tokens on the list, and can be searched');
    await page.click('.pk-r:has(b:text-is("USDC"))');
    ok((await page.textContent('#get-coin')).includes('USDC') && (await page.textContent('#pay-coin')).includes('TAC'), 'TAC sells for USDC');
    const have = await bal(TAC, w.account), amt = String(Math.max(1, Math.floor(Number(have / 10n ** 18n) * 0.4)));
    await typeAmt(page, amt); await quoted(page);
    ok(/^Sell TAC$/.test((await page.textContent('#go')).trim()), 'the button sells TAC');
    ok(/Route\s*(Precision|Tacit) pool → (Uniswap|Curve|Sushi|zAMM)/.test((await page.textContent('#rcpt')).replace(/\s+/g, ' ')), `the receipt names the pool that buys the ETH and the one that sells it for USDC (${(await page.textContent('#rcpt')).replace(/\s+/g, ' ').slice(0, 120)})`);
    const usdc0 = await bal(USDC, w.account), tac0 = await bal(TAC, w.account);
    await page.click('#go');
    await until(page, () => /Done/.test(document.querySelector('#q').textContent), null, 180000);
    const usdc1 = await bal(USDC, w.account), tac1 = await bal(TAC, w.account);
    ok(tac0 - tac1 > 0n && tac0 - tac1 <= BigInt(amt) * 10n ** 18n && usdc1 > usdc0, `TAC → USDC landed in one transaction: ${Number(tac0 - tac1) / 1e18} TAC → ${Number(usdc1 - usdc0) / 1e6} USDC`);
    ok(/USDC/.test(await page.textContent('#q')), 'the receipt names the USDC received');
    await page.click('#flip');
    ok((await page.textContent('#pay-coin')).includes('USDC') && (await page.textContent('#get-coin')).includes('TAC'), 'the flip turns the sale back into a purchase of TAC');
    await typeAmt(page, '100'); await quoted(page);
    ok(/^Buy TAC$/.test((await page.textContent('#go')).trim()), 'and the button buys TAC with the USDC');
    await pick(page, 'pay', 'USDC'); await pick(page, 'get', 'tacUSD');
    if (DEPLOYED) ok((await page.textContent('#get-coin')).includes('tacUSD') && (await page.textContent('#pay-coin')).includes('USDC'), 'with TacitAmmRoute on chain, a token can be paid into tacUSD');
    else ok((await page.textContent('#get-coin')).includes('tacUSD') && (await page.textContent('#pay-coin')).includes('ETH') && !(await page.textContent('#pay-coin')).includes('USDC'), 'while TacitAmmRoute is not deployed, a token cannot be paid into tacUSD: choosing tacUSD moves the pay side to ETH');
  }
  ok(walletLog.sends.every((s) => !/^0x095ea7b3/.test(s.data)) || walletLog.typed.length >= 2, `sales sign rather than approve where they can (${walletLog.sends.length} sends, ${walletLog.signs} signatures)`);
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  ok(!blocked.length, `nothing blocked by the CSP${blocked.length ? ': ' + blocked.slice(0, 3).join(' | ') : ''}`);
  void e0;
  await browser.close();
}

// ── TacitAmmRoute is deployed: any token into tacUSD, in one transaction ──
{
  const CUSD = '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564', DEPLOYER = '0x' + 'd3'.repeat(20);
  await rpcA('anvil_impersonateAccount', [DEPLOYER]); await rpcA('anvil_setBalance', [DEPLOYER, '0x' + (5n * 10n ** 18n).toString(16)]);
  ok(ammRouteAddressMatches(), 'the compiled TacitAmmRoute lands at the address route.js names');
  await rpcA('eth_sendTransaction', [{ from: DEPLOYER, ...ammRouteDeployTx(), gas: '0x2dc6c0' }]);
  const w = await fundedWallet();
  const { browser, page, errors, blocked } = await openPage({ width: 1280, height: 900 }, { wallet: w });
  await page.click('#wallet-chip');
  await until(page, () => /0x/.test(document.querySelector('#wallet-label').textContent));
  await until(page, () => /Balance/.test(document.querySelector('#pay-side').textContent));
  await pick(page, 'pay', 'USDC'); await pick(page, 'get', 'tacUSD');
  ok((await page.textContent('#get-coin')).includes('tacUSD'), 'once TacitAmmRoute is deployed, the page offers USDC → tacUSD');
  await typeAmt(page, '150'); await quoted(page);
  if (await page.$('#ack')) await page.check('#ack');
  ok(/^Buy tacUSD$/.test((await page.textContent('#go')).trim()), `the button buys tacUSD (${(await page.textContent('#go')).trim()})`);
  ok(/Route\s*(Uniswap|Curve|Sushi|zAMM).* → Tacit pool/.test((await page.textContent('#rcpt')).replace(/\s+/g, ' ')), 'the receipt names the pool that sells the ETH and the Tacit pool that buys tacUSD with it');
  const c0 = await bal(CUSD, w.account), u0 = await bal(USDC, w.account);
  await page.click('#go');
  await until(page, () => /Done/.test(document.querySelector('#q').textContent), null, 180000);
  const c1 = await bal(CUSD, w.account), u1 = await bal(USDC, w.account);
  ok(c1 > c0 && u0 - u1 > 0n && u0 - u1 <= 150n * 10n ** 6n, `USDC → tacUSD landed in one transaction: ${Number(u0 - u1) / 1e6} USDC → ${Number(c1 - c0) / 1e18} tacUSD`);
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  ok(!blocked.length, `nothing blocked by the CSP${blocked.length ? ': ' + blocked.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
}
// a shared link to a pair that needs TacitAmmRoute opens on it once the page has found the contract, and leaves a pair the visitor chose meanwhile alone
{
  const { browser, page, errors } = await openPage({ width: 1280, height: 900 }, { path: '/swap/?from=USDC&to=cusd&amt=150' });
  await until(page, () => /USDC/.test(document.querySelector('#pay-coin')?.textContent || '') && /tacUSD/.test(document.querySelector('#get-coin')?.textContent || ''), null, 60000);
  ok((await page.inputValue('#amt')) === '150', 'a link to pay 150 USDC for tacUSD opens on USDC → tacUSD with its amount, though the contract is only found after the page has read the link');
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
  await browser.close();
}

// ── a shared link naming a token from the onchain list waits for the list, and keeps its amount in that token ──
{
  const { browser, page, errors } = await openPage({ width: 1280, height: 900 }, { path: '/swap/?from=LUSD&amt=100' });
  await until(page, () => /LUSD/.test(document.querySelector('#pay-coin')?.textContent || ''), null, 90000);
  ok((await page.inputValue('#amt')) === '100' && (await page.textContent('#get-coin')).includes('TAC'), 'a link to pay 100 LUSD opens on 100 LUSD → TAC');
  await quoted(page);
  ok(/Price impact/.test(await page.textContent('#rcpt')), 'a token with no dollar price of its own still shows its price impact (through the WETH it buys)');
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
  await browser.close();
}

// ── an old link's ?to=cusd still opens on the same token, now named tacUSD ──
{
  const { browser, page, errors } = await openPage({ width: 1280, height: 900 }, { path: '/swap/?to=cusd' });
  ok((await page.textContent('#get-coin')).includes('tacUSD'), 'an old ?to=cusd link opens on tacUSD');
  await sidePriv(page, 'get', true);
  ok((await page.textContent('#get-coin')).includes('cUSD') && !(await page.textContent('#get-coin')).includes('tacUSD'), 'on a private side the same token is the cUSD note');
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
}

// ── the first paint needs the HTML alone, the private door's modules wait for someone going to it, the button stays in view, the picker keeps Tab ──
{
  const { browser, page, errors } = await openPage({ width: 1280, height: 700 });
  await until(page, () => document.querySelector('#pxs')?.classList.contains('on'));
  const res = () => page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
  ok(!(await res()).some((u) => /\/chrome\.css/.test(u)) && (await page.evaluate(() => getComputedStyle(document.querySelector('footer.sf')).display)) === 'flex', 'the shared header and footer styles are in the page, not a request the first paint waits for');
  ok(!(await res()).some((u) => /confidential-pool-ux|confidential-pool\.js/.test(u)), 'the private door\'s modules are not fetched by a page that stays public');
  await page.hover('.sides[data-side="get"] [data-p="1"]');
  await until(page, () => performance.getEntriesByType('resource').some((e) => /confidential-pool-ux/.test(e.name)) && performance.getEntriesByType('resource').some((e) => /confidential-pool\.js/.test(e.name)), null, 60000);
  ok(true, 'going toward Private fetches its modules, all at once');
  await page.click('[data-slip="100"]');
  await page.reload();
  await until(page, () => document.querySelector('#slip [aria-pressed="true"]'));
  ok((await page.getAttribute('#slip [aria-pressed="true"]', 'data-slip')) === '100', 'the slippage chosen is kept for the next visit');
  await page.click('[data-slip="50"]');
  await typeAmt(page, '1');
  await quoted(page);
  const act = await page.evaluate(() => { const g = document.querySelector('#go').getBoundingClientRect(); return { sticky: getComputedStyle(document.querySelector('.act')).position, bottom: g.bottom, top: g.top, h: innerHeight, card: document.querySelector('#sw').getBoundingClientRect().bottom }; });
  ok(act.sticky === 'sticky' && act.top >= 0 && act.bottom <= act.h, `the button stays in view under a long quote (card ends at ${Math.round(act.card)}, button at ${Math.round(act.top)}–${Math.round(act.bottom)} of ${act.h})`);
  await page.click('#pay-coin');
  await page.focus('.pk-x');
  await page.keyboard.press('Shift+Tab');
  ok(await page.evaluate(() => document.activeElement.classList.contains('pk-r') && !!document.activeElement.closest('.pk-s')), 'Shift+Tab from the picker\'s first control wraps to its last');
  await page.keyboard.press('Tab');
  ok(await page.evaluate(() => document.activeElement.classList.contains('pk-x')), 'and Tab from the last wraps to the first');
  await page.keyboard.press('Escape');
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
}

// ── fonts that arrive late move nothing; the radio groups take the arrow keys; the whole receipt clears the button's bar at 900 px ──
{
  const { browser, page } = await openPage({ width: 390, height: 844 }, { fontDelay: 900, shifts: true });
  await until(page, () => document.querySelector('#pxs')?.classList.contains('on'));
  await page.evaluate(() => document.fonts.ready);
  await sleep(500);
  const cls = await page.evaluate(() => window.__cls);
  ok(cls < 0.005, `fonts arriving late move nothing (layout shift ${cls.toFixed(4)})`);
  await browser.close();
}
{
  const { browser, page, errors } = await openPage({ width: 1440, height: 900 });
  await until(page, () => document.querySelector('#pxs')?.classList.contains('on'));
  const G = '.sides[data-side="get"]';
  await page.focus(`${G} [data-p="0"]`);
  await page.keyboard.press('ArrowRight');
  ok((await page.getAttribute(`${G} [data-p="1"]`, 'aria-checked')) === 'true' && await page.evaluate(() => document.activeElement.dataset.p === '1'), 'the arrow keys move a side from Wallet to Private, the focus with them');
  await page.keyboard.press('ArrowLeft');
  ok((await page.getAttribute(`${G} [data-p="0"]`, 'aria-checked')) === 'true' && await page.evaluate(() => document.activeElement.dataset.p === '0'), 'and back');
  await typeAmt(page, '1');
  await quoted(page);
  if ((await page.$$('#rows [data-route]')).length >= 2) {
    await page.focus('#rows [aria-checked="true"]');
    const was = await page.evaluate(() => document.activeElement.dataset.route);
    await page.keyboard.press('ArrowDown');
    const now = await page.evaluate(() => ({ k: document.activeElement.dataset.route, on: document.activeElement.getAttribute('aria-checked') }));
    ok(!!now.k && now.k !== was && now.on === 'true', 'the arrow keys choose the next route and keep the focus on it');
  }
  const fit = await page.evaluate(() => ({ bar: document.querySelector('.act').getBoundingClientRect().top, last: Math.max(...[...document.querySelectorAll('#rcpt div')].map((e) => e.getBoundingClientRect().bottom)) }));
  ok(fit.last <= fit.bar + 1, `the whole receipt clears the button's bar at 900 px (ends ${Math.round(fit.last)}, the bar starts ${Math.round(fit.bar)})`);
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
}

// ── a phone, light and dark: no sideways scroll; the bare address finds the page ──
for (const [scheme, width] of [['light', 360], ['dark', 390]]) {
  const { browser, page, errors } = await openPage({ width, height: 800 }, { scheme, path: '/swap' });
  await until(page, () => location.pathname === '/swap/' && document.querySelector('#pxs')?.classList.contains('on'));
  await typeAmt(page, '1');
  await quoted(page);
  ok(await overflow(page) <= 0, `${scheme} ${width}px: no sideways scroll`);
  await page.click('#pay-coin');
  ok(await page.isVisible('.pk-s'), `${scheme} ${width}px: the picker opens`);
  await shot(page, `phone-${scheme}-picker`);
  await page.keyboard.press('Escape');
  await page.click('#tab-earn');
  await until(page, () => document.querySelector('#fm-stats') && !/Reading/.test(document.querySelector('#fm-stats').textContent), null, 60000).catch(() => {});
  ok(await overflow(page) <= 0, `${scheme} ${width}px earn: no sideways scroll`);
  await shot(page, `phone-${scheme}-earn`);
  await page.click('#tab-swap');
  await page.evaluate(() => document.querySelector('#how').scrollIntoView());
  await shot(page, `phone-${scheme}-how`);
  ok(!errors.length, `${scheme} ${width}px: no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
}

server.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
