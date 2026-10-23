// dapp/swap/later.js, the parts that need no chain: the deposit for "Swap privately" is not an amount of its own (the swap, the relay's fee
// twice and an extra drawn around the slider's share, never under a twentieth of the swap, rounded up to two significant figures).
//   node --test tests/swap-later.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { depositFor } = await import('../dapp/swap/later.js');

const sig = (v) => v.toString().replace(/0+$/, '').length;
const E = 10n ** 18n;

test('a deposit is a round amount: two significant figures, at least the swap, the fee twice and its extra', () => {
  for (const [swap, fee, pct] of [[5n * E / 10n, 30n ** 10n, 25], [2n * E / 100n, 12_345_678_901_234n, 60], [3n * E, 9n * 10n ** 14n, 100], [123_456_789_000_000n, 1n, 5]]) {
    for (const rand of [() => 0, () => 0.5, () => 0.999]) {
      const { depositWei, extraWei } = depositFor({ swapWei: swap, feeWei: fee, pct, rand });
      assert.ok(sig(depositWei) <= 2, `${depositWei} has more than two significant figures`);
      assert.strictEqual(depositWei, swap + 2n * fee + extraWei, 'the parts add up to the deposit');
      assert.ok(extraWei * 100n >= swap * 5n, `the extra ${extraWei} is at least a twentieth of the swap ${swap}`);
    }
  }
});

test('the extra is drawn around the slider: three quarters to one and a quarter of its share', () => {
  const swap = 10n ** 18n, at = (r) => depositFor({ swapWei: swap, feeWei: 0n, pct: 40, rand: () => r });
  assert.ok(at(0).depositWei < at(0.999).depositWei, 'a different draw makes a different deposit');
  assert.ok(at(0).extraWei >= (swap * 30n) / 100n && at(0.999).extraWei <= (swap * 51n) / 100n + swap / 10n, 'within the range around 40%');
});

test('a zero share is not offered: the floor keeps the deposit from being the swap and its fee', () => {
  const { depositWei } = depositFor({ swapWei: 10n ** 17n, feeWei: 10n ** 14n, pct: 0, rand: () => 0 });
  assert.ok(depositWei >= 10n ** 17n + 2n * 10n ** 14n + 5n * 10n ** 15n);
});
