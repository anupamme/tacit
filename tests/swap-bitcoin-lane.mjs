#!/usr/bin/env node
// dapp/swap/ in a real browser, under its own CSP: the Bitcoin lane (the third switch under the card's title) swaps tETH and TAC in the Bitcoin pool with a
// Tacit key. The page and the lane are the real files; tacit.js (through /trade/btc.js) is a stand-in that holds a key, a pool and a few balances and
// records what the lane asks of it, so nothing here reaches Bitcoin or Ethereum. The stand-in's quote is the pool's constant-product formula.
//   checks: the switch and its address; the pool and a quote before any key is open; the price warning and the acknowledgement it asks for; opening the key;
//   balances; the bridged note's move (asked first, then made); the swap (its floor, the exact amount, what it says while it settles and after);
//   flipping the pair; going back to the wallet lane; a link to #bitcoin; a phone width.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/swap-bitcoin-lane.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// The stand-in for /trade/btc.js: the lane's only door to tacit.js.
const STUB = `
const TETH = '${TETH}', TAC = '${TAC}';
const W = window.__stub = { calls: [], unlocked: false, outcome: 'waiting', sats: 60000, need: 4000, bridged: true, bal: { [TETH]: 5000000n, [TAC]: 0n }, fail: {} };
const rec = (name, args) => W.calls.push({ name, args });
const pool = { pool_id: 'aa'.repeat(32), asset_a: TETH, asset_b: TAC, reserve_a: '20000', reserve_b: '182704255', fee_bps: 30, validation: 'xcurve-verified' };
const T = {
  wallet: { address: () => 'bc1qtestaddress0000000000000000000000000' },
  bitcoinSwapPools: async () => [pool],
  bitcoinSwapFundsNeeded: async () => W.need,
  bitcoinSwapQuote: async ({ fromAid, toAid, amountIn, slipBps = 100 }) => {
    const din = BigInt(amountIn), dir = fromAid === pool.asset_a ? 0 : 1, ra = BigInt(pool.reserve_a), rb = BigInt(pool.reserve_b), g = 9970n;
    const out = dir === 0 ? (rb * g * din) / (ra * 10000n + g * din) : (ra * g * din) / (rb * 10000n + g * din);
    return { kind: 'direct', poolId: pool.pool_id, direction: dir, feeBps: 30, reserveA: ra, reserveB: rb, deltaOut: out, minOut: (out * (10000n - BigInt(slipBps))) / 10000n, pending: W.pending || 0 };
  },
  getUtxos: async () => [{ txid: 'ee'.repeat(32), vout: 0, value: W.sats }],
  scanHoldings: async () => new Map([[TETH, { balance: W.bal[TETH], utxos: [] }], [TAC, { balance: W.bal[TAC], utxos: [] }]]),
  bridgedAtTaproot: async () => ({ count: W.bridged ? 1 : 0, address: 'bc1ptest' }),
  bridgedNotes: async (aid) => ({ notes: W.bridged && aid === TETH ? [{ txid: 'bb'.repeat(32), vout: 0, sats: 546, amount: 10000000n, confirmed: true, openErr: null }] : [], unread: 0 }),
  moveBridgedNote: async (o) => { rec('move', { txid: o.txid, assetIdHex: o.assetIdHex }); o.onProgress?.('commit-start'); o.onProgress?.('reveal-start'); if (W.fail.move) throw new Error(W.fail.move); W.bridged = false; return { reveal_txid: 'dd'.repeat(32) }; },
  bitcoinSwap: async (o) => { rec('swap', { fromAid: o.fromAid, toAid: o.toAid, amountIn: String(o.amountIn), minOut: String(o.minOut) }); for (const s of ['check', 'prepare', 'send']) { o.onProgress?.(s); await new Promise((r) => setTimeout(r, 30)); } if (W.fail.swap) throw new Error(W.fail.swap); return { revealTxid: 'cc'.repeat(32), quoted: 1n, floor: o.minOut }; },
  bitcoinSwapOutcome: async () => (W.outcome === 'filled' ? { state: 'filled', got: 16500000n } : W.outcome === 'refunded' ? { state: 'refunded', reason: 'floor miss', refund: 2000n } : { state: 'waiting' }),
};
const session = { key: null, get unlocked() { return W.unlocked; }, load: async () => T };
export function makeBitcoin({ onChange }) {
  return { session, signIn: async () => { W.unlocked = true; session.key = { pubHex: '02' + 'ab'.repeat(32) }; rec('signIn', {}); onChange?.(); }, fund: () => rec('fund', {}) };
}`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();

