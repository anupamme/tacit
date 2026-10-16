// The catch-up registry's admin page (contracts/script/deploy-checkpoints.mjs) end to end on anvil forks of Ethereum and
// Base: the anon.wei steward (impersonated on the forks) connects through a scripted EIP-6963 wallet, deploys the registry
// through the real CreateX with the committed salt at its fixed address on each chain, prepares a point from the relay's
// index (served here cut off below each fork's head, so the index and the fork agree), posts it, and finds the same point
// refused as posted already; another wallet is told it is not the deployer. Nothing is sent to a real chain.
// Usage: node tests/checkpoints-admin.test.mjs     (anvil on PATH, playwright-core installed; FORK_1 / FORK_8453 to fork
// from other nodes; the registry's build under the checkpoints profile)
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';

net.setDefaultAutoSelectFamily?.(false);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright-core');

let failures = 0, passed = 0;
const ok = (c, m, x = '') => { console.log(`${c ? 'ok' : 'not ok'} - ${m}${x ? '  ' + x : ''}`); c ? passed++ : failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
process.on('exit', () => kids.forEach((k) => k.kill('SIGKILL')));
const ACCT = '0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855A20';              // the steward, the deployer the committed salt is bound to
const OTHER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ADDR = '0x00000000182cc07949efad43bac79a25e6a9413b';
const CHAINS = [
  { id: 1, fork: process.env.FORK_1 || 'https://ethereum-rpc.publicnode.com', relay: 'https://tacit-evm-pool-keeper.onrender.com/evm-pool/keeper' },
  { id: 8453, fork: process.env.FORK_8453 || 'https://base.gateway.tenderly.co', relay: 'https://tacit-evm-pool-keeper-base.onrender.com/evm-pool/keeper' },
];
const port = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const rpcAt = async (url, method, params = []) => { const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };

// Forks, and a relay per chain that serves the real index cut off five blocks below the fork's head.
for (const c of CHAINS) {
  c.port = await port(); c.url = `http://127.0.0.1:${c.port}`;
  kids.push(spawn('anvil', ['--port', String(c.port), '--fork-url', c.fork, '--silent'], { stdio: 'ignore' }));
  for (let i = 0; ; i++) { try { if (await rpcAt(c.url, 'eth_chainId')) break; } catch {} if (i > 240) throw new Error('anvil did not start'); await sleep(500); }
  c.head = Number(BigInt(await rpcAt(c.url, 'eth_blockNumber')));
  await rpcAt(c.url, 'anvil_impersonateAccount', [ACCT]);
  await rpcAt(c.url, 'anvil_setBalance', [ACCT, '0x' + (10n ** 19n).toString(16)]);
  const cut = c.head - 5;
  const srv = http.createServer(async (q, r) => {
    const from = Number(new URL(q.url, 'http://x').searchParams.get('from'));
    const real = await (await fetch(`${c.relay}/events?from=${from}`)).json();
    const events = real.events.filter((e) => e.block <= cut);
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ ...real, events, through: Math.min(Number(real.through), cut) < from ? from - 1 : Math.min(Number(real.through), cut) }));
  }).listen(0);
  c.stub = `http://127.0.0.1:${srv.address().port}`;
  console.log(`# chain ${c.id}: fork at block ${c.head} on :${c.port}`);
}

