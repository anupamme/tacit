// dapp/bridge-out.js, what a bridge to Bitcoin is held to wherever it is started: the fee ladder, the relay's published floor taken when it is
// the higher, the limits in words, and the words for a proof that is behind and a Bitcoin address with no coin for the last step.
//   node tests/bridge-out.test.mjs
import assert from 'node:assert/strict';
import { OUT_ASSETS, ladder, feeShort, makeOutFee, limitText, proofWarn, proofProblem, fundingText } from '../dapp/bridge-out.js';

assert.equal(ladder(5n), 5n); assert.equal(ladder(99n), 99n); assert.equal(ladder(123n), 130n); assert.equal(ladder(130n), 130n); assert.equal(ladder(1234567n), 1300000n, 'rounded up to two digits');
assert.equal(feeShort(new Error('relay: fee below the current floor')), true); assert.equal(feeShort('feeGate'), true); assert.equal(feeShort(new Error('relay 429')), false);
assert.equal(OUT_ASSETS.tac.pool, 'cTAC'); assert.equal(OUT_ASSETS.teth.id.length, 66); assert.equal(OUT_ASSETS.tac.min, 2_000_000_000n);

// the fee: the pool's own quote, or the published floor when that is higher, kept five minutes
{
  let asks = 0, floor = '300';
  const t = { quoteOpFee: async (tk, op) => { assert.equal(op, 'bridgeburn'); return tk === 'cETH' ? 120n : 200n; } };
  const outFee = makeOutFee({ api: 'https://api.x', fetchImpl: async (url) => { asks++; assert.equal(url, 'https://api.x/confidential/quote?asset=cTAC'); return { ok: true, json: async () => ({ staticFloorUnits: floor }) }; } });
  assert.equal(await outFee(t, OUT_ASSETS.teth), 120n, 'an asset with no published floor: its own quote');
  assert.equal(asks, 0);
  assert.equal(await outFee(t, OUT_ASSETS.tac), 300n, 'the floor, when it is higher');
  floor = '100'; assert.equal(await outFee(t, OUT_ASSETS.tac), 300n); assert.equal(asks, 1, 'kept, not asked again');
  const down = makeOutFee({ api: 'x', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await down(t, OUT_ASSETS.tac), 200n, 'a floor that cannot be read: its own quote');
}
// the limits
const fmt = (v, max = 8) => `${Number(v) / 1e8}`;
const L = (o) => limitText({ units: 500n, fee: 10n, min: 100n, cap: 1000n, ticker: 'TAC', fmt, ...o });
assert.equal(L({}), null);
assert.match(L({ units: 50n }), /^Bridge at least .* TAC: below that the fees take too much of it\.$/);
assert.match(L({ units: 1001n }), /^One bridge takes at most .* TAC while this is new\. Bridge less, then again\.$/);
assert.match(L({ units: 10n, min: 0n }), /^Bridge more than .* TAC: the relay fee comes out of it\.$/);
assert.match(L({ units: 10n, min: 100n }), /at least/, 'the least is named before the fee');
// the proof
assert.match(proofWarn({ name: 'reflection-behind', detail: '300 Bitcoin blocks' }, 300), /300 Bitcoin blocks behind \(about 50 hours\)/);
assert.match(proofWarn({ name: 'coverage-behind' }, 0), /further behind than usual/); assert.equal(proofWarn({ name: 'funding' }, 0), '');
assert.match(proofProblem, /nothing was started/);
// the coin for the Bitcoin step
const btc = (s) => (s / 1e8).toFixed(8);
assert.match(fundingText({ pending: 0, haveSats: 0, needSats: 1882 }, btc), /has no free coin yet.*one coin of 1,882 sats/);
assert.match(fundingText({ pending: 0, haveSats: 1000, needSats: 1882 }, btc), /largest free coin .* holds 0\.00001000 BTC/);
assert.match(fundingText({ pending: 1, haveSats: 0, needSats: 1882 }, btc), /^A bridge under way takes a coin .* No other coin is free/);
assert.match(fundingText({ pending: 3, haveSats: 2000, needSats: 1882 }, btc), /^3 bridges under way take a coin each .* The next free coin holds 0\.00002000 BTC/);
console.log('bridge-out: all checks passed');
