// scanAssetForStealthReceipts over an index of 1,600 transfers (what one 8 x 200 Rescan reads): every transfer is
// checked, the transfers are read a window at a time rather than one request each, a read that failed is counted and
// tried again by the next scan, and the seen-transfer cache holds the whole walk, so the next scan skips all of it.
//
// Setup mirrors tests/stealth-cache-isolation.test.mjs (JSDOM + localStorage shims so dapp/tacit.js loads in node);
// the worker is a fetch stub. Run with Node >= 22 and NODE_OPTIONS=--no-experimental-global-navigator.

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import { hexToBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

const ASSET = 'cc'.repeat(32), ASSET2 = 'dd'.repeat(32);
const N = 1600;
const txids = Array.from({ length: N }, (_, i) => i.toString(16).padStart(64, '0'));
// The worker lists an asset's newest transfers first, then its full walk, which repeats them.
const fresh = Array.from({ length: 300 }, (_, i) => (0x100000 + i).toString(16).padStart(64, '0'));
const INDEX = { [ASSET]: txids, [ASSET2]: [...fresh.slice(-100), ...fresh] };

// The worker serves the asset's transfer index (paged by offset); the dapp reads each transfer from the public
// indexers. A transfer that holds no envelope for anyone is what almost every scanned transfer looks like.
const reads = { total: 0, inflight: 0, maxInflight: 0, failing: false };
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const listed = /^\/assets\/([0-9a-f]{64})\/recent-xfer-txids$/.exec(url.pathname);
  if (listed && INDEX[listed[1]]) {
    const all = INDEX[listed[1]], limit = Number(url.searchParams.get('limit')), at = Number(url.searchParams.get('cursor') || 0);
    const page = all.slice(at, at + limit), end = at + page.length;
    return json({ asset_id: listed[1], txids: page, next_cursor: end >= all.length ? null : String(end), done: end >= all.length });
  }
  const m = /\/tx\/([0-9a-f]{64})$/.exec(url.pathname);
  if (m) {
    reads.total++;
    reads.maxInflight = Math.max(reads.maxInflight, ++reads.inflight);
    await new Promise((r) => setTimeout(r, 3));
    reads.inflight--;
    if (reads.failing) return json({ error: 'unavailable' }, 500);
    const id = m[1];
    // every 25th transfer has one input, like the mint-shaped ones in the live index: read, and not a shielded transfer
    const vin = [{ txid: id, vout: 0, witness: ['00', '00', '00'] }];
    if (parseInt(id, 16) % 25 !== 0) vin.push({ txid: id, vout: 1, witness: [] });
    return json({ txid: id, status: { confirmed: false }, vin, vout: [] });
  }
  return json({ error: 'not found' }, 404);
};

const dapp = await import('../dapp/tacit.js');
const priv = hexToBytes('aa'.repeat(32));
dapp.wallet.priv = priv;
dapp.wallet.pub = secp.getPublicKey(priv, true);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

await test('a Rescan-sized walk checks every transfer in the index', async () => {
  const progress = [];
  const r = await dapp.scanAssetForStealthReceipts(ASSET, { pageLimit: 200, maxPages: 8, onProgress: (p) => progress.push(p) });
  assert(r.complete === true, 'the walk did not reach the end of the index');
  assert(r.pagesScanned === 8, `expected 8 pages, read ${r.pagesScanned}`);
  assert(r.txsScanned === N && r.txsSkipped === 0 && r.txsFailed === 0, `expected ${N} checked, got ${r.txsScanned} (+${r.txsSkipped} skipped, ${r.txsFailed} failed)`);
  assert(progress.length === N, 'progress did not report every transfer');
  assert(progress[progress.length - 1].txsScanned === N, 'the last progress report is not the full count');
  assert(reads.total === N, `${reads.total} reads for ${N} transfers`);
});

await test('transfers are read in a window, within the dapp\'s in-flight cap', () => {
  assert(reads.maxInflight > 1, 'the transfers were read one at a time');
  assert(reads.maxInflight <= 12, `${reads.maxInflight} reads in flight at once`);
});

await test('the seen-transfer cache holds the whole walk, so the next scan skips all of it', async () => {
  const before = reads.total;
  const r = await dapp.scanAssetForStealthReceipts(ASSET, { pageLimit: 200, maxPages: 8 });
  assert(r.complete === true && r.txsScanned === 0 && r.txsSkipped === N, `second scan checked ${r.txsScanned}, skipped ${r.txsSkipped}`);
  assert(reads.total === before, 'the second scan read transfers again');
});

await test('a transaction that was read and is not a shielded transfer counts as checked, not as failed', async () => {
  // the first scan above read 64 such transfers; none was reported failed, and the next scan reads none of them again
  assert(dapp.isStealthTxidSeen(ASSET, txids[0]) && dapp.isStealthTxidSeen(ASSET, txids[25]), 'a one-input transfer was left unmarked');
});

await test('a transfer the index lists twice is counted and read once', async () => {
  globalThis.localStorage.clear();
  const before = reads.total, progress = [];
  const r = await dapp.scanAssetForStealthReceipts(ASSET2, { pageLimit: 100, maxPages: 10, onProgress: (p) => progress.push(p) });
  assert(r.complete === true, 'the walk did not reach the end of the index');
  assert(r.txsScanned === 300 && r.txsSkipped === 0 && r.txsFailed === 0, `expected 300 transfers, got ${r.txsScanned} (+${r.txsSkipped} skipped, ${r.txsFailed} failed)`);
  assert(reads.total - before === 300, `${reads.total - before} reads for 300 transfers`);
  assert(progress.length === 300 && progress[progress.length - 1].txsScanned === 300, 'progress counted a repeat');
  const again = await dapp.scanAssetForStealthReceipts(ASSET2, { pageLimit: 100, maxPages: 10 });
  assert(again.txsScanned === 0 && again.txsSkipped === 300, `a second scan skipped ${again.txsSkipped} and read ${again.txsScanned}, not 300 and none`);
});

await test('a transfer whose read failed is counted, left unmarked, and read again by the next scan', async () => {
  globalThis.localStorage.clear();
  const bobPriv = hexToBytes('bb'.repeat(32));          // a fresh wallet: no seen markers
  dapp.wallet.priv = bobPriv;
  dapp.wallet.pub = secp.getPublicKey(bobPriv, true);
  reads.failing = true;
  const first = await dapp.scanAssetForStealthReceipts(ASSET, { pageLimit: 24, maxPages: 1 });
  assert(first.txsFailed === 24, `expected 24 failed reads, got ${first.txsFailed}`);
  reads.failing = false;
  const second = await dapp.scanAssetForStealthReceipts(ASSET, { pageLimit: 24, maxPages: 1 });
  assert(second.txsScanned === 24 && second.txsSkipped === 0 && second.txsFailed === 0,
    `the failed reads were not tried again (checked ${second.txsScanned}, skipped ${second.txsSkipped}, failed ${second.txsFailed})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
