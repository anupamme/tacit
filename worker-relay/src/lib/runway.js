// How long a relay wallet's gas lasts — pure arithmetic, so it can be tested with real numbers.
//
// Days, not "settles left": a wallet that carries BOTH roles (the merged relayer key) pays for the maintenance
// lane as well as the settles, and maintenance costs about as much per day as the settles do at any realistic
// volume.

// Gas the wallet burns per day, from the roles it carries. The relay role's burn is the measured figure (`relayBurnGasPerDay`,
// RELAY_BURN_GAS_PER_DAY: headers and attests as they actually ran) when given, else the maintenance model.
export function burnGasPerDay({ roles, maintenanceRunsPerDay = 0, relayBurnGasPerDay = null, expectedOpsPerDay, gas }) {
  let g = 0n;
  if (roles.includes('relay')) g += relayBurnGasPerDay != null ? BigInt(relayBurnGasPerDay) : BigInt(Math.round(maintenanceRunsPerDay)) * gas.maintenance;
  if (roles.includes('settle')) g += BigInt(Math.round(expectedOpsPerDay)) * gas.transfer;
  return g;
}

// Days of gas left at a gas price, or null when it cannot be computed (no price, or nothing burned).
export function runwayDays({ balanceWei, gasPriceWei, ...burn }) {
  const perDay = burnGasPerDay(burn) * BigInt(gasPriceWei ?? 0);
  if (perDay <= 0n) return null;
  return Number(balanceWei) / Number(perDay);
}
