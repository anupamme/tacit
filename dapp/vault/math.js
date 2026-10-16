// The vault's arithmetic, step for step as TacVault.sol does it (integers, division rounding down), so that what the page shows, suggests and
// sends is what the contract accepts. Pure: no DOM, no network. Amounts are 18-decimal bigints, ratios are in basis points, prices are SYNTH per
// TAC scaled by 1e18 (the contract's `valueOf(1e18, true)` and `liquidationPrice()`).
//
// Which way each figure rounds: what can be borrowed or withdrawn and the ratio shown round down, what must be added and the liquidation price
// round up, so a suggestion is never one the contract refuses and a margin is never overstated.

export const BPS = 10000n, WAD = 10n ** 18n, MAX_UINT = (1n << 256n) - 1n;

const min = (a, b) => (a < b ? a : b);
const ceilDiv = (a, b) => (a + b - 1n) / b;

// The synth value of `tac` at `price`: TacVault._value.
export const valueOf = (tac, price) => tac * price / WAD;
// The vault's ratio, rounded down; null with no debt.
export const ratioBps = (value, debt) => (debt > 0n ? value * BPS / debt : null);

// ── what the vault is open to, at the liquidation view ──
// 'none' (no debt), 'liquidation' (an auction may start: under `liq`), 'redemption' (from `liq` up to twice it: a holder of the synth may redeem
// against it) or 'safe'. The comparisons are the contract's own cross-multiplications.
export function zoneOf({ collateral, debt, price, liq }) {
  if (debt === 0n) return 'none';
  const v = valueOf(collateral, price) * BPS;
  if (v < debt * liq) return 'liquidation';
  if (v < debt * 2n * liq) return 'redemption';
  return 'safe';
}

// The least collateral at which `debt` is at most 1/`bps` of its value at `price`, that is value × BPS ≥ debt × bps, as the contract tests it.
export const collateralFor = (debt, price, bps) => ceilDiv(ceilDiv(debt * bps, BPS) * WAD, price);

// TAC to add so that the vault stands at `bps` or more at `price` (rounded up to `dp` decimals, so adding exactly it is enough).
export function topUp({ collateral, debt, price, bps, dp = 2 }) {
  if (debt === 0n || !price) return 0n;
  const need = collateralFor(debt, price, bps);
  return need > collateral ? ceilTo(need - collateral, dp) : 0n;
}

// The price at which the vault is at `liq` (rounded up: the danger is never later than shown). Needs collateral and debt.
export const liquidationPriceOf = (collateral, debt, liq) => (collateral > 0n && debt > 0n ? ceilDiv(debt * liq * WAD, collateral * BPS) : null);

// ── borrowing ──
export const feeOf = (amount, feeBps) => amount * feeBps / BPS;
// The largest amount whose debt (itself plus its fee) fits in `room`: the debt of `a` is a + floor(a × fee / BPS), which only grows with a.
export function amountForDebt(room, feeBps) {
  let lo = 0n, hi = room;
  while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (mid + feeOf(mid, feeBps) <= room) lo = mid; else hi = mid - 1n; }
  return lo;
}
// The smallest amount whose debt is at least `debt`.
export function amountForAtLeast(debt, feeBps) {
  if (debt <= 0n) return 0n;
  let a = ceilDiv(debt * BPS, BPS + feeBps);
  while (a + feeOf(a, feeBps) < debt) a++;
  while (a > 0n && a - 1n + feeOf(a - 1n, feeBps) >= debt) a--;
  return a;
}
// What the whole market lends now, less what is lent: min(owner's ceiling, depth's share) − total debt, never below zero.
export const sharedRoom = ({ debtCeiling, depthCeiling, totalDebt }) => { const cap = min(debtCeiling, depthCeiling); return cap > totalDebt ? cap - totalDebt : 0n; };
// What this vault may owe in all at the borrow view and `mint` bps.
export const maxDebt = ({ collateral, pB, mint }) => valueOf(collateral, pB) * BPS / mint;

// How much this vault can borrow (the amount it receives): the lesser of its own limit (debt at most 1/`mint` of its collateral's value at the borrow
// view) and the room the whole market has left, less the fee that rides on top; zero when the debt that would follow is under `minDebt`.
export function borrowLimit({ collateral, debt, pB, mint, feeBps, room, minDebt }) {
  const own = maxDebt({ collateral, pB, mint }), ownRoom = own > debt ? own - debt : 0n;
  let amount = amountForDebt(min(ownRoom, room), feeBps);
  if (amount > 0n && debt + amount + feeOf(amount, feeBps) < minDebt) amount = 0n;
  return { amount, ownRoom, binding: amount === 0n ? null : room < ownRoom ? 'room' : 'own' };
}
// A typed borrow: ok, or the first reason it would be refused, with the figures that go with it.
export function checkBorrow({ amount, collateral, debt, pB, mint, feeBps, room, minDebt }) {
  const fee = feeOf(amount, feeBps), owe = debt + amount + fee, out = { fee, owe };
  if (amount <= 0n) return { ...out, ok: false, why: 'zero' };
  if (owe < minDebt) return { ...out, ok: false, why: 'min', least: amountForAtLeast(minDebt - debt, feeBps) };
  const lim = borrowLimit({ collateral, debt, pB, mint, feeBps, room, minDebt: 0n });
  // Over what the vault's TAC allows, or over what the market has left (whichever is the smaller says why), with the most that would go through.
  if (owe - debt > min(lim.ownRoom, room)) return { ...out, ok: false, why: lim.ownRoom <= room ? 'own' : 'room', limit: lim.amount };
  return { ...out, ok: true };
}
// TAC to add so that a debt of `owe` is within the borrowing line (at the borrow view).
export const addToBorrow = ({ collateral, owe, pB, mint, dp = 2 }) => topUp({ collateral, debt: owe, price: pB, bps: mint, dp });

