// dapp/sp1-stdin.js: the program input the page builds is byte for byte the one each harness builds from the same op
// (tests/fixtures/sp1-stdin, written by the harnesses through contracts/sp1/confidential/dump-stdin.mjs), its zstd frame
// decodes back to it, and an op a harness would stop on or misread is refused.
//
// Run: node --test tests/sp1-stdin.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stdinFor, zstdFrame, LIMITS, SELF_PROVE_TYPES } from '../dapp/sp1-stdin.js';

const DIR = new URL('./fixtures/sp1-stdin/', import.meta.url);
const CASES = readdirSync(DIR).filter((f) => f.endsWith('.op.json')).map((f) => f.slice(0, -'.op.json'.length)).sort();
const load = (name) => ({
  type: name.split('.')[0],
  op: JSON.parse(readFileSync(new URL(`${name}.op.json`, DIR), 'utf8')),
  ref: new Uint8Array(readFileSync(new URL(`${name}.bin`, DIR))),
});
const clone = (o) => JSON.parse(JSON.stringify(o));

// The entries of a bincode SP1Stdin, to name the first one that differs.
function entries(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = Number(dv.getBigUint64(0, true));
  const out = [];
  let off = 8;
  for (let i = 0; i < n; i++) {
    const len = Number(dv.getBigUint64(off, true));
    out.push(Buffer.from(b.subarray(off + 8, off + 8 + len)).toString('hex'));
    off += 8 + len;
  }
  return { out, ptr: dv.getBigUint64(off, true), proofs: dv.getBigUint64(off + 8, true), end: off + 16 };
}
function assertSame(got, ref, name) {
  if (Buffer.compare(Buffer.from(got), Buffer.from(ref)) === 0) return;
  const g = entries(got), r = entries(ref);
  const i = g.out.findIndex((e, k) => e !== r.out[k]);
  assert.fail(`${name}: ${got.length} bytes, ${g.out.length} entries; the harness wrote ${ref.length} bytes, ${r.out.length} entries; first difference at entry ${i}: ${g.out[i]} vs ${r.out[i]}`);
}

test('every op type has a reference the harness wrote, and every reference is a ported type', () => {
  const types = new Set(CASES.map((c) => c.split('.')[0]));
  for (const t of SELF_PROVE_TYPES) assert.ok(types.has(t), `no reference for ${t}`);
  for (const t of types) assert.ok(SELF_PROVE_TYPES.includes(t), `${t} has a reference but is not ported`);
});

for (const name of CASES) {
  test(`${name}: stdinFor equals the harness's bytes`, () => {
    const { type, op, ref } = load(name);
    const e = entries(ref);
    assert.equal(e.end, ref.length);
    assert.equal(e.ptr, 0n);
    assert.equal(e.proofs, 0n);
    assertSame(stdinFor(type, op), ref, name);
    // As the page holds the op before the relay's wire form: decimal strings as BigInt.
    const big = JSON.parse(JSON.stringify(op), (_k, v) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v));
    assertSame(stdinFor(type, big), ref, `${name} (BigInt fields)`);
  });
}

test('the module imports nothing', () => {
  const src = readFileSync(new URL('../dapp/sp1-stdin.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\brequire\(/);
});

test('LIMITS are each harness\'s request limits', () => {
  for (const t of SELF_PROVE_TYPES) {
    const l = LIMITS[t];
    assert.equal(typeof l.cycleLimit, 'bigint');
    assert.equal(typeof l.gasLimit, 'bigint');
    const want = { lp: [30_000_000_000n, 30_000_000_000n], bridgeburn: [4_000_000_000n, 4_000_000_000n], fastlane: [4_000_000_000n, 4_000_000_000n] }[t]
      || [256_000_000n, 1_000_000_000n];
    assert.deepEqual([l.cycleLimit, l.gasLimit], want, t);
  }
});

// ── zstd ──
// A decoder for the frames zstdFrame writes: the header fields RFC 8878 allows there, raw blocks only.
function unframe(f) {
  assert.deepEqual([...f.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd]);
  const fhd = f[4];
  assert.equal(fhd & 0x20, 0x20, 'single segment');
  assert.equal(fhd & 0x1f, 0, 'no checksum, no dictionary, reserved clear');
  const fcsLen = [1, 2, 4, 8][fhd >> 6];
  let size = 0;
  for (let i = fcsLen - 1; i >= 0; i--) size = size * 256 + f[5 + i];
  if (fcsLen === 2) size += 256;
  let off = 5 + fcsLen;
  const parts = [];
  for (;;) {
    const h = f[off] | (f[off + 1] << 8) | (f[off + 2] << 16);
    off += 3;
    const last = h & 1, type = (h >> 1) & 3, len = h >>> 3;
    assert.equal(type, 0, 'raw block');
    assert.ok(len <= 128 * 1024);
    parts.push(f.subarray(off, off + len));
    off += len;
    if (last) break;
  }
  assert.equal(off, f.length, 'nothing after the last block');
  const out = Buffer.concat(parts);
  assert.equal(out.length, size, 'content size');
  return new Uint8Array(out);
}
const zstdCli = spawnSync('zstd', ['--version']).status === 0;
const sample = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + (i >> 8)) & 0xff);

