#!/usr/bin/env node
// Reference program inputs for dapp/sp1-stdin.js, written by the harnesses themselves.
//
// For each case below it writes tests/fixtures/sp1-stdin/<case>.op.json (a committed fixture op from fixtures/, or one
// built from them, with deterministic memoHashes, one per note or lock leaf the op appends) and then
// tests/fixtures/sp1-stdin/<case>.bin: bincode::serialize(&stdin) of the SP1Stdin that op's harness
// (harnesses/exec-<op>.rs, picked as worker-relay/src/lib/prover.js picks it) builds from that file.
//
// The harnesses are not edited. Each one is copied, as a module, into one scratch crate whose `main` runs the harness
// named by HARNESS; the copy gains one statement just before it would prove: under MODE=stdin it writes
// bincode::serialize(&stdin) to STDIN_OUT and returns. Nothing is proved and no network client is made.
//
//   node contracts/sp1/confidential/dump-stdin.mjs [case ...]
//
// Env: CARGO_TARGET_DIR  a target dir to build in (an existing harness build reuses its compiled dependencies;
//                        default harnesses/target)
//      DUMP_CRATE_DIR    where to put the scratch crate (default: a new temporary directory)

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const HARNESSES = path.join(HERE, 'harnesses');
const FIXTURES = path.join(HERE, 'fixtures');
const OUT = path.join(ROOT, 'tests/fixtures/sp1-stdin');

// Op type -> harness (worker-relay/src/lib/prover.js PEROP).
const HARNESS = {
  wrap: 'exec-wrap', transfer: 'exec-prove', unwrap: 'exec-unwrap', sendunwrap: 'exec-sendunwrap', wraptransfer: 'exec-wraptransfer',
  swap: 'exec-swap', route: 'exec-route', lp: 'exec-lp', lpremove: 'exec-lpremove', lpbond: 'exec-lpbond',
  farmbond: 'exec-farmbond', farmharvest: 'exec-farmharvest', farmunbond: 'exec-farmunbond',
  stealthlock: 'exec-stealthlock', stealthlockbatch: 'exec-stealthlockbatch', stealthclaim: 'exec-stealthclaim', stealthrefund: 'exec-stealthrefund',
  bridgeburn: 'exec-bridgeburn', bridgemint: 'exec-bridgemint', bridgestealthmint: 'exec-bridgestealthmint', cbtcmint: 'exec-cbtcmint',
  cdpmint: 'exec-cdpmint', cdpclose: 'exec-cdpclose', cdptopup: 'exec-cdptopup', cdpliquidate: 'exec-cdpliquidate',
  wraplp: 'exec-wraplp', wrapswap: 'exec-wrapswap', wrapcdpmint: 'exec-wrapcdpmint',
  otc: 'exec-otc', bid: 'exec-bid', fastlane: 'exec-fastlane',
  adaptorlock: 'exec-adaptorlock', adaptorclaim: 'exec-adaptorclaim', adaptorrefund: 'exec-adaptorrefund',
};

const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const note = (o) => ({ cx: o.cx, cy: o.cy, owner: o.owner });
const hex = (seed, bytes) => '0x' + createHash('sha256').update(seed).digest('hex').repeat(Math.ceil(bytes / 32)).slice(0, bytes * 2);

// Note and lock leaves each op appends (the count of memo hashes its guest run reads).
const LEAVES = {
  wrap: () => 1, transfer: (o) => o.outputs.length, unwrap: () => 0, sendunwrap: (o) => o.change.length,
  wraptransfer: (o) => o.outputs.length,
  swap: (o) => o.intents.reduce((n, it) => n + 1 + (it.change || []).length, 0),
  route: (o) => 1 + (o.change || []).length,
  lp: (o) => 1 + (o.aChange || []).length + (o.bChange || []).length,
  lpremove: (o) => 2 + (o.shareChange || []).length,
  lpbond: () => 1, farmbond: () => 1, farmharvest: () => 2, farmunbond: () => 1,
  stealthlock: () => 1, stealthlockbatch: (o) => o.ops.length, stealthclaim: () => 1, stealthrefund: () => 1,
  bridgeburn: () => 0, bridgemint: () => 1, bridgestealthmint: () => 1, cbtcmint: () => 1,
  cdpmint: (o) => (BigInt(o.debtValue) > 0n ? 1 : 0), cdpclose: (o) => o.legs.length, cdptopup: () => 0, cdpliquidate: () => 0,
  wraplp: () => 1, wrapswap: () => 1, wrapcdpmint: () => 1,
  otc: (o) => 2 + o.maker.hasChange + o.taker.hasChange,
  bid: (o) => 2 + (o.chosenF < o.maxFill ? 1 : 0) + o.sellerHasChange,
  fastlane: (o) => o.transfer.outputs.length,
  adaptorlock: () => 1, adaptorclaim: () => 1, adaptorrefund: () => 1,
};

