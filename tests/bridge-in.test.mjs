// dapp/bridge-in.js, what starting a bridge from Bitcoin is made of wherever it is started: the words for a check that failed, the notes that
// can go and why the others cannot, the cost against the coins a key has free, the one transaction (or the move) that starts it, and the send
// to one's own address that an older note needs first.
//   node tests/bridge-in.test.mjs
import assert from 'node:assert/strict';
import { TAC_BTC_ID, noteId, bridgeError, checkText, needsSend, firstStep, overCap, marked, longReason, listNotes, review, checkNote, priceNote, planSet, burnMaxRate, PLAN_KEY, begin, toSelf } from '../dapp/bridge-in.js';

const say = (e) => `said: ${e?.message || e}`;

// a failure is put in the page's words, with the bridge's own about funds held for other bridges
assert.match(bridgeError(new Error('burndep-ux: held for your other bridges'), say), /free bitcoin is held for your other bridges’ burns/);
assert.match(bridgeError(new Error('no safe funding utxo'), say), /has no free bitcoin to pay this step’s fee/);
assert.match(bridgeError(new Error('this bridge is leased by another tab'), say), /being moved on in another tab/);
assert.equal(bridgeError(new Error('burndep-ux: over the beta cap'), say), 'said: Over the beta cap', 'the engine’s prefix goes, the first letter is a capital');
assert.equal(bridgeError(new Error('plain'), say), 'said: plain');

// the words for the step of a check that failed
const T = (s) => checkText(s, say);
assert.match(T({ name: 'not-tracked' }), /arrived recently/);
assert.match(T({ name: 'reflected' }), /One Bitcoin transaction sends it to your own address/);
assert.match(T({ name: 'old-leaf' }), /older note form/);
assert.match(T({ name: 'source-confirmed' }), /waiting for its Bitcoin confirmation/);
assert.match(T({ name: 'trace', tooLong: true, hops: 2500, atLeast: true, max: 1000 }), /more than 2,500 transfers in its history, and the bridge proves up to 1000/);
assert.match(T({ name: 'trace', tooLong: true, max: 1000 }), /far more than 1,000 transfers/);
assert.match(T({ name: 'trace', unprovable: true, through: 'pool' }), /includes a pool or farm trade on Bitcoin, which the bridge’s proof does not follow, so this note stays/);
assert.match(T({ name: 'trace', unprovable: true, through: 'other', at: 'ab'.repeat(32) }), /includes a transaction the bridge’s proof does not follow \(abababab…ababab\)/);
assert.match(T({ name: 'trace', reading: true, read: 1234 }), /1,234 transfers so far/);
assert.match(T({ name: 'trace', detail: 'busy, retry in ~40s' }), /Pick it again in about 40 seconds/);
assert.match(T({ name: 'trace', detail: 'boom' }), /could not be read from Bitcoin just now \(said: boom\)/);
assert.match(T({ name: 'cap', detail: 'x' }), /^Could not check this TAC: said: x$/);

// the notes: which need a send first, which are over the limit, which a check or an empty amount takes off the list
assert.ok(needsSend({ form: 'old' }) && needsSend({ form: 'private' }) && !needsSend({ form: 'tacit' }) && !needsSend({}));
assert.match(firstStep({ form: 'old' }), /^Older note form/); assert.match(firstStep({ form: 'private' }), /^Received privately/); assert.equal(firstStep({ form: 'tacit' }), '');
assert.ok(overCap({ eligible: false, reason: 'over the 1,000 TAC beta limit — send part' }) && !overCap({ eligible: true, reason: null }) && !overCap({ eligible: false, reason: 'unconfirmed' }));
const n1 = { txid: 'aa', vout: 0, amount: '500', eligible: true };
assert.equal(noteId(n1), 'aa:0');
assert.equal(marked(n1, new Map()), n1);
const deep = new Map([['aa:0', { tooLong: true, hops: 5000, max: 1000 }]]);
assert.equal(marked(n1, deep).eligible, false);
assert.equal(marked(n1, deep).reason, '5,000 transfers in its history; the bridge proves up to 1000.');
assert.equal(marked({ ...n1, amount: '0' }, new Map()).reason, 'Holds no TAC');
assert.equal(marked({ ...n1, eligible: false, reason: 'unconfirmed' }, new Map([['aa:0', { tooLong: true }]])).reason, 'unconfirmed', 'a note already off the list keeps its own reason');
assert.match(longReason({ unprovable: true, through: 'shielded' }), /^Its history includes a move through Bitcoin’s shielded pool, which the bridge does not follow\.$/);

