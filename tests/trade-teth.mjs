#!/usr/bin/env node
// dapp/trade/teth/ in a real browser, under the page's own CSP: what it reads (the pool's totals and ETH history, the private farms that pair
// tETH, the dollar rates), what it draws, and what it does when ETH is made private: the Tacit key opened from a stub Ethereum wallet's real
// signature, one transaction to the wrap forwarder carrying the deposit and the relay's tip, the relay's half, and every way that can stop.
// The API's answers are fixtures captured on 2026-10-14 (the flows moved so the newest is two hours old), the chain's reads are answered by the
// test, and the pool module (confidential-pool-ux.js) is a stand-in that records what it is asked: it is tested on its own elsewhere.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-teth.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, FX = new URL('./fixtures/', import.meta.url).pathname;
const WEB = 23100 + Math.floor(Math.random() * 800);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

const json = (n) => JSON.parse(readFileSync(join(FX, n), 'utf8'));
const stats = json('teth-stats-2026-10-14.json'), program = json('teth-program-2026-10-14.json'), quote = json('teth-quote-2026-10-14.json');
// tETH on Bitcoin: the API's answer for an asset with nothing on its book (the live one on 2026-10-14), and one with a book, made from TAC's fixtures of
// 2026-10-12 by moving them to tETH's id and price (a tETH is about 2.9 million sats, a TAC about 150) and size (a thousandth).
const BTC_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const idleAsset = { asset_id: BTC_ID, ticker: 'tETH', decimals: 8, trades: [], trades_cap: 1000, volume_24h_sats: 0, holder_count: 3, transfer_count: 2, listing_count: 0 };
function activeMarket() {
  const soon = nowS() + 7 * 86400, asset = json('tac-asset-2026-10-12.json'), sales = json('tac-sales-2026-10-12.json'), bids = json('tac-bids-2026-10-12.json'), P = 18.75, A = 1000;
  const shift = nowS() - 3600 - Math.max(...asset.trades.map((t) => t.ts));
  const trades = asset.trades.map((t) => ({ ...t, ts: t.ts + shift, price_sats: Math.round(t.price_sats * P), amount: String(BigInt(t.amount) / BigInt(A)) }));
  const last = trades.at(-1);
  return {
    asset: { ...asset, asset_id: BTC_ID, ticker: 'tETH', trades, last_trade: last, mark_price: { unit: asset.mark_price.unit * P * A, source: 'last_trade', ts: last.ts }, volume_24h_sats: 12345678, holder_count: 41, listing_count: sales.sales.length, price_first_trade_ts: trades[0].ts },
    sales: { ...sales, asset_id: BTC_ID, sales: sales.sales.map((x) => ({ ...x, asset_id: BTC_ID, asset_opening: { amount: String(BigInt(x.asset_opening.amount) / BigInt(A)) }, min_price_sats: Math.round(x.min_price_sats * P), expiry: soon, expired: false, seller_pubkey: '02' + 'ab'.repeat(32) })) },
    bids: { ...bids, asset_id: BTC_ID, intents: bids.intents.map((x) => ({ ...x, asset_id: BTC_ID, amount: String(BigInt(x.amount) / BigInt(A)), price_sats: Math.round(x.price_sats * P), expiry: soon })) },
  };
}
const nowS = () => Math.floor(Date.now() / 1000);
// The fixture's flows, moved so the newest is two hours old.
{
  const f = stats.eth.series.flows, shift = nowS() - 7200 - Math.max(...f.map((x) => x[0]));
  stats.eth.series.flows = f.map(([t, v]) => [t + shift, v]); stats.eth.series.ins = stats.eth.series.ins.map(([t, v]) => [t + shift, v]); stats.eth.lastAt += shift;
}
const front = JSON.parse(JSON.stringify(stats)); delete front.eth.series.flows;
const HELD = BigInt(stats.eth.held.$n);
const WRAP_TIP = '0x000000D218B03db5837943b0b05DeA2965AE956e', RELAY = quote.recommendedTipRecipient, TIP = BigInt(quote.recommendedWrapTipWei);
const SPLITTER = '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9';
const ETH_USD = 2441, PER_ETH = 11000, ACCOUNT_BAL = 5n * 10n ** 18n;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout });
// SHOTS=<dir> keeps a picture at the moments worth looking at.
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();

// ── what the chain says: Multicall3's answer for the rates, balances, and the receipts of what the wallet sent ──
const w32 = (v) => BigInt(v).toString(16).padStart(64, '0');
const pad = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
function aggregate3Result(datas) {
  const tuples = datas.map((d) => { const h = d ? d.replace(/^0x/, '') : ''; return w32(d ? 1 : 0) + w32(64) + w32(h.length / 2) + pad(h); });
  let off = datas.length * 32, offs = '';
  for (const t of tuples) { offs += w32(off); off += t.length / 2; }
  return '0x' + w32(32) + w32(datas.length) + offs + tuples.join('');
}
const round = (answer) => '0x' + w32(1) + w32(BigInt(Math.round(answer * 1e8))) + w32(nowS()) + w32(nowS()) + w32(1);
const sqrtWord = '0x' + w32(BigInt(Math.round(Math.sqrt(PER_ETH) * 1e6)) * 10n ** 12n);
const sent = [];                                                                       // what the stub wallet was asked to send, in order
const chain = { rates: true, receipt: 'ok', quote: null, market: null };                            // `quote`: replaces the API's quote for a test
function rpcAnswer(req) {
  const { id, method, params } = req;
  const res = (result) => ({ jsonrpc: '2.0', id, result }), err = (message, code = -32000) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'eth_call') {
    if (!chain.rates) return err('stub: no rates');
    if (String(params[0].to).toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') return res(aggregate3Result([round(ETH_USD), round(83000), sqrtWord]));
    return err('stub: eth_call', 3);
  }
  if (method === 'eth_getBalance') return res('0x' + ACCOUNT_BAL.toString(16));
  if (method === 'eth_getTransactionReceipt') { const t = sent.find((x) => x.hash === params[0]); return res(t && chain.receipt !== 'none' ? { status: chain.receipt === 'ok' ? '0x1' : '0x0', logs: [], gasUsed: '0x5208', effectiveGasPrice: '0x1' } : null); }
  if (method === 'eth_blockNumber') return res('0x1000000');
  return err(`stub: ${method}`);
}

