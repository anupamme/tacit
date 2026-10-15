#!/usr/bin/env node
// TacVault keeper.
//
// With ORACLE set (one or more venue oracles, comma separated), it records their intervals: every interval within
// an oracle's longest window that is not yet recorded (so a first run fills the history at once), each proven at its
// sample block, which the following block's mixHash picks. RPC must serve `eth_getProof` for blocks as old as the
// longest window (an archive endpoint); the keeper checks this at start and exits if not. When both venues need the
// same interval it records them in one transaction (through Multicall3, when the chain has it), and it looks at the
// newest intervals every RECORD_POLL_SECONDS (a full sweep of the window every FULL_SWEEP_SECONDS), because a record
// that lands more than GRACE blocks after its interval ends pauses borrowing. Records pay at most MAX_GWEI, and at
// most URGENT_MAX_GWEI once a needed interval is URGENT_AFTER_BLOCKS old; above the cap they are skipped and anyone
// can fill the interval later, for about 21 hours.
//
// With VAULTS set, it reads each vault's borrowers from its Borrowed events (in chunks, remembering them) and:
//   - calls `liquidate` on a vault with debt that is below the liquidation line (not while the owner has paused
//     auctions), and `cancel` on an auction whose vault has recovered;
//   - once an auction has run AUCTION_DURATION, calls `absorb` when it can, and otherwise reports the vault.
//
// Every call is simulated first and sent only if it would succeed, with a gas limit 30% above the estimate. Vault
// actions pay at most ACTION_MAX_GWEI, since a liquidation must not wait out a gas spike. A transaction that mines
// but reverts is reported. Anyone can run one.
//
// Lines starting ALERT report what an operator may want to act on: an auction opened on a vault (its owner can repay
// or add TAC until the owner window ends), a venue's price more than 40% under its longest window's upper median or
// 60% over its lower one, an oracle the vault's owner has announced or put in place whose venues are not recorded
// here, and intervals that could not be recorded. With ALERT_WEBHOOK set, each is also posted there as {"text": "..."}.
//
// Usage:
//   KEEPER_ACCOUNT=<cast keystore name> [KEEPER_PASSWORD_FILE=..] RPC=<archive endpoint>
//   [ORACLE=0xvenue1,0xvenue2] [VAULTS=0xusd,0xeth FROM_BLOCK=<vault deploy block>] [SEND_RPC=https://...]
//   [MAX_GWEI=1] [RECORD_TIP_GWEI=0.001] [URGENT_MAX_GWEI=25] [URGENT_TIP_GWEI=0.1] [URGENT_AFTER_BLOCKS=5]
//   [ACTION_MAX_GWEI=100] [ACTION_TIP_GWEI=0.1] [RECORD_POLL_SECONDS=12] [FULL_SWEEP_SECONDS=300] [SCAN_SECONDS=60]
//   [LOG_CHUNK=5000] [ALERT_WEBHOOK=https://...] [ONCE=1]
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
const URGENT_CAP = gwei(process.env.URGENT_MAX_GWEI || 25);
const URGENT_TIP = gwei(process.env.URGENT_TIP_GWEI || 0.1);
const URGENT_AFTER = BigInt(process.env.URGENT_AFTER_BLOCKS || 5);
const RECORD_POLL = Number(process.env.RECORD_POLL_SECONDS || 12);
const FULL_SWEEP = Number(process.env.FULL_SWEEP_SECONDS || 300);
const SCAN_SECONDS = Number(process.env.SCAN_SECONDS || 60);
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MAX_CHUNK = BigInt(process.env.LOG_CHUNK || 5000);
let logChunk = MAX_CHUNK;
const ONCE = process.env.ONCE === '1';

