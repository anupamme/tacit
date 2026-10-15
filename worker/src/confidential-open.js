// The open board's pure pieces: reading a proof's public values, and building the settle() call anyone can send.
//
// A job on the board is a proof waiting for a sender. ConfidentialPool.settle(publicValues, proof, memos) is
// permissionless and pays each fee leg the proof binds to msg.sender, so the proof, its public values and its memos are
// all a sender needs, and all of them go on chain with the settle anyway. Nothing here reads a witness.
//
// publicValues is abi.encode(PublicValues) of the struct in contracts/src/ConfidentialPool.sol: word 0 is the tuple's
// offset (0x20), then one head word per field in declaration order, so `fees` (an offset) is head word 8 and
// `deadline` (a uint64) head word 16, counted with the leading offset as word 0.

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
export const SETTLE_SELECTOR = '0x717fd7f2'; // settle(bytes,bytes,bytes[])
const WORD_FEES = 8, WORD_DEADLINE = 16;

const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
export const isHex = (h, minBytes = 0, maxBytes = Infinity) => typeof h === 'string' && HEX_RE.test(h) && (h.length - 2) / 2 >= minBytes && (h.length - 2) / 2 <= maxBytes;

function word(hex, i) {
  const w = hex.slice(i * 64, i * 64 + 64);
  if (w.length !== 64) throw new Error('public values too short');
  return BigInt('0x' + w);
}

// The settle deadline the proof commits to, in unix seconds (0 = none). Throws on bytes that are not a PublicValues.
export function pvDeadline(publicValues) {
  const h = strip(publicValues);
  if (word(h, 0) !== 32n) throw new Error('public values do not start with a tuple offset');
  const d = word(h, WORD_DEADLINE);
  if (d >= 1n << 64n) throw new Error('deadline out of range');
  return Number(d);
}

// The fee legs the proof binds (paid to whoever sends the settle): [{ assetId, value }], value in the pool's units.
export function pvFees(publicValues) {
  const h = strip(publicValues);
  if (word(h, 0) !== 32n) throw new Error('public values do not start with a tuple offset');
  const off = word(h, WORD_FEES);                                   // bytes from the tuple's start (word 1)
  if (off % 32n !== 0n) throw new Error('fees offset not word aligned');
  const at = 1 + Number(off / 32n);
  const n = Number(word(h, at));
  if (n > 64) throw new Error('too many fee legs');
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ assetId: '0x' + h.slice((at + 1 + 2 * i) * 64, (at + 2 + 2 * i) * 64), value: word(h, at + 2 + 2 * i).toString() });
  }
  return out;
}

// abi.encode for settle(bytes publicValues, bytes proof, bytes[] memos), with its selector.
export function settleCalldata({ publicValues, proof, memos = [] }) {
  const pad = (hex) => hex + '0'.repeat((64 - (hex.length % 64)) % 64);
  const num = (n) => BigInt(n).toString(16).padStart(64, '0');
  const bytes = (hex) => num(hex.length / 2) + pad(hex);
  const pv = strip(publicValues), pf = strip(proof), ms = memos.map(strip);
  const encPv = bytes(pv), encPf = bytes(pf);
  // bytes[]: length, then one offset per element (from the start of the offsets), then each element.
  const elems = ms.map(bytes);
  let offs = '', body = '', at = ms.length * 32;
  for (const e of elems) { offs += num(at); body += e; at += e.length / 2; }
  const encMemos = num(ms.length) + offs + body;
  const head = num(96) + num(96 + encPv.length / 2) + num(96 + encPv.length / 2 + encPf.length / 2);
  return SETTLE_SELECTOR + head + encPv + encPf + encMemos;
}

// True when a transaction's input carries these public values whole: a settle sent straight to the pool, or through
// a forwarder, a relayer contract or a smart account, all carry the bytes contiguously.
export function carriesPublicValues(input, publicValues) {
  const pv = strip(publicValues);
  return pv.length >= 64 && strip(input).includes(pv);
}

// A posted proof's shape, before anything reads the chain: hex everywhere and bounded sizes.
export function checkPostedShape({ publicValues, proof, memos }) {
  if (!isHex(publicValues, 64, 64 * 1024)) return 'publicValues must be 0x-hex of 64 bytes to 64 KB';
  if (!isHex(proof, 32, 4096)) return 'proof must be 0x-hex of 32 bytes to 4 KB';
  if (!Array.isArray(memos) || memos.length > 256 || !memos.every((m) => isHex(m, 0, 4096))) return 'memos must be a list of hex strings';
  try { pvDeadline(publicValues); pvFees(publicValues); } catch (e) { return `publicValues: ${e.message}`; }
  return null;
}