// ── withdrawing ──
// The most TAC that can leave: all of it with no debt, else what keeps the debt within the borrowing line at the borrow view.
export function withdrawLimit({ collateral, debt, pB, mint }) {
  if (debt === 0n) return collateral;
  if (!pB) return 0n;
  const keep = collateralFor(debt, pB, mint);
  return collateral > keep ? collateral - keep : 0n;
}

// ── repaying ──
// What can be repaid with `balance` of the synth: all of it when the balance covers the debt, else the most that leaves zero or at least `minDebt`.
export function repayLimit({ debt, balance, minDebt }) {
  if (debt === 0n) return { max: 0n, all: false };
  if (balance >= debt) return { max: debt, all: true };
  const part = debt > minDebt ? debt - minDebt : 0n;
  return { max: min(balance, part), all: false };
}
// A typed repayment: an amount at or over the debt repays all of it, as the contract does.
export function checkRepay({ amount, debt, balance, minDebt }) {
  const paid = min(amount, debt), left = debt - paid;
  if (amount <= 0n || debt === 0n) return { ok: false, why: 'zero', paid, left, all: false };
  const all = amount >= debt;
  if (left !== 0n && left < minDebt) return { ok: false, why: 'min', paid, left, all };
  if (paid > balance) return { ok: false, why: 'balance', paid, left, all };
  return { ok: true, paid, left, all };
}

// ── the health bar ──
// A line from 100% to 500%: liquidation under `liq`, redemption up to twice it, safe beyond. Positions are fractions of the width.
export const BAR = { lo: 10000, hi: 50000 };
export const barPos = (bps, { lo, hi } = BAR) => Math.min(1, Math.max(0, (Number(bps) - lo) / (hi - lo)));
// The borrowing line, in the bar's terms (ratios at the liquidation view): where the borrow view's `mint` falls when the two prices differ.
export const borrowLineBps = ({ mint, pL, pB }) => (pL && pB ? mint * pL / pB : mint);

// ── rounding and writing amounts ──
// To `dp` decimals of an 18-decimal amount, down or up.
export const floorTo = (v, dp, dec = 18) => { const u = 10n ** BigInt(dec - dp); return v / u * u; };
export const ceilTo = (v, dp, dec = 18) => { const u = 10n ** BigInt(dec - dp); return ceilDiv(v, u) * u; };
// To `digits` significant digits, down or up (prices).
export function sigTo(v, digits, dir) {
  const len = v.toString().length;
  if (v <= 0n || len <= digits) return v;
  const u = 10n ** BigInt(len - digits);
  return dir === 'up' ? ceilDiv(v, u) * u : v / u * u;
}
// Written out, the digits past `max` dropped (rounding down), thousands grouped.
export function fmtUnits(v, dec = 18, max = 4) {
  let n = BigInt(v);
  const neg = n < 0n;
  if (neg) n = -n;
  const base = 10n ** BigInt(dec), frac = (n % base).toString().padStart(dec, '0').slice(0, max).replace(/0+$/, '');
  return `${neg ? '−' : ''}${(n / base).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
// An amount with at least its first two significant digits, so a small one does not read as 0 (rounding down, to at most 12 decimals).
export function fmtAmount(v, dp = 2, dec = 18) {
  const n = BigInt(v);
  let d = dp;
  while (n > 0n && d < 12 && fmtUnits(n, dec, d).replace(/[^1-9]/g, '').length < 2) d++;
  return fmtUnits(n, dec, d);
}
// The digits of an amount for an input box: no grouping, no trailing zeros.
export const plain = (v, dec = 18) => fmtUnits(v, dec, dec).replace(/,/g, '');
// An amount as the front page reads it: a comma between digits is a thousands separator only where it plainly is one (1,500.25 or 1,000,000),
// a lone comma is a decimal point (0,05), and an ambiguous 1,500 is left unread rather than guessed. Anything else with a comma is unread.
export function parseUnits(text, dec = 18) {
  let t = String(text ?? '').trim().replace(/[_\s]/g, '');
  if (t.includes(',')) {
    if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d*)?$/.test(t) && (t.includes('.') || t.indexOf(',') !== t.lastIndexOf(','))) t = t.replace(/,/g, '');
    else if (/^\d*,\d*$/.test(t) && !/^[1-9]\d{0,2},\d{3}$/.test(t)) t = t.replace(',', '.');
    else return null;
  }
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  if (f.length > dec) return null;
  return BigInt(w || '0') * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}
// A length of time in words: "2 days 3 h", "5 h 20 min", "12 min".
export const span = (s) => {
  s = Math.max(0, Math.round(Number(s)));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} day${d > 1 ? 's' : ''}${h ? ` ${h} h` : ''}`;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  return `${Math.max(1, m)} min`;
};
// A countdown, m:ss.
export const clock = (s) => { s = Math.max(0, Math.ceil(Number(s))); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
