// dapp/farm-ops.js, a private farm position as every page treats it: when Harvest and Unbond are offered, and an unbond refused over a pending
// reward sent again giving it up only when that reward is dust.
//   node tests/farm-ops.test.mjs
import assert from 'node:assert/strict';
import { canHarvest, canUnbond, unharvested, locked, harvest, unbond, UNBOND_DUST, HARVEST_WORTH, WTAC, wtacWithdrawCall, wtacBalanceCall, rewardNotes, relayable, worthHarvesting, redeem, lpNotes, takeOut } from '../dapp/farm-ops.js';

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
// ── rewards turned into TAC, liquidity taken out ──
const to = '0x' + 'Ab'.repeat(20);
assert.deepEqual(wtacWithdrawCall(5n * 10n ** 18n, to), { to: WTAC, data: '0x00f714ce' + (5n * 10n ** 18n).toString(16).padStart(64, '0') + 'ab'.repeat(20).padStart(64, '0') }, 'withdraw(amount, to) on wTAC');
assert.equal(wtacBalanceCall(to).data, '0x70a08231' + 'ab'.repeat(20).padStart(64, '0'));
const RID = '0xRW', notes = [{ asset: '0xrw', value: '300' }, { asset: '0xother', value: '9' }, { asset: '0xRW', value: '50' }];
assert.deepEqual(rewardNotes(notes, RID).map((n) => n.value), ['300', '50'], 'the reward asset\'s notes, whatever its case'); assert.deepEqual(rewardNotes(notes, null), []);
const ft = { poolTickerOf: (id) => `tk(${id})`, quoteUnwrapFee: (v, tk) => { if (tk !== 'tk(0xrw)') throw new Error('ticker'); const fee = 100n; return { fee, net: BigInt(v) - fee }; } };
assert.equal(relayable(ft, { value: '300' }, RID), true); assert.equal(relayable(ft, { value: '100' }, RID), false, 'the fee takes it all: not through the relay');
assert.equal(relayable({ poolTickerOf: () => { throw new Error('x'); } }, { value: '1' }, RID), true, 'a note that cannot be priced is tried');
assert.equal(worthHarvesting(ft, HARVEST_WORTH, RID), false, 'dust is not harvested'); assert.equal(worthHarvesting(ft, HARVEST_WORTH + 1n, RID), true, 'over dust with a fee under half: harvested');
assert.equal(worthHarvesting({ poolTickerOf: () => 'x', quoteUnwrapFee: (v) => ({ fee: BigInt(v) }) }, 10n ** 9n, RID), false, 'a fee over half of it: not through the relay');
const rc = [], rt = { farmRedeem: async (a) => rc.push(a), lpRemove: async (a) => rc.push(a) };
await redeem(rt, 'PRIV', { id: 'n' }, to, 'W'); assert.deepEqual(rc.at(-1), { walletPriv: 'PRIV', note: { id: 'n' }, to, wait: true, waitOpts: 'W' });
const pool = { lpAsset: '0xLP', feeBps: 25, reserves: { assetA: '0xA', assetB: '0xB' } };
assert.deepEqual(lpNotes([{ asset: '0xlp', id: 1 }, { asset: '0xA', id: 2 }], pool).map((n) => n.id), [1], 'the pool\'s share notes');
await takeOut(rt, 'PRIV', pool, { id: 'lp' }, 'W'); assert.deepEqual(rc.at(-1), { walletPriv: 'PRIV', assetA: '0xA', assetB: '0xB', feeBps: 25, shareNote: { id: 'lp' }, waitOpts: 'W' }, 'taken out as the pool\'s two assets at its fee');
console.log('farm-ops: all checks passed');
