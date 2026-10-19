#!/usr/bin/env node
// dapp/bridge/ in a real browser, under its own CSP. The API, mempool.space and the Ethereum node are answered here (LIVE=1 lets
// them through). Checks the page loads clean; the tile's asset and direction pick its steps, its door and its link; the bridges a
// browser has under way (seeded as the front page journals them) are listed with what each waits on, read from the chains, and no
// signing material reaches the page; another tab's journal write shows at once; the walk-through's steppers and checks answer a
// press; a phone and a dark screen have no sideways scroll.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/bridge-page.mjs        (SHOTS=dir saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null, LIVE = !!process.env.LIVE;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const WEB = 23000 + Math.floor(Math.random() * 1000);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

// ── what the front page journals ──
const NOW = Date.now(), PUB = '02' + 'ab'.repeat(32), SECRET = 'cd'.repeat(32);
const TAC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', TETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const BURN_TX = 'b1'.repeat(32), MINT_TX = 'c2'.repeat(32);
const IN = [
  { id: 'a1', network: 'mainnet', walletPub: PUB, path: 'reflected', stage: 'rburn-mined', createdAt: NOW - 2 * 3600e3, burnHeight: 972_100,
    source: { txid: 'aa'.repeat(32), vout: 0, assetId: TAC_ID, ticker: 'TAC', amount: { __big: '25000000000' }, blinding: { __big: '7' } },
    burn: { txid: BURN_TX, hex: 'deadbeef' }, notePriv: SECRET },
  { id: 'a2', network: 'mainnet', walletPub: PUB, path: 'reflected', stage: 'minted', createdAt: NOW - 30 * 3600e3, mintedAt: NOW - 20 * 3600e3, mintedTxHash: '9f'.repeat(32),
    source: { txid: 'ab'.repeat(32), vout: 1, assetId: TAC_ID, ticker: 'TAC', amount: { __big: '100000000000' } }, burn: { txid: 'b2'.repeat(32) } },
];
const OUT = [
  { id: '0x' + 'dd'.repeat(32), network: 'mainnet', walletPub: PUB, stage: 'covered', createdAt: NOW - 40 * 60e3,
    source: { amount: '150000000', value: '151000000', assetId: '0x' + TETH_ID, ticker: 'tETH' },
    settle: { txHash: 'ee'.repeat(32), ethBlock: 26_225_700, claimIdVerified: true } },
  { id: '0x' + 'de'.repeat(32), network: 'mainnet', walletPub: PUB, stage: 'mint-submitted', createdAt: NOW - 20 * 60e3,
    source: { amount: '4000000000', assetId: '0x' + TAC_ID, ticker: 'TAC' }, mint: { revealTxid: MINT_TX, revealHex: 'cafe' },
    settle: { txHash: 'ef'.repeat(32), ethBlock: 26_225_750, claimIdVerified: true } },
];