// the listing: the key's TAC with each note's form, tracking and eligibility, the eligible first and the larger first among them
{
  const utxo = (txid, vout, amount, extra = {}) => ({ utxo: { txid, vout, value: 546, status: extra.confirmed === false ? {} : { confirmed: true, block_height: 900000 } }, amount, blinding: 'bb' });
  const holdings = new Map([[TAC_BTC_ID, { assetIdHex: TAC_BTC_ID, utxos: [utxo('a1', 0, 100n), utxo('b2', 1, 900n), utxo('c3', 0, 500n, { confirmed: false }), utxo('d4', 0, 700n)] }], ['other', { utxos: [utxo('e5', 0, 1n)] }]]);
  const asked = [];
  const t = { scanHoldings: async (force) => { asked.push(force); return holdings; },
    bridgeUx: () => ({
      noteForms: async (ns) => new Map(ns.map((n) => [noteId(n), n.txid === 'a1' ? 'old' : 'tacit'])),
      noteTracking: async (ns) => new Map(ns.map((n) => [noteId(n), 'tracked'])),
      eligibleNotes: (ns) => ns.map((n) => ({ ...n, eligible: n.confirmed && n.txid !== 'd4', reason: !n.confirmed ? 'unconfirmed' : n.txid === 'd4' ? 'already bridging' : null })),
    }) };
  const seen = [];
  const notes = await listNotes(t, { force: true, esplora: async (p) => { seen.push(p); return { confirmed: false }; } });
  assert.deepEqual(asked, [true]);
  assert.deepEqual(notes.map(noteId), ['b2:1', 'a1:0', 'd4:0', 'c3:0'], 'eligible first, the larger first among each');
  assert.deepEqual(seen, ['/tx/c3/status'], 'only a note not yet known confirmed is asked of the explorer');
  assert.equal(notes.find((n) => n.txid === 'a1').form, 'old'); assert.equal(notes.find((n) => n.txid === 'a1').tracking, 'tracked');
  assert.equal((await listNotes({ ...t, scanHoldings: async () => new Map() }, { esplora: async () => null })).length, 0, 'no TAC, no notes');
  // forms or tracking that cannot be read leave the notes as they are
  const bare = await listNotes({ ...t, bridgeUx: () => ({ noteForms: async () => { throw new Error('x'); }, noteTracking: async () => { throw new Error('y'); }, eligibleNotes: (ns) => ns.map((n) => ({ ...n, eligible: true })) }) }, { esplora: async () => ({ confirmed: true }) });
  assert.ok(bare.every((n) => n.form === undefined && n.tracking === undefined));
}

// the cost: a check that fails is returned as it is, one that passes is priced against the coins free for fees
{
  const note = { txid: 'a1', vout: 0, sats: 546, amount: '100' };
  const ux = (pf) => ({ preflight: async ({ onProgress }) => { onProgress?.(7); return pf; }, bridgeCost: ({ path, coins }) => ({ fee: 700, need: 900, ok: coins.some((c) => c.value >= 900), have: coins[0]?.value || 0, path }) });
  const bad = await review({ bridgeUx: () => ux({ ok: false, steps: [{ name: 'reflected', ok: false }] }) }, { note, walletPub: new Uint8Array(33) });
  assert.equal(bad.ok, false); assert.equal(bad.pf.steps[0].name, 'reflected');
  const progress = [];
  const t = (pf, coins) => ({ bridgeUx: () => ux(pf), pickSafeCommitSats: async (u) => u, getUtxos: async () => coins, wallet: { address: () => 'bc1q' } });
  const good = await review(t({ ok: true, path: 'reflected', burnFeeRate: 5 }, [{ value: 5000 }]), { note, walletPub: new Uint8Array(33), onProgress: (n) => progress.push(n) });
  assert.deepEqual([good.ok, good.one, good.short, good.cost.path], [true, true, false, 'reflected']); assert.deepEqual(progress, [7]);
  const poor = await review(t({ ok: true, path: 'migrate', migrateFeeRate: 5 }, [{ value: 100 }]), { note, walletPub: new Uint8Array(33) });
  assert.deepEqual([poor.one, poor.short], [false, true], 'coins read and short of the need');
  const unread = await review({ ...t({ ok: true, path: 'reflected', burnFeeRate: 5 }, []), getUtxos: async () => { throw new Error('down'); } }, { note, walletPub: new Uint8Array(33) });
  assert.equal(unread.short, false, 'coins that could not be read are not called short');
  const given = await review(t({ ok: true, path: 'reflected', burnFeeRate: 5 }, []), { note, walletPub: new Uint8Array(33), coins: [{ value: 9000 }] });
  assert.equal(given.short, false, 'coins read already are used as they are');
}

