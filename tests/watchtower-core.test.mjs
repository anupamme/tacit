// Unit tests for the per-bid fill engine (fulfiller/watchtower-core.mjs),
// driving runTick over a mocked dapp so the orchestration logic — discovery
// filtering, the policy pre-filter, the settle-time re-check, accounting, the
// fill cap, and partial-fill accumulation — is validated deterministically
// without a signet cycle. The real claim/take path is exercised by the signet
// e2e; here we pin the control flow around it.
//
// Run: `node tests/watchtower-core.test.mjs`

import {
  runTick, recordExpiration, RECORD_GRACE_SEC,
  returnDue, returnToOwner, noteReturn, giveBack, RETURN_RETRY_SEC, RETURN_RETRY_MAX_SEC, RETURN_MAX_ATTEMPTS,
} from '../fulfiller/watchtower-core.mjs';

let pass = 0, fail = 0;
async function test(label, fn) {
  try { const ok = await fn(); if (ok) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

// A mock dapp: records claims/takes, serves a scripted intent list + fulfilments.
function mockDapp({ listIntents = [], fulfilFor = () => ({ partial_reveal: {}, enc_recipient_blinding: '' }), takeBehavior = () => ({ txid: 'aa'.repeat(32) }), satsBalance = 1_000_000 } = {}) {
  const calls = { claims: [], takes: [], cancels: [] };
  const dapp = {
    wallet: { priv: null, pub: null },
    async getUtxos() { return [{ value: satsBalance }]; },
    async claimAxferIntent({ intentIdHex }) { calls.claims.push(intentIdHex); },
    async fetchAxferFulfilment({ intentIdHex }) { return { fulfilment: fulfilFor(intentIdHex) }; },
    async takeAxferIntent({ intent }) { calls.takes.push(intent.intent_id); return takeBehavior(intent); },
    async cancelAxferClaim({ intentIdHex }) { calls.cancels.push(intentIdHex); },
    invalidateHoldingsCache() {},
  };
  return { dapp, calls };
}

// global fetch is monkeypatched per-test to serve the worker list + by-id.
const realFetch = globalThis.fetch;
function withFetch(listIntents, byId) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/atomic-intents\/[0-9a-f]+/.test(u)) {
      const id = u.match(/atomic-intents\/([0-9a-f]+)/)[1];
      return { ok: true, json: async () => ({ intent: byId ? byId(id) : (listIntents.find((i) => i.intent_id === id)) }) };
    }
    if (/\/atomic-intents\b/.test(u)) return { ok: true, json: async () => ({ intents: listIntents }) };
    throw new Error('unexpected fetch ' + u);
  };
}
function restoreFetch() { globalThis.fetch = realFetch; }

function baseCtx(dapp, over = {}) {
  return {
    dapp, workerBase: 'https://w', network: 'signet', assetId: 'ab'.repeat(32), decimals: 0,
    priv: new Uint8Array(32).fill(1), pub: new Uint8Array(33).fill(2), pubHex: '02'.repeat(33), h160: 'cd'.repeat(20),
    maxUnitPriceSats: 25, maxTotalFillBase: 1000n, claimFulfilTimeoutSec: 1, minBidWalletSats: 1000,
    dryRun: false, log: () => {}, ...over,
  };
}
const ask = (id, amount, price) => ({ intent_id: id, amount: String(amount), price_sats: price, expiry: 2_000_000_000 });

await test('takes an untargeted public ask within policy', async () => {
  const { dapp, calls } = mockDapp();
  withFetch([ask('aa'.repeat(16), 300, 6000)]); // 20 sats/unit ≤ 25
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 1 && calls.takes.length === 1 && state.filledBase === 300n;
});

await test('skips an ask over the unit-price ceiling (no claim)', async () => {
  const { dapp, calls } = mockDapp();
  withFetch([ask('aa'.repeat(16), 300, 9000)]); // 30 sats/unit > 25
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 0 && calls.claims.length === 0;
});

await test('skips an ask reserved for a different buyer', async () => {
  const { dapp, calls } = mockDapp();
  const other = { ...ask('aa'.repeat(16), 300, 6000), intended_buyer_h160: 'ff'.repeat(20) };
  withFetch([other]);
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 0 && calls.claims.length === 0;
});

await test('partial-fill accumulates across multiple asks toward the cap', async () => {
  const { dapp, calls } = mockDapp();
  withFetch([ask('11'.repeat(16), 300, 6000), ask('22'.repeat(16), 200, 4000)]); // both 20 sats/unit
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 2 && state.filledBase === 500n && calls.takes.length === 2;
});

