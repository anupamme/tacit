// The public TAC on Ethereum against what backs it, read from chain. TAC is etched on Bitcoin with a fixed 21,000,000
// supply, and the pool mints the ERC-20 only against proof, so its supply can never exceed the etch. wTAC holds one TAC
// per wTAC. A canonical token is registered in the pool once, under its own asset id; a second registration under the
// token's local EVM id would let a differently-scaled asset pay out the same token. And a retired TAC token, whose
// pool no longer runs, keeps the supply it had.
//
// → { level: 'ok' | 'warning' | 'critical', why: string[] }

import { sha256, concat, toHex, pad, numberToHex } from 'viem';

export const TAC_ASSET_ID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const TAC_ETCH_SUPPLY = 21_000_000n * 10n ** 18n;   // 21,000,000 TAC at the ERC-20's 18 decimals

// ConfidentialPool._evmAssetId: sha256("tacit-evm-token-v1" ‖ chainid (u64 BE) ‖ address).
export function evmAssetId(chainId, address) {
  return sha256(concat([toHex('tacit-evm-token-v1'), pad(numberToHex(BigInt(chainId)), { size: 8 }), address]));
}

const tac = (w) => `${(Number(w / 10n ** 10n) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} TAC`;

export function tacSupplyVerdict({ supply, wtac, shadowRegistered = [], legacy = [] }) {
  const why = [];
  let level = 'ok';
  const raise = (l, msg) => { why.push(msg); if (l === 'critical' || level === 'ok') level = l; };
  if (BigInt(supply) > TAC_ETCH_SUPPLY) raise('critical', `the TAC ERC-20 supply is ${tac(BigInt(supply))}, over the 21,000,000 etched on Bitcoin`);
  if (wtac && BigInt(wtac.backing) < BigInt(wtac.supply)) {
    raise('critical', `wTAC holds ${tac(BigInt(wtac.backing))} TAC against ${tac(BigInt(wtac.supply))} wTAC`);
  }
  for (const t of shadowRegistered) raise('warning', `the pool has a second asset registered over canonical token ${t.token} (asset ${t.assetId}); integrators must identify assets by id`);
  for (const l of legacy) {
    if (BigInt(l.supply) !== BigInt(l.expected)) raise('warning', `retired TAC token ${l.token} has ${tac(BigInt(l.supply))}, expected ${tac(BigInt(l.expected))}`);
  }
  if (!why.length) why.push(`TAC ERC-20 supply ${tac(BigInt(supply))}${wtac ? `, wTAC backed ${tac(BigInt(wtac.backing))} / ${tac(BigInt(wtac.supply))}` : ''}`);
  return { level, why };
}

const ERC20 = [
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const POOL_ASSETS = [
  { type: 'function', name: 'canonicalTokenFor', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'assets', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [
    { type: 'bool' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bool' }, { type: 'uint8' }] },
];

// client: a viem public client. canonicalTokens: the pool's pool-minted tokens (TAC is found through the pool itself).
// legacy: [{ token, expected }] retired TAC tokens and their final supply (wei).
export async function readTacSupply({ client, chainId, pool, wtac = null, canonicalTokens = [], legacy = [] }) {
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const tacToken = await read(pool, POOL_ASSETS, 'canonicalTokenFor', [TAC_ASSET_ID]);
  const supply = await read(tacToken, ERC20, 'totalSupply');
  const wtacState = wtac
    ? { supply: await read(wtac, ERC20, 'totalSupply'), backing: await read(tacToken, ERC20, 'balanceOf', [wtac]) }
    : null;
  const shadowRegistered = [];
  for (const token of [tacToken, ...canonicalTokens]) {
    const assetId = evmAssetId(chainId, token);
    const [registered] = await read(pool, POOL_ASSETS, 'assets', [assetId]);
    if (registered) shadowRegistered.push({ token, assetId });
  }
  const legacyState = [];
  for (const l of legacy) legacyState.push({ ...l, supply: await read(l.token, ERC20, 'totalSupply') });
  return { tacToken, ...tacSupplyVerdict({ supply, wtac: wtacState, shadowRegistered, legacy: legacyState }) };
}