// ── the wallet: an EIP-1193 provider announced through EIP-6963 that signs for real and records what it is asked to send ──
async function stubWallet(ctx, { reject = false } = {}) {
  sent.length = 0;
  const j = JSON.parse(cast('wallet', 'new', '--json'))[0], account = j.address, log = { account, signs: 0, sends: sent, requests: [], reject };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    log.requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x';
    if (method === 'personal_sign') { log.signs++; return cast('wallet', 'sign', '--private-key', j.private_key, params[0]); }
    if (method === 'eth_sendTransaction') {
      if (log.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      const hash = '0x' + (sent.length + 1).toString(16).padStart(64, 'a'); sent.push({ hash, tx: params[0] }); return hash;
    }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => {
    const provider = { request: ({ method, params }) => window.__wallet(method, params).catch((e) => { const m = String(e?.message || e); throw Object.assign(new Error(m.replace(/^.*Error: /, '')), { code: /rejected/i.test(m) ? 4001 : undefined }); }), on() {}, removeListener() {} };
    const detail = Object.freeze({ info: Object.freeze({ uuid: 'stub-1', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  });
  return log;
}

// ── the pool module, as a stand-in that records what it is asked and answers from `window.__ux.cfg` ──
const UX_STUB = `
const ux = (window.__ux ||= { calls: [], cfg: {} });
export function setExternalTacHolders() {}
export function forgetKeys() { ux.forgot = (ux.forgot || 0) + 1; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export function makeConfidentialPoolUx() {
  return {
    async nextWrapIndex(a) { ux.calls.push(['nextWrapIndex', a.ticker, a.walletPriv.length]); await wait(ux.cfg.indexMs || 0); if (ux.cfg.indexFails) throw new Error('nextWrapIndex: could not read this asset\\'s wrap deposits (stub); retry'); return ux.cfg.index ?? 7; },
    buildWrap(a) { ux.calls.push(['buildWrap', String(a.amountWei), a.ticker, a.index]); return { commit: '0x' + 'ab'.repeat(32), index: a.index, leaf: 'leaf' + a.index, wrapOp: {}, outputs: [], memos: [] }; },
    async submitWrapSettle(a) {
      ux.calls.push(['submitWrapSettle', a.built.index, a.depositTx || null, a.waitOpts?.timeoutMs]);
      await wait(ux.cfg.settleMs || 0);
      if (ux.cfg.settleFails > 0) { ux.cfg.settleFails--; throw new Error('settle timed out (box offline or backlogged)'); }
      return { status: 'settled' };
    },
    async balance(priv, o) {
      ux.calls.push(['balance', priv.length, JSON.stringify(o)]);
      await wait(ux.cfg.balanceMs || 0);
      if (ux.cfg.balanceFails) throw new Error('could not read the pool');
      const id = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
      const value = BigInt(ux.cfg.held || 0);
      return { byAsset: value ? { [id]: { asset: id, value, notes: [{ value: String(value) }] } } : {}, notes: [], diag: { wrap: { pending: (ux.cfg.pending || []).map((p) => ({ ...p, value: BigInt(p.value) })) }, errors: ux.cfg.farmError ? { farm: 'x' } : {} },
        farmPositions: ux.cfg.positions || [] };
    },
  };
}`;

async function openPage(viewport, { wallet = false, reject = false, hash = '', scheme = 'light', api = true } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const log = wallet ? await stubWallet(ctx, { reject }) : null;
  const ok200 = (body) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  for (const h of ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co']) await ctx.route(`https://${h}/**`, (r) => {
    const q = JSON.parse(r.request().postData() || '{}');
    return r.fulfill(ok200(Array.isArray(q) ? q.map(rpcAnswer) : rpcAnswer(q)));
  });
  const seen = [];
  await ctx.route(/^https:\/\/api\.tacit\.finance\//, (r) => {
    const u = new URL(r.request().url()); seen.push(u.pathname + u.search);
    if (!api) return r.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"down"}' });
    if (u.pathname === '/stats') return r.fulfill(ok200(u.searchParams.get('view') === 'front' ? front : stats));
    if (u.pathname === '/farm/program') return r.fulfill(ok200(program));
    if (u.pathname === `/assets/${BTC_ID}`) return r.fulfill(chain.market === 'down' ? { status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' } : ok200(chain.market === 'active' ? activeMarket().asset : chain.market === 'ask' ? { ...idleAsset, listing_count: 1 } : idleAsset));
    if (u.pathname === `/assets/${BTC_ID}/preauth-sales`) return r.fulfill(chain.market === 'partial' ? { status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' } : ok200(chain.market === 'active' ? activeMarket().sales : chain.market === 'ask' ? { ...activeMarket().sales, sales: activeMarket().sales.sales.slice(0, 1) } : { asset_id: BTC_ID, count: 0, sales: [] }));
    if (u.pathname === `/assets/${BTC_ID}/bid-intents`) return r.fulfill(ok200(chain.market === 'active' ? activeMarket().bids : { asset_id: BTC_ID, count: 0, intents: [] }));
    if (u.pathname === '/confidential/quote') return r.fulfill(ok200(chain.quote ? chain.quote(quote, u) : quote));
    return r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  await ctx.route('**/confidential-pool-ux.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: UX_STUB }));
  await ctx.route('**/walletconnect.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'export function announceWalletConnect() { return { provider: null, disconnect: async () => {} }; }' }));
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t); else if (!/Failed to load resource/.test(t)) errors.push(t.slice(0, 200)); } });
  await page.goto(`http://127.0.0.1:${WEB}/trade/teth/${hash}`);
  await page.waitForSelector('#wallet-chip');
  return { browser, page, errors, blocked, log, seen };
}
const ux = (page) => page.evaluate(() => window.__ux);
const cfg = (page, o) => page.evaluate((x) => { (window.__ux ||= { calls: [], cfg: {} }); Object.assign(window.__ux.cfg, x); }, o);
const money = (page) => page.evaluate(() => ({ route: document.querySelector('#route')?.textContent.replace(/\s+/g, ' ').trim(), go: document.querySelector('#go').textContent, disabled: document.querySelector('#go').disabled }));

let r;
try {
  // ── a visitor with no wallet, at a desktop: what the page says on its own ──
  r = await openPage({ width: 1280, height: 1000 });
  let p = r.page;
  await until(p, () => document.querySelector('#px-usd').textContent.startsWith('$') && document.querySelectorAll('.pf').length === 3 && document.querySelectorAll('#moves tbody tr').length > 3 && document.querySelector('#chart .line'));
  ok((await text(p, '#px-usd')) === '$2,441', `the headline is a tETH's dollar value, ETH's price: ${await text(p, '#px-usd')}`);
  ok((await p.title()) === 'tETH $2,441 · tacit trade', 'the tab names it and its price');
  const sub = await text(p, '#px-sub');
  const heldTxt = (Number(HELD) / 1e18).toFixed(2);
  ok(/1 tETH = 1 ETH, private/.test(sub) && sub.includes(`${heldTxt} ETH`) && /187 deposits · 64 wallets/.test(sub), `the line under it says what the pool holds and from how many (${sub.slice(0, 90)})`);
  const asset = await p.$$eval('.assets a', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('aria-current')]));
  ok(asset.length === 3 && asset[0][1] === '/trade/tac/' && asset[1][0] === 'tETH' && asset[1][2] === 'page' && asset[2][1] === '/trade/cbtc/', 'a switch names the three markets and marks this one');
  const sum = await text(p, '#hints-sum');
  ok(/Wrapped \$2,441/.test(sum) && /in the pools \$\d/.test(sum) && /apart/.test(sum), `the dropdown's line gives the wrapped value and the pools' range (${sum})`);
  await p.click('#hints summary');
  const lanes = await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  ok(lanes.length === 5 && /Wrapped/.test(lanes[0]) && lanes.some((l) => /On Bitcoin.*not listed yet/.test(l)) && lanes.some((l) => /TAC pool/.test(l)) && lanes.some((l) => /cUSD pool/.test(l)) && lanes.some((l) => /cBTC pool/.test(l)), `one lane for the wrapped rate, one for each pool that pairs tETH and one for Bitcoin, which says it has no listing yet (${lanes.length})`);
  // each pool's price is its reserves' ratio, checked against the fixture
  const cusd = program.pools.find((x) => x.pair === 'cETH/cUSD'), per = Number(cusd.reserves.reserveB) / Number(cusd.reserves.reserveA);
  ok(lanes.some((l) => /cUSD pool/.test(l) && l.includes(`$${Math.round(per)}`) || l.includes(`$${per.toFixed(2)}`)), `the cUSD pool's price is its reserves' ratio, ${per.toFixed(2)} cUSD a tETH`);
  await p.keyboard.press('Escape');
  // the farms
  const farms = await p.$$eval('.pf', (as) => as.map((a) => ({ href: a.getAttribute('href'), t: a.textContent.replace(/\s+/g, ' ').trim() })));
  ok(farms.map((f) => f.href).join() === '/#farm/private-0,/#farm/private-1,/#farm/private-2', 'each farm opens on the front page at its own pool');
  ok(/tETH \/ TAC/.test(farms[0].t) && /554 TAC a day/.test(farms[0].t) && /\d+%/.test(farms[0].t) && /ETH deep/.test(farms[0].t) && /farmed/.test(farms[0].t), `a farm says its pool, what it pays and its APR, its depth and share farmed (${farms[0].t.slice(0, 120)})`);
  const stat = await text(p, '#fm-stats');
  ok(/Best APR now/.test(stat) && /1,108 TAC/.test(stat) && /Stream ends/.test(stat), `the farms' figures (${stat.slice(0, 100)})`);
  const aprs = await p.$$eval('.pf .rt', (rs) => rs.map((x) => parseInt(x.firstChild.textContent.replace(/[^\d]/g, '')) || 0));
  // The APR is a year of the pool's TAC at TAC's price over twice its tETH side bonded (the front page's sum): checked for the TAC pool.
  const tp = program.pools.find((x) => x.pair === 'TAC/cETH'), bonded = 2 * Number(tp.reserves.reserveA) / 1e8 * Number(tp.totalShares) / Number(tp.reserves.lpTotalShares);
  const wantApr = Number(tp.tacPerDayForPool) * 365 * (1 / PER_ETH) / bonded * 100;
  ok(Math.abs(aprs[0] - wantApr) <= 1.5, `the TAC pool's APR is a year of its TAC at TAC's price over what is bonded: ${aprs[0]}% (${wantApr.toFixed(1)}%)`);
  ok(/Sign in to see yours/.test(await text(p, '#fm-note')), 'signed out, the farms offer to show your positions');
  // the chart and the movements
  const bars = await p.evaluate(() => document.querySelector('#chart svg')?.querySelectorAll('.line').length);
  ok(bars >= 1, 'the chart draws the ETH held as a line');
  const read = await text(p, '#ch-read');
  ok(read.startsWith(`${heldTxt} ETH`) && /all time|past/.test(read), `the line above the chart reads what is held now (${read.slice(0, 70)})`);
  const ranges = await p.$$eval('#range-seg button', (b) => b.map((x) => x.textContent));
  ok(ranges.includes('All') && ranges.includes('1D') && ranges.length >= 3, `the ranges offered are those the history can fill: ${ranges.join(' ')}`);
  await p.click('#range-seg [data-range="1"]');
  await until(p, () => /past day/.test(document.querySelector('#ch-read').textContent));
  ok(/past day/.test(await text(p, '#ch-read')), 'a range changes what the chart and its readout cover');
  await p.click('#view-seg [data-unit="usd"]');
  ok(/^\$24,/.test((await text(p, '#ch-read'))), `dollars: the held ETH at today's rate (${(await text(p, '#ch-read')).slice(0, 30)})`);
  const mv = await p.$$eval('#moves tbody tr', (rs) => rs.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(mv.length === 10 && /ETH (in|out)/.test(mv[0]) && /2 h ago/.test(mv[0]), `the newest ten movements, the newest first (${mv[0]})`);
  ok(/24h .* in, .* out/.test(await text(p, '#mv-sum')), 'a line sums the day and the week');
  ok((await text(p, '#about')).includes('ETH made private'), 'the about text says what tETH is');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error and nothing blocked by the CSP (${[...r.errors, ...r.blocked].join(' | ').slice(0, 200)})`);
  // the pool's figures that can be read here
  const calls = r.seen.join(' ');
  ok(/\/stats\?network=mainnet&view=front/.test(calls) && /\/stats\?network=mainnet$/.test(r.seen.find((x) => /^\/stats\?network=mainnet$/.test(x)) || ''), 'the short reading comes first, the whole one after');
  await p.fill('#amt', '0.5');
  ok((await text(p, '#go')) === 'Connect wallet', 'with no wallet connected the button asks for one');
  await r.browser.close();

  // ── the pure figures, in the page's own module ──
  r = await openPage({ width: 1280, height: 900 });
  p = r.page;
  await p.waitForSelector('#px-usd');
  const pure = await p.evaluate(async () => {
    const m = await import('/trade/teth/read.js');
    const out = {};
    const flows = [[100, 5n], [200, -2n], [200, 3n], [300, 4n]];
    const h = m.heldHistory(flows, 10n);
    out.hist = h.pts.map((x) => String(x.held)).join(); out.exact = h.exact;
    out.inexact = m.heldHistory(flows, 9n).exact;
    const day = 86400, base = 1000 * day;
    const pts = [{ t: base, held: 10n ** 18n, move: 10n ** 18n }, { t: base + 3 * day + 10, held: 3n * 10n ** 18n, move: 2n * 10n ** 18n }, { t: base + 3 * day + 20, held: 2n * 10n ** 18n, move: -(10n ** 18n) }];
    const bars = m.heldBars(pts, { tf: day, since: 0, spot: 5n * 10n ** 18n, at: base + 5 * day + 5 });
    out.bars = bars.map((b) => [b.close, b.held ? 1 : 0, b.vol, b.n, b.live ? 1 : 0].join(':')).join(' ');
    out.from = m.heldBars(pts, { tf: day, since: base + 2 * day, at: base + 5 * day + 5 }).map((b) => b.close).join();
    out.moved = Object.fromEntries(Object.entries(m.movedSince(pts, 2 * day, base + 4 * day)).map(([k, v]) => [k, String(v)]));
    out.ranges = [m.rangesFor(26).map((x) => x[0]).join(), m.rangesFor(100).map((x) => x[0]).join(), m.rangesFor(0).map((x) => x[0]).join()];
    out.sizes = [m.barSize(1, 26), m.barSize(7, 26), m.barSize(0, 26), m.barSize(0, 80), m.barSize(90, 200)];
    out.wrapIssue = [m.POOL.length];
    return out;
  });
  ok(pure.hist === '5,3,6,10' && pure.exact === true && pure.inexact === false, `the history is the running sum of the flows, and says when it does not end on the balance (${pure.hist})`);
  ok(pure.bars === '1:0:1:1:0 1:1:0:0:0 1:1:0:0:0 2:0:3:2:0 2:1:0:0:0 5:1:0:0:1', `bars: a quiet bar holds what was held, vol is what moved, the last is the balance (${pure.bars})`);
  ok(pure.from === '1,2,2,2', `a range opens at what was held then (${pure.from})`);
  ok(pure.moved.in === String(2n * 10n ** 18n) && pure.moved.out === String(10n ** 18n), 'movedSince counts only what is inside the window');
  ok(pure.ranges.join('|') === '1D,1W,All|1D,1W,1M,3M,All|1D,1W,All', `the ranges offered follow the history's length (${pure.ranges.join(' | ')})`);
  ok(pure.sizes.join() === '3600,14400,14400,86400,86400', `bar sizes follow the range (${pure.sizes.join()})`);
  // the pools' rows and positions, against the front page's arithmetic
  const rows = await p.evaluate(async (prog) => {
    const m = await import('/trade/teth/read.js');
    const rows = m.poolRows(prog, { tacEth: 1 / 11000, ethUsd: 2441, btcUsd: 83000 });
    const mine = m.positionsIn(rows, [{ pid: 0, shares: String(Number(prog.pools[0].reserves.lpTotalShares) / 10), pendingTac: '1.5', unlockAt: 5 }, { pid: 9, shares: '5' }]);
    return { rows, mine: [...mine.entries()] };
  }, program);
  ok(rows.rows.length === 3 && rows.rows.map((x) => x.other).join() === 'TAC,cUSD,cBTC', 'a pool is a row only when it pairs tETH, in pool order');
  ok(Math.abs(rows.rows[0].per - Number(program.pools[0].reserves.reserveB) / Number(program.pools[0].reserves.reserveA)) < 1e-9, 'the price in a pool is its reserves\' ratio');
  ok(rows.mine.length === 1 && rows.mine[0][0] === 0 && Math.abs(rows.mine[0][1].teth - Number(program.pools[0].reserves.reserveA) / 1e8 / 10) < 1e-9 && rows.mine[0][1].earned === 1.5, 'a position is a share of the pool\'s two sides and what it earned; a pool not listed is left out');
  await r.browser.close();

  // ── the wrap: a wallet connects, the key opens from its signature, one transaction pays the deposit and the tip ──
  r = await openPage({ width: 1280, height: 1000 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelector('#px-usd').textContent.startsWith('$'));
  await cfg(p, { held: 0 });
  await p.click('#go');                                                                  // connects the wallet
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on') && document.querySelector('#in-bal') && !document.querySelector('#in-bal').hidden);
  ok((await text(p, '#in-bal')) === 'Balance 5 ETH · Max' && (await text(p, '#go')) === 'Enter an amount', 'connected: the balance shows and the button asks for an amount');
  await p.fill('#amt', '0.1');
  await until(p, () => /Relay tip/.test(document.querySelector('#route').textContent) && !/reading/.test(document.querySelector('#route').textContent));
  let m = await money(p);
  const total = 10n ** 17n + TIP, f6 = (v) => { const s = v.toString().padStart(19, '0'), i = s.length - 18; return `${s.slice(0, i)}.${s.slice(i, i + 6)}`.replace(/^0+(?=\d)/, ''); };
  ok(m.route.includes(`Relay tip${f6(TIP)} ETH`) && m.route.includes(`Your wallet sends${f6(total)} ETH`), `the receipt shows the tip and what the wallet sends (${m.route.slice(0, 110)})`);
  ok(m.go === 'Sign in to make ETH private' && !m.disabled, 'with no key open the button says it signs in first');
  ok((await text(p, '#out')) === '0.1' && /≈ \$244/.test(await text(p, '#out-usd')), 'the output is the same amount, one for one, with its dollar value');
  await p.fill('#amt', '0.123456789');
  await until(p, () => /8 decimals/.test(document.querySelector('#go').textContent));
  ok((await text(p, '#go')) === 'Up to 8 decimals' && (await money(p)).disabled, 'an amount finer than the pool moves is refused before anything is asked');
  await p.fill('#amt', '99');
  await until(p, () => document.querySelector('#go').textContent === 'Not enough ETH');
  ok((await money(p)).disabled, 'more than the wallet holds is refused');
  await p.click('#in-bal');
  await until(p, () => document.querySelector('#amt').value !== '99');
  ok((await p.inputValue('#amt')) === '4.996', `Max keeps a little back for the network fee (${await p.inputValue('#amt')})`);
  await p.fill('#amt', '0.1');
  await until(p, () => document.querySelector('#go').textContent === 'Sign in to make ETH private');
  await shot(p, 'quote');
  await cfg(p, { indexMs: 300, settleMs: 1500, held: 10000000 });
  await p.click('#go');
  await p.waitForSelector('.bsheet.top .ways');
  const ways = await text(p, '.bsheet.top');
  ok(/Ethereum wallet/.test(ways) && /Open your Tacit wallet/.test(ways) && !/Bitcoin wallet/.test(ways), 'the key is offered from an Ethereum wallet or a passkey (no Bitcoin wallet: that is tacit.finance\'s)');
  await p.click('.bsheet.top [data-in="eth"]');
  await until(p, () => !document.querySelector('.bsheet'), null, 15000);
  await until(p, () => /Preparing your note|Confirm the deposit/.test(document.querySelector('#status').textContent) || document.querySelector('#steps li[data-s="now"]'));
  await shot(p, 'steps');
  const steps = await p.$$eval('#steps li', (ls) => ls.map((l) => `${l.dataset.s}:${l.textContent}`));
  ok(steps.length === 5 && /^done:Open your Tacit wallet/.test(steps[0]), `the steps show, the key's already done (${steps.map((x) => x.split(':')[0]).join(' ')})`);
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);
  ok(r.log.signs === 2, 'the wallet signed the identity message twice, as a first derivation does');
  ok(r.log.sends.length === 1, 'one transaction was sent');
  const tx = r.log.sends[0].tx;
  ok(tx.to.toLowerCase() === WRAP_TIP.toLowerCase(), 'it goes to the wrap forwarder');
  ok(BigInt(tx.value) === total, `it carries the deposit and the tip together (${BigInt(tx.value)} = ${total})`);
  ok(tx.data === '0xfc24c435' + 'ab'.repeat(32) + (10n ** 17n).toString(16).padStart(64, '0') + RELAY.slice(2).toLowerCase().padStart(64, '0'), 'its calldata is wrapWithTip(commit, amount, the relay\'s tip address)');
  ok(tx.from.toLowerCase() === r.log.account.toLowerCase(), 'it comes from the connected account');
  let u = await ux(p);
  const wc = u.calls.filter((c) => c[0] !== 'balance'), called = wc.map((c) => c[0]);
  ok(called.slice(0, 3).join() === 'nextWrapIndex,buildWrap,submitWrapSettle', `the module is asked for the next index, then the note, then the relay's settle (${called.join()})`);
  ok(u.calls.some((c) => c[0] === 'balance') && u.calls.findIndex((c) => c[0] === 'balance') < u.calls.findIndex((c) => c[0] === 'nextWrapIndex'), 'a key just opened is read before it is given a note');
  ok(wc[0][1] === 'cETH' && wc[0][2] === 32, 'the index is asked for tETH with the key as 32 bytes');
  ok(wc[1][1] === String(10n ** 17n) && wc[1][3] === 7, 'the note is built for the amount at that index');
  ok(wc[2][1] === 7 && wc[2][2] === r.log.sends[0].hash && wc[2][3] === 15 * 60e3, 'the relay is given the deposit\'s hash and fifteen minutes');
  ok(/tETH is private now/.test(await text(p, '#status')) && (await p.inputValue('#amt')) === '' , 'it says it is done and clears the amount');
  ok((await p.$$eval('#steps li', (ls) => ls.every((l) => l.dataset.s === 'done'))), 'every step shows done');
  // what the key holds shows in Use tETH
  await p.click('#mode-seg [data-mode="use"]');
  await until(p, () => /0\.1\b/.test(document.querySelector('#held')?.textContent || ''), null, 30000);
  ok(/0\.1 .*tETH, private/.test(await text(p, '#held')), `Use tETH shows the key's private tETH (${await text(p, '#held')})`);
  const links = await p.$$eval('#uses a.use', (as) => as.map((a) => [a.querySelector('b').textContent, a.getAttribute('href')]));
  ok(links.length === 6 && links[0][1] === '/#private/send' && links.find((l) => /Bridge/.test(l[0]))[1] === '/#private/bitcoin' && links.find((l) => /Bring tETH back/.test(l[0]))[1] === '/#private/bitcoin' && links.find((l) => /Back to ETH/.test(l[0]))[1] === '/#card=shield:eth:wallet', `six ways on, each a link that opens tacit.finance ready (${links.map((l) => l[1]).join(' ')})`);
  await p.fill('#use-amt', '0.05');
  const links2 = await p.$$eval('#uses a.use', (as) => as.map((a) => a.getAttribute('href')));
  ok(links2.filter((h) => h.includes('&amt=0.05')).length === 2 && !links2.some((h) => /private\/bitcoin.*amt/.test(h)), `the amount rides on the swap and take-out links (the bridge asks for its own) (${links2.filter((h) => h.includes('amt')).join(' ')})`);
  ok((await ux(p)).calls.some((c) => c[0] === 'balance' && /"positions":true/.test(c[2]) && /"cbtc":false/.test(c[2])), 'the key\'s balance and farm positions come from one scan');
  await shot(p, 'use');
  await p.click('#mode-seg [data-mode="get"]');

  // ── the same key, on a farm: positions show on their pool ──
  await cfg(p, { positions: [{ pid: 1, shares: String(Math.round(Number(program.pools[1].reserves.lpTotalShares) / 4)), pendingTac: '3.25', unlockAt: 0 }] });
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-re');
  await until(p, () => document.querySelectorAll('.pf .tag').length === 1, null, 20000);
  await shot(p, 'position');
  const mine = await text(p, '.pf .sb.mine');
  ok(/Yours: .* tETH \+ .* cUSD · 3\.25 TAC earned/.test(mine) && (await p.$$eval('.pf', (as) => as.findIndex((a) => a.querySelector('.tag')))) === 1, `a position shows on its farm: what it holds and has earned (${mine})`);
  await p.click('#mode-seg [data-mode="get"]');

  // ── a rejected transaction, the relay failing after the deposit, and its retry ──
  await cfg(p, { settleMs: 0, indexMs: 0, settleFails: 0 });
  r.log.reject = true;
  await p.fill('#amt', '0.02');
  await until(p, () => document.querySelector('#go').textContent === 'Make ETH private' && !document.querySelector('#go').disabled);
  await p.click('#go');
  await until(p, () => /Cancelled in your wallet/.test(document.querySelector('#status').textContent));
  ok(/Nothing was sent/.test(await text(p, '#status')) && (await text(p, '#go')) === 'Make ETH private' && !(await money(p)).disabled && r.log.sends.length === 1, 'a refusal in the wallet sends nothing and leaves the ticket as it was');
  ok(r.log.signs === 2, 'the key was not asked for again');
  r.log.reject = false;
  await cfg(p, { settleFails: 1 });
  await p.click('#go');
  await until(p, () => /not private yet/.test(document.querySelector('#status').textContent), null, 20000);
  const st = await text(p, '#status');
  ok(/still working on it/.test(st) && /0\.02 ETH is in the Tacit pool, but it is not private yet/.test(st) && /no need to send it again/.test(st) && /Private ETH tab/.test(st), `a relay that fails after the deposit says where it is and that it is not asked for again (${st.slice(0, 140)})`);
  ok(r.log.sends.length === 2, 'one deposit went out, not two');
  ok((await p.inputValue('#amt')) === '' && (await text(p, '#go')) === 'Finish the earlier deposit first' && (await money(p)).disabled, 'the form is cleared and cannot make the deposit again while it is unfinished');
  await p.fill('#amt', '0.02');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(600);
  ok(r.log.sends.length === 2, 'Enter on a refilled form sends nothing either');
  await p.fill('#amt', '');
  await p.click('#retry');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);
  u = await ux(p);
  const subs = u.calls.filter((c) => c[0] === 'submitWrapSettle');
  ok(subs.length === 3 && subs[2][1] === subs[1][1] && subs[2][2] === r.log.sends[1].hash, 'finishing asks the relay for the same note from the same deposit');
  ok(u.calls.filter((c) => c[0] === 'nextWrapIndex').length === 3 && u.calls.filter((c) => c[0] === 'buildWrap').length === 3, 'and builds nothing new');
  ok((await text(p, '#go')) === 'Enter an amount', 'the ticket is free again');
  // Lock forgets what a retry holds
  await cfg(p, { settleFails: 1 });
  await p.fill('#amt', '0.02');
  await until(p, () => document.querySelector('#go').textContent === 'Make ETH private' && !document.querySelector('#go').disabled);
  await p.click('#go');
  await until(p, () => document.querySelector('#retry'), null, 20000);
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-lock');
  await until(p, () => document.querySelector('#signin'));
  await p.click('#mode-seg [data-mode="get"]');
  ok(!(await p.$('#retry')) && (await text(p, '#status')) === '' && (await text(p, '#go')) !== 'Finish the earlier deposit first', 'Lock drops the unfinished deposit\'s retry (it holds the note\'s secrets)');
  // the key again, for what follows
  await p.fill('#amt', '0.03');
  await until(p, () => document.querySelector('#go').textContent === 'Sign in to make ETH private');
  await cfg(p, { pending: [{ index: 9, asset: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', value: 2000000, txHash: '0x' + 'ee'.repeat(32) }] });
  await p.click('#go'); await p.waitForSelector('.bsheet.top [data-in="known"], .bsheet.top [data-in="eth"]');
  await p.click('.bsheet.top [data-in="known"], .bsheet.top [data-in="eth"]');
  await until(p, () => /waiting to become private/.test(document.querySelector('#status').textContent), null, 30000);
  ok(r.log.sends.length === 3 && /Press Finish above/.test(await text(p, '#status')) && (await p.$('#finish')), `a key opened for a deposit looks for deposits waiting first, and stops to say so before it makes another (${r.log.sends.length} sends; ${await text(p, '#status')})`);
  await p.click('#mode-seg [data-mode="use"]');
  ok(!!(await p.$eval('#finish', (b) => b.offsetParent !== null)), 'and the Finish is in view from Use tETH too');
  await p.click('#mode-seg [data-mode="get"]');
  await cfg(p, { pending: [] });
  await p.click('#finish');
  await until(p, () => /They are private now/.test(document.querySelector('#status').textContent), null, 20000);
  await p.fill('#amt', '0.02');
  await until(p, () => document.querySelector('#go').textContent === 'Make ETH private' && !document.querySelector('#go').disabled);
  await p.click('#go');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 20000);
  ok(r.log.sends.length === 4, `with nothing waiting the deposit goes (${r.log.sends.length} sends; ${await text(p, '#status')})`);
  // the deposit reverted
  chain.receipt = 'revert';
  await p.fill('#amt', '0.03');
  await until(p, () => document.querySelector('#go').textContent === 'Make ETH private' && !document.querySelector('#go').disabled);
  await p.click('#go');
  await until(p, () => /failed on chain/.test(document.querySelector('#status').textContent), null, 20000);
  ok(!/not private yet/.test(await text(p, '#status')) && !(await p.$('#retry')) && (await text(p, '#go')) !== 'Finish the earlier deposit first', 'a deposit that reverted is not called waiting and offers no retry');
  chain.receipt = 'ok';
  // the index could not be read
  await cfg(p, { indexFails: true });
  await p.fill('#amt', '0.04');
  await until(p, () => document.querySelector('#go').textContent === 'Make ETH private' && !document.querySelector('#go').disabled);
  const before = r.log.sends.length;
  await p.click('#go');
  await until(p, () => /could not read this asset/.test(document.querySelector('#status').textContent));
  ok(r.log.sends.length === before, 'a failure before the deposit sends nothing');
  await cfg(p, { indexFails: false });

  // ── a deposit that landed and was never settled is found from the key, and finished ──
  await cfg(p, { pending: [{ index: 3, asset: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', value: 10000000, txHash: '0x' + 'cd'.repeat(32) }] });
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-re');
  await until(p, () => document.querySelector('#finish'), null, 20000);
  ok(/0\.1 ETH is waiting to become private/.test(await text(p, '#waiting')), `a waiting deposit shows with a Finish (${await text(p, '#waiting')})`);
  await p.click('#mode-seg [data-mode="get"]');
  await cfg(p, { pending: [] });
  await p.click('#finish');
  await until(p, () => /They are private now/.test(document.querySelector('#status').textContent), null, 20000);
  u = await ux(p);
  const lastBuild = [...u.calls].reverse().find((c) => c[0] === 'buildWrap'), lastSub = [...u.calls].reverse().find((c) => c[0] === 'submitWrapSettle');
  ok(lastBuild[1] === String(10000000n * 10n ** 10n) && lastBuild[3] === 3 && lastSub[1] === 3 && lastSub[2] === '0x' + 'cd'.repeat(32), 'Finish rebuilds the note at its own index and amount, and gives the relay its deposit');
  // locking forgets the key
  await p.click('#mode-seg [data-mode="use"]'); await p.click('#held-lock');
  await until(p, () => document.querySelector('#signin') && window.__ux.forgot >= 1);
  ok(((await ux(p)).forgot || 0) >= 1 && (await text(p, '#go')) !== '' && /Sign in to see yours/.test(await text(p, '#fm-note')), 'Lock drops the key and the pool module\'s copies of it');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error and nothing blocked (${[...r.errors, ...r.blocked].join(' | ').slice(0, 200)})`);
  await r.browser.close();

  // ── tETH on Bitcoin: the quiet state until there is a book ──
  r = await openPage({ width: 1280, height: 1000 });
  p = r.page;
  await until(p, () => document.querySelector('#btc-lead').textContent.length > 0 && document.querySelector('#px-usd').textContent.startsWith('$'));
  await shot(p, 'btc-idle');
  ok(/No tETH is listed on Bitcoin yet/.test(await text(p, '#btc-lead')) && /not listed yet/.test(await text(p, '#btc-sum')), 'with nothing on the Bitcoin book, the panel says so');
  const ghost = await p.$eval('#btc-ladder', (e) => ({ ghost: !!e.querySelector('.ob.ghost'), mid: e.querySelector('.ob-spread')?.textContent.replace(/\s+/g, ' ').trim(), empties: [...e.querySelectorAll('.ob-empty')].map((x) => x.textContent) }));
  const refTxt = (ETH_USD / 83000 * 1e8 / 1e6).toFixed(2);
  ok(ghost.ghost && ghost.empties.length === 2 && ghost.mid.includes(`≈ ${refTxt}M sats`) && /ETH's price/.test(ghost.mid), `the book's own shape, empty, with ETH's price in sats where the last trade will be (${ghost.mid})`);
  ok(!(await p.$('#btc-actions button')) && !(await p.$('#btc-actions a')) && (await p.$eval('#btc-depth', (e) => e.hidden)), 'no way to trade is offered until there is something to trade');
  const facts = await text(p, '#btc-facts');
  ok(/3 holders on Bitcoin · 2 transfers/.test(facts), `what is known of tETH on Bitcoin (${facts})`);
  ok(/change hands together in the transaction that takes it/.test(await text(p, '#btc-note')) && (await p.$eval('#btc-note a', (a) => a.getAttribute('href'))) === '/#private/bitcoin', 'it says how a listing settles and where tETH comes from');
  ok((await p.$$eval('#lane-seg button', (b) => b.map((x) => x.textContent))).join() === 'ETH held', 'the chart offers no Bitcoin price while there is none');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  await r.browser.close();

  // ── ... and when someone has listed: the book, the price against ETH's, and the way in ──
  chain.market = 'active';
  r = await openPage({ width: 1280, height: 1000 });
  p = r.page;
  await r.page.route('**/trade/btc.js*', (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript', body: `export function makeBitcoin(o) { (window.__btc ||= { made: [], opened: [] }).made.push({ id: o.asset?.id, title: o.asset?.title, after: o.asset?.after }); return { open: async (prime) => { window.__btc.opened.push(prime); } }; }` }));
  await until(p, () => document.querySelectorAll('#btc-ladder .ob-row').length > 3 && document.querySelector('#btc-depth svg') && document.querySelector('#px-usd').textContent.startsWith('$'));
  await shot(p, 'btc-active');
  const btcSum = await text(p, '#btc-sum');
  const mark = activeMarket().asset.mark_price.unit, premiumPct = Math.abs((mark / (ETH_USD / 83000 * 1e8) - 1) * 100);
  ok(/sats/.test(btcSum) && /(under|over) ETH|level with ETH/.test(btcSum) && btcSum.includes(`${premiumPct.toFixed(premiumPct < 10 ? 1 : 0)}%`), `the panel's head gives the last price and how far it sits from ETH's (${btcSum})`);
  const obRows = await p.$$eval('#btc-ladder .ob-row', (rs) => rs.map((x) => ({ side: x.classList.contains('ask') ? 'ask' : 'bid', btn: x.tagName === 'BUTTON', t: x.textContent.replace(/\s+/g, ' ').trim() })));
  ok(obRows.some((x) => x.side === 'ask' && x.btn) && obRows.some((x) => x.side === 'bid') && obRows.every((x) => !x.btn || /\$/.test(x.t)), `asks and bids are rows, each a button that opens the market, priced in dollars (${obRows[0].t})`);
  ok(!(await p.$eval('#btc-depth', (e) => e.hidden)) && /listings/.test(await text(p, '#btc-note')), 'the depth chart and the count of listings show');
  const acts = await p.$$eval('#btc-actions button', (b) => b.map((x) => x.textContent));
  ok(acts.join() === 'Trade on Bitcoin,List a sale', `the way in: ${acts.join(' · ')}`);
  await p.click('#hints summary');
  const lanes2 = await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  ok(lanes2.some((l) => /On Bitcoin/.test(l) && /\$/.test(l) && /vs ETH/.test(l)), `the hero's dropdown has a Bitcoin lane with its price against ETH (${lanes2.find((l) => /On Bitcoin/.test(l))})`);
  await p.keyboard.press('Escape');
  await p.click('#btc-actions [data-btc="open"]');
  await until(p, () => window.__btc?.opened.length === 1);
  let bt = await p.evaluate(() => window.__btc);
  ok(bt.made[0].id === BTC_ID && bt.made[0].title === 'tETH on Bitcoin' && /Bridge/.test(bt.made[0].after) && bt.opened[0] === null, 'the market sheet is made for tETH\'s id and title, and opened as it is');
  await p.click('#btc-ladder .ob-row.ask[data-btc]');
  await until(p, () => window.__btc.opened.length === 2);
  bt = await p.evaluate(() => window.__btc);
  ok(bt.opened[1]?.side === 'buy' && bt.opened[1].type === 'market' && typeof bt.opened[1].receiveBase === 'bigint' || (bt.opened[1]?.side === 'buy' && bt.opened[1].type === 'market'), `a ladder row primes the ticket to buy up to it (${JSON.stringify(bt.opened[1], (k, v) => (typeof v === 'bigint' ? String(v) : v))})`);
  await p.click('#btc-actions [data-btc="list"]');
  await until(p, () => window.__btc.opened.length === 3);
  bt = await p.evaluate(() => window.__btc);
  ok(bt.opened[2].side === 'sell' && bt.opened[2].type === 'limit', 'List a sale primes a limit sell');
  // the chart gains a Bitcoin price
  const kindsNow = await p.$$eval('#lane-seg button', (b) => b.map((x) => x.textContent));
  ok(kindsNow.join() === 'ETH held,On Bitcoin', `with trades, the chart offers tETH's price on Bitcoin (${kindsNow.join(' | ')})`);
  await p.click('#lane-seg [data-chart="btc"]');
  await until(p, () => /price on the Bitcoin order book/.test(document.querySelector('#chart-name').textContent) && document.querySelector('#chart .line'));
  await shot(p, 'btc-chart');
  const rd = await text(p, '#ch-read');
  ok(/\$/.test(rd) && /vs ETH/.test(rd) && /tETH traded/.test(rd), `the readout gives the price, the move, and how far it sits from ETH (${rd.slice(0, 120)})`);
  const tags = await p.$$eval('#chart .tagtext', (t) => t.map((x) => x.textContent));
  ok(tags.includes('ETH') && tags.includes('Bitcoin'), `ETH's own price is marked beside it on the chart (${tags.join(',')})`);
  await p.click('#view-seg [data-unit="sats"]');
  await until(p, () => /sats/.test(document.querySelector('#ch-read').textContent));
  ok(/M sats/.test(await text(p, '#ch-read')), 'the same in sats');
  await p.click('#lane-seg [data-chart="held"]');
  await until(p, () => /private ETH held/.test(document.querySelector('#chart-name').textContent));
  ok(/ETH/.test(await text(p, '#ch-read')) && (await p.$$eval('#view-seg button', (b) => b.map((x) => x.textContent))).join() === 'ETH,USD', 'and back to the ETH held');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error with a book (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  await r.browser.close();
  // a book with one listing and no trade: the lane names the ask, not "not listed yet"
  chain.market = 'ask';
  r = await openPage({ width: 1280, height: 1000 });
  p = r.page;
  await until(p, () => document.querySelectorAll('#btc-ladder .ob-row').length >= 1 && document.querySelector('#px-usd').textContent.startsWith('$'));
  await p.click('#hints summary');
  const askLane = (await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()))).find((l) => /On Bitcoin/.test(l));
  ok(/cheapest ask · no trades yet/.test(askLane) && /\$/.test(askLane) && !/not listed yet/.test(askLane), `one listing and no trade: the lane gives the cheapest ask (${askLane})`);
  ok(/1 listed · 0 bids · no trades yet/.test(await text(p, '#btc-sum')) && !/Could not read/.test(await text(p, '#btc-ladder')), `and the head agrees (${await text(p, '#btc-sum')})`);
  await r.browser.close();
  // the listings could not be read, the rest could: that is not an empty book
  chain.market = 'partial';
  r = await openPage({ width: 1280, height: 900 });
  p = r.page;
  await until(p, () => /Could not read the Bitcoin order book just now/.test(document.querySelector('#btc-ladder').textContent) && document.querySelector('#px-usd').textContent.startsWith('$'));
  await p.click('#hints summary');
  const partLane = (await p.$$eval('#lanes .lane', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()))).find((l) => /On Bitcoin/.test(l));
  ok(!/No tETH is listed/.test(await text(p, '#btc-lead')) && /book not read/.test(await text(p, '#btc-sum')) && /book not read just now/.test(partLane) && !(await p.$('#btc-actions button')), `holders and transfers known but no listings read: it says so and does not call the book empty (${partLane})`);
  await r.browser.close();
  // clicking a ladder row with the visitor's own order at the best price primes only what is cheaper than the row, theirs left out
  r = await openPage({ width: 1280, height: 900 });
  const prime = await r.page.evaluate(async () => {
    const m = await import('/trade/teth/market.js');
    const row = (unit, mine) => ({ unit, amount: 10n ** 8n, sats: unit, mine, instant: true, whole: true });
    const book = { asks: [row(100, true), row(200, false), row(300, false)], bids: [{ ...row(90, true), auto: false }, { ...row(80, false), auto: false }, { ...row(70, false), auto: false }] };
    return { buy1: m.bookPrime({ book }, 'buy', 1).receiveBase, buy2: m.bookPrime({ book }, 'buy', 2).receiveBase, sell1: m.bookPrime({ book }, 'sell', 1).sellBase };
  });
  ok(prime.buy1 === 10n ** 8n && prime.buy2 === 2n * 10n ** 8n && prime.sell1 === 10n ** 8n, `a click counts the levels the ladder draws: the 200 row primes its own lot, not the next one too (${prime.buy1}, ${prime.buy2}, ${prime.sell1})`);
  await r.browser.close();
  // the book cannot be read
  chain.market = 'down';
  r = await openPage({ width: 1280, height: 900 });
  await until(r.page, () => /Could not read the Bitcoin order book/.test(document.querySelector('#btc-ladder').textContent), null, 20000);
  ok(!(await r.page.$('#btc-actions button')) && !/No tETH is listed/.test(await text(r.page, '#btc-lead')), 'a book that could not be read is not called empty');
  await r.browser.close();
  chain.market = null;

  // ── the relay's quote is checked before the wallet is asked ──
  r = await openPage({ width: 1280, height: 900 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelector('#px-usd').textContent.startsWith('$'));
  await p.click('#go');
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on'));
  const sendsBefore = r.log.sends.length;
  for (const [name, mod, want] of [
    ['a tip address this page does not know', (q) => ({ ...q, recommendedTipRecipient: '0x' + '11'.repeat(20) }), /tip address this page does not know/],
    ['a splitter this page does not know', (q) => ({ ...q, tipSplitter: '0x' + '22'.repeat(20) }), /tip address this page does not know/],
    ['no tip at all', (q) => { const { recommendedWrapTipWei, ...rest } = q; return rest; }, /did not give a tip/],
    ['a tip of a tenth of the deposit', (q) => ({ ...q, recommendedWrapTipWei: String(10n ** 16n) }), /more than 5% of this deposit/],
  ]) {
    chain.quote = mod;
    await p.fill('#amt', '0.1');
    await until(p, (w) => new RegExp(w).test(document.querySelector('#route').textContent), want.source);
    const goText = await text(p, '#go');
    ok(want.test(await text(p, '#route')) && goText === 'Try again', `${name}: refused with the reason, and the button only asks again (${goText})`);
    await p.fill('#amt', '');
  }
  chain.quote = null;
  await p.fill('#amt', '0.1');
  await until(p, () => /Relay tip/.test(document.querySelector('#route').textContent) && /Private to/.test(document.querySelector('#route').textContent));
  const rt = await text(p, '#route');
  ok(/Private to\s*the Tacit key you open next/.test(rt), `before a key is open the receipt says whose key the note will be for (${rt.slice(0, 120)})`);
  ok(r.log.sends.length === sendsBefore, 'nothing was sent for any of them');
  await r.browser.close();

  // ── a deposit whose receipt does not come: it is not asked for again, and Check again finishes it ──
  chain.receipt = 'none';
  chain.quote = (q) => ({ ...q, tipSplitter: SPLITTER });                  // a quote that names the splitter: this deposit's tip goes to it
  r = await openPage({ width: 1280, height: 900 }, { wallet: true });
  p = r.page;
  await until(p, () => document.querySelector('#px-usd').textContent.startsWith('$'));
  await p.clock.install();
  await cfg(p, { held: 0 });
  await p.click('#go');
  await until(p, () => document.querySelector('#wallet-dot').classList.contains('on'));
  await p.fill('#amt', '0.07');
  await until(p, () => document.querySelector('#go').textContent === 'Sign in to make ETH private', null, 20000);
  await p.click('#go');
  await p.waitForSelector('.bsheet.top [data-in="eth"]');
  await p.click('.bsheet.top [data-in="eth"]');
  await until(p, () => /Deposit sent/.test(document.querySelector('#status').textContent), null, 30000);
  for (let i = 0; i < 6 && !/not confirmed yet/.test(await text(p, '#status')); i++) { await p.clock.fastForward('06:00'); await p.waitForTimeout(400); }
  const slow = await text(p, '#status');
  ok(/not confirmed yet/.test(slow) && /0\.07 ETH deposit was sent/.test(slow) && /no need to send it again/.test(slow) && /Check again/.test(slow), `a deposit that does not confirm is said to be sent, not safe, and not to be sent again (${slow.slice(0, 150)})`);
  ok(r.log.sends[0].tx.data.toLowerCase().endsWith(SPLITTER.slice(2).toLowerCase().padStart(64, '0')) && !r.log.sends[0].tx.data.toLowerCase().endsWith(RELAY.slice(2).toLowerCase().padStart(64, '0')), 'a quote that names the splitter has the deposit\'s tip sent to it, not to the ops address');
  chain.quote = null;
  ok(r.log.sends.length === 1 && (await text(p, '#go')) === 'Finish the earlier deposit first' && (await p.inputValue('#amt')) === '', 'the form is cleared and held');
  chain.receipt = 'ok';
  await p.click('#retry');
  await until(p, () => /Done\./.test(document.querySelector('#status').textContent), null, 30000);
  u = await ux(p);
  const lastSub2 = [...u.calls].reverse().find((c) => c[0] === 'submitWrapSettle');
  ok(lastSub2[2] === r.log.sends[0].hash && r.log.sends.length === 1, 'once it lands the relay is given the same deposit, and no second one was sent');
  await r.browser.close();
  chain.receipt = 'ok';

  // ── what the reads fail to give ──
  chain.rates = false;
  r = await openPage({ width: 1280, height: 900 }, { api: false });
  p = r.page;
  await p.waitForTimeout(2500);
  ok((await text(p, '#px-usd')) === 'tETH' && /Reading the pool/.test(await text(p, '#px-sub')), 'with nothing readable the headline waits and says so');
  ok(/history could not be read/.test(await text(p, '#chart')), 'the chart says its history was not read');
  ok((await text(p, '#go')) === 'Connect wallet' && !(await p.$('.pf')), 'no farms are invented');
  await r.browser.close();
  chain.rates = true;

  // ── a phone: the ticket first, nothing sideways, the bar at the foot, dark ──
  r = await openPage({ width: 390, height: 800 }, { scheme: 'dark' });
  p = r.page;
  await until(p, () => document.querySelectorAll('.pf').length === 3 && document.querySelector('#chart .line'));
  await shot(p, 'phone-dark');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'a phone has no sideways scroll');
  const order = await p.evaluate(() => ['.p-ticket', '.p-chart', '.p-farm', '.p-depth', '.p-info'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top + scrollY)));
  ok(order.every((v, i) => i === 0 || v > order[i - 1]), `the ticket comes first, then the chart, farms, movements and about (${order.join(' ')})`);
  await p.evaluate(() => scrollTo(0, document.querySelector('.p-info').offsetTop));
  await p.waitForTimeout(400);
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('#stick')).display === 'block'), 'the bar at the foot leads to the ticket once it is out of view');
  await p.click('#stick-go');
  await p.waitForTimeout(700);
  ok(await p.evaluate(() => Math.abs(document.querySelector('.p-ticket').getBoundingClientRect().top) < 140), 'and takes the visitor there');
  ok(r.errors.length === 0 && r.blocked.length === 0, `no page error on a phone in the dark (${[...r.errors, ...r.blocked].join(' | ').slice(0, 160)})`);
  await r.browser.close();

  // ── the other market names this one ──
  r = await openPage({ width: 1280, height: 900 });
  await r.page.goto(`http://127.0.0.1:${WEB}/trade/tac/`);
  await r.page.waitForSelector('.assets');
  const tac = await r.page.$$eval('.assets a', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('aria-current')]));
  ok(tac.length === 3 && tac[0][2] === 'page' && tac[1][1] === '/trade/teth/' && tac[2][1] === '/trade/cbtc/', 'the TAC page carries the same switch, to the other two');
  await r.browser.close();
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 8).join('\n'));
  try { await r?.browser?.close(); } catch { /* it may be gone */ }
}
server.close();
console.log(`\n${n} passed${fails ? `, ${fails} failed` : ''}`);
process.exit(fails ? 1 : 0);