// case -> the op it proves. A case named `<type>.<variant>` takes a branch or a field form the plain fixture does not.
const CASES = {
  wrap: () => fixture('wrap_op.json'),
  transfer: () => fixture('transfer_op.json'),
  'transfer.fee': () => ({ ...fixture('transfer_op.json'), fee: '25' }),
  unwrap: () => fixture('unwrap_op.json'),
  sendunwrap: () => fixture('sendunwrap_op.json'),
  'sendunwrap.strings': () => ({ ...fixture('sendunwrap_op.json'), payout: '900', fee: '3', opDeadline: '1900000000' }),
  wraptransfer: () => fixture('wraptransfer_op.json'),
  'wraptransfer.root': () => ({ ...fixture('wraptransfer_op.json'), spendRoot: hex('wraptransfer.root', 32), value: '1500', fee: '0' }),
  swap: () => fixture('swap_op.json'),
  'swap.change': () => {
    const o = fixture('swap_op.json');
    const it = o.intents[0];
    it.change = [{ cx: it.outCx, cy: it.outCy, owner: it.outOwner }];
    it.changeRangeProof = hex('swap.change.range', 658);
    it.fee = 2; it.deadline = 1900000000;
    return { ...o, protocolFeeBps: 10, protocolFeeRecipient: hex('swap.change.recipient', 33) };
  },
  route: () => fixture('route_op.json'),
  'route.change': () => {
    const o = fixture('route_op.json');
    const { sigR, sigZ, ...out } = o.out;
    return {
      ...o, fee: '4', amountIn: String(o.amountIn), minOut: String(o.minOut),
      in: { ...o.in, leafIndex: String(o.in.leafIndex) },
      out: { ...out, sig: { R: sigR, z: sigZ } },
      change: [note(o.out)], changeRangeProof: hex('route.change.range', 658),
    };
  },
  'route.outsig': () => {
    const o = fixture('route_op.json');
    const { sigR, sigZ, ...out } = o.out;
    return { ...o, out, outSig: { R: sigR, z: sigZ } };
  },
  lp: () => fixture('lp_op.json'),
  'lp.protofee': () => fixture('lp_protofee_op.json'),
  'lp.change': () => {
    const o = fixture('lp_op.json');
    return {
      ...o, reserveAPre: String(o.reserveAPre), reserveBPre: String(o.reserveBPre), sharesPre: '0', dA: String(o.dA), dB: String(o.dB),
      deadline: '1900000000', fee: '5', aChange: [note(o.share)], bChange: [note(o.share)], changeRangeProof: hex('lp.change.range', 724),
    };
  },
  lpremove: () => fixture('lp_remove_op.json'),
  'lpremove.change': () => ({ ...fixture('lp_remove_op.json'), fee: 3, deadline: 1900000000, shareChange: [note(fixture('lp_remove_op.json').share)], changeRangeProof: hex('lpremove.change.range', 658) }),
  lpbond: () => fixture('lpbond_op.json'),
  'lpbond.defaults': () => {
    const { protocolFeeBps, protocolFeeRecipient, opDeadline, fee, ...o } = fixture('lpbond_op.json');
    return { ...o, reserveAPre: '10000', reserveBPre: '10000', sharesPre: '10000', a: { ...o.a, d: '1000' } };
  },
  farmbond: () => fixture('farm_bond_op.json'),
  farmharvest: () => fixture('farm_harvest_op.json'),
  farmunbond: () => fixture('farm_unbond_op.json'),
  stealthlock: () => fixture('stealthlock_op.json'),
  stealthlockbatch: () => fixture('stealthlockbatch_op.json'),
  stealthclaim: () => fixture('stealthclaim_op.json'),
  'stealthclaim.amount': () => fixture('stealthclaim_amount_op.json'),
  stealthrefund: () => fixture('stealthrefund_op.json'),
  // No committed fixture: the dapp's crossOut shape (confidential-pool-ux.js) over transfer_op.json's notes.
  bridgeburn: () => {
    const t = fixture('transfer_op.json');
    return {
      chainBinding: t.chainBinding, spendRoot: t.spendRoot, asset: t.asset, destChain: 1,
      inputs: t.inputs.map((i) => ({ cx: i.cx, cy: i.cy, owner: i.owner, nk: i.nk, leafIndex: i.leafIndex, path: i.path })),
      outputs: t.outputs.map(note), rangeProof: t.rangeProof, kernel: t.kernel, fee: '3',
    };
  },
  bridgemint: () => fixture('bridgemint_op.json'),
  bridgestealthmint: () => fixture('bridgestealthmint_op.json'),
  cbtcmint: () => fixture('cbtc_mint_op.json'),
  cdpmint: () => fixture('cdp_mint_op.json'),
  'cdpmint.bond': () => {
    const { debt, debtOwner, ...o } = fixture('cdp_mint_op.json');
    return { ...o, debtValue: '0', fee: '0' };
  },
  cdpclose: () => fixture('cdp_close_op.json'),
  cdptopup: () => fixture('cdp_topup_op.json'),
  cdpliquidate: () => fixture('cdp_liquidate_op.json'),
  wraplp: () => fixture('wraplp_op.json'),
  wrapswap: () => fixture('wrapswap_op.json'),
  wrapcdpmint: () => fixture('wrapcdpmint_op.json'),
  otc: () => fixture('otc_op.json'),
  'otc.fees': () => {
    const o = fixture('otc_op.json');
    const { changeCx, changeCy, changeSigR, changeSigZ, ...maker } = o.maker;
    return { ...o, deadline: 1900000000, feeA: 2, feeB: 3, maker: { ...maker, hasChange: 0 }, taker: { ...o.taker, hasChange: 1, changeCx, changeCy, changeSigR, changeSigZ } };
  },
  bid: () => fixture('bid_op.json'),
  'bid.full': () => {
    const { refund, sellerChange, ...o } = fixture('bid_op.json');
    return { ...o, chosenF: o.maxFill, sellerHasChange: 0, deadline: 1900000000, fee: 1 };
  },
  // No committed fixture: buildFastlaneExitOp's shape (confidential-pool-ux.js) over crosslane_op.json's notes.
  fastlane: () => {
    const c = fixture('crosslane_op.json');
    return {
      chainBinding: c.chainBinding, spendRoot: c.spendRoot, bitcoinSpentRoot: c.bitcoinSpentRoot,
      transfer: {
        asset: c.asset,
        inputs: c.inputs.map((i) => ({
          cx: i.cx, cy: i.cy, owner: i.owner, leafIndex: i.leafIndex, path: i.path,
          low: { value: i.nonMember.lowValue, next: i.nonMember.lowNext, index: i.nonMember.lowIndex, path: i.nonMember.path }, sig: i.sig,
        })),
        outputs: c.outputs.map(note), rangeProof: c.rangeProof, fee: '7', kernel: c.kernel,
      },
    };
  },
  adaptorlock: () => fixture('adaptor_lock_op.json'),
  adaptorclaim: () => fixture('adaptor_claim_op.json'),
  adaptorrefund: () => fixture('adaptor_refund_op.json'),
};

