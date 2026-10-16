// The Bitcoin lane's schedule (src/lib/lane-schedule.js): stages run in order and never together, a stage that worked goes again at
// once, a failing stage backs off on its own and the others keep their pace.
// node --test tests/lane-schedule.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLaneSchedule } from '../src/lib/lane-schedule.js';

const clock = (t0 = 1_000_000) => { let t = t0; return { now: () => t, tick: (s) => { t += s * 1000; } }; };

test('stages run in order, one at a time, and a stage that worked runs again next round at once', async () => {
  const c = clock();
  const calls = [];
  let inFlight = 0, overlap = false, ethWork = 2;
  const stage = (name, fn) => ({ name, everySecs: 60, run: async () => { inFlight++; if (inFlight > 1) overlap = true; calls.push(name); await new Promise((r) => setTimeout(r, 2)); inFlight--; return fn(); } });
  const s = makeLaneSchedule([stage('eth-state', () => ethWork-- > 0), stage('reflection', () => false), stage('header', () => false)], { now: c.now, idleSecs: 30 });
  let r = await s.round();
  assert.deepEqual(r.ran, ['eth-state', 'reflection', 'header']);
  assert.equal(r.worked, true); assert.equal(r.sleepSecs, 0);
  r = await s.round();              // no time passed: only the stage that worked is due again
  assert.deepEqual(r.ran, ['eth-state']);
  assert.equal(r.worked, true);
  r = await s.round();              // eth-state found nothing this time
  assert.deepEqual(r.ran, ['eth-state']); assert.equal(r.worked, false); assert.equal(r.sleepSecs, 30);
  r = await s.round();              // nothing due
  assert.deepEqual(r.ran, []);
  c.tick(60);
  r = await s.round();
  assert.deepEqual(r.ran, ['eth-state', 'reflection', 'header']);
  assert.equal(overlap, false, 'two stages ran at once');
});

test('a failing stage backs off by itself; the others keep their pace; a success resets it', async () => {
  const c = clock();
  const seen = [];
  let fails = 3;
  const s = makeLaneSchedule([
    { name: 'eth-state', everySecs: 60, run: async () => false },
    { name: 'reflection', everySecs: 30, run: async () => { if (fails-- > 0) throw new Error('rpc down'); return false; } },
  ], { now: c.now, idleSecs: 30, maxBackoffSecs: 600, log: (m) => seen.push(m) });
  await s.round();                                   // reflection fails once -> next in 60s
  c.tick(30); assert.deepEqual((await s.round()).ran, [], 'backing off, not due at 30s');
  c.tick(30); let r = await s.round(); assert.deepEqual(r.ran, ['eth-state', 'reflection'], 'due at 60s'); // fails again -> 120s
  c.tick(60); r = await s.round(); assert.deepEqual(r.ran, ['eth-state'], 'eth-state keeps its own minute while reflection backs off');
  c.tick(60); r = await s.round(); assert.deepEqual(r.ran, ['eth-state', 'reflection']); // third failure -> 240s
  c.tick(240); r = await s.round(); assert.ok(r.ran.includes('reflection'), 'due after 240s');
  const st = s.state().find((x) => x.name === 'reflection');
  assert.equal(st.failures, 0, 'a success reset the backoff');
  assert.ok(seen.some((m) => /recovered after 3 failure/.test(m)) && seen.some((m) => /next attempt in 240s/.test(m)), seen.join('\n'));
  // the cap
  const capped = makeLaneSchedule([{ name: 'x', everySecs: 300, run: async () => { throw new Error('x'); } }], { now: c.now, maxBackoffSecs: 600, log: (m) => seen.push(m) });
  for (let i = 0; i < 4; i++) { await capped.round(); c.tick(600); }
  assert.ok(seen.some((m) => /x: cycle error.*next attempt in 600s/.test(m)), 'the backoff is capped');
});

test('a stage that found nothing calls its idle hook; one that worked or threw does not', async () => {
  const c = clock();
  const idles = [];
  let work = true, boom = false;
  const s = makeLaneSchedule([{ name: 'r', everySecs: 30, run: async () => { if (boom) throw new Error('x'); return work; }, idle: async () => { idles.push(c.now()); } }], { now: c.now });
  await s.round(); assert.equal(idles.length, 0, 'worked: no idle beat');
  work = false; await s.round(); assert.equal(idles.length, 1, 'found nothing: idle beat');
  boom = true; c.tick(30); await s.round(); assert.equal(idles.length, 1, 'threw: no idle beat');
});
