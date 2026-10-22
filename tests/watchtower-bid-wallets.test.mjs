// Numbered watchtower bid wallets: a key and the chain find every bid wallet. Pins the derivation (distinct
// per index, apart from the older per-bid key), the public-key -> index lookup, the first-unused-wallet
// picker (including two bids placed together), and the scan: it sweeps wallets holding funds, leaves a
// wallet behind a live registration alone, stops after a run of unused wallets, and refuses to run when
// the registration list cannot be read. The network is a mock; the sweep is injected.
//
// Run: `node tests/watchtower-bid-wallets.test.mjs`

import { JSDOM } from './_jsdom.mjs';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator; globalThis.__TACIT_NO_INIT__ = true;
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');
globalThis.__TACIT_WORKER_BASE__ = 'https://worker.test';

// Chain and worker state the mock serves.
const used = new Set();                  // addresses with history
const funded = new Map();                // address -> utxos
let registered = [];                     // watchtower registrations for the owner
let registrationStatus = 200;
let registrationBody = null;             // overrides the body when set
const utxoReads = [];                    // the wallet key in place at each UTXO read
let utxoDelayMs = 0;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const broadcasts = [];                   // raw transactions posted to the explorer
let spendOnBroadcast = false;            // a broadcast spends every funded output
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://worker.test/watchtower/bids')) {
    return json(registrationBody ?? { bids: registered }, registrationStatus);
  }
  if (u.includes('/scripthash/')) return json([]);
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: 10, halfHourFee: 5, hourFee: 2, economyFee: 1, minimumFee: 1 });
  if (init?.method === 'POST' && u.endsWith('/tx')) {
    if (!broadcasts.includes(init.body)) broadcasts.push(init.body);
    if (spendOnBroadcast) funded.clear();
    return new Response('00'.repeat(32), { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  const m = u.match(/\/address\/([0-9a-z]+)(\/utxo)?(?:\?|$)/);
  if (m) {
    const addr = m[1];
    if (m[2]) {
      utxoReads.push(bytesToHex(dapp.wallet.pub));
      if (utxoDelayMs) await new Promise((r) => setTimeout(r, utxoDelayMs));
      return json(funded.get(addr) || []);
    }
    return json({ chain_stats: { tx_count: used.has(addr) ? 1 : 0 }, mempool_stats: { tx_count: 0 } });
  }
  return json({ error: 'not mocked' }, 404);
};

const dapp = await import('../dapp/tacit.js');
const { returnToOwner } = await import('../fulfiller/watchtower-core.mjs');

let pass = 0, fail = 0;
async function test(label, fn) {
  try { const ok = await fn(); if (ok) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const keyOf = (b) => hexToBytes(String(b).repeat(32));
const MAIN = keyOf('31');
const pubHex = (priv) => bytesToHex(secp.getPublicKey(priv, true));
const addrOf = (priv) => bech32.encode('tb', [0, ...bech32.toWords(ripemd160(sha256(secp.getPublicKey(priv, true))))]);
const walletPriv = (main, i) => dapp.deriveWatchtowerBidWalletKey(main, i);
const reset = () => { used.clear(); funded.clear(); registered = []; registrationStatus = 200; registrationBody = null; };
const setMain = (sk) => { dapp.wallet.priv = sk; dapp.wallet.pub = secp.getPublicKey(sk, true); };
const utxo = (n) => [{ txid: 'ab'.repeat(32), vout: n, value: 50000, status: { confirmed: true, block_height: 1 } }];

await test('wallet keys are deterministic, distinct per index, and apart from the per-bid key', () => {
  const a0 = walletPriv(MAIN, 0), a1 = walletPriv(MAIN, 1);
  const legacy = dapp.deriveWatchtowerBidKey(MAIN, 'ab'.repeat(32), 'cd'.repeat(16));
  return bytesToHex(a0) === bytesToHex(walletPriv(MAIN, 0)) && bytesToHex(a0) !== bytesToHex(a1)
    && bytesToHex(a0) !== bytesToHex(legacy) && bytesToHex(walletPriv(keyOf('32'), 0)) !== bytesToHex(a0);
});

await test('a wallet public key maps back to its index; an unrelated key does not', () => {
  const idx = [0, 3, 57].every((i) => dapp.watchtowerBidWalletIndexOf(MAIN, pubHex(walletPriv(MAIN, i))) === i);
  return idx && dapp.watchtowerBidWalletIndexOf(MAIN, pubHex(keyOf('77'))) === -1;
});

await test('the picker returns the first wallet with no history', async () => {
  reset(); setMain(keyOf('41'));
  const sk = dapp.wallet.priv;
  used.add(addrOf(walletPriv(sk, 0))); used.add(addrOf(walletPriv(sk, 1)));
  return (await dapp.nextWatchtowerBidWalletIndex(sk)) === 2;
});

await test('two bids placed together get different wallets', async () => {
  reset(); setMain(keyOf('42'));
  const sk = dapp.wallet.priv;
  const [a, b] = await Promise.all([dapp.nextWatchtowerBidWalletIndex(sk), dapp.nextWatchtowerBidWalletIndex(sk)]);
  return a !== b && Math.min(a, b) === 0;
});

await test('the scan sweeps funded wallets, skips a live bid, and stops after ten unused in a row', async () => {
  reset(); setMain(keyOf('43'));
  const sk = dapp.wallet.priv;
  const A = (i) => addrOf(walletPriv(sk, i));
  used.add(A(0)); funded.set(A(0), utxo(0));       // live registration: left alone
  used.add(A(1)); funded.set(A(1), utxo(1));       // stranded: swept
  used.add(A(2));                                  // swept before: used, empty
  used.add(A(11)); funded.set(A(11), utxo(11));    // after an 8-wallet gap: still found
  used.add(A(30)); funded.set(A(30), utxo(30));    // after a 18-wallet gap: out of reach
  registered = [{ bid_id: 'cd'.repeat(16), bid_pubkey: pubHex(walletPriv(sk, 0)) }];
  const swept = [];
  const r = await dapp.recoverWatchtowerBidWallets({ sweep: async (priv, assets) => { swept.push([bytesToHex(priv), assets]); return { swept: 49000, assets: [{ asset_id: 'ef'.repeat(32), amount: '5' }] }; } });
  const want = [1, 11].map((i) => bytesToHex(walletPriv(sk, i)));
  return JSON.stringify(swept.map((s) => s[0])) === JSON.stringify(want) && swept.every((s) => s[1] === null)
    && r.swept === 98000 && r.assets.length === 2 && r.wallets.map((w) => w.index).join() === '1,11' && r.failed.length === 0;
});

await test('a wallet that cannot be swept is reported and the scan carries on', async () => {
  reset(); setMain(keyOf('44'));
  const sk = dapp.wallet.priv;
  for (const i of [0, 1]) { used.add(addrOf(walletPriv(sk, i))); funded.set(addrOf(walletPriv(sk, i)), utxo(i)); }
  let n = 0;
  const r = await dapp.recoverWatchtowerBidWallets({ sweep: async () => { if (n++ === 0) throw new Error('broadcast rejected'); return { swept: 1000, assets: [] }; } });
  return r.failed.length === 1 && r.failed[0].index === 0 && /rejected/.test(r.failed[0].error) && r.wallets.length === 1 && r.swept === 1000;
});

await test('the scan refuses to run when the registration list cannot be read (nothing swept)', async () => {
  reset(); setMain(keyOf('45'));
  const sk = dapp.wallet.priv;
  used.add(addrOf(walletPriv(sk, 0))); funded.set(addrOf(walletPriv(sk, 0)), utxo(0));
  let swept = 0, msgs = [];
  for (const mode of ['http500', 'notAList']) {
    registrationStatus = mode === 'http500' ? 500 : 200;
    registrationBody = mode === 'http500' ? { error: 'down' } : { ok: true };
    try { await dapp.recoverWatchtowerBidWallets({ sweep: async () => { swept++; return { swept: 1, assets: [] }; } }); msgs.push('ran'); }
    catch (e) { msgs.push(/cannot be told apart/.test(e.message) ? 'refused' : e.message); }
  }
  return swept === 0 && msgs.join() === 'refused,refused';
});

const nowSec = () => Math.floor(Date.now() / 1000);
const ASSET = 'ef'.repeat(32);
const reg = (priv, extra = {}) => ({ bid_id: 'cd'.repeat(16), asset_id: ASSET, bid_pubkey: pubHex(priv), status: 'active', expiry: nowSec() + 86400, ...extra });
const sweepLog = [];
const sweepOk = (swept = 49000) => async (priv, assets) => {
  sweepLog.push([bytesToHex(priv), assets, !!document.querySelector('[data-wt-returning]')]);
  return { swept, assets: assets ? [{ asset_id: assets[0], amount: '5' }] : [] };
};

await test('a bid is finished once filled, or an hour past its expiry; unknown expiry is not finished', () => {
  const t = nowSec();
  const f = dapp.watchtowerBidFinished;
  return !f({ status: 'active', expiry: t + 600 }) && f({ status: 'filled', expiry: t + 600 })
    && !f({ status: 'active', expiry: t - 600 }) && f({ status: 'active', expiry: t - 7200 })
    && !f({ bid_id: 'x' }) && !f(null);
});

await test('the scan sweeps the wallet of an expired registration and leaves a live one alone', async () => {
  reset(); setMain(keyOf('46'));
  const sk = dapp.wallet.priv;
  const A = (i) => addrOf(walletPriv(sk, i));
  used.add(A(0)); funded.set(A(0), utxo(0)); used.add(A(1)); funded.set(A(1), utxo(1));
  registered = [reg(walletPriv(sk, 0), { expiry: nowSec() - 7200 }), reg(walletPriv(sk, 1), { bid_id: 'ee'.repeat(16) })];
  const swept = [];
  await dapp.recoverWatchtowerBidWallets({ sweep: async (priv) => { swept.push(bytesToHex(priv)); return { swept: 1, assets: [] }; } });
  return swept.join() === bytesToHex(walletPriv(sk, 0));
});

await test('the scan leaves a funding still unconfirmed, and a wallet this tab funded that is not yet registered', async () => {
  reset(); setMain(keyOf('47'));
  const sk = dapp.wallet.priv;
  const A = (i) => addrOf(walletPriv(sk, i));
  const mine = await dapp.nextWatchtowerBidWalletIndex(sk);
  used.add(A(mine)); funded.set(A(mine), utxo(0));
  used.add(A(mine + 1)); funded.set(A(mine + 1), [{ ...utxo(1)[0], status: { confirmed: false } }]);
  used.add(A(mine + 2)); funded.set(A(mine + 2), utxo(2));
  const swept = [];
  await dapp.recoverWatchtowerBidWallets({ sweep: async (priv) => { swept.push(bytesToHex(priv)); return { swept: 1, assets: [] }; } });
  return swept.join() === bytesToHex(walletPriv(sk, mine + 2));
});

await test('two sweeps started together run one after the other and leave the wallet key as it was', async () => {
  reset(); setMain(keyOf('48'));
  const sk = dapp.wallet.priv, pub0 = pubHex(sk);
  dapp._testSetScanHoldingsOverride(() => new Map());
  const [a, b] = [walletPriv(sk, 0), walletPriv(sk, 1)];
  utxoReads.length = 0; utxoDelayMs = 15;
  const results = await Promise.all([dapp.sweepWatchtowerBidWallet(a, [ASSET]), dapp.sweepWatchtowerBidWallet(b, [ASSET])]);
  utxoDelayMs = 0; dapp._testSetScanHoldingsOverride(null);
  const seen = utxoReads.filter((p) => p !== pub0);
  return results.every((r) => r.swept === 0) && seen.join() === [pubHex(a), pubHex(b)].join() && pubHex(dapp.wallet.priv) === pub0;
});

await test('returning funds: nothing happens while the wallet is locked or the registration list cannot be read', async () => {
  reset(); setMain(keyOf('49'));
  const sk = dapp.wallet.priv;
  sweepLog.length = 0;
  registered = [reg(walletPriv(sk, 0), { expiry: nowSec() - 7200 })];
  used.add(addrOf(walletPriv(sk, 0))); funded.set(addrOf(walletPriv(sk, 0)), utxo(0));
  dapp.wallet.priv = null;
  const locked = await dapp.returnWatchtowerBidFunds({ sweep: sweepOk(), quietMs: 0 });
  dapp.wallet.priv = sk;
  registrationStatus = 500; registrationBody = { error: 'down' };
  const unread = await dapp.returnWatchtowerBidFunds({ sweep: sweepOk(), quietMs: 0 });
  return locked === null && unread === null && sweepLog.length === 0;
});

await test('returning funds: a finished bid is swept once, a live one is not, and the notice is up only during the sweep', async () => {
  reset(); setMain(keyOf('50'));
  const sk = dapp.wallet.priv;
  sweepLog.length = 0;
  const A = (i) => addrOf(walletPriv(sk, i));
  used.add(A(0)); funded.set(A(0), utxo(0)); used.add(A(1)); funded.set(A(1), utxo(1));
  registered = [reg(walletPriv(sk, 0), { expiry: nowSec() - 7200 }), reg(walletPriv(sk, 1), { bid_id: 'ee'.repeat(16) })];
  const r1 = await dapp.returnWatchtowerBidFunds({ sweep: sweepOk(), quietMs: 0, every: Infinity });
  const r2 = await dapp.returnWatchtowerBidFunds({ sweep: sweepOk(), quietMs: 0, every: Infinity });
  return r1.swept === 49000 && r1.assets.length === 1 && r1.failed.length === 0
    && sweepLog.length === 1 && sweepLog[0][0] === bytesToHex(walletPriv(sk, 0)) && sweepLog[0][1].join() === ASSET && sweepLog[0][2] === true
    && r2.swept === 0 && !document.querySelector('[data-wt-returning]');
});

await test('returning funds: a sweep that fails is reported and tried again next time', async () => {
  reset(); setMain(keyOf('51'));
  const sk = dapp.wallet.priv;
  sweepLog.length = 0;
  used.add(addrOf(walletPriv(sk, 0))); funded.set(addrOf(walletPriv(sk, 0)), utxo(0));
  registered = [reg(walletPriv(sk, 0), { status: 'filled' })];
  const r1 = await dapp.returnWatchtowerBidFunds({ sweep: async () => { throw new Error('broadcast rejected'); }, quietMs: 0, every: Infinity });
  const r2 = await dapp.returnWatchtowerBidFunds({ sweep: sweepOk(), quietMs: 0, every: Infinity });
  return r1.failed.length === 1 && /rejected/.test(r1.failed[0].error) && r2.swept === 49000 && !document.querySelector('[data-wt-returning]');
});

await test('returning funds, end to end: a finished bid is swept in one transaction to the main wallet and the key is restored', async () => {
  reset(); setMain(keyOf('54'));
  const sk = dapp.wallet.priv, pub0 = pubHex(sk);
  const bid = walletPriv(sk, 0);
  dapp._testSetScanHoldingsOverride(() => new Map());
  used.add(addrOf(bid)); funded.set(addrOf(bid), utxo(0));
  registered = [reg(bid, { expiry: nowSec() - 7200 })];
  broadcasts.length = 0;
  const r = await dapp.returnWatchtowerBidFunds({ quietMs: 0, every: Infinity });
  dapp._testSetScanHoldingsOverride(null);
  const mainScript = '0014' + bytesToHex(ripemd160(sha256(secp.getPublicKey(sk, true))));
  return r.failed.length === 0 && r.swept > 40000 && broadcasts.length === 1 && broadcasts[0].includes(mainScript)
    && pubHex(dapp.wallet.priv) === pub0 && !document.querySelector('[data-wt-returning]');
});

await test('scheduling the return twice runs it once, and only for an unlocked wallet', async () => {
  reset(); setMain(keyOf('55'));
  const sk = dapp.wallet.priv;
  const bid = walletPriv(sk, 0);
  dapp._testSetScanHoldingsOverride(() => new Map());
  used.add(addrOf(bid)); funded.set(addrOf(bid), utxo(0));
  registered = [reg(bid, { status: 'filled' })];
  broadcasts.length = 0;
  dapp.wallet.priv = null; dapp.scheduleBidWalletReturn(5); dapp.wallet.priv = sk;
  await new Promise((r) => setTimeout(r, 100));
  const whileLocked = broadcasts.length;
  dapp.scheduleBidWalletReturn(5); dapp.scheduleBidWalletReturn(5);
  await new Promise((r) => setTimeout(r, 1500));
  dapp._testSetScanHoldingsOverride(null);
  return whileLocked === 0 && broadcasts.length === 1;
});

await test('the service returns a finished bid wallet to the owner key it holds, signed as the bid key, and the wallet stays bound to the bid', async () => {
  reset();
  const owner = keyOf('56'), ownerPub = secp.getPublicKey(owner, true);
  const bid = walletPriv(owner, 0), bidPub = secp.getPublicKey(bid, true);
  dapp.wallet.priv = bid; dapp.wallet.pub = bidPub;   // as the orchestrator binds it for this bid
  dapp._testSetScanHoldingsOverride(() => new Map());
  funded.set(addrOf(bid), utxo(0));
  broadcasts.length = 0; spendOnBroadcast = true;
  const ctx = { dapp, priv: bid, pub: bidPub, address: addrOf(bid), assetId: ASSET, ownerPub };
  const r = await returnToOwner(ctx);
  spendOnBroadcast = false; dapp._testSetScanHoldingsOverride(null);
  const ownerScript = '0014' + bytesToHex(ripemd160(sha256(ownerPub)));
  const bidScript = '0014' + bytesToHex(ripemd160(sha256(bidPub)));
  return r.done === true && r.swept > 40000 && broadcasts.length === 1 && broadcasts[0].includes(ownerScript) && !broadcasts[0].includes(bidScript)
    && pubHex(dapp.wallet.priv) === pubHex(bid);
});

await test('returning funds: a key that never had a bid wallet is not walked', async () => {
  reset(); setMain(keyOf('52'));
  const sk = dapp.wallet.priv;
  sweepLog.length = 0;
  funded.set(addrOf(walletPriv(sk, 3)), utxo(3));     // funds at wallet 3, but wallet 0 was never used
  const r = await dapp.returnWatchtowerBidFunds({ sweep: sweepOk(), quietMs: 0 });
  const stamp = JSON.parse(localStorage.getItem(`tacit-wt-scan-v1:signet:${pubHex(sk)}`));
  return r.swept === 0 && sweepLog.length === 0 && stamp.idle === true;
});

await test('returning funds: a wallet whose registration has gone is found from the key, and the walk runs once in the interval', async () => {
  reset(); setMain(keyOf('53'));
  const sk = dapp.wallet.priv;
  const A = (i) => addrOf(walletPriv(sk, i));
  sweepLog.length = 0;
  for (const i of [0, 1, 2, 3]) used.add(A(i));
  funded.set(A(2), utxo(2));
  const first = await dapp.returnWatchtowerBidFunds({ sweep: sweepOk(), quietMs: 0 });
  const again = await dapp.returnWatchtowerBidFunds({ sweep: sweepOk(), quietMs: 0 });
  return first.swept === 49000 && sweepLog.length === 1 && sweepLog[0][0] === bytesToHex(walletPriv(sk, 2)) && sweepLog[0][1] === null
    && again.swept === 0;
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