function opFor(name) {
  const type = name.split('.')[0];
  const { expected, expect, note: _note, ...op } = CASES[name]();
  const n = LEAVES[type](op);
  op.memoHashes = Array.from({ length: n }, (_, i) => hex(`sp1-stdin:${name}:memo:${i}`, 32));
  return { type, op };
}

// The scratch crate: every harness used, each as a module with the MODE=stdin exit added.
function crate(dir, harnesses) {
  const elf = path.join(HERE, 'elf/cxfer-guest');
  const hook = 'if std::env::var("MODE").as_deref() == Ok("stdin") { std::fs::write(std::env::var("STDIN_OUT").expect("STDIN_OUT"), bincode::serialize(&stdin).expect("bincode")).expect("write STDIN_OUT"); return; }';
  let mods = '', arms = '';
  for (const h of harnesses) {
    let src = readFileSync(path.join(HARNESSES, `${h}.rs`), 'utf8');
    const include = 'concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/cxfer-guest")';
    if (!src.includes(include)) throw new Error(`${h}: no guest include to repoint`);
    src = src.split(include).join(JSON.stringify(elf));
    if (!/^fn main\(\)/m.test(src)) throw new Error(`${h}: no fn main`);
    src = src.replace(/^fn main\(\)/m, 'pub fn main()');
    // Just before the harness proves: the MODE switch, or the network client for the harnesses without one.
    const m = /^([ \t]*)let mode = std::env::var\("MODE"\)/m.exec(src) || /^([ \t]*)let client = ProverClient::builder\(\)/m.exec(src);
    if (!m) throw new Error(`${h}: no point to stop before proving`);
    if (/stdin\.write\(/.test(src.slice(m.index))) throw new Error(`${h}: writes stdin after the stop point`);
    src = src.slice(0, m.index) + `${m[1]}${hook}\n` + src.slice(m.index);
    const mod = h.replace(/-/g, '_');
    mods += `#[allow(dead_code, unused_imports, unused_variables, unused_mut, unreachable_code)]\nmod ${mod} {\n${src}\n}\n\n`;
    arms += `        ${JSON.stringify(h)} => ${mod}::main(),\n`;
  }
  const main = `${mods}fn main() {\n    let h = std::env::var("HARNESS").expect("HARNESS");\n    match h.as_str() {\n${arms}        _ => panic!("unknown harness {h}"),\n    }\n}\n`;
  // The harness crate's own dependencies (and lockfile), plus bincode, which sp1-sdk already pulls in.
  const manifest = readFileSync(path.join(HARNESSES, 'Cargo.toml'), 'utf8');
  const deps = /\[dependencies\]\n([\s\S]*?)\n\[/.exec(manifest);
  if (!deps) throw new Error('harnesses/Cargo.toml: no [dependencies]');
  const depLines = deps[1].replace(/path = "\.\.\/\.\.\/reflect-stdin"/, `path = ${JSON.stringify(path.resolve(HERE, '../reflect-stdin'))}`);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'Cargo.toml'), `[package]\nname = "sp1-stdin-dump"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n\n[dependencies]\n${depLines}\nbincode = "1"\n\n[profile.release]\nopt-level = 3\n`);
  copyFileSync(path.join(HARNESSES, 'Cargo.lock'), path.join(dir, 'Cargo.lock'));
  writeFileSync(path.join(dir, 'src/main.rs'), main);
}

