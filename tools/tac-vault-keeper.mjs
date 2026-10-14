#!/usr/bin/env node
// TacVault keeper.
//
// With ORACLE set (one or more venue oracles, comma separated), it records their intervals: every interval within
// an oracle's longest window that is not yet recorded (so a first run fills the history at once), each proven at its
// sample block, which the following block's mixHash picks. RPC must serve `eth_getProof` for blocks as old as the
// longest window (an archive endpoint); the keeper checks this at start and exits if not. Records are skipped while
// the base fee is above MAX_GWEI; anyone can fill an interval later, for about 21 hours.
//
// With VAULTS set, it reads each vault's borrowers from its Borrowed events (in chunks, remembering them) and:
//   - calls `liquidate` on a vault with debt that is below the liquidation line, and `cancel` on an auction whose
//     vault has recovered;
//   - once an auction has run AUCTION_DURATION, calls `absorb` when it can, and otherwise reports the vault.
//
// Every call is simulated first and sent only if it would succeed, with a gas limit 30% above the estimate. Records
// pay at most MAX_GWEI per gas; vault actions pay at most ACTION_MAX_GWEI, since a liquidation must not wait out
// a gas spike. A transaction that mines but reverts is reported. Anyone can run one.
//
// Usage:
//   KEEPER_ACCOUNT=<cast keystore name> [KEEPER_PASSWORD_FILE=..] RPC=<archive endpoint>
//   [ORACLE=0xvenue1,0xvenue2] [VAULTS=0xusd,0xeth FROM_BLOCK=<vault deploy block>] [SEND_RPC=https://...]
//   [MAX_GWEI=1] [RECORD_TIP_GWEI=0.001] [ACTION_MAX_GWEI=100] [ACTION_TIP_GWEI=0.1] [SCAN_SECONDS=60]
//   [LOG_CHUNK=5000] [ONCE=1]
//   node tools/tac-vault-keeper.mjs
// KEEPER_PRIV=0x.. works too, but the key is then visible to every local process in the command line of each send.

import { execFileSync } from 'node:child_process';

