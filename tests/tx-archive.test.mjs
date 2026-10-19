#!/usr/bin/env node
// The page's side of the Tacit transaction archive (dapp/tx-archive.js): a transaction built from archived bytes reads, on every
// field a history walk and its two-source cross-check compare, exactly as esplora serves it; bytes that do not hash to the txid are
// dropped; a refused answer rests the archive instead of being asked again; a browser can turn it off.
//   node tests/tx-archive.test.mjs
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import { txFromRaw, makeTxArchive } from '../dapp/tx-archive.js';

let n = 0;
const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
// The digest dapp/tacit.js compares between two sources before a purchase (_txFieldsOf), and the walk's own reads.
const fields = (t) => JSON.stringify({
  vin: (t.vin || []).map((i) => [String(i.txid).toLowerCase(), i.vout, (i.witness || []).map((w) => String(w).toLowerCase())]),
  vout: (t.vout || []).map((o) => [String(o.scriptpubkey).toLowerCase(), Number(o.value)]),
  height: t.status?.confirmed ? Number(t.status.block_height) : null,
});

// Four real TAC transactions (a BP+ transfer, a transfer, an atomic settlement and a bridge burn), each as esplora serves it and as
// its raw bytes.
const FIX = JSON.parse(readFileSync(new URL('./fixtures/esplora-tx-json-2026-10-19.json', import.meta.url), 'utf8'));
for (const [id, r] of Object.entries(FIX)) {
  const j = typeof r.json === 'string' ? JSON.parse(r.json) : r.json;
  const t = txFromRaw(r.hex, { txid: id, height: j.status.block_height, blockHash: j.status.block_hash, sha256 });
  ok(!!t && fields(t) === fields(j), `${r.kind} ${id.slice(0, 8)}: inputs, witnesses, outputs and height read as esplora's`);
  ok(t && t.vin.every((v, i) => v.sequence === j.vin[i].sequence && v.scriptsig === j.vin[i].scriptsig), `${id.slice(0, 8)}: and each input's sequence and script`);
  ok(t && t.vout.every((o, i) => o.scriptpubkey_type === j.vout[i].scriptpubkey_type) && t.version === j.version && t.locktime === j.locktime,
    `${id.slice(0, 8)}: and output types, version and locktime`);
  ok(t && t.status.block_hash === j.status.block_hash, `${id.slice(0, 8)}: and the block it is in`);
}
{
  const [id, r] = Object.entries(FIX)[0];
  const flip = r.hex.slice(0, 200) + (r.hex[200] === '0' ? '1' : '0') + r.hex.slice(201);
  ok(txFromRaw(flip, { txid: id, height: 970125, sha256 }) === null, 'bytes changed in an input or output no longer hash to the txid, and are dropped');
  ok(txFromRaw(r.hex, { txid: 'ab'.repeat(32), height: 970125, sha256 }) === null, 'and so are bytes offered under another txid');
  ok(txFromRaw(r.hex + '00', { txid: id, height: 970125, sha256 }) === null, 'or with bytes past the end');
}

// ── the client ──
{
  const ids = Object.keys(FIX), [a, b] = ids;
  const tamper = FIX[b].hex.slice(0, 120) + (FIX[b].hex[120] === 'f' ? 'e' : 'f') + FIX[b].hex.slice(121);
  let asked = 0, status = 200, t = 0;
  const fetchImpl = async (url, o) => {
    asked++;
    const body = JSON.parse(o.body);
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status, json: async () => ({ txs: { [a]: { hex: FIX[a].hex, h: 970125 }, [b]: { hex: tamper, h: 951880 } }, truncated: false, roots: body.roots }) };
  };
  const store = { v: null, getItem: () => store.v };
  const arch = makeTxArchive({ base: 'https://api.test', network: 'mainnet', sha256, fetchImpl, storage: store, now: () => t });
  await arch.prefetch([a, b]);
  ok(asked === 1 && arch.get(a) && !arch.get(b), 'one request for the history; the answer that checks is kept, the one that does not is dropped');
  ok(arch.get(a)._archived === true && arch.get(a).status.block_height === 970125, 'and what is kept says where it came from');
  const roots = Array.from({ length: 130 }, (_, i) => i.toString(16).padStart(64, '0'));
  asked = 0; await arch.prefetch(roots);
  ok(asked === 3, `130 roots are asked in batches of 64 (${asked} requests)`);
  status = 429; asked = 0;
  await arch.prefetch(['cd'.repeat(32)]); await arch.prefetch(['ce'.repeat(32)]);
  ok(asked === 1, 'a refused answer rests the archive: the next scan does not ask again');
  t += 11 * 60e3; status = 200; asked = 0;
  await arch.prefetch(['cf'.repeat(32)]);
  ok(asked === 1, 'and ten minutes on it is asked again');
  store.v = 'off'; asked = 0;
  await arch.prefetch(['d0'.repeat(32)]);
  ok(asked === 0, "a browser with 'tacit-tx-archive' set to off never asks it");
}
console.log(`${n} tx-archive checks passed${process.exitCode ? ' (with failures above)' : ''}`);
