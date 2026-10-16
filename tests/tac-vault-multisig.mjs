// tools/tac-vault-multisig.mjs against a fork of mainnet: the ops multisig gets two owners whose keys this test holds, they sign the queue step's typed data,
// the signatures are assembled and sent, the multisig's hour and the vaults' two days pass, the execute step goes the same way, and then the terms
// are the new ones and a deposit and a borrow on the ETH vault go through at the new minimum.
//   anvil --fork-url <archive mainnet rpc> --port 8548 --chain-id 1 &
//   FORK_RPC=http://127.0.0.1:8548 node tests/tac-vault-multisig.mjs
// (The USD vault borrows against a Chainlink price that would be stale after the time this test passes, so only the ETH vault is borrowed from.)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RPC = process.env.FORK_RPC;
if (!RPC) { console.log('skipped - set FORK_RPC to an anvil mainnet fork'); process.exit(0); }
const MULTISIG = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const USD = '0x00000087ac9ed3E1Bd443E00FBe18B4EdcAEeb1F', ETH_V = '0x00000047bFC8cF504967049D9Cf9E1FD9651ED80';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', PRECISION_POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E';
const cast = (args, opts = {}) => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const view = (to, sig, ...a) => cast(['call', to, sig, ...a, '--rpc-url', RPC]).split('\n')[0].split(' ')[0];
const send = (from, to, sig, ...a) => cast(['send', to, sig, ...a, '--from', from, '--unlocked', '--rpc-url', RPC, '--json']);
const tool = (...a) => JSON.parse(execFileSync('node', [new URL('../tools/tac-vault-multisig.mjs', import.meta.url).pathname, ...a], { env: { ...process.env, RPC }, encoding: 'utf8' }));
const rpc = (m, p = []) => cast(['rpc', m, ...p.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))), '--rpc-url', RPC]);
const warp = (secs) => { rpc('evm_increaseTime', [String(secs)]); rpc('evm_mine'); };
const impersonate = (a) => { rpc('anvil_impersonateAccount', [a]); rpc('anvil_setBalance', [a, '0x56bc75e2d63100000']); };

const dir = mkdtempSync(join(tmpdir(), 'ms-'));
const snap = rpc('evm_snapshot').replace(/"/g, '');
try {
  // Two owners this test holds the keys of, added by the multisig itself (impersonated), in address order.
  const keys = [0, 1].map(() => { const j = JSON.parse(cast(['wallet', 'new', '--json'])); return { address: j[0].address, key: j[0].private_key }; });
  impersonate(MULTISIG);
  for (const k of keys) impersonate(k.address);                       // they pay for the sends on the fork
  for (const k of keys) send(MULTISIG, MULTISIG, 'addOwner(address)', k.address);
  assert.equal(view(MULTISIG, 'isOwner(address)(bool)', keys[0].address), 'true');

  const before = { usd: [view(USD, 'MIN_DEBT()(uint256)'), view(USD, 'DEPTH_BPS()(uint256)')], eth: [view(ETH_V, 'MIN_DEBT()(uint256)'), view(ETH_V, 'DEPTH_BPS()(uint256)')] };
  assert.deepEqual([before.usd[1], before.eth[1]], ['15', '15']);

  // One step: the owners sign the typed data, the signatures are assembled into the `execute` call and sent, the multisig's hour passes, and the queued call is run.
  const sendRaw = (from, to, data) => cast(['send', to, data, '--from', from, '--unlocked', '--rpc-url', RPC, '--json']);
  const run = (name) => {
    const p = tool('payload', name);
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(p.typedData));
    const sigs = keys.map((k) => cast(['wallet', 'sign', '--data', '--from-file', file, '--private-key', k.key]));
    const a = tool('assemble', name, ...sigs);
    assert.equal(a.digest, p.digest, 'the wallets sign the digest the contract computes');
    sendRaw(keys[0].address, a.to, a.data);
    const q = tool('queued', name, String(p.nonce));
    assert.ok(q.queuedUntil, `${name}: queued by the multisig`);
    warp(3601);
    assert.match(tool('queued', name, String(p.nonce)).state, /^ready/);
    sendRaw(keys[1].address, q.to, q.data);
    return p;
  };

  run('queue');
  for (const [v, depth, min] of [[USD, '55', '10000000000000000000'], [ETH_V, '55', '4000000000000000']]) {
    const queuedDepth = cast(['call', v, 'queuedParam(uint8)(uint192,uint64)', '0', '--rpc-url', RPC]).split('\n');
    const queuedMin = cast(['call', v, 'queuedParam(uint8)(uint192,uint64)', '6', '--rpc-url', RPC]).split('\n');
    assert.equal(queuedDepth[0].split(' ')[0], depth, 'the vault announced the depth share');
    assert.equal(queuedMin[0].split(' ')[0], min, 'and the minimum debt');
  }
  console.log('ok - signed, assembled, queued by the multisig, run after its hour: both vaults announce the new terms');

  assert.throws(() => cast(['call', USD, 'executeParam(uint8)', '6', '--from', MULTISIG, '--rpc-url', RPC]), 'the vaults apply nothing before their own two days, even for the multisig');
  warp(2 * 86400 + 60);
  run('execute');
  assert.equal(view(USD, 'MIN_DEBT()(uint256)'), '10000000000000000000');
  assert.equal(view(USD, 'DEPTH_BPS()(uint256)'), '55');
  assert.equal(view(ETH_V, 'MIN_DEBT()(uint256)'), '4000000000000000');
  assert.equal(view(ETH_V, 'DEPTH_BPS()(uint256)'), '55');
  console.log('ok - two days on, the execute step applies: minimum debt a tenth, depth share 55, on both vaults');

  // A borrow at the new minimum on the ETH vault.
  const borrower = keys[0].address;
  impersonate(PRECISION_POOL); impersonate(borrower);
  send(PRECISION_POOL, TAC, 'transfer(address,uint256)', borrower, '500000000000000000000');
  send(borrower, TAC, 'approve(address,uint256)', ETH_V, '500000000000000000000');
  send(borrower, ETH_V, 'deposit(uint256)', '300000000000000000000');
  const room = BigInt(view(ETH_V, 'depthCeiling()(uint256)').replace(/\[.*$/, ''));
  assert.ok(room >= 4_000_000_000_000_000n, `the vault has room for the minimum: ${room}`);
  assert.throws(() => send(borrower, ETH_V, 'borrow(uint256,uint256)', '3000000000000000', '1000'), 'under the new minimum (0.004) is still refused');
  send(borrower, ETH_V, 'borrow(uint256,uint256)', '5000000000000000', '1000');
  const synth = view(ETH_V, 'SYNTH()(address)');
  const got = BigInt(view(synth, 'balanceOf(address)(uint256)', borrower));
  assert.ok(got >= 4_900_000_000_000_000n, `borrowed 0.005 TACE (less the fee): ${got}`);
  console.log(`ok - a vault of 0.005 TACE opened on the ETH vault (borrowed ${Number(got) / 1e18} TACE after the fee); under 0.004 is refused`);
} finally {
  try { rpc('evm_revert', [snap]); } catch { /* the fork is thrown away anyway */ }
  rmSync(dir, { recursive: true, force: true });
}
