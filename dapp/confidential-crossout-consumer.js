
export const CONFIDENTIAL_POOL_DEPLOYMENTS = {
  signet:  { pool: '0x000000003eD19c48531bd397F66800004F8A18c2', deployBlock: 11175726 },
  mainnet: { pool: '0x000000000Ed1eabD231Be41d93b719056F7febFC', deployBlock: 25998736, headerRelay: '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0',
    crossOutSlots: { commitment: 77, count: 171 }, crossOutPoolsRetired: ['0x0000000098A73197B3255aD9db1ed8544410f5Ba'] },
};

export function makeCrossoutConsumer({ ethGetLogs, kvGet, kvPut, evmLog, confirmations = 36, maxRange = 5000, poolState = null }) {
  const DEST_BITCOIN = 1;
  const TOPIC0 = evmLog.TOPIC0.CrossOutRecorded;
  const lc = (h) => String(h).toLowerCase();
  const recKey = (net, claimId) => `crossout-recorded:${net}:${lc(claimId)}`;
  const cursorKey = (net, pool) => `crossout-scan-cursor:${net}:${lc(pool)}`;

  async function scan({ network, pool, tipHeight, fromBlock }) {
    const base = { network, pool: lc(pool), fromBlock };
    const safeTip = tipHeight - confirmations;
    if (!(safeTip >= fromBlock)) {
      return { ...base, toBlock: fromBlock - 1, scanned: 0, recorded: 0, advancedCursorTo: null, reason: 'nothing-final-yet' };
    }
    const toBlock = Math.min(safeTip, fromBlock + maxRange - 1);
    const logs = await ethGetLogs(network, pool, fromBlock, toBlock, TOPIC0);
    if (logs == null) {
      return { ...base, toBlock, scanned: 0, recorded: 0, advancedCursorTo: null, rpcFailed: true };
    }
    const events = [];
    for (const log of logs) {
      let ev;
      try { ev = evmLog.decodeLog(log); } catch { continue; }
      if (!ev || ev.type !== 'CrossOutRecorded' || ev.destChain !== DEST_BITCOIN) continue;
      events.push({ ev, log });
    }
    if (poolState) {
      const unconfirmed = (reason) => ({ ...base, toBlock, scanned: logs.length, recorded: 0, advancedCursorTo: null, unconfirmed: reason });
      const [before, after] = await Promise.all([poolState.countAt(network, pool, fromBlock - 1), poolState.countAt(network, pool, toBlock)]);
      if (before != null && after != null && after - before !== events.length) return unconfirmed('log-count-mismatch');
      for (const { ev } of events) {
        const onChain = await poolState.commitmentOf(network, pool, ev.claimId);
        if (onChain == null) return unconfirmed('commitment-unreadable');
        if (lc(onChain) !== lc(ev.destCommitment)) return unconfirmed('commitment-mismatch');
      }
    }
    let recorded = 0;
    for (const { ev, log } of events) {
      const key = recKey(network, ev.claimId);
      if (await kvGet(key)) continue;
      await kvPut(key, JSON.stringify({
        claimId: lc(ev.claimId), destCommitment: ev.destCommitment, nullifier: ev.nullifier,
        assetId: ev.assetId, blockNumber: Number(log.blockNumber ?? 0), pool: lc(pool),
        network, status: 'recorded',
      }));
      recorded++;
    }
    await kvPut(cursorKey(network, pool), String(toBlock + 1));
    return { ...base, toBlock, scanned: logs.length, recorded, advancedCursorTo: toBlock + 1 };
  }

  async function nextFromBlock(network, pool, deployBlock) {
    const c = await kvGet(cursorKey(network, pool));
    return c != null ? Number(c) : Number(deployBlock || 0);
  }

  async function getRecorded(network, claimId) {
    const v = await kvGet(recKey(network, claimId));
    return v ? JSON.parse(v) : null;
  }

  async function bindBitcoinOutput({ network, claimId, outputLeaf }) {
    const rec = await getRecorded(network, claimId);
    if (!rec) return { bound: false, reason: 'no-recorded-crossout' };
    if (lc(rec.destCommitment) !== lc(outputLeaf)) return { bound: false, rejected: 'dest-mismatch' };
    if (rec.status === 'consumed') return { bound: false, rejected: 'already-consumed' };
    rec.status = 'consumed';
    await kvPut(recKey(network, claimId), JSON.stringify(rec));
    return { bound: true, claimId: lc(claimId), record: rec };
  }

  return { scan, nextFromBlock, getRecorded, bindBitcoinOutput, recKey, cursorKey, DEST_BITCOIN, TOPIC0 };
}

