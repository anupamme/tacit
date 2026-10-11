// The visualizer's planning (dapp/weld/flow/viz.js): what is drawn, and when, from the feed. Real events at their real times, counters
// drawn when they moved, nothing invented, and every mark inside the picture. Offline: node --test tests/flow-viz.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { planReplay, diffFeed, summarize, describe, layout, gated, alpha, REPLAY_SPAN } from '../dapp/weld/flow/viz.js';

const ASOF = 1_791_800_000, WIN = 86400, START = ASOF - WIN;
const pt = (t, o = {}) => ({ t, burns: 40, minted: 30, out: 9, att: 970_800, relay: 970_830, btc: 970_850, ...o });
const feed = (o = {}) => ({
  asOf: ASOF, windowSec: WIN,
  now: { btc: 970_960, relay: 970_930, attested: 970_900, burns: 43, minted: 32, crossOuts: 9, burnDeposits: 1, tacSupply: '1' },
  series: [pt(START - 1800), pt(START + 3600, { burns: 41, btc: 970_856 }), pt(START + 7200, { burns: 41, minted: 31 }), pt(ASOF - 60, { burns: 43, minted: 32, out: 10, btc: 970_960, relay: 970_930, att: 970_900 })],
  events: { attests: [START + 100, START + 40000, ASOF - 100], settles: [START + 200], deposits: [START + 300], tacOut: [START + 43200], tacIn: [] },
  ...o,
});
const kinds = (plan) => plan.reduce((m, e) => ((m[e.kind] = (m[e.kind] || 0) + 1), m), {});

test('a replay places each real event at its real time, scaled onto the span', () => {
  const plan = planReplay(feed());
  const proofs = plan.filter((e) => e.kind === 'proof');
  assert.equal(proofs.length, 3);
  assert.ok(Math.abs(proofs[0].at - (100 / WIN) * REPLAY_SPAN) < 1e-9, 'an event 100 s into the day is 100/86400 of the way along');
  assert.ok(Math.abs(proofs[1].at - REPLAY_SPAN * (40000 / WIN)) < 1e-9);
  assert.ok(proofs[2].at > REPLAY_SPAN - 0.1, 'the newest is at the end');
  const half = plan.find((e) => e.kind === 'out');
  assert.ok(Math.abs(half.at - REPLAY_SPAN / 2) < 1e-9, 'twelve hours in is half way');
});

test('a counter that moved is drawn once for each step it moved, when it moved, and capped', () => {
  const plan = planReplay(feed());
  const k = kinds(plan);
  assert.equal(k.burn, 3, '40 -> 41 (inside the window) and 41 -> 43 are drawn: 1 + 2');
  assert.equal(k.mint, 2, '30 -> 31 -> 32');
  assert.equal(k.cross, 1, '9 -> 10');
  assert.ok(k.block > 0 && k.header > 0, 'blocks and headers beat as the heartbeat');
  const big = feed({ series: [pt(START + 10), pt(START + 20, { burns: 400 })] });
  assert.equal(kinds(planReplay(big)).burn, 10, 'a jump of 360 draws no more than ten marks');
});

test('a change from before the window began is not part of the day', () => {
  const f = feed({ series: [pt(START - 7200), pt(START - 3600, { burns: 99, minted: 99 }), pt(START + 100)] });
  const k = kinds(planReplay(f));
  assert.equal(k.burn || 0, 0); assert.equal(k.mint || 0, 0);
});

test('a counter that is missing or went backwards draws nothing', () => {
  const f = feed({ series: [pt(START + 1), { ...pt(START + 2), burns: null, minted: 5 }, pt(START + 3, { burns: 10, minted: 4 })] });
  const k = kinds(planReplay(f));
  assert.equal(k.burn || 0, 0); assert.equal(k.mint || 0, 0);
});

test('marks come out oldest first and inside the span, with no feed and with an empty one', () => {
  const plan = planReplay(feed());
  assert.deepEqual(plan.map((e) => e.at), [...plan.map((e) => e.at)].sort((a, b) => a - b));
  assert.ok(plan.every((e) => e.at >= 0 && e.at <= REPLAY_SPAN));
  assert.deepEqual(planReplay(null), []);
  assert.deepEqual(planReplay({ asOf: ASOF, windowSec: WIN, now: {}, series: [], events: {} }), []);
});

test('live: only what is new since the last feed is drawn, once', () => {
  const prev = feed();
  const next = feed({
    asOf: ASOF + 15,
    now: { ...prev.now, burns: 45, minted: 33, btc: 970_961 },
    events: { ...prev.events, attests: [...prev.events.attests, ASOF + 5], settles: [...prev.events.settles, ASOF + 2, ASOF + 3] },
  });
  const k = kinds(diffFeed(prev, next));
  assert.equal(k.proof, 1); assert.equal(k.settle, 2); assert.equal(k.burn, 2); assert.equal(k.mint, 1); assert.equal(k.block, 1);
  assert.deepEqual(diffFeed(next, next), [], 'the same feed again draws nothing');
  assert.deepEqual(diffFeed(null, next), [], 'the first feed has no before');
  assert.deepEqual(diffFeed(prev, null), []);
});

