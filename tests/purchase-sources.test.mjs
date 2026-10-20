// The two sources of a purchase's cross-check (dapp/tacit.js _crossCheckedFetcher: the shared reader and _explorerTx), network-free.
//
//   - an answer that is a rate limit, a server error or a timeout from every explorer is tried again after a pause, and the lot still checks
//   - a host that just limited the browser is left alone while another does not
//   - every explorer answering "not found" ends the read at once; explorers that stay down end it empty (the purchase refuses)
//   - a transaction both sources agreed on once it was a day deep is not read from the second source again in a later session, but only a copy
//     with the same fields: a changed copy goes through both sources; a young or unconfirmed one is never recorded
//
// Run: node tests/purchase-sources.test.mjs

const store = new Map();
const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el(), readyState: 'complete' };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', hash: '', search: '', pathname: '/', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true, language: 'en' }, configurable: true }); } catch {}
globalThis.addEventListener = () => {};
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
store.set('tacit-network-v1', 'signet');

const NOW = Math.floor(Date.now() / 1000);
const txs = new Map();
const mk = (n, { witness = ['aa'], blockTime = NOW - 30 * 86400, confirmed = true } = {}) => {
  const txid = n.toString(16).padStart(64, '0');
  txs.set(txid, { txid, version: 2, locktime: 0, vin: [{ txid: '11'.repeat(32), vout: 0, witness }], vout: [{ scriptpubkey: '0014' + '22'.repeat(20), value: 546 }], status: confirmed ? { confirmed: true, block_height: 100, block_time: blockTime } : { confirmed: false } });
  return txid;
};

// Every explorer read lands here: `faults` decides the answer per host and transaction, `forged` changes what one host says about a transaction.
const log = [];
const E = { faults: (host, id, nth) => null, forged: new Map() };
const seen = new Map();
const reads = (host, id) => log.filter((l) => l.host === host && (!id || l.id === id)).length;
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  const m = /\/tx\/([0-9a-f]{64})$/.exec(u.pathname);
  if (!m) return new Response('{"error":"not found"}', { status: 404 });
  const id = m[1], k = `${u.hostname}|${id}`, nth = (seen.get(k) || 0) + 1;
  seen.set(k, nth);
  log.push({ host: u.hostname, id });
  const fault = E.faults(u.hostname, id, nth);
  if (fault === 'down') throw new TypeError('Failed to fetch');
  if (fault) return new Response('limited', { status: fault, headers: { 'retry-after': '1' } });
  const t = (E.forged.get(`${u.hostname}|${id}`)) || txs.get(id);
  return t ? new Response(JSON.stringify(t), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{"error":"not found"}', { status: 404 });
};

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; } };
let n = 0;
const fresh = async () => { log.length = 0; seen.clear(); E.faults = () => null; E.forged.clear(); return import(`${process.env.TACIT_MODULE || '../dapp/tacit.js'}?s${++n}`); };
const BS = 'blockstream.info', MP = 'mempool.space', FAST = { backoffMs: [0, 10, 10] };
const settle = () => new Promise((r) => setTimeout(r, 600));          // the record of what both sources agreed on is written a moment after

console.log('The second source:');
{
  const d = await fresh(), id = mk(1);
  const t = await d._explorerTx(id, FAST);
  ok('a healthy explorer answers in one read, from blockstream first', t?.txid === id && log.length === 1 && log[0].host === BS, JSON.stringify(log));
}
{
  const d = await fresh(), id = mk(2);
  E.faults = (host, tx, nth) => (nth === 1 ? 429 : null);
  const t = await d._explorerTx(id, FAST);
  ok('every explorer rate limiting the first read does not lose the transaction: it is read again', t?.txid === id, `${t ? 'got' : 'null'} after ${log.length} reads`);
}
{
  const d = await fresh(), id = mk(3);
  E.faults = (host, tx, nth) => (nth === 1 ? 'down' : null);
  const t = await d._explorerTx(id, FAST);
  ok('a timeout or dropped connection on every explorer is tried again too', t?.txid === id);
}
{
  const d = await fresh(), id = mk(4);
  E.faults = () => 500;
  const t = await d._explorerTx(id, FAST);
  ok('explorers that stay down end it empty after a bounded number of reads (the purchase refuses)', t === null && log.length <= 6 && log.length >= 2, `${log.length} reads`);
}
{
  const d = await fresh();
  const t = await d._explorerTx('ab'.repeat(32), FAST);
  ok('every explorer answering "not found" ends it at once, with one read of each', t === null && log.length === 2, `${log.length} reads`);
}
{
  const d = await fresh(), a = mk(5), b = mk(6);
  E.faults = (host, tx, nth) => (host === BS ? 429 : null);
  await d._explorerTx(a, FAST);
  const before = reads(BS);
  const t = await d._explorerTx(b, FAST);
  ok('a host that just limited the browser is not asked again while another answers', t?.txid === b && reads(BS) === before, `${reads(BS) - before} more reads of it`);
}

