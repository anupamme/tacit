// What pays TAC, read for the list on the rewards page: the Precision farm (and what one account has in it), the private farms, the liquidity
// campaign and the task budget. Each read stands alone and gives null when its source does not answer, so the list shows what it has and
// leaves the rest as a plain row. Money is BigInt wei; an APR is a plain number of percent, the farm's own arithmetic (TAC streamed a year,
// at the pool's price, over what is staked, both in ETH).

export const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E', FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0';
export const POINTS = 'https://tacit-points.onrender.com';
const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const wordOf = (a) => a.slice(2).toLowerCase().padStart(64, '0');

// The Precision farm: its stream, its stake and the pool's price. `call({ to, data })` is an eth_call returning hex. Null when it cannot be read.
export async function readPrecision(call) {
  const farm = await Promise.all([[POOL, '0x443cb4bc'], [POOL, '0x5a76f25e'], [POOL, '0x18160ddd'], [POOL, '0x2af1f249'], [FARM, '0x817b1cd2'], [FARM, '0x7b0a47ee'], [FARM, '0xebe2b12b']]
    .map(([to, data]) => call({ to, data }).then(BigInt))).catch(() => null);
  if (!farm) return null;
  const [r0, r1, supply, sp, totalStaked, rate, finish] = farm;
  const sq = Number(sp) / 1e18, tacEth = sq > 0 ? 1 / (sq * sq) : 0;
  const live = tacEth > 0 && Date.now() / 1000 < Number(finish);
  const stakedEth = supply > 0n ? (Number(r0) + Number(r1) * tacEth) * Number(totalStaked) / Number(supply) : 0;          // ETH wei
  return { r0, r1, supply, tacEth, live, finish: Number(finish), perDay: live ? rate * 86400n : 0n, stakedEth, apr: live && stakedEth > 0 ? Number(rate) * 86400 * 365 * tacEth / stakedEth * 100 : null };
}

// What one account has in the farm: staked, earned, and pool shares it holds that are not staked, with the ETH and TAC the stake is worth at the
// pool's reserves. Null when the account's figures cannot be read.
export async function readStake(call, who, f) {
  const m = await Promise.all([[FARM, '0x98807d84'], [FARM, '0x008cc262'], [POOL, '0x70a08231']].map(([to, sel]) => call({ to, data: `${sel}${wordOf(who)}` }).then(BigInt))).catch(() => null);
  if (!m) return null;
  const [staked, earned, loose] = m, ok = f && f.supply > 0n;
  return { staked, earned, loose, eth: ok ? staked * f.r0 / f.supply : 0n, tac: ok ? staked * f.r1 / f.supply : 0n };
}

// The private farms, from the farm program the API publishes: one row for each pool that has a stream, with its APR at the Precision pool's price.
// A name is the pair with tETH first ("tETH / TAC"), as on the swap page.
export function privateFarms(program, tacEth) {
  if (!program?.epoch?.active) return [];
  return (program.pools || []).filter((p) => Number(p.tacPerDayForPool) > 0).map((p) => {
    const r = p.reserves || {}, total = Number(r.lpTotalShares || 0);
    const bonded = String(r.assetA).toLowerCase() === CETH && total && tacEth ? 2 * Number(r.reserveA) / 1e8 * Number(p.totalShares) / total : 0;      // ETH: the tETH side, twice, for the shares bonded
    const k = String(p.pair).split('/').map((x) => (x === 'cETH' ? 'tETH' : x));
    if (k[1] === 'tETH') k.reverse();
    return { pid: Number(p.pid), name: k.join(' / '), icons: k.map((x) => x.toLowerCase()), perDay: Number(p.tacPerDayForPool), apr: bonded > 0 ? Number(p.tacPerDayForPool) * 365 * tacEth / bonded * 100 : null };
  });
}

// What the liquidity campaign pays now (or, when its terms have not started, from the day they do): a daily reward for supplying a Borrow market
// and a bonus for opening one. Null when the service says nothing or the campaign is off.
export async function readLiquidity(json) {
  const j = await json(`${POINTS}/lp`);
  if (!j?.enabled) return null;
  const t = j.terms?.dailyWei != null ? j.terms : j.next?.dailyWei != null ? j.next : null;
  if (!t) return null;
  const unopened = Array.isArray(j.pools) && j.pools.some((p) => !p.openPaid);
  return { daily: BigInt(t.dailyWei), create: BigInt(t.createWei || 0), from: j.terms?.dailyWei != null ? null : j.next.fromDay, endSec: Number(j.endSec) || 0, bonusOpen: unopened };
}

// What is left in the task budget: small jobs paid in TAC, each repaying its network fees with a tip.
export async function readTasks(json) {
  const j = await json(`${POINTS}/tasks`);
  return j?.enabled && j.budget ? { left: BigInt(j.budget.remainingWei), endSec: Number(j.endSec) || 0 } : null;
}
