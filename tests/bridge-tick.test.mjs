// dapp/bridge-tick.js, a pass over the bridges under way as any page makes it: what is signed under the key and what is only read again, a
// burn sent only on the holder's plan, a failing Bitcoin step left to rest, and nothing signed for another key.
//   node tests/bridge-tick.test.mjs
import assert from 'node:assert/strict';
import { stepIn, stepOut, advanceOut, outPubs, waitRanOut } from '../dapp/bridge-tick.js';

const PUB = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32);
const withKey = async (fn, pub) => { if (pub !== PUB) throw new Error('other key'); return fn(); };
const priv = () => 'PRIV';

// ── in ──
function inUx(recs, next) {
  const calls = [];
  return {
    calls,
    list: () => recs,
    armMint: async (pub, id, o) => { calls.push(['arm', id, o.walletPriv]); },
    mintRetryDue: (rec, { ranOut }) => rec.due === true || (ranOut && rec.due === 'ranOut'),
    advance: async (pub, id, o) => { calls.push(['advance', id, o?.walletPriv ?? null, o?.maxFeeRate ?? null]); return next(id, o); },
    verify: async (pub, id) => { calls.push(['verify', id]); return recs.find((r) => r.id === id); },
  };
}
{
  const recs = [
    { id: 'done', stage: 'minted' }, { id: 'held', stage: 'stopped' },
    { id: 'wait', stage: 'burn-mined' },
    { id: 'tr', stage: 'traced' },
    { id: 'plan', stage: 'traced' },
    { id: 'ready', stage: 'folded', due: true },
    { id: 'early', stage: 'rfolded', due: false },
    { id: 'arm', stage: 'rburn-mined', path: 'reflected', mint: {}, arm: { tries: 1 } },
  ];
  const ux = inUx(recs, (id) => ({ wait: { id, stage: 'registered' }, plan: { id, stage: 'burn-submitted' }, ready: { id, stage: 'minted' }, arm: { id, stage: 'rburn-mined' } })[id]);
  const told = [];
  const { moved } = await stepIn({ ux, pub: PUB, withKey, priv, planOf: (r) => (r.id === 'plan' ? { burn: { maxRate: 9 } } : null),
    on: { burnSent: (r) => told.push(['burn', r.id]), minted: (r) => told.push(['minted', r.id]), traced: (r) => told.push(['traced', r.id]) } });
  assert.equal(moved, true);
  assert.deepEqual(ux.calls, [
    ['advance', 'wait', null, null],
    ['verify', 'tr'],
    ['advance', 'plan', 'PRIV', 9],
    ['advance', 'ready', 'PRIV', null],
    ['verify', 'early'],
    ['arm', 'arm', 'PRIV'], ['advance', 'arm', null, null],
  ], 'done and held bridges are left alone; a traced bridge burns only on its plan; a ready mint is sent only when due; the rest is read again');
  assert.deepEqual(told, [['burn', 'plan'], ['minted', 'ready']]);
}
{
  const ux = inUx([{ id: 'a', stage: 'burn-mined' }, { id: 'b', stage: 'burn-mined' }], (id) => ({ id, stage: 'burn-mined' }));
  let n = 0;
  const { moved } = await stepIn({ ux, pub: PUB, withKey, priv, alive: () => n++ < 1 });
  assert.equal(moved, false, 'nothing moved: nothing to redraw');
  assert.equal(ux.calls.length, 1, 'the pass stops once the key changes');
}
{
  const ux = inUx([{ id: 'x', stage: 'burn-mined' }], () => { throw new Error('read'); });
  assert.equal((await stepIn({ ux, pub: PUB, withKey, priv })).moved, true, 'a failure is redrawn (its row says so)');
}
assert.equal(waitRanOut(new Error('settle timed out after 900s')), true); assert.equal(waitRanOut(new Error('relay 429')), false);

