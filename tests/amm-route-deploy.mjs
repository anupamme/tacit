// TacitAmmRoute's init code from this checkout's forge build, and the CreateX call that deploys it under the open salt that gives it the address
// dapp/swap/route.js names (the /tasks job `amm-route` sends the same call). A fork test sends it where the route is not yet on chain; the address it
// lands at is checked against the constant, so a change to the contract that moves the address fails the test until the salt and the constant are mined again:
//   (cd contracts && forge build) && contracts/script/create3-vanity/target/release/create3-vanity create2 <CreateX> <keccak of the init code> 3
// and the job rebuilt with `node worker-relay/scripts/tasks-amm-route.mjs`.
import { readFileSync, existsSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { TACIT_AMM, TACIT_AMM_ROUTE, WETH, POOL_ID, ZERO } from '../dapp/swap/route.js';

export const CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
// 20 zero bytes and the flag 0x00: CreateX guards it as keccak256(salt) alone, so any account can deploy it and nothing but this init code can land there.
export const SALT = '0x000000000000000000000000000000000000000000c004b080000000004144e5';
const word = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const keccak = (hex) => '0x' + Buffer.from(keccak_256(Buffer.from(hex.replace(/^0x/, ''), 'hex'))).toString('hex');

export function ammRouteInit() {
  const f = process.env.AMM_ROUTE_ARTIFACT || new URL('../contracts/out/TacitAmmRoute.sol/TacitAmmRoute.json', import.meta.url).pathname;
  if (!existsSync(f)) throw new Error(`no ${f}: run (cd contracts && forge build) first`);
  return '0x' + JSON.parse(readFileSync(f, 'utf8')).bytecode.object.replace(/^0x/, '') + word(TACIT_AMM) + word(WETH) + word(POOL_ID[ZERO]);
}
// CreateX.deployCreate2(bytes32 salt, bytes initCode)
export function ammRouteDeployTx() {
  const init = ammRouteInit().slice(2), n = init.length / 2;
  return { to: CREATEX, data: '0x26307668' + SALT.slice(2) + (64).toString(16).padStart(64, '0') + n.toString(16).padStart(64, '0') + init + '00'.repeat((32 - (n % 32)) % 32) };
}

// The address CreateX gives that init code and salt.
export const ammRouteAddress = () => '0x' + keccak('0xff' + CREATEX.slice(2) + keccak(SALT).slice(2) + keccak(ammRouteInit()).slice(2)).slice(26);
export const ammRouteAddressMatches = () => ammRouteAddress().toLowerCase() === TACIT_AMM_ROUTE.toLowerCase();