const wanted = process.argv.slice(2);
for (const n of wanted) if (!CASES[n]) throw new Error(`unknown case ${n} (have: ${Object.keys(CASES).join(', ')})`);
const names = wanted.length ? wanted : Object.keys(CASES);
const harnesses = [...new Set(names.map((n) => HARNESS[n.split('.')[0]]))];

mkdirSync(OUT, { recursive: true });
const dir = process.env.DUMP_CRATE_DIR || mkdtempSync(path.join(tmpdir(), 'sp1-stdin-dump-'));
crate(dir, harnesses);
const target = process.env.CARGO_TARGET_DIR || path.join(HARNESSES, 'target');
console.log(`building ${dir} (target ${target})`);
execFileSync('cargo', ['build', '--release', '--quiet'], { cwd: dir, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target } });
const bin = path.join(target, 'release', 'sp1-stdin-dump');

let failed = 0;
for (const name of names) {
  const { type, op } = opFor(name);
  const opFile = path.join(OUT, `${name}.op.json`);
  const binFile = path.join(OUT, `${name}.bin`);
  writeFileSync(opFile, JSON.stringify(op) + '\n');
  try {
    execFileSync(bin, [], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HARNESS: HARNESS[type], MODE: 'stdin', OP_FILE: opFile, STDIN_OUT: binFile } });
    const b = readFileSync(binFile);
    console.log(`${name.padEnd(22)} ${HARNESS[type].padEnd(24)} ${String(b.length).padStart(6)} bytes  sha256 ${createHash('sha256').update(b).digest('hex').slice(0, 16)}`);
  } catch (e) {
    failed++;
    console.error(`${name}: ${HARNESS[type]} failed\n${String(e.stderr || e.message).trim().split('\n').slice(-4).join('\n')}`);
  }
}
if (failed) { console.error(`${failed} case(s) failed`); process.exit(1); }
