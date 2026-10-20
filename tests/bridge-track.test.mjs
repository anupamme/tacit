// dapp/bridge/track.js: the bridge page reads the front page's bridge journals (burndep-ux on the way in, crossout-ux on the way out)
// into rows, says which step each is at and what it waits on its holder for, and reads none of a record's signing material.
//   node --test tests/bridge-track.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { readBridges, inRow, outRow, inDue, outDue, liveLine, nextOf, readyNow, fmtAmount, limitLine, ethSpan, btcSpan, satsOut, satsBack, costLine, LIMITS, IN_PREFIX, OUT_PREFIX, PLAN_KEY, TETH_ID, KEEP_DONE_MS } from '../dapp/bridge/track.js';
import { CROSSOUT_BETA_CAP_RAW, CROSSOUT_TETH_CAP_RAW, CROSSOUT_TETH_MIN_RAW } from '../dapp/crossout-ux.js';
import { BURNDEP_BETA_CAP_RAW } from '../dapp/burndep-ux.js';
import { makeCrossoutMintReveal } from '../dapp/crossout-mint-reveal.js';

const NOW = 1_760_000_000_000;
const PUB = '02' + 'ab'.repeat(32);
const SECRET = 'cd'.repeat(32);
const big = (v) => ({ __big: String(v) });   // how burndep-ux journals an amount

function store(map) {
  const keys = Object.keys(map);
  return { get length() { return keys.length; }, key: (i) => keys[i] ?? null, getItem: (k) => (k in map ? map[k] : null) };
}

const inRec = (o = {}) => ({
  id: 'aa'.repeat(32) + ':0', network: 'mainnet', walletPub: PUB, path: 'reflected', stage: 'rburn-mined', createdAt: NOW - 3600e3,
  source: { txid: 'aa'.repeat(32), vout: 0, assetId: 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', ticker: 'TAC', amount: big(123_45000000n), blinding: big(77n) },
  burn: { txid: 'bb'.repeat(32), hex: '00', commitTxid: 'cc'.repeat(32) }, burnHeight: 972_100,
  notePriv: SECRET, mint: { dest: { blinding: big(9n) } }, ...o,
});
const outRec = (o = {}) => ({
  id: '0x' + 'dd'.repeat(32), network: 'mainnet', walletPub: PUB, stage: 'settled', createdAt: NOW - 600e3,
  source: { nullifier: '0x' + 'dd'.repeat(32), value: '500000000', amount: '490000000', assetId: '0x' + TETH_ID, ticker: 'tETH' },
  destXonly: 'ee'.repeat(32), settle: { txHash: 'ff'.repeat(32), claimId: '0x' + '11'.repeat(32), ethBlock: 26_225_900, claimIdVerified: true },
  ...o,
});

test('a bridge in reads its asset, amount, step and transactions', () => {
  const r = inRow(inRec(), NOW);
  assert.equal(r.dir, 'in'); assert.equal(r.asset, 'tac'); assert.equal(r.amount, 123_45000000n);
  assert.equal(r.at, 2); assert.equal(r.btcTx, 'bb'.repeat(32)); assert.equal(r.btcHeight, 972_100);
  assert.equal(r.href, '/#bridge'); assert.equal(r.due, '');
});

test('nothing secret leaves a record', () => {
  const rows = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([inRec()]), [OUT_PREFIX + PUB]: JSON.stringify([outRec()]) }), NOW);
  const text = JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  assert.ok(!text.includes(SECRET), 'the note key');
  assert.ok(!text.includes('"blinding"'), 'a blinding');
  assert.ok(!text.includes('"hex"'), 'a signed transaction');
});

