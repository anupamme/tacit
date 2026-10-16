// The settle relay's books (lib/income-ledger.js): what each kind of fee adds to the buyback base, what is only counted, and that nothing
// the ledger is handed can make it throw into the settle path.
// node --test tests/income-ledger.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLedger, classifyFeeAsset, ETH } from '../src/lib/income-ledger.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', TAC = '0x00000000aAAA000000000000000000000000dEaD', TACUSD = '0x1111111111111111111111111111111111111111';
const opts = { converted: [ETH, USDC], tac: TAC };
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

test('a fee asset is classed by its address', () => {
  assert.equal(classifyFeeAsset(ETH, opts), 'eth');
  assert.equal(classifyFeeAsset('eth', opts), 'eth');
  assert.equal(classifyFeeAsset(USDC.toLowerCase(), opts), 'converted', 'case does not matter');
  assert.equal(classifyFeeAsset(TAC, opts), 'tac');
  assert.equal(classifyFeeAsset(TACUSD, opts), 'other', 'paid, but nothing converts it');
  assert.equal(classifyFeeAsset(null, opts), 'none');
  assert.equal(classifyFeeAsset('', opts), 'none');
});

test('ETH and converted fees make up the buyback base; TAC and the rest are counted but not in it', () => {
  const l = makeLedger({ ...opts, now: () => T0 });
  l.settled({ feeUsd: 0.7, feeAsset: ETH }, { txCostWei: 120_000_000_000_000n });
  l.settled({ feeUsd: 0.5, feeAsset: USDC });
  l.settled({ feeUsd: 0.4, feeAsset: TAC });
  l.settled({ feeUsd: 0.3, feeAsset: TACUSD });
  assert.ok(Math.abs(l.peekBuybackBase() - 1.2) < 1e-9, `base ${l.peekBuybackBase()}`);
  const d = l.snapshot().days['2026-10-15'];
  assert.equal(d.settled, 4);
  assert.equal(d.priced, 4);
  assert.deepEqual(d.feeUsd, { eth: 0.7, converted: 0.5, tac: 0.4, other: 0.3 });
  assert.equal(d.gasEth, 0.00012);
});

test('a job with no fee counts as unpriced and adds nothing to the base', () => {
  const l = makeLedger({ ...opts, now: () => T0 });
  l.settled({ feeUsd: null, feeAsset: null });
  l.settled({ feeUsd: 0, feeAsset: ETH });
  l.settled({});
  l.settled(null);
  assert.equal(l.peekBuybackBase(), 0);
  const d = l.snapshot().days['2026-10-15'];
  assert.equal(d.unpriced, 4);
  assert.equal(d.priced, 0);
});

test('taking the base resets it, and a pass that could not pay can hand it back', () => {
  const l = makeLedger({ ...opts, now: () => T0 });
  l.settled({ feeUsd: 2, feeAsset: ETH });
  assert.equal(l.takeBuybackBase(), 2);
  assert.equal(l.takeBuybackBase(), 0);
  l.giveBackBase(2);
  assert.equal(l.peekBuybackBase(), 2);
  l.giveBackBase(-5); l.giveBackBase(NaN);
  assert.equal(l.peekBuybackBase(), 2, 'nonsense is ignored');
});

test('the buyback owed is carried and never negative', () => {
  const l = makeLedger(opts);
  assert.equal(l.owed(), 0n);
  l.setOwed(1_000n);
  assert.equal(l.owed(), 1_000n);
  l.setOwed(-5n);
  assert.equal(l.owed(), 0n);
  l.setOwed('not a number');
  assert.equal(l.owed(), 0n, 'a bad value leaves it unchanged rather than throwing');
});

test('days are kept apart and only the newest few are kept', () => {
  let t = T0;
  const l = makeLedger({ ...opts, keepDays: 3, now: () => t });
  for (let i = 0; i < 5; i++) { l.settled({ feeUsd: 1, feeAsset: ETH }); l.provedOnly(); l.deposited(10); l.boughtBack(10n ** 15n); l.splitterSent(); t += 86_400_000; }
  const snap = l.snapshot();
  assert.deepEqual(Object.keys(snap.days), ['2026-10-17', '2026-10-18', '2026-10-19']);
  const d = snap.days['2026-10-19'];
  assert.equal(d.proveOnly, 1);
  assert.equal(d.proveIn, 10);
  assert.equal(d.buybackEth, 0.001);
  assert.equal(d.splitterSends, 1);
});

test('the snapshot is plain JSON of numbers and a few strings', () => {
  const l = makeLedger({ ...opts, now: () => T0 });
  l.setConfig({ buybackBps: 1000 });
  l.settled({ feeUsd: 0.123456, feeAsset: ETH }, { txCostWei: 1n });
  const snap = l.snapshot();
  assert.equal(JSON.parse(JSON.stringify(snap)).cfg.buybackBps, 1000);
  assert.equal(snap.days['2026-10-15'].feeUsd.eth, 0.12);
  assert.ok(snap.since.startsWith('2026-10-15'));
  assert.ok(JSON.stringify(snap).length < 2000, 'small enough to ride every heartbeat');
});

test('configure sets the assets after the book is made', () => {
  const l = makeLedger({ now: () => T0 });
  l.settled({ feeUsd: 1, feeAsset: USDC });
  assert.equal(l.peekBuybackBase(), 0, 'before configuring, an ERC-20 is only "other"');
  l.configure({ converted: [USDC], tac: TAC });
  l.settled({ feeUsd: 1, feeAsset: USDC });
  assert.equal(l.peekBuybackBase(), 1);
});

