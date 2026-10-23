// The Bitcoin block fetchers fail at once when every explorer is cooling (a request someone waits on should not hang), but a caller that
// asks to (`waitCoolingMs`: the reflection job, whose minutes of fetches one refused call would throw away) sleeps through a short
// cooldown and goes on. Offline: node tests/upstream-cooling-wait.test.mjs
let mode = 'throttle';   // throttle: 429 with Retry-After; ok: 200
let retryAfter = '2';
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (mode === 'throttle') return new Response('slow down', { status: 429, headers: { 'retry-after': retryAfter } });
  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
};
const { apiText, apiRawBytes } = await import('../worker/src/index.js');

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };
const timed = async (fn) => { const t0 = Date.now(); try { return { value: await fn(), ms: Date.now() - t0 }; } catch (e) { return { error: String(e?.message || e), ms: Date.now() - t0 }; } };

// signet, JSON/text path: one round of 429s puts every source on a two-second cooldown.
const sig = { SIGNET_API: 'https://a.signet.test/api,https://b.signet.test/api' };
let r = await timed(() => apiText(sig, '/x', {}, 'signet'));
ok('every source refusing fails the call', !!r.error, JSON.stringify(r));
r = await timed(() => apiText(sig, '/x', {}, 'signet'));
ok('with every source cooling, a plain call fails at once', /all sources cooling/.test(r.error || '') && r.ms < 500, JSON.stringify(r));
mode = 'ok';
r = await timed(() => apiText(sig, '/x', { waitCoolingMs: 10_000 }, 'signet'));
ok('a call that allows the wait sleeps through the cooldown and is answered', r.value !== undefined && !r.error && r.ms >= 400, JSON.stringify(r));

// mainnet, raw path: the same, and a cooldown longer than the allowance is not waited for.
mode = 'throttle'; retryAfter = '2';
const main = { MAINNET_API: 'https://a.main.test/api,https://b.main.test/api' };
r = await timed(() => apiRawBytes(main, '/block/00/raw', 'mainnet'));
ok('raw: every source refusing fails the call', !!r.error, JSON.stringify(r));
r = await timed(() => apiRawBytes(main, '/block/00/raw', 'mainnet'));
ok('raw: with every source cooling, a plain call fails at once', /all sources cooling/.test(r.error || '') && r.ms < 500, JSON.stringify(r));
mode = 'ok';
r = await timed(() => apiRawBytes(main, '/block/00/raw', 'mainnet', { waitCoolingMs: 10_000 }));
ok('raw: a call that allows the wait is answered with the block', r.value instanceof Uint8Array && r.value.length === 3 && r.ms >= 400, JSON.stringify(r));

mode = 'throttle'; retryAfter = '30';
await timed(() => apiText(sig, '/y', {}, 'signet'));   // the sources of the first set are cooling again, for half a minute
r = await timed(() => apiText(sig, '/y', { waitCoolingMs: 1000 }, 'signet'));
ok('a cooldown longer than the allowance is not waited for', /all sources cooling/.test(r.error || '') && r.ms < 500, JSON.stringify(r));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