test('the presses a bridge in waits on, as the front page names them', () => {
  assert.equal(inDue(inRec({ stage: 'traced' }), NOW), 'Burn it');
  assert.equal(inDue(inRec({ stage: 'rfolded' }), NOW), 'Mint now');
  assert.equal(inDue(inRec({ stage: 'rfolded', arm: { ok: true } }), NOW), '', 'the relay holds an armed mint');
  assert.equal(inDue(inRec({ stage: 'folded', lastError: { message: 'x', until: NOW + 3600e3 } }), NOW), '', 'held for the day');
  assert.equal(inDue(inRec({ stage: 'folded', lastError: { message: 'x', relay: true } }), NOW), '', 'the page asks again');
  assert.equal(inDue(inRec({ stage: 'stopped' }), NOW), 'Move it back');
  assert.equal(inDue(inRec({ stage: 'burn-submitted', submittedAt: NOW - 13 * 3600e3 }), NOW), 'Move it back');
  assert.equal(inDue(inRec({ stage: 'burn-submitted', submittedAt: NOW - 3600e3 }), NOW), '');
  assert.equal(inDue(inRec({ stage: 'not-recorded' }), NOW), 'Recover');
  assert.equal(inDue(inRec({ stage: 'not-recorded', source: { p2tr: true } }), NOW), '', 'a cross-out note has nothing to recover');
  assert.equal(inDue(inRec({ stage: 'rburn-sent', lastError: { message: 'x' }, errorCount: 3 }), NOW), 'Try again or cancel');
});

test('a bridge out: its step, its press, and its Ethereum block', () => {
  const r = outRow(outRec());
  assert.equal(r.asset, 'teth'); assert.equal(r.amount, 490000000n); assert.equal(r.at, 1);
  assert.equal(r.ethTx, '0x' + 'ff'.repeat(32)); assert.equal(r.ethBlock, 26_225_900); assert.equal(r.href, '/#private/bitcoin/out');
  assert.equal(outDue(outRec({ stage: 'covered' })), 'Send to Bitcoin');
  assert.equal(outDue(outRec({ stage: 'mint-rejected' })), 'Send it again');
  assert.equal(outDue(outRec({ stage: 'mint-rejected', attempts: [{}, {}] })), 'Look at it', 'after the third step the front page offers none');
  assert.equal(outDue(outRec({ settle: { claimIdVerified: false } })), 'Look at it');
  assert.equal(outDue(outRec({ stage: 'mint-submitted', lastError: { message: 'x' }, errorCount: 6, feeWait: true })), '', 'a fee wait is not the holder’s');
  assert.equal(outRow(outRec({ stage: 'mint-submitted', mint: { revealTxid: '12'.repeat(32) } })).btcTx, '12'.repeat(32));
});

test('every journal in the browser, ordered: what needs its holder, then what is under way, then arrivals', () => {
  const rows = readBridges(store({
    [IN_PREFIX + PUB]: JSON.stringify([inRec({ id: 'a', createdAt: NOW - 1e3 }), inRec({ id: 'b', stage: 'minted', mintedAt: NOW - 1e3 }), inRec({ id: 'c', stage: 'minted', mintedAt: NOW - KEEP_DONE_MS - 1 })]),
    [OUT_PREFIX + PUB]: JSON.stringify([outRec({ id: 'd', stage: 'covered' })]),
    'tacit-something-else': '[{"stage":"x"}]',
    [IN_PREFIX + '03' + '00'.repeat(32)]: 'not json',
  }), NOW);
  assert.deepEqual(rows.map((r) => r.id), ['d', 'a', 'b']);
});

test('Ethereum blocks read as a time: minutes, then hours from an hour and a half', () => {
  assert.equal(ethSpan(1), '1 min');
  assert.equal(ethSpan(100), '20 min');
  assert.equal(ethSpan(444), '89 min');
  assert.equal(ethSpan(450), '2 hours');
  assert.equal(ethSpan(3000), '10 hours');
});

test('storage that refuses to be read is no bridges', () => {
  assert.deepEqual(readBridges({ get length() { throw new Error('denied'); } }, NOW), []);
  assert.deepEqual(readBridges(null, NOW), []);
});