async function fresh(path = '/swap/', viewport = { width: 1100, height: 1000 }) {
  const page = await b.newPage({ viewport });
  const errs = [], csp = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 160)); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const req = route.request();
    if (/publicnode|drpc|1rpc|tenderly/.test(req.url())) {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch { /* not JSON */ }
      const err = (id) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'offline in this test' } });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map((x) => err(x.id)) : err(body.id)) });
    }
    return route.abort();
  });
  await page.route(/\/trade\/btc\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sw');
  return { page, errs, csp };
}
const text = async (page, sel) => (await page.textContent(sel).catch(() => '') || '').replace(/\s+/g, ' ').trim();
const visible = (page, sel) => page.isVisible(sel);
const calls = (page, name) => page.evaluate((nm) => window.__stub.calls.filter((c) => c.name === nm).map((c) => c.args), name);
const laneReady = (page) => page.waitForFunction(() => document.querySelector('#b-go') && document.querySelector('#b-go').textContent !== 'Loading…' && !/Loading/.test(document.querySelector('#b-q')?.textContent || ''), null, { timeout: 15000 });
const type = async (page, v) => { await page.fill('#b-amt', v); await page.waitForFunction(() => !document.querySelector('#b-out').classList.contains('ph'), null, { timeout: 8000 }); };

