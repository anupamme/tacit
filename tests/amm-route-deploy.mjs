// TacitAmmRoute's init code from this checkout's forge build, and the transaction that deploys it through the deterministic CREATE2 proxy with the
// salt that gives it the address dapp/swap/route.js names. A fork test sends it where the route is not yet on chain; the address it lands at is checked
// against the constant, so a change to the contract that moves the address fails the test until the salt and the constant are mined again:
//   (cd contracts && forge build) && cast create2 --starts-with 000000 --deployer 0x4e59b44847b379578588920ca78fbf26c0b4956c --init-code-hash $(cast keccak <init code>)
import { readFileSync, existsSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { TACIT_AMM, TACIT_AMM_ROUTE, WETH, POOL_ID, ZERO } from '../dapp/swap/route.js';

export const PROXY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
export const SALT = '0xe9e6678193aecf47bbb394e27dd3b628865b1d0d195eec40c63a17d054f02b91';
const word = (a) => a.slice(2).toLowerCase().padStart(64, '0');

export function ammRouteInit() {
  const f = process.env.AMM_ROUTE_ARTIFACT || new URL('../contracts/out/TacitAmmRoute.sol/TacitAmmRoute.json', import.meta.url).pathname;
  if (!existsSync(f)) throw new Error(`no ${f}: run (cd contracts && forge build) first`);
  return '0x' + JSON.parse(readFileSync(f, 'utf8')).bytecode.object.replace(/^0x/, '') + word(TACIT_AMM) + word(WETH) + word(POOL_ID[ZERO]);
}
export const ammRouteDeployTx = () => ({ to: PROXY, data: SALT + ammRouteInit().slice(2) });

// The address the proxy gives that init code and salt.
export function ammRouteAddress() {
  const init = Buffer.from(ammRouteInit().slice(2), 'hex'), pre = Buffer.concat([Buffer.from([0xff]), Buffer.from(PROXY.slice(2), 'hex'), Buffer.from(SALT.slice(2), 'hex'), Buffer.from(keccak_256(init))]);
  return '0x' + Buffer.from(keccak_256(pre)).subarray(12).toString('hex');
}
export const ammRouteAddressMatches = () => ammRouteAddress().toLowerCase() === TACIT_AMM_ROUTE.toLowerCase();
