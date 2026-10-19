
export function isqrtBig(n) {
  const v = BigInt(n);
  if (v < 0n) throw new Error('isqrt of negative');
  if (v < 2n) return v;
  let x = v, y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + v / x) >> 1n; }
  return x;
}

function _toHex(x) {
  if (typeof x === 'string') return x.toLowerCase();
  let s = '';
  for (let i = 0; i < x.length; i++) s += x[i].toString(16).padStart(2, '0');
  return s;
}

function _pairSwapped(assetA, assetB) {
  const a = _toHex(assetA || ''), b = _toHex(assetB || '');
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) throw new Error('replay: LP op without a 32-byte asset pair');
  if (a === b) throw new Error('replay: LP op with identical assets');
  return a > b;
}

export function computeProtocolShares(S_pre, k_pre, k_now, protocolFeeBps) {
  const S = BigInt(S_pre), kPre = BigInt(k_pre), kNow = BigInt(k_now), bps = BigInt(protocolFeeBps);
  if (bps <= 0n) return 0n;
  if (kNow <= kPre) return 0n;
  if (S === 0n) return 0n;
  const rootPre = isqrtBig(kPre), rootNow = isqrtBig(kNow);
  if (rootNow <= rootPre) return 0n;
  const numerator = S * bps * (rootNow - rootPre);
  const denominator = (10000n - bps) * rootNow + bps * rootPre;
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

export function replayAmmPoolState(ops, deps) {
  const {
    curveDeltaOut, lpAddShares, removeOutputs, MINIMUM_LIQUIDITY,
    computeProtocolShares: computeProtoShares, protocolFeeBps: cfgFeeBps, protocolFeeEnabled,
  } = deps || {};
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('replay: no ops');
  if (typeof curveDeltaOut !== 'function' || typeof lpAddShares !== 'function' || typeof removeOutputs !== 'function') {
    throw new Error('replay: missing pool math (curveDeltaOut / lpAddShares / removeOutputs)');
  }
  const MIN_LIQ = BigInt(MINIMUM_LIQUIDITY);
  const protoFeeBps = Number(cfgFeeBps || 0);
  const protoFeeOn = !!protocolFeeEnabled && protoFeeBps > 0 && typeof computeProtoShares === 'function';
  let reserveA = 0n, reserveB = 0n, totalShares = 0n, initialized = false;
  let poolFeeBps = 0;
  let kLast = 0n;

  const crystallize = () => {
    const kNow = reserveA * reserveB;
    if (protoFeeOn) {
      const minted = BigInt(computeProtoShares(totalShares, kLast, kNow, protoFeeBps));
      if (minted > 0n) totalShares += minted;
    }
    kLast = kNow;
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op.kind !== 'string') throw new Error(`replay[${i}]: malformed op`);

    if (op.kind === 'pool_init') {
      if (initialized) throw new Error(`replay[${i}]: pool_init after pool already initialized`);
      const da = BigInt(op.deltaA), db = BigInt(op.deltaB);
      if (da <= 0n || db <= 0n) throw new Error(`replay[${i}]: pool_init non-positive deltas`);
      const total = isqrtBig(da * db);
      if (total <= MIN_LIQ) throw new Error(`replay[${i}]: pool_init total ${total} <= MINIMUM_LIQUIDITY`);
      const founder = total - MIN_LIQ;
      if (op.shareAmount != null && BigInt(op.shareAmount) !== founder) {
        throw new Error(`replay[${i}]: pool_init founder-share mismatch (declared ${op.shareAmount}, formula ${founder})`);
      }
      reserveA = da; reserveB = db; totalShares = total; initialized = true;
      poolFeeBps = Number(op.feeBps || 0);
      kLast = reserveA * reserveB;
      continue;
    }

    if (!initialized) throw new Error(`replay[${i}]: ${op.kind} before pool_init`);

    if (op.kind === 'lp_add') {
      crystallize();
      const da = BigInt(op.deltaA), db = BigInt(op.deltaB);
      if (da <= 0n || db <= 0n) throw new Error(`replay[${i}]: lp_add non-positive deltas`);
      const shares = BigInt(lpAddShares(da, db, reserveA, reserveB, totalShares));
      if (shares <= 0n) throw new Error(`replay[${i}]: lp_add yields zero shares (dust add)`);
      if (op.shareAmount != null && BigInt(op.shareAmount) !== shares) {
        throw new Error(`replay[${i}]: lp_add share mismatch (declared ${op.shareAmount}, formula ${shares})`);
      }
      reserveA += da; reserveB += db; totalShares += shares;
      kLast = reserveA * reserveB;
      continue;
    }

    if (op.kind === 'swap_var') {
      const deltaIn = BigInt(op.deltaIn);
      if (deltaIn <= 0n) throw new Error(`replay[${i}]: swap non-positive deltaIn`);
      const dir = op.direction | 0;
      const r = curveDeltaOut(dir, reserveA, reserveB, deltaIn, poolFeeBps);
      const deltaOut = BigInt(r.deltaOut);
      const floor = (op.minOut != null && BigInt(op.minOut) > 1n) ? BigInt(op.minOut) : 1n;
      if (deltaOut < floor) {
        continue;
      }
      reserveA = BigInt(r.raPost);
      reserveB = BigInt(r.rbPost);
      continue;
    }

    if (op.kind === 'swap_route') {
      if (!Array.isArray(op.hops) || op.hops.length === 0) throw new Error(`replay[${i}]: swap_route with no hops for this pool`);
      const gDen = 10000n;
      const gNum = gDen - BigInt(poolFeeBps);
      for (let hI = 0; hI < op.hops.length; hI++) {
        const hop = op.hops[hI];
        if (Number(hop.feeBps) !== poolFeeBps) throw new Error(`replay[${i}]: swap_route hop fee_bps ${hop.feeBps} != pool ${poolFeeBps}`);
        if (BigInt(hop.rAPre) !== reserveA) throw new Error(`replay[${i}]: swap_route hop R_A_pre ${hop.rAPre} != replayed ${reserveA}`);
        if (BigInt(hop.rBPre) !== reserveB) throw new Error(`replay[${i}]: swap_route hop R_B_pre ${hop.rBPre} != replayed ${reserveB}`);
        const dir = hop.direction | 0;
        let rIn, rOut, dIn, dOut;
        if (dir === 0) { rIn = reserveA; rOut = reserveB; dIn = BigInt(hop.deltaAMag); dOut = BigInt(hop.deltaBMag); }
        else if (dir === 1) { rIn = reserveB; rOut = reserveA; dIn = BigInt(hop.deltaBMag); dOut = BigInt(hop.deltaAMag); }
        else throw new Error(`replay[${i}]: swap_route hop bad direction ${dir}`);
        if (dIn <= 0n || dOut <= 0n) throw new Error(`replay[${i}]: swap_route hop non-positive delta`);
        if (rOut < dOut) throw new Error(`replay[${i}]: swap_route hop R_out ${rOut} < delta_out ${dOut}`);
        if (dOut * (rIn * gDen + gNum * dIn) > rOut * gNum * dIn) {
          throw new Error(`replay[${i}]: swap_route hop violates CFMM curve floor`);
        }
        if (dir === 0) { reserveA = rIn + dIn; reserveB = rOut - dOut; }
        else { reserveB = rIn + dIn; reserveA = rOut - dOut; }
      }
      continue;
    }

    if (op.kind === 'lp_remove') {
      crystallize();
      const burned = BigInt(op.sharesBurned);
      if (burned <= 0n || burned > totalShares - MIN_LIQ) {
        throw new Error(`replay[${i}]: lp_remove invalid burn ${burned} (totalShares ${totalShares})`);
      }
      const { deltaA: outA, deltaB: outB } = removeOutputs(burned, reserveA, reserveB, totalShares);
      const oA = BigInt(outA), oB = BigInt(outB);
      if (op.outA != null && BigInt(op.outA) !== oA) throw new Error(`replay[${i}]: lp_remove outA mismatch (declared ${op.outA}, formula ${oA})`);
      if (op.outB != null && BigInt(op.outB) !== oB) throw new Error(`replay[${i}]: lp_remove outB mismatch (declared ${op.outB}, formula ${oB})`);
      reserveA -= oA; reserveB -= oB; totalShares -= burned;
      kLast = reserveA * reserveB;
      continue;
    }

    if (op.kind === 'fee_claim') {
      crystallize();
      continue;
    }

    if (op.kind === 'swap_batch') {
      throw new Error(`replay[${i}]: swap_batch requires Groth16 verification against reserves_before (not yet wired)`);
    }

    throw new Error(`replay[${i}]: unknown op kind '${op.kind}'`);
  }

  return { reserveA, reserveB, totalShares };
}

