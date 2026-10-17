// OP_BRIDGE_MINT client: mint the Ethereum note for a Bitcoin note burned for the bridge (BTC→ETH), and hand it
// to the relay so a holder with no ETH can complete the mint.
//
// The destination is fixed at burn time: the 0x2B burn envelope pins destLeaf = leaf(asset, Cx, Cy, owner) of the
// Ethereum note, and the reflection records burnId → destLeaf in the bridge-burn set. The mint proves
// v_burn == v_out + fee, so a relay fee is chosen when the burn is BUILT: commit the destination to
// v_burn − fee (see `destValueFor`), and the mint pays exactly that fee to whoever settles it. A destination
// committed to the full burned value mints with fee 0 (self-settle, or the relay's free budget).
//
// The op JSON matches contracts/sp1/confidential/harnesses/exec-bridgemint.rs (the relay writes it verbatim to the
// harness OP_FILE): chainBinding ‖ bitcoinBurnRoot ‖ asset ‖ poolRoot ‖ sourceClass ‖ spentTxid ‖ spentVout ‖
// input{cx,cy,owner,leafIndex,path} ‖ output{cx,cy,owner} ‖ burnMembership{next,index,path} ‖ rangeProof ‖ fee ‖
// kernel{R,z}. The kernel is the unbound conservation kernel over [C_burn] → [C_dest] with the public fee
// (verify_kernel_with_fee), so only the holder of both openings can sign it.
//
// Witness data (the Bitcoin note tree and the bridge-burn set) comes from the relay's public reflected-state
// export, GET /reflection/dump. The mint must prove against the burn root the pool currently holds, so a mint
// built just before a newer reflection lands is refused on-chain as stale; rebuild it from a fresh dump.
//
// Deps: { pool } — makeConfidentialPool(); { ct } — makeConfidentialTransfer(); { relay } — makeConfidentialRelay()
// (for `bridgeMint`); { fetchImpl, relayBase } — for `fetchReflectionSnapshot`.

const SOURCE_DEPOSIT = 0, SOURCE_REFLECTED = 1, SOURCE_REFLECTED_BOUND = 2;
const BURN_SOURCE_REFLECTED = 1, BURN_SOURCE_DEPOSIT = 2;
const U64_MAX = (1n << 64n) - 1n;

// A relay fee must be zero or carry at most two significant decimal digits (the guest's fee_is_quantized).
export function feeIsQuantized(fee) {
  let f = BigInt(fee);
  if (f < 0n) return false;
  if (f === 0n) return true;
  while (f % 10n === 0n) f /= 10n;
  return f < 100n;
}

// Round a fee UP onto the two-significant-digit ladder (never below the amount it was derived from).
export function ladderFee(v) {
  const x = BigInt(v);
  if (x <= 0n) return 0n;
  let digits = 0n;
  for (let t = x; t > 0n; t /= 10n) digits += 1n;
  if (digits <= 2n) return x;
  const scale = 10n ** (digits - 2n);
  return ((x + scale - 1n) / scale) * scale;
}

// The value to commit the Ethereum destination to when burning `burnValue` with relay fee `fee`.
export function destValueFor({ burnValue, fee = 0n }) {
  const v = BigInt(burnValue), f = BigInt(fee);
  if (!feeIsQuantized(f)) throw new Error(`bridge-mint: fee ${f} is not on the fee ladder (at most two significant digits)`);
  if (v <= 0n || v > U64_MAX) throw new Error('bridge-mint: burned value out of range');
  if (f >= v) throw new Error('bridge-mint: fee must be below the burned value');
  return v - f;
}

// Display (RPC / explorer) txid → the internal byte order the guest and burnId use.
export function txidInternal(displayHex) {
  const h = String(displayHex).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('bridge-mint: txid must be 32 bytes of hex');
  return '0x' + h.match(/../g).reverse().join('').toLowerCase();
}