test('zstdFrame round-trips at every header size and block boundary', () => {
  const sizes = [0, 1, 255, 256, 257, 65791, 65792, 131071, 131072, 131073, 262144, 300001];
  for (const n of sizes) {
    const b = sample(n);
    const f = zstdFrame(b);
    assert.deepEqual(unframe(f), b, `size ${n}`);
    if (zstdCli) {
      const d = spawnSync('zstd', ['-d', '-c', '-q'], { input: Buffer.from(f), maxBuffer: 1 << 24 });
      assert.equal(d.status, 0, `zstd -d failed at size ${n}: ${d.stderr}`);
      assert.deepEqual(new Uint8Array(d.stdout), b, `zstd -d at size ${n}`);
    }
  }
  const { type, op, ref } = load(CASES.find((c) => c.startsWith('lp')));
  assert.deepEqual(unframe(zstdFrame(stdinFor(type, op))), ref);
  assert.throws(() => zstdFrame([1, 2, 3]), /Uint8Array/);
});

test('zstd -d reads every reference\'s frame', { skip: !zstdCli && 'zstd is not installed' }, () => {
  for (const name of CASES) {
    const { ref } = load(name);
    const d = spawnSync('zstd', ['-d', '-c', '-q'], { input: Buffer.from(zstdFrame(ref)), maxBuffer: 1 << 24 });
    assert.equal(d.status, 0, `${name}: ${d.stderr}`);
    assert.deepEqual(new Uint8Array(d.stdout), ref, name);
  }
});

// ── what a harness would stop on or misread ──
const bad = (name, edit, re) => {
  const { type, op } = load(name);
  const o = clone(op);
  edit(o);
  assert.throws(() => stdinFor(type, o), re, `${name}: ${re}`);
};

test('an unknown type or a non-object op is refused', () => {
  assert.throws(() => stdinFor('crosslane', {}), /no program input for op type "crosslane"/);
  assert.throws(() => stdinFor('toString', {}), /no program input/);
  assert.throws(() => stdinFor('transfer', null), /op must be an object/);
  assert.throws(() => stdinFor('transfer', []), /op must be an object/);
});

test('memoHashes must be the list of 32-byte hashes', () => {
  bad('transfer', (o) => { delete o.memoHashes; }, /memoHashes must be an array/);
  bad('transfer', (o) => { o.memoHashes = null; }, /memoHashes must be an array/);
  bad('transfer', (o) => { o.memoHashes[0] = o.memoHashes[0].slice(0, 64); }, /memoHashes\[0\] must be 32 bytes/);
  bad('transfer', (o) => { o.memoHashes[1] = 7; }, /memoHashes\[1\] must be a hex string/);
});

test('hex is read as hex::decode(s.trim_start_matches("0x")) reads it', () => {
  const { type, op, ref } = load('wrap');
  const o = clone(op);
  o.cx = o.cx.slice(2).toUpperCase();                 // no prefix, upper case
  o.cy = '0x0x' + o.cy.slice(2);                      // every leading 0x is dropped
  assertSame(stdinFor(type, o), ref, 'wrap');
  o.owner = '0X' + o.owner.slice(2);                  // 0X is not a prefix
  assert.throws(() => stdinFor(type, o), /owner is not valid hex/);
});

test('missing fields and bad hex are refused, naming the field', () => {
  bad('transfer', (o) => { delete o.spendRoot; }, /transfer: spendRoot is missing/);
  bad('transfer', (o) => { o.inputs[1].path[3] = '0xabc'; }, /inputs\[1\]\.path\[3\] is not valid hex/);
  bad('transfer', (o) => { o.inputs[0].cx = 'zz'; }, /inputs\[0\]\.cx is not valid hex/);
  bad('transfer', (o) => { o.kernel = '0x00'; }, /kernel\.R is missing/);
  bad('transfer', (o) => { o.outputs = {}; }, /outputs must be an array/);
  bad('cdpclose', (o) => { delete o.debts; }, /debts is missing/);
  bad('wrap', (o) => { o.cx = 5; }, /cx must be a hex string/);
});