// ── out ──
function outUx(steps) {
  const calls = [];
  return {
    calls,
    advance: async (pub, id, o) => { calls.push(['advance', pub.slice(0, 2), id, o?.walletPriv ?? null, o?.allowHighFee ?? null]); const s = steps[id]; return typeof s === 'function' ? s() : s.shift(); },
    recoverFromEthTx: async (h, p, o) => { calls.push(['recover', h, p, String(o.amount)]); return { id: 'unv', stage: 'settled', settle: { claimIdVerified: true }, source: { amount: '5' } }; },
  };
}
{
  const ux = outUx({ c: [{ id: 'c', stage: 'covered' }, { id: 'c', stage: 'mint-signed' }, { id: 'c', stage: 'mint-submitted' }] });
  const after = await advanceOut(ux, PUB, { id: 'c', stage: 'settled' }, { withKey, priv, keyPub: () => PUB });
  assert.equal(after.stage, 'mint-submitted');
  assert.deepEqual(ux.calls.map((c) => c[3]), [null, 'PRIV', null], 'only the Bitcoin step (from covered) is signed');
  const u2 = outUx({ c: [{ id: 'c', stage: 'covered' }] });
  assert.equal((await advanceOut(u2, OTHER, { id: 'c', stage: 'settled' }, { withKey, priv, keyPub: () => PUB })).stage, 'covered', 'another key\'s bridge stops before its Bitcoin step');
}
{
  const now = Date.now();
  const recs = {
    [PUB]: [
      { id: 'unv', stage: 'settled', settle: { claimIdVerified: false, txHash: 'ab' }, source: { amount: '5' } },
      { id: 'rest', stage: 'covered', lastError: { at: now - 60e3 }, errorCount: 1 },
      { id: 'tired', stage: 'mint-signed', lastError: { at: now - 3600e3 }, errorCount: 6 },
      { id: 'fund', stage: 'covered', lastError: { at: now - 3 * 60e3, fundWait: true }, errorCount: 9 },
      { id: 'fund2', stage: 'covered', lastError: { at: now - 11 * 60e3 }, errorCount: 1 },
      { id: 'go', stage: 'mint-confirmed' },
    ],
    [OTHER]: [{ id: 'theirs', stage: 'mint-confirmed' }],
  };
  const ux = outUx({ unv: () => ({ id: 'unv', stage: 'settled' }), fund: () => { throw Object.assign(new Error('fund'), { fundWait: true, needSats: 900 }); }, fund2: () => { throw Object.assign(new Error('fund'), { fundWait: true, needSats: 900 }); }, go: () => ({ id: 'go', stage: 'minted' }), theirs: () => ({ id: 'theirs', stage: 'minted' }) });
  const told = [], rechecked = {};
  const moved = await stepOut({ ux, pubs: [PUB, OTHER], records: (p) => recs[p], keyPub: () => PUB, withKey, priv, rechecked, on: { arrived: (r) => told.push(['arrived', r.id]), fundWait: (r) => told.push(['fund', r.id]) } });
  assert.deepEqual(ux.calls.map((c) => c[0] === 'recover' ? `recover:${c[1]}:${c[3]}` : `adv:${c[2]}`), ['recover:0xab:5', 'adv:unv', 'adv:fund', 'adv:fund2', 'adv:go', 'adv:theirs'],
    'an unmatched claim is rebuilt from its transaction; a step that failed a minute ago, or six times, rests; one waiting for bitcoin is tried after two minutes');
  assert.ok(rechecked.unv > 0);
  assert.deepEqual(moved.map((r) => r.id), ['unv', 'fund', 'fund2', 'go', 'theirs']);
  assert.deepEqual(told, [['fund', 'fund2'], ['arrived', 'go']], 'arrivals are told for the open key only; a wait for bitcoin is told when it is new, not again');
}
{
  const m = new Map([['tacit-crossout-bridge-v1:mainnet:' + PUB, '[]'], ['tacit-crossout-bridge-v1:mainnet:xyz', '[]'], ['other', '']]);
  const st = { length: m.size, key: (i) => [...m.keys()][i] };
  assert.deepEqual(outPubs(st), [PUB], 'keys are read from the journals\' names, and only well-formed ones');
}
console.log('bridge-tick: all checks passed');