export const T_CROSSOUT_MINT = 0x65;

const _fromHex = (h) => {
  h = String(h).replace(/^0x/, '');
  if (h.length % 2) h = '0' + h;
  const u = new Uint8Array(h.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
  return u;
};
const _toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const _field32 = (h) => {
  const raw = _fromHex(h);
  if (raw.length > 32) throw new Error('crossout-mint: field over 32 bytes');
  const out = new Uint8Array(32);
  out.set(raw, 32 - raw.length);
  return out;
};

export function encodeCrossoutMint({ assetId, claimId, cx, cy, owner }) {
  const out = new Uint8Array(161);
  out[0] = T_CROSSOUT_MINT;
  out.set(_field32(assetId), 1);
  out.set(_field32(claimId), 33);
  out.set(_field32(cx), 65);
  out.set(_field32(cy), 97);
  out.set(_field32(owner == null ? '0x0' : owner), 129);
  return out;
}

export function decodeCrossoutMint(payload) {
  const u = payload instanceof Uint8Array ? payload : _fromHex(payload);
  if (!u || u.length !== 161 || u[0] !== T_CROSSOUT_MINT) return null;
  const at = (i) => _toHex(u.subarray(i, i + 32));
  return { assetId: at(1), claimId: at(33), cx: at(65), cy: at(97), owner: at(129) };
}

export function makePoolStateReader({ fetchFn, rpcsForNetwork, keccak256, slots, timeoutMs = 8000 }) {
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
  const mapSlot = (key, slot) => _toHex(keccak256(bytes(String(key).replace(/^0x/, '').padStart(64, '0') + word(slot))));
  async function storageAt(network, address, slot, block) {
    const rpcs = rpcsForNetwork(network) || [];
    const quorum = Math.min(2, rpcs.length);
    if (!quorum) return null;
    const tag = typeof block === 'number' ? '0x' + block.toString(16) : block;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getStorageAt', params: [address, slot, tag] });
    const seen = new Map();
    for (const rpc of rpcs) {
      try {
        const r = await fetchFn(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) continue;
        const j = await r.json();
        if (!j || typeof j.result !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(j.result)) continue;
        const v = '0x' + j.result.slice(2).toLowerCase().padStart(64, '0');
        const n = (seen.get(v) || 0) + 1;
        seen.set(v, n);
        if (n >= quorum) return v;
      } catch {}
    }
    return null;
  }
  return {
    commitmentOf: (network, pool, claimId, block = 'latest') => storageAt(network, pool, mapSlot(claimId, slots.commitment), block),
    countAt: async (network, pool, block) => {
      const v = await storageAt(network, pool, '0x' + word(slots.count), block);
      return v == null ? null : Number(BigInt(v));
    },
  };
}

export function makeEthGetLogs({ fetchFn, rpcsForNetwork, timeoutMs = 8000 }) {
  const hexBlock = (n) => '0x' + Number(n).toString(16);
  return async function ethGetLogs(network, address, fromBlock, toBlock, topic0) {
    const params = [{ address, fromBlock: hexBlock(fromBlock), toBlock: hexBlock(toBlock), topics: [topic0] }];
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params });
    for (const rpc of (rpcsForNetwork(network) || [])) {
      try {
        const r = await fetchFn(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && Array.isArray(j.result)) {
          return j.result.map((l) => ({ topics: l.topics, data: l.data, blockNumber: Number(l.blockNumber) }));
        }
      } catch {}
    }
    return null;
  };
}
