// dapp/farm-ops.js, a private farm position as every page treats it: when Harvest and Unbond are offered, and an unbond refused over a pending
// reward sent again giving it up only when that reward is dust.
//   node tests/farm-ops.test.mjs
import assert from 'node:assert/strict';
import { canHarvest, canUnbond, unharvested, locked, harvest, unbond, UNBOND_DUST, HARVEST_WORTH } from '../dapp/farm-ops.js';

const now = 1_800_000_000;
assert.equal(canHarvest({ pendingUnits: '1' }), true); assert.equal(canHarvest({ pendingUnits: '0' }), false, 'nothing pending: nothing to harvest');
assert.equal(canHarvest({}), false); assert.equal(canHarvest({ pendingUnits: 'junk' }), false, 'an unreadable figure is nothing');
assert.equal(unharvested({ pendingUnits: String(UNBOND_DUST) }), false, 'dust is not an unharvested reward'); assert.equal(unharvested({ pendingUnits: String(UNBOND_DUST + 1n) }), true);
assert.equal(locked({ unlockAt: now + 60 }, now), true); assert.equal(locked({ unlockAt: now - 1 }, now), false); assert.equal(locked({}, now), false, 'no lock-up: free');
assert.equal(canUnbond({ unlockAt: now + 60, pendingUnits: '0' }, now), false, 'not before the bond is over');
assert.equal(canUnbond({ unlockAt: now - 1, pendingUnits: String(UNBOND_DUST * 2n) }, now), false, 'not while it holds a reward worth harvesting');
assert.equal(canUnbond({ unlockAt: now - 1, pendingUnits: '5' }, now), true);

const calls = [], t = {
  farmHarvest: async (a) => { calls.push(['harvest', a.position.id, a.waitOpts]); return { jobId: 'h' }; },
  farmUnbond: async (a) => { calls.push(['unbond', a.position.id, a.forfeitPending]); if (!a.forfeitPending && t.refuse != null) throw new Error(`farm-unbond: ${t.refuse} reward units would be forfeited`); return { jobId: 'u' }; },
};
assert.deepEqual(await harvest(t, 'PRIV', { id: 1 }, 'W'), { jobId: 'h' }); assert.deepEqual(calls.at(-1), ['harvest', 1, 'W']);
calls.length = 0; t.refuse = null;
await unbond(t, 'PRIV', { id: 2 }, 'W'); assert.deepEqual(calls, [['unbond', 2, false]], 'a clean unbond is sent once');
calls.length = 0; t.refuse = String(HARVEST_WORTH);
await unbond(t, 'PRIV', { id: 3 }, 'W', (p) => ({ ...p, id: 33 })); assert.deepEqual(calls, [['unbond', 3, false], ['unbond', 33, true]], 'refused over dust: sent again giving it up, with the position read again');
calls.length = 0; t.refuse = String(HARVEST_WORTH + 1n);
await assert.rejects(unbond(t, 'PRIV', { id: 4 }, 'W'), /reward units/, 'refused over a reward worth having: the refusal stands');
assert.equal(calls.length, 1);
console.log('farm-ops: all checks passed');
