// A transfer to this wallet's own key (a split of a note, or a note prepared for the bridge), and a second
// transfer built before the indexer lists the first.
//
//   - A send to the wallet's own key is recorded in Activity as "sent to yourself" with a matching "received from
//     yourself" row; a send to anyone else keeps its single "sent" row.
//   - The notes a broadcast transfer spent are not picked again, by a greedy pick or by a forced one, while holdings
//     read from a lagging indexer still list them: the second transfer stops before it builds anything.
//
// Chain and worker are mocks. Run: `node tests/xfer-self-send.test.mjs` (Node 22: add --no-experimental-global-navigator)

import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
async function test(label, fn) {
  try {
    const ok = await fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const SK = hexToBytes('0c'.repeat(32));
dapp.wallet.priv = SK;
dapp.wallet.pub = secp.getPublicKey(SK, true);
dapp.wallet.mode = 'passkey';
const ADDR = dapp.wallet.address();
const PUB_HEX = bytesToHex(dapp.wallet.pub);
const OTHER_PUB_HEX = bytesToHex(secp.getPublicKey(hexToBytes('0d'.repeat(32)), true));

const ASSET_ID = bytesToHex(sha256(new TextEncoder().encode('test-asset')));
const BIG = { utxo: { txid: 'aa'.repeat(32), vout: 1, value: 546 }, amount: 10_000n, blinding: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn };
const SMALL = { utxo: { txid: 'cc'.repeat(32), vout: 0, value: 546 }, amount: 5_000n, blinding: 0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn };
const FAN = { utxo: { txid: 'dd'.repeat(32), vout: 2, value: 546 }, amount: 4_000n, blinding: 0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn };

// The indexer never catches up in this test: every read lists both notes, as one still behind the broadcasts would.
dapp._testSetScanHoldingsOverride(() => new Map([[ASSET_ID, {
  decimals: 0, ticker: 'TST', balance: BIG.amount + SMALL.amount + FAN.amount, utxos: [BIG, SMALL, FAN],
}]]));

const broadcasts = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });
  if (method === 'POST' && typeof opts.body === 'string' && opts.body.includes('"jsonrpc"')) {
    const rpc = JSON.parse(opts.body);
    if (rpc.method === 'eth_getStorageAt') return json({ jsonrpc: '2.0', id: rpc.id, result: '0x' + '00'.repeat(32) });
    return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'mock: ' + rpc.method } });
  }
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: 10, halfHourFee: 5, hourFee: 2, economyFee: 1, minimumFee: 1 });
  if (u.includes('/scripthash/')) return json([]);
  if (u.includes(`/address/${ADDR}/utxo`)) { dapp._testClearRecentSpends(); return json([{ txid: 'ee'.repeat(32), vout: 0, value: 5_000_000, status: { confirmed: true } }]); }  // this chain never remembers a spend
  if (method === 'POST' && u.endsWith('/tx')) {
    if (!broadcasts.some((b) => b.hex === opts.body)) broadcasts.push({ hex: opts.body });
    return text('0'.repeat(64));
  }
  if (/\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(u)) return json({ spent: false });
  if (u.includes('/blocks/tip/height')) return text('0');
  if (u.includes('/assets/hint')) return json({ ok: true });
  return json({ error: 'mock fetch: no handler for ' + u }, 404);
};

const activity = () => JSON.parse(localStorage.getItem('tacit-activity-v1:signet') || '[]');

console.log('\n§ Transfer to the wallet\'s own key, then a second transfer before the indexer lists the first:');

const first = await dapp.buildAndBroadcastCXfer({ assetIdHex: ASSET_ID, recipientPubHex: PUB_HEX, amount: 3_000n });
await test('self-send broadcast a commit and a reveal', () => broadcasts.length === 2);
await test('self-send kept 7,000 as change (spent the larger note)', () => first.changeAmount === 7_000n);
await test('Activity: a "sent to yourself" row and a matching "received from yourself" row', () => {
  const rows = activity().filter((e) => e.txid === first.revealTxid);
  const out = rows.find((e) => e.kind === 'transfer-out'), inn = rows.find((e) => e.kind === 'transfer-in');
  return rows.length === 2 && out?.extra?.self === true && inn?.extra?.self === true && out.amount === '3000' && inn.amount === '3000';
});

const second = await dapp.buildAndBroadcastCXfer({ assetIdHex: ASSET_ID, recipientPubHex: OTHER_PUB_HEX, amount: 2_000n });
await test('a send to another key spends the note the first did not', () => broadcasts.length === 4 && second.changeAmount === 3_000n);
await test('Activity: a send to another key is one plain "sent" row', () => {
  const rows = activity().filter((e) => e.txid === second.revealTxid);
  return rows.length === 1 && rows[0].kind === 'transfer-out' && !rows[0].extra;
});

// One transaction that makes three notes for this wallet (a listing in chunks): three "sent" rows, one "received" row.
const fan = await dapp.buildAndBroadcastCXferMulti({
  assetIdHex: ASSET_ID,
  recipients: [1, 2, 3].map(() => ({ pubHex: PUB_HEX, amount: 1_000n })),
  allowDuplicateRecipients: true,
  forceUtxos: [FAN],
});
await test('a three-note self-send makes three "sent to yourself" rows and a single "received" row for all of it', () => {
  const rows = activity().filter((e) => e.txid === fan.revealTxid);
  const outs = rows.filter((e) => e.kind === 'transfer-out'), ins = rows.filter((e) => e.kind === 'transfer-in');
  return outs.length === 3 && outs.every((e) => e.extra?.self === true) && ins.length === 1 && ins[0].amount === '3000' && ins[0].extra?.self === true;
});

const before = broadcasts.length;
let greedyErr = null;
try { await dapp.buildAndBroadcastCXfer({ assetIdHex: ASSET_ID, recipientPubHex: OTHER_PUB_HEX, amount: 1_000n }); } catch (e) { greedyErr = e; }
await test('a pick that only the spent notes could cover stops as still settling', () => /still settling/.test(greedyErr?.message || ''));
await test('...before any transaction is built or broadcast', () => broadcasts.length === before);

let forcedErr = null;
try { await dapp.buildAndBroadcastCXfer({ assetIdHex: ASSET_ID, recipientPubHex: PUB_HEX, amount: 1_000n, forceUtxos: [BIG] }); } catch (e) { forcedErr = e; }
await test('a forced pick of a spent note stops as still settling', () => /still settling/.test(forcedErr?.message || ''));
await test('...without a broadcast', () => broadcasts.length === before);

// A holdings entry that carries no outpoint is left to the pick as before; it does not break the guard's filter.
dapp._testSetScanHoldingsOverride(() => new Map([[ASSET_ID, {
  decimals: 0, ticker: 'TST', balance: 600n, utxos: [{ amount: 100n, blinding: 1n }],
}]]));
let bareErr = null;
try { await dapp.buildAndBroadcastCXfer({ assetIdHex: ASSET_ID, recipientPubHex: OTHER_PUB_HEX, amount: 50n }); } catch (e) { bareErr = e; }
await test('an entry with no outpoint is not mistaken for a spent note', () => !!bareErr && !/still settling/.test(bareErr.message));

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