await test('stops at the cap and refuses the chunk that would overshoot', async () => {
  const { dapp, calls } = mockDapp();
  withFetch([ask('11'.repeat(16), 800, 16000), ask('22'.repeat(16), 300, 6000)]); // 800 fits, +300 overshoots 1000
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  // 800 taken; the 300 chunk would make 1100 > 1000 cap → skipped by policy pre-filter (no claim).
  return state.filledBase === 800n && calls.takes.length === 1;
});

await test('settle-time re-check refuses + cancels when the by-id record is worse than listed', async () => {
  const { dapp, calls } = mockDapp();
  // listed at 20 sats/unit (passes pre-filter) but GET-by-id serves 60 sats/unit.
  const id = '33'.repeat(16);
  withFetch([ask(id, 300, 6000)], () => ({ intent_id: id, amount: '300', price_sats: 18000, expiry: 2_000_000_000 }));
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 0 && calls.cancels.length === 1 && state.filledBase === 0n
    && state.processed[id]?.refused === true;
});

await test('already-processed intents are not re-claimed', async () => {
  const { dapp, calls } = mockDapp();
  const id = '44'.repeat(16);
  withFetch([ask(id, 300, 6000)]);
  const state = { filledBase: 0n, processed: { [id]: { txid: 'old' } } };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.fills === 0 && calls.claims.length === 0;
});

