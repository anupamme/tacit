#!/usr/bin/env node
// tools/tac-vault-keeper.mjs with RECORD_MODE=demand on a local anvil, against a real TacVault that borrows from a MockPair (venues that take a record on a header alone):
// while every borrower is far from the liquidation line the keeper records nothing and spends nothing (the default mode, on the same chain, records); once TAC falls so
// that a borrower is near the line it records what is due; a vault in an auction keeps it recording; and with no vault to judge it falls back to recording. One-shot
// runs (ONCE=1).
//
//   VAULT_OUT=<forge out dir> node tests/tac-vault-keeper-demand.mjs
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('../', import.meta.url).pathname;
const OUT = process.env.VAULT_OUT || join(REPO, 'contracts/out');
const need = ['TacVault.sol/TacVault', 'TacVaultMocks.sol/TestTac', 'TacVaultMocks.sol/MockPair', 'TacVaultMocks.sol/LiveFeed'];
if (need.some((f) => !existsSync(join(OUT, `${f}.json`)))) { console.log(`skipped: ${OUT} has no compiled TacVault and test mocks (forge build, or set VAULT_OUT)`); process.exit(0); }
const PORT = 24000 + Math.floor(Math.random() * 900), ANVIL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => { const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 60) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 250)); } }

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', DEPLOYER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const KEEPER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', KEEPER_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const art = (f) => JSON.parse(readFileSync(join(OUT, `${f}.json`), 'utf8')).bytecode.object;
const create = (data) => JSON.parse(cast('send', '--private-key', DEPLOYER, '--rpc-url', ANVIL, '--json', '--create', data)).contractAddress;
const send = (k, to, sig, ...a) => cast('send', to, sig, ...a, '--private-key', k, '--rpc-url', ANVIL, '--json');
const view = (to, sig, ...a) => cast('call', to, sig, ...a, '--rpc-url', ANVIL).split('\n')[0].trim().split(/\s+/)[0];
const head = async () => Number(BigInt(await rpc('eth_blockNumber')));
const nonce = (a) => Number(cast('nonce', a, '--rpc-url', ANVIL));
const E18 = 10n ** 18n;

await rpc('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', readFileSync(join(REPO, 'tests/fixtures/multicall3-runtime.hex'), 'utf8').trim()]);
const TAC = create(art('TacVaultMocks.sol/TestTac'));
const PAIR = create(art('TacVaultMocks.sol/MockPair'));
const A = view(PAIR, 'A()(address)'), B = view(PAIR, 'B()(address)');
const FEED = create(art('TacVaultMocks.sol/LiveFeed'));                                                   // ETH is $2,500
send(DEPLOYER, PAIR, 'set(uint256)', String(10n ** 14n));                                                 // 0.0001 ETH per TAC: $0.25
const cfg = `(${TAC},${PAIR},${FEED},${DEPLOYER_ADDR},35000,20000,4000,3600,1800,${100n * E18},3900,${(1n << 256n) - 1n},15,50,100,0x00000000000000000000000000000000000000Fe,0x000000000000000000000000000000000000dEaD,TAC Dollar,TACD)`;
const enc = cast('abi-encode', 'f((address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address,string,string))', cfg);
const VAULT = create(art('TacVault.sol/TacVault') + enc.slice(2));
send(DEPLOYER, TAC, 'mint(address,uint256)', DEPLOYER_ADDR, String(1_000_000n * E18));
send(DEPLOYER, TAC, 'approve(address,uint256)', VAULT, String((1n << 256n) - 1n));
send(DEPLOYER, VAULT, 'deposit(uint256)', String(100_000n * E18));                                        // $25,000 of TAC
send(DEPLOYER, VAULT, 'borrow(uint256,uint256)', String(5_000n * E18), '500');                            // owes 5,050: about 495% cover

