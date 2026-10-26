// The services log through a `log` function of their own. A loop, callback or parameter that is also called `log` (a receipt's logs are the
// usual case) hides it for the rest of that block, and the first `log(...)` there fails with "log is not a function": in the points service a
// V4 swap whose explorer lookup never resolved did exactly that, so every cycle of the chain's zRouter scan failed before saving its cursor and
// the same chunk was retried for a day (found 2026-10-26, fixed with this test).
//   node worker-relay/tests/no-logger-shadow.test.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : []; });

// The places in `text` that name something else `log`: a second declaration (a `for (const log of receipt.logs)` loop is one) or an array
// callback's parameter (`receipt.logs.find((log) => …)`). A logger handed in as a function's own parameter (`{ log = () => {} }`) is the logger
// itself and is fine.
export function shadows(text) {
  const out = [];
  let loggerSeen = false;
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');          // not comments, not strings
    if (/^\s*(const|let|var)\s+log\s*=\s*(\(|function|async)/.test(code) && !loggerSeen) { loggerSeen = true; return; }
    const hit = /\b(const|let|var)\s+log\b/.test(code) || /\.(find|findLast|findIndex|filter|map|flatMap|some|every|forEach|reduce)\(\s*(async\s*)?\(?\s*log\b/.test(code);
    if (hit) out.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return out;
}

// the checker itself: it sees what it should
assert.deepEqual(shadows('const log = (...a) => console.log(...a);\nfor (const x of y) log(x);'), []);
assert.equal(shadows('const log = (...a) => 1;\nfor (const log of receipt.logs) { log.data; }').length, 1, 'a loop variable');
assert.equal(shadows('const log = (...a) => 1;\nconst hit = receipt.logs.find((log) => log.topics[0]);').length, 1, 'a callback parameter');
assert.equal(shadows('const log = (...a) => 1;\nreceipt.logs.map(log => log.data);').length, 1, 'a bare arrow parameter');
assert.deepEqual(shadows('const log = (...a) => 1;\nexport function createIndexer({ store, log = () => {} }) { log(1); }'), [], 'a logger handed in as a parameter');
assert.deepEqual(shadows('const log = (...a) => 1;\n// for (const log of logs) is what not to do\nlog("a for (const log of logs) in a string");'), [], 'not comments or strings');
assert.deepEqual(shadows('  const log = (...a) => console.log(a);  // inside a function: the one logger of the file'), []);
assert.deepEqual(shadows('const log = (...a) => 1;\nexport function make({ cfg, fetchImpl = fetch, logger = log }) {}'), [], 'the logger as a default value');

for (const f of files(SRC)) {
  const found = shadows(readFileSync(f, 'utf8'));
  assert.deepEqual(found, [], `${f.slice(SRC.length + 1)} hides its logger: ${found.join(' | ')}`);
}
console.log('ok - nothing in worker-relay/src hides its log function');
