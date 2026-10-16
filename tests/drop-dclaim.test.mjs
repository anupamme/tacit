// T_DCLAIM canonical credited-set computation against the
// worker's actual loadCreditedDclaims logic. This is the load-bearing
// supply-correctness gate for public-claim pools: the dapp validator treats
// the credited set as authoritative and rejects any claim absent from it, so
// the set MUST apply (in canonical (height, tx_index, txid) order):
//   - confirmation depth ≥ 3 (tip-state claims are pending, not credited),
//   - the cap (only the first cap_amount/per_claim claims credit), and
//   - txid de-dup (a reorg re-confirm leaves two keys for one claim).
// For OPEN drops (merkle_root == 0) there is no per-claim gate, so this
// credited-set computation is what prevents over-claiming the pool.
//
// Run: `node drop-dclaim.test.mjs`

import { loadCreditedDclaims, PMINT_CONFIRMATION_DEPTH, putDropReclaim, dropDepositorXonly } from '../worker/src/index.js';

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });
}

// In-memory KV stub: list({prefix,limit,cursor}) returning {keys,list_complete,cursor}.
// Lex-sort matches the production KV.list contract, so a key embedding zero-
// padded (height, tx_index) yields canonical chain order.
function makeKvStub(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    _data: data,
    set(k, v) { data.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete(k) { data.delete(k); },
    async list({ prefix, limit = 1000, cursor = null } = {}) {
      const sorted = Array.from(data.keys()).filter(k => k.startsWith(prefix)).sort();
      const startIdx = cursor ? Number(cursor) : 0;
      const page = sorted.slice(startIdx, startIdx + limit);
      const nextIdx = startIdx + limit;
      const list_complete = nextIdx >= sorted.length;
      return {
        keys: page.map(name => ({ name })),
        list_complete,
        cursor: list_complete ? undefined : String(nextIdx),
      };
    },
    async get(name, type) {
      if (!data.has(name)) return null;
      return type === 'json' ? JSON.parse(data.get(name)) : data.get(name);
    },
    async put(name, v) { data.set(name, v); },
  };
}

const DROP = 'd'.repeat(64);
// signet dclaim key shape: dclaim:<dropId>:<padH(10)>:<padTi(6)>:<txid>
const dclaimKey = (dropId, height, txIndex, txid) =>
  `dclaim:${dropId}:${String(height).padStart(10, '0')}:${String(txIndex).padStart(6, '0')}:${txid}`;
const tx = c => c.repeat(64);

console.log('SPEC §5.13 — T_DCLAIM credited-set (depth ≥ 3 + cap + de-dup):');

await test(`PMINT_CONFIRMATION_DEPTH is the shared §5.9/§5.13 3-conf rule`, () => PMINT_CONFIRMATION_DEPTH === 3);

// Happy path: cap=300, per=100 → 3 slots. Three deep claims all credit.
await test('all deep claims within cap are credited', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(dclaimKey(DROP, 100, 0, tx('a')), { kind: 'dclaim' });
  env.REGISTRY_KV.set(dclaimKey(DROP, 101, 0, tx('b')), { kind: 'dclaim' });
  env.REGISTRY_KV.set(dclaimKey(DROP, 102, 0, tx('c')), { kind: 'dclaim' });
  const r = await loadCreditedDclaims(env, 'signet', DROP, 110, '300', '100');
  return r.resolvable === true && r.list_complete === true
    && r.credited_txids.length === 3
    && r.credited_txids[0] === tx('a') && r.credited_txids[2] === tx('c');
});

// Cap overflow: 4 claims, cap fits 3. The canonically-later 4th is rejected.
await test('claims past cap_amount/per_claim are NOT credited (cap-overflow)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(dclaimKey(DROP, 100, 0, tx('a')), { kind: 'dclaim' });
  env.REGISTRY_KV.set(dclaimKey(DROP, 101, 0, tx('b')), { kind: 'dclaim' });
  env.REGISTRY_KV.set(dclaimKey(DROP, 102, 0, tx('c')), { kind: 'dclaim' });
  env.REGISTRY_KV.set(dclaimKey(DROP, 103, 0, tx('d')), { kind: 'dclaim' });
  const r = await loadCreditedDclaims(env, 'signet', DROP, 110, '300', '100');
  return r.resolvable === true
    && r.credited_txids.length === 3
    && !r.credited_txids.includes(tx('d'));   // the 4th (overflow) is excluded
});

// Depth gate: a tip-state claim (depth < 3) is pending, not credited.
await test('tip-state claim (depth < 3) is excluded (pending, not credited)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(dclaimKey(DROP, 100, 0, tx('a')), { kind: 'dclaim' }); // depth 11
  env.REGISTRY_KV.set(dclaimKey(DROP, 101, 0, tx('b')), { kind: 'dclaim' }); // depth 10
  env.REGISTRY_KV.set(dclaimKey(DROP, 109, 0, tx('c')), { kind: 'dclaim' }); // depth 2 < 3 → pending
  const r = await loadCreditedDclaims(env, 'signet', DROP, 110, '300', '100');
  return r.resolvable === true
    && r.credited_txids.length === 2
    && !r.credited_txids.includes(tx('c'));
});

