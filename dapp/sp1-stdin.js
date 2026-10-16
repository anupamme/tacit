// The SP1 program input for a confidential-pool op, built in the page.
//
// The relay proves an op by writing `{ ...op, memoHashes }` to a file and running the op's harness
// (contracts/sp1/confidential/harnesses/exec-<op>.rs), which reads that JSON and calls `stdin.write(&x)` once per
// field in the order the guest reads them. This module builds the same SP1Stdin from the same op, so a proof asked
// for from the holder's own prover account runs the pinned guest over exactly the input the relay's would.
//
// What it returns is `bincode::serialize(&SP1Stdin)` as sp1-sdk 6.2.3 has it: the buffer (a u64 count, then each entry
// as a u64 length and its bytes), `ptr` (a u64, 0) and `proofs` (a u64 count, 0), all little-endian. Each entry is
// bincode of one written value: a `Vec<u8>` is a u64 length and the bytes, a u64/u32/u8 is its little-endian bytes.
// The network takes that zstd-compressed; `zstdFrame` wraps it in a valid zstd frame of raw (stored) blocks.
//
// The op is read as the relay receives it: JSON with every BigInt as its decimal string (confidential-relay.js
// submitOp). Each numeric field is then read the way its harness reads it: some harnesses take a JSON number only
// (serde's as_u64), some a decimal string only, some either. stdinFor returns exactly the harness's bytes, or throws
// where the harness would stop (a missing field, bad hex, a value it cannot parse) and where it would carry on with a
// value other than the one given: a number where it reads only strings (or the reverse) that is not the value it
// falls back to, a value too large for the u32 or u8 it casts to, a flag other than 0 or 1, a signature that is not
// 64 bytes, a field present with the wrong JSON type where it falls back to a default.
//
// tests/sp1-stdin.test.mjs checks every type against bytes the harnesses wrote (contracts/sp1/confidential/dump-stdin.mjs).

const U64_MAX = (1n << 64n) - 1n;
const own = Object.prototype.hasOwnProperty;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// serde_json's Index: a missing key, or any key of something that is not an object, reads as null.
const get = (o, k) => (isObj(o) && own.call(o, k) ? o[k] : null);
const Z32 = new Uint8Array(32);
const Z33 = new Uint8Array(33);

// The u64 a JSON number or a decimal string stands for, or null. A number is read from its JSON text (what serde sees,
// so 2^63 reads as 9223372036854776000, as the relay's harness would read it); a string as Rust's u64 parse reads it.
function u64Of(v) {
  let s;
  if (typeof v === 'number') { s = String(v); if (!/^\d+$/.test(s)) return null; }
  else if (typeof v === 'string') { if (!/^\+?\d+$/.test(v)) return null; s = v.replace(/^\+/, ''); }
  else return null;
  const n = BigInt(s);
  return n <= U64_MAX ? n : null;
}

const WANT = { num: 'a JSON number', dec: 'a decimal string', any: 'a JSON number or a decimal string' };

function reader(type) {
  const bad = (m) => new Error(`sp1-stdin ${type}: ${m}`);
  // hexv: hex::decode(s.trim_start_matches("0x")).
  const hexb = (v, at) => {
    if (typeof v !== 'string') throw bad(v === null ? `${at} is missing` : `${at} must be a hex string`);
    let s = v;
    while (s.startsWith('0x')) s = s.slice(2);
    if (s.length % 2 || !/^[0-9a-fA-F]*$/.test(s)) throw bad(`${at} is not valid hex`);
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  };
  // kind: the JSON forms the harness reads (num, dec, any). def: what it writes when it reads nothing (undefined:
  // it stops). bits: the width it casts to.
  const int = (v, at, kind, def, bits = 64) => {
    if (v === null) {
      if (def === undefined) throw bad(`${at} is missing`);
      return def;
    }
    const n = u64Of(v);
    if (n === null) throw bad(`${at} must be ${WANT[kind]} holding an integer from 0 to 2^64-1`);
    const reads = kind === 'any' || (kind === 'num' ? typeof v === 'number' : typeof v === 'string');
    if (!reads && n !== def) throw bad(`${at} must be ${WANT[kind]}`);
    if (bits < 64 && n >= 1n << BigInt(bits)) throw bad(`${at} does not fit a u${bits}`);
    return n;
  };
  const list = (v, at, optional) => {
    if (Array.isArray(v)) return v;
    if (optional && v === null) return [];
    throw bad(v === null ? `${at} is missing` : `${at} must be an array`);
  };
  // An accessor over one JSON object, naming each field by its path for the errors.
  const at = (o, pre = '') => {
    const a = {
      raw: (k) => get(o, k),
      has: (k) => isObj(o) && own.call(o, k),
      o: (k) => at(get(o, k), `${pre}${k}.`),
      h: (k) => hexb(get(o, k), pre + k),
      hOr: (k, d) => (get(o, k) === null ? d : hexb(get(o, k), pre + k)),
      n: (k, kind, def, bits) => int(get(o, k), pre + k, kind, def, bits),
      flag: (k, kind, def) => {
        const n = int(get(o, k), pre + k, kind, def, 8);
        if (n > 1n) throw bad(`${pre + k} must be 0 or 1`);
        return n;
      },
      a: (k) => list(get(o, k), pre + k, false),
      aOr: (k) => list(get(o, k), pre + k, true),
      each: (k, optional = false) => list(get(o, k), pre + k, optional).map((x, i) => at(x, `${pre}${k}[${i}].`)),
      hs: (k) => list(get(o, k), pre + k, false).map((x, i) => hexb(x, `${pre}${k}[${i}]`)),
      // A 64-byte BIP-340 signature the harness writes as its two 32-byte halves.
      sig64: (k) => {
        const b = hexb(get(o, k), pre + k);
        if (b.length !== 64) throw bad(`${pre + k} must be 64 bytes (R ‖ s)`);
        return [b.subarray(0, 32), b.subarray(32)];
      },
      label: (k) => pre + k,
    };
    return a;
  };
  return { bad, at, hexb };
}