test('nothing it is handed can make it throw', () => {
  const l = makeLedger({ ...opts, now: () => T0 });
  assert.doesNotThrow(() => { l.settled({ feeUsd: 'x', feeAsset: {} }, { txCostWei: 'junk' }); l.deposited('x'); l.boughtBack('x'); l.setConfig(null); });
  assert.doesNotThrow(() => l.snapshot());
});

test('a restart takes the last process\'s books back: days added, owed and pending carried, the first start kept', () => {
  const before = makeLedger({ ...opts, now: () => T0 });
  before.settled({ feeUsd: 0.7, feeAsset: ETH }, { txCostWei: 100_000_000_000_000n });
  before.provedOnly(); before.deposited(10); before.boughtBack(1_000_000_000_000_000n); before.setOwed(123_456_789_012_345_678n);
  const snap = JSON.parse(JSON.stringify(before.snapshot()));
  assert.equal(snap.owedWei, '123456789012345678');
  assert.equal(snap.pendingUsd, 0.7);

  const after = makeLedger({ ...opts, now: () => T0 + 3600e3 });
  after.settled({ feeUsd: 0.5, feeAsset: USDC });                       // counted before the books came back
  assert.equal(after.restore(snap), true);
  const d = after.snapshot().days['2026-10-15'];
  assert.equal(d.settled, 2); assert.equal(d.priced, 2); assert.equal(d.proveOnly, 1); assert.equal(d.proveIn, 10);
  assert.deepEqual(d.feeUsd, { eth: 0.7, converted: 0.5, tac: 0, other: 0 });
  assert.equal(d.gasEth, 0.0001); assert.equal(d.buybackEth, 0.001);
  assert.equal(after.owed(), 123_456_789_012_345_678n, 'the exact amount owed');
  assert.ok(Math.abs(after.peekBuybackBase() - 1.2) < 1e-9, 'income not yet taxed is still to be taxed');
  assert.equal(after.snapshot().since, snap.since, 'counted from the first start, not the restart');
});

test('the books come back once, and a snapshot that is not books changes nothing', () => {
  const snap = { since: new Date(T0 - 86400e3).toISOString(), owedWei: '5', pendingUsd: 1, days: { '2026-10-14': { settled: 3, feeUsd: { eth: 1 } } } };
  const k = makeLedger({ ...opts, now: () => T0 });
  for (const bad of [null, undefined, 'x', 7, []]) assert.equal(k.restore(bad), false);
  assert.equal(k.restore(snap), true);
  assert.equal(k.restore(snap), false, 'a second call adds nothing');
  assert.equal(k.snapshot().days['2026-10-14'].settled, 3);
  assert.equal(k.owed(), 5n);
});

test('restored days beyond the keep window are dropped, and odd fields are read as zero', () => {
  const l = makeLedger({ ...opts, now: () => T0, keepDays: 2 });
  const days = {};
  for (let i = 1; i <= 5; i++) days[`2026-10-0${i}`] = { settled: i };
  days['not-a-day'] = { settled: 99 };
  days['2026-10-09'] = { settled: 'many', feeUsd: { eth: -3, converted: 'x' }, gasEth: NaN };
  l.restore({ since: 'junk', owedWei: '-1', pendingUsd: 'x', days });
  const out = l.snapshot();
  assert.deepEqual(Object.keys(out.days), ['2026-10-05', '2026-10-09']);
  assert.equal(out.days['2026-10-09'].settled, 0);
  assert.equal(out.days['2026-10-09'].gasEth, 0);
  assert.equal(l.owed(), 0n);
  assert.equal(out.since, new Date(T0).toISOString(), 'a start that does not parse is ignored');
});

test('the token the API names decides the kind; what a submitter said is read only without it', () => {
  const l = makeLedger({ ...opts, now: () => T0 });
  l.settled({ feeUsd: 1, feeToken: ETH, feeAsset: TACUSD });        // an ETH fee leg, whatever the submitter wrote
  l.settled({ feeUsd: 2, feeToken: TAC, feeAsset: null });
  l.settled({ feeUsd: 4, feeAsset: USDC });                        // an older API: the submitter's word stands
  l.settled({ feeUsd: 8, feeToken: null, feeAsset: null });        // priced, token unknown: counted, not in the base
  const d = l.snapshot().days['2026-10-15'];
  assert.deepEqual(d.feeUsd, { eth: 1, converted: 4, tac: 2, other: 8 });
  assert.ok(Math.abs(l.peekBuybackBase() - 5) < 1e-9);
});

test('the books give a burn a day and carry the treasury runway for the operator', () => {
  const l = makeLedger({ ...opts, now: () => T0 });
  assert.equal(l.burnPerDay().gasEthPerDay, null, 'nothing before a day');
  l.settled({ feeUsd: 1, feeToken: ETH }, { txCostWei: 2_000_000_000_000_000n });
  l.deposited(12);
  const b = l.burnPerDay();
  assert.ok(b.gasEthPerDay > 0 && b.provePerDay > 0 && b.settlesPerDay > 0, JSON.stringify(b));
  assert.equal(l.snapshot().runway, undefined, 'no runway until a pass reports one');
  l.setRunway({ settleDays: 1.5, relayDays: 2, proveDays: 0.4, toRelayEth: 0.001, toProveEth: 0 });
  const r = l.snapshot().runway;
  assert.equal(r.settleDays, 1.5); assert.equal(r.proveDays, 0.4); assert.ok(/^2026-10-15T/.test(r.at));
  l.setRunway('junk');
  assert.equal(l.snapshot().runway, undefined);
});
