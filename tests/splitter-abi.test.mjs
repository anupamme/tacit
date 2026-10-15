// The splitter page's encodings (dapp/splitter/abi.js) against the real thing: selectors and event topics from keccak, and every
// calldata, constructor-argument and return-value layout against `cast` when it is installed. Payout rounding is checked against the
// contract's own arithmetic (contracts/src/EthSplitter.sol distribute) by property.
//
// Run: node tests/splitter-abi.test.mjs
import { execFileSync } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  SEL, TOPIC, MAX_RECIPIENTS, encSetShares, encDistribute, encDeployArgs, deployData, decodeShares, decodeAddress,
  payouts, percent, fmtEth, sharesProblem, isAddress, safeBatch,
} from '../dapp/splitter/abi.js';

let n = 0, failed = 0;
const ok = (c, m) => { n++; if (!c) { failed++; console.log('  FAIL -', m); } else console.log('  ok -', m); };
const hex = (u) => Buffer.from(u).toString('hex');
const sel = (sig) => '0x' + hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
const topic = (sig) => '0x' + hex(keccak_256(new TextEncoder().encode(sig)));
let cast = true;
try { execFileSync('cast', ['--version'], { stdio: 'ignore' }); } catch { cast = false; }
const castOut = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();

const A = '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7', B = '0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331', O = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';

ok(SEL.distribute === sel('distribute()') && SEL.shares === sel('shares()') && SEL.owner === sel('owner()') && SEL.setShares === sel('setShares(address[],uint96[])'), 'the four selectors are the keccak of the contract signatures');
ok(TOPIC.distributed === topic('Distributed(uint256)') && TOPIC.sharesSet === topic('SharesSet(address[],uint96[])'), 'the two event topics are the keccak of the event signatures');
ok(encDistribute() === SEL.distribute, 'distribute() is its bare selector');

const to = [A, B], w = [70n, 30n];
if (cast) {
  ok(encSetShares(to, w) === castOut('calldata', 'setShares(address[],uint96[])', `[${to}]`, `[${w}]`), 'setShares calldata equals cast calldata, two recipients');
  const three = [A, B, O], tw = [5n, 3n, 2n];
  ok(encSetShares(three, tw) === castOut('calldata', 'setShares(address[],uint96[])', `[${three}]`, `[${tw}]`), 'setShares calldata equals cast calldata, three recipients');
  const one = [A], ow = [(1n << 96n) - 1n];
  ok(encSetShares(one, ow) === castOut('calldata', 'setShares(address[],uint96[])', `[${one}]`, `[${ow}]`), 'setShares calldata equals cast calldata, one recipient at the largest weight');
  ok('0x' + encDeployArgs(O, to, w) === castOut('abi-encode', 'constructor(address,address[],uint96[])', O, `[${to}]`, `[${w}]`), 'the deploy arguments equal cast abi-encode');
  const ret = castOut('abi-encode', 'f(address[],uint96[])', `[${three}]`, `[${[5, 3, 2]}]`);
  const dec = decodeShares(ret);
  ok(dec.to.map((x) => x.toLowerCase()).join() === three.map((x) => x.toLowerCase()).join() && dec.weight.join() === '5,3,2', 'shares() return decodes to the same addresses and weights');
} else console.log('  (cast not installed: the layout checks against cast are skipped)');
ok(deployData('0x6080', O, to, w) === '0x6080' + encDeployArgs(O, to, w), 'deploy data is the creation code followed by the arguments');
ok(decodeAddress('0x' + '00'.repeat(12) + A.slice(2).toLowerCase()) === A.toLowerCase(), 'an address word decodes');

// payouts: the contract's rounding.
ok(payouts(11n, [70n, 30n]).join() === '7,4', '11 wei at 70/30 pays 7 and 4: the first rounds down, the last takes the dust');
ok(payouts(1n, [70n, 30n]).join() === '0,1', '1 wei goes to the last');
ok(payouts(10n ** 18n, [70n, 30n]).join() === `${7n * 10n ** 17n},${3n * 10n ** 17n}`, '1 ETH at 70/30 is 0.7 and 0.3');
ok(payouts(10n, [5n, 3n, 2n]).join() === '5,3,2', 'three recipients, exact');
let conserved = true, floorOk = true;
for (let i = 0; i < 400; i++) {
  const k = 1 + (i % 8), ws = Array.from({ length: k }, (_, j) => BigInt(1 + ((i * 7919 + j * 104729) % 1000003))), b = BigInt(i) * 10n ** 15n + BigInt(i * 31 % 977);
  const p = payouts(b, ws), total = ws.reduce((x, y) => x + y, 0n);
  if (p.reduce((x, y) => x + y, 0n) !== b) conserved = false;
  for (let j = 0; j < k - 1; j++) if (p[j] !== b * ws[j] / total) floorOk = false;
  if (p[k - 1] < b * ws[k - 1] / total || p[k - 1] - b * ws[k - 1] / total >= BigInt(k)) floorOk = false;
}
ok(conserved, 'every wei is paid out, for 400 balances and weight lists up to eight');
ok(floorOk, 'each but the last gets its exact share rounded down, and the last at most (recipients - 1) wei more');
ok(payouts(5n, []).length === 0, 'no recipients, no payouts');

ok(percent([70n, 30n], 0) === '70' && percent([70n, 30n], 1) === '30' && percent([1n, 2n], 0) === '33.33' && percent([1n, 2n], 1) === '66.66' && percent([1n, 7n], 0) === '12.5', 'percent shows up to two decimals, trimmed');
ok(fmtEth(210000000000000n) === '0.00021' && fmtEth(10n ** 18n) === '1' && fmtEth(0n) === '0' && fmtEth(1500000000000000000n) === '1.5' && fmtEth(1n) === '0', 'ether is trimmed, and a single wei is below the six places shown');

ok(sharesProblem([A, B], [70, 30]) === null, 'a valid list has no problem');
ok(/at least one/.test(sharesProblem([], [])) && /At most 8/.test(sharesProblem(Array(9).fill(A), Array(9).fill(1))) && MAX_RECIPIENTS === 8, 'zero and nine wallets are refused');
ok(/not an address/.test(sharesProblem(['0x12', B], [1, 1])) && /not an address/.test(sharesProblem(['0x' + '0'.repeat(40), B], [1, 1])), 'a short address and the zero address are refused');
ok(/above zero/.test(sharesProblem([A, B], [0, 1])) && /above zero/.test(sharesProblem([A, B], [-1, 1])) && /whole number/.test(sharesProblem([A, B], ['1.5', 1])) && /above zero/.test(sharesProblem([A, B], [1n << 96n, 1])), 'zero, negative, fractional and over-wide weights are refused');
ok(/splitter itself/.test(sharesProblem([A, B], [1, 1], A.toLowerCase())), 'the splitter cannot pay itself');
ok(/needs a weight/.test(sharesProblem([A, B], [1])), 'a missing weight is refused');
ok(isAddress(A) && !isAddress('0x') && !isAddress(null), 'isAddress');

const sb = safeBatch({ to: A, name: 'x', calls: ['0xe4fc6b6d', '0xc8389ce5'] });
ok(sb.chainId === '1' && sb.transactions.length === 2 && sb.transactions[0].to === A && sb.transactions[0].value === '0' && sb.transactions[1].data === '0xc8389ce5', 'the Safe batch lists the calls in order, each to the splitter with no value');

console.log(failed ? `\n${failed} FAILED (${n} checks)` : `\nall ${n} splitter-abi checks passed`);
process.exit(failed ? 1 : 0);