test('live: a long gap does not flood the picture', () => {
  const prev = feed({ events: { attests: [], settles: [], deposits: [], tacOut: [], tacIn: [] } });
  const many = Array.from({ length: 200 }, (_, i) => ASOF - 800 + i);
  const next = feed({ asOf: ASOF + 900, events: { attests: many, settles: [], deposits: [], tacOut: [], tacIn: [] }, now: { ...prev.now, burns: 400 } });
  const k = kinds(diffFeed(prev, next));
  assert.ok(k.proof <= 12, `${k.proof} proofs`);
  assert.ok(k.burn <= 10, `${k.burn} burns`);
});

test('the numbers under the picture are the window\'s, and a missing figure is absent, never zero', () => {
  const s = summarize(feed());
  assert.equal(s.proofs, 3); assert.equal(s.settles, 1); assert.equal(s.made_public, 1); assert.equal(s.made_private, 0);
  assert.equal(s.attested, 970_900); assert.equal(s.behind, 60);
  assert.equal(s.burns, 3, 'recorded in the window: 40 -> 43 from the point before it began');
  assert.equal(s.minted, 2);
  const bare = summarize({ asOf: ASOF, windowSec: WIN, now: {}, series: [], events: {} });
  assert.equal(bare.attested, null); assert.equal(bare.behind, null); assert.equal(bare.burns, null); assert.equal(bare.minted, null);
  assert.equal(summarize(null), null);
});

test('the words for a screen reader carry the same numbers and say nothing for what is not known', () => {
  const text = describe(summarize(feed()));
  assert.match(text, /3 proofs of Bitcoin landed on Ethereum/); assert.match(text, /3 bridge burns recorded/); assert.match(text, /1 TAC made public, 0 made private/);
  const bare = describe(summarize({ asOf: ASOF, windowSec: WIN, now: {}, series: [], events: { attests: [] } }));
  assert.ok(!/bridge burns|minted|cross-outs/.test(bare), bare);
  assert.equal(describe(null), 'Bitcoin and Ethereum: reading.');
});

test('every fixed point of the layout is inside the picture at any width, in both sizes', () => {
  for (const compact of [true, false]) for (const w of [280, 360, 520, 760, 1000, 1400]) {
    const h = compact ? 88 : 280, L = layout(w, h, compact);
    for (const [name, p] of Object.entries({ btc: L.btc, eth: L.eth, priv: L.priv, pub: L.pub })) {
      assert.ok(p.x > 0 && p.x < w && p.y > 0 && p.y < h, `${name} ${JSON.stringify(p)} in ${w}x${h}`);
    }
    assert.ok(L.up < L.mid && L.mid < L.dn, 'the lanes are above and below the line'); assert.ok(L.btc.x < L.gateX && L.gateX < L.eth.x); assert.ok(L.btc.x + L.inset < L.gateX && L.gateX < L.eth.x - L.inset, 'the lines start beyond the names and still reach the gate');
    assert.equal(L.priv.x, L.eth.x); assert.equal(L.pub.x, L.eth.x, 'Ethereum is a column, so TAC made public stays off the lanes');
    assert.ok(L.priv.y < L.eth.y && L.eth.y < L.pub.y);
  }
});

test('a burn waits at the gate before it crosses, and never goes backwards', () => {
  assert.equal(gated(0), 0); assert.ok(Math.abs(gated(1) - 1) < 1e-9);
  let prev = -1;
  for (let t = 0; t <= 1; t += 0.01) { const g = gated(t); assert.ok(g >= prev - 1e-9, `t=${t}`); prev = g; }
  const wait = [0.43, 0.45, 0.5].map(gated);
  assert.ok(wait.every((g) => Math.abs(g - 0.5) < 0.01), 'about the gate for the pause');
  assert.ok(gated(0.2) < 0.5 && gated(0.8) > 0.5);
});

test('colours: a hex colour takes an alpha, anything else is left as it is', () => {
  assert.equal(alpha('#f7931a', 0.5), 'rgba(247,147,26,0.5)');
  assert.equal(alpha('#fff', 1), 'rgba(255,255,255,1)');
  assert.equal(alpha('rgba(1,2,3,.4)', 0.2), 'rgba(1,2,3,.4)');
  assert.equal(alpha('#f7931a', 5), 'rgba(247,147,26,1)', 'alpha is held to 0..1');
});