function writer() {
  const entries = [];
  const le = (n, len) => {
    const b = new Uint8Array(len);
    let x = BigInt(n);
    for (let i = 0; i < len; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
    return b;
  };
  return {
    entries,
    b(bytes) { const e = new Uint8Array(8 + bytes.length); e.set(le(bytes.length, 8)); e.set(bytes, 8); entries.push(e); }, // Vec<u8>
    u64(n) { entries.push(le(n, 8)); },
    u32(n) { entries.push(le(n, 4)); },
    u8(n) { entries.push(le(n, 1)); },
    zeros(k) { for (let i = 0; i < k; i++) this.b(Z32); },                       // vec![0u8; 32], k times
    path(list) { for (const p of list) this.b(p); },
  };
}

// bincode(SP1Stdin { buffer, ptr: 0, proofs: [] }).
function encode(entries) {
  let size = 8 + 8 + 8;
  for (const e of entries) size += 8 + e.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let off = 0;
  const u64 = (n) => { dv.setBigUint64(off, BigInt(n), true); off += 8; };
  u64(entries.length);
  for (const e of entries) { u64(e.length); out.set(e, off); off += e.length; }
  u64(0); // ptr
  u64(0); // proofs
  return out;
}

// The memo hashes the guest reads after the last op: keccak256 of each sealed memo, in order (prover.js proveSettle).
function memos(w, F, r) {
  const list = F.raw('memoHashes');
  if (!Array.isArray(list)) throw r.bad('memoHashes must be an array of the keccak256 of each sealed memo, in order');
  list.forEach((h, i) => {
    const b = r.hexb(h, `memoHashes[${i}]`);
    if (b.length !== 32) throw r.bad(`memoHashes[${i}] must be 32 bytes`);
    w.b(b);
  });
}

// One builder per op type, each the stdin.write sequence of its harness, field for field.
const BUILD = {
  // exec-wrap.rs
  wrap(w, F) {
    w.b(F.h('chainBinding')); w.zeros(5);
    w.u32(1); w.u8(0);
    w.b(F.h('asset'));
    w.u64(F.n('value', 'dec'));
    w.b(F.h('cx')); w.b(F.h('cy')); w.b(F.h('owner'));
    w.b(F.h('sigR')); w.b(F.h('sigZ'));
  },
  // exec-prove.rs
  transfer(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(1);
    w.b(F.h('asset'));
    const ins = F.each('inputs'), outs = F.each('outputs');
    w.u32(ins.length); w.u32(outs.length);
    for (const I of ins) {
      w.b(I.h('cx')); w.b(I.h('cy')); w.b(I.h('owner'));
      w.u64(I.n('leafIndex', 'num'));
      w.path(I.hs('path'));
      w.b(I.h('secret'));
    }
    for (const O of outs) { w.b(O.h('cx')); w.b(O.h('cy')); w.b(O.h('owner')); }
    w.b(F.h('rangeProof'));
    w.u64(F.n('fee', 'dec', 0n));
    const K = F.o('kernel'); w.b(K.h('R')); w.b(K.h('z'));
  },
  // exec-unwrap.rs
  unwrap(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(2);
    w.b(F.h('asset')); w.b(F.h('cx')); w.b(F.h('cy')); w.b(F.h('owner'));
    w.u64(F.n('leafIndex', 'num'));
    w.path(F.hs('path'));
    w.u64(F.n('value', 'dec'));
    w.b(F.h('recipient'));
    w.u64(F.n('fee', 'dec', 0n));
    w.u64(F.n('deadline', 'dec', 0n));
    w.b(F.h('sigR')); w.b(F.h('sigZ')); w.b(F.h('nk'));
  },
  // exec-sendunwrap.rs
  sendunwrap(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(28);
    w.b(F.h('asset'));
    const I = F.o('input');
    w.b(I.h('cx')); w.b(I.h('cy')); w.b(I.h('owner'));
    w.u64(I.n('leafIndex', 'num'));
    w.path(I.hs('path'));
    w.b(F.h('recipient'));
    w.u64(F.n('payout', 'any', 0n));
    w.u64(F.n('fee', 'any', 0n));
    w.u64(F.n('opDeadline', 'any', 0n));
    w.b(F.h('pokR')); w.b(F.h('pokZv')); w.b(F.h('pokZr'));
    w.b(I.h('nk'));
    const change = F.each('change');
    w.u32(change.length);
    for (const C of change) { w.b(C.h('cx')); w.b(C.h('cy')); w.b(C.h('owner')); }
    w.b(F.h('rangeProof'));
    const K = F.o('kernel'); w.b(K.h('R')); w.b(K.h('z'));
  },
  // exec-wraptransfer.rs
  wraptransfer(w, F) {
    w.b(F.h('chainBinding')); w.b(F.hOr('spendRoot', Z32)); w.zeros(4);
    w.u32(1); w.u8(27);
    w.b(F.h('asset'));
    w.u64(F.n('value', 'any', 0n));
    const D = F.o('deposit');
    w.b(D.h('cx')); w.b(D.h('cy')); w.b(D.h('owner')); w.b(D.h('sigR')); w.b(D.h('sigZ'));
    const outs = F.each('outputs');
    w.u32(outs.length);
    for (const O of outs) { w.b(O.h('cx')); w.b(O.h('cy')); w.b(O.h('owner')); }
    w.b(F.h('rangeProof'));
    w.u64(F.n('fee', 'any', 0n));
    const K = F.o('kernel'); w.b(K.h('R')); w.b(K.h('z'));
  },
  // exec-swap.rs
  swap(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(6);
    w.b(F.h('assetA')); w.b(F.h('assetB'));
    w.u32(F.n('feeBps', 'num', undefined, 32));
    w.u32(F.n('protocolFeeBps', 'num', 0n, 32));
    w.b(F.hOr('protocolFeeRecipient', Z33));
    w.u64(F.n('reserveAPre', 'num')); w.u64(F.n('reserveBPre', 'num'));
    w.u64(F.n('priceNum', 'num')); w.u64(F.n('priceDen', 'num'));
    const intents = F.each('intents');
    w.u32(intents.length);
    for (const I of intents) {
      w.u8(I.n('direction', 'num', undefined, 8));
      // A flat single-note intent (inCx, inCy, …) carries no nk, so the harness cannot read it: inputs must be a list.
      const ins = I.each('inputs');
      w.u32(ins.length);
      for (const N of ins) {
        w.b(N.h('cx')); w.b(N.h('cy')); w.b(N.h('owner'));
        w.u64(N.n('leafIndex', 'num'));
        w.path(N.hs('path'));
        w.b(N.h('nk')); w.b(N.h('pokR')); w.b(N.h('pokZv')); w.b(N.h('pokZr'));
      }
      w.u64(I.n('amountIn', 'num'));
      w.u64(I.n('fee', 'num', 0n));
      w.u64(I.n('amountOut', 'num'));
      w.u64(I.n('rem', 'num'));
      w.u64(I.n('minOut', 'num'));
      w.u64(I.n('deadline', 'num', 0n));
      w.b(I.h('outCx')); w.b(I.h('outCy')); w.b(I.h('outOwner')); w.b(I.h('outSigR')); w.b(I.h('outSigZ'));
      const ch = I.each('change', true);
      w.u32(ch.length);
      for (const C of ch) { w.b(C.h('cx')); w.b(C.h('cy')); w.b(C.h('owner')); }
      if (ch.length) w.b(I.h('changeRangeProof'));
      w.b(I.h('changeKernelR')); w.b(I.h('changeKernelZ'));
    }
  },
  // exec-route.rs
  route(w, F, r) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(11);
    w.b(F.h('asset0'));
    const IN = F.o('in');
    w.b(IN.h('cx')); w.b(IN.h('cy')); w.b(IN.h('owner'));
    w.u64(IN.n('leafIndex', 'any'));
    w.path(IN.hs('path'));
    w.u64(F.n('amountIn', 'any'));
    w.u64(F.has('fee') ? F.n('fee', 'any') : 0n); // f.get("fee"): absent is 0, a null fee stops the harness
    w.b(IN.h('pokR')); w.b(IN.h('pokZv')); w.b(IN.h('pokZr'));
    const hops = F.each('hops');
    w.u32(hops.length);
    w.u64(F.n('minOut', 'any'));
    const OUT = F.o('out');
    w.b(OUT.h('cx')); w.b(OUT.h('cy')); w.b(OUT.h('owner'));
    // The out sigma: out.sigR / out.sigZ, else out.sig.{R,z}, else outSig.{R,z} (route_sig_r / route_sig_z).
    const sigma = (flat, k) => {
      for (const v of [OUT.raw(flat), get(OUT.raw('sig'), k), get(F.raw('outSig'), k)]) if (typeof v === 'string') return r.hexb(v, `out.${flat}`);
      throw r.bad(`out.${flat} (or out.sig.${k}, outSig.${k}) is missing`);
    };
    w.b(sigma('sigR', 'R')); w.b(sigma('sigZ', 'z'));
    w.u64(F.n('deadline', 'any'));
    for (const H of hops) {
      w.b(H.h('assetNext'));
      w.u32(H.n('feeBps', 'any', undefined, 32));
      w.u64(H.n('reserveAPre', 'any')); w.u64(H.n('reserveBPre', 'any'));
    }
    w.b(IN.h('nk'));
    const ch = F.each('change', true);
    w.u32(ch.length);
    for (const C of ch) { w.b(C.h('cx')); w.b(C.h('cy')); w.b(C.h('owner')); }
    if (ch.length) w.b(F.h('changeRangeProof'));
    w.b(F.h('changeKernelR')); w.b(F.h('changeKernelZ'));
  },
  // exec-lp.rs
  lp(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(7);
    w.b(F.h('assetA')); w.b(F.h('assetB'));
    w.u32(F.n('feeBps', 'num', undefined, 32));
    w.u32(F.n('protocolFeeBps', 'num', 0n, 32));
    w.b(F.hOr('protocolFeeRecipient', Z33));
    w.u64(F.n('reserveAPre', 'any')); w.u64(F.n('reserveBPre', 'any')); w.u64(F.n('sharesPre', 'any'));
    // A flat single-note leg (cx, cy, … on the leg) carries no nk, so the harness cannot read it: inputs must be a list.
    const leg = (L) => {
      const ins = L.each('inputs');
      w.u32(ins.length);
      for (const N of ins) {
        w.b(N.h('cx')); w.b(N.h('cy')); w.b(N.h('owner'));
        w.u64(N.n('leafIndex', 'num'));
        w.path(N.hs('path'));
        w.b(N.h('nk')); w.b(N.h('pokR')); w.b(N.h('pokZv')); w.b(N.h('pokZr'));
      }
    };
    leg(F.o('a'));
    w.u64(F.n('dA', 'any'));
    leg(F.o('b'));
    w.u64(F.n('dB', 'any'));
    const S = F.o('share');
    w.b(S.h('cx')); w.b(S.h('cy')); w.b(S.h('owner'));
    const SS = F.o('sSig'); w.b(SS.h('R')); w.b(SS.h('z'));
    w.u64(F.n('deadline', 'any', 0n));
    w.u64(F.n('fee', 'any', 0n));
    const aCh = F.each('aChange', true), bCh = F.each('bChange', true);
    for (const ch of [aCh, bCh]) {
      w.u32(ch.length);
      for (const C of ch) { w.b(C.h('cx')); w.b(C.h('cy')); w.b(C.h('owner')); }
    }
    if (aCh.length || bCh.length) w.b(F.h('changeRangeProof'));
    const AK = F.o('aKernel'), BK = F.o('bKernel');
    w.b(AK.h('R')); w.b(AK.h('z')); w.b(BK.h('R')); w.b(BK.h('z'));
  },
  // exec-lpremove.rs
  lpremove(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(8);
    w.b(F.h('assetA')); w.b(F.h('assetB'));
    w.u32(F.n('feeBps', 'num', undefined, 32));
    w.u32(F.n('protocolFeeBps', 'num', 0n, 32));
    w.b(F.hOr('protocolFeeRecipient', Z33));
    w.u64(F.n('reserveAPre', 'num')); w.u64(F.n('reserveBPre', 'num')); w.u64(F.n('sharesPre', 'num'));
    const S = F.o('share');
    w.b(S.h('cx')); w.b(S.h('cy')); w.b(S.h('owner'));
    w.u64(S.n('leafIndex', 'num'));
    w.path(S.hs('path'));
    w.u64(S.n('dShares', 'num'));
    w.b(S.h('pokR')); w.b(S.h('pokZv')); w.b(S.h('pokZr'));
    w.u64(F.n('dA', 'num')); w.u64(F.n('remA', 'num')); w.u64(F.n('dB', 'num')); w.u64(F.n('remB', 'num'));
    for (const side of ['a', 'b']) {
      const L = F.o(side);
      w.b(L.h('cx')); w.b(L.h('cy')); w.b(L.h('owner')); w.b(L.h('sigR')); w.b(L.h('sigZ'));
    }
    w.u64(F.n('deadline', 'num'));
    w.u64(F.n('fee', 'num', 0n));
    w.b(S.h('nk'));
    const ch = F.each('shareChange', true);
    w.u32(ch.length);
    for (const C of ch) { w.b(C.h('cx')); w.b(C.h('cy')); w.b(C.h('owner')); }
    if (ch.length) w.b(F.h('changeRangeProof'));
    w.b(F.h('shareKernelR')); w.b(F.h('shareKernelZ'));
  },
  // exec-lpbond.rs
  lpbond(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(29);
    w.b(F.h('controller')); w.b(F.h('owner')); w.b(F.h('bondNonce'));
    w.b(F.h('assetA')); w.b(F.h('assetB'));
    w.u32(F.n('feeBps', 'any', 0n, 32));
    w.u32(F.n('protocolFeeBps', 'any', 0n, 32));
    w.b(F.hOr('protocolFeeRecipient', Z33));
    w.u64(F.n('reserveAPre', 'any', 0n)); w.u64(F.n('reserveBPre', 'any', 0n)); w.u64(F.n('sharesPre', 'any', 0n));
    const A = F.o('a'), B = F.o('b');
    for (const L of [A, B]) {
      w.b(L.h('cx')); w.b(L.h('cy')); w.b(L.h('owner'));
      w.u64(L.n('index', 'num'));
      w.path(L.hs('path'));
      w.u64(L.n('d', 'any', 0n));
      w.b(L.h('sigR')); w.b(L.h('sigZ'));
    }
    w.u64(F.n('opDeadline', 'any', 0n));
    w.u64(F.n('fee', 'any', 0n));
    w.b(A.h('nk')); w.b(B.h('nk'));
  },
  // exec-farmbond.rs
  farmbond(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(20);
    w.b(F.h('controller')); w.b(F.h('owner')); w.b(F.h('nonce')); w.b(F.h('lpAsset'));
    const legs = F.each('legs');
    w.u32(legs.length);
    for (const L of legs) {
      w.b(L.h('cx')); w.b(L.h('cy'));
      w.u64(L.n('value', 'any')); w.u64(L.n('index', 'any'));
      w.path(L.hs('path'));
      w.b(L.h('sigR')); w.b(L.h('sigZ')); w.b(L.h('owner')); w.b(L.h('nk'));
    }
  },
  // exec-farmharvest.rs
  farmharvest(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(21);
    w.b(F.h('controller')); w.b(F.h('owner'));
    w.u64(F.n('shares', 'any'));
    w.b(F.h('nonce')); w.b(F.h('harvestNonce'));
    w.u64(F.n('reward', 'any'));
    w.u64(F.n('fee', 'any', 0n));
    w.b(F.h('lpAsset'));
    w.u64(F.n('oldIndex', 'any'));
    w.path(F.hs('oldPath'));
    w.b(F.h('rewardAsset')); w.b(F.h('rewardOwner')); w.b(F.h('rewardCx')); w.b(F.h('rewardCy'));
    w.b(F.h('sigR')); w.b(F.h('sigZ'));
    for (const half of F.sig64('ownerSig')) w.b(half);
  },
  // exec-farmunbond.rs
  farmunbond(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(22);
    w.b(F.h('controller')); w.b(F.h('owner'));
    w.u64(F.n('shares', 'any'));
    w.u64(F.n('fee', 'any', 0n));
    w.b(F.h('nonce')); w.b(F.h('lpAsset'));
    w.u64(F.n('oldIndex', 'any'));
    w.path(F.hs('oldPath'));
    w.b(F.h('lpOwner')); w.b(F.h('releaseCx')); w.b(F.h('releaseCy'));
    w.b(F.h('sigR')); w.b(F.h('sigZ'));
    for (const half of F.sig64('ownerSig')) w.b(half);
  },
  // exec-stealthlock.rs
  stealthlock(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1);
    stealthLock(w, F);
  },
  // exec-stealthlockbatch.rs
  stealthlockbatch(w, F, r) {
    const ops = F.each('ops');
    if (!ops.length) throw r.bad('ops is empty');
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(ops.length);
    for (const O of ops) stealthLock(w, O);
  },
  // exec-stealthclaim.rs
  stealthclaim(w, F) {
    w.b(F.h('chainBinding')); w.zeros(3); w.b(F.h('lockSetRoot')); w.zeros(1);
    w.u32(1); w.u8(24);
    // 1: the value-hidden send (kernel + range proof on M); 0: the amount-bearing skim (opening sigma on M).
    const blind = F.flag('blind', 'num', 1n);
    w.u8(blind);
    w.b(F.h('asset')); w.b(F.h('lCx')); w.b(F.h('lCy')); w.b(F.h('ownerPub'));
    if (blind === 0n) w.u64(F.n('amount', 'any'));
    w.u64(F.n('deadline', 'any'));
    w.b(F.h('locker'));
    w.u64(F.n('lIndex', 'num'));
    w.path(F.hs('lPath'));
    w.b(F.h('mCx')); w.b(F.h('mCy')); w.b(F.h('mOwner'));
    w.u64(F.n('fee', 'any'));
    if (blind === 1n) { w.b(F.h('kernelR')); w.b(F.h('kernelZ')); w.b(F.h('mRange')); }
    else { w.b(F.h('mSigR')); w.b(F.h('mSigZ')); }
    for (const half of F.sig64('ownerSig')) w.b(half);
  },
  // exec-stealthrefund.rs
  stealthrefund(w, F) {
    w.b(F.h('chainBinding')); w.zeros(3); w.b(F.h('lockSetRoot')); w.zeros(1);
    w.u32(1); w.u8(25);
    w.b(F.h('asset')); w.b(F.h('lCx')); w.b(F.h('lCy')); w.b(F.h('ownerPub'));
    w.u64(F.n('deadline', 'num'));
    w.b(F.h('locker'));
    w.u64(F.n('lIndex', 'num'));
    w.path(F.hs('lPath'));
    w.b(F.h('oCx')); w.b(F.h('oCy'));
    w.u64(F.n('fee', 'num'));
    w.b(F.h('refundOwner')); w.b(F.h('kernelR')); w.b(F.h('kernelZ')); w.b(F.h('oRange'));
    for (const half of F.sig64('lockerSig')) w.b(half);
  },
  // exec-bridgeburn.rs
  bridgeburn(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(3);
    w.b(F.h('asset'));
    w.u32(F.n('destChain', 'num', undefined, 32));
    const ins = F.each('inputs'), outs = F.each('outputs');
    w.u32(ins.length); w.u32(outs.length);
    for (const I of ins) {
      w.b(I.h('cx')); w.b(I.h('cy')); w.b(I.h('owner'));
      w.u64(I.n('leafIndex', 'num'));
      w.path(I.hs('path'));
      w.b(I.h('nk'));
    }
    for (const O of outs) { w.b(O.h('cx')); w.b(O.h('cy')); w.b(O.h('owner')); }
    w.b(F.h('rangeProof'));
    w.u64(F.n('fee', 'dec', 0n));
    const K = F.o('kernel'); w.b(K.h('R')); w.b(K.h('z'));
  },
  // exec-bridgemint.rs
  bridgemint(w, F) {
    const I = F.o('input'), O = F.o('output'), BM = F.o('burnMembership'), K = F.o('kernel');
    w.b(F.h('chainBinding')); w.zeros(2); w.b(F.h('bitcoinBurnRoot')); w.zeros(2);
    w.u32(1); w.u8(4);
    w.b(F.h('asset')); w.b(F.h('poolRoot'));
    w.b(I.h('cx')); w.b(I.h('cy')); w.b(I.h('owner'));
    w.u32(F.n('sourceClass', 'num', undefined, 32));
    w.b(F.h('spentTxid'));
    w.u32(F.n('spentVout', 'num', undefined, 32));
    w.u64(I.n('leafIndex', 'num'));
    w.path(I.hs('path'));
    w.b(O.h('cx')); w.b(O.h('cy')); w.b(O.h('owner'));
    w.b(BM.h('next'));
    w.u64(BM.n('index', 'num'));
    w.path(BM.hs('path'));
    w.b(F.h('rangeProof'));
    w.u64(F.n('fee', 'any', 0n));
    w.b(K.h('R')); w.b(K.h('z'));
  },
  // exec-bridgestealthmint.rs
  bridgestealthmint(w, F) {
    w.b(F.h('chainBinding')); w.zeros(2); w.b(F.h('bitcoinBurnRoot')); w.zeros(2);
    w.u32(1); w.u8(26);
    w.b(F.h('asset')); w.b(F.h('poolRoot'));
    w.b(F.h('inCx')); w.b(F.h('inCy')); w.b(F.h('inOwner'));
    w.u32(F.n('sourceClass', 'num', undefined, 32));
    w.b(F.h('spentTxid'));
    w.u32(F.n('spentVout', 'num', undefined, 32));
    w.u64(F.n('inIndex', 'num'));
    w.path(F.hs('inPath'));
    w.b(F.h('ownerPub'));
    w.u64(F.n('deadline', 'num'));
    w.b(F.h('locker')); w.b(F.h('lCx')); w.b(F.h('lCy'));
    w.b(F.h('bmNext'));
    w.u64(F.n('bmIndex', 'num'));
    w.path(F.hs('bmPath'));
    w.u64(F.n('fee', 'any', 0n));
    w.b(F.h('kernelR')); w.b(F.h('kernelZ')); w.b(F.h('lRange'));
  },
  // exec-cbtcmint.rs
  cbtcmint(w, F) {
    w.b(F.h('chainBinding')); w.zeros(5);
    w.u32(1); w.u8(18);
    w.b(F.h('outpoint'));
    w.u64(F.n('vBtc', 'any'));
    w.u64(F.n('fee', 'any', 0n));
    w.b(F.h('cx')); w.b(F.h('cy')); w.b(F.h('sigR')); w.b(F.h('sigZ'));
  },
  // exec-cdpmint.rs
  cdpmint(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(15);
    w.b(F.h('controller')); w.b(F.h('owner'));
    const debt = F.n('debtValue', 'any');
    w.u64(debt);
    w.b(F.h('nonce')); w.b(F.h('rateSnapshot'));
    w.u64(F.n('fee', 'any', 0n));
    if (debt > 0n) { // a bond (debtValue 0) has no debt note
      const D = F.o('debt');
      w.b(D.h('cx')); w.b(D.h('cy')); w.b(F.h('debtOwner')); w.b(D.h('sigR')); w.b(D.h('sigZ'));
    }
    const legs = F.each('legs');
    w.u32(legs.length);
    for (const L of legs) {
      w.b(L.h('asset')); w.b(L.h('cx')); w.b(L.h('cy'));
      w.u64(L.n('value', 'any'));
      w.u64(L.n('index', 'num'));
      w.path(L.hs('path'));
      w.b(L.h('sigR')); w.b(L.h('sigZ')); w.b(L.h('owner')); w.b(L.h('nk'));
    }
  },
  // exec-cdpclose.rs
  cdpclose(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(3); w.b(F.h('cdpPositionRoot'));
    w.u32(1); w.u8(16);
    w.b(F.h('controller')); w.b(F.h('owner'));
    w.u64(F.n('debtValue', 'any'));
    w.b(F.h('nonce')); w.b(F.h('rateSnapshot'));
    w.u64(F.n('positionIndex', 'num'));
    w.path(F.hs('positionPath'));
    const legs = F.each('legs');
    w.u32(legs.length);
    w.u64(F.n('fee', 'any', 0n));
    for (const L of legs) {
      w.b(L.h('asset'));
      w.u64(L.n('value', 'any'));
      w.b(L.h('cx')); w.b(L.h('cy')); w.b(L.h('owner')); w.b(L.h('sigR')); w.b(L.h('sigZ'));
    }
    for (const half of F.sig64('ownerSig')) w.b(half);
    cdpDebts(w, F);
  },
  // exec-cdptopup.rs
  cdptopup(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(3); w.b(F.h('cdpPositionRoot'));
    w.u32(1); w.u8(19);
    w.b(F.h('controller')); w.b(F.h('owner'));
    w.u64(F.n('debtValue', 'any'));
    w.b(F.h('oldNonce')); w.b(F.h('newNonce')); w.b(F.h('rateSnapshot'));
    w.u64(F.n('positionIndex', 'num'));
    w.path(F.hs('positionPath'));
    const old = F.each('oldLegs');
    w.u32(old.length);
    for (const L of old) { w.b(L.h('asset')); w.u64(L.n('value', 'any')); }
    const added = F.each('addedLegs');
    w.u32(added.length);
    for (const L of added) {
      w.b(L.h('asset')); w.b(L.h('cx')); w.b(L.h('cy'));
      w.u64(L.n('value', 'any'));
      w.u64(L.n('index', 'num'));
      w.path(L.hs('path'));
      w.b(L.h('sigR')); w.b(L.h('sigZ')); w.b(L.h('owner')); w.b(L.h('nk'));
    }
    for (const half of F.sig64('ownerSig')) w.b(half);
  },
  // exec-cdpliquidate.rs
  cdpliquidate(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(3); w.b(F.h('cdpPositionRoot'));
    w.u32(1); w.u8(17);
    w.b(F.h('controller')); w.b(F.h('owner'));
    w.u64(F.n('debtValue', 'any'));
    w.b(F.h('nonce')); w.b(F.h('rateSnapshot')); w.b(F.h('liquidator'));
    w.u64(F.n('positionIndex', 'num'));
    w.path(F.hs('positionPath'));
    const legs = F.each('legs');
    w.u32(legs.length);
    w.u64(F.n('fee', 'any', 0n));
    for (const L of legs) { w.b(L.h('asset')); w.u64(L.n('value', 'any')); }
    cdpDebts(w, F);
  },
  // exec-wrapcdpmint.rs
  wrapcdpmint(w, F) {
    w.b(F.h('chainBinding')); w.zeros(5);
    w.u32(1); w.u8(30);
    w.b(F.h('controller')); w.b(F.h('owner'));
    w.u64(F.n('debtValue', 'any', 0n));
    w.b(F.h('nonce')); w.b(F.h('rateSnapshot'));
    w.u64(F.n('fee', 'any', 0n));
    const D = F.o('debt');
    w.b(D.h('cx')); w.b(D.h('cy')); w.b(D.h('debtOwner')); w.b(D.h('sigR')); w.b(D.h('sigZ'));
    const legs = F.each('legs');
    w.u32(legs.length);
    for (const L of legs) {
      w.b(L.h('asset'));
      w.u64(L.n('value', 'any', 0n));
      w.b(L.h('cx')); w.b(L.h('cy')); w.b(L.h('sigR')); w.b(L.h('sigZ'));
    }
  },
  // exec-wraplp.rs
  wraplp(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(32);
    w.b(F.h('assetA')); w.b(F.h('assetB'));
    w.u32(F.n('feeBps', 'any', undefined, 32));
    w.u32(F.n('protocolFeeBps', 'any', undefined, 32));
    w.b(F.h('protocolFeeRecipient'));
    w.u64(F.n('reserveAPre', 'any')); w.u64(F.n('reserveBPre', 'any')); w.u64(F.n('sharesPre', 'any'));
    for (const side of ['a', 'b']) {
      const D = F.o(side);
      w.u64(D.n('value', 'any'));
      w.b(D.h('cx')); w.b(D.h('cy')); w.b(D.h('owner')); w.b(D.h('sigR')); w.b(D.h('sigZ'));
    }
    const S = F.o('share');
    w.b(S.h('cx')); w.b(S.h('cy')); w.b(S.h('owner')); w.b(S.h('sigR')); w.b(S.h('sigZ'));
    w.u64(F.n('opDeadline', 'any'));
    w.u64(F.n('fee', 'any'));
  },
  // exec-wrapswap.rs
  wrapswap(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(33);
    w.b(F.h('assetA')); w.b(F.h('assetB'));
    w.u32(F.n('feeBps', 'any', undefined, 32));
    w.u32(F.n('protocolFeeBps', 'any', undefined, 32));
    w.b(F.h('protocolFeeRecipient'));
    w.u64(F.n('reserveAPre', 'any')); w.u64(F.n('reserveBPre', 'any'));
    w.u8(F.n('direction', 'any', undefined, 8));
    w.u64(F.n('amountIn', 'any'));
    w.u64(F.n('fee', 'any'));
    const D = F.o('deposit');
    w.b(D.h('cx')); w.b(D.h('cy')); w.b(D.h('owner')); w.b(D.h('sigR')); w.b(D.h('sigZ'));
    w.u64(F.n('minOut', 'any'));
    const O = F.o('out');
    w.b(O.h('cx')); w.b(O.h('cy')); w.b(O.h('owner')); w.b(O.h('sigR')); w.b(O.h('sigZ'));
    w.u64(F.n('opDeadline', 'any'));
  },
  // exec-otc.rs
  otc(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(9);
    w.b(F.h('assetA')); w.b(F.h('assetB'));
    w.u64(F.n('vA', 'num')); w.u64(F.n('vB', 'num'));
    w.b(F.h('makerOwner')); w.b(F.h('takerOwner'));
    for (const side of ['maker', 'taker']) {
      const L = F.o(side);
      w.b(L.h('inCx')); w.b(L.h('inCy'));
      w.u64(L.n('inLeafIndex', 'num'));
      w.path(L.hs('inPath'));
      w.b(L.h('nk'));
      w.u64(L.n('inAmount', 'num'));
      w.b(L.h('inSigR')); w.b(L.h('inSigZ'));
      const change = L.flag('hasChange', 'num');
      w.u8(change);
      if (change === 1n) { w.b(L.h('changeCx')); w.b(L.h('changeCy')); w.b(L.h('changeSigR')); w.b(L.h('changeSigZ')); }
      w.b(L.h('recvCx')); w.b(L.h('recvCy')); w.b(L.h('recvSigR')); w.b(L.h('recvSigZ'));
    }
    w.u64(F.n('deadline', 'num', 0n));
    w.u64(F.n('feeA', 'num', 0n));
    w.u64(F.n('feeB', 'num', 0n));
  },
  // exec-bid.rs (build_stdin)
  bid(w, F) {
    const note = (N) => { w.b(N.h('cx')); w.b(N.h('cy')); };
    const sig = (N) => { w.b(N.h('sigR')); w.b(N.h('sigZ')); };
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(10);
    w.b(F.h('assetA')); w.b(F.h('assetB'));
    const maxFill = F.n('maxFill', 'num');
    w.u64(F.n('minFill', 'num')); w.u64(maxFill); w.u64(F.n('price', 'num')); w.u64(F.n('increment', 'num'));
    w.b(F.h('buyerOwner'));
    const FUND = F.o('fund');
    note(FUND);
    w.u64(FUND.n('leafIndex', 'num'));
    w.path(FUND.hs('path'));
    w.b(FUND.h('nk'));
    sig(FUND);
    const chosen = F.n('chosenF', 'num');
    w.u64(chosen);
    const RA = F.o('buyerRecvA'); note(RA); sig(RA);
    if (chosen < maxFill) { const R = F.o('refund'); note(R); sig(R); }
    const SI = F.o('sellerIn');
    note(SI);
    w.b(F.h('sellerOwner'));
    w.u64(SI.n('leafIndex', 'num'));
    w.path(SI.hs('path'));
    w.b(SI.h('nk'));
    w.u64(SI.n('amount', 'num'));
    sig(SI);
    const change = F.flag('sellerHasChange', 'num');
    w.u8(change);
    if (change === 1n) { const C = F.o('sellerChange'); note(C); sig(C); }
    const RB = F.o('sellerRecvB'); note(RB); sig(RB);
    w.u64(F.n('deadline', 'num', 0n));
    w.u64(F.n('fee', 'num', 0n));
  },
  // exec-fastlane.rs: an OP_TRANSFER of Bitcoin-homed notes, { chainBinding, spendRoot, bitcoinSpentRoot, transfer }.
  fastlane(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.b(F.h('bitcoinSpentRoot')); w.zeros(3);
    w.u32(1);
    const T = F.o('transfer');
    w.u8(1);
    w.b(T.h('asset'));
    const ins = T.each('inputs'), outs = T.each('outputs');
    w.u32(ins.length); w.u32(outs.length);
    for (const I of ins) {
      w.b(I.h('cx')); w.b(I.h('cy')); w.b(I.h('owner'));
      w.u64(I.n('leafIndex', 'num'));
      w.path(I.hs('path'));
      const L = I.o('low');
      w.b(L.h('value')); w.b(L.h('next'));
      w.u64(L.n('index', 'num'));
      w.path(L.hs('path'));
    }
    for (const O of outs) { w.b(O.h('cx')); w.b(O.h('cy')); w.b(O.h('owner')); }
    w.b(T.h('rangeProof'));
    w.u64(T.n('fee', 'any', 0n));
    for (const I of ins) w.b(I.h('sig'));
    const K = T.o('kernel'); w.b(K.h('R')); w.b(K.h('z'));
  },
  // exec-adaptorlock.rs
  adaptorlock(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(4);
    w.u32(1); w.u8(12);
    w.b(F.h('asset')); w.b(F.h('locker')); w.b(F.h('recipient')); w.b(F.h('refundPub'));
    w.u64(F.n('amount', 'num'));
    w.b(F.h('tx')); w.b(F.h('ty'));
    w.u64(F.n('deadline', 'num'));
    w.b(F.h('nCx')); w.b(F.h('nCy'));
    w.u64(F.n('nIndex', 'num'));
    w.path(F.hs('nPath'));
    w.b(F.h('nk')); w.b(F.h('nSigR')); w.b(F.h('nSigZ'));
    w.b(F.h('lCx')); w.b(F.h('lCy')); w.b(F.h('lSigR')); w.b(F.h('lSigZ'));
  },
  // exec-adaptorclaim.rs
  adaptorclaim(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(2); w.b(F.h('lockSetRoot')); w.zeros(1);
    w.u32(1); w.u8(13);
    w.b(F.h('asset')); w.b(F.h('lCx')); w.b(F.h('lCy')); w.b(F.h('tx')); w.b(F.h('ty'));
    w.u64(F.n('deadline', 'num'));
    w.b(F.h('recipient')); w.b(F.h('locker'));
    w.u64(F.n('lIndex', 'num'));
    w.path(F.hs('lPath'));
    w.u64(F.n('amount', 'num'));
    w.b(F.h('oCx')); w.b(F.h('oCy')); w.b(F.h('oSigR')); w.b(F.h('oSigZ'));
    w.b(F.h('kernelR')); w.b(F.h('kernelS')); w.b(F.h('outOwner'));
    for (const half of F.sig64('recipientSig')) w.b(half);
  },
  // exec-adaptorrefund.rs
  adaptorrefund(w, F) {
    w.b(F.h('chainBinding')); w.b(F.h('spendRoot')); w.zeros(2); w.b(F.h('lockSetRoot')); w.zeros(1);
    w.u32(1); w.u8(14);
    w.b(F.h('asset')); w.b(F.h('lCx')); w.b(F.h('lCy')); w.b(F.h('tx')); w.b(F.h('ty'));
    w.u64(F.n('deadline', 'num'));
    w.b(F.h('recipient')); w.b(F.h('locker'));
    w.u64(F.n('lIndex', 'num'));
    w.path(F.hs('lPath'));
    w.b(F.h('oCx')); w.b(F.h('oCy'));
    w.u64(F.n('amount', 'num'));
    w.b(F.h('lSigR')); w.b(F.h('lSigZ'));
    w.u64(F.n('fee', 'num', 0n));
    w.b(F.h('kernelR')); w.b(F.h('kernelZ'));
    for (const half of F.sig64('lockerSig')) w.b(half);
    w.b(F.h('refundOwner'));
  },
};

