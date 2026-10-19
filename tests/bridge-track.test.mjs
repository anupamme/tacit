// dapp/bridge/track.js: the bridge page reads the front page's bridge journals (burndep-ux on the way in, crossout-ux on the way out)
// into rows, says which step each is at and what it waits on its holder for, and reads none of a record's signing material.
//   node --test tests/bridge-track.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { readBridges, inRow, outRow, inDue, outDue, liveLine, nextOf, fmtAmount, limitLine, LIMITS, IN_PREFIX, OUT_PREFIX, PLAN_KEY, TETH_ID, KEEP_DONE_MS } from '../dapp/bridge/track.js';
import { CROSSOUT_BETA_CAP_RAW, CROSSOUT_TETH_CAP_RAW, CROSSOUT_TETH_MIN_RAW } from '../dapp/crossout-ux.js';
import { BURNDEP_BETA_CAP_RAW } from '../dapp/burndep-ux.js';

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
  assert.equal(r.ethTx, '0x' + 'ff'.repeat(32)); assert.equal(r.ethBlock, 26_225_900); assert.equal(r.href, '/#private/bitcoin');
  assert.equal(outDue(outRec({ stage: 'covered' })), 'Send to Bitcoin');
  assert.equal(outDue(outRec({ stage: 'mint-rejected' })), 'Look at it');
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
  assert.match(liveLine(outRow(outRec()), live), /the proof is 100 blocks short of it/);
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
  assert.equal(r.href, '/#private/bitcoin'); assert.equal(r.at, 2); assert.equal(r.btcTx, 'bb'.repeat(32));
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
  assert.equal(limitLine('teth', 'out'), '0.01 to 0.5 tETH a bridge while it is new');
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