const cast = (args) => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const num = (s) => BigInt(s.split(' ')[0]);
const call = (to, sig, ...a) => cast(['call', to, sig, ...a, '--rpc-url', RPC]);
const errLine = (e) => String(e.stderr || e.message).split('\n')[0];
const log = (...m) => console.log(new Date().toISOString(), ...m);
const head = () => num(cast(['block-number', '--rpc-url', RPC]));

// Reports something an operator may act on: a log line, and a POST to ALERT_WEBHOOK when set. Each key alerts once
// until it is cleared.
const alerted = new Set();
function alertOnce(key, msg) {
  if (alerted.has(key)) return;
  alerted.add(key);
  log('ALERT', msg);
  if (!ALERT_WEBHOOK) return;
  fetch(ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `tac-vault-keeper: ${msg}` }) })
    .catch((e) => log('alert webhook failed:', String(e.message || e)));
}
const clearAlert = (key) => alerted.delete(key);

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

function readConfig(oracle) {
  if (configs.has(oracle)) return true;
  try {
    const step = num(call(oracle, 'STEP()(uint256)'));
    const [slotA, slotB] = call(oracle, 'slots()(bytes32,bytes32)').split('\n');
    configs.set(oracle, {
      pool: call(oracle, 'POOL()(address)'),
      slots: [slotA, slotB],
      step,
      intervals: num(call(oracle, 'MAX_WINDOW()(uint256)')) / (step * 12n) + 2n,
    });
    return true;
  } catch (e) {
    log(oracle, 'oracle read failed:', errLine(e));
    return false;
  }
}

// Records to the venues' oracles go through Multicall3 when two are due together and the chain has it.
let hasMulticall;
function multicall() {
  if (hasMulticall === undefined) {
    try {
      hasMulticall = cast(['code', MULTICALL3, '--rpc-url', RPC]).length > 2;
    } catch {
      hasMulticall = false;
    }
  }
  return hasMulticall;
}

const RECORD_SIG = 'record(bytes,bytes,bytes[],bytes[],bytes[])';
let lastFull = 0;

// The arguments of `record` for interval k of an oracle: its sample block is picked by the next block's mixHash.
function buildRecord(oracle, c, k, top) {
  const next = (k + 1n) * c.step;
  const mix = BigInt(cast(['block', String(next), '--field', 'mixHash', '--rpc-url', RPC]));
  const n = k * c.step + (mix % c.step);
  const p = JSON.parse(cast(['proof', c.pool, ...c.slots, '-B', String(n), '--rpc-url', RPC]));
  const list = (a) => `[${a.join(',')}]`;
  const args = [
    cast(['block', String(n), '--raw', '--rpc-url', RPC]),
    cast(['block', String(next), '--raw', '--rpc-url', RPC]),
    list(p.accountProof),
    list(p.storageProof[0].proof),
    list(p.storageProof[1].proof),
  ];
  return { oracle, k, n, args, age: top - next };
}

// Looks at the newest intervals of every oracle (all of those a window needs once in FULL_SWEEP seconds) and records
// what is missing, newest first, so a long outage is repaired from the intervals every window needs most.
function sampleAll() {
  const full = Date.now() - lastFull >= FULL_SWEEP * 1000;
  for (const oracle of ORACLES) if (!readConfig(oracle)) return;
  const top = head();
  const baseFee = num(cast(['base-fee', '--rpc-url', RPC]));
  const depth = full ? Math.max(...ORACLES.map((o) => Number(configs.get(o).intervals))) : 3;
  let missed = 0;
  for (let i = 0; i < depth; i++) {
    const due = [];
    for (const oracle of ORACLES) {
      const c = configs.get(oracle);
      if (BigInt(i) >= c.intervals) continue;
      // The newest interval whose following block exists, then i back.
      const k = (top - 1n) / c.step - 1n - BigInt(i);
      if (k < 0n) continue;
      try {
        if (recorded(oracle, k)) continue;
        due.push(buildRecord(oracle, c, k, top));
      } catch (e) {
        ++missed;
        log(oracle, 'record', String(k), 'failed:', errLine(e));
      }
    }
    if (due.length) missed += submit(due, baseFee);
  }
  if (full) lastFull = Date.now();
  if (missed) alertOnce('missed', `${missed} interval(s) could not be recorded; borrowing and liquidation wait for them`);
  else clearAlert('missed');
}

