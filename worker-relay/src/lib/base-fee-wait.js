// Headers are in no hurry: a batch that is ready can wait a little for a cheaper block. The base fee is the whole of what a
// header advance pays now (the tip is 0.001 gwei, lib/patient-send.js), it moves several-fold within a day, and a batch is
// 3.5M gas, so sending it in the cheaper part of the last few hours is worth having — as long as the wait is bounded, because a
// header that lands late is a bridge mint that lands late.
//
// The rule: when the next block's base fee is above what the last ~1,000 blocks (a few hours) usually paid (their 40th
// percentile), hold the batch, until it has been ready for `maxWaitSec`. Replayed on 14 days of real base fees (12 random
// Bitcoin arrival sequences, the cron's 3-minute cadence, batches of 20 to 40) this saved 5 to 8% of the base fee paid for about
// 20 minutes more delay on average; a longer wait saves more and is not worth the delay it adds to a bridge.

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));

// The p-th percentile (0..100) of a list of numbers, as a bigint; null for an empty list.
export function percentileOf(values, p) {
  const xs = (Array.isArray(values) ? values : []).filter((v) => v != null).map(big).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!xs.length) return null;
  const i = Math.min(xs.length - 1, Math.max(0, Math.floor(((xs.length - 1) * Number(p)) / 100)));
  return xs[i];
}

// The time a Bitcoin block header says it was mined (seconds), from its 80 raw bytes as hex: bytes 68..72, little-endian.
export function headerTimeSec(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{160}$/.test(h)) return null;
  const le = h.slice(136, 144).match(/../g).reverse().join('');
  return parseInt(le, 16);
}

// → { wait, ref, why }
//   history     base fees of recent blocks (wei); the caller passes what eth_feeHistory returned without the next block's
//   nextBase    the next block's base fee (wei): what a transaction sent now pays
//   readyAgeSec how long the batch has been ready (the age of the header that made it a full batch)
// No reading, or a short history, never holds a batch.
export function baseFeeWait({ history, nextBase, readyAgeSec, maxWaitSec = 7200, percentile = 40, ratio = 1, minHistory = 64 }) {
  const hs = Array.isArray(history) ? history : [];
  if (nextBase == null || hs.length < minHistory) return { wait: false, ref: null, why: 'no reading' };
  const ref = percentileOf(hs, percentile);
  if (!(Number(readyAgeSec) < maxWaitSec)) return { wait: false, ref, why: 'waited long enough' };
  const permille = BigInt(Math.round(Number(ratio) * 1000));
  if (big(nextBase) * 1000n > ref * permille) return { wait: true, ref, why: 'above what recent blocks paid' };
  return { wait: false, ref, why: 'cheap enough' };
}
