// The keeper posts a catch-up point when the pool has grown enough, or the newest point is old, and otherwise leaves the
// registry alone; a chain without the registry is skipped; a failed send waits before another try.
// Usage: node tests/evm-pool-keeper-points.test.mjs
import { makePointPoster } from '../src/lib/evm-pool-keeper-points.js';

let failures = 0, passed = 0;
const ok = (c, m, x = '') => { console.log(`${c ? 'ok' : 'not ok'} - ${m}${x ? '  ' + x : ''}`); c ? passed++ : failures++; };

const cfg = { pointsAddress: '0x00000000C3267616ED5E0DAA6F6490D109d6844D', pointsEvery: 2000, pointsMaxAgeSecs: 86400, pointsGas: 2500000n };
const tree = (size) => ({ size, toJSON: () => ({ filled: Array.from({ length: 32 }, (_, i) => String(BigInt(size) * 1000n + BigInt(i))) }) });
const synced = (size, block) => ({ confirmed: { tree: tree(size), block } });
function fakeChain({ code = true, latest = 0, postedAt = 0, front = true, rich = true, fail = false } = {}) {
  const sent = [];
  return {
    sent,
    hasCode: async () => code,
    pointLatest: async () => latest,
    pointPostedAt: async () => postedAt,
    canFront: async () => ({ ok: front, balance: rich ? 10n ** 18n : 10n, need: 10n ** 15n }),
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
  const chain = fakeChain({ latest: 10000, postedAt: t / 1000 - 3600 }), p = makePointPoster({ chain, cfg, now });
  ok((await p.maybePost(synced(11000, 900))) === null && !chain.sent.length, 'a pool 1000 leaves past a point an hour old: nothing is posted');
  ok((await p.maybePost(synced(12000, 950))) === '0xhash1', '2000 leaves past it: posted');
  t += 601_000;
  const stale = fakeChain({ latest: 12000, postedAt: t / 1000 - 90_000 }), q = makePointPoster({ chain: stale, cfg, now });
  ok((await q.maybePost(synced(12002, 1000))) === null && !stale.sent.length, 'one pair past a point a day old is not worth a post');
  ok((await q.maybePost(synced(12200, 1000))) === '0xhash1', 'two hundred leaves past a point a day old: posted');
  ok((await q.maybePost(synced(12400, 1001))) === null && stale.sent.length === 1, 'and not again within ten minutes');
  ok((await makePointPoster({ chain: fakeChain({ latest: 12000 }), cfg, now }).maybePost(synced(12000, 1000))) === null, 'nothing new to post at the same count');
}
{
  const chain = fakeChain({ code: false }), p = makePointPoster({ chain, cfg, now });
  ok((await p.maybePost(synced(400, 123))) === null && !chain.sent.length, 'a chain without the registry is left alone');
  ok((await makePointPoster({ chain: fakeChain(), cfg: { ...cfg, pointsAddress: null }, now }).maybePost(synced(400, 123))) === null, 'and so is one configured off');
  ok((await makePointPoster({ chain: fakeChain({ front: false }), cfg, now }).maybePost(synced(400, 123))) === null, 'a keeper short of ETH posts nothing');
  const logs = [], poor = makePointPoster({ chain: fakeChain({ rich: false }), cfg, now, log: (m) => logs.push(m) });
  ok((await poor.maybePost(synced(400, 123))) === null && /holds 10 wei/.test(logs.join()), 'and one that could afford a post but not with room to spare posts nothing, and says why', logs.join());
  // A keeper that started before the registry was deployed looks again, not never.
  let has = false, asked = 0;
  const late = fakeChain(); late.hasCode = async () => { asked++; return has; };
  let clock = t; const lp = makePointPoster({ chain: late, cfg, now: () => clock });
  ok((await lp.maybePost(synced(400, 123))) === null && asked === 1, 'before the registry has code, nothing is posted');
  clock += 10 * 60_000; has = true;
  ok((await lp.maybePost(synced(400, 123))) === null && asked === 1, 'it is not asked again within half an hour');
  clock += 31 * 60_000;
  ok((await lp.maybePost(synced(400, 123))) === '0xhash1' && asked === 2, 'and once it has code, the next look finds it and posts');
  // What is posted is the tree as it was when the sync returned, not as it is by the time the chain has been asked.
  let live = 400; const moving = { get size() { return live; }, toJSON: () => ({ filled: Array.from({ length: 32 }, (_, i) => String(BigInt(live) * 1000n + BigInt(i))) }) };
  const slow = fakeChain(); slow.pointLatest = async () => { live = 600; return 0; };
  const sp = makePointPoster({ chain: slow, cfg, now });
  await sp.maybePost({ confirmed: { tree: moving, block: 123 } });
  const sent = slow.sent[0]?.args;
  ok(sent && sent[0] === 400n && sent[2][0] === `0x${(400n * 1000n).toString(16).padStart(64, '0')}`, 'a tree that grows while the chain is asked still posts one moment’s size and edge together', sent && `${sent[0]} ${sent[2][0].slice(-8)}`);
  const failing = fakeChain({ fail: true }), f = makePointPoster({ chain: failing, cfg, now });
  ok((await f.maybePost(synced(400, 123))) === null, 'a post that reverts (someone posted this count first) is logged, not thrown');
  ok((await makePointPoster({ chain: fakeChain(), cfg, now }).maybePost(synced(401, 123))) === null, 'an odd count is never posted');
  ok((await makePointPoster({ chain: fakeChain(), cfg, now }).maybePost({ tree: tree(400) })) === null, 'a sync without the confirmed tree posts nothing');
}
{
  // The registry keeps one pool's points: a keeper for another pool on the chain (the TAC pool) posts nothing to it, and looks no more.
  const ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', TAC_POOL = '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe';
  let asked = 0;
  const other = { ...fakeChain(), pool: TAC_POOL, pointPool: async () => { asked++; return ETH_POOL; } }, logs = [];
  let clock = t; const op = makePointPoster({ chain: other, cfg, now: () => clock, log: (m) => logs.push(m) });
  ok((await op.maybePost(synced(400, 123))) === null && !other.sent.length && /keeps pool 0x000000c2/.test(logs.join()), 'a keeper for another pool posts nothing to the registry, and says why', logs.join());
  clock += 2 * 3600_000;
  ok((await op.maybePost(synced(4000, 999))) === null && asked === 1 && !other.sent.length, 'and does not ask again');
  const own = { ...fakeChain(), pool: ETH_POOL, pointPool: async () => ETH_POOL.toLowerCase() };
  ok((await makePointPoster({ chain: own, cfg, now }).maybePost(synced(400, 123))) === '0xhash1', "the registry's own pool's keeper still posts");
  const blind = { ...fakeChain(), pool: ETH_POOL, pointPool: async () => { throw new Error('node down'); } };
  ok((await makePointPoster({ chain: blind, cfg, now }).maybePost(synced(400, 123))) === null && !blind.sent.length, "a registry whose pool cannot be read is not posted to");
}
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
