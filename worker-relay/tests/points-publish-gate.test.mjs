import assert from 'node:assert/strict';
import { mayPublishRoot } from '../src/lib/points-publish-gate.js';

const base = { minIntervalSecs: 1800, settledDay: 20741 };
// the first publish after a start is never held
assert.equal(mayPublishRoot({ ...base, nowSec: 1000, lastPublishSec: 0, publishedThroughDay: -Infinity }), true);
// a newly settled day goes out at once, however recent the last publish
assert.equal(mayPublishRoot({ ...base, nowSec: 1000, lastPublishSec: 990, publishedThroughDay: 20740 }), true);
// a change to an already published history waits out the interval
assert.equal(mayPublishRoot({ ...base, nowSec: 1000, lastPublishSec: 990, publishedThroughDay: 20741 }), false);
assert.equal(mayPublishRoot({ ...base, nowSec: 2789, lastPublishSec: 990, publishedThroughDay: 20741 }), false);
assert.equal(mayPublishRoot({ ...base, nowSec: 2790, lastPublishSec: 990, publishedThroughDay: 20741 }), true);

// The service's cycle (every 15 s): publish when the ledger differs from the published one and the gate allows it. Six credits two
// minutes apart (as the vault tasks were on 2026-10-16) reach the chain as two roots, the last of them carrying every credit.
let version = 0, published = 0, lastPublishSec = -86400, publishedThroughDay = 20741, sent = 0;   // the daily publish was hours ago
for (let t = 1000; t <= 1000 + 3 * 3600; t += 15) {
  if (t >= 1120 && t <= 1120 + 5 * 120 && (t - 1120) % 120 === 0) version += 1;
  if (version !== published && mayPublishRoot({ ...base, nowSec: t, lastPublishSec, publishedThroughDay })) { published = version; lastPublishSec = t; sent += 1; }
}
assert.equal(published, version, 'the final root carries every credit');
assert.equal(sent, 2, 'six credits make two publishes');
console.log('ok - a settled day publishes at once; later changes to published history are held to one root per interval');
