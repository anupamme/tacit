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