await rpc('anvil_mine', ['0x7d0']);                                                                       // 2,000 blocks of history
const top = async () => Math.floor(((await head()) - 1) / 50) - 1;
const t0 = await top();
for (const v of [A, B]) send(DEPLOYER, v, 'fill(uint256,uint256)', String(t0 - 30), String(t0 - 11));   // the newest eleven intervals of each venue are due
const recorded = (k) => [A, B].every((v) => BigInt(view(v, 'sampleOf(uint256)(uint256,uint256)', String(k))) !== 0n);
const due = async () => { const t = await top(); return Array.from({ length: 11 }, (_, i) => t - 10 + i).filter((k) => !recorded(k)); };
const keeper = (extra = {}) => {
  const env = { ...process.env, KEEPER_PRIV: KEEPER, RPC: ANVIL, SEND_RPC: ANVIL, ORACLE: `${A},${B}`, VAULTS: VAULT, FROM_BLOCK: '0', MAX_GWEI: '100', URGENT_MAX_GWEI: '100', RECORD_TIP_GWEI: '0', URGENT_TIP_GWEI: '0', ALERT_WEBHOOK: '', ONCE: '1', ...extra };
  try { return execFileSync('node', [join(REPO, 'tools/tac-vault-keeper.mjs')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); }
};
const riskAlert = (out) => out.split('\n').find((l) => / ALERT .* cover: recording prices/.test(l) || / ALERT .* in an auction: recording prices/.test(l));
const dueBefore = (await due()).length;
ok(dueBefore >= 10, `${dueBefore} intervals of each venue are due`);

// 1. far from the line (about 495% against the 280% trigger): nothing is recorded, nothing is spent, nothing alerts
let before = nonce(KEEPER_ADDR);
let out = keeper({ RECORD_MODE: 'demand' });
ok(nonce(KEEPER_ADDR) === before && (await due()).length === dueBefore, 'with the only borrower at about 495% cover, demand mode sends nothing and leaves the intervals unrecorded');
ok(!riskAlert(out) && !/check failed/.test(out), `and raises no alert and no failure (${out.split('\n').filter((l) => /ALERT|failed/.test(l)).join(' | ') || 'quiet'})`);

// 2. the default mode, on the same chain and the same backlog, records it (so the quiet above is the mode's doing)
const spare = await rpc('evm_snapshot');
out = keeper();
ok(nonce(KEEPER_ADDR) > before && (await due()).length === 0, 'RECORD_MODE unset records the same backlog');
await rpc('evm_revert', [spare]);
ok((await due()).length === dueBefore, 'the snapshot put the backlog back');

// 3. TAC halves ($0.125, so 5,050 owed against $12,500: about 247% cover): demand mode records what is due, and says why
send(DEPLOYER, PAIR, 'set(uint256)', String(5n * 10n ** 13n));
before = nonce(KEEPER_ADDR);
out = keeper({ RECORD_MODE: 'demand' });
ok(nonce(KEEPER_ADDR) > before && (await due()).length === 0, 'with the borrower near the line it records every due interval');
const ra = riskAlert(out);
ok(ra && /at 247\.\d+% cover/.test(ra) && ra.toLowerCase().includes(DEPLOYER_ADDR.toLowerCase()), `and says which borrower and how near (${ra ? ra.slice(ra.indexOf('ALERT')).slice(0, 130) : 'no alert'})`);

// 4. the latest recorded price is the cautious one when it is lower than the spot: spot back up, a newer lower sample keeps the alert
send(DEPLOYER, PAIR, 'set(uint256)', String(10n ** 14n));
send(DEPLOYER, PAIR, 'setLatest(uint256)', String(5n * 10n ** 13n));
await rpc('anvil_mine', ['0x1f4']);
out = keeper({ RECORD_MODE: 'demand' });
ok(riskAlert(out) && /at 2\d\d(\.\d+)?% cover/.test(riskAlert(out)), 'the lower of spot and the newest recorded price judges the cover');
send(DEPLOYER, PAIR, 'set(uint256)', String(10n ** 14n));                                                // both back to $0.25
await rpc('anvil_mine', ['0x1f4']);                                                                       // and a new backlog comes due
before = nonce(KEEPER_ADDR);
out = keeper({ RECORD_MODE: 'demand' });
ok((await due()).length > 0 && nonce(KEEPER_ADDR) === before && !riskAlert(out), 'once TAC is back, with a backlog due, the keeper is quiet again and spends nothing');

// 5. a borrower in an auction keeps it recording, whatever the cover shows: drop TAC under 200% so the keeper's own scan opens one
send(DEPLOYER, PAIR, 'set(uint256)', String(3n * 10n ** 13n));
await rpc('anvil_mine', ['0x1f4']);
out = keeper({ RECORD_MODE: 'demand' });
ok(/liquidate/.test(out), 'under the liquidation line the keeper opens the auction');
send(DEPLOYER, PAIR, 'set(uint256)', String(10n ** 14n));                                                // the market recovers while the auction stands
await rpc('anvil_mine', ['0x1f4']);
out = keeper({ RECORD_MODE: 'demand' });
ok(/in an auction: recording prices/.test(out), 'an auction that stands keeps the keeper recording, even with the price back up');

// 6. with no vault to judge, the mode has nothing to go on and records as before
await rpc('anvil_mine', ['0x1f4']);
before = nonce(KEEPER_ADDR);
const backlog = (await due()).length;
keeper({ RECORD_MODE: 'demand', VAULTS: '', FROM_BLOCK: '' });
ok(backlog > 0 && nonce(KEEPER_ADDR) > before && (await due()).length === 0, 'RECORD_MODE=demand without VAULTS has no borrower to judge by and records as before');
const bad = keeper({ RECORD_MODE: 'sometimes' });
ok(/RECORD_MODE is always or demand/.test(bad), 'an unknown RECORD_MODE is refused');

console.log(fails ? `${fails} failed, ${n} passed` : `${n} checks passed`);
process.exit(fails ? 1 : 0);
