#!/usr/bin/env node
// Checks a TAC vaults deployment payload on its own, with nothing but `cast`: that every transaction goes to CreateX
// with value 0 and carries the salt and init code it names, that the init code's hash and CREATE2 address are the
// ones listed, that each address starts with zero bytes, and that the registry calls go to the confidential pool.
//
//   node tools/tac-vaults-check.mjs <payload.json> [contracts/deployments/tac-vaults.json]
//
// With the manifest it also checks that the payload and the manifest agree.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const lc = (s) => s.toLowerCase();

const payload = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const manifest = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : null;
let bad = 0;
const check = (ok, what) => { if (!ok) { bad++; console.log(`FAIL  ${what}`); } };

check(payload.chainId === 1 && lc(payload.factory) === lc(CREATEX), 'chain and factory');
payload.deployments.forEach((t, i) => {
  check(t.step === i + 1, `${t.name}: step order`);
  check(lc(t.to) === lc(CREATEX) && t.value === '0x0', `${t.name}: goes to CreateX with no value`);
  const [salt, initCode] = cast('calldata-decode', 'deployCreate2(bytes32,bytes)', t.data).split('\n');
  const hash = cast('keccak', initCode);
  check(hash === t.initCodeHash, `${t.name}: init code hash`);
  const guarded = cast('keccak', '0x' + '00'.repeat(31) + '01' + salt.slice(2)); // keccak256(abi.encode(chainId 1, salt))
  const create2 = '0x' + cast('keccak', '0xff' + CREATEX.slice(2) + guarded.slice(2) + hash.slice(2)).slice(26);
  check(lc(create2) === lc(t.expectedAddress), `${t.name}: CREATE2 address`);
  check(t.expectedAddress.slice(0, 8) === '0x000000', `${t.name}: three zero bytes`);
  check(lc(salt).startsWith('0x' + '00'.repeat(20) + '01'), `${t.name}: the salt is bound to the chain (20 zero bytes, then 0x01)`);
  const m = manifest?.contracts.find((c) => c.name === t.name);
  if (manifest) check(m && lc(m.address) === lc(t.expectedAddress) && m.salt === salt && m.initCodeHash === hash, `${t.name}: manifest agrees`);
});
payload.registry.forEach((t) => check(lc(t.to) === lc(POOL), `${t.name}: goes to the confidential pool`));
const addrs = payload.deployments.map((t) => lc(t.expectedAddress));
check(new Set(addrs).size === addrs.length, 'addresses are distinct');

console.log(bad ? `${bad} problem(s)` : `ok: ${payload.deployments.length} deployments and ${payload.registry.length} registry calls check out`);
process.exit(bad ? 1 : 0);