// the check and the price are two steps: the check can take minutes, the coins are read after it each time
{
  const note = { txid: 'a1', vout: 0, sats: 546, amount: '100' };
  const ux = { preflight: async ({ onProgress }) => { onProgress?.(3); return { ok: true, path: 'reflected', burnFeeRate: 5 }; },
    bridgeCost: ({ coins }) => ({ fee: 700, need: 900, ok: coins.some((c) => c.value >= 900), have: coins[0]?.value || 0 }) };
  const t = { bridgeUx: () => ux };
  const seen = [], c = await checkNote(t, { note, walletPub: new Uint8Array(33), onProgress: (n) => seen.push(n) });
  assert.deepEqual([c.ok, c.pf.path, seen], [true, 'reflected', [3]]);
  assert.equal(priceNote(t, { note, pf: c.pf, coins: [{ value: 100 }] }).short, true, 'coins read and short');
  assert.equal(priceNote(t, { note, pf: c.pf, coins: [{ value: 5000 }] }).short, false);
  assert.equal(priceNote(t, { note, pf: c.pf, coins: null }).short, false, 'coins not read are not called short');
  assert.equal((await checkNote({ bridgeUx: () => ({ preflight: async () => ({ ok: false, steps: [] }) }) }, { note, walletPub: new Uint8Array(33) })).ok, false);
}
// the plans kept beside the journal, newest fifty per key, and the rate a move's burn may go out at on its own
{
  const m = new Map(), mem = { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))) };
  planSet(mem, 'pubA', 'id1', { at: 2, burn: { maxRate: 20 } }); planSet(mem, 'pubA', 'id2', { at: 3 }); planSet(mem, 'pubB', 'idx', { at: 1 });
  assert.deepEqual(Object.keys(m.get(PLAN_KEY).pubA), ['id2', 'id1'], 'newest first'); assert.deepEqual(m.get(PLAN_KEY).pubB, { idx: { at: 1 } });
  planSet(mem, 'pubA', 'id1', null); assert.deepEqual(Object.keys(m.get(PLAN_KEY).pubA), ['id2'], 'a plan is dropped by naming none');
  for (let i = 0; i < 60; i++) planSet(mem, 'pubC', `n${i}`, { at: 100 + i });
  assert.equal(Object.keys(m.get(PLAN_KEY).pubC).length, 50); assert.ok(m.get(PLAN_KEY).pubC.n59 && !m.get(PLAN_KEY).pubC.n0);
  assert.equal(burnMaxRate({}), 20, 'no miner rates read: twice the 10 floor');
  assert.equal(burnMaxRate({ slipstreamRates: { effective_rate: 12, submit_fee_rate: 9 } }), 27, 'twice a tenth over the miner’s rate');
  assert.equal(burnMaxRate({ slipstreamRates: { effective_rate: 1, submit_fee_rate: 1 } }), 10, 'never under 10');
}
// starting: one transaction for a tracked note (and the relay asked to finish the mint), a move for the rest, a fee paid from a coin that is free
{
  const calls = [];
  const rec = { id: 'br1', walletPub: 'wp' };
  const ux = (over = {}) => ({
    startReflected: async (o) => { calls.push(['startReflected', o]); return rec; },
    start: async (o) => { calls.push(['start', o]); return rec; },
    advance: async (pub, id) => { calls.push(['advance', pub, id]); return { ...rec, stage: 'burn-submitted' }; },
    armMint: async (pub, id, o) => { calls.push(['armMint', pub, id, o]); },
    list: () => [{ ...rec, stage: 'burn-signed' }],
    pickFunding: (coins, need) => { calls.push(['pick', need]); return coins.find((c) => c.value >= need) || null; },
    ...over,
  });
  const t = (u) => ({ bridgeUx: () => u, pickSafeCommitSats: async (c) => c, getUtxos: async () => [{ txid: 'f', vout: 1, value: 5000 }], wallet: { address: () => 'bc1q' } });
  const note = { txid: 'a1', vout: 0, sats: 546, amount: '100' };
  const one = await begin(t(ux()), { review: { note, pf: { path: 'reflected', burnFeeRate: 6 }, cost: { need: 800 } }, priv: 'PRIV', recipient: 'RCPT' });
  assert.equal(one.stage, 'burn-submitted');
  assert.deepEqual(calls.map((c) => c[0]), ['startReflected', 'advance', 'armMint']);
  assert.deepEqual(calls[0][1], { note, walletPriv: 'PRIV', feeRate: 6, recipient: 'RCPT' });
  assert.deepEqual(calls[2].slice(1, 3), ['wp', 'br1']); assert.equal(calls[2][3].walletPriv, 'PRIV');
  calls.length = 0;
  await begin(t(ux()), { review: { note, pf: { path: 'reflected', burnFeeRate: 6 }, cost: { need: 800 } }, priv: 'PRIV' });
  assert.ok(!('recipient' in calls[0][1]), 'no recipient: the key’s own');
  calls.length = 0;
  await begin(t(ux()), { review: { note, pf: { path: 'migrate', migrateFeeRate: 4 }, cost: { need: 1000 } }, priv: 'PRIV' });
  assert.deepEqual(calls.map((c) => c[0]), ['pick', 'start', 'advance'], 'a move is not armed for a mint: its burn comes later');
  assert.equal(calls[0][1], 1100, 'the funding coin covers the need and a tenth over');
  assert.deepEqual(calls[1][1].fundingUtxo, { txid: 'f', vout: 1, value: 5000 });
  await assert.rejects(begin({ ...t(ux()), getUtxos: async () => [{ txid: 'f', vout: 1, value: 100 }] }, { review: { note, pf: { path: 'migrate', migrateFeeRate: 4 }, cost: { need: 1000 } }, priv: 'PRIV' }), /no sats free to pay the fee/);
  // a record that could not be advanced is read back from the journal
  calls.length = 0;
  const back = await begin(t(ux({ advance: async () => { throw new Error('down'); } })), { review: { note, pf: { path: 'reflected', burnFeeRate: 6 }, cost: { need: 800 } }, priv: 'PRIV' });
  assert.equal(back.stage, 'burn-signed');
  // an arming that fails does not undo a burn that was sent
  const armed = await begin(t(ux({ armMint: async () => { throw new Error('relay down'); } })), { review: { note, pf: { path: 'reflected', burnFeeRate: 6 }, cost: { need: 800 } }, priv: 'PRIV' });
  assert.equal(armed.stage, 'burn-submitted');
}

