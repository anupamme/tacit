
export const POINTS = 'https://tacit-points.onrender.com';

export async function readLiquidity(json) {
  const j = await json(`${POINTS}/lp`);
  if (!j?.enabled) return null;
  const t = j.terms?.dailyWei != null ? j.terms : j.next?.dailyWei != null ? j.next : null;
  if (!t) return null;
  const unopened = Array.isArray(j.pools) && j.pools.some((p) => !p.openPaid);
  return { daily: BigInt(t.dailyWei), create: BigInt(t.createWei || 0), from: j.terms?.dailyWei != null ? null : j.next.fromDay, endSec: Number(j.endSec) || 0, bonusOpen: unopened };
}

export async function readTasks(json) {
  const j = await json(`${POINTS}/tasks`);
  return j?.enabled && j.budget ? { left: BigInt(j.budget.remainingWei), endSec: Number(j.endSec) || 0 } : null;
}