test('a number is read only where the harness reads numbers, a decimal string only where it reads strings', () => {
  bad('wrap', (o) => { o.value = 1500; }, /value must be a decimal string/);           // as_str().unwrap()
  bad('unwrap', (o) => { o.fee = 100; }, /fee must be a decimal string/);              // as_str() or 0: 100 would read as 0
  bad('transfer', (o) => { o.inputs[0].leafIndex = '0'; }, /leafIndex must be a JSON number/);
  bad('bid', (o) => { o.minFill = '10'; }, /minFill must be a JSON number/);
  bad('swap.change', (o) => { o.intents[0].fee = '2'; }, /intents\[0\]\.fee must be a JSON number/); // as_u64() or 0
  assert.throws(() => stdinFor('bid', { ...load('bid').op, minFill: 10n }), /minFill must be a JSON number/);
  // Where the harness falls back to the value given, the other form is the same input.
  for (const [name, edit] of [
    ['transfer', (o) => { o.fee = 0; }],
    ['swap', (o) => { o.intents[0].fee = '0'; o.protocolFeeBps = '0'; }],
    ['stealthclaim', (o) => { o.blind = '1'; }],
  ]) {
    const { type, op, ref } = load(name);
    const o = clone(op); edit(o);
    assertSame(stdinFor(type, o), ref, name);
  }
  bad('stealthclaim', (o) => { o.blind = '0'; }, /blind must be a JSON number/);
});

test('values outside what the harness writes are refused', () => {
  bad('sendunwrap.strings', (o) => { o.payout = '18446744073709551616'; }, /payout must be/);
  bad('sendunwrap.strings', (o) => { o.payout = '-1'; }, /payout must be/);
  bad('sendunwrap.strings', (o) => { o.payout = ' 900'; }, /payout must be/);
  bad('transfer', (o) => { o.inputs[0].leafIndex = 1.5; }, /leafIndex must be/);
  bad('transfer', (o) => { o.inputs[0].leafIndex = -1; }, /leafIndex must be/);
  bad('transfer', (o) => { o.inputs[0].leafIndex = 1e21; }, /leafIndex must be/);
  bad('bridgemint', (o) => { o.spentVout = 2 ** 32; }, /spentVout does not fit a u32/);
  bad('swap', (o) => { o.intents[0].direction = 256; }, /direction does not fit a u8/);
  bad('otc', (o) => { o.maker.hasChange = 2; }, /maker\.hasChange must be 0 or 1/);
  bad('bid', (o) => { o.sellerHasChange = 2; }, /sellerHasChange must be 0 or 1/);
  bad('stealthclaim', (o) => { o.blind = 2; }, /blind must be 0 or 1/);
  bad('stealthclaim', (o) => { o.ownerSig += 'ab'; }, /ownerSig must be 64 bytes/);
  bad('adaptorclaim', (o) => { o.recipientSig = o.recipientSig.slice(0, 66); }, /recipientSig must be 64 bytes/);
  bad('farmharvest', (o) => { o.ownerSig = o.ownerSig.slice(0, 100); }, /ownerSig must be 64 bytes/);
  bad('stealthlockbatch', (o) => { o.ops = []; }, /ops is empty/);
  // A JSON number is read from its JSON text, as serde reads it: 2^60 is exact, and stays a u64.
  const { type, op } = load('transfer');
  const o = clone(op); o.inputs[0].leafIndex = 2 ** 60;
  assert.equal(Buffer.from(stdinFor(type, o)).includes(Buffer.from('0000000000000010', 'hex')), true);
});

test('shapes a harness cannot read are refused; defaults it applies are kept', () => {
  bad('swap', (o) => { const it = o.intents[0]; const n = it.inputs[0]; delete it.inputs; Object.assign(it, { inCx: n.cx, inCy: n.cy }); }, /intents\[0\]\.inputs is missing/);
  bad('lp', (o) => { o.a = o.a.inputs[0]; }, /a\.inputs is missing/);
  bad('swap', (o) => { o.intents[0].change = {}; }, /intents\[0\]\.change must be an array/);
  bad('route', (o) => { o.fee = null; }, /route: fee is missing/);
  bad('wraptransfer', (o) => { o.spendRoot = 0; }, /spendRoot must be a hex string/);
  bad('lp', (o) => { o.protocolFeeRecipient = 1; }, /protocolFeeRecipient must be a hex string/);
  bad('route', (o) => { delete o.out.sigR; }, /out\.sigR \(or out\.sig\.R, outSig\.R\) is missing/);
  // null is absent: the harness's default.
  for (const [name, edit] of [
    ['swap', (o) => { o.intents[0].change = null; }],
    ['wraptransfer', (o) => { o.spendRoot = null; }],
    ['lpbond.defaults', (o) => { o.fee = null; o.protocolFeeRecipient = null; }],
    ['transfer', (o) => { o.fee = undefined; }],
  ]) {
    const { type, op, ref } = load(name);
    const o = clone(op); edit(o);
    assertSame(stdinFor(type, o), ref, name);
  }
});

