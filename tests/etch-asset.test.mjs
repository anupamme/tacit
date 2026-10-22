// The functions the etch page calls in tacit.js (etchQuote, etchAsset), against a chain and a worker that are answered here: the quote is the fees at the
// rate with room, an etch refuses what it should before anything is sent, and one that goes out is a commit and then a reveal, with the metadata pinned
// first (the name, the link and the supply's opening, whose commitment is the one on the chain) and the worker told of it.
//   node tests/etch-asset.test.mjs

const store = new Map();
const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el() };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', hash: '', search: '', pathname: '/', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true, language: 'en' }, configurable: true }); } catch {}
globalThis.addEventListener = () => {};
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
store.set('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; } };
const refuses = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e?.message)); } };

// Each part of the test is its own key: an output a transaction has spent is not offered again for a while, as it is not on a real chain.
let ADDR = null;
function useKey(n) {
  const sk = hexToBytes(n.toString(16).padStart(2, '0').repeat(32));
  dapp.wallet.priv = sk; dapp.wallet.pub = secp.getPublicKey(sk, true); dapp.wallet.mode = 'passkey';
  ADDR = dapp.wallet.address();
}
useKey(0x0d);
dapp._testSetScanHoldingsOverride(() => new Map());                         // the key holds no assets, so every coin it has is sats to spend
const CID = 'bafkreiabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

let broadcasts = [], pinned = [], hints = [], attests = [], pinFails = false, fundSats = 5_000_000;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = (opts.method || 'GET').toUpperCase();
  if (method === 'POST' && typeof opts.body === 'string' && opts.body.includes('"jsonrpc"')) return json({ jsonrpc: '2.0', id: JSON.parse(opts.body).id, result: '0x' + '00'.repeat(32) });
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: 10, halfHourFee: 5, hourFee: 2, economyFee: 1, minimumFee: 1 });
  if (u.includes('/scripthash/')) return json([]);
  if (u.includes(`/address/${ADDR}/utxo`)) return json([{ txid: 'ee'.repeat(32), vout: 0, value: fundSats, status: { confirmed: true } }]);
  if (method === 'POST' && u.includes('/pin-json')) { if (pinFails) return json({ error: 'pin down' }, 502); pinned.push(JSON.parse(opts.body)); return json({ cid: CID }); }
  if (method === 'POST' && u.includes('/assets/hint')) { hints.push(JSON.parse(opts.body)); return json({ ok: true }); }
  if (method === 'POST' && /\/assets\/[0-9a-f]{64}\/attest/.test(u)) { attests.push(JSON.parse(opts.body)); return json({ ok: true }); }
  if (method === 'POST' && u.endsWith('/tx')) { if (!broadcasts.includes(opts.body)) broadcasts.push(opts.body); return new Response('0'.repeat(64), { status: 200 }); }
  if (/\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(u)) return json({ spent: false });
  if (u.includes('/blocks/tip/height')) return new Response('800000', { status: 200 });
  return json({ error: 'mock: no handler for ' + u }, 404);
};

const BASE = { ticker: 'ORANGE', supply: 100000000000000n, decimals: 8 };

console.log('The quote:');
{
  const q = await dapp.etchQuote({ tickerLen: 6, pin: true });
  ok('the fee is the commit and the reveal at the rate', q.rate > 0 && q.fee > 0 && q.fee < 20000, JSON.stringify(q));
  ok('the sats it asks for are whole 500s, with room beyond the fee and the output', q.need % 500 === 0 && q.need >= q.fee + 546 + 1000, String(q.need));
  const longer = await dapp.etchQuote({ tickerLen: 8, pin: true, imageUri: 'ipfs://' + CID });
  const bare = await dapp.etchQuote({ tickerLen: 3, pin: false });
  ok('a longer ticker, or an image, costs more; the least costs least', longer.fee >= q.fee && q.fee >= bare.fee && longer.fee > bare.fee, `${longer.fee} ${q.fee} ${bare.fee}`);
}

console.log('\nAn etch refuses before it sends anything:');
{
  broadcasts = [];
  ok('a ticker with a symbol in it', await refuses(() => dapp.etchAsset({ ...BASE, ticker: 'OR-ANGE' }), /1 to 8 letters or digits/));
  ok('a ticker too long', await refuses(() => dapp.etchAsset({ ...BASE, ticker: 'ABCDEFGHI' }), /1 to 8 letters or digits/));
  ok('nine decimals', await refuses(() => dapp.etchAsset({ ...BASE, decimals: 9 }), /decimals are 0 to 8/));
  ok('no supply', await refuses(() => dapp.etchAsset({ ...BASE, supply: 0n }), /more than zero/));
  ok('a supply of 2⁶⁴ base units', await refuses(() => dapp.etchAsset({ ...BASE, supply: 1n << 64n }), /2⁶⁴/));
  ok('a link that is not https', await refuses(() => dapp.etchAsset({ ...BASE, externalUrl: 'http://orange.example' }), /https/));
  ok('an image that is not a CID', await refuses(() => dapp.etchAsset({ ...BASE, imageUri: 'https://orange.example/o.png' }), /image URI/));
  ok('a name over 64 characters', await refuses(() => dapp.etchAsset({ ...BASE, name: 'x'.repeat(65) }), /64 characters/));
  ok('a description over 500', await refuses(() => dapp.etchAsset({ ...BASE, description: 'x'.repeat(501) }), /500 characters/));
  ok('and nothing was broadcast, pinned or announced by any of them', broadcasts.length === 0 && pinned.length === 0 && hints.length === 0, `${broadcasts.length} ${pinned.length} ${hints.length}`);
  useKey(0x0e); fundSats = 700;
  ok('a key with too few sats stops before the commit', await refuses(() => dapp.etchAsset(BASE), /insufficient sats/) && broadcasts.length === 0);
  fundSats = 5_000_000;
}

