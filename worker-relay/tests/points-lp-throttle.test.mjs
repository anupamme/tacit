// The client the verifier uses on a public endpoint (lib/points-lp-record.js throttledClient): requests one at a time, a pause apart, asked again with
// growing pauses when the endpoint says it is rate limited, and any other error passed on at once.
//   node worker-relay/tests/points-lp-throttle.test.mjs
import assert from 'node:assert/strict';
import { throttledClient } from '../src/lib/points-lp-record.js';

const pauses = [];
const sleep = async (ms) => { pauses.push(ms); };
const limited = () => Object.assign(new Error('RPC Request failed.'), { shortMessage: 'RPC Request failed.', details: 'You reached Public endpoint rate limit, please upgrade to paid plan' });

{ // a rate-limited request is asked again after 1 s, 2 s, then answers
  let calls = 0; pauses.length = 0;
  const c = throttledClient({ readContract: async () => { if (++calls <= 2) throw limited(); return 42n; } }, { gapMs: 5, sleep });
  assert.equal(await c.readContract({}), 42n);
  assert.equal(calls, 3); assert.deepEqual(pauses, [1000, 2000, 5], 'two growing pauses, then the gap after the answer');
}
{ // another error is passed on at once: a log range that is too wide must reach the caller, which asks for less
  let calls = 0; pauses.length = 0;
  const c = throttledClient({ getLogs: async () => { calls++; throw Object.assign(new Error('ranges over 10000 blocks are not supported on free plan'), { details: 'ranges over 10000 blocks are not supported on free plan' }); } }, { gapMs: 5, sleep });
  await assert.rejects(c.getLogs({}), /not supported on free plan/);
  assert.equal(calls, 1); assert.deepEqual(pauses, []);
}
{ // an endpoint that never stops refusing is given up on after `tries`, with the last error
  let calls = 0; pauses.length = 0;
  const c = throttledClient({ getBlock: async () => { calls++; throw limited(); } }, { gapMs: 5, tries: 3, sleep });
  await assert.rejects(c.getBlock({}), /RPC Request failed/);
  assert.equal(calls, 3); assert.deepEqual(pauses, [1000, 2000]);
}
{ // a refusal by status code counts too, and the pause never passes 30 s
  let calls = 0; pauses.length = 0;
  const c = throttledClient({ getCode: async () => { if (++calls <= 7) throw Object.assign(new Error('HTTP request failed.'), { status: 429 }); return '0x6001'; } }, { gapMs: 0, tries: 9, sleep });
  assert.equal(await c.getCode({}), '0x6001');
  assert.deepEqual(pauses.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
}
{ // requests are made one at a time, in the order asked, even when asked together
  const order = []; let inFlight = 0, most = 0; pauses.length = 0;
  const slow = (tag) => async () => { inFlight++; most = Math.max(most, inFlight); order.push(tag); await new Promise((r) => setTimeout(r, 5)); inFlight--; return tag; };
  const c = throttledClient({ readContract: ({ tag }) => slow(tag)(), getBlock: ({ tag }) => slow(tag)(), getCode: ({ tag }) => slow(tag)(), getLogs: ({ tag }) => slow(tag)() }, { gapMs: 0, sleep });
  const out = await Promise.all([c.readContract({ tag: 'a' }), c.getBlock({ tag: 'b' }), c.getCode({ tag: 'c' }), c.getLogs({ tag: 'd' }), c.readContract({ tag: 'e' })]);
  assert.deepEqual(out, ['a', 'b', 'c', 'd', 'e']); assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e']); assert.equal(most, 1, 'never two at once');
  // a failure does not stop the ones queued behind it
  const bad = throttledClient({ readContract: async ({ n }) => { if (n === 1) throw new Error('reverted'); return n; } }, { gapMs: 0, sleep });
  const r = await Promise.allSettled([bad.readContract({ n: 0 }), bad.readContract({ n: 1 }), bad.readContract({ n: 2 })]);
  assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'rejected', 'fulfilled']);
}
console.log('ok - the verifier asks a public endpoint one thing at a time and asks again when it says to wait');