test('where a bridge really is, from the chains', () => {
  const live = { btcAttested: 972_090, ethCovered: 26_225_800, txs: new Map() };
  assert.match(liveLine(inRow(inRec(), NOW), live), /10 blocks behind/);
  assert.match(liveLine(inRow(inRec(), NOW), { ...live, btcAttested: 972_100 }), /has reached this block/);
  assert.equal(liveLine(inRow(inRec({ stage: 'rfolded' }), NOW), { ...live, btcAttested: 972_200 }), '');
  const pending = inRow(inRec({ stage: 'rburn-sent', burnHeight: undefined }), NOW);
  assert.match(liveLine(pending, { ...live, txs: new Map([['bb'.repeat(32), { confirmed: false }]]) }), /mempool/);
  assert.match(liveLine(outRow(outRec()), live), /the proof is about 20 min short of it/);
  assert.match(liveLine(outRow(outRec()), { ...live, ethCovered: live.ethCovered - 900 }), /the proof is about 3 hours short of it/);
  assert.match(liveLine(outRow(outRec()), { ...live, ethCovered: 26_225_900 }), /proof has reached this block/);
  assert.equal(liveLine(inRow(inRec({ stage: 'minted', mintedAt: NOW }), NOW), live), '');
});

test('what goes on by itself and what needs the page', () => {
  assert.deepEqual(nextOf(inRow(inRec(), NOW)), { due: '', self: true });
  assert.deepEqual(nextOf(inRow(inRec({ stage: 'rfolded', arm: { ok: true } }), NOW)), { due: '', self: true });
  assert.deepEqual(nextOf(inRow(inRec({ stage: 'traced' }), NOW)), { due: 'Burn it', self: false });
  assert.deepEqual(nextOf(outRow(outRec())), { due: '', self: true });
  assert.deepEqual(nextOf(outRow(outRec({ stage: 'covered' }))), { due: 'Send to Bitcoin', self: false });
});

test('amounts in eight decimals, trimmed to the asset’s places', () => {
  assert.equal(fmtAmount(123_45000000n, 4), '123.45');
  assert.equal(fmtAmount(1_000_00000000n, 4), '1,000');
  assert.equal(fmtAmount({ __big: '490000000' }, 6), '4.9');
  assert.equal(fmtAmount(1n, 8), '0.00000001');
});

// ── tETH ──
const tethBack = (o = {}) => inRec({ source: { txid: 'aa'.repeat(32), vout: 1, assetId: '0x' + TETH_ID, ticker: 'tETH', amount: big(30_000_000n), blinding: big(5n) }, ...o });

test('tETH coming back from Bitcoin is a tETH row, read in its own places', () => {
  const r = inRow(tethBack({ stage: 'rburn-mined' }), NOW);
  assert.equal(r.asset, 'teth'); assert.equal(r.dir, 'in'); assert.equal(r.amount, 30_000_000n);
  assert.equal(r.href, '/#private/bitcoin/back'); assert.equal(r.at, 2); assert.equal(r.btcTx, 'bb'.repeat(32));
  assert.equal(fmtAmount(r.amount, 6), '0.3');
  assert.equal(inDue(tethBack({ stage: 'rfolded' }), NOW), 'Mint now');
  const rows = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([tethBack({ id: 't1', createdAt: NOW - 1e3 }), inRec({ id: 'x1', createdAt: NOW - 2e3 })]) }), NOW);
  assert.deepEqual(rows.map((x) => [x.id, x.asset]), [['t1', 'teth'], ['x1', 'tac']]);
});

test('a tETH record that names only its ticker is still tETH', () => {
  assert.equal(inRow(tethBack({ source: { ticker: 'tETH', amount: big(1n) } }), NOW).asset, 'teth');
  assert.equal(outRow(outRec({ source: { ticker: 'tETH', amount: '5' } })).asset, 'teth');
});

