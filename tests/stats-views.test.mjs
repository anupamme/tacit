// worker/src/stats-views.js: the tETH page's slim reading is the whole reading's `eth` object and nothing else of its weight.
import assert from 'node:assert/strict';
import { ethStatsBody } from '../worker/src/stats-views.js';

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok  ', m); };

const whole = { at: 1760000000, block: 23600000, eth: { held: { $n: '10090000000000000000' }, deposits: 238, wallets: 65, series: { flows: [[1, { $n: '5' }], [2, { $n: '-3' }]], ins: [[2, 9]] } },
  dev: [{ series: { ins: new Array(500).fill([1, 2, 3]) } }], link: { times: { a: [1] } }, tac: {}, btc: {}, pts: {} };
const slim = JSON.parse(ethStatsBody(JSON.stringify(whole)));
ok(JSON.stringify(slim.eth) === JSON.stringify(whole.eth), 'the pool\'s reading is carried whole: totals, flows and latest deposits');
ok(slim.at === whole.at && slim.block === whole.block, 'with the time and block of the reading');
ok(Object.keys(slim).sort().join() === 'at,block,eth', 'and nothing else');
ok(ethStatsBody(JSON.stringify(whole)).length < JSON.stringify(whole).length / 4, 'it is a fraction of the whole reading');
ok(JSON.parse(ethStatsBody('{"at":5}')).eth === null, 'a reading with no pool part gives null, not a missing key the page would misread');
assert.throws(() => ethStatsBody('not json'), 'a body that is not JSON throws (the handler then serves the whole reading)'); n++; console.log('  ok   a body that is not JSON throws, so the handler falls back to the whole reading');
console.log(`${n} stats-views checks passed`);
