#!/usr/bin/env node
// dapp/walletconnect.js on its own, in a real browser over the stand-in for its bundle (tests/wc-fake.mjs), with its own sheets (overlayHost):
// the pairing sheet's code and Copy link for a screen reader, a pairing closed before the wallet app approved it, a network switch the session
// already allows, and a bundle that does not arrive.
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/walletconnect-provider.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { useWcFake, WC_FAKE_BUNDLE } from './wc-fake.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
// A page of nothing but the module, announced for Ethereum, Base and Robinhood Chain; each request's outcome is kept in window.__out.
const PAGE = `<!doctype html><meta charset="utf-8"><title>wc</title><body><script type="module">
const m = await import('/walletconnect.js');
const sheets = m.wcSheets(m.overlayHost());
window.__asks = [];
const { provider } = m.announceWalletConnect({
  projectId: 'test', chains: [1, 8453, 4663], rpcMap: {}, metadata: { name: 'test', description: 'test', url: location.origin, icons: [] },
  onPair: sheets.onPair, onAsk: (x) => { window.__asks.push(x.name); return sheets.onAsk(x); },
});
window.__out = {};
window.__ask = (key, method, params) => { window.__out[key] = 'waiting'; provider.request({ method, params }).then((r) => { window.__out[key] = { ok: r }; }, (e) => { window.__out[key] = { err: e.message, code: e.code }; }); };
window.__ready = true;
</script></body>`;
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  const f = normalize(join(DAPP, p));
  if (!f.startsWith(DAPP) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': extname(f) === '.js' ? 'text/javascript' : 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const out = (p, key) => p.evaluate((k) => window.__out[k], key);
const settled = (p, key) => p.waitForFunction((k) => window.__out[k] && window.__out[k] !== 'waiting', key, { timeout: 15000 });

const browser = await chromium.launch();
try {
  // Pairing, cancelled and paired again; then network switches.
  {
    const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await useWcFake(ctx);
    // What the wallet app is asked to switch to, with the sheet's title at that moment.
    const wallet = [];
    let p = null;
    await ctx.exposeFunction('__wcRequest', async (method, params) => {
      if (method !== 'wallet_switchEthereumChain') return undefined;
      wallet.push([params[0].chainId, await p.evaluate(() => document.querySelector('dialog.wcx[open] h2')?.textContent || '')]);
      return null;
    });
    p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e.message || e)));
    await p.goto(ORIGIN + '/');
    await p.waitForFunction(() => window.__ready);

    await p.evaluate(() => window.__ask('pair1', 'eth_requestAccounts'));
    await p.waitForSelector('dialog.wcx[open] .wc-qr');
    const qr = await p.$eval('dialog.wcx .wc-qr', (e) => ({ role: e.getAttribute('role'), label: e.getAttribute('aria-label') }));
    ok(qr.role === 'img' && /QR code/.test(qr.label || ''), `the pairing code is an image with a text alternative (${qr.label})`);
    const live = await p.$eval('dialog.wcx [data-copied]', (e) => ({ role: e.getAttribute('role'), live: e.getAttribute('aria-live'), text: e.textContent }));
    ok(live.role === 'status' && live.live === 'polite' && live.text === '', 'a status line for Copy link is in the sheet, empty until it is pressed');
    await p.click('dialog.wcx [data-copy]');
    await p.waitForFunction(() => document.querySelector('dialog.wcx [data-copied]').textContent !== '');
    const copied = await p.$eval('dialog.wcx', (d) => ({ label: d.querySelector('[data-copy]').textContent, said: d.querySelector('[data-copied]').textContent }));
    ok((copied.label === 'Copied' && copied.said === 'Link copied') || (copied.label === 'Could not copy' && copied.said === 'Could not copy the link'), `what came of Copy link is said in the status line (${copied.label} / ${copied.said})`);

    // The code is scanned, the sheet closed, and the wallet app approves after.
    await p.click('dialog.wcx .wcx-x');
    await settled(p, 'pair1');
    const r1 = await out(p, 'pair1');
    ok(r1.code === 4001 && /cancel/i.test(r1.err), `closing the sheet ends the request as cancelled (${r1.err})`);
    ok((await p.evaluate(() => window.__wcfake.cancelled)) === 1, 'and deletes the pairing waiting for the wallet app');
    await p.evaluate(() => window.__wcfake.approve());
    await p.waitForTimeout(300);
    await p.evaluate(() => window.__ask('accts', 'eth_accounts'));
    await settled(p, 'accts');
    ok((await out(p, 'accts')).ok?.length === 0 && !(await p.evaluate(() => localStorage.getItem('fake-wc-session'))), 'an approval that comes after the sheet closed opens no session');

    // Connect again: a new code, approved for Ethereum and Base only.
    await p.evaluate(() => window.__ask('pair2', 'eth_requestAccounts'));
    await p.waitForSelector('dialog.wcx[open] .wc-qr');
    await p.evaluate(() => { window.__wcfake.approveChains = [1, 8453]; window.__wcfake.approve(); });
    await settled(p, 'pair2');
    ok((await out(p, 'pair2')).ok?.length === 1 && (await p.evaluate(() => window.__wcfake.pairs)) === 2, 'the next Connect pairs afresh and the wallet app connects');

    // A switch to a network the session holds is made by the provider alone: no sheet, nothing asked of the wallet app.
    await p.evaluate(() => window.__ask('base', 'wallet_switchEthereumChain', [{ chainId: '0x2105' }]));
    await settled(p, 'base');
    await p.evaluate(() => window.__ask('cid1', 'eth_chainId'));
    await settled(p, 'cid1');
    ok((await p.evaluate(() => window.__asks.length)) === 0 && wallet.length === 0 && (await out(p, 'cid1')).ok === '0x2105', `a switch to Base, which the session holds, shows no sheet and asks the wallet app nothing (${(await out(p, 'cid1')).ok})`);
    // A switch to one it does not hold goes to the wallet app, and the page says where to approve it.
    await p.evaluate(() => window.__ask('rh', 'wallet_switchEthereumChain', [{ chainId: '0x1237' }]));
    await settled(p, 'rh');
    const shown = await p.evaluate(() => window.__asks.length);
    await p.evaluate(() => window.__ask('cid2', 'eth_chainId'));
    await settled(p, 'cid2');
    ok(shown === 1 && wallet.length === 1 && wallet[0][0] === '0x1237' && wallet[0][1] === 'Approve in your wallet' && (await out(p, 'cid2')).ok === '0x1237',
      `a switch to Robinhood Chain, which it does not hold, asks the wallet app with "Approve in your wallet" up (${JSON.stringify(wallet)})`);
    ok(!(await p.$('dialog.wcx[open]')), 'and the sheet goes once the wallet app answers');
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
  }

  // The bundle does not arrive: the request ends in words after the wait, and the bundle arriving later is used by the next one.
  {
    const ctx = await browser.newContext();
    let held = null;
    await ctx.route('**/vendor/tacit-walletconnect.min.js*', (r) => { held = r; });
    const p = await ctx.newPage(), errors = [];
    p.on('pageerror', (e) => errors.push(String(e.message || e)));
    await p.clock.install();
    await p.goto(ORIGIN + '/');
    await p.waitForFunction(() => window.__ready);
    await p.clock.pauseAt(new Date(Date.now() + 5000));                  // the page's time moves only when the test moves it
    await p.evaluate(() => window.__ask('stall', 'eth_requestAccounts'));
    for (let i = 0; i < 50 && !held; i++) await p.waitForTimeout(100);
    await p.clock.runFor(19_000);
    ok((await out(p, 'stall')) === 'waiting', 'it waits for the bundle a while');
    await p.clock.runFor(1_500);
    await settled(p, 'stall');
    const r = await out(p, 'stall');
    ok(/WalletConnect did not load/.test(r.err || ''), `then says WalletConnect did not load (${r.err})`);
    await held.fulfill({ status: 200, contentType: 'text/javascript', body: WC_FAKE_BUNDLE });
    await p.waitForFunction(() => window.__wcfake?.inits === 1, null, { timeout: 15000 });
    await p.evaluate(() => window.__ask('again', 'eth_requestAccounts'));
    await p.waitForSelector('dialog.wcx[open] .wc-qr', { timeout: 15000 });
    ok((await p.evaluate(() => window.__wcfake.inits)) === 1, 'a bundle that arrives after the wait is started once and used by the next Connect');
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `\n${fails} of ${n + fails} walletconnect-provider checks FAILED` : `\n${n} walletconnect-provider checks passed`);
process.exit(fails ? 1 : 0);