// De-dup: a reorg re-confirm leaves the same txid under two canonical keys.
// One claim consumes one cap slot; the distinct later claim must still credit.
await test('reorg re-confirm de-dups (one txid → one cap slot)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // cap=200, per=100 → 2 slots. 'a' appears at two heights; 'b' is distinct.
  env.REGISTRY_KV.set(dclaimKey(DROP, 100, 0, tx('a')), { kind: 'dclaim' });
  env.REGISTRY_KV.set(dclaimKey(DROP, 101, 0, tx('a')), { kind: 'dclaim' }); // duplicate txid
  env.REGISTRY_KV.set(dclaimKey(DROP, 102, 0, tx('b')), { kind: 'dclaim' });
  const r = await loadCreditedDclaims(env, 'signet', DROP, 110, '200', '100');
  // Without de-dup: 'a'@100 + 'a'@101 fill the cap and 'b' overflows.
  // With de-dup: 'a' once + 'b' → both distinct claims credit.
  return r.resolvable === true
    && r.credited_txids.length === 2
    && r.credited_txids.filter(t => t === tx('a')).length === 1
    && r.credited_txids.includes(tx('b'));
});

// Unresolvable: tip unavailable → resolvable=false (the endpoint answers 503 and
// the dapp keeps the claim pending) rather than asserting an empty set.
await test('null tip → resolvable=false (degrade, do not assert a set)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(dclaimKey(DROP, 100, 0, tx('a')), { kind: 'dclaim' });
  const r = await loadCreditedDclaims(env, 'signet', DROP, null, '300', '100');
  return r.resolvable === false && r.credited_txids.length === 0;
});

console.log('\nT_DROP reclaim record (one per drop, the depositor\'s first confirmed):');

const DEPOSITOR = '02' + 'ab'.repeat(32);
const xonly = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const reclaimEnv = () => {
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(`drop:${DROP}`, { kind: 'drop', drop_reveal_txid: tx('f'), depositor_xonly: 'ab'.repeat(32) });
  return env;
};
const reclaimMeta = (txid, h) => ({ kind: 'drop-reclaim', reclaim_drop_id: DROP, reclaim_txid: txid, reclaim_at_height: h });
const recorded = async (env) => (await env.REGISTRY_KV.get(`drop-reclaim:${DROP}`, 'json'))?.reclaim_txid || null;

await test('the depositor is the key of the drop\'s first funding input', () =>
  dropDepositorXonly({ vin: [{}, { witness: ['30', DEPOSITOR] }] }) === 'ab'.repeat(32)
  && dropDepositorXonly({ vin: [{}, { witness: ['30', '00'] }] }) === null);
await test('a reclaim not signed under the depositor key is not recorded', async () => {
  const env = reclaimEnv();
  const okWrite = await putDropReclaim(env, 'signet', reclaimMeta(tx('1'), 200), xonly('cd'.repeat(32)));
  return okWrite === false && (await recorded(env)) === null;
});
await test('the depositor\'s first confirmed reclaim is recorded, a later one is not', async () => {
  const env = reclaimEnv();
  const first = await putDropReclaim(env, 'signet', reclaimMeta(tx('1'), 200), xonly('ab'.repeat(32)));
  const later = await putDropReclaim(env, 'signet', reclaimMeta(tx('2'), 205), xonly('ab'.repeat(32)));
  return first === true && later === false && (await recorded(env)) === tx('1');
});
await test('an earlier confirmed reclaim replaces a later one (scan order)', async () => {
  const env = reclaimEnv();
  await putDropReclaim(env, 'signet', reclaimMeta(tx('2'), 205), xonly('ab'.repeat(32)));
  const earlier = await putDropReclaim(env, 'signet', reclaimMeta(tx('1'), 200), xonly('ab'.repeat(32)));
  return earlier === true && (await recorded(env)) === tx('1');
});
await test('an unconfirmed reclaim never displaces a confirmed one, and yields to one', async () => {
  const env = reclaimEnv();
  const pending = await putDropReclaim(env, 'signet', reclaimMeta(tx('3'), 0), xonly('ab'.repeat(32)));
  const confirmedOne = await putDropReclaim(env, 'signet', reclaimMeta(tx('4'), 210), xonly('ab'.repeat(32)));
  const pendingAgain = await putDropReclaim(env, 'signet', reclaimMeta(tx('5'), 0), xonly('ab'.repeat(32)));
  return pending === true && confirmedOne === true && pendingAgain === false && (await recorded(env)) === tx('4');
});

console.log(`\n${pass} passed, ${fail} failed.`);
// Exit on the computed verdict rather than only on failure: imported browser modules can leave the
// event loop alive, and a run that passes every assertion then never exits reads as a hang.
process.exit(fail > 0 ? 1 : 0);
