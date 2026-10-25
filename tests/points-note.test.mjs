import assert from 'node:assert/strict';
import { makePointsNote } from '../dapp/points-note.js';

const day = 20742, t0 = day * 86400e3 + 3600e3;
const program = (extra = {}) => ({ program: { rates: { zswapeth: 1000 }, weights: [{ fromDay: day - 5, weights: {} }], ...extra } });
let clock = t0, calls = 0, answer = program();
const note = makePointsNote({ read: async () => { calls++; if (answer instanceof Error) throw answer; return answer; }, now: () => clock });

assert.equal(note.floor(10n ** 18n), '', 'nothing is said before the terms are read');
assert.equal(await note.load(), 1000);
assert.equal(note.floor(5n * 10n ** 17n), '500+ points');
assert.equal(note.floor(1234n * 10n ** 18n), '1,234,000+ points', 'thousands are grouped');
assert.equal(note.floor(10n ** 14n), '', 'under one point says nothing');
await note.load(); assert.equal(calls, 1, 'the terms are read once in ten minutes');
clock += 601e3; answer = program({ weights: [{ fromDay: day - 5, weights: { zswapeth: 2 } }] });
assert.equal(await note.load(), 2000, 'the day’s weight multiplies the rate'); assert.equal(calls, 2);
clock += 601e3; answer = program({ weights: [{ fromDay: day - 5, weights: { zswapeth: 0 } }, { fromDay: day + 3, weights: { zswapeth: 5 } }] });
assert.equal(await note.load(), 0, 'a weight of none says nothing, and a weight that starts later is not in force yet'); assert.equal(note.floor(10n ** 18n), '');
clock += 601e3; answer = null;
assert.equal(await note.load(), 0); const seen = calls;
clock += 61e3; answer = program(); assert.equal(await note.load(), 1000, 'an unread answer is asked again in a minute'); assert.equal(calls, seen + 1);
clock += 601e3; answer = new Error('down');
assert.equal(await note.load(), 1000, 'a failed read leaves the last one standing'); clock += 61e3; answer = null; assert.equal(await note.load(), 1000);
clock += 601e3; answer = program({ rates: { zswapeth: 1000, wrap: 1250, evmpooldeposit: 1000 }, weights: [{ fromDay: day - 5, weights: { evmpooldeposit: 0.5 } }] }); await note.load();
assert.equal(note.est(10n ** 18n, 'wrap'), 1250, 'a wrap is priced at its own rate');
assert.equal(note.est(2n * 10n ** 18n, 'evmpooldeposit'), 1000, 'a deposit into an ETH pool at its own, with the day’s weight');
assert.equal(note.est(10n ** 18n), 1000, 'and a swap at zswapeth\'s'); assert.equal(note.est(10n ** 18n, 'cusdmint'), 0, 'an activity it does not read says nothing');
console.log('ok - the points note reads the terms once in ten minutes, never blocks, and says what only the Precision pool earns');
