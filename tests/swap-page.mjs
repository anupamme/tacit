#!/usr/bin/env node
// dapp/swap/ in a real browser, under its own CSP, with Ethereum an anvil fork of mainnet (zQuoter's scan of every pool, a read a fork
// makes slowly, goes to the upstream node at the fork's block). Checks the page loads clean; the quotes for ETH → TAC (with its routes),
// USDC → TAC, ETH → cUSD (a price far under the market has to be accepted first) and a private swap (priced here, handed to the front
// page's console); then, with a wallet that signs with a real key, buys TAC with ETH, buys TAC with USDC by permit, sells TAC by permit,
// and opens the farm on what was bought. A phone and a dark screen have no sideways scroll.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/swap-page.mjs        (SHOTS=dir saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://ethereum-rpc.publicnode.com', SHOTS = process.env.SHOTS || null;
const PORT = 22000 + Math.floor(Math.random() * 1000), WEB = PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ZQUOTER = '0x000000bd2db80567c23e353ca95a251c573cbf9b';
const up = async (method, params) => (await (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
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

async function openPage(viewport, { wallet = null, path = '/swap/', scheme = 'light' } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const walletLog = wallet ? await stubWallet(ctx, wallet) : null;
  await ctx.addInitScript(() => { try { localStorage.setItem('tacit-trade-hedge-ms', '0'); } catch { /* storage is a convenience */ } });
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
const pick = async (page, side, sym) => { await page.click(side === 'pay' ? '#pay-coin' : '#get-coin'); await page.click(`.pk-r:has(b:text-is("${sym}"))`); };

// ── no wallet: the page, the quotes, the gate, the private hand-off ──
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
  ok(!sp || (/\d+% \/ \d+% · [\d,]+\+ points/.test(sp) && Number(sp.match(/([\d,]+)\+ points/)[1].replace(/,/g, '')) < 500), `a split earns on its Precision leg only (${sp.slice(0, 80) || 'no split offered'})`);
  ok((await page.textContent('#go')) === 'Connect wallet', 'without a wallet the button connects one');
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

  // Choosing cUSD while paying USDC puts ETH on the pay side: the 500 typed in USDC is not kept as 500 ETH.
  await pick(page, 'get', 'cUSD');
  ok((await page.textContent('#pay-coin')).includes('ETH') && (await page.inputValue('#amt')) === '', 'a pay side that follows a choice clears the amount typed in the old asset');

  // cUSD from the Tacit pool, priced far from a dollar: accepted first.
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
  ok(gated ? /under/.test(await page.textContent('#ackbox')) : true, `cUSD: ${gated ? 'a price far under the market is gated' : 'priced near the market, no gate'}`);
  if (gated) {
    ok(/Borrow cUSD at \$1/.test(await page.textContent('#ackbox')), 'the gate offers the vault');
    ok((await page.textContent('#go')).startsWith('Connect') || await page.isDisabled('#go'), 'the button waits for the acceptance (or a wallet)');
  }
  await shot(page, 'desktop-cusd');

  // Private: priced here, handed to the console.
  await page.click('[data-mode="private"]');
  await pick(page, 'pay', 'ETH');
  await pick(page, 'get', 'TAC');
  await typeAmt(page, '0.25');
  await quoted(page);
  ok((await page.textContent('#go')) === 'Continue privately →', 'private: the button continues in the Tacit app');
  ok(/Relay fee/.test(await page.textContent('#rcpt')), 'private: the relay fee is shown');
  ok(await page.$eval('#f-get', (e) => e.classList.contains('priv')), 'private: the get field is dashed');
  await shot(page, 'desktop-private');
  await Promise.all([page.waitForURL(/#card=swap:ether:tac:private&amt=0\.25|\/$/), page.click('#go')]);
  await sleep(1500);
  ok(/\/$|\/#/.test(new URL(page.url()).pathname + new URL(page.url()).hash) || page.url().endsWith('/'), `the console opens (${page.url().replace(/^http:\/\/[^/]+/, '')})`);
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  ok(!blocked.length, `nothing blocked by the CSP${blocked.length ? ': ' + blocked.slice(0, 3).join(' | ') : ''}`);
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
  ok(walletLog.sends.every((s) => !/^0x095ea7b3/.test(s.data)) || walletLog.typed.length >= 2, `sales sign rather than approve where they can (${walletLog.sends.length} sends, ${walletLog.signs} signatures)`);
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  ok(!blocked.length, `nothing blocked by the CSP${blocked.length ? ': ' + blocked.slice(0, 3).join(' | ') : ''}`);
  void e0;
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