// Sends the due records: one transaction when more than one is due and Multicall3 exists, else one each. Returns how
// many were not recorded.
function submit(due, baseFee) {
  // An interval that is already older than URGENT_AFTER blocks is nearly late: pay up to the urgent cap for it.
  const urgent = due.some((d) => d.age >= URGENT_AFTER);
  const cap = urgent ? URGENT_CAP : RECORD_CAP;
  const tip = urgent ? URGENT_TIP : RECORD_TIP;
  if (baseFee > cap) {
    log('base fee', String(baseFee), urgent ? 'above URGENT_MAX_GWEI' : 'above MAX_GWEI', ': not recording');
    return urgent ? due.length : 0;
  }
  let missed = 0;
  const ready = [];
  for (const d of due) {
    const sim = simulate(d.oracle, RECORD_SIG, ...d.args);
    if (sim.ok) ready.push(d);
    // Another keeper recorded it first.
    else if (!sim.reason.includes(alreadyRecorded)) {
      ++missed;
      log(d.oracle, 'record', String(d.k), 'would fail:', sim.reason);
    }
  }
  if (!ready.length) return missed;
  // One at a time: the fallback when a batch is not possible or fails.
  const each = (list) => {
    for (const d of list) {
      try {
        log(d.oracle, 'record', String(d.k), String(d.n), send(d.oracle, RECORD_SIG, d.args, cap, tip));
      } catch (e) {
        // Another keeper recorded it between the simulation and the estimate, or its transaction landed first and
        // ours mined and reverted.
        if (errLine(e).includes(alreadyRecorded) || recorded(d.oracle, d.k)) continue;
        ++missed;
        log(d.oracle, 'record', String(d.k), 'failed:', errLine(e));
      }
    }
  };
  if (ready.length > 1 && multicall()) {
    // Every call must succeed (allowFailure false): the gas estimate then covers all of them, and a batch that
    // loses a race to another keeper reverts whole and is sent again one at a time.
    try {
      const calls = ready.map((d) => `(${d.oracle},false,${cast(['calldata', RECORD_SIG, ...d.args])})`);
      const hash = send(MULTICALL3, 'aggregate3((address,bool,bytes)[])', [`[${calls.join(',')}]`], cap, tip);
      for (const d of ready) log(d.oracle, 'record', String(d.k), String(d.n), hash);
    } catch (e) {
      log('batch failed, recording one at a time:', errLine(e));
      each(ready.filter((d) => !recorded(d.oracle, d.k)));
    }
  } else {
    each(ready);
  }
  return missed;
}

// A venue whose price is more than 40% under its longest window's upper median, or 60% over its lower one, is worth
// a look: the vaults price from medians, so a move this size either holds (and moves the views) or is traded back.
function checkVenues() {
  for (const oracle of ORACLES) {
    const key = `venue:${oracle}`;
    try {
      const max = num(call(oracle, 'MAX_WINDOW()(uint256)'));
      const [low, high] = call(oracle, 'prices(uint256)(uint256,uint256)', String(max)).split('\n').map(num);
      const spot = num(call(oracle, 'spot()(uint256)'));
      if (spot * 100n < high * 60n) alertOnce(key, `${oracle}: price is more than 40% below its ${max / 3600n}-hour median`);
      else if (spot * 100n > low * 160n) alertOnce(key, `${oracle}: price is more than 60% above its ${max / 3600n}-hour median`);
      else clearAlert(key);
    } catch {
      // Too few intervals recorded for a median: nothing to compare with.
    }
  }
}