test('the limits the page shows are the ones the bridge enforces', () => {
  // to Bitcoin: dapp/crossout-ux.js; back from it: dapp/burndep-ux.js; the TAC minimum is the front page's own asset table
  assert.equal(LIMITS.tac.out.max, CROSSOUT_BETA_CAP_RAW);
  assert.equal(LIMITS.tac.in.max, BURNDEP_BETA_CAP_RAW);
  assert.equal(LIMITS.teth.out.max, CROSSOUT_TETH_CAP_RAW);
  assert.equal(LIMITS.teth.out.min, CROSSOUT_TETH_MIN_RAW);
  assert.equal(LIMITS.teth.in.max, CROSSOUT_TETH_CAP_RAW);   // tacit.js hands the burn-deposit module the same tETH cap
  const front = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
  const tacMin = /tac: \{ key: 'tac'[^\n]*?\bmin: ([0-9_]+)n/.exec(front);
  assert.ok(tacMin, 'the front page keeps a TAC minimum');
  assert.equal(LIMITS.tac.out.min, BigInt(tacMin[1].replaceAll('_', '')));
  const tacit = readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8');
  assert.match(tacit, /ticker: 'tETH', capRaw: CROSSOUT_TETH_CAP_RAW \}\] : \[\]\)\],\n\s+chain/, 'the way back for tETH takes the same cap');
});

test('the line under the steps says what one bridge takes', () => {
  assert.equal(limitLine('tac', 'in'), 'Up to 1,000 TAC a bridge while it is new');
  assert.equal(limitLine('tac', 'out'), '20 to 1,000 TAC a bridge while it is new');
  assert.equal(limitLine('teth', 'out'), '0.001 to 0.5 tETH a bridge while it is new');
  assert.equal(limitLine('teth', 'in'), 'Up to 0.5 tETH a bridge while it is new');
  assert.equal(limitLine('cbtc', 'in'), '');
});

test('a two-step bridge at its burn asks for no press when the page sends it, as the front page decides (brDue)', () => {
  const traced = (o = {}) => inRec({ path: 'deposit', stage: 'traced', ...o });
  assert.equal(inDue(traced(), NOW), 'Burn it');
  assert.equal(inDue(traced(), NOW, { burn: { maxRate: 20 } }), '', 'its plan sends the burn');
  assert.equal(inDue(traced({ checkWait: { at: NOW, go: true } }), NOW), '', 'a pressed burn waits on the history check');
  assert.equal(inDue(traced({ checkWait: { at: NOW, go: false } }), NOW), 'Burn it', 'a check the page started on its own still wants the press');
  assert.equal(inDue(traced({ feeWait: { rate: 40, max: 20 } }), NOW, { burn: { maxRate: 20 } }), 'Burn it', 'over the rate it was allowed');
  assert.equal(inDue(traced({ lastError: { message: 'x' }, checkWait: { at: NOW, go: true } }), NOW), 'Burn it');
  const row = inRow(traced({ checkWait: { at: NOW, go: true } }), NOW);
  assert.equal(row.checking, true);
  assert.equal(liveLine(row, null), 'Its history is being checked before its burn');
  assert.equal(nextOf(row).due, '');
  assert.equal(nextOf(row).self, false, 'the burn still needs the front page open');
});

test('the bridge page reads the front page\'s plans for each key', () => {
  const rec = inRec({ path: 'deposit', stage: 'traced' });
  const plans = { [PUB]: { [rec.id]: { at: NOW, burn: { maxRate: 20 } } } };
  const [row] = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([rec]), [PLAN_KEY]: JSON.stringify(plans) }), NOW);
  assert.equal(row.due, '');
  const [bare] = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([rec]) }), NOW);
  assert.equal(bare.due, 'Burn it');
  const [broken] = readBridges(store({ [IN_PREFIX + PUB]: JSON.stringify([rec]), [PLAN_KEY]: '{not json' }), NOW);
  assert.equal(broken.due, 'Burn it', 'unreadable plans are no plans');
});

