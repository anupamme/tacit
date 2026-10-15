#!/usr/bin/env node
// TacVault admin helper: what the owner can change, what is waiting, and the calldata to send from the multisig.
//
//   RPC=<endpoint> [FROM_BLOCK=<synth deploy block>] node tools/tac-vault-admin.mjs status <vault> [<synth>]
//   node tools/tac-vault-admin.mjs call <action> [args...]            (prints `data` for the multisig; to = the vault)
//
// status: every governed term now, what is announced (with the time it may be executed), the oracle in place and
// the one announced, the locks, the pause and the lending capacity now. Read-only.
//
// call: builds calldata with foundry's `cast calldata`; nothing is sent. Actions, with their speed:
//   at once   set-ceiling <wei> | set-borrow-fee <bps> | set-redemption-fee <bps> | lower-depth <bps> | pause <seconds>
//             | resume | set-fee-to <addr> | set-tac-sink <addr> | set-pauser <addr>
//             (a pause is at most 12 h and the next can start only 12 h after it ends; in a genuine crash a pause
//             only delays liquidations, so prefer 3-6 h unless a price is clearly being held away from the market)
//   announce  queue <term> <value> | execute <term> | cancel <term>       terms: depth mint liq bonus owner-window
//             auction min-debt (depth in bps; ratios and bonus in bps; windows in seconds; min-debt in wei)
//   oracle    queue-oracle <addr> | execute-oracle | cancel-oracle
//   locks     lock-params | lock-oracle | lock-minters (on the synth)        each ends the owner's power for good; the
//             three are separate. After lower-depth 0 the way back is 0, 25, 75, 175 ... (one doubling per wait): for an
//             emergency stop prefer set-ceiling 0.
//   synth     queue-minter <addr> | execute-minter | cancel-minter | remove-minter <addr> | lock-minters   (send to the synth)

import { execFileSync } from 'node:child_process';

const cast = (args) => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TERMS = { depth: 0, mint: 1, liq: 2, bonus: 3, 'owner-window': 4, auction: 5, 'min-debt': 6 };
const TERM_NAMES = Object.fromEntries(Object.entries(TERMS).map(([k, v]) => [v, k]));

const CALLS = {
  'set-ceiling': ['setDebtCeiling(uint256)', 1],
  'set-borrow-fee': ['setBorrowFee(uint256)', 1],
  'set-redemption-fee': ['setRedemptionFee(uint256)', 1],
  'lower-depth': ['lowerDepthBps(uint256)', 1],
  pause: ['pauseAuctions(uint256)', 1],
  resume: ['resumeAuctions()', 0],
  'set-fee-to': ['setFeeTo(address)', 1],
  'set-tac-sink': ['setTacSink(address)', 1],
  'set-pauser': ['setPauser(address)', 1],
  'queue-oracle': ['queueOracle(address)', 1],
  'execute-oracle': ['executeOracle()', 0],
  'cancel-oracle': ['cancelOracle()', 0],
  'lock-params': ['lockParams()', 0],
  'lock-oracle': ['lockOracle()', 0],
  'queue-minter': ['queueMinter(address)', 1],
  'execute-minter': ['executeMinter()', 0],
  'cancel-minter': ['cancelMinter()', 0],
  'remove-minter': ['removeMinter(address)', 1],
  'lock-minters': ['lockMinters()', 0],
};

function build(action, args) {
  if (['queue', 'execute', 'cancel'].includes(action)) {
    const term = args[0];
    if (!(term in TERMS)) throw new Error(`term must be one of ${Object.keys(TERMS).join(', ')}`);
    if (action === 'queue') {
      if (args[1] === undefined) throw new Error('queue <term> <value>');
      return cast(['calldata', 'queueParam(uint8,uint256)', String(TERMS[term]), String(args[1])]);
    }
    return cast(['calldata', `${action}Param(uint8)`, String(TERMS[term])]);
  }
  const c = CALLS[action];
  if (!c) throw new Error(`unknown action ${action}`);
  if (args.length !== c[1]) throw new Error(`${action} takes ${c[1]} argument(s)`);
  return cast(['calldata', c[0], ...args.map(String)]);
}

const rpc = process.env.RPC;
const call = (to, sig) => cast(['call', to, sig, '--rpc-url', rpc]);
const num = (s) => BigInt(s.split(' ')[0]);
const when = (t) => (t === 0n ? '-' : new Date(Number(t) * 1000).toISOString());

