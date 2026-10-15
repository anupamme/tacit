// Checks the relay page (dapp/relay/) in a real browser with the API's /relay/economics stubbed: the buyback's totals and the commitment, the
// fee table, the costs, the tips and the splitter's shares; then the states with no books yet, an API that fails, and a phone.
//
//   PLAYWRIGHT=<path to playwright-core> node tools/relay-page-check.mjs   (SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const WEB = 24000 + Math.floor(Math.random() * 2000), ROOT = `http://127.0.0.1:${WEB}`;
let fails = 0;
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };

const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, ROOT).pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(WEB, r));

const day = (date, o = {}) => ({ date, settled: 40, priced: 25, unpriced: 12, proveOnly: 3, gasEth: 0.012, proveIn: 30, buybackEth: 0.0004, splitterSends: 1, feeUsd: { eth: 14, converted: 3, convertible: 17 }, ...o });
const FULL = {
  updatedAt: new Date().toISOString(),
  ledger: {
    since: '2026-10-12T09:00:00.000Z', stale: false, owedEth: 0.0003,
    cfg: { buybackBps: 1000, buybackKeepEth: 0.002, buybackMinSendEth: 0.0002, splitter: '0x' + '5'.repeat(40), buyback: '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250' },
    recent: [day('2026-10-14'), day('2026-10-15', { settled: 22, buybackEth: 0.0002 })],
    week: { days: 2, settled: 62, priced: 40, unpriced: 20, proveOnly: 5, gasEth: 0.02, proveIn: 55, buybackEth: 0.0006, splitterSends: 2, feeUsd: { eth: 24, converted: 5, convertible: 29 } },
  },
  chain: {
    head: 26_200_000, wallets: { settle: { address: '0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331', eth: 0.003 }, relay: { address: '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7', eth: 0.001, prove: 4 } },
    buyback: { address: '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250', ethHeld: 0.0004, buys: 3, ethSpent: 0.0123, tacBought: 187.4, lastBuyBlock: 26_199_000, complete: true },
    tips: { at: 1, days: 30, wraps: 122, eth: 0.032, byRecipient: [{ to: '0x006cd14f36f65ecbb29b2519ccbe63a0dc8549f2', eth: 0.031 }, { to: '0x' + '5'.repeat(40), eth: 0.001 }], complete: true },
    splitter: { address: '0x' + '5'.repeat(40), ethHeld: 0.0002, shares: [{ to: '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7', weight: '63', percent: '63' }, { to: '0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331', weight: '27', percent: '27' }, { to: '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250', weight: '10', percent: '10' }] },
  },
  prices: { ethUsd: 2400, proveUsd: 0.18 },
  sponsorship: { day: '2026-10-15', total: { used: 20, cap: 300 }, classes: { onboard: { used: 3, cap: 12 }, farm: { used: 8, cap: 8 }, wrap: { used: 2, cap: null }, other: { used: 1, cap: 4 } } },
};
let mode = 'full';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const CORS = { 'access-control-allow-origin': '*' };
await ctx.route('https://api.tacit.finance/relay/economics', (route) => {
  if (mode === 'down') return route.fulfill({ status: 503, headers: CORS, body: 'down' });
  const body = mode === 'empty' ? { updatedAt: new Date().toISOString(), ledger: null, chain: { ...FULL.chain, tips: null, splitter: null, buyback: { ...FULL.chain.buyback, buys: 1, tacBought: 19.93, ethSpent: 0.00123, complete: false } }, prices: null } : FULL;
  route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const text = (s) => page.$eval(s, (e) => e.textContent).catch(() => '');
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/relay-${n}.png`, fullPage: true }); };

try {
  await page.goto(`${ROOT}/relay/`);
  await page.waitForFunction(() => /TAC bought/.test(document.querySelector('#p-buyback')?.textContent || ''), null, { timeout: 15000 });
  let t = await text('#p-buyback');
  ok(/187\.4TAC bought/.test(t) && /3 buys for 0\.0123 ETH/.test(t) && /the last 3 hours ago/.test(t), `buyback: what it bought and when (${t.slice(18, 120)})`);
  ok(/10% of the relay’s fee income/.test(t) && /Sent in the last 2 days0\.0006 ETH/.test(t) && /Carried to the next pass0\.0003 ETH/.test(t) && /Waiting in the contract0\.0004 ETH/.test(t), 'buyback: the commitment, what was sent, what is carried, what waits');
  t = await text('#p-fees');
  ok(/\$29in ETH and converted tokens/.test(t) && /Settled for a fee40/.test(t) && /Settled with no fee20/.test(t) && /Proved for the sender to settle5/.test(t) && /Paid in ETH\$24/.test(t), `fees: the week's income and the job counts (${t.slice(0, 110)})`);
  ok(/10-15/.test(t) && /10-14/.test(t) && /Counted from 2026-10-12 09:00 UTC/.test(t), 'fees: the daily table and where the books start');
  const tacNote = await page.$$eval('#p-fees .note', (els) => els.map((e) => e.textContent).find((x) => /paid in TAC/.test(x)) || '');
ok(/Fees paid in TAC are kept, not sold/.test(tacNote) && !/\$/.test(tacNote), 'fees: a fee paid in TAC is said to be kept, with no dollar value put on it');
  t = await text('#p-costs');
  ok(/Gas paid to settle0\.02 ETH · \$48/.test(t) && /PROVE put into the prover55 PROVE · \$9\.9/.test(t), `costs: gas and PROVE, in ETH and dollars (${t.slice(0, 120)})`);
  ok(/Fees pay part of all this; the team funds the rest/.test(t), 'costs: says the team funds the rest');
  ok(/Settles the relay pays for today/.test(t) && /Bridge and cBTC mints3 of 12/.test(t) && /Farm harvests and unbonds8 of 8/.test(t) && /Wraps with no tip2 so far/.test(t) && /Other requests with no fee1 of 4/.test(t) && /settled from the sender’s own account/.test(t), `costs: today's sponsored settles against each limit (${t.slice(-330)})`);
  t = await text('#p-tips');
  ok(/122wraps tipped, 0\.032 ETH/.test(t) && /To Ops multisig0\.031 ETH/.test(t) && /Deployer wallet63%/.test(t) && /Settle wallet27%/.test(t) && /TAC buyback10%/.test(t), `tips: the month's tips, where they went and who the splitter pays (${t.slice(0, 130)})`);
  ok(/send it to a splitter/.test(await text('#flow-tips')), 'flow: with a splitter set, the tip line names it');
  const all = await page.evaluate(() => document.body.textContent);
  ok(!/0\.003 ETH|0\.001 ETH.*4 PROVE|runway|low on gas|running low/i.test(all) && !/68575b073de49a94e3e3acf6f3a0d6e3b66267c7.*\bETH\b.*held/i.test(all), 'no wallet balance or runway is shown on the public page');
  await shot('full');

  mode = 'empty';
  await page.reload();
  await page.waitForFunction(() => /TAC bought/.test(document.querySelector('#p-buyback')?.textContent || ''), null, { timeout: 15000 });
  ok(/goes to the ops multisig/.test(await text('#flow-tips')), 'flow: with no splitter, the tip line says the multisig gets the tips');
  ok(/not reported its books yet/.test(await text('#p-fees')) && /not reported its books yet/.test(await text('#p-costs')), 'no books yet: fees and costs say so instead of showing zeros');
  ok(/19\.93TAC bought/.test(await text('#p-buyback')) && /Still reading the contract/.test(await text('#p-buyback')) && /not set/.test(await text('#p-buyback')), 'no books yet: the buyback still shows what it bought, says it is still reading, and says no commitment is set');

  mode = 'down';
  await page.reload();
  await page.waitForFunction(() => /Could not read the relay/.test(document.querySelector('#p-buyback')?.textContent || ''), null, { timeout: 15000 });
  ok(true, 'an API that fails is said plainly, on every panel');

  mode = 'full';
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload();
  await page.waitForFunction(() => /TAC bought/.test(document.querySelector('#p-buyback')?.textContent || ''), null, { timeout: 15000 });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: no sideways scroll');
  await shot('phone');
  ok(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);
} catch (e) { fails++; console.log('FAIL', e.message.split('\n')[0]); await shot('failure').catch(() => {}); }
finally { await browser.close(); server.close(); }
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
