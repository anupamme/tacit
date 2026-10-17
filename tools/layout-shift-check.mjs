#!/usr/bin/env node
// A read-only check that no page moves under the reader while it loads: every page that wears the shared header (build/chrome.mjs's list, and
// /trade/tac/) is opened at a phone and at a desktop width on a throttled connection, and the layout shifts Chrome reports over the load are
// added up. Nothing is signed or sent. A page over the limit is listed with what moved (the element, and where it was and went).
//
//   PLAYWRIGHT=/path/to/node_modules/playwright-core node tools/layout-shift-check.mjs [https://tacit.finance] [limit=0.1]
//
// A page is measured from its own network and the public nodes it reads, so a figure moves a little between runs; a page that is over the
// limit is measured again before it counts. A block that fills in after the first paint should hold the height it will have (the .loading
// rules in the pages' own styles); see how the vault, tasks and stats pages do it. Exit 1 when a page stays over the limit.
import { createRequire } from 'node:module';
import { CHROME_PAGES } from '../build/chrome.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const BASE = (process.argv[2] || 'https://tacit.finance').replace(/\/$/, ''), LIMIT = Number(process.argv[3] || 0.1);
const SIZES = [['phone', 390, 844], ['desktop', 1440, 900]];
const paths = [...Object.keys(CHROME_PAGES).map((p) => `/${p.replace(/index\.html$/, '')}`), '/trade/tac/'];

const browser = await chromium.launch();
async function measure(path, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const name = (n) => { const e = n && (n.nodeType === 3 ? n.parentElement : n); return e ? `${e.nodeName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/)[0]}` : ''}` : '?'; };
      window.__shift = { total: 0, moves: [] };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__shift.total += e.value;
          if (e.value >= 0.01) window.__shift.moves.push(`${Math.round(e.startTime)} ms ${e.value.toFixed(3)} ${(e.sources || []).slice(0, 2).map((s) => `${name(s.node)} ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)}`).join(', ')}`);
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 4e6 / 8, uploadThroughput: 1e6 / 8 });
    await page.goto(BASE + path, { waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(5000);
    return await page.evaluate(() => window.__shift);
  } finally { await ctx.close(); }
}

let fails = 0;
for (const path of paths) {
  const row = [];
  for (const [label, w, h] of SIZES) {
    let m = await measure(path, w, h);
    if (m.total > LIMIT) { const again = await measure(path, w, h); if (again.total < m.total) m = again; }
    const over = m.total > LIMIT;
    if (over) fails++;
    row.push({ label, m, over });
  }
  console.log(`${row.some((r) => r.over) ? 'FAIL' : 'ok  '} ${path.padEnd(16)} ${row.map((r) => `${r.label} ${r.m.total.toFixed(4)}`).join('   ')}`);
  for (const r of row) if (r.over) for (const line of r.m.moves) console.log(`       ${r.label}: ${line}`);
}
await browser.close();
console.log(fails ? `\n${fails} page size(s) over ${LIMIT}` : `\nno page moves more than ${LIMIT}`);
process.exit(fails ? 1 : 0);