console.log('\nAn etch that goes out:');
{
  useKey(0x0f);
  broadcasts = []; pinned = []; hints = []; attests = [];
  const stages = [];
  const r = await dapp.etchAsset({ ...BASE, name: 'Orange Coin', description: 'A coin', externalUrl: 'https://orange.example', imageUri: 'ipfs://' + CID, onProgress: (s) => stages.push(s) });
  ok('a commit and then a reveal are broadcast', broadcasts.length === 2, `${broadcasts.length} broadcasts`);
  ok('it reports the commit and the reveal', stages.includes('commit-start') && stages.includes('reveal-start') && stages.indexOf('commit-start') < stages.indexOf('reveal-start'), stages.join());
  ok('it returns both transactions and the asset id', /^[0-9a-f]{64}$/.test(r.commitTxid) && /^[0-9a-f]{64}$/.test(r.revealTxid) && r.commitTxid !== r.revealTxid && /^[0-9a-f]{64}$/.test(r.assetIdHex));
  ok('the asset id is the hash of the reveal id and its output', r.assetIdHex === bytesToHex(dapp.assetIdFor(r.revealTxid, 0)));
  ok('the metadata was pinned once, with the name, the image, the link and the decimals', pinned.length === 1 && pinned[0].name === 'Orange Coin' && pinned[0].image === 'ipfs://' + CID && pinned[0].external_url === 'https://orange.example' && pinned[0].description === 'A coin' && pinned[0].decimals === 8, JSON.stringify(pinned[0] || null));
  ok('and holds the supply’s opening', pinned[0].tacit_attest.supply === '100000000000000' && /^[0-9a-f]{64}$/.test(pinned[0].tacit_attest.blinding) && /^0[23][0-9a-f]{64}$/.test(pinned[0].tacit_attest.commitment));
  ok('the envelope names the metadata, not the image', r.metadataPinned === true && broadcasts[1].includes(bytesToHex(new TextEncoder().encode(`ipfs://${CID}`))));
  ok('the worker is told of the reveal, and given the opening', hints.length >= 1 && hints[0].reveal_txid === r.revealTxid && attests.length === 1 && attests[0].supply === '100000000000000' && attests[0].reveal_txid === r.revealTxid, `${hints.length} hints, ${attests.length} attests`);
  ok('the supply is said to be published', r.supplyPublished === true);
  const meta = dapp.getAssetMeta(r.assetIdHex);
  ok('the wallet knows the asset: its ticker, decimals and where it was etched', meta?.ticker === 'ORANGE' && meta.decimals === 8 && meta.etchTxid === r.revealTxid && meta.etchVout === 0, JSON.stringify(meta));
}

console.log('\nWhat is left out:');
{
  useKey(0x10);
  broadcasts = []; pinned = []; hints = []; attests = [];
  const r = await dapp.etchAsset({ ...BASE, ticker: 'QUIET', publishSupply: false });
  ok('no name, no link and no published supply: nothing is pinned and the image is not replaced', pinned.length === 0 && r.metadataPinned === null && broadcasts.length === 2);
  ok('the supply is not given to the worker, and is said to be private', attests.length === 0 && r.supplyPublished === false);
  useKey(0x11);
  broadcasts = []; pinned = []; attests = [];
  const n = await dapp.etchAsset({ ...BASE, ticker: 'NAMED', name: 'Named', publishSupply: false });
  ok('a name alone is pinned without the opening', pinned.length === 1 && pinned[0].name === 'Named' && pinned[0].tacit_attest === undefined && n.supplyPublished === false);
}

console.log('\nWhen the pin is down:');
{
  useKey(0x12);
  broadcasts = []; pinned = []; attests = []; pinFails = true;
  const r = await dapp.etchAsset({ ...BASE, ticker: 'NOPIN', name: 'No Pin' });
  ok('the asset is etched all the same, and says its metadata was not pinned', broadcasts.length === 2 && r.metadataPinned === false);
  ok('the supply is still given to the worker, so it is published through it', attests.length === 1 && r.supplyPublished === true);
  pinFails = false;
}

console.log('\nA mintable asset:');
{
  useKey(0x13);
  broadcasts = [];
  const r = await dapp.etchAsset({ ...BASE, ticker: 'MORE', mintable: true });
  const m = dapp.getAssetMeta(r.assetIdHex);
  ok('it goes out, and the wallet records the key as its mint authority', broadcasts.length === 2 && m.mintable === true && m.mintAuthorityHex === bytesToHex(dapp.wallet.xonly()));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
