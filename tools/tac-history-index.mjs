#!/usr/bin/env node
// TAC transfer history index. Walks every TAC note forward from the etch's supply note through Bitcoin's own spends,
// records each transfer (its TAC inputs and outputs) and each note, and reports for every unspent note whether the
// reflection tracks it and, when it does not, how many transfers its history holds (what a two-step bridge proves,
// at most 255 of them since the move to the burn address adds one) and whether that history reaches the etch through
// transfers alone (a note with a cross-out mint or a pool output in its past cannot be proven that way).
//
//   node tools/tac-history-index.mjs [--out tac-index.json] [--cache ~/.cache/tacit-tac-index] [--dump dump.json]
//                                    [--seed txmap.json] [--esplora url,url] [--rate 2]
//
// Public data only: keyless esplora mirrors (never the Tacit API's own chain proxy, whose upstream allowance its users
// share) and the API's /reflection/dump for the tracked set. It asks as little as it can: a seed txmap (txid -> {raw,
// height}) is read instead of fetched, spends inside it are worked out locally, confirmed transactions and fully spent
// outspends are cached on disk for good, requests are paced (--rate per second across hosts) and a host that answers
// 429 rests for two minutes. A second run only reads what moved since.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { keccak_256 } from '@noble/hashes/sha3';
import * as secp from '@noble/secp256k1';
import { classifyConfidentialTx, extractTaprootEnvelope, parseCetch, extractInputs } from '../dapp/burn-deposit-bitcoin.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', 'tac-index.json');
const CACHE = arg('--cache', join(homedir(), '.cache', 'tacit-tac-index'));
const DUMP = arg('--dump', null);
const API = arg('--api', 'https://api.tacit.finance');
const HOSTS = (arg('--esplora', 'https://mempool.bitaroo.net/api,https://blockstream.info/api,https://mempool.emzy.de/api')).split(',');
const CONCURRENCY = Number(arg('--concurrency', '2'));
let rate = Number(arg('--rate', '1.2')); // requests per second across hosts: halves on a 429, creeps back after a clean run
const MAX_RATE = rate;
const SEED = arg('--seed', join(homedir(), 'tacit-critical-backup', 'seed-rebuild', 'txmap.json'));
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const ETCH = 'e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e';
const ETCH_HEIGHT = 948242;
const BRIDGE_MAX = 255; // a source note's history the bridge proves: the guest takes 256 transfers, the move adds one

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const rev = (h) => strip(h).match(/../g).reverse().join('');
const opKey = (txid, vout) => strip(pool.outpointKey('0x' + rev(txid), vout));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(CACHE, { recursive: true });
const seedTxs = existsSync(SEED) ? JSON.parse(readFileSync(SEED, 'utf8')) : {};
const dsha = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
// A raw transaction's txid (display order), from its bytes without the witness, to check what a mirror sent.
function txidOfHex(hex) {
  const b = Buffer.from(strip(hex), 'hex');
  if (!(b[4] === 0 && b[5] === 1)) return Buffer.from(dsha(b)).reverse().toString('hex');
  let p = 6;
  const vi = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; } if (f === 0xfe) { const v = b.readUInt32LE(p); p += 4; return v; } const v = Number(b.readBigUInt64LE(p)); p += 8; return v; };
  const nIn = vi(); for (let i = 0; i < nIn; i++) { p += 36; const l = vi(); p += l + 4; }
  const nOut = vi(); for (let i = 0; i < nOut; i++) { p += 8; const l = vi(); p += l; }
  const body = Buffer.concat([b.subarray(0, 4), b.subarray(6, p), b.subarray(b.length - 4)]);
  return Buffer.from(dsha(body)).reverse().toString('hex');
}
let calls = 0, hits = 0, nextAt = 0, clean = 0;
const restUntil = new Map(); // host -> time it may be asked again after a 429
async function pace() { const now = Date.now(), at = Math.max(now, nextAt); nextAt = at + 1000 / rate; if (at > now) await sleep(at - now); }
// keepIf: kept for good when it holds (an answer that cannot change); otherwise kept for FRESH_MS, so a second run soon after
// asks again only for what may have moved since.
const FRESH_MS = Number(arg('--fresh-hours', '12')) * 3600e3;
async function get(path, { keepIf = null, json = false, check = null } = {}) {
  const file = join(CACHE, createHash('sha256').update(path).digest('hex').slice(0, 32));
  if (existsSync(file)) { hits++; const t = readFileSync(file, 'utf8'); return json ? JSON.parse(t) : t; }
  const recent = file + '.recent';
  if (existsSync(recent)) {
    try { const r = JSON.parse(readFileSync(recent, 'utf8')); if (Date.now() - r.at < FRESH_MS) { hits++; return json ? JSON.parse(r.t) : r.t; } } catch { /* asked again */ }
  }
  for (let attempt = 0; ; attempt++) {
    const ready = HOSTS.filter((h) => !(restUntil.get(h) > Date.now()));
    if (!ready.length) { await sleep(Math.min(...HOSTS.map((h) => restUntil.get(h))) - Date.now() + 50); continue; }
    const host = ready[0]; // the first host that is not resting: later ones are fallbacks (blockstream allows ~700 an hour)
    await pace();
    try {
      calls++;
      const res = await fetch(host + path, { signal: AbortSignal.timeout(30e3) });
      const t = (await res.text()).trim();
      if (res.status === 429 || /rate.?limit|too many requests/i.test(t.slice(0, 200))) {
        restUntil.set(host, Date.now() + 60e3); rate = Math.max(0.2, rate / 2); clean = 0;
        throw new Error(`${host} 429`);
      }
      if (res.status >= 500) throw new Error(`${host} ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`${host}${path} answered ${res.status}`), { final: true });
      const v = json ? JSON.parse(t) : t;
      if (check && !check(v)) throw Object.assign(new Error(`${host}${path}: answer does not check out`), { bad: true }); // never cached
      if (!keepIf || keepIf(v)) writeFileSync(file, t); else writeFileSync(recent, JSON.stringify({ at: Date.now(), t }));
      if (++clean >= 200 && rate < MAX_RATE) { rate = Math.min(MAX_RATE, rate * 1.25); clean = 0; }
      return v;
    } catch (e) {
      if (e.final || attempt >= 10 || (e.bad && attempt >= 2)) throw e;
      if (!/ 429$/.test(e.message)) await sleep(Math.min(20e3, 400 * 2 ** attempt));
    }
  }
}
const getHex = async (txid) => (seedTxs[txid] ? seedTxs[txid].raw
  : get(`/tx/${txid}/hex`, { check: (t) => /^[0-9a-f]+$/i.test(t) && txidOfHex(t) === txid }));
// Spends inside the seed are read from its own transactions' inputs, so its outputs need no outspends request.
const seedSpender = new Map();
for (const [txid, t] of Object.entries(seedTxs)) for (const v of vinsOfSeed(t.raw)) seedSpender.set(`${v.txid}:${v.vout}`, { txid, h: t.height });
function vinsOfSeed(hex) { return (extractInputs(strip(hex)) || []).map((x) => ({ txid: rev(x.prevTxid), vout: x.prevVout })); }

// The outputs of a raw transaction: script and value, by index.
function outputsOf(hex) {
  const b = Buffer.from(strip(hex), 'hex');
  let p = 4; if (b[4] === 0 && b[5] === 1) p = 6;
  const vi = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; } if (f === 0xfe) { const v = b.readUInt32LE(p); p += 4; return v; } const v = Number(b.readBigUInt64LE(p)); p += 8; return v; };
  const nIn = vi(); for (let i = 0; i < nIn; i++) { p += 36; const l = vi(); p += l + 4; }
  const nOut = vi(), outs = [];
  for (let i = 0; i < nOut; i++) { const value = Number(b.readBigUInt64LE(p)); p += 8; const l = vi(); outs.push({ value, spk: b.subarray(p, p + l).toString('hex') }); p += l; }
  return outs;
}
const vinsOf = (hex) => (extractInputs(strip(hex)) || []).map((x) => ({ txid: rev(x.prevTxid), vout: x.prevVout }));

// bech32 / bech32m for the two script forms TAC notes sit at.
const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const t = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >> i) & 1) c ^= G[i]; } return c; }
function bech32(hrp, ver, prog) {
  const d = [ver]; let acc = 0, bits = 0; for (const x of prog) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; d.push((acc >> bits) & 31); } } if (bits) d.push((acc << (5 - bits)) & 31);
  const hx = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const k = ver ? 0x2bc830a3 : 1, pm = polymod(hx.concat(d, [0, 0, 0, 0, 0, 0])) ^ k;
  return hrp + '1' + d.concat([0, 1, 2, 3, 4, 5].map((i) => (pm >> (5 * (5 - i))) & 31)).map((x) => CS[x]).join('');
}
const addressOf = (spk) => (/^0014[0-9a-f]{40}$/.test(spk) ? bech32('bc', 0, Buffer.from(spk.slice(4), 'hex'))
  : /^5120[0-9a-f]{64}$/.test(spk) ? bech32('bc', 1, Buffer.from(spk.slice(4), 'hex')) : 'spk:' + spk);

// ── 1. Walk forward from C_0: a transaction's TAC outputs, then who spent each one. ──
const txs = new Map();   // txid -> { h, kind, op, outs: [vout], ins: [ 'txid:vout' ] (filled in step 2), bound }
const notes = new Map(); // 'txid:vout' -> { by, c, spentBy, pending, spk, sats }
const queue = [{ txid: ETCH, h: ETCH_HEIGHT }];
const queued = new Set([ETCH]);
let done = 0;
async function visit({ txid, h }) {
  const hex = await getHex(txid);
  let kind, op = null, outs = [], bound = false;
  if (txid === ETCH) { const c = parseCetch(extractTaprootEnvelope(hex)); kind = 'etch'; outs = [{ vout: 0, c: c && c.c0Compressed }]; }
  else {
    const d = classifyConfidentialTx('0x' + strip(hex));
    if (!d) kind = extractTaprootEnvelope(hex) ? 'unknown-envelope' : 'plain';
    else if ((d.type === 'cxfer' || d.type === 'cxfer_bound') && strip(d.assetId) !== TAC) kind = 'other-asset';
    else if (d.type === 'cxfer' || d.type === 'cxfer_bound') {
      kind = 'cxfer'; op = d.opcode; bound = d.type === 'cxfer_bound';
      outs = d.vouts.map((v, i) => ({ vout: v, c: d.commitments[i] }));
    } else kind = d.type; // burn, or a pool, farm or lock fold: TAC leaves the transfer graph here
  }
  const o = outputsOf(hex);
  txs.set(txid, { h, kind, op, bound, outs: outs.map((x) => x.vout) });
  if (!outs.length) return;
  // Outspends change while an output is unspent, so they are kept on disk only once every TAC output is spent.
  const known = outs.map((x) => seedSpender.get(`${txid}:${x.vout}`));
  const spends = known.every(Boolean) ? [] : await get(`/tx/${txid}/outspends`, { json: true,
    check: Array.isArray, keepIf: (v) => outs.every((x) => v[x.vout] && v[x.vout].spent && v[x.vout].status && v[x.vout].status.confirmed) });
  for (const [i, x] of outs.entries()) {
    const s = known[i] ? { spent: true, txid: known[i].txid, status: { confirmed: true, block_height: known[i].h } } : spends[x.vout] || {};
    const id = `${txid}:${x.vout}`;
    notes.set(id, { by: txid, c: x.c, spentBy: s.spent && s.status && s.status.confirmed ? s.txid : null, pending: !!(s.spent && !(s.status && s.status.confirmed)), spk: o[x.vout] && o[x.vout].spk, sats: o[x.vout] && o[x.vout].value });
    if (s.spent && s.status && s.status.confirmed && !queued.has(s.txid)) { queued.add(s.txid); queue.push({ txid: s.txid, h: s.status.block_height }); }
  }
}
const t0 = Date.now();
async function crawl() {
  let active = 0, failed = [];
  await new Promise((resolve) => {
    const pump = () => {
      while (active < CONCURRENCY && queue.length) {
        const job = queue.shift(); active++;
        visit(job).catch((e) => failed.push(`${job.txid}: ${e.message}`)).finally(() => {
          active--; done++;
          if (done % 250 === 0) console.error(`… ${done} transactions (height ${job.h}), ${notes.size} notes, ${calls} calls (${hits} cached), ${rate.toFixed(2)}/s, ${Math.round((Date.now() - t0) / 1e3)} s`);
          if (!queue.length && !active) resolve(); else pump();
        });
      }
    };
    pump();
  });
  return failed;
}
const failed = await crawl();
console.error(`walk: ${txs.size} transactions, ${notes.size} notes, ${failed.length} failed, ${calls} calls, ${Math.round((Date.now() - t0) / 1e3)} s`);
for (const f of failed.slice(0, 10)) console.error('  failed', f);

// ── 2. Each transfer's TAC inputs: the vins its kernel covers that are notes of this graph, as the guest and the live tracer read
// them (an atomic settlement's are vin[1..1+count]: its taker's sats inputs after those are no part of the history). Any other
// input the kernel covers that is itself a TAC note from outside the graph (a cross-out mint, a pool or farm output) makes that
// history unprovable to the etch. ──
for (const [txid, t] of txs) {
  if (t.kind !== 'cxfer') continue;
  const hex = await getHex(txid), d = classifyConfidentialTx('0x' + strip(hex));
  const vins = vinsOf(hex), covered = d && d.assetInputCount != null ? vins.slice(1, 1 + d.assetInputCount) : vins;
  t.ins = covered.map((v) => `${v.txid}:${v.vout}`).filter((id) => notes.has(id));
  t.other = covered.filter((v) => !notes.has(`${v.txid}:${v.vout}`)).map((v) => `${v.txid}:${v.vout}`);
}
const producerKind = new Map();
// A producer the walk visited already has its kind (a pool, farm or shielded-pool transaction that took TAC in), and one the
// pre-launch seed holds is read from it: only a producer outside both costs a request.
async function foreignTac(id) {
  const txid = id.split(':')[0];
  if (!producerKind.has(txid)) {
    const seen = txs.get(txid);
    if (seen && seen.kind !== 'cxfer') producerKind.set(txid, seen.kind);
    else {
      const hex = await getHex(txid);
      const d = classifyConfidentialTx('0x' + strip(hex));
      producerKind.set(txid, !d ? 'funding' : d.type === 'crossout_mint' ? 'crossout' : d.type === 'cxfer' || d.type === 'cxfer_bound' ? 'cxfer-off-graph' : d.type);
    }
  }
  const k = producerKind.get(txid);
  return k === 'funding' || k === 'burn' || k === 'plain' || k === 'other-asset' ? null : k; // these make plain outputs only
}

// ── 3. The tracked set, and each unspent note's history. ──
const dump = DUMP ? JSON.parse(readFileSync(DUMP, 'utf8')) : await (await fetch(`${API}/reflection/dump?network=mainnet`)).json();
const live = new Map(dump.snapshot.liveTriples.map((t) => [strip(t[0]), Number(t[4]) === 1]));
const attested = Number(dump.snapshot.height ?? dump.attestedHeight);
const unspent = [...notes].filter(([, n]) => !n.spentBy && !n.pending).map(([id, n]) => {
  const [txid, vout] = id.split(':');
  const key = opKey(txid, Number(vout));
  return { id, ...n, h: txs.get(n.by).h, tracked: live.has(key), bound: live.get(key) === true || txs.get(n.by).bound };
});

const memo = new Map();
async function history(id) {
  // Distinct transfers behind a note, back to the etch; null `why` when every input reaches the etch by transfers.
  const seen = new Set(), stack = [notes.get(id).by]; let why = null;
  while (stack.length) {
    const txid = stack.pop();
    if (txid === ETCH || seen.has(txid)) continue;
    const t = txs.get(txid);
    if (!t || t.kind !== 'cxfer') { why = why || `through ${t ? t.kind : 'an unknown transaction'}`; continue; }
    seen.add(txid);
    for (const o of t.other || []) { const k = await foreignTac(o); if (k) why = why || `through a ${k} output`; }
    for (const i of t.ins) stack.push(notes.get(i).by);
  }
  return { hops: seen.size, why, set: seen };
}

const rows = [];
for (const n of unspent.filter((x) => !x.tracked && x.h <= attested)) {
  const hst = await history(n.id);
  memo.set(n.id, hst.set);
  rows.push({ id: n.id, h: n.h, address: addressOf(n.spk || ''), sats: n.sats, hops: hst.hops, provable: !hst.why, why: hst.why, bound: n.bound });
}
const band = (r) => (!r.provable ? 'unprovable' : r.hops <= 63 ? '<=63' : r.hops <= BRIDGE_MAX ? '64-255' : '>255');
const bands = rows.reduce((m, r) => ({ ...m, [band(r)]: (m[band(r)] || 0) + 1 }), {});
const byOwner = new Map();
for (const r of rows) { const o = byOwner.get(r.address) || { address: r.address, notes: 0, maxHops: 0, union: new Set(), bands: {} }; o.notes++; o.maxHops = Math.max(o.maxHops, r.hops); for (const x of memo.get(r.id)) o.union.add(x); o.bands[band(r)] = (o.bands[band(r)] || 0) + 1; byOwner.set(r.address, o); }
const owners = [...byOwner.values()].map((o) => ({ address: o.address, notes: o.notes, maxHops: o.maxHops, unionHops: o.union.size, bands: o.bands })).sort((a, b) => b.maxHops - a.maxHops);

const trackedFound = unspent.filter((x) => x.tracked).length;
// ── 4. Integrity: the reflection's tracked set against Bitcoin's own spends. A live key whose note Bitcoin had spent by the attested
// height is listed with the spend's height and whether the seed holds its spender; one spent after that height is later news and
// only counted. A live key the walk never reached is a note made off the transfer graph (a cross-out mint, a pool or farm output, a
// shielded-pool exit), and is counted only. ──
const GENESIS = 967041;
const keyOf = new Map();
for (const [id] of notes) { const [txid, vout] = id.split(':'); keyOf.set(opKey(txid, Number(vout)), id); }
const liveSpent = [], liveUnseen = [];
let liveSpentAfter = 0;
for (const k of live.keys()) {
  const id = keyOf.get(k);
  if (!id) { liveUnseen.push(k); continue; }
  const n = notes.get(id), s = n.spentBy && txs.get(n.spentBy);
  if (!n.spentBy) continue;
  if (s && s.h > attested) { liveSpentAfter++; continue; }
  liveSpent.push({ id, spentBy: n.spentBy, spentAt: s ? s.h : null, spentKind: s ? s.kind : 'unvisited', spenderInSeed: !!seedTxs[n.spentBy] });
}
const integrity = { liveSpentOnBitcoin: liveSpent.length, liveSpentSinceGenesis: liveSpent.filter((x) => x.spentAt == null || x.spentAt >= GENESIS).length,
  liveSpentSpenderNotInSeed: liveSpent.filter((x) => !x.spenderInSeed).length, liveSpentAfterAttested: liveSpentAfter,
  liveSpentHeights: liveSpent.length ? [Math.min(...liveSpent.map((x) => x.spentAt)), Math.max(...liveSpent.map((x) => x.spentAt))] : null,
  liveSpentSample: liveSpent.slice(0, 20), liveOffGraph: liveUnseen.length,
  destroyedByPlainSpend: [...txs.values()].filter((t) => t.kind === 'plain').length, otherAssetSpends: [...txs.values()].filter((t) => t.kind === 'other-asset').length,
  unknownEnvelopes: [...txs.values()].filter((t) => t.kind === 'unknown-envelope').length };
const summary = {
  at: new Date().toISOString(), attestedHeight: attested, transactions: txs.size, notes: notes.size,
  kinds: [...txs.values()].reduce((m, t) => ({ ...m, [t.kind]: (m[t.kind] || 0) + 1 }), {}),
  unspent: unspent.length, unspentTracked: trackedFound, liveTriples: live.size,
  unspentUntracked: rows.length, newerThanAttested: unspent.filter((x) => !x.tracked && x.h > attested).length,
  untrackedBands: bands, owners: owners.length, integrity,
};
writeFileSync(OUT, JSON.stringify({ summary, untracked: rows.sort((a, b) => b.hops - a.hops), owners,
  transfers: Object.fromEntries([...txs].map(([id, t]) => [id, { h: t.h, kind: t.kind, op: t.op, ins: t.ins || [], outs: t.outs }])) }, null, 1));
console.log(JSON.stringify(summary, null, 2));
console.log('deepest untracked holders:');
for (const o of owners.slice(0, 25)) console.log(`  ${o.address}  notes ${o.notes}  max ${o.maxHops}  together ${o.unionHops}  ${JSON.stringify(o.bands)}`);