const KEEPER_PRIV = process.env.KEEPER_PRIV;
const KEEPER_ACCOUNT = process.env.KEEPER_ACCOUNT;
const ORACLES = (process.env.ORACLE || '').split(',').map((s) => s.trim()).filter(Boolean);
const VAULTS = (process.env.VAULTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const RPC = process.env.RPC;
if (!(KEEPER_PRIV || KEEPER_ACCOUNT) || !RPC || !(VAULTS.length || ORACLES.length) || (VAULTS.length && !process.env.FROM_BLOCK)) {
  console.error('set KEEPER_ACCOUNT (or KEEPER_PRIV), RPC, and ORACLE and/or VAULTS with FROM_BLOCK');
  process.exit(2);
}
const SEND_RPC = process.env.SEND_RPC || RPC;
const gwei = (x) => BigInt(Math.round(Number(x) * 1e9));
const RECORD_CAP = gwei(process.env.MAX_GWEI || 1);
const RECORD_TIP = gwei(process.env.RECORD_TIP_GWEI || 0.001);
const ACTION_CAP = gwei(process.env.ACTION_MAX_GWEI || 100);
const ACTION_TIP = gwei(process.env.ACTION_TIP_GWEI || 0.1);
const SCAN_SECONDS = Number(process.env.SCAN_SECONDS || 60);
const MAX_CHUNK = BigInt(process.env.LOG_CHUNK || 5000);
let logChunk = MAX_CHUNK;
const ONCE = process.env.ONCE === '1';

const cast = (args) => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const num = (s) => BigInt(s.split(' ')[0]);
const call = (to, sig, ...a) => cast(['call', to, sig, ...a, '--rpc-url', RPC]);
const errLine = (e) => String(e.stderr || e.message).split('\n')[0];
const log = (...m) => console.log(new Date().toISOString(), ...m);
const head = () => num(cast(['block-number', '--rpc-url', RPC]));

// A cast keystore account keeps the key out of the process list; KEEPER_PRIV passes it as an argument.
const signer = KEEPER_ACCOUNT
  ? ['--account', KEEPER_ACCOUNT, ...(process.env.KEEPER_PASSWORD_FILE ? ['--password-file', process.env.KEEPER_PASSWORD_FILE] : [])]
  : ['--private-key', KEEPER_PRIV];
let sender;
try {
  sender = cast(['wallet', 'address', ...signer]);
} catch (e) {
  console.error('cannot load the signing key:', errLine(e));
  process.exit(2);
}
if (!KEEPER_ACCOUNT) log('WARNING: KEEPER_PRIV is visible in the process list; prefer KEEPER_ACCOUNT');

// Simulates a call from the keeper's address: { ok, reason }.
function simulate(to, sig, ...a) {
  try {
    cast(['call', to, sig, ...a, '--from', sender, '--rpc-url', RPC]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errLine(e) };
  }
}

// Sends with a gas limit 30% over the estimate and the given fee cap and tip, waits for the receipt (up to five
// minutes, so the next send takes the next nonce) and returns the hash; throws if the transaction reverted.
function send(to, sig, args, cap, tip) {
  const estimate = num(cast(['estimate', to, sig, ...args, '--from', sender, '--rpc-url', RPC]));
  const out = cast([
    'send', to, sig, ...args, ...signer, '--gas-limit', String(estimate * 13n / 10n), '--gas-price', String(cap),
    '--priority-gas-price', String(tip < cap ? tip : cap), '--timeout', '300', '--rpc-url', SEND_RPC, '--json',
  ]);
  const receipt = JSON.parse(out);
  if (!/1$/.test(String(receipt.status))) throw new Error(`REVERTED on chain: ${receipt.transactionHash}`);
  return receipt.transactionHash;
}

const alreadyRecorded = cast(['sig', 'AlreadyRecorded()']);

const recorded = (oracle, k) => {
  try {
    return num(call(oracle, 'sampleOf(uint256)(uint256,uint256)', String(k)).split('\n')[0]) !== 0n;
  } catch {
    return false;
  }
};

// Each venue oracle: the contract whose storage it proves, the two slots, its interval and how many to keep.
const configs = new Map();

function sampleAll() {
  const baseFee = num(cast(['base-fee', '--rpc-url', RPC]));
  if (baseFee > RECORD_CAP) return log('base fee', String(baseFee), 'above MAX_GWEI: not recording');
  for (const oracle of ORACLES) sample(oracle);
}

function sample(oracle) {
  try {
    if (!configs.has(oracle)) {
      const step = num(call(oracle, 'STEP()(uint256)'));
      const [slotA, slotB] = call(oracle, 'slots()(bytes32,bytes32)').split('\n');
      configs.set(oracle, {
        pool: call(oracle, 'POOL()(address)'),
        slots: [slotA, slotB],
        step,
        intervals: num(call(oracle, 'MAX_WINDOW()(uint256)')) / (step * 12n) + 2n,
      });
    }
  } catch (e) {
    log(oracle, 'oracle read failed:', errLine(e));
    return;
  }
  const { pool, slots, step, intervals } = configs.get(oracle);
  // The newest interval whose following block exists.
  const latest = (head() - 1n) / step - 1n;
  let missed = 0;
  // Newest first, so a long outage is repaired from the intervals every window needs most.
  for (let k = latest; k > latest - intervals; k--) {
    if (k < 0n) continue;
    try {
      if (recorded(oracle, k)) continue;
      const next = (k + 1n) * step;
      const mix = BigInt(cast(['block', String(next), '--field', 'mixHash', '--rpc-url', RPC]));
      const n = k * step + (mix % step);
      const p = JSON.parse(cast(['proof', pool, ...slots, '-B', String(n), '--rpc-url', RPC]));
      const list = (a) => `[${a.join(',')}]`;
      const args = [
        cast(['block', String(n), '--raw', '--rpc-url', RPC]),
        cast(['block', String(next), '--raw', '--rpc-url', RPC]),
        list(p.accountProof),
        list(p.storageProof[0].proof),
        list(p.storageProof[1].proof),
      ];
      const sig = 'record(bytes,bytes,bytes[],bytes[],bytes[])';
      const sim = simulate(oracle, sig, ...args);
      if (!sim.ok) {
        // Another keeper recorded it first.
        if (sim.reason.includes(alreadyRecorded)) continue;
        ++missed;
        log(oracle, 'record', String(k), 'would fail:', sim.reason);
        continue;
      }
      log(oracle, 'record', String(k), String(n), send(oracle, sig, args, RECORD_CAP, RECORD_TIP));
    } catch (e) {
      // Another keeper recorded it between the simulation and the estimate, or its transaction landed first and
      // ours mined and reverted.
      if (errLine(e).includes(alreadyRecorded) || recorded(oracle, k)) continue;
      ++missed;
      log(oracle, 'record', String(k), 'failed:', errLine(e));
    }
  }
  if (missed) log(oracle, 'INTERVALS NOT RECORDED:', missed);
}

// Per vault: borrowers seen in Borrowed(address indexed owner, address to, uint256 amount, uint256 fee) and the
// next block to read. Only a real borrow of at least MIN_DEBT puts an owner here.
const seen = new Map(VAULTS.map((v) => [v, { owners: new Set(), next: BigInt(process.env.FROM_BLOCK || 0) }]));

function readOwners(vault) {
  const s = seen.get(vault);
  const top = head();
  while (s.next <= top) {
    const to = s.next + logChunk - 1n < top ? s.next + logChunk - 1n : top;
    let out;
    try {
      out = cast([
        'logs', '--address', vault, '--from-block', String(s.next), '--to-block', String(to),
        'Borrowed(address indexed,address,uint256,uint256)', '--rpc-url', RPC, '--json',
      ]);
    } catch (e) {
      // A provider's range limit: retry with a smaller chunk.
      if (logChunk <= 100n) throw e;
      logChunk /= 2n;
      log('log range refused, chunk now', String(logChunk));
      continue;
    }
    for (const l of JSON.parse(out || '[]')) s.owners.add('0x' + l.topics[1].slice(26));
    s.next = to + 1n;
  }
  // A pass without a refusal lets a chunk that was halved by a transient error grow back.
  if (logChunk < MAX_CHUNK) logChunk = logChunk * 2n < MAX_CHUNK ? logChunk * 2n : MAX_CHUNK;
  return [...s.owners];
}

const act = (vault, sig, owner) => send(vault, sig, [owner], ACTION_CAP, ACTION_TIP);

function scan(vault) {
  let list;
  try {
    list = readOwners(vault);
  } catch (e) {
    log(vault, 'LOG SCAN FAILED, vaults are not being checked:', errLine(e));
    return;
  }
  let duration;
  try {
    duration = num(call(vault, 'AUCTION_DURATION()(uint256)'));
  } catch (e) {
    log(vault, 'read failed:', errLine(e));
    return;
  }
  const now = num(cast(['block', 'latest', '--field', 'timestamp', '--rpc-url', RPC]));
  for (const owner of list) {
    try {
      const [, debt, start] = call(vault, 'vaults(address)(uint256,uint256,uint256)', owner).split('\n').map(num);
      if (debt === 0n) continue;
      if (start === 0n) {
        if (call(vault, 'liqHealthyView(address)(bool)', owner) === 'false' && simulate(vault, 'liquidate(address)', owner).ok) {
          log(vault, 'liquidate', owner, act(vault, 'liquidate(address)', owner));
        }
      } else if (simulate(vault, 'cancel(address)', owner).ok) {
        log(vault, 'cancel', owner, act(vault, 'cancel(address)', owner));
      } else if (now - start >= duration) {
        if (simulate(vault, 'absorb(address)', owner).ok) log(vault, 'absorb', owner, act(vault, 'absorb(address)', owner));
        else log(vault, owner, 'auction unsold and not absorbable (vault worth its debt, or the reserve is empty)');
      }
    } catch (e) {
      log(vault, owner, 'check failed:', errLine(e));
    }
  }
}

async function main() {
  for (const oracle of ORACLES) {
    try {
      // The oldest block the keeper reads: its longest window of intervals back.
      const step = num(call(oracle, 'STEP()(uint256)'));
      const reach = (num(call(oracle, 'MAX_WINDOW()(uint256)')) / (step * 12n) + 3n) * step;
      const oldest = head() > reach ? head() - reach : 1n;
      cast(['proof', call(oracle, 'POOL()(address)'), '0', '-B', String(oldest), '--rpc-url', RPC]);
    } catch (e) {
      console.error('RPC does not serve eth_getProof for old blocks; use an archive endpoint:', errLine(e));
      process.exit(2);
    }
  }
  for (;;) {
    if (ORACLES.length) sampleAll();
    for (const v of VAULTS) scan(v);
    if (ONCE) return;
    await new Promise((r) => setTimeout(r, SCAN_SECONDS * 1000));
  }
}

main();