// ── several ops in one input (batchStdin), as exec-mixed.rs writes a transfer and an unwrap ──
import { batchStdin, batchLimits } from '../dapp/sp1-stdin.js';

const list = (b) => entries(b).out;
const body = (type, op) => list(stdinFor(type, op)).slice(7); // past the six roots and the count (an op with no memo hashes)
const memoless = (op) => ({ ...op, memoHashes: [] });

test('batchStdin: the header once, the count, each op\'s body in order, then every op\'s memo hashes in order', () => {
  const T = load('transfer'), U = load('unwrap');
  const opT = { ...T.op, memoHashes: ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)] };
  const opU = { ...U.op, memoHashes: ['0x' + '33'.repeat(32)] };
  const { stdin, numOps, roots } = batchStdin([{ type: 'transfer', op: { ...opT, spendRoot: opU.spendRoot } }, { type: 'unwrap', op: opU }]);
  const e = list(stdin);
  const single = (type, op) => list(stdinFor(type, op));
  const eT = single('transfer', { ...opT, spendRoot: opU.spendRoot, memoHashes: [] }), eU = single('unwrap', { ...opU, memoHashes: [] });
  assert.equal(numOps, 2);
  assert.deepEqual(e.slice(0, 6), eU.slice(0, 6), 'the header is the one both ops carry');
  assert.equal(e[6], '02000000', 'num_ops = 2');
  const bT = eT.slice(7), bU = eU.slice(7);
  assert.deepEqual(e.slice(7, 7 + bT.length), bT, 'the transfer body comes first');
  assert.deepEqual(e.slice(7 + bT.length, 7 + bT.length + bU.length), bU, 'then the unwrap body');
  const tail = e.slice(7 + bT.length + bU.length);
  assert.deepEqual(tail, opT.memoHashes.concat(opU.memoHashes).map((h) => '2000000000000000' + h.slice(2)), 'then the memo hashes, transfer\'s first');
  assert.equal(roots[1], opU.spendRoot.toLowerCase());
  assert.equal(roots[2], null);
});

test('batchStdin: a wrap (no roots of its own) joins a transfer under the transfer\'s root; two different spend roots cannot share an input', () => {
  const W = load('wrap'), T = load('transfer');
  const { stdin, numOps, roots } = batchStdin([{ type: 'wrap', op: memoless(W.op) }, { type: 'transfer', op: memoless(T.op) }]);
  const e = list(stdin);
  assert.equal(numOps, 2);
  assert.equal(roots[1], T.op.spendRoot.toLowerCase(), 'the header takes the transfer\'s spend root');
  assert.equal(e[6], '02000000');
  assert.deepEqual(e.slice(7, 7 + body('wrap', memoless(W.op)).length), body('wrap', memoless(W.op)));
  const other = { ...memoless(T.op), spendRoot: '0x' + 'ab'.repeat(32) };
  assert.throws(() => batchStdin([{ type: 'transfer', op: memoless(T.op) }, { type: 'transfer', op: other }]), /another spendRoot/);
});

test('batchStdin: a stealth lock batch counts each of its locks; the limits add up', () => {
  const B = load('stealthlockbatch');
  const { numOps } = batchStdin([{ type: 'stealthlockbatch', op: memoless(B.op) }, { type: 'wrap', op: memoless(load('wrap').op) }]);
  assert.equal(numOps, B.op.ops.length + 1);
  const l = batchLimits(['transfer', 'lp', 'wrap']);
  assert.equal(l.cycleLimit, LIMITS.transfer.cycleLimit + LIMITS.lp.cycleLimit + LIMITS.wrap.cycleLimit);
  assert.equal(l.gasLimit, LIMITS.transfer.gasLimit + LIMITS.lp.gasLimit + LIMITS.wrap.gasLimit);
  assert.throws(() => batchStdin([]), /at least one op/);
  assert.throws(() => batchStdin([{ type: 'nope', op: {} }]), /no program input/);
});