await test('idles (no claim) when the bid wallet is below the minimum', async () => {
  const { dapp, calls } = mockDapp({ satsBalance: 500 });
  withFetch([ask('55'.repeat(16), 300, 6000)]);
  const state = { filledBase: 0n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.idle === true && calls.claims.length === 0;
});

await test('reports capped when already at the fill cap', async () => {
  const { dapp } = mockDapp();
  withFetch([]);
  const state = { filledBase: 1000n, processed: {} };
  const r = await runTick(baseCtx(dapp), state);
  restoreFetch();
  return r.capped === true && r.fills === 0;
});

await test('binds the dapp wallet to the bid key before acting', async () => {
  const { dapp } = mockDapp();
  withFetch([ask('66'.repeat(16), 300, 6000)]);
  const ctx = baseCtx(dapp);
  await runTick(ctx, { filledBase: 0n, processed: {} });
  restoreFetch();
  return dapp.wallet.priv === ctx.priv && dapp.wallet.pub === ctx.pub;
});

await test('a rewritten registration is kept a week past its expiry, never to the expiry itself', () => {
  const expiry = 2_000_000_000;
  return recordExpiration(expiry) === expiry + 7 * 24 * 3600 && RECORD_GRACE_SEC === 604800 && recordExpiration(String(expiry)) === recordExpiration(expiry);
});

// ---- giving a finished bid's wallet back to its owner ----
const OWNER = new Uint8Array(33).fill(3);
const finishedRule = (rec, now) => (rec.status && rec.status !== 'active') || rec.expiry + 3600 <= now;
function returnDapp({ before = [], after = [], result = { swept: 49000, assets: [] }, throws = null } = {}) {
  const calls = { sweeps: [], reads: 0 };
  const dapp = {
    wallet: { priv: null, pub: null },
    watchtowerBidFinished: finishedRule,
    async getUtxos() { return calls.reads++ === 0 ? before : after; },
    async sweepWatchtowerBidWallet(priv, assets, opts) { calls.sweeps.push({ priv, assets, to: opts.to }); if (throws) throw throws; return result; },
  };
  return { dapp, calls };
}
const confirmed = (n) => ({ txid: 'aa'.repeat(32), vout: n, value: 50000, status: { confirmed: true } });

await test('a bid is due for return once finished, never twice, and not before its retry time or past the attempt limit', () => {
  const { dapp } = returnDapp();
  const now = 2_000_000_000;
  const rec = (x) => ({ status: 'active', expiry: now - 7200, ...x });
  return returnDue(rec(), dapp, now) && returnDue(rec({ status: 'filled', expiry: now + 600 }), dapp, now)
    && !returnDue(rec({ expiry: now + 600 }), dapp, now) && !returnDue(rec({ expiry: now - 600 }), dapp, now)
    && !returnDue(rec({ returned_at: now - 1 }), dapp, now) && !returnDue(rec({ return_next: now + 5 }), dapp, now)
    && !returnDue(rec({ return_attempts: RETURN_MAX_ATTEMPTS }), dapp, now) && !returnDue(null, dapp, now);
});

await test('returning pays the owner: the wallet is bound to the bid key, the sweep is for the bid asset to the owner key, and an emptied wallet is done', async () => {
  const { dapp, calls } = returnDapp({ before: [confirmed(0)], after: [], result: { swept: 49000, assets: [{ asset_id: 'ab'.repeat(32), amount: '5' }], txid: 'ee'.repeat(32) } });
  const ctx = baseCtx(dapp, { address: 'tb1qbid', ownerPub: OWNER });
  const r = await returnToOwner(ctx);
  return r.done === true && r.swept === 49000 && r.assets.length === 1 && calls.sweeps.length === 1
    && calls.sweeps[0].priv === ctx.priv && calls.sweeps[0].assets.join() === ctx.assetId && calls.sweeps[0].to === OWNER
    && dapp.wallet.priv === ctx.priv;
});

await test('an empty wallet is done without a sweep, and one with an unconfirmed output waits', async () => {
  const empty = returnDapp({ before: [] });
  const pending = returnDapp({ before: [confirmed(0), { ...confirmed(1), status: { confirmed: false } }] });
  const a = await returnToOwner(baseCtx(empty.dapp, { ownerPub: OWNER }));
  const b = await returnToOwner(baseCtx(pending.dapp, { ownerPub: OWNER }));
  return a.done === true && empty.calls.sweeps.length === 0 && b.done === false && b.pending === true && pending.calls.sweeps.length === 0;
});

await test('a wallet that is not emptied is not done, and a sweep that throws reaches the caller', async () => {
  const left = returnDapp({ before: [confirmed(0)], after: [confirmed(1)] });
  const r = await returnToOwner(baseCtx(left.dapp, { ownerPub: OWNER }));
  const bad = returnDapp({ before: [confirmed(0)], throws: new Error('broadcast rejected') });
  let msg = '';
  try { await returnToOwner(baseCtx(bad.dapp, { ownerPub: OWNER })); } catch (e) { msg = e.message; }
  return r.done === false && !r.pending && msg === 'broadcast rejected';
});

await test('the record is marked returned when done, waits a fixed time when pending, and backs off up to a cap when not emptied', () => {
  const now = 2_000_000_000;
  const done = noteReturn({ status: 'filled', return_next: 5 }, { done: true }, now);
  const wait = noteReturn({ status: 'active' }, { pending: true }, now);
  const rec = { status: 'active' };
  const gaps = [];
  for (let i = 0; i < 8; i++) { noteReturn(rec, { done: false }, now); gaps.push(rec.return_next - now); }
  return done.status === 'returned' && done.returned_at === now && done.return_next === undefined
    && wait.return_next === now + RETURN_RETRY_SEC && wait.return_attempts === undefined
    && gaps[0] === RETURN_RETRY_SEC && gaps[1] === 2 * RETURN_RETRY_SEC && gaps[2] === 4 * RETURN_RETRY_SEC
    && gaps[7] === RETURN_RETRY_MAX_SEC && rec.return_attempts === 8;
});

await test('giving back stores the record every time: returned when done, an attempt counted when the wallet fails, the key cannot be read, or the sweep throws', async () => {
  const now = 2_000_000_000;
  const stored = [];
  const put = async (r) => { stored.push(JSON.parse(JSON.stringify(r))); };
  const rec = () => ({ status: 'active', expiry: now - 7200, bid_id: 'cd'.repeat(16) });
  const good = returnDapp({ before: [confirmed(0)], after: [] });
  const bad = returnDapp({ before: [confirmed(0)], throws: new Error('broadcast rejected') });
  const logs = [];
  const ctxOf = (dapp) => baseCtx(dapp, { address: 'tb1qbid', ownerPub: OWNER, log: (l, m) => logs.push(`${l}:${m}`) });
  const a = await giveBack(rec(), now, { ctxFor: () => ctxOf(good.dapp), put });
  const b = await giveBack(rec(), now, { ctxFor: () => ctxOf(bad.dapp), put });
  const c = await giveBack(rec(), now, { ctxFor: () => null, put });
  return a.done === true && stored[0].status === 'returned' && stored[0].returned_at === now
    && b.done === false && stored[1].return_attempts === 1 && stored[1].status === 'active' && logs.includes('warn:return to owner failed')
    && c.done === false && stored[2].return_attempts === 1 && stored.length === 3;
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
// Exit on the computed verdict rather than only on failure: imported browser modules can leave the
// event loop alive, and a run that passes every assertion then never exits reads as a hang.
process.exit(fail > 0 ? 1 : 0);
