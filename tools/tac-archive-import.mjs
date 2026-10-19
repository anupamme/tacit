#!/usr/bin/env node
// Imports the TAC history a crawl holds (tools/tac-history-index.mjs: its index for the txids and heights, its disk cache and the
// seed txmap for the bytes) into the API's Tacit transaction archive, 400 transactions a request. Nothing is read from an explorer:
// every byte comes from disk, and the API checks each transaction's id and envelope itself before keeping it. Needs the operator
// token in TACIT_BOX_TOKEN (not with --dry, which only counts what it would send).
//
//   TACIT_BOX_TOKEN=… node tools/tac-archive-import.mjs --index tac-index.json [--api https://api.tacit.finance] [--network mainnet]
//                                                        [--cache ~/.cache/tacit-tac-index] [--seed txmap.json] [--dry]
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const INDEX = arg('--index', 'tac-index.json');
const API = arg('--api', 'https://api.tacit.finance');
const NETWORK = arg('--network', 'mainnet');
const CACHE = arg('--cache', join(homedir(), '.cache', 'tacit-tac-index'));
const SEED = arg('--seed', join(homedir(), 'tacit-critical-backup', 'seed-rebuild', 'txmap.json'));
const DRY = process.argv.includes('--dry');
const BATCH = 400;
const TOKEN = process.env.TACIT_BOX_TOKEN || '';
if (!DRY && TOKEN.length < 16) { console.error('set TACIT_BOX_TOKEN to the operator token (or pass --dry)'); process.exit(2); }

const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
const seed = existsSync(SEED) ? JSON.parse(readFileSync(SEED, 'utf8')) : {};
const hexOf = (txid) => {
  if (seed[txid] && seed[txid].raw) return String(seed[txid].raw).replace(/^0x/, '');
  const f = join(CACHE, createHash('sha256').update(`/tx/${txid}/hex`).digest('hex').slice(0, 32));
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
};
// What carries an envelope: the etch, the transfers and burns, and envelopes the crawl did not classify (the API decides those).
const list = [], missing = [];
for (const [txid, t] of Object.entries(idx.transfers || {})) {
  if (t.kind === 'plain' || t.kind === 'other-asset' || !Number.isInteger(t.h)) continue;
  const hex = hexOf(txid);
  if (hex) list.push({ txid, hex, h: t.h }); else missing.push(txid);
}
list.sort((a, b) => a.h - b.h);
console.log(`${list.length} transactions to send (${missing.length} without bytes on disk), ${Math.ceil(list.length / BATCH)} requests`);
if (DRY) process.exit(0);

let kept = 0, refused = 0;
for (let i = 0; i < list.length; i += BATCH) {
  const part = list.slice(i, i + BATCH);
  const res = await fetch(`${API}/chain/tac/import?network=${encodeURIComponent(NETWORK)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ txs: part.map(({ hex, h }) => ({ hex, h })) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`request ${i / BATCH + 1}: ${res.status} ${JSON.stringify(body)}`); process.exit(1); }
  kept += body.kept || 0; refused += (body.refused || []).length;
  for (const j of body.refused || []) console.log(`  refused ${part[j].txid} (height ${part[j].h})`);
  console.log(`… ${Math.min(i + BATCH, list.length)} / ${list.length} sent, ${kept} kept`);
}
console.log(`done: ${kept} kept, ${refused} refused`);
