// GET /reflection/status: a small public summary so an integrator need not download the full snapshot.
// Offline: node tests/reflection-status.test.mjs
const record = JSON.stringify({ attestedHeight: 967810, tipHeight: 967836, snapshot: { foldedCrossoutCount: '2', consumedCount: 1, burnNodes: [['0x00', '0x01', '0x00', true], ['0x01', '0x02', '0xd1', true], ['0x02', '0x00', '0xd2', true]], liveTriples: [[1], [2], [3]], noteLeaves: new Array(50).fill('0x0'), pendingDepositRecords: [] } });
let reads = 0;
const env = { REGISTRY_KV: { get: async (k) => { reads++; return k === 'reflection:scan:mainnet' ? record : null; }, put: async () => {}, delete: async () => {} } };
globalThis.fetch = async () => { throw new Error('offline'); };   // the minted count reads Ethereum: unreachable here, so absent
const worker = await import('../worker/src/index.js');
const get = (q = '') => worker.default.fetch(new Request('https://api.test/reflection/status' + q), env, { waitUntil() {} });
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };

const r = await get('?network=mainnet');
const b = await r.json();
ok('answers without credentials', r.status === 200);
ok('reports attested and relay tip heights', b.attestedHeight === 967810 && b.tipHeight === 967836);
ok('reports the lag in blocks', b.lagBlocks === 26);
ok('reports the confirmation depth the pool requires', b.confirmations === 24);
ok('reports the folded cross-out and consumed counts', b.foldedCrossoutCount === 2 && b.consumedCount === 1);
ok('reports the bridge-in burns it has recorded, not counting the burn set\'s opening entry', b.bridgeBurns === 2);
ok('reports live note count without shipping the notes', b.liveNotes === 3 && !('snapshot' in b) && JSON.stringify(b).length < 600);
const before = reads;
await get('?network=mainnet'); await get('?network=mainnet');
ok('repeat calls inside the window reuse the parsed summary', reads === before);
const s = await get('?network=signet');
ok('an unseeded network is a clean 404', s.status === 404);
// Burns the reflection holds pending with no proof bundle registered, and how long the oldest has waited (the other network,
// since each network's summary is held for a few seconds).
{
  const rec = (txid, height, completed = false) => ({ burnTxidDisplay: '0x' + txid.repeat(32), height, completed });
  const pendingRecord = JSON.stringify({ attestedHeight: 970000, tipHeight: 970010, snapshot: { burnNodes: [['0x00', '0x01', '0x00', true]], pendingDepositRecords: [rec('aa', 969000), rec('bb', 969500), rec('cc', 968000, true), rec('dd', 969900)] } });
  const registered = new Set(['bb'.repeat(32), 'dd'.repeat(32)]);
  const env2 = { REGISTRY_KV: { get: async (k) => (k === 'reflection:scan:signet' ? pendingRecord : (registered.has(k.split(':').pop()) ? '{}' : null)), put: async () => {}, delete: async () => {} } };
  const b2 = await (await worker.default.fetch(new Request('https://api.test/reflection/status?network=signet'), env2, { waitUntil() {} })).json();
  ok('counts the open pending burns that have no bundle registered', b2.burnsAwaitingBundle === 1);
  ok('reports the height of the oldest of them', b2.oldestAwaitingHeight === 969000);
  ok('still counts every pending record as before', b2.burnDeposits === 4);
  ok('a record already completed is never counted', b2.burnsAwaitingBundle === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
