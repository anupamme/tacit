
import { makeConfidentialPool } from './confidential-pool.js';
import { foldSwapBatch } from './confidential-swapbatch.js';
import { txOutputScript } from './burn-deposit-bitcoin.js';

const ZERO_OWNER = '0x' + '00'.repeat(32);
const reverseHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join('');

export function makeScanReflectionIndexer({ secp, keccak256, sha256, ownerTag, burnDepositKit, swapBatchVk } = {}) {
  const pool = makeConfidentialPool({ secp, keccak256, sha256 });
  const OWNER = ownerTag || ZERO_OWNER;
  let state = pool.makeScanReflectionState();
  let coords = new Map();

  const internal = (displayTxid) => '0x' + reverseHex(displayTxid);
  const withHex = (raw) => (raw.startsWith('0x') ? raw : '0x' + raw);
  const hexToBytes = (h) => { const s = String(h).replace(/^0x/, ''); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return out; };
  const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const dsha = (b) => sha256(sha256(b));

  let batchPrevHash = null;

  function trimProvHeaders(provHeaders) {
    if (!batchPrevHash || !Array.isArray(provHeaders) || !provHeaders.length) return provHeaders || [];
    if (!provHeaders.every((h) => typeof h === 'string' && /^(0x)?[0-9a-fA-F]{160}$/.test(h))) return [];
    for (let i = provHeaders.length - 1; i >= 0; i--) {
      if (bytesToHex(dsha(hexToBytes(withHex(provHeaders[i])))) === batchPrevHash) {
        return i === provHeaders.length - 1 ? provHeaders : provHeaders.slice(0, i + 1);
      }
    }
    return provHeaders;
  }

  function blockWitnessCtx(blockTxs) {
    return {
      blockTxids: blockTxs.map((t) => hexToBytes(internal(t.txidDisplay))),
      blockWtxids: blockTxs.map((t) => dsha(hexToBytes(withHex(t.rawHex)))),
      coinbase: withHex(blockTxs[0].rawHex),
    };
  }

  function buildBurnDepositCtx(bundle, burn) {
    if (!burnDepositKit) throw new Error('scan indexer: burn-deposit tx present but no burnDepositKit injected');
    const { assembler } = burnDepositKit;
    const Z = ZERO_OWNER;
    const hex32 = (h) => (typeof h === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(h) ? withHex(h).toLowerCase() : Z);
    const provHeaders = trimProvHeaders(bundle.provHeaders);
    let stat = null;
    let blob = '0x';
    try {
      stat = assembler.buildBurnDepositStatic({
        etch: bundle.etch, provHeaders, cxfers: bundle.cxfers || [], cmints: bundle.cmints || [],
        poolMemberships: bundle.poolMemberships || [],
      });
      blob = bytesToHex(assembler.serializeProvenanceBlob(stat));
    } catch { stat = null; blob = '0x'; }
    const vin0 = (burn.vins && burn.vins[0]) || { prevTxid: Z, vout: 0 };
    const verdict = (stat && !bundle.unbundled && burnDepositKit.admitBurnDeposit)
      ? burnDepositKit.admitBurnDeposit({
        burnTxHex: withHex(burn.rawHex), envAsset: burn.env.assetId, envNu: burn.env.nullifier, blobHex: blob, provHeaders,
        burnedCx: hex32(bundle.burned && bundle.burned.cx), burnedCy: hex32(bundle.burned && bundle.burned.cy), batchPrevHash,
      })
      : { admitted: false, burnedTxid: vin0.prevTxid, burnedVout: vin0.vout, burnedNoteLeaf: null };
    const valid = !!verdict.admitted;
    const bw = bundle.burnTxWitness ? assembler.witnessPath(bundle.burnTxWitness, 'burn') : { wtxidSiblings: [], coinbaseTxidSiblings: [] };
    return {
      valid,
      reason: verdict.reason,
      asset: hex32(burn.env.assetId),
      nu: hex32(burn.env.nullifier),
      dest: hex32(burn.env.dest),
      target: hex32(burn.env.target),
      burnedTxid: verdict.burnedTxid || vin0.prevTxid,
      burnedVout: verdict.burnedTxid ? verdict.burnedVout : vin0.vout,
      burnedCx: valid ? hex32(bundle.burned.cx) : Z,
      burnedCy: valid ? hex32(bundle.burned.cy) : Z,
      burnedNoteLeaf: valid ? verdict.burnedNoteLeaf : Z,
      witness: {
        ...(stat || {}),
        provHeaders: valid ? provHeaders : [],
        blob: valid ? blob : '0x',
        burnWtxidSiblings: bw.wtxidSiblings,
        burnCbTxidSiblings: bw.coinbaseTxidSiblings,
      },
    };
  }

  function txSpec(tx, burnDeposits, blockCtx, txIndex) {
    const vins = (tx.vins || []).map((vi) => ({ prevTxid: internal(vi.prevTxidDisplay), vout: vi.vout }));
    const txid = internal(tx.txidDisplay);
    let env = null;
    if (tx.decode && tx.decode.type === 'cxfer') {
      try {
        env = {
          type: 'cxfer',
          opcode: tx.decode.opcode,
          assetInputCount: tx.decode.assetInputCount == null ? null : tx.decode.assetInputCount,
          assetId: tx.decode.assetId,
          kernelSig: tx.decode.kernelSig,
          rangeProof: tx.decode.rangeProof,
          outputs: tx.decode.commitments.map((comm, j) => {
            const { cx, cy } = pool.decompressCommitment(comm);
            const vout = (tx.decode.vouts && tx.decode.vouts[j] != null) ? tx.decode.vouts[j] : (j + (tx.decode.voutBase || 0));
            const authKey = pool.p2trXonly(txOutputScript(tx.rawHex, vout)) || ZERO_OWNER;
            return { cx, cy, compressed: comm, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.btcNoteLeaf(tx.decode.assetId, cx, cy, authKey), vout };
          }),
        };
      } catch (e) {
        console.log(`[reflection] cxfer envelope for ${tx.txidDisplay} has an unusable commitment, treating as unrecognized traffic: ${String(e && e.message || e).slice(0, 200)}`);
        env = null;
      }
    } else if (tx.decode && tx.decode.type === 'cxfer_bound') {
      try {
        env = {
          type: 'cxfer_bound',
          opcode: tx.decode.opcode,
          target: tx.decode.target,
          assetId: tx.decode.assetId,
          kernelSig: tx.decode.kernelSig,
          rangeProof: tx.decode.rangeProof,
          outputs: tx.decode.commitments.map((comm, j) => {
            const { cx, cy } = pool.decompressCommitment(comm);
            const vout = (tx.decode.vouts && tx.decode.vouts[j] != null) ? tx.decode.vouts[j] : (j + (tx.decode.voutBase || 0));
            const authKey = pool.p2trXonly(txOutputScript(tx.rawHex, vout)) || ZERO_OWNER;
            return { cx, cy, compressed: comm, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.btcNoteLeafBound(tx.decode.assetId, cx, cy, authKey, tx.decode.target), vout };
          }),
        };
      } catch (e) {
        console.log(`[reflection] cxfer_bound envelope for ${tx.txidDisplay} has an unusable commitment, treating as unrecognized traffic: ${String(e && e.message || e).slice(0, 200)}`);
        env = null;
      }
    } else if (tx.decode && tx.decode.type === 'burn') {
      env = { type: 'burn', assetId: tx.decode.assetId || null, nullifier: tx.decode.nullifier || null, dest: tx.decode.dest, target: tx.decode.target || null };
      const bundle = burnDeposits && burnDeposits.get(tx.txidDisplay);
      const burnTxWitness = blockCtx ? { blockTxids: blockCtx.blockTxids, blockWtxids: blockCtx.blockWtxids, coinbase: blockCtx.coinbase, tx: withHex(tx.rawHex), index: txIndex } : null;
      const burnFacts = { rawHex: tx.rawHex, env, vins };
      if (bundle) {
        env.burnDeposit = buildBurnDepositCtx({ ...bundle, burnTxWitness: bundle.burnTxWitness || burnTxWitness }, burnFacts);
      } else if (burnTxWitness) {
        env.burnDeposit = buildBurnDepositCtx({
          assetId: env.assetId, etch: null, cmints: [], cxfers: [], poolMemberships: [],
          burned: { cx: ZERO_OWNER, cy: ZERO_OWNER }, burnTxWitness, unbundled: true,
        }, burnFacts);
        env.burnDepositUnbundled = true;
      }
    } else if (tx.decode && (tx.decode.type === 'mint' || tx.decode.type === 'cmint')) {
      env = { type: 'mint', assetId: tx.decode.assetId };
    } else if (tx.decode && ['swap_var', 'swap_route', 'harvest', 'farm_refund', 'protocol_fee_claim', 'farm_init', 'swap_batch', 'lp_add', 'lp_remove', 'lp_bond', 'lp_unbond', 'cbtc_lock', 'cbtc_redeem', 'crossout_mint', 'eth_call'].includes(tx.decode.type)) {
      env = tx.decode;
    } else if (tx.decode && tx.decode.type === 'unsupported') {
      env = { type: 'unsupported', opcode: tx.decode.opcode };
    }
    if (tx.decode && env == null) env = { type: 'unsupported', opcode: tx.decode.opcode };
    return { txData: withHex(tx.rawHex), txid, txidDisplay: tx.txidDisplay, vins, env };
  }

  async function assembleBlocks(input, { headers, anchorHeight, burnDeposits, ethBundle, consumedSources, chainBinding } = {}) {
    const streaming = input && typeof input.getRawBlock === 'function';
    const blockCount = streaming ? input.blockCount : ((input && input.length) || 0);
    const getRawBlock = streaming ? input.getRawBlock : ((i) => input[i]);
    batchPrevHash = (headers && headers.length) ? bytesToHex(hexToBytes(withHex(headers[0])).slice(4, 36)) : null;
    const depositCompletions = [];
    if (burnDepositKit && burnDeposits) {
      for (const rec of state.pendingDepositRecords()) {
        if (rec.completed || !rec.burnTxid || !rec.burnTxData) continue;
        const bundle = burnDeposits.get(rec.burnTxidDisplay || reverseHex(rec.burnTxid));
        if (!bundle) continue;
        try {
          const ctx = buildBurnDepositCtx({ ...bundle, burnTxWitness: null }, {
            rawHex: rec.burnTxData,
            env: { assetId: rec.asset, nullifier: rec.nu, dest: rec.dest, target: rec.target },
            vins: [{ prevTxid: rec.burnedTxid, vout: rec.burnedVout }],
          });
          if (ctx.valid) depositCompletions.push({ ...ctx, burnedTxid: rec.burnedTxid, burnedVout: rec.burnedVout });
        } catch { }
      }
    }
    const batch = {
      depositCompletions,
      chainBinding: chainBinding || null,
      anchorHeight, headers, blockCount,
      getBlock: async (i) => {
        await new Promise((r) => setTimeout(r, 0));
        const b = await getRawBlock(i);
        const blockTxs = b.txs || [];
        const bwc = blockTxs.length ? blockWitnessCtx(blockTxs) : null;
        return { txs: blockTxs.map((tx, ti) => txSpec(tx, burnDeposits, bwc, ti)) };
      },
    };
    if (swapBatchVk) batch.swapBatchFold = (env, txid, spends, opts = {}) => foldSwapBatch(pool, state, env, txid, spends, { vk: swapBatchVk, ...opts });
    if (ethBundle) {
      const { modeB } = pool.buildModeBBatch(ethBundle, [], consumedSources || [], Number(state.getConsumedCount()));
      batch.modeB = modeB;
    }
    return pool.assembleReflectionScanInput(state, batch, coords);
  }

  function snapshot() {
    return {
      noteLeaves: state._acc.notes.leaves.map((l) => '0x' + Array.from(l, (x) => x.toString(16).padStart(2, '0')).join('')),
      spentLinks: state._acc.spent.links(),
      cbtcLockTriples: state.cbtcLocks.triples(),
      cbtcBackingSats: String(state.getCbtcBackingSats()),
      liveTriples: state._acc.live.triples(),
      burnNodes: state._acc.burns.nodes(),
      pools: state.pools.list(),
      height: state.counts().height,
      coords: [...coords.entries()],
      consumedCount: String(state.getConsumedCount()),
      ethReflDigest: state.getEthReflDigest(),
      consumedCrossoutLinks: state.consumedCrossoutLinks(),
      honoredMsgLinks: state.honoredMsgLinks(),
      foldedCrossoutCount: String(state.getFoldedCrossoutCount()),
      farmRewards: state.farmRewards.list(),
      farmEntries: state.farmEntries.list(),
      consumedOutpointsLinks: state.consumedOutpointsLinks(),
      ethSyncCommittee: state.getEthSyncCommittee(),
      pendingDepositNodes: state.pendingDepositNodes(),
      pendingDepositRecords: state.pendingDepositRecords(),
    };
  }
  function load(snap) {
    state = pool.makeScanReflectionState();
    coords = new Map();
    if (!snap) return;
    for (const leaf of (snap.noteLeaves || [])) state._acc.notes.insert(leaf);
    if ((snap.spentLinks || []).length) state._acc.spent.setLinks(snap.spentLinks);
    if ((snap.burnNodes || []).length) state._acc.burns.setNodes(snap.burnNodes);
    state._acc.live.load(snap.liveTriples || []);
    state.cbtcLocks.load(snap.cbtcLockTriples || []);
    if (snap.cbtcBackingSats) state.setCbtcBackingSats(snap.cbtcBackingSats);
    state.pools.load(snap.pools || []);
    if (snap.height) state.setHeight(snap.height);
    for (const [k, v] of (snap.coords || [])) coords.set(k, v);
    if (snap.consumedCount != null) state.setConsumedCount(snap.consumedCount);
    if (snap.ethReflDigest) state.setEthReflDigest(snap.ethReflDigest);
    if ((snap.consumedCrossoutLinks || []).length) state.setConsumedCrossoutLinks(snap.consumedCrossoutLinks);
    if ((snap.honoredMsgLinks || []).length) state.setHonoredMsgLinks(snap.honoredMsgLinks);
    if (snap.foldedCrossoutCount != null) state.setFoldedCrossoutCount(snap.foldedCrossoutCount);
    if ((snap.farmRewards || []).length) state.farmRewards.load(snap.farmRewards);
    if ((snap.farmEntries || []).length) state.farmEntries.load(snap.farmEntries);
    if ((snap.consumedOutpointsLinks || []).length) state.setConsumedOutpointsLinks(snap.consumedOutpointsLinks);
    if (snap.ethSyncCommittee) state.setEthSyncCommittee(snap.ethSyncCommittee);
    if ((snap.pendingDepositNodes || []).length) state.setPendingDepositNodes(snap.pendingDepositNodes);
    if ((snap.pendingDepositRecords || []).length) state.setPendingDepositRecords(snap.pendingDepositRecords);
  }

  return {
    pool, assembleBlocks, snapshot, load,
    state: () => state,
    pendingBurnTxids: () => state.pendingDepositRecords().filter((r) => !r.completed && r.burnTxid).map((r) => r.burnTxidDisplay || reverseHex(r.burnTxid)),
    coords: () => coords,
    digest: () => state.digest(),
    digestParts: () => state.digestParts(),
    roots: () => state.commit(),
    liveCount: () => state.counts().live,
  };
}
