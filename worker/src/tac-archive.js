// Confirmed Tacit transactions kept as their exact bytes, by txid, so a page walking a note's history back to its etch reads that
// history from here in one answer instead of asking a public explorer for each transaction in it. The forward scan fills it from
// the blocks it reads, and an operator can import a list; a visitor never writes to it. A txid is the hash of a transaction's own
// bytes, so a reader checks every answer against the id it asked for, and what the page credits it still verifies itself.

export const ARCHIVE_MAX_ROOTS = 64;
export const ARCHIVE_MAX_TXS = 4000;
export const ARCHIVE_MAX_IMPORT = 500;
const READ_CONCURRENCY = 32;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const toHex = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; };
function fromHex(h) {
  const s = String(h).replace(/^0x/, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) return null;
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return b;
}

// A transaction's txid (display order, when `dsha256` is given), the txids its inputs spend, and its first input's witness items
// (hex), from its raw bytes; null for bytes that are not one whole transaction.
export function parseTx(d, dsha256 = null) {
  try {
    let p = 0;
    const vi = () => {
      const f = d[p++];
      if (f < 0xfd) return f;
      if (f === 0xfd) { const v = d[p] | (d[p + 1] << 8); p += 2; return v; }
      if (f === 0xfe) { const v = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) + d[p + 3] * 0x1000000; p += 4; return v; }
      let v = 0; for (let i = 0; i < 8; i++) v += d[p + i] * 2 ** (8 * i); p += 8; return v;
    };
    p = 4;
    const segwit = d[4] === 0 && d[5] === 1;
    if (segwit) p = 6;
    const nIn = vi();
    if (nIn < 1 || nIn > 10000) return null;
    const vins = [];
    for (let i = 0; i < nIn; i++) {
      vins.push(toHex(Uint8Array.from(d.subarray(p, p + 32)).reverse()));
      p += 36;
      const l = vi(); p += l + 4;
    }
    const nOut = vi();
    for (let i = 0; i < nOut; i++) { p += 8; const l = vi(); p += l; }
    const outEnd = p;
    let witness0 = null;
    if (segwit) {
      for (let i = 0; i < nIn; i++) {
        const n = vi(), items = [];
        for (let w = 0; w < n; w++) { const l = vi(); items.push(toHex(d.subarray(p, p + l))); p += l; }
        if (i === 0) witness0 = items;
      }
    }
    p += 4;
    if (p !== d.length) return null;
    let txid = null;
    if (dsha256) {
      const body = segwit ? concat(d.subarray(0, 4), d.subarray(6, outEnd), d.subarray(p - 4, p)) : d;
      txid = toHex(Uint8Array.from(dsha256(body)).reverse());
    }
    return { txid, vins, witness0 };
  } catch { return null; }
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

export function makeTacArchive({ kv, network, dsha256, isTacit }) {
  if (!kv) throw new Error('tac-archive: kv required');
  const key = (txid) => `tacarch:${network}:${String(txid).toLowerCase()}`;

  // Keeps one confirmed transaction at `height`; returns its txid, or null for bytes that are not a whole transaction carrying a
  // Tacit envelope (the archive holds only those).
  async function keep(bytes, height, blockHash = null) {
    const d = typeof bytes === 'string' ? fromHex(bytes) : bytes;
    if (!d || !Number.isInteger(height) || height <= 0) return null;
    const t = parseTx(d, dsha256);
    if (!t || !isTacit(t.witness0)) return null;
    const rec = { hex: toHex(d), h: height };
    if (typeof blockHash === 'string' && /^[0-9a-f]{64}$/i.test(blockHash)) rec.b = blockHash.toLowerCase();
    await kv.put(key(t.txid), JSON.stringify(rec));
    return t.txid;
  }

  // Every archived transaction reached from `roots` through their inputs, roots included: { txs: Map txid -> { hex, h, b? },
  // truncated } (truncated when the walk stopped at `cap`). Reads storage only, a level at a time.
  async function ancestry(roots, { cap = ARCHIVE_MAX_TXS } = {}) {
    const out = new Map(), seen = new Set();
    let frontier = [...new Set((roots || []).map((r) => String(r).toLowerCase()))], truncated = false;
    while (frontier.length && !truncated) {
      for (const id of frontier) seen.add(id);
      const got = [];
      for (let i = 0; i < frontier.length; i += READ_CONCURRENCY) {
        got.push(...await Promise.all(frontier.slice(i, i + READ_CONCURRENCY).map(async (id) => [id, await kv.get(key(id), 'json').catch(() => null)])));
      }
      const next = new Set();
      for (const [id, rec] of got) {
        if (!rec || typeof rec.hex !== 'string') continue;
        if (out.size >= cap) { truncated = true; break; }
        out.set(id, rec);
        const t = parseTx(fromHex(rec.hex));
        for (const v of (t && t.vins) || []) if (!seen.has(v)) next.add(v);
      }
      frontier = [...next];
    }
    return { txs: out, truncated };
  }

  return { key, keep, ancestry };
}