console.log('the switch');
{
  const { page, errs, csp } = await fresh();
  const radios = await page.$$eval('.mode [role=radio]', (els) => els.map((e) => [e.dataset.mode, e.getAttribute('aria-checked')]));
  ok(radios.length === 3 && radios[2][0] === 'bitcoin' && radios[0][1] === 'true', `a Bitcoin switch sits after To your wallet and Private (${JSON.stringify(radios)})`);
  ok(await page.getAttribute('[data-mode=bitcoin]', 'aria-label') === 'On Bitcoin', 'it is named "On Bitcoin" for a screen reader');
  ok(!(await visible(page, '#btc')) && await visible(page, '#f-pay'), 'the wallet card is shown and the lane is not');
  await page.click('[data-mode=bitcoin]');
  await laneReady(page);
  ok(page.url().endsWith('/swap/#bitcoin'), `the address says #bitcoin (${page.url()})`);
  ok(await visible(page, '#btc') && !(await visible(page, '#f-pay')) && !(await visible(page, '#go')), 'the lane replaces the wallet card');
  ok(await page.getAttribute('[data-mode=bitcoin]', 'aria-checked') === 'true' && await page.getAttribute('[data-mode=wallet]', 'aria-checked') === 'false', 'the switch shows Bitcoin');
  ok(/Open your Tacit wallet/.test(await text(page, '#b-go')), 'with no key open the button asks to open it');
  ok(/0\.0002 tETH · 1\.82704255 TAC/.test(await text(page, '#b-rcpt')) && /0\.30%/.test(await text(page, '#b-rcpt')), 'the pool and its fee are shown before any key is open');
  await page.click('[data-mode=wallet]');
  ok(await visible(page, '#f-pay') && !(await visible(page, '#btc')) && !page.url().includes('#bitcoin'), 'back to To your wallet: the wallet card returns and the address is clean');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('a quote, a price warning, the key, the balances');
{
  const { page, errs, csp } = await fresh('/swap/#bitcoin');
  await laneReady(page);
  ok(await visible(page, '#btc') && !(await visible(page, '#f-pay')), 'a link to #bitcoin opens the lane');
  await type(page, '0.00002');
  ok(await text(page, '#b-out') === '0.16564166', `0.00002 tETH quotes 0.16564166 TAC from the pool's formula (${await text(page, '#b-out')})`);
  const r = await text(page, '#b-rcpt');
  ok(/1 tETH ≈ 8282/.test(r) && /Least you get\s*0\.16398524 TAC/.test(r), `the price and the floor (1% under) are shown (${r.slice(0, 160)})`);
  ok(/Worse than the pool’s price by\s*9\.3%/.test(r) && await page.$eval('#b-rcpt dd.warn', (e) => !!e).catch(() => false), 'the price impact is stated and marked as a warning');
  ok(!(await visible(page, '#b-ack')), 'under 10% worse it asks for no acknowledgement');
  ok(/Open your Tacit wallet/.test(await text(page, '#b-go')) && !(await page.$eval('#b-go', (e) => e.disabled)), 'the button still asks for the key');
  await page.click('#b-go');
  await page.waitForFunction(() => window.__stub.unlocked && /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  ok(true, 'opening the key reads the balance: Balance 0.05 tETH');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/lane-quote.png` });
  ok(/^Swap$/.test(await text(page, '#b-go')) && !(await page.$eval('#b-go', (e) => e.disabled)), 'the button now says Swap');
  await type(page, '0.001');
  ok(/83%/.test(await text(page, '#b-rcpt')) && await visible(page, '#b-ack') && await page.$eval('#b-go', (e) => e.disabled), 'a swap 83% under the pool’s price asks to be accepted, and waits for it');
  await page.check('#b-ackbox');
  ok(!(await page.$eval('#b-go', (e) => e.disabled)), 'accepting enables the swap');
  await type(page, '0.5');
  ok(/Not enough tETH on Bitcoin/.test(await text(page, '#b-go')) && await page.$eval('#b-go', (e) => e.disabled), 'more than the key holds is refused');
  await page.click('[data-quick="0.0125"]');
  await page.waitForFunction(() => !document.querySelector('#b-out').classList.contains('ph'), null, { timeout: 8000 });
  ok(await page.inputValue('#b-amt') === '0.0125', 'a quick amount fills the box (25% of the balance) and quotes');
  await page.click('#b-slip [data-slip="300"]');
  await page.waitForFunction(() => document.querySelector('#b-slip [data-slip="300"]').getAttribute('aria-pressed') === 'true', null, { timeout: 4000 });
  ok(/Least you get/.test(await text(page, '#b-rcpt')), 'a wider slippage is kept and the quote is read again');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('the bridged note');
{
  const { page } = await fresh('/swap/#bitcoin');
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => document.querySelector('#b-brd') && !document.querySelector('#b-brd').hidden, null, { timeout: 8000 });
  const t = await text(page, '#b-brd');
  ok(/0\.1 tETH you bridged sits at your Taproot address, which a swap does not spend from/.test(t), `the note is named (${t})`);
  await page.click('[data-move]');
  const ask = await text(page, '#b-brd');
  ok(/Move 0\.1 tETH to your trading address\? One Bitcoin transaction, about 5,000 sats/.test(ask) && (await calls(page, 'move')).length === 0, 'it asks first, naming the fee, and moves nothing');
  await page.click('[data-move-no]');
  ok(!/Move 0\.1 tETH to your trading address\?/.test(await text(page, '#b-brd')) && (await calls(page, 'move')).length === 0, 'Cancel leaves it as it was');
  await page.click('[data-move]'); await page.click('[data-move-yes]');
  await page.waitForFunction(() => /Moved 0\.1 tETH/.test(document.querySelector('#b-q').textContent), null, { timeout: 8000 });
  const mv = await calls(page, 'move');
  ok(mv.length === 1 && mv[0].txid === 'bb'.repeat(32) && mv[0].assetIdHex === TETH, 'the move is asked for that note, as tETH');
  ok(/next Bitcoin block/.test(await text(page, '#b-q')) && await page.$eval('#b-q', (e) => e.classList.contains('ok')), 'it says it confirms with the next block');
  await page.close();
}
{
  const { page } = await fresh('/swap/#bitcoin');
  await page.evaluate(() => { window.__stub.sats = 1000; });
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => document.querySelector('#b-brd') && !document.querySelector('#b-brd').hidden, null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#b-bal').textContent.includes('Balance'), null, { timeout: 8000 });
  await page.click('[data-move]'); await page.click('[data-move-yes]');
  await page.waitForTimeout(300);
  ok((await calls(page, 'move')).length === 0 && /Add sats, then try again/.test(await text(page, '#b-q')) && (await calls(page, 'fund')).length === 1, 'with too few sats the move is not made, and the fund dialog opens');
  await page.close();
}

console.log('the swap');
{
  const { page, errs, csp } = await fresh('/swap/#bitcoin');
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.00002');
  await page.click('#b-go');
  await page.waitForFunction(() => /Sent/.test(document.querySelector('#b-q').textContent), null, { timeout: 8000 });
  const sw = await calls(page, 'swap');
  ok(sw.length === 1 && sw[0].fromAid === TETH && sw[0].toAid === TAC && sw[0].amountIn === '2000' && sw[0].minOut === '16398524', `the swap is asked for the exact amount with the floor shown (${JSON.stringify(sw[0])})`);
  const sent = await text(page, '#b-q');
  ok(/next Bitcoin block/.test(sent) && /never below 0\.16398524 TAC/.test(sent) && /your tETH comes back/.test(sent) && sent.includes('cccccccccc'), 'while it waits it says when it settles, the floor, and that a miss returns the tETH');
  ok((await page.getAttribute('#b-q a', 'href')) === `https://mempool.space/tx/${'cc'.repeat(32)}`, 'it links the transaction');
  ok(await page.inputValue('#b-amt') === '', 'the amount is cleared');
  await page.evaluate(() => { window.__stub.outcome = 'filled'; });
  await page.waitForFunction(() => /^Filled/.test(document.querySelector('#b-q').textContent), null, { timeout: 30000 });
  ok(/Filled .*0\.165 TAC/.test(await text(page, '#b-q')) && await page.$eval('#b-q', (e) => e.classList.contains('ok')), 'when the pool takes it, it says what was got');
  // a refund
  await type(page, '0.00002');
  await page.evaluate(() => { window.__stub.outcome = 'refunded'; });
  await page.click('#b-go');
  await page.waitForFunction(() => /returned/.test(document.querySelector('#b-q').textContent), null, { timeout: 30000 });
  ok(/The pool had moved past your floor, so your tETH was returned/.test(await text(page, '#b-q')) && await page.$eval('#b-q', (e) => e.classList.contains('err')), 'a swap the pool moved past says the tETH came back');
  // a failure
  await page.evaluate(() => { window.__stub.fail.swap = 'the pool moved past your floor: quote it again'; });
  await type(page, '0.00001');
  await page.click('#b-go');
  await page.waitForFunction(() => /quote it again/.test(document.querySelector('#b-q').textContent), null, { timeout: 8000 });
  ok(await page.$eval('#b-q', (e) => e.classList.contains('err')) && !(await page.$eval('#b-go', (e) => /Swapping/.test(e.textContent))), 'a swap that fails says why and frees the button');
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

console.log('the other direction, and sats');
{
  const { page } = await fresh('/swap/#bitcoin');
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.00002');
  await page.click('#b-flip');
  ok(/TAC/.test(await text(page, '#b-pay-coin')) && /tETH/.test(await text(page, '#b-get-coin')) && await page.inputValue('#b-amt') === '', 'flipping swaps the two sides and clears the amount');
  ok(/Balance 0 TAC/.test(await text(page, '#b-bal')), 'the balance follows the pay side');
  await type(page, '1');
  ok(/Not enough TAC on Bitcoin/.test(await text(page, '#b-go')), 'TAC the key does not hold is refused');
  await page.close();
}
{
  const { page } = await fresh('/swap/#bitcoin');
  await page.evaluate(() => { window.__stub.sats = 1000; });
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.00002');
  await page.waitForFunction(() => /Add sats for the Bitcoin fees/.test(document.querySelector('#b-go').textContent), null, { timeout: 8000 });
  ok(true, 'with fewer sats than the fees need, the button asks for sats');
  await page.click('#b-go');
  ok((await calls(page, 'fund')).length === 1 && (await calls(page, 'swap')).length === 0, 'pressing it opens the fund dialog and sends nothing');
  await page.close();
}

console.log('a phone');
{
  const { page, errs, csp } = await fresh('/swap/#bitcoin', { width: 360, height: 800 });
  await laneReady(page);
  await page.click('#b-go');
  await page.waitForFunction(() => /Balance 0\.05 tETH/.test(document.querySelector('#b-bal').textContent), null, { timeout: 8000 });
  await type(page, '0.00002');
  await sleep(300);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 0, `the lane has no sideways scroll at 360 px (${over})`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/lane-phone.png`, fullPage: true });
  ok(errs.length === 0 && csp.length === 0, `no page errors or CSP violations (${errs.concat(csp).join(' | ')})`);
  await page.close();
}

await b.close(); server.close();
console.log(`\n${n} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
