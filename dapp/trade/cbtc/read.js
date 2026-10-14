// What the cBTC page reads and how each figure on it is worked out. cBTC is bitcoin locked at an address only its owner's key can spend, backed by
// a refundable ETH bond (held as wstETH) and minted one for one in the Tacit pool; against it cUSD is borrowed. So the page follows four things: the
// locks on Bitcoin (their sats, the bond behind them, how many are minted), the loans taken against the cBTC, the pools in the private AMM that hold
// it, and (with a key open) what that key has in each. The arithmetic is plain functions of what was read, so tests can pin it.
import { MULTICALL3, TAC_POOL_ASSET_ID, CETH_POOL_ASSET_ID, _internal } from '/evm-trade-venues.js?cb=bb675102';
import { keccak_256 } from '/vendor/tacit-deps.min.js';
import { ethCall, wordAt, word, strip } from '/trade/util.js?cb=369d2824';
import { POOL } from '/trade/teth/read.js?cb=cb8cb803';

export const ENGINE = '0x000000003f608BDdF0ca45934003ffb9DbDF70DB';                 // the collateral engine: prices bitcoin, holds the bonds, lends cUSD
export const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
export const CBTC_ID = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';      // cBTC in the pool: pinned at its construction, the same on Bitcoin's side
export const CUSD_ID = '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d';
export const TAC_ID = TAC_POOL_ASSET_ID, CETH_ID = CETH_POOL_ASSET_ID;
const SEL = { cdpRatioBps: '0x4827ecb3', liqRatioBps: '0x1432d93f', btcToUsd: '0xd5901347', wstEthForBtc: '0x7dd55c2b', stEthPerWst: '0xbb2952fc', requiredEscrow: '0x034448ed',
  escrowSufficient: '0x058e18b0', cbtcLockVBtc: '0x7cea1c1a', cbtcMinted: '0xe2c2a40c', pools: '0xb5217bb4' };
const BTC1 = 10n ** 8n;
const big = (x) => BigInt(x != null && typeof x === 'object' && '$n' in x ? x.$n : x ?? 0);

const batch = async (calls) => _internal.decAggregate3(await ethCall(MULTICALL3, _internal.encAggregate3(calls)), calls.length);

// ── the protocol's totals: the stats reading's `btc` part ──
// Sats locked and how many locks, sats minted against them and how many, the bond (wstETH wei) and how many bonds, the cUSD (8 decimals) borrowed,
// repaid and still out, loans open, locks given up (`unlocked`) or redeemed, and the public ERC-20s' supplies (18 decimals).
export function totalsOf(j) {
  const b = j?.btc;
  if (!b) return null;
  return { locked: big(b.locked), locks: Number(b.nLocked) || 0, minted: big(b.mint), mints: Number(b.nMint) || 0, bond: big(b.bonds), bonds: Number(b.nBonds) || 0,
    borrowed: big(b.borrowed), repaid: big(b.repaid), liquidated: big(b.liq), out: big(b.out), open: Number(b.open) || 0, redeemed: Number(b.redeemed) || 0, unlocked: Number(b.unlocked) || 0,
    waiting: Number(b.waiting) || 0, tacbtc: big(b.tacbtc), tacusd: big(b.tacusd) };
}

// ── the engine: its price of bitcoin, its loan lines, and what a wstETH is worth ──
// `usdBtc`: dollars a bitcoin, as the engine prices the loans (the front page's own BTC price). `ratio`/`liq`: the floor a loan is opened above and the
// line it is liquidated below, in percent. `ethBtc`: ETH a bitcoin costs through wstETH. `wstEth`: stETH (about ETH) one wstETH is worth.
export async function readEngine() {
  const r = await batch([{ to: ENGINE, data: SEL.cdpRatioBps }, { to: ENGINE, data: SEL.liqRatioBps }, { to: ENGINE, data: SEL.btcToUsd + word(BTC1) },
    { to: ENGINE, data: SEL.wstEthForBtc + word(BTC1) }, { to: WSTETH, data: SEL.stEthPerWst + word(10n ** 18n) }]);
  const n = (i) => (r[i] ? wordAt(r[i], 0) : null);
  const wst = n(4) != null ? Number(n(4)) / 1e18 : null;
  return { ratio: n(0) != null ? Number(n(0)) / 100 : null, liq: n(1) != null ? Number(n(1)) / 100 : null, usdBtc: n(2) != null ? Number(n(2)) / 1e8 : null,
    ethBtc: n(3) != null && wst ? (Number(n(3)) / 1e18) * wst : null, wstEth: wst };
}
// What a lock of `sats` needs bonded now (wstETH wei) and what that is in ETH: the engine's own requirement, which sits above the 1.5× floor.
export async function sizeBond(sats) {
  const [need, rate] = await batch([{ to: ENGINE, data: SEL.requiredEscrow + word(sats) }, { to: WSTETH, data: SEL.stEthPerWst + word(10n ** 18n) }]);
  if (!need) return null;
  const wst = wordAt(need, 0), per = rate ? wordAt(rate, 0) : null;
  return { wst, eth: per != null ? (wst * per) / 10n ** 18n : null };
}

