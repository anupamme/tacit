// worker/src/book-views.js: the trade page's slim list of sales keeps what its order book is drawn from (dapp/btc-book.js reads it) and drops the rest.
import assert from 'node:assert/strict';
import { preauthSalesBookBody } from '../worker/src/book-views.js';
import { buildBook } from '../dapp/btc-book.js';

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok  ', m); };

const AID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', soon = Math.floor(Date.now() / 1000) + 86400;
const sale = (i, sats, amount, extra = {}) => ({
  sale_id: i.toString(16).padStart(32, '0'), asset_id: AID, network: 'mainnet', ticker: 'TAC', decimals: 8, nonce: 'ab'.repeat(16),
  seller_pubkey: '02' + 'cd'.repeat(32), seller_payout_address: 'bc1q' + 'x'.repeat(38), seller_payout_script: '0014' + 'ee'.repeat(20),
  asset_outpoint: { txid: 'aa'.repeat(32), vout: 1 }, asset_opening: { amount: String(amount), blinding: '11'.repeat(32) },
  seller_asset_spend_sig: 'ff'.repeat(72), auth_sig: 'ee'.repeat(64), min_price_sats: sats, expiry: soon, expired: false, created_at: soon - 86400 * 2, ...extra,
});
const whole = { asset_id: AID, count: 4, sales: [sale(1, 250000, 100000000000n), sale(2, 210000, 1090000000000n), sale(3, 5000, 2638n * 10n ** 8n, { expired: true }), sale(4, 600, 50n * 10n ** 8n)] };
const body = JSON.stringify(whole, (k, v) => (typeof v === 'bigint' ? String(v) : v));
const slim = JSON.parse(preauthSalesBookBody(body));

ok(slim.sales.length === 4 && slim.count === 4 && slim.asset_id === AID && slim.view === 'book', 'every sale is listed, with the list\'s own fields and the view named');
ok(slim.sales.every((s) => !('seller_asset_spend_sig' in s) && !('auth_sig' in s) && !('asset_outpoint' in s) && !('seller_payout_script' in s) && !s.asset_opening.blinding), 'the signatures, the outpoint, the payout and the blinding are left out');
ok(preauthSalesBookBody(body).length * 2 < body.length, `it is a fraction of the whole list (${preauthSalesBookBody(body).length} of ${body.length} bytes)`);
// the order book drawn from the slim list is the one drawn from the whole list
const book = (rows) => buildBook({ assetId: AID, decimals: 8, listings: rows.map((x) => ({ ...x, kind: 'preauth' })), bids: [], myPubHex: '02' + 'cd'.repeat(32) });
const a = book(JSON.parse(body).sales), b = book(slim.sales), strip = (x) => x.asks.map(({ raw, ...r }) => r);
ok(JSON.stringify(strip(a), (k, v) => (typeof v === 'bigint' ? String(v) : v)) === JSON.stringify(strip(b), (k, v) => (typeof v === 'bigint' ? String(v) : v)) && a.bestAsk === b.bestAsk && b.asks.length === 3, `the book drawn from it is the same: ${b.asks.length} asks (the expired one left out), the same prices, amounts, ends and seller`);
ok(b.asks.every((x) => x.mine), 'whose sale it is still reads from the seller\'s key');
assert.throws(() => preauthSalesBookBody('not json')); assert.throws(() => preauthSalesBookBody('{"error":"x"}'));
ok(true, 'a body that is not a list of sales throws, so the handler serves the whole list');
console.log(`${n} book-views checks passed`);
