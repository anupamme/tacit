#!/usr/bin/env node
// dapp/vault/ in a real browser, under its own CSP, against two TacVaults (a dollar vault and an ETH vault) deployed on a local anvil with
// the test price oracle: the room to borrow, a position and its health bar, the top-up prompt, deposit (a permit, and the approval it falls back to),
// borrow with its fee, repay (short of the fee, then all), withdraw, the paused state, an auction, a read-only account, and the opens-soon state of
// the page as deployed (no addresses). Every limit the page offers is checked against the contract itself: the amount is accepted by an eth_call, one
// wei more is refused.
//
//   VAULT_OUT=<forge out dir> PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/vault-page.mjs        (SHOTS=dir saves screenshots)
//
// VAULT_OUT holds the compiled TacVault, the test mocks (contracts/test/TacVaultMocks.sol) and FixedFeed; it defaults to contracts/out. Without them
// the test says so and stops.
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const REPO = new URL('../', import.meta.url).pathname, DAPP = join(REPO, 'dapp'), FX = join(REPO, 'tests/fixtures');
const OUT = process.env.VAULT_OUT || join(REPO, 'contracts/out'), SHOTS = process.env.SHOTS || null;
const need = ['TacVault.sol/TacVault', 'TacVaultMocks.sol/TestTac', 'TacVaultMocks.sol/MockOracle', 'TacVaultMocks.sol/LiveFeed', 'FixedFeed.sol/FixedFeed'];
if (need.some((f) => !existsSync(join(OUT, `${f}.json`)))) { console.log(`skipped: ${OUT} has no compiled TacVault and test mocks (forge build, or set VAULT_OUT)`); process.exit(0); }
const PW = process.env.PLAYWRIGHT || (existsSync('/Users/z/zFi/node_modules/playwright-core') ? '/Users/z/zFi/node_modules/playwright-core' : 'playwright-core');
const { chromium } = createRequire(import.meta.url)(PW);
const PORT = Number(process.env.ANVIL_PORT) || 21000 + Math.floor(Math.random() * 1000), WEB = Number(process.env.WEB_PORT) || PORT + 1, ANVIL = `http://127.0.0.1:${PORT}`;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const anvil = spawn('anvil', ['--port', String(PORT), '--chain-id', '1', '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
let server;
const finish = (code) => { anvil.kill('SIGKILL'); server?.close(); process.exit(code); };
process.on('exit', () => anvil.kill('SIGKILL'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) { try { await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })).json(); break; } catch { if (i > 60) throw new Error('anvil did not start'); await sleep(250); } }

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

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);
const lost = async (page, e) => { const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 700)).catch(() => ''); e.message += `\n  page said: ${t}`; throw e; };
const until = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout }).catch((e) => lost(page, e));
const untilText = (page, sel, re, timeout = 30000) => page.waitForFunction(([s, src, fl]) => new RegExp(src, fl).test((document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ')), [sel, re.source, re.flags], { timeout }).catch((e) => lost(page, e));

// ── the chain ──
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const rpcA = async (method, params = []) => { const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result; };
const ACC = {
  deployer: { a: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', k: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  owner: { a: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', k: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
  user: { a: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', k: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' },
  bob: { a: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', k: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' },
  carol: { a: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', k: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' },
};
const FEE_TO = '0x00000000000000000000000000000000000000Fe', SINK = '0x000000000000000000000000000000000000dEaD';
const E18 = 10n ** 18n, MAXU = (1n << 256n) - 1n;
const art = (f) => JSON.parse(readFileSync(join(OUT, `${f}.json`), 'utf8')).bytecode.object;
const create = (data) => JSON.parse(cast('send', '--private-key', ACC.deployer.k, '--rpc-url', ANVIL, '--json', '--create', data)).contractAddress;
const send = (who, to, sig, ...args) => cast('send', to, sig, ...args, '--private-key', ACC[who].k, '--rpc-url', ANVIL, '--json');
const view = (to, sig, ...args) => cast('call', to, sig, ...args, '--rpc-url', ANVIL).split('\n').map((l) => l.trim().split(/\s+/)[0]);
const big = (to, sig, ...args) => BigInt(view(to, sig, ...args)[0]);
const reverts = (fn) => { try { fn(); return false; } catch { return true; } };
const asCall = (who, to, sig, ...args) => cast('call', to, sig, ...args, '--from', ACC[who].a, '--rpc-url', ANVIL);

// Multicall3 is where the page expects it; two vaults share one test oracle and TAC; the dollar vault prices through a feed that says 2,500, the
// ETH vault through the fixed feed (1.0).
await rpcA('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', readFileSync(join(FX, 'multicall3-runtime.hex'), 'utf8').trim()]);
const TAC = create(art('TacVaultMocks.sol/TestTac')), ORACLE = create(art('TacVaultMocks.sol/MockOracle'));
const FEED = create(art('TacVaultMocks.sol/LiveFeed')), FIXED = create(art('FixedFeed.sol/FixedFeed'));
const noLimit = MAXU.toString();
const makeVault = (feed, name, symbol, minDebt) => {
  const cfg = `(${TAC},${ORACLE},${feed},${ACC.owner.a},35000,20000,2500,5400,1200,${minDebt},3900,${noLimit},500,50,100,${FEE_TO},${SINK},${name},${symbol})`;
  const enc = cast('abi-encode', 'f((address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address,string,string))', cfg);
  return create(art('TacVault.sol/TacVault') + enc.slice(2));
};
const USD = makeVault(FEED, 'TAC Dollar', 'TACD', (100n * E18).toString()), ETH = makeVault(FIXED, 'TAC Ether', 'TACE', (E18 / 25n).toString());
const SYN = { usd: view(USD, 'SYNTH()(address)')[0], eth: view(ETH, 'SYNTH()(address)')[0] };
const P0 = 10n ** 14n;                                                                                  // 0.0001 ETH per TAC: $0.25 at 2,500
const setPrice = (p) => send('deployer', ORACLE, 'set(uint256)', String(p));
setPrice(P0); send('deployer', ORACLE, 'setDepth(uint256)', String(2000n * E18));                      // 2,000 ETH deep: room is 5% of it in each synth
const mintTac = (to, amount) => send('deployer', TAC, 'mint(address,uint256)', to, String(amount));
mintTac(ACC.user.a, 1_000_000n * E18); mintTac(ACC.bob.a, 1_000_000n * E18); mintTac(ACC.carol.a, 1_000_000n * E18);
const vaultOf = (v, who) => { const [c, d, a] = view(v, 'vaults(address)(uint256,uint256,uint256)', ACC[who].a); return { c: BigInt(c), d: BigInt(d), a: BigInt(a) }; };
const snap = async () => (await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp;

// ── the page ──
const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co'];
async function stubWallet(ctx, { who, noTyped = false }) {
  const log = { sends: [], signs: 0 };
  await ctx.exposeFunction('__wallet', async (method, params) => {
    const a = ACC[who].a;
    if (method === 'eth_requestAccounts') return [a];
    if (method === 'eth_accounts') return [a];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_signTypedData_v4') { if (noTyped) throw Object.assign(new Error('Method not supported'), { code: -32601 }); log.signs++; return cast('wallet', 'sign', '--private-key', ACC[who].k, '--data', params[1]); }
    if (method === 'eth_sendTransaction') { log.sends.push(params[0]); return rpcA('eth_sendTransaction', [{ ...params[0], gas: '0x3d0900' }]); }
    throw new Error(`the stub wallet does not do ${method}`);
  });
  await ctx.addInitScript(() => { window.__h = {}; window.ethereum = { isStub: true, request: ({ method, params }) => window.__wallet(method, params), on(ev, fn) { window.__h[ev] = fn; }, removeListener() {} }; });
  return log;
}
const hashFor = (extra = '') => `#vusd=${USD}&veth=${ETH}${extra}`;
// `bare`: the page served with a deployments module that names no vault, as it was before the vaults existed (the opens-soon state).
async function openPage({ viewport = { width: 1280, height: 900 }, who = null, noTyped = false, hash = hashFor(), host = '127.0.0.1', scheme = 'light', args = [], bare = false } = {}) {
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  if (bare) await ctx.route('**/vault/deployments.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const DEPLOYMENTS = Object.freeze({ chainId: 1, vaults: Object.freeze([]) });' }));
  const walletLog = who ? await stubWallet(ctx, { who, noTyped }) : null;
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, async (route) => {
    try {
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
    } catch (e) { await route.fulfill({ status: 502, headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
  });
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => { if (process.env.DEBUG) console.log('[pageerror]', e.message); errors.push(String(e.message || e)); });
  if (process.env.DEBUG) page.on('requestfailed', (q) => console.log('[requestfailed]', q.url().slice(0, 100), q.failure()?.errorText));
  page.on('console', (m) => { if (process.env.DEBUG) console.log('[page]', m.type(), m.text()); if (m.type() === 'error') { const t = m.text(); (/Content Security Policy|Refused to/i.test(t) ? blocked : errors).push(t); } });
  await page.goto(`http://${host}:${WEB}/vault/${hash}`);
  return { browser, ctx, page, errors, blocked, walletLog };
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }) : null);
const closeAll = async (...rs) => { for (const r of rs) await r?.browser.close().catch(() => {}); };
const money = (s) => BigInt(Math.round(Number(s.replace(/,/g, '')) * 100)) * (E18 / 100n);                // "1,234.56" → wei, for what the page writes to two places
const typed = async (p, v) => { await p.fill('#amt', v); await sleep(60); };
const chipMax = async (p) => { await p.click('#chips [data-pct="100"]'); await sleep(60); return BigInt(cast('to-wei', await p.inputValue('#amt'))); };
// Connect the stub wallet once the page has read the vaults (a click before its script has run does nothing).
const connect = async (p) => { await until(p, () => !!document.querySelector('#board table') && /Room to borrow/.test(document.querySelector('#board')?.textContent || '')); await p.click('#go'); await until(p, () => /^0x/.test(document.querySelector('#wallet-label')?.textContent || '')); };
const tab = async (p, t) => { await p.click(`#acts [data-t="${t}"]`); await sleep(60); };

let r, r2;
try {
  // ── as deployed: the two mainnet vaults ──
  const { DEPLOYMENTS } = await import(new URL('../dapp/vault/deployments.js', import.meta.url).href);
  ok(DEPLOYMENTS.chainId === 1 && DEPLOYMENTS.vaults.map((v) => v.key).join() === 'usd,eth' && DEPLOYMENTS.vaults.every((v) => /^0x0{6}[0-9a-fA-F]{34}$/.test(v.vault)), `the page names the dollar and the ETH vault on mainnet (${DEPLOYMENTS.vaults.map((v) => v.vault).join(', ')})`);
  // ── with no addresses the page opens soon; an address in the bar is ignored away from this computer ──
  r = await openPage({ hash: '', bare: true });
  await until(r.page, () => !document.querySelector('#soon').hidden);
  const soon = await text(r.page, '#soon');
  ok(/Opens soon/.test(soon) && /TAC Dollar \(TACD\)/.test(soon) && /TAC Ether \(TACE\)/.test(soon) && (soon.match(/\./g) || []).length <= 3, `with no addresses the page says it opens soon, in two sentences (${soon.slice(0, 120)}…)`);
  ok(await r.page.$eval('#app', (e) => e.hidden) && await r.page.$eval('#wallet-chip', (e) => e.hidden), 'and shows no vault and no wallet button');
  ok(r.errors.length === 0 && r.blocked.length === 0, `with nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
  await shot(r.page, 'soon');
  await closeAll(r);
  r = await openPage({ host: 'vault.localhost', bare: true });
  await sleep(1500);
  ok(!(await r.page.$eval('#soon', (e) => e.hidden)) && await r.page.$eval('#app', (e) => e.hidden), 'vault addresses in the address bar are ignored away from this computer: the page still opens soon');
  await closeAll(r);

  // ── the address without its slash goes to the page, the fragment kept ──
  r = await openPage({ hash: '' }); await r.page.goto(`http://127.0.0.1:${WEB}/vault${hashFor('&a=' + ACC.user.a)}`);
  await until(r.page, () => location.pathname === '/vault/' && !document.querySelector('#app').hidden);
  ok(r.page.url() === `http://127.0.0.1:${WEB}/vault/${hashFor('&a=' + ACC.user.a)}`, '/vault goes to /vault/ and keeps the #fragment');
  await closeAll(r);

  // ── public numbers, no wallet ──
  r = await openPage();
  const p = r.page;
  await until(p, () => /250,000\s*TACD/.test(document.querySelector('#board')?.textContent || ''));
  const cap = await text(p, '#board');
  ok(/Borrowing is open on both vaults/.test(cap) && /Room to borrow\s*250,000 TACD\s*100 TACE/.test(cap) && /Borrowed so far\s*0 TACD\s*0 TACE/.test(cap) && /Fee\s*1%\s*1%/.test(cap) && /Smallest debt\s*100 TACD\s*0\.04 TACE/.test(cap), `the status board says both are open, with the room (the depth's 5% less the debt), the smallest debt, the fee and what is borrowed: ${cap.slice(0, 200)}`);
  ok(!/Pools' depth|TAC price|Collateral ratio/.test(cap) && (await text(p, '#board [data-more]')) === 'More figures', 'the further figures wait behind More figures');
  await p.click('#board [data-more]');
  const more = await text(p, '#board');
  ok(/Pools' depth\s*5,000,000 TACD.*2,000 TACE/.test(more) && /Share of depth lent\s*5%\s*5%/.test(more) && /Borrow \/ liquidate at\s*350% · 200%\s*350% · 200%/.test(more) && /TAC deposited\s*0 TAC\s*0 TAC/.test(more), 'and give the pools\' depth, the share of it lent, the TAC deposited and the ratios');
  ok(/TAC price\s*\$0\.25\s*0\.0001 ETH/.test(more) && /ETH\/USD price\s*\d+ (min|s|h)[^—]*—/.test(more) && (await text(p, '#board [data-more]')) === 'Fewer figures', 'the TAC price now in each vault\'s token, and how old the dollar feed is (TAC Ether has none)');
  ok(await p.evaluate(() => localStorage.getItem('tacit-vault-more')) === '1', 'the choice is kept in this browser');
  ok(/^Borrowing open/.test(await p.title()) && /read (just now|\d+ s ago)/.test(await text(p, '#board .eyebrow')) && !!(await p.$('#board [data-refresh]')), 'the tab\'s title says borrowing is open, and the board says when it was read, with a Refresh');
  ok((await p.$$eval('#pick button', (b) => b.map((x) => x.textContent))).join('|') === 'TAC DollarTACD|TAC EtherTACE', 'two vaults to pick: TAC Dollar and TAC Ether');
  ok(/Connect a wallet to see your vault/.test(await text(p, '#pos')) && /Connect wallet/.test(await text(p, '#go')), 'with no wallet the position asks for one and the button connects');
  ok(r.errors.length === 0 && r.blocked.length === 0, `nothing logged or blocked (${[...r.errors, ...r.blocked].join(' | ')})`);
  // the ETH vault's own numbers: room 100 TACE, in ETH terms
  await p.click('#pick [data-v="eth"]');
  await until(p, () => /TAC Ether vault/.test(document.querySelector('#ticket')?.textContent || ''));
  ok(/Room to borrow\s*250,000 TACD\s*100 TACE/.test(await text(p, '#board')) && /Borrow TACE|TACE to deposit|TAC to deposit/.test(await text(p, '#ticket')), 'choosing the ETH vault leaves the board showing both, and the ticket speaks of TACE');
  await closeAll(r);

  // ── paused: no price recorded ──
  send('deployer', ORACLE, 'setBroken(bool)', 'true');
  r = await openPage();
  await until(r.page, () => /Prices cannot be read right now/.test(document.querySelector('#board')?.textContent || ''));
  const pb = await text(r.page, '#board');
  ok(/Borrowing is not open yet/.test(pb) && /Borrowing\s*Not open.*Not open/.test(pb) && /Room to borrow\s*—\s*—/.test(pb) && !/error|revert/i.test(pb) && /^Borrowing not open yet/.test(await r.page.title()), 'with no price the board says borrowing is not open and that prices cannot be read, calmly, with no room shown');
  ok(r.errors.length === 0, 'and logs no error');
  await shot(r.page, 'paused');
  await closeAll(r);
  send('deployer', ORACLE, 'setBroken(bool)', 'false');

  // ── thin: the room is under the smallest debt ──
  send('deployer', ORACLE, 'setDepth(uint256)', String(E18 / 2n));                                       // 0.5 ETH deep: the room is 0.025 ETH, under each vault's smallest debt
  r = await openPage();
  await until(r.page, () => /under the smallest debt/.test(document.querySelector('#board')?.textContent || ''));
  const tb = await text(r.page, '#board');
  ok(/Borrowing is not open yet/.test(tb) && /Room to borrow\s*62\.5 TACD\s*0\.025 TACE/.test(tb) && /TAC Dollar: Room \(62\.5 TACD\) is under the smallest debt \(100 TACD\)/.test(tb) && /TAC Ether: Room \(0\.025 TACE\) is under the smallest debt \(0\.04 TACE\)/.test(tb), `a room under the smallest debt is said with both figures, and the vault is not open (${tb.slice(0, 160)})`);
  ok(/^Borrowing not open yet/.test(await r.page.title()) && (await r.page.$eval('#board .needs a[href="/trade/tac/#farm"]', (a) => a.textContent)) === 'Add liquidity', 'the tab says so too, and the way to more room is the TAC pools');
  // an announced change to the share of depth lent opens it: the board says what the room becomes and from when
  send('owner', USD, 'queueParam(uint8,uint256)', '0', '1000'); send('owner', ETH, 'queueParam(uint8,uint256)', '0', '1000');
  await r.page.reload();
  await until(r.page, () => /borrowing opens from/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  const ta = await text(r.page, '#board');
  ok(/The announced change makes the room 125 TACD \(smallest debt 100 TACD\): borrowing opens from \d+ \w+ \d+:\d+ UTC/.test(ta) && /makes the room 0\.05 TACE \(smallest debt 0\.04 TACE\): borrowing opens from/.test(ta), `an announced change that opens it says the room it makes and from when (${ta.replace(/\s+/g, ' ').slice(120, 330)})`);
  send('owner', USD, 'cancelParam(uint8)', '0'); send('owner', ETH, 'cancelParam(uint8)', '0');
  send('deployer', ORACLE, 'setDepth(uint256)', String(2000n * E18));
  await closeAll(r);

  // ── a wallet: deposit, by permit ──
  r = await openPage({ who: 'user' });
  const u = r.page, W = r.walletLog;
  await until(u, () => /250,000\s*TACD/.test(document.querySelector('#board')?.textContent || ''));
  await connect(u);
  await until(u, () => /Nothing deposited yet/.test(document.querySelector('#pos')?.textContent || ''));
  ok(/Nothing deposited yet\. Deposit TAC to borrow TACD against it\./.test(await text(u, '#pos')), 'connected, a new account has nothing in the vault');
  await until(u, () => /Balance 1,000,000/.test(document.querySelector('#bal')?.textContent || ''));
  await typed(u, '100000');
  ok(/Collateral after\s*100,000 TAC/.test(await text(u, '#info')) && /Deposit TAC/.test(await text(u, '#go')), 'typing a deposit shows the collateral after it, and the button');
  await u.click('#go');
  await untilText(u, '#status', /Deposited 100,000 TAC/, 60000);
  ok(W.signs === 1 && W.sends.length === 1 && W.sends[0].to.toLowerCase() === USD.toLowerCase(), `no allowance: one permit signed (no gas) and ONE transaction sent to the vault (${W.signs} signature, ${W.sends.length} sent)`);
  ok(vaultOf(USD, 'user').c === 100000n * E18 && big(TAC, 'allowance(address,address)(uint256)', ACC.user.a, USD) === 0n, 'the vault holds 100,000 TAC and no allowance is left over');
  await until(u, () => /100,000 TAC/.test(document.querySelector('#pos')?.textContent || ''));
  ok(/Collateral\s*100,000 TAC\s*25,000 TACD/.test(await text(u, '#pos')), `the position shows the collateral and its value at the liquidation view (${(await text(u, '#pos')).slice(0, 100)})`);

  // ── borrow: what the limit is, what the fee does, and what the contract says ──
  await tab(u, 'borrow');
  const L = await chipMax(u);                                                                            // the limit, exactly
  ok(L > 0n && !reverts(() => asCall('user', USD, 'borrow(uint256,uint256)', String(L), '100')) && reverts(() => asCall('user', USD, 'borrow(uint256,uint256)', String(L + 1n), '100')), `the limit the page gives (${L} wei) is accepted by the vault, one wei more is refused`);
  ok(/Up to 7,072\.\d\d · Max/.test(await text(u, '#bal')) && L >= 7072n * E18 && L < 7073n * E18, 'at 350% of $25,000 with a 1% fee on top the limit is 7,072 TACD');
  await typed(u, '3000');
  const rows = await text(u, '#info');
  ok(/Fee \(1%\)\s*30 TACD/.test(rows) && /You receive\s*3,000 TACD/.test(rows) && /You owe after\s*3,030 TACD/.test(rows) && /Ratio after\s*825%/.test(rows), `the fee is shown before: ${rows}`);
  await typed(u, '8000');
  ok(/You can borrow up to 7,072\.\d\d TACD now/.test(await text(u, '#hint')) && await u.$eval('#go', (b) => b.disabled), 'over the limit it says how much is allowed instead of failing late');
  await typed(u, '50');
  ok(/Smallest debt is 100 TACD: borrow at least 99(\.0\d)?\./.test(await text(u, '#hint')) && await u.$eval('#go', (b) => b.disabled), 'under the minimum debt it says what to borrow at least');
  await typed(u, '3000');
  W.sends.length = 0;
  await u.click('#go');
  await untilText(u, '#status', /Borrowed 3,000 TACD\. You owe 3,030/, 60000);
  ok(W.sends.length === 1 && vaultOf(USD, 'user').d === 3030n * E18 && big(SYN.usd, 'balanceOf(address)(uint256)', ACC.user.a) === 3000n * E18, 'borrowing sends one transaction: 3,000 received, 3,030 owed');
  ok(W.sends[0].data === cast('calldata', 'borrow(uint256,uint256)', String(3000n * E18), '100'), 'its maximum fee is the fee on the screen (100 basis points)');
  ok(big(SYN.usd, 'balanceOf(address)(uint256)', FEE_TO) === 30n * E18, 'and the 30 fee went to the fee address');
  // the owner raises the fee while a borrow sits on the screen: the page stops, with the new fee, and sends nothing
  await typed(u, '200'); W.sends.length = 0;
  send('owner', USD, 'setBorrowFee(uint256)', '200');
  await u.click('#go');
  await untilText(u, '#status', /The borrow fee is now 2%\. Nothing was sent/, 30000);
  ok(W.sends.length === 0 && vaultOf(USD, 'user').d === 3030n * E18, 'a borrow on the screen at a 1% fee is not sent at 2%: the page says the fee changed and sends nothing');
  await u.fill('#amt', ''); send('owner', USD, 'setBorrowFee(uint256)', '100');
  await until(u, () => /Ratio\s*825%/.test(document.querySelector('#pos')?.textContent || ''));
  const pos = await text(u, '#pos');
  ok(/Debt\s*3,030 TACD/.test(pos) && /Safe/.test(pos) && /You can borrow\s*4,0\d\d(\.\d+)? TACD/.test(pos) && /Liquidation price\s*\$0\.0\d+/.test(pos), `the position: ratio 825%, debt, what is still available and the liquidation price (${pos.slice(0, 260)})`);
  // the liquidation price is the price at which the vault is at 200%: 3,030 × 2 / 100,000 = $0.0606 per TAC, shown rounded up
  ok(/Liquidation price\s*\$0\.0606/.test(pos), 'the liquidation price is where the vault is at 200%: $0.0606 per TAC');
  const hb = await u.evaluate(() => { const f = (s) => parseFloat(document.querySelector(s)?.style.left || 'NaN'); return { pin: f('.hb-pin'), tick: f('.hb-tick'), on: [...document.querySelectorAll('.hb-key span.on')].map((e) => e.textContent) }; });
  ok(Math.abs(hb.tick - 62.5) < 0.01 && hb.pin === 100 && hb.on.join() === 'Safe', `the health bar: the borrowing line is at 350% (${hb.tick}% across), the marker at the safe end (825% is off the bar's end), the Safe zone is the lit one`);
  await shot(u, 'safe-desktop');

  // ── a price fall: into redemption, the top-up prompt ──
  setPrice(P0 * 3n / 10n);                                                                               // $0.075 a TAC: $7,500 against 3,030 owed = 247%
  await u.reload(); await until(u, () => /Ratio\s*247%/.test(document.querySelector('#pos')?.textContent || ''));
  const pos2 = await text(u, '#pos');
  const need = (4n * 3030n * E18 - 7500n * E18) * E18 / (P0 * 3n / 10n * 2500n);                           // (4 × debt − value) / price, the formula, in TAC
  ok(/Redemption/.test(pos2) && /Open to redemption: a TACD holder can swap it for your TAC at its price, and your debt falls by as much/.test(pos2), 'between 200% and 400% the page says what redemption is');
  const topText = await text(u, '#pos .callout');
  const topFill = await u.$eval('#pos [data-fill]', (b) => b.dataset.fill);
  ok(/Add 61,600 TAC to reach 400%/.test(topText) && BigInt(cast('to-wei', topFill)) >= need && BigInt(cast('to-wei', topFill)) - need < E18 / 50n, `the top-up prompt says how much TAC reaches 400% (${topText}); the fill is the formula's figure rounded up to a cent (${topFill} vs ${need})`);
  const zonesNow = await u.$eval('#pos', (e) => [...e.querySelectorAll('.hb-key span.on')].map((x) => x.textContent).join());
  ok(zonesNow === 'Redemption', 'the redemption zone is the lit one');
  await shot(u, 'redemption-desktop');
  await u.click('#pos [data-fill]');
  ok(await u.inputValue('#amt') === topFill && (await u.$eval('#acts [aria-pressed="true"]', (e) => e.textContent)) === 'Deposit', 'one tap fills the deposit box with that amount');
  const ratioAfter = await text(u, '#info');
  ok(/Ratio after\s*4\d\d%/.test(ratioAfter), `and the ticket shows the ratio it leaves (${ratioAfter})`);
  const before = vaultOf(USD, 'user'); W.signs = 0; W.sends.length = 0;
  await u.click('#go');
  await untilText(u, '#status', /Deposited/, 60000);
  const after = vaultOf(USD, 'user');
  const safeNow = big(USD, 'valueOf(uint256,bool)(uint256)', String(after.c), 'false') * 10000n >= after.d * 40000n;
  ok(safeNow && after.c - before.c === BigInt(cast('to-wei', topFill)), 'depositing exactly the amount reaches 400% at the contract\'s own liquidation view');
  ok(!(big(USD, 'valueOf(uint256,bool)(uint256)', String(after.c - 10n ** 16n), 'false') * 10000n >= after.d * 40000n), 'and one cent of TAC less would not have');
  await until(u, () => /Safe/.test(document.querySelector('#pos')?.textContent || '') && !document.querySelector('#pos .callout'));
  ok(true, 'the prompt goes away once the vault is safe');
  ok(r.errors.length === 0 && r.blocked.length === 0, `deposit, borrow and top-up logged nothing and were blocked by nothing (${[...r.errors, ...r.blocked].join(' | ')})`);
  setPrice(P0);                                                                                          // the price recovers
  await u.reload(); await untilText(u, '#bal', /Balance/);

  // ── borrowing that leaves the vault exposed says so, and what to add ──
  await tab(u, 'borrow');
  const Lb = await chipMax(u);
  ok(!reverts(() => asCall('user', USD, 'borrow(uint256,uint256)', String(Lb), '100')) && reverts(() => asCall('user', USD, 'borrow(uint256,uint256)', String(Lb + 1n), '100')), 'after the top-up the limit is again exactly what the vault accepts');
  await typed(u, '7500');                                                                                // 3,030 + 7,575 owed against 40,400: 380%
  const hint = await text(u, '#hint');
  ok(/That leaves the vault at \d{3}%, open to redemption\. Add [\d,.]+ TAC to stay at 400% or more\./.test(hint), `a borrow that would leave the vault under 400% says what to add (${hint})`);
  await u.fill('#amt', '');

  // ── repay: short of the fee, then all ──
  await tab(u, 'repay');
  const dueNow = vaultOf(USD, 'user').d;                                                                // 3,030
  ok(/You hold 3,000 of the 3,030 TACD you owe\./.test(await text(u, '#hint')), 'the fee came out of what was lent, so the page says "You hold 3,000 of the 3,030 you owe" and nothing more');
  await typed(u, '3030');
  ok(/Not enough TACD/.test(await text(u, '#go')) && await u.$eval('#go', (b) => b.disabled), 'repaying all of it needs the fee: the button says so');
  await typed(u, '1000');
  W.signs = 0; W.sends.length = 0;
  await u.click('#go');
  await untilText(u, '#status', /Repaid\. You owe 2,030 TACD/, 60000);
  ok(W.signs === 1 && W.sends.length === 1 && vaultOf(USD, 'user').d === 2030n * E18, `a part-repayment uses the synth's permit and one transaction (${W.signs} signed, ${W.sends.length} sent)`);
  await typed(u, '1950');
  ok(/Debt left must be zero or at least 100 TACD\. Repay up to 1,930, or all 2,030\./.test(await text(u, '#hint')), 'a repayment that would leave less than the minimum is refused with the way out');
  // the fee, from the fee address
  await rpcA('anvil_impersonateAccount', [FEE_TO]); await rpcA('anvil_setBalance', [FEE_TO, '0x56bc75e2d63100000']);
  await rpcA('eth_sendTransaction', [{ from: FEE_TO, to: SYN.usd, data: '0xa9059cbb' + ACC.user.a.slice(2).toLowerCase().padStart(64, '0') + (30n * E18).toString(16).padStart(64, '0') }]);
  await u.reload(); await untilText(u, '#bal', /You hold 2,030/, 30000);
  await tab(u, 'repay'); await chipMax(u);
  ok(/Repay all TACD/.test(await text(u, '#go')) && /Owed after\s*0 TACD/.test(await text(u, '#info')), 'with the fee in hand Max repays all');
  W.signs = 0; W.sends.length = 0;
  await u.click('#go');
  await untilText(u, '#status', /Repaid\. Nothing owed now\./, 60000);
  ok(vaultOf(USD, 'user').d === 0n && big(USD, 'totalDebt()(uint256)') === 0n, 'repaying all clears the debt (the vault takes what is owed, whatever the amount asked)');

  // ── withdraw ──
  await tab(u, 'withdraw');
  const coll = vaultOf(USD, 'user').c;
  const Wm = await chipMax(u);
  ok(Wm === coll, 'with no debt Max is all the TAC in the vault');
  await u.click('#go');
  await untilText(u, '#status', /Withdrawn/, 60000);
  ok(vaultOf(USD, 'user').c === 0n && big(TAC, 'balanceOf(address)(uint256)', ACC.user.a) === 1_000_000n * E18, 'withdrawing all returns the TAC to the account and empties the vault');
  // a vault with debt: the withdraw limit
  await tab(u, 'deposit'); await typed(u, '100000'); await u.click('#go'); await untilText(u, '#status', /Deposited/, 60000);
  await tab(u, 'borrow'); await typed(u, '3000'); await u.click('#go'); await untilText(u, '#status', /Borrowed 3,000/, 60000);
  await tab(u, 'withdraw');
  const Wd = await chipMax(u);
  ok(Wd > 0n && !reverts(() => asCall('user', USD, 'withdraw(uint256)', String(Wd))) && reverts(() => asCall('user', USD, 'withdraw(uint256)', String(Wd + 1n))), `with a debt the withdraw limit (${Wd} wei) is accepted by the vault and one wei more is refused`);
  await typed(u, String(Number(cast('from-wei', String(Wd))) + 1000));
  ok(/You can withdraw up to [\d,.]+ TAC and stay at 350%\./.test(await text(u, '#hint')) && await u.$eval('#go', (b) => b.disabled), 'asking for more says how much is allowed');
  await u.fill('#amt', '');

  // ── paused with a position open: repaying and depositing go on, borrowing and withdrawing wait ──
  send('deployer', ORACLE, 'setBroken(bool)', 'true');
  await u.reload(); await until(u, () => /Borrowing is not open yet/.test(document.querySelector('#board')?.textContent || ''));
  await tab(u, 'borrow');
  ok(/Lending is paused/.test(await text(u, '#go')) && await u.$eval('#go', (b) => b.disabled), 'paused: the borrow button says lending is paused');
  await tab(u, 'withdraw');
  ok(/Withdrawing is paused/.test(await text(u, '#go')) && /With a debt, withdrawing waits until prices are recorded/.test(await text(u, '#hint')), 'and withdrawing with a debt waits too');
  await tab(u, 'deposit'); await typed(u, '10');
  ok(/Deposit TAC/.test(await text(u, '#go')) && !(await u.$eval('#go', (b) => b.disabled)), 'but a deposit goes on');
  await u.fill('#amt', '');
  ok(/The ratio shows once prices are recorded/.test(await text(u, '#pos')), 'and the position says its ratio waits for prices');
  send('deployer', ORACLE, 'setBroken(bool)', 'false');
  await closeAll(r);

  // ── an auction ──
  setPrice(P0 / 10n);                                                                                    // $0.025: $2,500 against 3,030 owed: under 200%
  send('bob', USD, 'liquidate(address)', ACC.user.a);
  await rpcA('evm_increaseTime', [300]); await rpcA('evm_mine', []);
  r = await openPage({ who: 'user' });
  const a = r.page;
  await until(a, () => !document.querySelector('#app').hidden && /Nothing|Collateral/.test(document.querySelector('#pos')?.textContent || '') || true, null, 15000);
  await connect(a); await until(a, () => /An auction is running/.test(document.querySelector('#pos')?.textContent || ''));
  const ac = await text(a, '#pos .callout.red');
  ok(/Only the owner can bid for \d{1,2}:\d\d, then anyone\./.test(ac) && /The offer is \$0\.0\d+ per TAC/.test(ac) && /a bid for all the debt takes [\d,.]+ TAC/.test(ac) && /Repay, or add TAC, to end it/.test(ac), `an auction shows the owner-only time left, the offer and the way out (${ac})`);
  ok(/Under 200%/.test(await text(a, '#pos')) && (await a.$eval('#pos', (e) => [...e.querySelectorAll('.hb-key span.on')].map((x) => x.textContent).join())) === 'Liquidation', 'the bar is in the liquidation zone');
  await shot(a, 'auction-desktop');
  await tab(a, 'borrow');
  ok(/In an auction/.test(await text(a, '#go')) && await a.$eval('#go', (b) => b.disabled) && /Borrowing waits until the auction ends/.test(await text(a, '#hint')), 'borrowing waits for the auction to end');
  await tab(a, 'withdraw');
  ok(/In an auction/.test(await text(a, '#go')), 'so does withdrawing');
  const cd1 = await text(a, '[data-cd]'); await sleep(2200); const cd2 = await text(a, '[data-cd]');
  ok(cd1 !== cd2, `the countdown runs (${cd1} then ${cd2})`);
  // add TAC to end it: the prompt's amount recovers the vault, which ends the auction
  setPrice(P0 / 4n);                                                                                     // $0.0625: $6,250 against 3,030: recovered at 200% (the test oracle's recovery view is its price)
  await a.reload();
  await until(a, () => /The vault has recovered/.test(document.querySelector('#pos')?.textContent || ''), null, 30000);
  ok(/End the auction/.test(await text(a, '#pos')), 'a vault that has recovered offers to end the auction');
  r.walletLog.sends.length = 0; await a.click('[data-cancel]'); await untilText(a, '#status', /The auction has ended/, 60000);
  ok(r.walletLog.sends.length === 1 && vaultOf(USD, 'user').a === 0n, 'ending it is one transaction, and the vault is out of the auction');
  await closeAll(r);

  // ── a pause: the owner stops liquidations, outside bids and redemptions for a while ──
  send('owner', USD, 'pauseAuctions(uint256)', '7200');
  r = await openPage({});
  await until(r.page, () => /Auctions paused/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  const pz = await text(r.page, '#board');
  ok(/Auctions paused on TAC Dollar for \d{1,3}:\d\d:/.test(pz) && /no liquidations, outside bids or redemptions/.test(pz) && /Everything else works/.test(pz), `a pause is said, with its countdown and what still works (${pz.slice(0, 160).replace(/\s+/g, ' ')})`);
  await closeAll(r);
  send('owner', USD, 'resumeAuctions()');
  r = await openPage({});
  await until(r.page, () => /Room to borrow/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  await sleep(1500);
  ok(!/Auctions paused/.test(await text(r.page, '#board')), 'when the owner lifts the pause the notice is gone');
  await closeAll(r);

  // ── the owner changes a term, slowly: the page follows it ──
  r = await openPage({ hash: hashFor(`&a=${ACC.user.a}`) });
  await until(r.page, () => /Collateral/.test(document.querySelector('#pos')?.textContent || ''));
  const bar0 = await text(r.page, '#pos');
  await r.page.click('#board [data-more]');
  const held = await text(r.page, '#board');
  ok(/TAC deposited\s*[1-9][\d,.]* TAC\s*0 TAC/.test(held) && /Collateral ratio\s*\d+%/.test(held) && /Borrowed so far\s*[1-9][\d,.]* TACD/.test(held), `once an account has borrowed, the board shows the TAC deposited, the debt and the ratio the TAC backs it at (${held.replace(/\s+/g, ' ').slice(200, 420)})`);
  ok(/200%/.test(bar0) && /400%/.test(bar0) && !/300%/.test(bar0.replace(/350%/g, '')), 'the bar is drawn with the 200% line and the 400% line');
  send('owner', USD, 'queueParam(uint8,uint256)', '2', '15000');                                          // the liquidation ratio to 150%
  await r.page.reload();
  await until(r.page, () => /Changes announced by the owner/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  const an = await text(r.page, '#board');
  // Liquidating later is easier for a borrower, so the notice says nothing is needed of them; it carries the wait and the date it lands.
  ok(/Liquidation ratio → 150% · from \d+ \w+ \d+:\d+ UTC \(in (2 days|1 day \d+ h)\)/.test(an) && /They make borrowing easier; nothing to do/.test(an) && !/repay or withdraw/.test(an), `an announced change is shown with its term, value, wait and date (${an.replace(/\s+/g, ' ').slice(-170)})`);
  // One that tightens is the one to act ahead of: a higher borrowing line means less can be borrowed against the same TAC.
  send('owner', USD, 'queueParam(uint8,uint256)', '1', '40000');                                          // the borrowing line to 400%
  await r.page.reload();
  await until(r.page, () => /Borrowing line → 400%/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  const tight = await text(r.page, '#board');
  ok(/They tighten borrowing: repay or withdraw before then/.test(tight) && /Liquidation ratio → 150%/.test(tight), `a tightening change warns, alongside the easier one (${tight.replace(/\s+/g, ' ').slice(-170)})`);
  send('owner', USD, 'cancelParam(uint8)', '1');
  await r.page.reload();
  await until(r.page, () => !/Borrowing line → 400%/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  ok(/They make borrowing easier/.test(await text(r.page, '#board')), 'and the warning goes with it when it is cancelled');
  // the owner's tool (tools/tac-vault-admin.mjs, or VAULT_ADMIN) reads the same announcement from the chain, and builds the calldata that makes it
  const ADMIN = process.env.VAULT_ADMIN || join(REPO, 'tools/tac-vault-admin.mjs');
  if (existsSync(ADMIN)) {
    const adm = execFileSync('node', [ADMIN, 'status', USD, SYN.usd], { env: { ...process.env, RPC: ANVIL }, encoding: 'utf8' });
    ok(/\bliq\s+-> 15000\s+executable from/.test(adm) && /liquidation ratio \(bps\)\s+20000/.test(adm) && /announced minter 0x0+\b/.test(adm), `the admin tool shows the terms now and the announced change (${adm.replace(/\s+/g, ' ').slice(0, 700)})`);
    ok(execFileSync('node', [ADMIN, 'call', 'queue', 'liq', '15000'], { encoding: 'utf8' }).trim() === cast('calldata', 'queueParam(uint8,uint256)', '2', '15000'), 'and its calldata is the vault\'s own queueParam');
  }
  // a further synth minter the owner names is shown the same way, and goes when it is cancelled
  send('owner', SYN.usd, 'queueMinter(address)', TAC);
  await r.page.reload();
  await until(r.page, () => /Another contract may mint/.test(document.querySelector('#board')?.textContent || ''), null, 30000);
  ok(/Another contract may mint TACD · from \d+ \w+ \d+:\d+ UTC \(in (3 days|2 days \d+ h)\)/.test(await text(r.page, '#board')), 'an announced synth minter is shown with its wait');
  send('owner', SYN.usd, 'cancelMinter()');
  await rpcA('evm_increaseTime', [2 * 86400 + 60]); await rpcA('evm_mine', []);
  send('owner', USD, 'executeParam(uint8)', '2');
  await r.page.reload();
  await until(r.page, () => /Collateral/.test(document.querySelector('#pos')?.textContent || ''), null, 30000);
  const bar1 = await text(r.page, '#pos');
  ok(!/Changes announced by the owner/.test(await text(r.page, '#board')), 'once the change is made the notice is gone');
  ok(/150%/.test(bar1) && /300%/.test(bar1) && !/400%/.test(bar1), `the lines follow the new liquidation ratio: 150% and 300% (${bar1.replace(/\s+/g, ' ').slice(0, 120)})`);
  await closeAll(r);

  // ── a read-only look at another account ──
  setPrice(P0);
  r = await openPage({ hash: hashFor(`&a=${ACC.user.a}`) });
  await until(r.page, () => /Collateral/.test(document.querySelector('#pos')?.textContent || ''));
  const ro = await text(r.page, '#pos');
  ok(/Collateral\s*100,000 TAC/.test(ro) && /Debt\s*3,030 TACD/.test(ro) && /Use my wallet/.test(ro) && /Connect wallet/.test(await text(r.page, '#go')), `an address in the bar shows that account's vault with no wallet (${ro.slice(0, 120)})`);
  await closeAll(r);
  r = await openPage({ who: 'bob', hash: hashFor(`&a=${ACC.user.a}`) });
  await connect(r.page); await until(r.page, () => /Viewing another account/.test(document.querySelector('#go')?.textContent || ''));
  ok(await r.page.$eval('#go', (b) => b.disabled) && r.walletLog.sends.length === 0, 'viewing another account with a wallet connected cannot send anything');
  await closeAll(r);

  // ── a wallet that cannot sign typed data: the exact approval, then the deposit ──
  r = await openPage({ who: 'bob', noTyped: true });
  const b = r.page;
  await connect(b); await until(b, () => /Balance 1,000,000/.test(document.querySelector('#bal')?.textContent || ''), null, 30000);
  await typed(b, '5000'); r.walletLog.sends.length = 0;
  await b.click('#go');
  await untilText(b, '#status', /Deposited 5,000 TAC/, 60000);
  const [s1, s2] = r.walletLog.sends;
  ok(r.walletLog.sends.length === 2 && s1.to.toLowerCase() === TAC.toLowerCase() && s1.data.startsWith('0x095ea7b3') && BigInt('0x' + s1.data.slice(-64)) === 5000n * E18 && s2.to.toLowerCase() === USD.toLowerCase(), 'without typed-data signing it approves exactly the amount, then deposits');
  ok(vaultOf(USD, 'bob').c === 5000n * E18 && big(TAC, 'allowance(address,address)(uint256)', ACC.bob.a, USD) === 0n, 'and the allowance is spent to nothing');
  await closeAll(r);

  // ── the ETH vault: borrowing TACE ──
  r = await openPage({ who: 'carol', hash: hashFor('&v=eth') });
  const c = r.page;
  await connect(c); await until(c, () => /Balance 1,000,000/.test(document.querySelector('#bal')?.textContent || ''), null, 30000);
  ok(/TAC Ether vault/.test(await text(c, '#tk-h')), 'the address bar can choose the ETH vault');
  await typed(c, '100000'); await c.click('#go'); await untilText(c, '#status', /Deposited 100,000 TAC/, 60000);
  await tab(c, 'borrow'); await typed(c, '3');                                                           // 100,000 TAC = 10 ETH; 3 TACE + 1% = 3.03 owed: 330%... that is under 350%: needs less
  ok(/up to \d\.\d+ TACE now/.test(await text(c, '#hint')) || /You receive/.test(await text(c, '#info')), 'the ETH vault answers in TACE');
  const Le = await chipMax(c);
  ok(!reverts(() => asCall('carol', ETH, 'borrow(uint256,uint256)', String(Le), '100')) && reverts(() => asCall('carol', ETH, 'borrow(uint256,uint256)', String(Le + 1n), '100')), `its limit (${Le} wei of TACE) is exactly what the ETH vault accepts`);
  await typed(c, '2'); await c.click('#go'); await untilText(c, '#status', /Borrowed 2 TACE\. You owe 2\.02/, 60000);
  ok(vaultOf(ETH, 'carol').d === 202n * E18 / 100n, 'borrowing 2 TACE owes 2.02');
  await closeAll(r);

  // ── screenshots, phone and dark, one per zone ──
  if (SHOTS) {
    for (const [name, price] of [['safe', P0 * 55n / 100n], ['redemption', P0 * 36n / 100n], ['liquidation', P0 * 21n / 100n]]) {
      setPrice(price); mintTac(ACC.user.a, 0n);
      for (const [vp, scheme] of [[{ width: 390, height: 844 }, 'light'], [{ width: 390, height: 844 }, 'dark'], [{ width: 1280, height: 900 }, 'dark']]) {
        const x = await openPage({ viewport: vp, who: 'user', scheme });
        await connect(x.page); await until(x.page, () => /Collateral/.test(document.querySelector('#pos')?.textContent || ''), null, 30000);
        await sleep(300); await shot(x.page, `${name}-${vp.width}-${scheme}`);
        await x.page.locator('#pos').screenshot({ path: join(SHOTS, `${name}-${vp.width}-${scheme}-pos.png`) });
        await closeAll(x);
      }
    }
  }
} catch (e) { fails++; console.log('FAIL   ' + String(e.message || e).split('\n').slice(0, 4).join('\n') + '\n' + String(e.stack || '').split('\n').filter((l) => /vault-page/.test(l)).slice(0, 2).join('\n')); }
if (process.env.HOLD) { console.log(JSON.stringify({ ANVIL, WEB, TAC, ORACLE, USD, ETH, FEED, FIXED })); await sleep(Number(process.env.HOLD) * 1000); }
console.log(fails ? `${fails} failed, ${n} passed` : `${n} checks passed`);
finish(fails ? 1 : 0);