// A vault whose owner swaps the oracle (announced ORACLE_DELAY ahead) prices from venues this keeper may not be
// recording: its ORACLE env names the venues, and a new pair needs its own intervals recorded or its prices lapse.
function checkVaultOracles() {
  const known = new Set(ORACLES.map((o) => o.toLowerCase()));
  for (const vault of VAULTS) {
    try {
      const venuesOf = (oracle) => {
        try { return [call(oracle, 'A()(address)'), call(oracle, 'B()(address)')]; } catch { return [oracle]; }
      };
      const now = call(vault, 'ORACLE()(address)');
      const stray = venuesOf(now).filter((v) => !known.has(v.toLowerCase()));
      const key = `oracle:${vault}:${now}`;
      if (ORACLES.length && stray.length) alertOnce(key, `${vault}: its oracle ${now} prices from ${stray.join(', ')}, not recorded here; restart with ORACLE set to them`);
      else clearAlert(key);
      const next = call(vault, 'pendingOracle()(address)');
      // An announcement that was cancelled (or carried out) is forgotten, so announcing it again alerts again.
      for (const k of [...alerted]) if (k.startsWith(`pending-oracle:${vault}:`) && k !== `pending-oracle:${vault}:${next}`) clearAlert(k);
      if (!/^0x0+$/.test(next)) {
        const eta = num(call(vault, 'pendingOracleEta()(uint256)'));
        const venues = venuesOf(next).filter((v) => !known.has(v.toLowerCase()));
        alertOnce(`pending-oracle:${vault}:${next}`, `${vault}: oracle ${next} is announced from ${new Date(Number(eta) * 1000).toISOString()}${venues.length ? `; record ${venues.join(', ')} before then` : ''}`);
      }
    } catch (e) {
      log(vault, 'oracle check failed:', errLine(e));
    }
  }
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
  let window = 0n;
  try {
    window = num(call(vault, 'OWNER_WINDOW()(uint256)'));
  } catch {}
  // While the owner has paused auctions, `liquidate` and `absorb` are refused; `cancel` is not.
  let pausedUntil = 0n;
  try {
    pausedUntil = num(call(vault, 'pausedUntil()(uint256)'));
  } catch {}
  const paused = now < pausedUntil;
  if (paused) log(vault, 'auctions paused until', new Date(Number(pausedUntil) * 1000).toISOString(), ': not liquidating or absorbing');
  for (const owner of list) {
    try {
      const [, debt, start] = call(vault, 'vaults(address)(uint256,uint256,uint256)', owner).split('\n').map(num);
      const key = `auction:${vault}:${owner}`;
      if (start !== 0n) {
        alertOnce(key, `auction on ${vault} for ${owner}: its owner can repay or add TAC until ${new Date(Number(start + window) * 1000).toISOString()}`);
      } else {
        clearAlert(key);
      }
      if (debt === 0n) continue;
      if (start === 0n) {
        if (!paused && call(vault, 'liqHealthyView(address)(bool)', owner) === 'false' && simulate(vault, 'liquidate(address)', owner).ok) {
          log(vault, 'liquidate', owner, act(vault, 'liquidate(address)', owner));
          alertOnce(key, `auction on ${vault} for ${owner}: its owner can repay or add TAC for ${window} seconds`);
        }
      } else if (simulate(vault, 'cancel(address)', owner).ok) {
        log(vault, 'cancel', owner, act(vault, 'cancel(address)', owner));
      } else if (now - start >= duration && !paused) {
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
  let lastScan = 0;
  for (;;) {
    if (ORACLES.length) sampleAll();
    if (Date.now() - lastScan >= SCAN_SECONDS * 1000 || ONCE) {
      for (const v of VAULTS) scan(v);
      checkVenues();
      checkVaultOracles();
      lastScan = Date.now();
    }
    if (ONCE) return;
    await new Promise((r) => setTimeout(r, RECORD_POLL * 1000));
  }
}

main();
