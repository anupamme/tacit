// node worker-relay/tests/replenish-schedule.test.mjs
import assert from 'node:assert/strict';
import { replenishDue } from '../src/lib/replenish-schedule.js';
const base = { enabled: true, intervalMin: 30, now: 10_000_000, lastAt: 0 };
assert.equal(replenishDue(base), true, 'never run: due');
assert.equal(replenishDue({ ...base, lastAt: base.now - 29 * 60_000 }), false, 'run 29 minutes ago: not yet');
assert.equal(replenishDue({ ...base, lastAt: base.now - 30 * 60_000 }), true, 'run 30 minutes ago: due');
assert.equal(replenishDue({ ...base, enabled: false }), false, 'switched off: never');
assert.equal(replenishDue({ ...base, enabled: false, pendingDrain: true }), true, 'the one-off consolidation runs even when the top-up is off');
assert.equal(replenishDue({ ...base, intervalMin: 0, lastAt: base.now }), true, 'a zero interval is always due');
console.log('ok - 6 replenish schedule checks');