console.log('\nThe cross-check:');
{
  const d = await fresh(), id = mk(10);
  const t = await d._crossCheckedFetcher()(id);
  ok('two sources that agree on a deep transaction give it', t?.txid === id && reads(BS, id) === 1 && reads(MP, id) >= 1, JSON.stringify(log.map((l) => l.host)));
  await settle();
  const key = [...store.keys()].find((x) => x.startsWith('tacit-xchecked-v1'));
  ok('and it is recorded (a txid and a hash, nothing else)', !!key && new RegExp(`^${id}:[0-9a-f]{32}$`).test(store.get(key)), String(store.get(key)).slice(0, 120));

  const d2 = await fresh();
  const t2 = await d2._crossCheckedFetcher()(id);
  ok('a later session takes the same transaction from the shared reader alone', t2?.txid === id && reads(BS, id) === 0, `${reads(BS, id)} reads of the second source`);

  const d3 = await fresh();
  const forged = structuredClone(txs.get(id)); forged.vin[0].witness = ['bb'];
  E.forged.set(`${MP}|${id}`, forged);
  const t3 = await d3._crossCheckedFetcher()(id);
  ok('a changed copy from the shared reader is not taken as already agreed: both sources are read and differ', t3 === null && reads(BS, id) >= 1, `${reads(BS, id)} reads of the second source`);
}
{
  store.clear(); store.set('tacit-network-v1', 'signet');
  const d = await fresh(), young = mk(11, { blockTime: NOW - 3600 }), pending = mk(12, { confirmed: false });
  await d._crossCheckedFetcher()(young);
  await d._crossCheckedFetcher()(pending);
  await settle();
  const key = [...store.keys()].find((x) => x.startsWith('tacit-xchecked-v1'));
  ok('a transaction less than a day deep, or unconfirmed, is not recorded', !key || (!String(store.get(key)).includes(young) && !String(store.get(key)).includes(pending)), String(store.get(key)).slice(0, 120));
  const d2 = await fresh();
  await d2._crossCheckedFetcher()(young);
  ok('so a later session reads it from both sources again', reads(BS, young) >= 1);
}
{
  const d = await fresh(), id = mk(14);
  E.down = true; E.faults = () => (E.down ? 500 : null);
  const first = await d._crossCheckedFetcher()(id);
  E.down = false;
  const again = await d._crossCheckedFetcher()(id);
  ok('a read that failed once is not remembered as the answer: the same lot checks when it is tried again in the same session', first === null && again?.txid === id, `first ${first ? 'tx' : 'null'}, again ${again ? 'tx' : 'null'}`);
}
{
  const d = await fresh(), id = mk(16);
  E.faults = (host, tx, nth) => (host === MP && nth === 1 ? 500 : null);
  const t = await d._crossCheckedFetcher()(id);
  ok('when the shared reader fails over to the same explorer the second source starts with, another one is asked for the copy that is compared', t?.txid === id && reads(MP, id) >= 2, `${reads(MP, id)} reads of mempool.space`);
}
{
  const d = await fresh(), id = mk(17);
  E.faults = (host, tx, nth) => (host === MP && nth === 1 ? 500 : null);
  const forged = structuredClone(txs.get(id)); forged.vin[0].witness = ['bb'];
  E.forged.set(`${BS}|${id}`, forged);
  const t = await d._crossCheckedFetcher()(id);
  ok('so one explorer giving a changed copy of a transaction to both reads does not pass the check', t === null, t ? 'accepted the changed copy' : '');
}
{
  const d = await fresh(), id = mk(15);
  E.down = true; E.faults = () => (E.down ? 429 : null);
  setTimeout(() => { E.down = false; }, 300);
  const t = await d._crossCheckedFetcher()(id);
  ok('both sources limiting for a moment does not refuse the lot: the shared reader reads again too', t?.txid === id, t ? '' : 'null');
}
{
  const d = await fresh(), id = mk(13);
  E.faults = (host) => (host === BS || host === MP ? 500 : null);
  const t = await d._crossCheckedFetcher()(id);
  ok('with the explorers down the check gives nothing (it fails closed)', t === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