test('what a way costs is the app\'s own figure, at the live fee rate', () => {
  // The way out: the page\'s sats are the Bitcoin step\'s own estimate.
  const mr = makeCrossoutMintReveal({ secp: {} });
  for (const rate of [1, 2, 3, 7.5, 40]) assert.equal(satsOut(rate), mr.estimateSats({ feeRate: rate, dust: 546 }), `at ${rate} sat/vB`);
  // The way back is bridgeCost's 'reflected' path for a P2TR note; its constants are pinned to the source it is built from.
  const src = readFileSync(new URL('../dapp/burndep-ux.js', import.meta.url), 'utf8');
  assert.ok(/feeFor\(p2tr \? 218 : 228\)/.test(src) && /commitVb = \(n\) => 85 \+ 68 \* n/.test(src) && /Math\.max\(500, Math\.ceil\(vb \* at\)\)/.test(src), 'bridgeCost no longer reads as satsBack expects');
  assert.equal(satsBack(1), 1000); assert.equal(satsBack(2), 1000);
  assert.equal(satsBack(5), Math.ceil(218 * 5) + Math.ceil(153 * 5));
});

test('the tile\'s cost line says what a way costs now, and nothing when it cannot say', () => {
  const c = { satvb: 2, relay: { teth: 52_241n, tac: 400_000_000n }, ethUsd: 2500, btcUsd: 80_000 };
  assert.equal(costLine('teth', 'out', c), 'About $2.28 now: 0.0005 tETH to the relay and 1,214 sats on Bitcoin');
  assert.equal(costLine('teth', 'in', c), 'About $0.80 now: 1,000 sats on Bitcoin; Tacit covers the Ethereum side');
  assert.equal(costLine('teth', 'out', { ...c, ethUsd: null }), 'About 0.0005 tETH to the relay and 1,214 sats on Bitcoin', 'without a price it names the amounts only');
  assert.equal(costLine('tac', 'out', c), 'About 4 TAC to the relay and 1,214 sats on Bitcoin');
  assert.equal(costLine('tac', 'in', c), '', 'TAC\'s way in has two steps and is priced on its own sheet');
  assert.equal(costLine('cbtc', 'in', c), '', 'a lock is priced on the Borrow sheet');
  assert.equal(costLine('teth', 'out', { ...c, satvb: null }), '', 'no fee rate, no line');
  assert.equal(costLine('teth', 'out', { ...c, relay: {} }), '', 'no relay floor, no line for the way out');
});

test('Bitcoin blocks read as a time', () => {
  assert.equal(btcSpan(1), '10 min'); assert.equal(btcSpan(8), '80 min'); assert.equal(btcSpan(9), '2 hours'); assert.equal(btcSpan(24), '4 hours');
  assert.match(liveLine(inRow(inRec(), NOW), { btcAttested: 972_090, ethCovered: 1, txs: new Map() }), /10 blocks behind it, about 2 hours$/);
});

test('a step the chains say is ready for its holder is named before the journal catches up', () => {
  const covered = { ethCovered: 26_226_000, btcAttested: 972_090, txs: new Map() };
  const waiting = outRow(outRec({ stage: 'settled' }));
  assert.equal(readyNow(waiting, covered), 'Send to Bitcoin', 'the proof has reached the burn, and the Bitcoin step needs the key');
  assert.equal(readyNow(waiting, { ...covered, ethCovered: 26_225_000 }), '', 'not yet');
  assert.deepEqual(nextOf(waiting, covered), { due: 'Send to Bitcoin', self: false });
  assert.deepEqual(nextOf(waiting, null), { due: '', self: true }, 'with no reading it is the journal\'s word');
  assert.equal(readyNow(outRow(outRec({ stage: 'minted', mintedAt: NOW })), covered), '', 'an arrival is not due');
  const burn = inRow(inRec({ stage: 'rburn-mined', burnHeight: 972_080 }), NOW);
  assert.equal(readyNow(burn, covered), 'Mint now', 'a burn the proof has reached waits for its mint');
  assert.equal(readyNow(inRow(inRec({ stage: 'rburn-mined', burnHeight: 972_100 }), NOW), covered), '', 'one it has not reached does not');
  assert.equal(readyNow(inRow(inRec({ stage: 'rburn-mined', burnHeight: 972_080, arm: { ok: true } }), NOW), covered), '', 'the relay mints an armed one');
});
