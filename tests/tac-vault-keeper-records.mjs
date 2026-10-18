#!/usr/bin/env node
// tools/tac-vault-keeper.mjs recording the venues' intervals on a local anvil, against test venues that take a record on a header alone (MockPair's): what is due goes out
// as few transactions as the batch limit allows (not one per interval), a wallet with too little is told so, and with DEFER_BLOCKS on an interval waits for a cheaper
// block until it is that old. One-shot runs (ONCE=1).
//
//   VAULT_OUT=<forge out dir> node tests/tac-vault-keeper-records.mjs
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('../', import.meta.url).pathname;
const OUT = process.env.VAULT_OUT || join(REPO, 'contracts/out');
if (!existsSync(join(OUT, 'TacVaultMocks.sol/MockPair.json'))) { console.log(`skipped: ${OUT} has no compiled MockPair (forge build, or set VAULT_OUT)`); process.exit(0); }
const PORT = 23000 + Math.floor(Math.random() * 900), ANVIL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--hardfork', 'prague', '--silent'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => { const j = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 60) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 250)); } }

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEEPER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', KEEPER_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const art = (f) => JSON.parse(readFileSync(join(OUT, `${f}.json`), 'utf8')).bytecode.object;
const send = (k, to, sig, ...a) => cast('send', to, sig, ...a, '--private-key', k, '--rpc-url', ANVIL, '--json');
const view = (to, sig, ...a) => cast('call', to, sig, ...a, '--rpc-url', ANVIL).split('\n')[0].trim().split(/\s+/)[0];
const head = async () => Number(BigInt(await rpc('eth_blockNumber')));
const nonce = (a) => Number(cast('nonce', a, '--rpc-url', ANVIL));
const keeper = (extra = {}, key = KEEPER) => {
  const env = { ...process.env, KEEPER_PRIV: key, RPC: ANVIL, SEND_RPC: ANVIL, ORACLE: `${A},${B}`, MAX_GWEI: '100', URGENT_MAX_GWEI: '100', RECORD_TIP_GWEI: '0', URGENT_TIP_GWEI: '0', ONCE: '1', ...extra };
  try { return execFileSync('node', [join(REPO, 'tools/tac-vault-keeper.mjs')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); }
};

await rpc('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', readFileSync(join(REPO, 'tests/fixtures/multicall3-runtime.hex'), 'utf8').trim()]);   // the chain has Multicall3, as mainnet does
const PAIR = JSON.parse(cast('send', '--private-key', DEPLOYER, '--rpc-url', ANVIL, '--json', '--create', art('TacVaultMocks.sol/MockPair'))).contractAddress;
const A = view(PAIR, 'A()(address)'), B = view(PAIR, 'B()(address)');
await rpc('anvil_mine', ['0x7d0']);                                                                       // 2,000 blocks
const top = Math.floor(((await head()) - 1) / 50) - 1;
for (const v of [A, B]) send(DEPLOYER, v, 'fill(uint256,uint256)', String(top - 30), String(top - 11));    // the newest eleven intervals of each venue are due
const recorded = (k) => [A, B].every((v) => BigInt(view(v, 'sampleOf(uint256)(uint256,uint256)', String(k))) !== 0n);
const due = Array.from({ length: 11 }, (_, i) => top - 10 + i).filter((k) => k <= Math.floor(((Number(BigInt(cast('block-number', '--rpc-url', ANVIL)))) - 1) / 50) - 1);
ok(due.length >= 10 && due.every((k) => !recorded(k)), `${due.length} intervals of each venue are due (${due.length * 2} records)`);

// 1. batched: twenty-two records are two transactions of at most twelve, not eleven
let before = nonce(KEEPER_ADDR);
let out = keeper();
const used = nonce(KEEPER_ADDR) - before;
ok(due.every(recorded), 'every due interval is recorded');
ok(used === Math.ceil(due.length * 2 / 12), `in ${used} transaction(s), the batch limit allowing ${Math.ceil(due.length * 2 / 12)} (one per interval would have been ${due.length})`);
ok(!/failed|would fail/.test(out), `nothing failed (${(out.match(/failed.*/) || ['clean'])[0].slice(0, 80)})`);

// 2. a smaller batch limit gives more transactions
await rpc('anvil_mine', ['0x1f4']);                                                                       // ten more intervals come due
for (const v of [A, B]) send(DEPLOYER, v, 'fill(uint256,uint256)', String(top + 1), String(top + 1));
before = nonce(KEEPER_ADDR);
keeper({ BATCH_RECORDS: '4' });
const used4 = nonce(KEEPER_ADDR) - before;
ok(used4 >= 5 && used4 <= 6, `with BATCH_RECORDS=4 the same kind of backlog takes more transactions (${used4})`);

// 3. a wallet with nothing is told so
out = keeper({}, '0x' + '11'.repeat(32));
ok(/ALERT the keeper wallet 0x[0-9a-fA-F]{40} holds 0 ETH, about 0 hours of recording at the current base fee; send it ETH/.test(out) || /ALERT the keeper wallet .* send it ETH/.test(out), `an empty wallet is reported (${(out.split('\n').find((l) => /ALERT/.test(l)) || 'no alert').slice(0, 140)})`);
out = keeper();
ok(!/ALERT the keeper wallet/.test(out), 'a funded wallet is not');

// 4. deferral: a dear block after cheap ones waits; once the interval is old enough it does not
await rpc('anvil_mine', ['0x12c']);                                                                       // 300 blocks at a base fee near nothing
await rpc('anvil_mine', ['0x32']);                                                                        // fifty more: a new interval is due
await rpc('anvil_setNextBlockBaseFeePerGas', ['0x12a05f200']);                                            // 5 gwei
await rpc('anvil_mine', ['0x1']);
const topNow = Math.floor(((await head()) - 1) / 50) - 1;
const missing = () => [topNow, topNow - 1].filter((k) => !recorded(k));
const m0 = missing().length;
before = nonce(KEEPER_ADDR);
out = keeper({ DEFER_BLOCKS: '1000', DEFER_PCT: '30' });
ok(m0 > 0 && nonce(KEEPER_ADDR) === before && /waiting for a cheaper block/.test(out), `at a dear base fee, with DEFER_BLOCKS on, it waits and sends nothing (${(out.split('\n').find((l) => /waiting/.test(l)) || 'no waiting line').slice(0, 120)})`);
out = keeper({ DEFER_BLOCKS: '1', DEFER_PCT: '30' });
ok(nonce(KEEPER_ADDR) > before && !/waiting for a cheaper block/.test(out), 'when what is due is older than DEFER_BLOCKS it records at once');

console.log(fails ? `${fails} failed, ${n} passed` : `${n} checks passed`);
process.exit(fails ? 1 : 0);
