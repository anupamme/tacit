// A per-address daily limit on the ETH of one activity that counts (src/lib/points-engagement.js, points-counted.js,
// points-store.js dayAmountsByAddress): a deposit repeated all day stops adding points past the limit, an ordinary
// day is untouched, days before the limit starts re-split to the same figures, and the terms state it.
//   node worker-relay/tests/points-address-caps.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { makeCounted } from '../src/lib/points-counted.js';
import { parseAddressDayCaps, addressDayCapsForDay, capFactor } from '../src/lib/points-engagement.js';
import { programTerms } from '../src/lib/points-program.js';

const ETH = 10n ** 18n, DAY = 86400, D = 20741;
const LOOP = '0x' + '1'.repeat(40), HONEST = '0x' + '2'.repeat(40), WHALE = '0x' + '3'.repeat(40);
let n = 0;
const dep = (depositor, day, activity, ethAmount, extra = {}) => ({
  txHash: '0x' + (++n).toString(16).padStart(64, '0'), blockNumber: n, blockTime: day * DAY + 100 + n, depositor,
  amountWei: String(BigInt(Math.round(ethAmount * 1000)) * ETH / 1000n), priorDepositCount: 0, points: ethAmount * 1000, activity, chainId: 1, ...extra,
});
const by = (rows) => Object.fromEntries(rows.map((r) => [r.address, r]));

{
  const s = parseAddressDayCaps('20741:evmpooldeposit=5;20800:evmpooldeposit=2.5,wrap=10;20900:off');
  assert.deepEqual(s.map((e) => e.fromDay), [20741, 20800, 20900]);
  assert.deepEqual(addressDayCapsForDay(s, 20740), {}, 'nothing before the first day');
  assert.deepEqual(addressDayCapsForDay(s, 20741), { evmpooldeposit: 5n * ETH });
  assert.deepEqual(addressDayCapsForDay(s, 20850), { evmpooldeposit: 25n * ETH / 10n, wrap: 10n * ETH }, 'a later entry replaces the earlier one');
  assert.deepEqual(addressDayCapsForDay(s, 20900), {}, '"off" ends them');
  const bad = [];
  assert.deepEqual(parseAddressDayCaps('x;20741:evmpooldeposit=lots;20741:evmpooldeposit=0;20741:Bad-Name=5', (m) => bad.push(m)), []);
  assert.equal(bad.length, 4, 'every malformed entry is ignored with a reason');
  assert.equal(capFactor(4n * ETH, 5n * ETH), 1);
  assert.equal(capFactor(5n * ETH, 5n * ETH), 1, 'exactly the limit counts whole');
  assert.equal(capFactor(200n * ETH, 5n * ETH), 0.025);
  assert.equal(capFactor(10n * ETH, undefined), 1, 'no limit');
  console.log('ok - the schedule parses, applies from its day, is replaced or ended, and refuses nonsense');
}

const dir = mkdtempSync(join(tmpdir(), 'points-caps-'));
try {
  const store = openStore(join(dir, 'p.db'));
  // Before the limit: the looper put in 100 ETH over 50 deposits.
  for (let i = 0; i < 50; i++) store.recordDeposit(dep(LOOP, D - 1, 'evmpooldeposit', 2));
  store.recordDeposit(dep(HONEST, D - 1, 'evmpooldeposit', 0.2));
  // The first day with the limit: the same pattern, an honest 0.2 ETH, a whale's 4 ETH split over chains and a swap.
  for (let i = 0; i < 50; i++) store.recordDeposit(dep(LOOP, D, 'evmpooldeposit', 2, { chainId: i % 2 ? 8453 : 4663 }));
  store.recordDeposit(dep(HONEST, D, 'evmpooldeposit', 0.2));
  store.recordDeposit(dep(WHALE, D, 'evmpooldeposit', 2, { chainId: 1 }));
  store.recordDeposit(dep(WHALE, D, 'evmpooldeposit', 2, { chainId: 8453 }));
  store.recordDeposit(dep(LOOP, D, 'zswapeth', 3));

  const caps = parseAddressDayCaps(`${D}:evmpooldeposit=5`);
  const counted = makeCounted({ store, addressDayCaps: caps });
  const plain = makeCounted({ store });

  const before = counted.rows(D - 1), legacy = store.dayPointsByAddress((D - 1) * DAY, D * DAY);
  assert.deepEqual(before.map((r) => [r.address, r.dayPoints]), legacy.map((r) => [r.address, r.dayPoints]), 'the day before the limit re-splits to exactly the store\'s sums');

  const on = by(counted.rows(D)), off = by(plain.rows(D));
  assert.equal(off[LOOP].dayPoints, 100000 + 3000, 'without the limit the looper counts all of it');
  assert.equal(on[LOOP].dayPoints, 5000 + 3000, 'with it, 5 ETH of the pool deposits and the swap');
  assert.equal(on[LOOP].rawPoints, 100000 + 3000, 'the points scored are still what they were');
  assert.equal(on[HONEST].dayPoints, 200, 'an ordinary day is untouched');
  assert.equal(on[WHALE].dayPoints, 4000, 'a depositor under the limit counts whole, across chains');
  console.log('ok - past the limit a day\'s repeated deposits stop adding; ordinary days and other activity are untouched');

  // Across chains the limit is on the address, and a late row does not count in a settled day's own split.
  store.recordDeposit({ ...dep(WHALE, D, 'evmpooldeposit', 4), blockTime: D * DAY + 5000 });
  const w = by(counted.rows(D))[WHALE];
  assert.equal(w.dayPoints, 5000, '8 ETH over two chains counts 5');
  assert.equal(Math.round(by(makeCounted({ store, addressDayCaps: caps, onTime: true }).rows(D))[WHALE].dayPoints), 5000);
  console.log('ok - the limit is on the address across chains');

  const cfg = {
    pointsProgramStartSec: 20719 * 86400 + 5, pointsProgramDays: 90, pointsProgramTotalWei: 100_000n * ETH, pointsSettleGraceSecs: 1800,
    pointsBasePerEth: 1000, tethWrapBoostMultiplier: 1.25, pointsBasePerZswapEth: 1000, pointsBasePerCbtc: 1000, pointsBasePerCusd: 1, cusdMintBonusMultiplier: 2,
    pointsBasePerPmBet: 1000, pointsPerPmCreate: 50, pointsBasePerEvmPoolEth: 1000, evmPoolPointsStartBlocks: { 1: '24000000', 8453: '', 4663: '' },
    weinameEnabled: true, pointsBasePerWeiname: 1000, btcPoolPointsStartHeight: '', pointsBasePerBtcPoolTac: 1,
    pointsBonusScale: 4, pointsBonusHalfLife: 200, tacBoostWindowBlocks: 7200, pointsBondHoldFromDay: 0, pointsCbtcHoldRate: 0, pointsCbtcHoldFromDay: 0,
  };
  const t = programTerms({ cfg, dayBudgetWei: () => 1111n * ETH, addressDayCaps: parseAddressDayCaps(`${D}:evmpooldeposit=5;20800:evmpooldeposit=2.5`) });
  assert.deepEqual(t.addressDayCaps, [{ fromDay: D, caps: { evmpooldeposit: '5' } }, { fromDay: 20800, caps: { evmpooldeposit: '2.5' } }], 'the terms state the limit in ETH');
  assert.deepEqual(programTerms({ cfg, dayBudgetWei: () => 1111n * ETH }).addressDayCaps, [], 'none configured states none');
  console.log('ok - the program terms state the limit');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