// One OP_STEALTH_LOCK, as exec-stealthlock.rs and each op of exec-stealthlockbatch.rs write it.
function stealthLock(w, O) {
  w.u8(23);
  w.b(O.h('asset')); w.b(O.h('locker')); w.b(O.h('ownerPub')); w.b(O.h('refundPub'));
  w.u64(O.n('deadline', 'num'));
  w.b(O.h('nCx')); w.b(O.h('nCy'));
  w.u64(O.n('nIndex', 'num'));
  w.path(O.hs('nPath'));
  w.b(O.h('nk')); w.b(O.h('lCx')); w.b(O.h('lCy'));
  w.b(O.h('kernelR')); w.b(O.h('kernelZ'));
  w.b(O.h('inPokR')); w.b(O.h('inPokZv')); w.b(O.h('inPokZr'));
}

// The debt notes a CDP close or liquidation burns.
function cdpDebts(w, F) {
  const debts = F.each('debts');
  w.u32(debts.length);
  for (const D of debts) {
    w.b(D.h('cx')); w.b(D.h('cy')); w.b(D.h('owner'));
    w.u64(D.n('value', 'any'));
    w.u64(D.n('index', 'num'));
    w.path(D.hs('path'));
    w.b(D.h('sigR')); w.b(D.h('sigZ')); w.b(D.h('nk'));
  }
}

