// What the replenish pass does with the fee income the ledger counted (lib/income-ledger.js): how much of it goes to the TAC buyback and
// when. Pure, so the decisions are tested to the wei and the code that moves ETH stays thin.
//
// The commitment is a share of what the relay EARNS, not of what is left: `bps` of every ETH or convertible fee, taken each pass. The wallet
// that earns it also pays the settle gas, so a share is only sent while the wallet keeps `keepWei` for the next settles; what could not be
// sent is carried as owed (up to a cap) and goes the first pass the wallet can spare it. Nothing is ever skipped silently: a share not paid
// is a share owed.

const min = (a, b) => (a < b ? a : b);

export function planBuyback({ baseUsd = 0, ethUsd, bps = 0, owedWei = 0n, balanceWei = 0n, keepWei = 0n, minSendWei = 0n, owedCapWei = 0n } = {}) {
  const owed = BigInt(owedWei), bal = BigInt(balanceWei), keep = BigInt(keepWei), minSend = BigInt(minSendWei), cap = BigInt(owedCapWei);
  const share = Math.max(0, Math.min(10000, Math.floor(Number(bps) || 0)));
  if (share === 0) return { payWei: 0n, owedAfterWei: owed, dueWei: owed, earnedWei: 0n, reason: 'off' };
  const px = Number(ethUsd), usd = Number(baseUsd);
  const earnedWei = Number.isFinite(px) && px > 0 && Number.isFinite(usd) && usd > 0 ? BigInt(Math.floor((usd / px) * 1e18)) : 0n;
  const dueWei = owed + (earnedWei * BigInt(share)) / 10000n;
  if (dueWei === 0n) return { payWei: 0n, owedAfterWei: 0n, dueWei, earnedWei, reason: 'nothing due' };
  const spare = bal > keep ? bal - keep : 0n;
  const pay = min(dueWei, spare);
  if (pay === 0n || pay < minSend) return { payWei: 0n, owedAfterWei: min(dueWei, cap), dueWei, earnedWei, reason: 'carried' };
  return { payWei: pay, owedAfterWei: min(dueWei - pay, cap), dueWei, earnedWei, reason: 'pay' };
}

// A splitter holding at least `minWei` is sent on: below it the gas of sending would be a real share of what moves.
export const splitterDue = (balanceWei, minWei) => BigInt(balanceWei) > 0n && BigInt(balanceWei) >= BigInt(minWei);
