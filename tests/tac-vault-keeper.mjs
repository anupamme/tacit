#!/usr/bin/env node
// tools/tac-vault-keeper.mjs against a TacVault on a local anvil, around an oracle swap: the keeper says when the
// owner announces a new oracle (and that its venues need recording before it takes over), and once it is in place,
// that the vault now prices from venues this keeper does not record, until it is restarted with them. One-shot runs
// (ONCE=1); the venue oracles are the vault tests' MockOracle, which the keeper cannot record (it says so and goes on).
// Then tools/tac-vault-admin.mjs's status of the synth's further minters, added and removed.
//
//   VAULT_OUT=<forge out dir> node tests/tac-vault-keeper.mjs
//
// VAULT_OUT holds the compiled TacVault and the test mocks (contracts/test/TacVaultMocks.sol); it defaults to
// contracts/out. Without them the test says so and stops.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('../', import.meta.url).pathname;
const OUT = process.env.VAULT_OUT || join(REPO, 'contracts/out');
const need = ['TacVault.sol/TacVault', 'TacVaultMocks.sol/TestTac', 'TacVaultMocks.sol/MockOracle', 'TacVaultMocks.sol/LiveFeed'];
if (need.some((f) => !existsSync(join(OUT, `${f}.json`)))) { console.log(`skipped: ${OUT} has no compiled TacVault and test mocks (forge build, or set VAULT_OUT)`); process.exit(0); }
const PORT = 22000 + Math.floor(Math.random() * 1000), ANVIL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => (await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 60) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 250)); } }

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OWNER = { a: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', k: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' };
const art = (f) => JSON.parse(readFileSync(join(OUT, `${f}.json`), 'utf8')).bytecode.object;
const create = (data) => JSON.parse(cast('send', '--private-key', DEPLOYER, '--rpc-url', ANVIL, '--json', '--create', data)).contractAddress;
const send = (k, to, sig, ...args) => cast('send', to, sig, ...args, '--private-key', k, '--rpc-url', ANVIL, '--json');

const TAC = create(art('TacVaultMocks.sol/TestTac'));
const A = create(art('TacVaultMocks.sol/MockOracle')), B = create(art('TacVaultMocks.sol/MockOracle'));
const FEED = create(art('TacVaultMocks.sol/LiveFeed'));
for (const o of [A, B]) send(DEPLOYER, o, 'set(uint256)', String(10n ** 14n));
const cfg = `(${TAC},${A},${FEED},${OWNER.a},35000,20000,4000,3600,1800,${100n * 10n ** 18n},3900,${(1n << 256n) - 1n},15,50,100,0x00000000000000000000000000000000000000Fe,0x000000000000000000000000000000000000dEaD,TAC Dollar,TACD)`;
const enc = cast('abi-encode', 'f((address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address,string,string))', cfg);
const VAULT = create(art('TacVault.sol/TacVault') + enc.slice(2));

const keeper = (oracles) => execFileSync('node', [join(REPO, 'tools/tac-vault-keeper.mjs')], {
  env: { ...process.env, KEEPER_PRIV: DEPLOYER, RPC: ANVIL, ORACLE: oracles.join(','), VAULTS: VAULT, FROM_BLOCK: '0', ONCE: '1', ALERT_WEBHOOK: '' },
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const alerts = (out) => out.split('\n').filter((l) => / ALERT /.test(l));
const lc = (a) => a.toLowerCase();

// The vault's own oracle is recorded: nothing to say about it.
let out = keeper([A]);
ok(!alerts(out).some((l) => /oracle/i.test(l)), `recording the vault's own oracle raises no oracle alert (${alerts(out).join(' | ') || 'no alerts'})`);

// The owner announces B: the keeper says so, with the time and the venue to record first.
send(OWNER.k, VAULT, 'queueOracle(address)', B);
out = keeper([A]);
const ann = alerts(out).find((l) => l.includes('is announced from'));
ok(ann && lc(ann).includes(lc(B)) && lc(ann).includes(`record ${lc(B)} before then`), `an announced oracle is an alert naming it, its time and the venue to record (${ann})`);
out = keeper([A, B]);
const ann2 = alerts(out).find((l) => l.includes('is announced from'));
ok(ann2 && !/record .* before then/.test(ann2), `once its venue is recorded the alert no longer asks for it (${ann2})`);

// B takes over: a keeper still recording only A says the vault prices from a venue it does not record.
await rpc('evm_increaseTime', [3 * 86400 + 60]); await rpc('evm_mine');
for (const o of [A, B]) send(DEPLOYER, o, 'set(uint256)', String(10n ** 14n));
send(OWNER.k, VAULT, 'executeOracle()');
ok(lc(cast('call', VAULT, 'ORACLE()(address)', '--rpc-url', ANVIL)) === lc(B), 'the owner put B in place after the wait');
out = keeper([A]);
const stray = alerts(out).find((l) => l.includes('not recorded here'));
ok(stray && lc(stray).includes(lc(B)), `a keeper that does not record the vault's new venue says so (${stray})`);
out = keeper([B]);
ok(!alerts(out).some((l) => /not recorded here|is announced/.test(l)), 'restarted with the new venue, it has nothing to say about the oracle');

// The owner adds a further minter to the synth (any contract will do here) and later removes it: the admin tool
// lists it while it is in place, and counts it as removed after.
const SYNTH = cast('call', VAULT, 'SYNTH()(address)', '--rpc-url', ANVIL);
const admin = () => execFileSync('node', [join(REPO, 'tools/tac-vault-admin.mjs'), 'status', VAULT, SYNTH], { env: { ...process.env, RPC: ANVIL, FROM_BLOCK: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
ok(/further minters now: none\b/.test(admin()), 'with no further minter the admin tool says none');
send(OWNER.k, SYNTH, 'queueMinter(address)', A);
await rpc('evm_increaseTime', [3 * 86400 + 60]); await rpc('evm_mine');
send(OWNER.k, SYNTH, 'executeMinter()');
const withOne = admin();
ok(lc(withOne).includes(`further minters now: ${lc(A)}`), `a further minter in place is listed (${withOne.split('\n').find((l) => /further minters/.test(l))})`);
send(OWNER.k, SYNTH, 'removeMinter(address)', A);
const removed = admin();
ok(/further minters now: none \(1 added and since removed\)/.test(removed), `and once removed it is counted as such (${removed.split('\n').find((l) => /further minters/.test(l))})`);

console.log(fails ? `${fails} failed, ${n} passed` : `${n} checks passed`);
process.exit(fails ? 1 : 0);