function status(vault, synth) {
  if (!rpc) throw new Error('set RPC');
  const now = BigInt(cast(['block', 'latest', '--field', 'timestamp', '--rpc-url', rpc]));
  const bps = (sig) => num(call(vault, sig));
  console.log(`vault ${vault}   owner ${call(vault, 'owner()(address)')}   chain time ${when(now)}`);
  console.log('\nterms now');
  const rows = [
    ['depth share (bps)', 'DEPTH_BPS()(uint256)'], ['mint ratio (bps)', 'MINT_RATIO_BPS()(uint256)'], ['liquidation ratio (bps)', 'LIQ_RATIO_BPS()(uint256)'],
    ['liquidation bonus (bps)', 'LIQ_BONUS_BPS()(uint256)'], ['owner window (s)', 'OWNER_WINDOW()(uint256)'], ['auction length (s)', 'AUCTION_DURATION()(uint256)'],
    ['minimum debt (wei)', 'MIN_DEBT()(uint256)'], ['redemption fee (bps)', 'REDEMPTION_FEE_BPS()(uint256)'], ['borrow fee (bps)', 'borrowFeeBps()(uint256)'],
    ['debt ceiling (wei)', 'debtCeiling()(uint256)'], ['longest oracle window (s)', 'LIQ_WINDOW()(uint256)'],
  ];
  for (const [label, sig] of rows) console.log(`  ${label.padEnd(26)} ${bps(sig)}`);
  console.log(`  ${'fee address'.padEnd(26)} ${call(vault, 'feeTo()(address)')}`);
  console.log(`  ${'absorb sink'.padEnd(26)} ${call(vault, 'tacSink()(address)')}`);
  console.log(`  ${'pauser'.padEnd(26)} ${call(vault, 'pauser()(address)')}`);
  const pausedUntil = bps('pausedUntil()(uint256)');
  console.log(`  ${'paused until'.padEnd(26)} ${pausedUntil > now ? when(pausedUntil) : 'no'}`);
  console.log('\nannounced changes');
  const expiry = num(call(vault, 'QUEUE_EXPIRY()(uint256)'));
  const state = (eta) => (eta > now ? 'from ' + when(eta) : now > eta + expiry ? 'LAPSED (announce again)' : 'NOW, until ' + when(eta + expiry));
  let any = false;
  for (const [id, name] of Object.entries(TERM_NAMES)) {
    const out = cast(['call', vault, 'queuedParam(uint8)(uint192,uint64)', id, '--rpc-url', rpc]).split('\n');
    const [value, eta] = [num(out[0]), num(out[1])];
    if (eta !== 0n) { any = true; console.log(`  ${name.padEnd(14)} -> ${value}   executable ${state(eta)}`); }
  }
  const pend = call(vault, 'pendingOracle()(address)');
  if (/^0x0+$/.test(pend)) { if (!any) console.log('  none'); }
  else { any = true; console.log(`  oracle         -> ${pend}   executable ${state(num(call(vault, 'pendingOracleEta()(uint256)')))}`); }
  console.log(`\noracle in place ${call(vault, 'ORACLE()(address)')}`);
  console.log(`locks: params ${call(vault, 'paramsLocked()(bool)')}, oracle ${call(vault, 'oracleLocked()(bool)')}`);
  try { console.log(`lending capacity now (synth wei): ${call(vault, 'depthCeiling()(uint256)')}   borrowed: ${call(vault, 'totalDebt()(uint256)')}`); }
  catch { console.log('lending capacity now: no price recorded'); }
  if (synth) {
    const minter = call(synth, 'pendingMinter()(address)');
    const mEta = /^0x0+$/.test(minter) ? 0n : num(call(synth, 'pendingMinterEta()(uint256)'));
    console.log(`\nsynth ${synth}: announced minter ${minter}${mEta ? '   executable ' + state(mEta) : ''}, minters locked ${call(synth, 'mintersLocked()(bool)')}`);
    // Minters added after deployment, from the synth's events, each checked as it stands now.
    try {
      const logs = JSON.parse(cast(['logs', '--from-block', process.env.FROM_BLOCK || 'earliest', '--to-block', 'latest', '--address', synth, 'MinterAdded(address indexed minter)', '--rpc-url', rpc, '--json']));
      const added = [...new Set(logs.map((l) => '0x' + l.topics[1].slice(26)))];
      const live = added.filter((m) => cast(['call', synth, 'isMinter(address)(bool)', m, '--rpc-url', rpc]) === 'true');
      console.log(`  further minters now: ${live.length ? live.join(', ') : 'none'}${added.length > live.length ? ` (${added.length - live.length} added and since removed)` : ''}`);
    } catch (e) {
      console.log(`  further minters: could not read the synth's events (${String(e.stderr || e.message).split('\n')[0]}); set FROM_BLOCK to its deploy block`);
    }
    console.log('  (a further minter can mint without limit: lock-minters on the synth ends that power, lock-params and lock-oracle do not)');
  }
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'status' && rest[0]) status(rest[0], rest[1]);
  else if (cmd === 'call' && rest[0]) console.log(build(rest[0], rest.slice(1)));
  else { console.error('usage: status <vault> [<synth>] | call <action> [args]  (see the header of this file)'); process.exit(2); }
} catch (e) {
  console.error(String(e.stderr || e.message).split('\n')[0]);
  process.exit(1);
}
