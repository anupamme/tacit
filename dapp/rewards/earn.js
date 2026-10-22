
export const POINTS = 'https://tacit-points.onrender.com';

export async function readTasks(json) {
  const j = await json(`${POINTS}/tasks`);
  return j?.enabled && j.budget ? { left: BigInt(j.budget.remainingWei), endSec: Number(j.endSec) || 0 } : null;
}
