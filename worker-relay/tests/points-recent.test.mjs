// The public feed of recent activity (store.recent, served as /recent): newest first, accruals left out, and nothing that
// names who or which transaction.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';

const dir = mkdtempSync(join(tmpdir(), 'points-recent-'));
try {
  const store = openStore(join(dir, 'points.db'));
  const tx = (n) => '0x' + n.toString(16).padStart(64, '0');
  const U = '0x' + '11'.repeat(20);
  const row = (n, blockTime, activity, chainId = 1) => store.recordDeposit({ txHash: tx(n), blockNumber: 100 + n, blockTime, depositor: U,
    amountWei: String(10n ** 17n * BigInt(n)), priorDepositCount: 0, points: 1, activity, chainId });
  row(1, 1000, 'wrap'); row(2, 2000, 'evmpooldeposit', 8453); row(3, 3000, 'cbtchold'); row(4, 4000, 'cusdmint'); row(5, 5000, 'holding');
  row(6, 2000, 'zswapeth');

  const r = store.recent(10);
  assert.deepEqual(r.map((x) => x.activity), ['cusdmint', 'zswapeth', 'evmpooldeposit', 'wrap']);
  console.log('ok - newest first, and accruals (a bond held, a holding reward) left out');
  assert.equal(r.find((x) => x.activity === 'evmpooldeposit').chain, 8453);
  assert.equal(r.find((x) => x.activity === 'wrap').amount, String(10n ** 17n));
  console.log('ok - each row says its chain and amount');
  for (const x of r) assert.deepEqual(Object.keys(x).sort(), ['activity', 'amount', 'chain', 't']);
  console.log('ok - no row names an address or a transaction');
  assert.equal(store.recent(2).length, 2);
  console.log('ok - the limit holds');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