// the send to one's own address: the notes by output, the amount whole or split, the coin cache dropped
{
  const sent = [];
  const holdings = new Map([['id1', { utxos: [{ utxo: { txid: 'a1', vout: 0 }, amount: 100n }, { utxo: { txid: 'b2', vout: 1 }, amount: 250n }] }]]);
  let dropped = 0;
  const t = { scanHoldings: async (force) => { assert.equal(force, true); return holdings; }, wallet: { pub: new Uint8Array([1, 2, 255]) }, invalidateHoldingsCache: () => { dropped++; },
    buildAndBroadcastCXfer: async (o) => { sent.push(o); return { revealTxid: 'tx9' }; } };
  const r = await toSelf(t, 'id1', [{ txid: 'a1', vout: 0 }, { txid: 'b2', vout: 1 }]);
  assert.deepEqual(r, { txid: 'tx9', amount: 350n }); assert.equal(sent[0].amount, 350n); assert.equal(sent[0].recipientPubHex, '0102ff'); assert.equal(dropped, 1);
  assert.deepEqual(sent[0].forceUtxos.map((u) => u.amount), [100n, 250n]);
  assert.equal((await toSelf(t, 'id1', [{ txid: 'b2', vout: 1 }], 60n)).amount, 60n, 'a part of one note');
  await assert.rejects(toSelf(t, 'id1', [{ txid: 'zz', vout: 0 }], null, 'TAC note'), /^Error: That TAC note is no longer at this address\. Refresh, then try again\.$/);
  assert.equal(sent.length, 2, 'nothing is sent for a note that is gone');
}
console.log('bridge-in: all checks passed');