export const SELF_PROVE_TYPES = Object.freeze(Object.keys(BUILD));

// The cycle and gas limits each harness puts on its network request (exec-lp's LP_*, exec-bridgeburn's BRIDGEBURN_* and
// exec-fastlane's FASTLANE_* at their defaults).
const STD = Object.freeze({ cycleLimit: 256_000_000n, gasLimit: 1_000_000_000n });
export const LIMITS = Object.freeze(Object.fromEntries(SELF_PROVE_TYPES.map((t) => [t, ({
  lp: Object.freeze({ cycleLimit: 30_000_000_000n, gasLimit: 30_000_000_000n }),
  bridgeburn: Object.freeze({ cycleLimit: 4_000_000_000n, gasLimit: 4_000_000_000n }),
  fastlane: Object.freeze({ cycleLimit: 4_000_000_000n, gasLimit: 4_000_000_000n }),
})[t] || STD])));

// bincode(SP1Stdin) for `op` (the op JSON a page submits for `type`, with `memoHashes`).
export function stdinFor(type, op) {
  if (!own.call(BUILD, type)) throw new Error(`sp1-stdin: no program input for op type ${JSON.stringify(type)} (have: ${SELF_PROVE_TYPES.join(', ')})`);
  if (!isObj(op)) throw new Error(`sp1-stdin ${type}: op must be an object`);
  // The op as the relay receives it: confidential-relay.js submitOp sends every BigInt as its decimal string.
  const f = JSON.parse(JSON.stringify(op, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const r = reader(type);
  const F = r.at(f);
  const w = writer();
  BUILD[type](w, F, r);
  memos(w, F, r);
  return encode(w.entries);
}

// A zstd frame (RFC 8878) holding `bytes` uncompressed: the magic number, a frame header with Single_Segment set and the
// content size, the content in raw blocks of at most 128 KiB with the last flagged, and no checksum.
export function zstdFrame(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('zstdFrame: bytes must be a Uint8Array');
  const n = bytes.length;
  const MAX = 128 * 1024;
  const head = [0x28, 0xb5, 0x2f, 0xfd];
  // Frame_Header_Descriptor: Frame_Content_Size_flag in bits 7-6, Single_Segment_flag (bit 5); the field takes 1, 2
  // (stored as size - 256), 4 or 8 bytes.
  if (n < 256) head.push(0x20, n);
  else if (n < 65536 + 256) head.push(0x60, (n - 256) & 0xff, (n - 256) >>> 8);
  else if (n <= 0xffffffff) head.push(0xa0, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
  else { head.push(0xe0); let x = BigInt(n); for (let i = 0; i < 8; i++) { head.push(Number(x & 0xffn)); x >>= 8n; } }
  const blocks = Math.max(1, Math.ceil(n / MAX));
  const out = new Uint8Array(head.length + blocks * 3 + n);
  out.set(head);
  let o = head.length;
  for (let i = 0, off = 0; i < blocks; i++, off += MAX) {
    const size = Math.min(MAX, n - off);
    const last = i === blocks - 1 ? 1 : 0;
    const h = size * 8 + last; // Block_Size << 3 | Block_Type (0, raw) << 1 | Last_Block
    out[o++] = h & 0xff; out[o++] = (h >>> 8) & 0xff; out[o++] = (h >>> 16) & 0xff;
    out.set(bytes.subarray(off, off + size), o);
    o += size;
  }
  return out;
}
