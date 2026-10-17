// The relay's renewal of a bridge mint the pool's burn root has moved past (src/lib/bridge-mint-renew.js).
//   node worker-relay/tests/bridge-mint-renew.test.mjs
import assert from 'node:assert/strict';
import { renewStaleMint } from '../src/lib/bridge-mint-renew.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const mint = (extra = {}) => ({ jobId: '0x' + '11'.repeat(32), type: 'bridgemint', mode: 'settle', op: { bitcoinBurnRoot: '0xold' }, ...extra });
const rig = ({ stale = true, answers = [] } = {}) => {
  const calls = { refresh: 0, sleeps: [], logs: [] };
  const q = [...answers];
  return { calls, deps: { blocker: async () => (stale ? 'moved on' : null), refresh: async () => { calls.refresh++; return q.shift() || { ok: false, code: 'burn_not_recorded' }; }, sleep: async (s) => { calls.sleeps.push(s); }, log: (m) => calls.logs.push(m) } };
};

await test('a mint on the root the pool holds is left alone, and the API is not asked', async () => {
  const { calls, deps } = rig({ stale: false });
  const j = mint();
  assert.equal(await renewStaleMint(j, deps), false);
  assert.equal(calls.refresh, 0);
  assert.equal(j.op.bitcoinBurnRoot, '0xold');
});

await test('a stale mint takes the op the API renews it to, and is proved on that', async () => {
  const { calls, deps } = rig({ answers: [{ ok: true, op: { bitcoinBurnRoot: '0xnew' } }] });
  const j = mint();
  assert.equal(await renewStaleMint(j, deps), true);
  assert.equal(j.op.bitcoinBurnRoot, '0xnew');
  assert.equal(calls.refresh, 1);
  assert.match(calls.logs[0], /renewed on the burn root the pool holds/);
});

await test('a reflection that is not the pool\'s yet is waited for a little, then used', async () => {
  const { calls, deps } = rig({ answers: [{ ok: false, code: 'reflection_not_current' }, { ok: false, code: 'chain_unreadable' }, { ok: true, op: { bitcoinBurnRoot: '0xnew' } }] });
  const j = mint();
  assert.equal(await renewStaleMint(j, deps), true);
  assert.equal(calls.refresh, 3);
  assert.deepEqual(calls.sleeps, [20, 20]);
});

await test('one that is still not current after the tries is given up on, quietly, for the stale-root check to turn back', async () => {
  const { calls, deps } = rig({ answers: Array(5).fill({ ok: false, code: 'reflection_not_current' }) });
  const j = mint();
  assert.equal(await renewStaleMint(j, deps), false);
  assert.equal(calls.refresh, 3);
  assert.equal(j.op.bitcoinBurnRoot, '0xold');
});

await test('a verdict is not asked again (the burn is not recorded, the destination differs)', async () => {
  for (const code of ['burn_not_recorded', 'dest_mismatch', 'note_not_in_tree', 'bad_op', 'bad_renewal']) {
    const { calls, deps } = rig({ answers: [{ ok: false, code }] });
    assert.equal(await renewStaleMint(mint(), deps), false);
    assert.equal(calls.refresh, 1, code);
    assert.deepEqual(calls.sleeps, []);
  }
});

await test('what is not a queued bridge mint is never touched', async () => {
  const { calls, deps } = rig();
  for (const j of [mint({ type: 'transfer' }), mint({ op: null }), mint({ mode: 'preproven' }), null]) assert.equal(await renewStaleMint(j, deps), false);
  assert.equal(calls.refresh, 0);
});

console.log(`\nall ${n} bridge-mint-renew checks passed`);
