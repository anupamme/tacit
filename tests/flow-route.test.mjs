// GET /flow on the API: the visualizer's feed, served from the saved stats reading and the reflection's status, with the counter history
// from storage. Offline: node --test tests/flow-route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { toJson } from '../dapp/weld/stats/read.js';

globalThis.fetch = async () => { throw new Error('offline'); };   // the minted count reads Ethereum: unreachable here, so absent
const now = Math.floor(Date.now() / 1000), ago = (s) => now - s;
const reading = {
  at: now, errors: {}, partial: false, stale: [],
  link: { tip: 970_926, btcTip: 970_957, attestedHeight: 970_902, anchorHeight: 964_163, attests: 3, settles: 4, notes: 1, spent: 1, crossOuts: 9, consumed: 2,
    times: { attests: [ago(40 * 3600), ago(3600), ago(600)], settles: [ago(7200), ago(60)] } },
  eth: { inWei: 1n, outWei: 0n, deposits: 1, series: { ins: [[ago(1800), 5n]], flows: [] } },
  dev: [],
  tac: { supply: 2_499_974_665_590_930_000_000_000n, times: { out: [ago(5000)], in: [ago(4000), ago(90000)] } },
};
const record = JSON.stringify({ attestedHeight: 970_902, tipHeight: 970_926, snapshot: { foldedCrossoutCount: '7', consumedCount: 2, burnNodes: [['0x00', '0x01', '0x00', true], ['0x01', '0x00', '0xd1', true]], liveTriples: [[1]], noteLeaves: [], pendingDepositRecords: [] } });
const series = [{ t: ago(7200), burns: 41, minted: 30, out: 9, att: 970_880, relay: 970_900, btc: 970_930 }, { t: ago(600), burns: 43, minted: 32, out: 9, att: 970_902, relay: 970_926, btc: 970_957 }];
const kv = new Map([['stats:last:v1', JSON.stringify({ at: Date.now(), body: toJson(reading) })], ['reflection:scan:mainnet', record], ['flow:series:mainnet', JSON.stringify(series)]]);
const env = { REGISTRY_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } } };
const worker = await import('../worker/src/index.js');
const get = (headers = {}) => worker.default.fetch(new Request('https://api.test/flow', { headers }), env, { waitUntil() {} });

test('answers with the counters now, the history and the last day of events', async () => {
  const r = await get({ origin: 'https://tacit.finance' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /json/);
  assert.match(r.headers.get('cache-control'), /max-age=15/);
  const f = await r.json();
  assert.equal(f.now.btc, 970_957); assert.equal(f.now.relay, 970_926); assert.equal(f.now.attested, 970_902);
  assert.equal(f.now.burns, 1, 'recorded burns from the reflection status, not counting the burn set\'s opening entry');
  assert.equal(f.now.minted, null, 'the pool is unreachable here, so the minted count is absent rather than zero');
  assert.equal(f.now.crossOuts, 9);
  assert.equal(f.now.tacSupply, '2499974665590930000000000');
  assert.equal(f.events.attests.length, 2, 'the 40-hour-old attestation is outside the day');
  assert.equal(f.events.settles.length, 2); assert.equal(f.events.deposits.length, 1);
  assert.equal(f.events.tacOut.length, 1); assert.equal(f.events.tacIn.length, 1, 'the TAC wrap 25 hours ago is outside the day');
  assert.equal(f.series.length, 2);
});

test('any origin may read it, as it may the stats', async () => {
  const r = await get({ origin: 'https://example.org' });
  assert.equal(r.status, 200);
  assert.ok(['*', 'https://example.org'].includes(r.headers.get('access-control-allow-origin')), `allow-origin ${r.headers.get('access-control-allow-origin')}`);
});

test('the feed carries no address or transaction hash, whatever the reading holds', async () => {
  const text = await (await get()).text();
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(text), 'no address');
  assert.ok(!/0x[0-9a-fA-F]{64}/.test(text), 'no transaction hash');
});

test('a history in storage that is corrupt reads as no history, and the feed still answers', async () => {
  kv.set('flow:series:mainnet', '{not json');
  const f = await (await get()).json();
  assert.deepEqual(f.series, []);
  assert.equal(f.now.btc, 970_957);
});