async function mock(ctx) {
  if (LIVE) return;
  await ctx.route('https://api.tacit.finance/**', (route) => {
    const u = new URL(route.request().url());
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
    if (u.pathname === '/reflection/status') return json({ attestedHeight: 972_090, tipHeight: 972_093, confirmations: 24, bridgeBurns: 186, foldedCrossoutCount: 7 });
    if (u.pathname === '/reflection/eth-state/covers') return json({ bestBlock: 26_225_800, confirmedBlock: 26_225_800, covered: true });
    if (u.pathname === '/flow') {                     // the live picture's feed: a day with a few burns, mints and proofs in it
      const t = Math.floor(NOW / 1e3);
      const pt = (dt, k) => ({ t: t - dt, burns: 180 + k, minted: 165 + k, out: 9, att: 972_000 + 10 * k, relay: 972_020 + 10 * k, btc: 972_024 + 10 * k });
      return json({ asOf: t, windowSec: 86400, now: { btc: 972_093, relay: 972_090, attested: 972_090, burns: 186, minted: 169, crossOuts: 9 },
        series: [pt(80000, 0), pt(60000, 2), pt(30000, 4), pt(5000, 6)], events: { attests: [t - 70000, t - 40000, t - 9000] } });
    }
    return json({ error: 'not found' }, 404);
  });
  await ctx.route('https://mempool.space/**', (route) => {
    const u = route.request().url();
    const body = u.includes(BURN_TX) ? { confirmed: true, block_height: 972_100 } : u.includes(MINT_TX) ? { confirmed: false } : u.endsWith('/tip/height') ? 972_093 : {};
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await ctx.route('https://ethereum-rpc.publicnode.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (2_512_345n * 10n ** 18n).toString(16).padStart(64, '0') }) }));
}

async function openPage(viewport, { scheme = 'light', seed = true, path = '/bridge/' } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await mock(ctx);
  if (seed) await ctx.addInitScript(([pub, a, b]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('tacit-burndep-bridge-v1:mainnet:' + pub, a);
    localStorage.setItem('tacit-crossout-bridge-v1:mainnet:' + pub, b);
  }, [PUB, JSON.stringify(IN), JSON.stringify(OUT)]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${WEB}${path}`, { waitUntil: 'load' });
  return { browser, page, errors };
}
const shot = async (page, name, full = false) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full }); };

try {
  // ── desktop, light ──
  {
    const { browser, page, errors } = await openPage({ width: 1280, height: 900 });
    await page.waitForFunction(() => !document.querySelector('[data-live="btc"]').classList.contains('sk'), null, { timeout: 20000 });
    ok(await page.textContent('h1') === 'Cross by proof', 'the title');
    ok((await page.textContent('#pf-btc')).includes('972,090'), 'Bitcoin’s proof on Ethereum, live');
    ok((await page.textContent('#pf-btc')).includes('3 behind Bitcoin’s tip'), 'and how far it is from the tip');
    ok((await page.textContent('#pf-eth')).includes('26,225,800'), 'Ethereum’s proof for Bitcoin, live');
    ok(await page.getAttribute('#bt-go', 'href') === '/#bridge', 'TAC from Bitcoin opens the Bridge tab');
    ok((await page.$$('#bt-steps li')).length === 4, 'four steps');
    await page.click('#bt-flip');
    ok(await page.getAttribute('#bt-go', 'href') === '/#bridge/out' && await page.evaluate(() => location.hash) === '#tac/out', 'the flip: TAC to Bitcoin, and the link says so');
    ok((await page.textContent('#bt-from')) === 'Ethereum', 'from Ethereum');
    await page.click('[data-asset="teth"]');
    ok(await page.getAttribute('#bt-go', 'href') === '/#private/bitcoin' && (await page.textContent('#bt-go')).includes('tETH to Bitcoin'), 'tETH to Bitcoin');
    await page.click('[data-asset="cbtc"]');
    ok(await page.getAttribute('#bt-go', 'href') === '/#lock' && await page.isDisabled('#bt-flip') && (await page.textContent('#bt-from')) === 'Bitcoin', 'cBTC enters by a lock, one way');
    ok(await page.isVisible('#bt-then') && await page.getAttribute('#bt-then', 'href') === '/#borrow', 'and offers cUSD after');
    await page.click('[data-asset="tac"]');
    await shot(page, 'desktop-top');

    // your bridges
    ok(await page.isVisible('#mine'), 'the bridges under way are listed');
    const rows = await page.$$eval('#mine-l > li', (ls) => ls.map((l) => l.innerText));
    ok(rows.length === 4, `four bridges (${rows.length})`);
    ok(/1\.5 tETH/.test(rows[0]) && /Send to Bitcoin/.test(rows[0]), 'the one that needs its holder comes first, with its press');
    ok(await page.$eval('#mine-l > li .mb-due', (a) => a.getAttribute('href')) === '/#private/bitcoin', 'which opens its sheet');
    ok(rows.some((r) => /250 TAC/.test(r) && /10 blocks behind/.test(r)), 'a burn on Bitcoin: how far the proof is behind its block');
    ok(rows.some((r) => /40 TAC/.test(r) && /mempool/.test(r)), 'a mint on Bitcoin: still in the mempool');
    ok(rows.some((r) => /1,000 TAC/.test(r) && /Arrived/.test(r)), 'an arrival');
    ok((await page.textContent('#mine-n')).includes('1 needs you'), 'the count of what needs its holder');
    const html = await page.content();
    ok(!html.includes(SECRET) && !html.includes('deadbeef') && !html.includes('cafe"'), 'no signing material reaches the page');
    ok(await page.$eval(`#mine-l a[href*="${BURN_TX}"]`, (a) => a.href.startsWith('https://mempool.space/tx/')).catch(() => false), 'the Bitcoin transaction is linked');

    // another tab moves a bridge on
    await page.evaluate(([pub, out]) => {
      const list = JSON.parse(out); list[0].stage = 'mint-submitted';
      localStorage.setItem('tacit-crossout-bridge-v1:mainnet:' + pub, JSON.stringify(list));
      window.dispatchEvent(new StorageEvent('storage', { key: 'tacit-crossout-bridge-v1:mainnet:' + pub }));
    }, [PUB, JSON.stringify(OUT)]);
    await page.waitForFunction(() => !document.querySelector('#mine-l .mb-due'), null, { timeout: 5000 }).catch(() => {});
    ok(!(await page.$('#mine-l .mb-due')), 'another tab’s write shows at once');

    // the walk-through
    await page.locator('#c2-h').scrollIntoViewIfNeeded();
    const step = page.locator('section:has(#c2-h) .st-l li').nth(2);
    await step.click();
    ok(await step.getAttribute('aria-current') === 'step', 'a press picks a step');
    ok(await page.$eval('section:has(#c2-h) figure', (f) => f.dataset.at) === '2', 'and the drawing follows');
    await shot(page, 'desktop-b2e');
    await page.click('[data-ck="pool"]');
    ok(await page.isVisible('[data-ckp="pool"]') && !(await page.isVisible('[data-ckp="work"]')), 'who checks what: a press names it');
    await page.click('#note-fig button[data-side="eth"]');
    ok(await page.$eval('#note-fig', (f) => f.dataset.side) === 'eth', 'the note, in the pool');
    ok((await page.textContent('[data-live="supply"]')).includes('2,512,345'), 'the TAC that crossed, live');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on a desktop');
    // scrolled through as a reader would: every section comes in
    for (let y = 0; y < await page.evaluate(() => document.body.scrollHeight); y += 500) { await page.evaluate((v) => scrollTo(0, v), y); await page.waitForTimeout(120); }
    await page.waitForTimeout(900);
    ok(await page.$$eval('.rv', (els) => els.every((e) => e.classList.contains('in'))), 'every section comes in as it is scrolled to');
    await page.waitForFunction(() => !!document.querySelector('#live-v canvas'), null, { timeout: 10000 }).catch(() => {});
    ok(!!(await page.$('#live-v canvas')), 'the live picture of both chains is drawn');
    await page.click('#mv-dir button[data-dir="out"]');
    ok(await page.$eval('#mv', (f) => f.dataset.dir) === 'out' && (await page.$eval('#mv-a', (u) => u.getAttribute('href'))) === '#tk-eth' && (await page.isVisible('.mvc .out')) && !(await page.isVisible('.mvc .in')), 'burn, prove, mint: the switch turns it to Ethereum → Bitcoin');
    ok((await page.textContent('#rf')).includes('972,090'), 'the reflection drawing carries the live block');
    for (const [id, name] of [['#rf', 'sec-reflection'], ['#mv-h', 'sec-moves'], ['#c1-h', 'sec-note'], ['#c2-h', 'sec-b2e'], ['#c3-h', 'sec-e2b'], ['#c4-h', 'sec-trust'], ['#live-h', 'sec-live'], ['#rt-h', 'sec-roundtrip']]) {
      await page.evaluate((q) => { document.querySelector(q).scrollIntoView({ block: 'start' }); scrollBy(0, -90); }, id); await page.waitForTimeout(700); await shot(page, name);
    }
    await shot(page, 'desktop-full', true);
    ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ').slice(0, 400) : ''}`);
    await browser.close();
  }

  // ── a hash picks the tile; a phone, dark ──
  {
    const { browser, page, errors } = await openPage({ width: 390, height: 844 }, { scheme: 'dark', path: '/bridge/#teth/out' });
    await page.waitForFunction(() => document.querySelector('#bt').dataset.asset === 'teth', null, { timeout: 10000 });
    ok(await page.getAttribute('#bt-go', 'href') === '/#private/bitcoin' && await page.$eval('#bt', (b) => b.dataset.dir) === 'out', 'the link #teth/out opens on tETH to Bitcoin');
    await page.waitForTimeout(800);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on a phone');
    ok(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(21, 19, 14)', 'dark paper');
    await shot(page, 'phone-dark');
    await shot(page, 'phone-dark-full', true);
    for (const [id, name] of [['#rf', 'phone-reflection'], ['#mv-h', 'phone-moves']]) {
      await page.evaluate((q) => { document.querySelector(q).scrollIntoView({ block: 'start' }); scrollBy(0, -60); }, id); await page.waitForTimeout(900); await shot(page, name);
    }
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the wide drawings scroll inside their frames, not the page');
    ok(errors.length === 0, `no console errors on a phone${errors.length ? ': ' + errors.join(' | ').slice(0, 400) : ''}`);
    await browser.close();
  }

  // ── a browser with no bridges ──
  {
    const { browser, page, errors } = await openPage({ width: 1024, height: 800 }, { seed: false });
    await page.waitForTimeout(500);
    ok(!(await page.isVisible('#mine')), 'no bridges, no list');
    ok(errors.length === 0, 'no console errors with nothing journaled');
    await browser.close();
  }
} catch (e) {
  fails++;
  console.log('FAIL   ' + (e.stack || e));
}
server.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
