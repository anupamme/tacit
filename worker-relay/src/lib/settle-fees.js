// What a settle needs in the settle wallet, reckoned once for the service that sends it and the monitor that pages on it, so the
// two cannot drift apart (they did: the monitor paged on a figure the relay no longer asked for).
import { CFG } from './config.js';
import { readTip } from './gas-tip.js';
import { fundsNeed, toMult } from './fee-cap.js';

// The smallest total priority payment worth a builder's attention: a floor on the total rather than on the rate, so a
// 350k-gas settle stays worth including without a 3.5M-gas batch paying the same rate for it.
export const SETTLE_TIP_MIN_TOTAL_WEI = BigInt(process.env.SETTLE_TIP_MIN_TOTAL_WEI || '20000000000000'); // 0.00002 ETH
export const SETTLE_TIP_CAP_WEI = BigInt(process.env.SETTLE_TIP_CAP_WEI || '2000000000'); // 2 gwei
// The fee cap's multiplier of the base fee: the full one a funded wallet sends with, and the floor a short one will.
export const CAP_MULT_MAX = toMult(process.env.SETTLE_CAP_MULT_MAX || '3');
export const CAP_MULT_MIN = toMult(process.env.SETTLE_CAP_MULT_MIN || '1.5');

let cached = { at: 0, tip: null };
// The tip a settle would offer now, read from the same fee history the send reads, and kept for TTL_MS (the gate runs every
// poll, a few seconds apart).
export async function settleTipNow(client, { ttlMs = 30_000 } = {}) {
  if (cached.tip != null && Date.now() - cached.at < ttlMs) return cached.tip;
  const tip = await readTip(client, { gas: CFG.settleFundsGas, minTotalWei: SETTLE_TIP_MIN_TOTAL_WEI, capWei: SETTLE_TIP_CAP_WEI, fallbackWei: CFG.settleTipFloorWei });
  cached = { at: Date.now(), tip };
  return tip;
}

// → { need, base, tip }: the ETH the settle wallet must hold for the next settle to be sent, at the live base fee.
export async function settleFundsNeed(client, { block } = {}) {
  const blk = block || await client.getBlock({ blockTag: 'latest' });
  const base = blk.baseFeePerGas ?? 0n, tip = await settleTipNow(client);
  return { need: fundsNeed({ gas: CFG.settleFundsGas, base, tip, minMult: CAP_MULT_MIN }), base, tip };
}
