// The keeper posts a catch-up point when the pool has grown enough, or the newest point is old, and otherwise leaves the
// registry alone; a chain without the registry is skipped; a failed send waits before another try.
// Usage: node tests/evm-pool-keeper-points.test.mjs
import { makePointPoster } from '../src/lib/evm-pool-keeper-points.js';

let failures = 0, passed = 0;
const ok = (c, m, x = '') => { console.log(`${c ? 'ok' : 'not ok'} - ${m}${x ? '  ' + x : ''}`); c ? passed++ : failures++; };

const cfg = { pointsAddress: '0x000000CDfeda8512b8DcD8642765A5Fa43b6Ab4b', pointsEvery: 2000, pointsMaxAgeSecs: 86400, pointsGas: 2500000n };
const tree = (size) => ({ size, toJSON: () => ({ filled: Array.from({ length: 32 }, (_, i) => String(BigInt(size) * 1000n + BigInt(i))) }) });
const synced = (size, block) => ({ confirmed: { tree: tree(size), block } });
function fakeChain({ code = true, latest = 0, postedAt = 0, time = 0, front = true, fail = false } = {}) {
  const sent = [];
  return {
    sent,
    hasCode: async () => code,
    pointLatest: async () => latest,
    pointPostedAt: async () => postedAt,
    blockTime: async () => time,
    canFront: async () => ({ ok: front }),
    send: async (fn, args, opts) => { if (fail) throw new Error('execution reverted: Known()'); sent.push({ fn, args, opts }); return '0xhash' + sent.length; },
  };
}
let t = 1_000_000_000_000;
const now = () => t;

{
  const chain = fakeChain(), p = makePointPoster({ chain, cfg, now });
  ok(await p.maybePost(synced(400, 123)) === '0xhash1', 'the first point is posted whatever the count');
  const s = chain.sent[0];
  ok(s.fn === 'checkpoints.post' && s.args[0] === 400n && s.args[1] === 123n && s.args[2].length === 32 && s.args[2][5] === `0x${(400n * 1000n + 5n).toString(16).padStart(64, '0')}` && s.opts.gas === 2500000n, 'with the count, the block, the edge as 32 words and the gas', [s.args[0], s.args[1], s.args[2][5]].map(String).join(" "));
}
{
  const chain = fakeChain({ latest: 10000, postedAt: 500, time: t / 1000 - 3600 }), p = makePointPoster({ chain, cfg, now });
  ok((await p.maybePost(synced(11000, 900))) === null && !chain.sent.length, 'a pool 1000 leaves past a point an hour old: nothing is posted');
  ok((await p.maybePost(synced(12000, 950))) === '0xhash1', '2000 leaves past it: posted');
  t += 601_000;
  const stale = fakeChain({ latest: 12000, postedAt: 950, time: t / 1000 - 90_000 }), q = makePointPoster({ chain: stale, cfg, now });
  ok((await q.maybePost(synced(12002, 1000))) === '0xhash1', 'one pair past a point a day old: posted');
  ok((await q.maybePost(synced(12004, 1001))) === null && stale.sent.length === 1, 'and not again within ten minutes');
  ok((await makePointPoster({ chain: fakeChain({ latest: 12000 }), cfg, now }).maybePost(synced(12000, 1000))) === null, 'nothing new to post at the same count');
}
{
  const chain = fakeChain({ code: false }), p = makePointPoster({ chain, cfg, now });
  ok((await p.maybePost(synced(400, 123))) === null && !chain.sent.length, 'a chain without the registry is left alone');
  ok((await makePointPoster({ chain: fakeChain(), cfg: { ...cfg, pointsAddress: null }, now }).maybePost(synced(400, 123))) === null, 'and so is one configured off');
  ok((await makePointPoster({ chain: fakeChain({ front: false }), cfg, now }).maybePost(synced(400, 123))) === null, 'a keeper short of ETH posts nothing');
  const failing = fakeChain({ fail: true }), f = makePointPoster({ chain: failing, cfg, now });
  ok((await f.maybePost(synced(400, 123))) === null, 'a post that reverts (someone posted this count first) is logged, not thrown');
  ok((await makePointPoster({ chain: fakeChain(), cfg, now }).maybePost(synced(401, 123))) === null, 'an odd count is never posted');
  ok((await makePointPoster({ chain: fakeChain(), cfg, now }).maybePost({ tree: tree(400) })) === null, 'a sync without the confirmed tree posts nothing');
}
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
