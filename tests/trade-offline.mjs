#!/usr/bin/env node
// dapp/trade/ with every Ethereum node and the Bitcoin API unreachable: each part says it could not read (not "reading" for ever, and not that nothing
// has traded), offers Try again, and the page tries again by itself soon after (5, 10 and 15 s), not only at the minute's refresh. Nothing here needs a
// network: every request to a node or the API is refused.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/trade-offline.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname); let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (p, s) => p.$eval(s, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');

const b = await chromium.launch();
try {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }), p = await ctx.newPage();
  let rpc = 0, api = 0; const errors = [];
  await ctx.route(/^https:\/\/(ethereum-rpc\.publicnode\.com|eth\.drpc\.org|1rpc\.io|mainnet\.gateway\.tenderly\.co)\//, (r) => { rpc++; r.abort(); });
  await ctx.route('https://api.tacit.finance/**', (r) => { api++; r.abort(); });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}/trade/tac/`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => /Could not read the pools/.test(document.querySelector('#px-sub')?.textContent || ''), null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  ok(/^Could not read the pools\. Try again$/.test(await text(p, '#px-sub')), 'the head says the pools could not be read, and offers another go (not "reading" for ever)');
  ok(/^Could not read the price history\. Try again in a moment\.$/.test(await text(p, '#chart')), 'the chart says its history could not be read (not that nothing has traded)');
  ok(/Could not read the Bitcoin order book/.test(await text(p, '#ladders')) && /Could not read the Bitcoin order book\./.test(await text(p, '#depthchart')) && !!(await p.$('#ladders [data-retry]')) && (await p.$eval('#ob-peek', (e) => e.hidden)), 'the Bitcoin book says so too, with a Try again, and no hint about pressing a price');
  ok(/Could not read the farm/.test(await text(p, '#fm-stats')), 'and so does the farm');
  const a0 = api, r0 = rpc;
  await p.waitForTimeout(6500);
  ok(api > a0 && rpc > r0, `the page tries again by itself within seconds (${api - a0} API and ${rpc - r0} node reads in 6 s)`);
  const a1 = api;
  await p.click('#px-sub [data-retry]');
  ok(/Trying…/.test(await text(p, '#px-sub')) || api > a1, 'Try again asks again at once');
  await p.waitForTimeout(2500);
  ok(api > a1, `and the reads go out (${api - a1} more API reads)`);
  ok(errors.length === 0, `no page errors from the refusals (${errors.slice(0, 2).join(' | ')})`);
  await ctx.close();
} catch (e) { fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' / ')); }
await b.close(); server.close();
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\n${n} trade-offline checks passed`);
process.exit(fails ? 1 : 0);