// How far the bonds cover the locks: the bonds' ETH value over the locks' value. The engine asks for 1.5× or more at each lock, so the sum sits above that.
export function coverage(t, { ethUsd, usdBtc, wstEth }) {
  if (!t || !(t.locked > 0n) || !ethUsd || !usdBtc || !wstEth) return null;
  const bondUsd = Number(t.bond) / 1e18 * wstEth * ethUsd, lockUsd = Number(t.locked) / 1e8 * usdBtc;
  return { bondUsd, lockUsd, ratio: lockUsd > 0 ? bondUsd / lockUsd : null };
}

// ── the private pools that hold cBTC ──
// A pool's id is keccak(lower asset id, higher, fee as 32 bytes); the pool contract's `pools(id)` gives its reserves. cBTC's pairs are looked for at
// each fee tier (only the 0.30% tier is founded today), and a pool with reserves is a row: the pair, both sides at the pool's 8 decimals, the price
// of a cBTC in the other asset, and how deep it is in ETH (twice the tETH side, or the cBTC side at the engine's price). `farm` is its entry in the
// farming program, which pays TAC to those who bond its liquidity.
const hexBytes = (h) => Uint8Array.from(strip(h).match(/../g).map((x) => parseInt(x, 16)));
export function poolId(a, b, fee) {
  const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a], u = new Uint8Array(96);
  u.set(hexBytes(lo), 0); u.set(hexBytes(hi), 32); u.set(hexBytes(word(fee)), 64);
  return Array.from(keccak_256(u), (x) => x.toString(16).padStart(2, '0')).join('');
}
const TIERS = [30, 5, 100, 1], OTHERS = [['tETH', CETH_ID], ['TAC', TAC_ID], ['cUSD', CUSD_ID]];
export async function readPools() {
  const asks = OTHERS.flatMap(([name, id]) => TIERS.map((fee) => ({ name, id, fee })));
  const r = await batch(asks.map((x) => ({ to: POOL, data: SEL.pools + poolId(CBTC_ID, x.id, x.fee) })));
  const out = [];
  asks.forEach((x, i) => {
    const h = r[i];
    if (!h || strip(h).length < 64 * 7 || wordAt(h, 0) === 0n) return;
    const a = wordAt(h, 3), b = wordAt(h, 4), total = wordAt(h, 6);
    if (a === 0n || b === 0n) return;
    const cbtcIsA = BigInt(CBTC_ID) < BigInt(x.id);
    out.push({ other: x.name, otherId: x.id, fee: x.fee, cbtc: Number(cbtcIsA ? a : b) / 1e8, side: Number(cbtcIsA ? b : a) / 1e8, lpTotal: Number(total) });
  });
  return out.filter((p, i, all) => all.findIndex((q) => q.other === p.other) === i);          // the first tier that holds reserves
}
// Each pool as a row: the price of a cBTC in dollars (`usd`), against the engine's price of bitcoin (`gap`), and the pool's depth in dollars.
export function poolRows(pools, program, { ethUsd, usdBtc, tacEth }) {
  return pools.map((p) => {
    const per = p.cbtc > 0 ? p.side / p.cbtc : null;                                               // the other asset per cBTC
    const usd = per == null ? null : p.other === 'tETH' ? (ethUsd ? per * ethUsd : null) : p.other === 'TAC' ? (tacEth && ethUsd ? per * tacEth * ethUsd : null) : per;
    const depth = usdBtc ? 2 * p.cbtc * usdBtc : null;
    const farm = (program?.pools || []).find((f) => String(f.pair).split('/').sort().join('/') === ['cBTC', p.other === 'tETH' ? 'cETH' : p.other].sort().join('/')) || null;
    return { ...p, name: `cBTC / ${p.other}`, per, usd, gap: usd != null && usdBtc ? usd / usdBtc - 1 : null, depthUsd: depth, farm: farm ? { pid: Number(farm.pid), perDay: Number(farm.tacPerDayForPool) || 0, shares: Number(farm.totalShares) || 0 } : null };
  });
}
// A farm's APR: a year of its TAC at TAC's price over what is bonded in it, counted as twice the cBTC side at the engine's price.
export function farmApr(row, program, { usdBtc, ethUsd, tacEth }) {
  if (!row.farm || !(row.farm.perDay > 0) || !usdBtc || !ethUsd || !tacEth || !(row.lpTotal > 0)) return null;
  const bondedUsd = 2 * row.cbtc * usdBtc * row.farm.shares / row.lpTotal;
  return bondedUsd > 0 ? (row.farm.perDay * 365 * tacEth * ethUsd) / bondedUsd * 100 : null;
}

