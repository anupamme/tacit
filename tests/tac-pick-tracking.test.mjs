// tacPickCandidates: a greedy TAC pick walks notes of one kind (tracked by the reflection, or not) when that
// kind covers the amount, so a transfer does not spend an untracked note beside tracked ones. A note newer than
// the attested block joins either kind; other assets, a one-note pick and an unreadable state keep the plain
// pick; the state is read once per attested height. The worker is a mock.
//
// Run: `node tests/tac-pick-tracking.test.mjs`

import { JSDOM } from 'jsdom';
import { keccak_256 } from '@noble/hashes/sha3';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator; globalThis.__TACIT_NO_INIT__ = true;
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');
globalThis.__TACIT_WORKER_BASE__ = 'https://worker.test';

const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const keyOf = (txid, vout) => {
  const b = new Uint8Array(36);
  b.set(hexToBytes(txid).reverse(), 0);
  new DataView(b.buffer).setUint32(32, vout, true);
  return '0x' + bytesToHex(keccak_256(b));
};

let attested = 100, live = [], statusFails = false, dumpReads = 0, calls = 0;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url) => {
  const u = String(url);
  calls++;
  if (u.startsWith('https://worker.test/reflection/status')) return statusFails ? json({ error: 'down' }, 503) : json({ attestedHeight: attested });
  if (u.startsWith('https://worker.test/reflection/dump')) { dumpReads++; return json({ snapshot: { liveTriples: live.map((k) => [k, '0x00', '0x' + TAC, '0x00', 0]) } }); }
  return json({ error: 'not mocked' }, 404);
};

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
async function test(label, fn) {
  try { const ok = await fn(); if (ok) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

// A note: txid from a byte, amount, block height (null = unconfirmed).
const note = (byte, amount, height = 50) => ({
  amount: BigInt(amount), blinding: '1',
  utxo: { txid: byte.repeat(32), vout: 0, value: 546, status: height == null ? { confirmed: false } : { confirmed: true, block_height: height } },
});
const desc = (xs) => [...xs].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
const ids = (xs) => xs.map((x) => x.utxo.txid.slice(0, 2)).join(',');
// The tracked set changes only with a new attested height, so each change moves the height (the cache key).
const track = (...ns) => { live = ns.map((n) => keyOf(n.utxo.txid, n.utxo.vout)); attested++; };

const t50 = note('a1', 50), t30 = note('a2', 30), u60 = note('b1', 60), u35 = note('b2', 35), n20 = note('c1', 20, 150), t10 = note('a3', 10);

await test('another asset keeps the plain pick and reads nothing', async () => {
  calls = 0;
  const xs = desc([t50, u60]);
  return (await dapp.tacPickCandidates('00'.repeat(32), xs, 100n)) === xs && calls === 0;
});

await test('a pick the largest note covers alone keeps the plain pick and reads nothing', async () => {
  calls = 0;
  const xs = desc([t50, u60]);
  return (await dapp.tacPickCandidates(TAC, xs, 55n)) === xs && calls === 0;
});

await test('tracked notes that cover the amount are walked on their own', async () => {
  track(t50, t30);
  return ids(await dapp.tacPickCandidates(TAC, desc([t50, t30, u60]), 70n)) === 'a1,a2';
});

await test('untracked notes are walked on their own when the tracked ones fall short', async () => {
  track(t10);
  return ids(await dapp.tacPickCandidates(TAC, desc([t10, u60, u35]), 80n)) === 'b1,b2';
});

await test('a note newer than the attested block joins the tracked notes', async () => {
  track(t50, t30);
  return ids(await dapp.tacPickCandidates(TAC, desc([t50, t30, u60, n20]), 95n)) === 'a1,a2,c1';
});

await test('an unconfirmed note joins as well', async () => {
  track(t50);
  const pending = note('c2', 25, null);
  return ids(await dapp.tacPickCandidates(TAC, desc([t50, u35, pending]), 70n)) === 'a1,c2';
});

await test('when neither kind covers the amount the plain pick is kept', async () => {
  track(t50);
  const xs = desc([t50, u35]);
  return (await dapp.tacPickCandidates(TAC, xs, 80n)) === xs;
});

await test('an unreadable state keeps the plain pick', async () => {
  statusFails = true;
  const xs = desc([t50, t30, u60]);
  const r = await dapp.tacPickCandidates(TAC, xs, 70n);
  statusFails = false;
  return r === xs;
});

await test('the state is read once per attested height', async () => {
  track(t50, t30); dumpReads = 0;
  await dapp.tacPickCandidates(TAC, desc([t50, t30, u60]), 70n);
  await dapp.tacPickCandidates(TAC, desc([t50, t30, u60]), 70n);
  const once = dumpReads === 1;
  attested++;
  await dapp.tacPickCandidates(TAC, desc([t50, t30, u60]), 70n);
  return once && dumpReads === 2;
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