export function replayOpFromDecoded(opcode, dec, opcodes, poolIdHex) {
  if (!dec || !opcodes) return null;
  const { T_LP_ADD, T_SWAP_VAR, T_LP_REMOVE, T_PROTOCOL_FEE_CLAIM, T_SWAP_ROUTE } = opcodes;

  if (opcode === T_LP_ADD) {
    if (dec.variant !== 0 && dec.variant !== 1) return null;
    const sw = _pairSwapped(dec.assetA, dec.assetB);
    const deltaA = sw ? dec.deltaB : dec.deltaA, deltaB = sw ? dec.deltaA : dec.deltaB;
    if (dec.variant === 1) {
      return { kind: 'pool_init', deltaA, deltaB, shareAmount: dec.shareAmount, feeBps: dec.feeBps || 0 };
    }
    return { kind: 'lp_add', deltaA, deltaB, shareAmount: dec.shareAmount };
  }
  if (opcode === T_SWAP_VAR) {
    return { kind: 'swap_var', direction: dec.direction, deltaIn: dec.deltaIn, minOut: dec.minOut };
  }
  if (T_SWAP_ROUTE != null && opcode === T_SWAP_ROUTE) {
    if (!Array.isArray(dec.hops)) return null;
    const want = poolIdHex == null ? null : String(poolIdHex).toLowerCase();
    const mine = dec.hops
      .filter(hp => want == null || _toHex(hp.poolId) === want)
      .map(hp => ({
        direction: hp.direction,
        feeBps: Number(hp.feeBps),
        rAPre: hp.R_A_pre, rBPre: hp.R_B_pre,
        deltaAMag: hp.deltaANetMag, deltaBMag: hp.deltaBNetMag,
      }));
    if (mine.length === 0) return null;
    return { kind: 'swap_route', hops: mine };
  }
  if (opcode === T_LP_REMOVE) {
    const sw = _pairSwapped(dec.assetA, dec.assetB);
    return { kind: 'lp_remove', sharesBurned: dec.shareAmount, outA: sw ? dec.deltaB : dec.deltaA, outB: sw ? dec.deltaA : dec.deltaB };
  }
  if (opcode === T_PROTOCOL_FEE_CLAIM) {
    return { kind: 'fee_claim', claimAmount: dec.claimAmount };
  }
  return null;
}