export function makeConfidentialBridgeMint({ pool, ct, relay = null, fetchImpl = null, relayBase = '' } = {}) {
  if (!pool) throw new Error('confidential-bridge-mint: pool is required');
  const hex32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const lc = (x) => String(x || '').toLowerCase();
  const ptHex = (P) => '0x' + Array.from(P.toRawBytes(true), (b) => b.toString(16).padStart(2, '0')).join('');
  const bytesHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  // A fresh memo ephemeral scalar in (0, n), for callers that do not supply their own source.
  const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const freshScalar = () => {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    const x = BigInt(bytesHex(b)) % SECP_N;
    return x === 0n ? 1n : x;
  };

  // The burned note's leaf in the reflected Bitcoin note tree, per source class (mirrors OP_BRIDGE_MINT):
  //   0 — burn-deposit native note, owned by its own burned outpoint: leaf(asset, cx, cy, outpointKey)
  //   1 — reflected note (legacy domain):                               btc_note_leaf(asset, cx, cy, authKey)
  //   2 — reflected note bound to this deployment:                      btc_note_leaf_bound(..., chainBinding)
  function sourceLeaf({ sourceClass, asset, cx, cy, owner, spentTxid, spentVout, chainBinding }) {
    switch (Number(sourceClass)) {
      case SOURCE_DEPOSIT: return pool.leaf(asset, cx, cy, pool.outpointKey(spentTxid, spentVout));
      case SOURCE_REFLECTED: return pool.btcNoteLeaf(asset, cx, cy, owner);
      case SOURCE_REFLECTED_BOUND: return pool.btcNoteLeafBound(asset, cx, cy, owner, chainBinding);
      default: throw new Error(`bridge-mint: unknown source class ${sourceClass}`);
    }
  }

  // A mint op has two halves. The HOLDER'S half is everything that needs the two openings: the burned note's commitment, the
  // destination's commitment, the range proof, the public fee and the conservation kernel. The kernel is signed over
  // [C_burn] → [C_dest] with no leaf bound, so it names no root and no path. The PUBLIC half is the burn set's membership path under the
  // burn root, and the burned note's path in the Bitcoin note tree: both are read off the reflected state by anyone, and the burn root
  // is the one thing that goes stale (the pool takes a mint only on the root it holds). So a mint built before its burn was recorded, or
  // on a root the pool has since moved past, is the same holder's half with a fresh public half.

  // A typed refusal, so a caller can tell "not yet" (the burn is not recorded) from "never" (the destination differs).
  const bridgeMintError = (code, message) => Object.assign(new Error(`bridge-mint: ${message}`), { code });
  const needCt = () => { if (!ct) throw new Error('bridge-mint: ct is required to build a mint'); return ct; };

  // The holder's half (no reflected state needed). `burned` and `dest` are openings { value, blinding, owner }; the class says how the
  // burned note's leaf is formed. Returns { op, fee, destLeaf, nullifier, burnId, sourceClass, srcLeaf }, where `op` has no
  // bitcoinBurnRoot, poolRoot, input.leafIndex/path or burnMembership yet (completeBridgeMintOp fills them in).
  function bridgeMintParts({ chainBinding, asset, spentTxid, spentVout, sourceClass, burned, dest }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(chainBinding))) throw new Error('bridge-mint: chainBinding required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(asset))) throw new Error('bridge-mint: asset required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spentTxid))) throw new Error('bridge-mint: spentTxid required (internal byte order)');
    const vout = Number(spentVout);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error('bridge-mint: bad spentVout');
    const cls = Number(sourceClass);
    if (![SOURCE_DEPOSIT, SOURCE_REFLECTED, SOURCE_REFLECTED_BOUND].includes(cls)) throw new Error(`bridge-mint: unknown source class ${sourceClass}`);
    const c = needCt();
    const vIn = BigInt(burned.value), rIn = BigInt(burned.blinding);
    const vOut = BigInt(dest.value), rOut = BigInt(dest.blinding);
    if (vIn <= 0n || vIn > U64_MAX || vOut <= 0n || vOut > vIn) throw new Error('bridge-mint: destination value must be positive and at most the burned value');
    const fee = vIn - vOut;
    if (!feeIsQuantized(fee)) throw new Error(`bridge-mint: implied fee ${fee} (burned − destination) is not on the fee ladder`);
    const { cx: inCx, cy: inCy } = pool.commitXY(vIn, rIn);
    const { cx: outCx, cy: outCy } = pool.commitXY(vOut, rOut);
    const destLeaf = pool.leaf(asset, outCx, outCy, dest.owner);
    const inOwner = cls === SOURCE_DEPOSIT ? pool.outpointKey(spentTxid, vout) : burned.owner;
    const srcLeaf = sourceLeaf({ sourceClass: cls, asset, cx: inCx, cy: inCy, owner: burned.owner, spentTxid, spentVout: vout, chainBinding });
    const burnId = pool.bridgeBurnId(cls === SOURCE_DEPOSIT ? BURN_SOURCE_DEPOSIT : BURN_SOURCE_REFLECTED, spentTxid, vout, srcLeaf, chainBinding);
    const kernel = c.kernelSign({ inputs: [{ value: vIn, blinding: rIn }], outputs: [{ value: vOut, blinding: rOut }], fee, outLeaves: [] });
    const { proof: rangeProof } = c.rangeProve([vOut], [rOut]);
    const op = {
      chainBinding: lc(chainBinding), asset: lc(asset), sourceClass: cls, spentTxid: lc(spentTxid), spentVout: vout,
      input: { cx: inCx, cy: inCy, owner: inOwner },
      output: { cx: outCx, cy: outCy, owner: dest.owner },
      rangeProof: bytesHex(rangeProof), fee: fee.toString(), kernel: { R: ptHex(kernel.R), z: hex32(kernel.z) },
    };
    return { op, fee, destLeaf, nullifier: pool.nullifier(srcLeaf), burnId, sourceClass: cls, srcLeaf };
  }

  // The reflected state a mint is completed against, indexed once: the burn set (its root is what the pool must hold), the leaf index of
  // each Bitcoin note, and the note tree, which is built on first use (it is the costly part) and then shared by every mint completed on
  // it. `snapshot` is { noteLeaves, burnNodes } from fetchReflectionSnapshot or the dump.
  function prepareReflection(snapshot) {
    if (snapshot && snapshot.burns && snapshot.leafIndexOf) return snapshot;
    if (!snapshot || !Array.isArray(snapshot.noteLeaves) || !Array.isArray(snapshot.burnNodes)) throw new Error('bridge-mint: snapshot { noteLeaves, burnNodes } required');
    const burns = pool.makeUtxoAccumulator();
    burns.setNodes(snapshot.burnNodes);
    const leafIndexOf = new Map();
    snapshot.noteLeaves.forEach((l, i) => { if (!leafIndexOf.has(lc(l))) leafIndexOf.set(lc(l), i); });
    let tree = null;
    return { burns, leafIndexOf, burnRoot: burns.root(), noteLeaves: snapshot.noteLeaves, noteTree: () => { if (!tree) { tree = new pool.Tree(); for (const l of snapshot.noteLeaves) tree.insert(l); } return tree; } };
  }

  // What an op names, from the op alone: the burned note's leaf, the burn's id (the pool's one-mint key), the destination leaf the burn pinned,
  // and the burned note's nullifier. Throws `bad_op` on an op that is not a bridge mint's.
  function bridgeMintIdentity(op) {
    const cls = Number(op && op.sourceClass);
    if (!op || !op.input || !op.output || ![SOURCE_DEPOSIT, SOURCE_REFLECTED, SOURCE_REFLECTED_BOUND].includes(cls)) throw bridgeMintError('bad_op', 'not a bridge mint op');
    const vout = Number(op.spentVout);
    const srcLeaf = sourceLeaf({ sourceClass: cls, asset: op.asset, cx: op.input.cx, cy: op.input.cy, owner: op.input.owner, spentTxid: op.spentTxid, spentVout: vout, chainBinding: op.chainBinding });
    const burnId = pool.bridgeBurnId(cls === SOURCE_DEPOSIT ? BURN_SOURCE_DEPOSIT : BURN_SOURCE_REFLECTED, op.spentTxid, vout, srcLeaf, op.chainBinding);
    return { srcLeaf, burnId, destLeaf: pool.leaf(op.asset, op.output.cx, op.output.cy, op.output.owner), nullifier: pool.nullifier(srcLeaf) };
  }

  // Fill in, or renew, a mint's public half from the reflected state. Works on a half-built op or a complete one (the old public half is
  // simply replaced). Throws a typed error: `note_not_in_tree` and `burn_not_recorded` mean "not yet" (the reflection has not folded the
  // burned note or recorded the burn), `dest_mismatch` that the burn pinned a different destination than this op's.
  function completeBridgeMintOp(op, reflection) {
    const r = prepareReflection(reflection);
    const { srcLeaf, burnId, destLeaf, nullifier } = bridgeMintIdentity(op);
    const leafIndex = r.leafIndexOf.get(lc(srcLeaf));
    if (leafIndex == null) throw bridgeMintError('note_not_in_tree', 'the burned note is not in the reflected note tree (yet), or the opening/outpoint does not match it');
    if (!r.burns.contains(burnId)) throw bridgeMintError('burn_not_recorded', 'the burn is not recorded in the reflected state yet');
    const bm = r.burns.membershipWitness(burnId);
    if (lc(bm.value) !== lc(destLeaf)) throw bridgeMintError('dest_mismatch', 'the burn committed to a different destination than the one given (check dest value/blinding/owner — the destination value is the burned value net of the fee)');
    const { root: poolRoot, path: inPath } = r.noteTree().rootAndPath(leafIndex);
    const done = {
      ...op,
      bitcoinBurnRoot: r.burnRoot,
      poolRoot,
      input: { ...op.input, leafIndex, path: inPath },
      burnMembership: { next: bm.next, index: bm.index, path: bm.path },
    };
    return { op: done, burnId, destLeaf, srcLeaf, nullifier, burnRoot: r.burnRoot, poolRoot };
  }

  // True iff the holder's half stands alone: the destination's range proof and the conservation kernel over [C_burn] → [C_dest] with the
  // public fee both verify, which no one can produce without the two openings. A third party can run this on a mint it was handed.
  function verifyBridgeMintParts(op) {
    try {
      const c = needCt();
      const hexBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
      const fee = BigInt(op.fee);
      if (!feeIsQuantized(fee)) return { ok: false, reason: 'the fee is not on the fee ladder' };
      const inC = [c.pointOf(op.input.cx, op.input.cy)], outC = [c.pointOf(op.output.cx, op.output.cy)];
      const kernel = { R: c.pointFromHex(op.kernel.R), z: BigInt(op.kernel.z) };
      const ok = c.verifyTransfer({ inC, outC, rangeProof: hexBytes(op.rangeProof), kernel, fee, outLeaves: [] });
      return ok ? { ok: true } : { ok: false, reason: 'the range proof or the conservation kernel does not verify' };
    } catch (e) { return { ok: false, reason: `not a readable mint (${(e && e.message) || e})` }; }
  }

  // Build the OP_BRIDGE_MINT op for a burn the reflection has folded.
  //   burned   { value, blinding, owner } — the burned Bitcoin note's opening; owner is its x-only Taproot key
  //            (classes 1/2; ignored for class 0, whose owner is its outpoint key)
  //   dest     { value, blinding, owner } — the destination the burn committed to (owner = the Ethereum note owner)
  //   spentTxid/spentVout — the burned note's outpoint (internal byte order; see txidInternal)
  //   sourceClass — 0/1/2, or omitted to take whichever class's leaf and burnId the snapshot actually holds
  //   snapshot { noteLeaves, burnNodes } — from fetchReflectionSnapshot
  // Returns { op, fee, destLeaf, nullifier, burnId, sourceClass }. The fee is burned.value − dest.value, and must be
  // on the fee ladder; the destination must be exactly the one recorded for this burn, or the build refuses.
  function buildBridgeMintOp({ chainBinding, asset, spentTxid, spentVout, sourceClass, burned, dest, snapshot }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(chainBinding))) throw new Error('bridge-mint: chainBinding required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(asset))) throw new Error('bridge-mint: asset required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spentTxid))) throw new Error('bridge-mint: spentTxid required (internal byte order)');
    const vout = Number(spentVout);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error('bridge-mint: bad spentVout');
    if (!snapshot || !Array.isArray(snapshot.noteLeaves) || !Array.isArray(snapshot.burnNodes)) throw new Error('bridge-mint: snapshot { noteLeaves, burnNodes } required');
    const vIn = BigInt(burned.value), rIn = BigInt(burned.blinding);
    const vOut = BigInt(dest.value);
    if (vIn <= 0n || vIn > U64_MAX || vOut <= 0n || vOut > vIn) throw new Error('bridge-mint: destination value must be positive and at most the burned value');
    const fee = vIn - vOut;
    if (!feeIsQuantized(fee)) throw new Error(`bridge-mint: implied fee ${fee} (burned − destination) is not on the fee ladder`);

    // Which class the snapshot holds this burn under, found before any proof is made, so a burn that is not there fails at once.
    const { cx: inCx, cy: inCy } = pool.commitXY(vIn, rIn);
    const r = prepareReflection(snapshot);
    const classes = sourceClass == null ? [SOURCE_REFLECTED_BOUND, SOURCE_REFLECTED, SOURCE_DEPOSIT] : [Number(sourceClass)];
    let cls = null;
    for (const c of classes) {
      const srcLeaf = sourceLeaf({ sourceClass: c, asset, cx: inCx, cy: inCy, owner: burned.owner, spentTxid, spentVout: vout, chainBinding });
      if (!r.leafIndexOf.has(lc(srcLeaf))) continue;
      if (!r.burns.contains(pool.bridgeBurnId(c === SOURCE_DEPOSIT ? BURN_SOURCE_DEPOSIT : BURN_SOURCE_REFLECTED, spentTxid, vout, srcLeaf, chainBinding))) continue;
      cls = c;
      break;
    }
    if (cls == null) throw new Error('bridge-mint: burn not found in the reflected state yet (the burned note or its burn record is not folded), or the opening/outpoint does not match it');
    const parts = bridgeMintParts({ chainBinding, asset, spentTxid, spentVout: vout, sourceClass: cls, burned, dest });
    const done = completeBridgeMintOp(parts.op, r);
    return { op: done.op, fee, destLeaf: parts.destLeaf, nullifier: parts.nullifier, burnId: parts.burnId, sourceClass: cls };
  }

  // The Bitcoin-side half for a REFLECTED note (class 1 or 2): the 161-byte 0x2B burn envelope payload
  //   0x2B ‖ asset ‖ bitcoinPoolRoot ‖ ν ‖ destLeaf ‖ targetChainBinding
  // committing the Ethereum destination to v_burn − fee, plus the destination opening the mint will need. The
  // caller wraps `envelope` in the standard commit/reveal Taproot envelope ("TACIT"‖v1 frame, script-path spend
  // as vin[0]) and spends the burned note in another input of the same reveal tx; that tx must spend no other
  // reflected note. bridge-burn-broadcast.js builds, checks and broadcasts that pair. Pass `deriveDestBlinding(nullifier)` (e.g. deriveBridgeMintBlinding from bridge-mint-recovery.js,
  // keyed by the wallet) instead of `dest.blinding` so the minted note is recoverable from the seed.
  function buildBridgeBurnEnvelope({ asset, bitcoinPoolRoot, chainBinding, sourceClass = SOURCE_REFLECTED_BOUND, burned, fee = 0n, dest, deriveDestBlinding = null }) {
    const cls = Number(sourceClass);
    if (cls !== SOURCE_REFLECTED && cls !== SOURCE_REFLECTED_BOUND) throw new Error('bridge-mint: the envelope builder covers reflected notes (class 1 or 2); a burn-deposit has its own path');
    for (const [k, v] of [['asset', asset], ['bitcoinPoolRoot', bitcoinPoolRoot], ['chainBinding', chainBinding], ['burned.owner', burned && burned.owner], ['dest.owner', dest && dest.owner]]) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(v))) throw new Error(`bridge-mint: ${k} must be 32 bytes of hex`);
    }
    const vOut = destValueFor({ burnValue: burned.value, fee });
    const { cx, cy } = pool.commitXY(BigInt(burned.value), BigInt(burned.blinding));
    const srcLeaf = sourceLeaf({ sourceClass: cls, asset, cx, cy, owner: burned.owner, chainBinding });
    const nullifier = pool.nullifier(srcLeaf);
    const rDest = BigInt(dest.blinding != null ? dest.blinding : typeof deriveDestBlinding === 'function' ? deriveDestBlinding(nullifier) : 0n);
    if (rDest <= 0n) throw new Error('bridge-mint: dest.blinding or deriveDestBlinding required');
    const d = pool.commitXY(vOut, rDest);
    const destLeaf = pool.leaf(asset, d.cx, d.cy, dest.owner);
    const envelope = '0x2b' + [asset, bitcoinPoolRoot, nullifier, destLeaf, chainBinding].map((h) => String(h).replace(/^0x/, '').toLowerCase()).join('');
    return { envelope, nullifier, destLeaf, fee: BigInt(fee), dest: { value: vOut, blinding: rDest, owner: dest.owner, cx: d.cx, cy: d.cy } };
  }

  // The relay's public reflected-state export (the Bitcoin note tree and the bridge-burn set).
  async function fetchReflectionSnapshot({ network = 'mainnet' } = {}) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('bridge-mint: no fetch available');
    const root = String(relayBase || '').replace(/\/$/, '');
    const res = await f(`${root}/reflection/dump?network=${network === 'signet' ? 'signet' : 'mainnet'}`);
    if (!res.ok) throw new Error(`bridge-mint: reflection dump ${res.status}`);
    const j = await res.json();
    const snap = j && j.snapshot;
    if (!snap || !Array.isArray(snap.noteLeaves) || !Array.isArray(snap.burnNodes)) throw new Error('bridge-mint: reflection dump carries no note tree / burn set');
    return { noteLeaves: snap.noteLeaves, burnNodes: snap.burnNodes, height: j.attestedHeight ?? snap.height ?? null };
  }

  // How the minted note stays recoverable from the seed, as the descriptor the memo is sealed from (see bridgeMint's `recovery`).
  function outputFor(recovery, dest, op) {
    return recovery.seedDerived
      ? { seedDerived: true }
      : { ownerPub: recovery.ownerPub, value: String(dest.value), blinding: hex32(dest.blinding), secret: recovery.secret == null ? 0 : recovery.secret,
          asset: op.asset, owner: dest.owner, cx: op.output.cx, cy: op.output.cy };
  }

  // Arm the mint with the API (POST /confidential/arm): the holder's half only, built now from the two openings, with the memo the mint
  // will carry. The API completes it with the burn's path under the pool's root and queues it as soon as the burn is recorded, so the
  // mint no longer waits for this page to be open. Nothing in what is sent opens either note. → { ok, status, dest } | { ok: false, code, error }
  async function armMint({ network = 'mainnet', recovery, ephRand, ...args }) {
    if (!relay || typeof relay.sealFor !== 'function') throw new Error('bridge-mint: no relay wired');
    if (!recovery || (!recovery.seedDerived && recovery.ownerPub == null)) throw new Error('bridge-mint: pass recovery { ownerPub, secret } or { seedDerived: true } so the minted note stays recoverable');
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('bridge-mint: no fetch available');
    const parts = bridgeMintParts(args);
    const memos = relay.sealFor({ leaves: [parts.destLeaf], outputs: [outputFor(recovery, args.dest, parts.op)], ephRand: ephRand || freshScalar });
    const root = String(relayBase || '').replace(/\/$/, '');
    const res = await f(`${root}/confidential/arm?network=${network === 'signet' ? 'signet' : 'mainnet'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'bridgemint', op: parts.op, memos }) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.ok) return { ok: false, code: (j && j.code) || `http_${res.status}`, error: (j && j.error) || `the relay answered ${res.status}`, dest: parts.destLeaf };
    return { ok: true, status: j.status, jobId: j.jobId || null, dest: parts.destLeaf };
  }
  // Where an armed mint stands, by the destination leaf the burn pinned: armed | queued (with its job) | minted | failed | unknown.
  async function armedStatus(dest, { network = 'mainnet' } = {}) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('bridge-mint: no fetch available');
    const root = String(relayBase || '').replace(/\/$/, '');
    const res = await f(`${root}/confidential/armed?dest=${encodeURIComponent(dest)}&network=${network === 'signet' ? 'signet' : 'mainnet'}`);
    if (!res.ok) throw new Error(`bridge-mint: armed status ${res.status}`);
    const j = await res.json();
    return { status: (j && j.status) || 'unknown', jobId: (j && j.jobId) || null };
  }

  // Build the mint and relay it (POST /confidential/submit, type 'bridgemint'), waiting for the settle.
  // `recovery` describes how the minted note stays recoverable from the seed: { ownerPub, secret } seals a memo to
  // the owner's key (secret = the note's nk), or { seedDerived: true } when dest.blinding came from
  // deriveBridgeMintBlinding (bridge-mint-recovery.js), which the recovery scan re-derives on its own. That scan tries
  // round amounts and caller-supplied values, and a destination net of a fee is usually not round, so a fee'd mint
  // should seal a memo.
  // `selfSettle({ jobId, publicValues, proof, memos })` → { txHash }: the relay only proves, and the caller sends settle()
  // from its own account and pays that gas (no relay fee). The proof is still built by the relay.
  async function bridgeMint({ network = 'mainnet', snapshot = null, recovery, ephRand, waitOpts, selfSettle = null, staleDelayMs = 4000, ...args }) {
    if (!relay) throw new Error('bridge-mint: no relay wired');
    if (!recovery || (!recovery.seedDerived && recovery.ownerPub == null)) {
      throw new Error('bridge-mint: pass recovery { ownerPub, secret } or { seedDerived: true } so the minted note stays recoverable');
    }
    // The relay turns a mint away as 'stale_root' when the burn set it was built on is not the one the pool holds (a newer proof landed while
    // it was built): it is built again from the newest state, which costs nothing, instead of being proved for a settle that would revert.
    for (let attempt = 0; ; attempt++) {
      const snap = snapshot && attempt === 0 ? snapshot : await fetchReflectionSnapshot({ network });
      const built = buildBridgeMintOp({ ...args, snapshot: snap });
      const output = outputFor(recovery, args.dest, built.op);
      const spec = { type: 'bridgemint', op: built.op, leaves: [built.destLeaf], outputs: [output], ephRand: ephRand || freshScalar };
      try {
        if (!selfSettle) return { ...(await relay.settle(spec, waitOpts)), ...built };
        const proven = await relay.prove(spec, waitOpts);
        if (proven.status === 'settled') return { ...proven, ...built };
        if (proven.status !== 'proven') throw new Error(`bridge-mint: the relay could not prove this mint (${proven.error || proven.status})`);
        const sent = await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos: proven.memos || [] });
        return { jobId: proven.jobId, ...sent, ...built };
      } catch (e) {
        if (!(e && e.code === 'stale_root') || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, staleDelayMs * (attempt + 1)));
      }
    }
  }

  return { sourceLeaf, buildBridgeBurnEnvelope, buildBridgeMintOp, bridgeMintParts, bridgeMintIdentity, armMint, armedStatus, prepareReflection, completeBridgeMintOp, verifyBridgeMintParts, fetchReflectionSnapshot, bridgeMint, feeIsQuantized, ladderFee, destValueFor, txidInternal };
}