// The admin server, reading the forks and the stub relays.
const adminPort = await port();
const env = { ...process.env, CHAINS: CHAINS.map((c) => c.id).join(',') };
for (const c of CHAINS) { env['RPC_' + c.id] = c.url; env['RELAY_' + c.id] = c.stub; }
const admin = spawn('node', [new URL('../contracts/script/deploy-checkpoints.mjs', import.meta.url).pathname, String(adminPort)], { env, stdio: ['ignore', 'pipe', 'inherit'] });
kids.push(admin);
await new Promise((resolve, reject) => { admin.stdout.on('data', (d) => /admin: http/.test(String(d)) && resolve()); admin.on('exit', (code) => reject(new Error(`admin server exited ${code}`))); });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => ok(false, 'no page errors', e.message));
// A wallet that signs with anvil's first account on whichever fork it is switched to.
await page.addInitScript(({ forks, acct }) => {
  let chain = 1;
  const handlers = {};
  const provider = {
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
      if (method === 'eth_chainId') return '0x' + chain.toString(16);
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
        const id = Number(params[0].chainId);
        if (!forks[id]) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
        chain = id; (handlers.chainChanged || []).forEach((f) => f('0x' + id.toString(16))); return null;
      }
      if (method === 'eth_sendTransaction') { const { chainId, ...tx } = params[0]; params = [tx]; }
      const j = await (await fetch(forks[chain], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
      return j.result;
    },
    on(ev, f) { (handlers[ev] ||= []).push(f); },
  };
  const info = { uuid: 'test-wallet', name: 'Test wallet', icon: '', rdns: 'test.wallet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}, { forks: Object.fromEntries(CHAINS.map((c) => [c.id, c.url])), acct: ACCT });

// Another wallet is not the deployer: the server says so, and nothing could land at the address from it.
for (const c of CHAINS) {
  const s = await (await fetch(`http://127.0.0.1:${adminPort}/api/state?chain=${c.id}&from=${OTHER}`)).json();
  ok(s.dryRun === 'wrong-wallet' && s.deployed === false, `chain ${c.id}: a wallet that is not the deployer is told so`, s.dryRun);
  const none = await (await fetch(`http://127.0.0.1:${adminPort}/api/state?chain=${c.id}`)).json();
  ok(none.dryRun === 'connect', `chain ${c.id}: with no wallet the page asks for the deployer`);
}
await page.goto(`http://127.0.0.1:${adminPort}/`);
const status = (id) => page.locator(`#r${id} .st`).innerText();
const waitStatus = async (id, re, ms = 300_000) => { await page.waitForFunction(([id, src]) => new RegExp(src).test(document.querySelector(`#r${id} .st`)?.textContent || ''), [id, re.source], { timeout: ms }); return status(id); };

ok(await page.locator('#banner').innerText() === '', 'no banner: the deployer is the one whose address the page and keepers name');
// A wallet that already has this site connected is picked up without a prompt; otherwise the button connects it.
await sleep(600);
if (await page.locator('#conn').isEnabled()) await page.click('#conn');
await page.waitForFunction((a) => document.querySelector('#who')?.textContent.includes(a), ACCT);
ok(true, 'the wallet connects through EIP-6963');
await page.waitForFunction((ids) => ids.every((id) => /dry run lands/.test(document.querySelector(`#r${id}`)?.textContent || '')), CHAINS.map((c) => c.id), { timeout: 120_000 })
  .catch(async (e) => { for (const c of CHAINS) console.log(`# row ${c.id}: ${(await page.locator(`#r${c.id}`).innerText()).replace(/\s+/g, ' ')}`); throw e; });
ok(true, 'every chain reads as not deployed, with a dry run from the deployer that lands at the address');

for (const c of CHAINS) {
  await page.click(`[data-deploy="${c.id}"]`);
  const s = await waitStatus(c.id, /Deployed|revert|refuse|not land|bad|Could not|Error/i);
  const code = await rpcAt(c.url, 'eth_getCode', [ADDR, 'latest']);
  ok(/Deployed/.test(s) && code.length > 2 + 2 * 18000, `chain ${c.id}: deployed at the registry address`, `${s} · ${(code.length - 2) / 2} bytes`);
  await page.waitForFunction((id) => /the code of this build/.test(document.querySelector(`#r${id}`)?.textContent || ''), c.id, { timeout: 30_000 });
  ok(true, `chain ${c.id}: the code on chain is this build's, immutables included`);
  const pool = await rpcAt(c.url, 'eth_call', [{ to: ADDR, data: '0x7535d246' }, 'latest']);
  ok(pool.toLowerCase().endsWith('000000c2a20657ce25f2ba99737933d031afbee9'), `chain ${c.id}: wired to the pool`);
  ok(await page.locator(`[data-deploy="${c.id}"]`).isDisabled(), `chain ${c.id}: deploy is off once deployed`);

  await page.click(`[data-post="${c.id}"]`);
  const prep = await waitStatus(c.id, /Press again|No point|refuse|posted already|Could not/i);
  ok(/Press again to post it/.test(prep), `chain ${c.id}: a point is worked out and dry-runs`, prep.slice(0, 160));
  await page.click(`[data-post="${c.id}"]`);
  const posted = await waitStatus(c.id, /Posted|revert|refuse|Could not|Error/i);
  const latestRaw = await rpcAt(c.url, 'eth_call', [{ to: ADDR, data: '0x' + Buffer.from(require('@noble/hashes/sha3').keccak_256('latest()')).toString('hex').slice(0, 8) }, 'latest']);
  const leaves = Number(BigInt(await rpcAt(c.url, 'eth_call', [{ to: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', data: '0xfc7e9c6f' }, 'latest'])));
  ok(/Posted/.test(posted) && Number(BigInt(latestRaw)) > 0 && Number(BigInt(latestRaw)) <= leaves, `chain ${c.id}: the point is posted, at or below the pool's count`, `${posted} · latest ${Number(BigInt(latestRaw))} of ${leaves}`);
  await page.click(`[data-post="${c.id}"]`);
  const again = await waitStatus(c.id, /posted already|Press again|refuse|No point/i);
  ok(/posted already/.test(again), `chain ${c.id}: the same point again is refused as posted already`, again);
}

await browser.close();
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