export async function deriveAmmPoolState(poolIdHex, env) {
  const {
    discover, fetchTx, decodeEnvelope, decodeForOpcode, poolIdForOp, blockTxids,
    opcodes, deps, tipHeight, confirmations = 3,
  } = env || {};
  for (const [name, fn] of [['discover', discover], ['fetchTx', fetchTx], ['decodeEnvelope', decodeEnvelope], ['decodeForOpcode', decodeForOpcode], ['poolIdForOp', poolIdForOp]]) {
    if (typeof fn !== 'function') throw new Error(`deriveAmmPoolState: missing ${name}()`);
  }
  if (!Number.isInteger(tipHeight)) throw new Error('deriveAmmPoolState: integer tipHeight required (depth gate)');

  const list = await discover(poolIdHex);
  if (!Array.isArray(list)) throw new Error('deriveAmmPoolState: discover() did not return an array');

  const fetched = [];
  const seen = new Set();
  for (const item of list) {
    const txid = item && item.txid;
    if (typeof txid !== 'string') throw new Error('deriveAmmPoolState: op-list item missing txid');
    if (seen.has(txid)) continue;
    seen.add(txid);
    const tx = await fetchTx(txid);
    if (!tx) throw new Error(`deriveAmmPoolState: op ${txid} unfetchable (halt — set incomplete)`);
    if (!tx.status || tx.status.confirmed !== true) throw new Error(`deriveAmmPoolState: op ${txid} unconfirmed`);
    const h = Number(tx.status.block_height);
    if (!Number.isInteger(h)) throw new Error(`deriveAmmPoolState: op ${txid} has no block height`);
    if ((tipHeight - h + 1) < confirmations) {
      throw new Error(`deriveAmmPoolState: op ${txid} below confirmation depth ${confirmations}`);
    }
    fetched.push({ txid, tx, h, pos: Number(item.txIndex) });
  }
  const perHeight = new Map();
  for (const f of fetched) perHeight.set(f.h, (perHeight.get(f.h) || 0) + 1);
  if (typeof blockTxids === 'function') {
    const blockOrder = new Map();
    for (const f of fetched) {
      if (perHeight.get(f.h) < 2) continue;
      const hash = f.tx.status.block_hash;
      if (typeof hash !== 'string' || !hash) throw new Error(`deriveAmmPoolState: op ${f.txid} has no block hash`);
      if (!blockOrder.has(hash)) blockOrder.set(hash, await blockTxids(hash));
      const ids = blockOrder.get(hash);
      f.pos = Array.isArray(ids) ? ids.indexOf(f.txid) : -1;
      if (f.pos < 0) throw new Error(`deriveAmmPoolState: op ${f.txid} not found in block ${hash}`);
    }
  }
  for (const f of fetched) {
    if (perHeight.get(f.h) > 1 && !Number.isInteger(f.pos)) throw new Error(`deriveAmmPoolState: op ${f.txid} has no position in its block`);
  }
  fetched.sort((a, b) => (a.h - b.h) || ((a.pos || 0) - (b.pos || 0)));

  const ops = [];
  for (const { txid, tx } of fetched) {
    const wit = tx.vin && tx.vin[0] && tx.vin[0].witness;
    if (!Array.isArray(wit) || wit.length < 3) throw new Error(`deriveAmmPoolState: op ${txid} carries no envelope`);
    const decodedEnv = decodeEnvelope(wit[1]);
    if (!decodedEnv || decodedEnv.opcode == null) throw new Error(`deriveAmmPoolState: op ${txid} envelope decode failed`);
    const dec = decodeForOpcode(decodedEnv.opcode, decodedEnv.payload);
    if (!dec) throw new Error(`deriveAmmPoolState: op ${txid} payload decode failed`);
    const opPool = poolIdForOp(decodedEnv.opcode, dec);
    const opPools = Array.isArray(opPool) ? opPool.map(String) : [opPool];
    if (!opPools.includes(poolIdHex)) throw new Error(`deriveAmmPoolState: op ${txid} is for pool(s) ${opPools.join(',')}, not ${poolIdHex}`);
    const replayOp = replayOpFromDecoded(decodedEnv.opcode, dec, opcodes, poolIdHex);
    if (!replayOp) throw new Error(`deriveAmmPoolState: op ${txid} is not a pool op (opcode ${decodedEnv.opcode})`);
    ops.push(replayOp);
  }
  return replayAmmPoolState(ops, deps);
}

export function compareAmmReserves(derived, worker) {
  const d = { reserveA: BigInt(derived.reserveA), reserveB: BigInt(derived.reserveB), totalShares: BigInt(derived.totalShares) };
  const w = { reserveA: BigInt(worker.reserveA), reserveB: BigInt(worker.reserveB), totalShares: BigInt(worker.totalShares) };
  const diffs = [];
  if (d.reserveA !== w.reserveA) diffs.push(`reserveA: replay ${d.reserveA} != worker ${w.reserveA}`);
  if (d.reserveB !== w.reserveB) diffs.push(`reserveB: replay ${d.reserveB} != worker ${w.reserveB}`);
  if (d.totalShares !== w.totalShares) diffs.push(`totalShares: replay ${d.totalShares} != worker ${w.totalShares}`);
  return { match: diffs.length === 0, diffs, derived: d, worker: w };
}
