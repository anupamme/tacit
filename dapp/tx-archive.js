// A note's history read in one answer from the API's archive of confirmed Tacit transactions (worker/src/tac-archive.js), so a
// browser walking a deep history for the first time does not ask a public explorer for every transaction in it. Each transaction
// is checked here against the txid its bytes hash to before the walk sees it, and the walk verifies what it credits exactly as
// before. What the archive lacks, and every failure, goes to the explorers as it always did. A browser turns it off with
// localStorage 'tacit-tx-archive' = 'off'.

const MAX_ROOTS = 64;
const REST_MS = 10 * 60e3;
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const toHex = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; };
function fromHex(h) {
  const s = String(h || '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) return null;
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return b;
}
const spkType = (s) => (/^0014[0-9a-f]{40}$/.test(s) ? 'v0_p2wpkh' : /^0020[0-9a-f]{64}$/.test(s) ? 'v0_p2wsh' : /^5120[0-9a-f]{64}$/.test(s) ? 'v1_p2tr'
  : /^76a914[0-9a-f]{40}88ac$/.test(s) ? 'p2pkh' : /^a914[0-9a-f]{40}87$/.test(s) ? 'p2sh' : /^6a/.test(s) ? 'op_return' : 'unknown');

// A confirmed transaction in the shape esplora serves (the fields a history walk reads: each input's prevout txid and vout and its
// witness, each output's script and value, the block it is in), from its raw bytes, or null when the bytes are not one whole
// transaction or do not hash to `txid`. Inputs carry no `prevout`: the archive holds Tacit transactions, whose first input is a
// reveal, and a walk reads a prevout's type only for one without an envelope.
export function txFromRaw(hex, { txid, height, blockHash = null, sha256 }) {
  const d = fromHex(hex);
  if (!d || d.length < 10 || !Number.isInteger(height) || height <= 0) return null;
  try {
    let p = 0;
    const vi = () => {
      const f = d[p++];
      if (f < 0xfd) return f;
      if (f === 0xfd) { const v = d[p] | (d[p + 1] << 8); p += 2; return v; }
      if (f === 0xfe) { const v = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) + d[p + 3] * 0x1000000; p += 4; return v; }
      let v = 0; for (let i = 0; i < 8; i++) v += d[p + i] * 2 ** (8 * i); p += 8; return v;
    };
    const u32 = () => { const v = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) + d[p + 3] * 0x1000000; p += 4; return v; };
    const version = u32();
    const segwit = d[4] === 0 && d[5] === 1;
    if (segwit) p = 6;
    const nIn = vi();
    if (nIn < 1) return null;
    const vin = [];
    for (let i = 0; i < nIn; i++) {
      const prev = toHex(Uint8Array.from(d.subarray(p, p + 32)).reverse()); p += 32;
      const vout = u32();
      const l = vi(), scriptsig = toHex(d.subarray(p, p + l)); p += l;
      vin.push({ txid: prev, vout, prevout: null, scriptsig, sequence: u32(), is_coinbase: false });
    }
    const nOut = vi(), outs = [];
    for (let i = 0; i < nOut; i++) {
      let value = 0; for (let k = 0; k < 8; k++) value += d[p + k] * 2 ** (8 * k); p += 8;
      const l = vi(), scriptpubkey = toHex(d.subarray(p, p + l)); p += l;
      outs.push({ scriptpubkey, scriptpubkey_type: spkType(scriptpubkey), value });
    }
    const outEnd = p;
    if (segwit) {
      for (let i = 0; i < nIn; i++) {
        const n = vi(), items = [];
        for (let w = 0; w < n; w++) { const l = vi(); items.push(toHex(d.subarray(p, p + l))); p += l; }
        if (items.length) vin[i].witness = items;
      }
    }
    const locktime = u32();
    if (p !== d.length) return null;
    const body = segwit ? new Uint8Array([...d.subarray(0, 4), ...d.subarray(6, outEnd), ...d.subarray(p - 4, p)]) : d;
    const id = toHex(Uint8Array.from(sha256(sha256(body))).reverse());
    if (id !== String(txid).toLowerCase()) return null;
    const status = { confirmed: true, block_height: height };
    if (typeof blockHash === 'string' && /^[0-9a-f]{64}$/.test(blockHash)) status.block_hash = blockHash;
    return { txid: id, version, locktime, vin, vout: outs, status, _archived: true };
  } catch { return null; }
}

export function makeTxArchive({ base, network, sha256, fetchImpl = null, storage = null, now = () => Date.now() }) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const held = new Map();
  let restUntil = 0;
  const off = () => { try { return (storage || globalThis.localStorage)?.getItem('tacit-tx-archive') === 'off'; } catch { return false; } };

  // Reads the archived history of every root at once (batches of 64) into memory; returns how many transactions it now holds.
  // An answer that fails or is refused rests the archive for ten minutes, so a page falls back without asking again and again.
  // `depth` 0 reads the roots' own transactions only (notes already known valid need no history).
  async function prefetch(roots, { depth = null } = {}) {
    if (!f || !base || off() || now() < restUntil) return 0;
    const want = [...new Set((roots || []).map((r) => String(r).toLowerCase()).filter((r) => /^[0-9a-f]{64}$/.test(r) && !held.has(r)))];
    for (let i = 0; i < want.length; i += MAX_ROOTS) {
      let body;
      try {
        const res = await f(`${base}/chain/tac/ancestry?network=${encodeURIComponent(network)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roots: want.slice(i, i + MAX_ROOTS), ...(Number.isInteger(depth) ? { depth } : {}) }),
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(30e3) : undefined,
        });
        if (!res.ok) { restUntil = now() + REST_MS; break; }
        body = await res.json();
      } catch { restUntil = now() + REST_MS; break; }
      for (const [id, rec] of Object.entries((body && body.txs) || {})) {
        if (held.has(id) || !rec) continue;
        const tx = txFromRaw(rec.hex, { txid: id, height: Number(rec.h), blockHash: rec.b, sha256 });
        if (tx) held.set(id, tx);
      }
    }
    return held.size;
  }

  return { prefetch, get: (txid) => held.get(String(txid).toLowerCase()) || null, size: () => held.size };
}