// ── what a key has: its locks on Bitcoin, read from the key's own Bitcoin history, each with where it stands ──
// A lock is "ready to mint" once Bitcoin's proof on Ethereum has recorded it and the bond is enough; "waiting for its proof" before; "post its bond"
// when the bond is short; "minted" once cBTC was made against it. A lock the pool has retired (spent or redeemed) is not listed.
export const lockStep = (l) => (l.minted ? 'minted' : !l.bonded ? 'post its bond' : !l.recorded ? 'waiting for its proof' : 'ready to mint');
export async function readLocks({ ux, priv, hist }) {
  const all = await hist.locks(priv);
  const states = await Promise.all(all.map((l) => ux.cbtcLockState(l.lockTxid, l.lockVout)));
  const live = all.filter((_, i) => !states[i].spent && !states[i].redeemed);
  if (!live.length) return [];
  const op = (l) => strip(ux.pool.outpointKey('0x' + l.lockTxid.match(/../g).reverse().join(''), l.lockVout));
  const r = await batch(live.flatMap((l) => [{ to: POOL, data: SEL.cbtcLockVBtc + op(l) }, { to: ENGINE, data: SEL.escrowSufficient + op(l) + word(l.vBtc) }, { to: POOL, data: SEL.cbtcMinted + op(l) }]));
  const w = (i) => (r[i] ? wordAt(r[i], 0) : 0n);
  return live.map((l, i) => ({ ...l, sats: BigInt(l.vBtc), recorded: w(3 * i) === BigInt(l.vBtc), bonded: w(3 * i + 1) === 1n, minted: w(3 * i + 2) === 1n }));
}
// The loans a key has: each live position with the cBTC it holds as collateral and what it owes (cUSD, 8 decimals).
export async function readLoans({ ux, priv }) {
  const cdp = await ux.recoverCdpPositions({ walletPriv: priv });
  const id = CBTC_ID.toLowerCase();
  return (cdp?.positions || []).filter((p) => p.live !== false).map((p) => ({ debt: BigInt(p.debtValue || 0), cbtc: (p.basket || []).filter((l) => String(l.asset).toLowerCase() === id).reduce((a, l) => a + BigInt(l.value), 0n) }));
}
// The key's private cBTC and cUSD: the notes it holds, from one scan (the cBTC notes are found from the key's own Bitcoin history, which that scan reads).
export async function readHeld({ ux, priv }) {
  const r = await ux.balance(priv, { cbtc: true, bridge: false });
  const of = (id) => { const g = r.byAsset?.[String(id).toLowerCase()]; return { value: g ? BigInt(g.value) : 0n, notes: g?.notes?.length || 0 }; };
  return { cbtc: of(CBTC_ID), cusd: of(CUSD_ID), partial: Object.keys(r.diag?.errors || {}).length > 0 };
}
