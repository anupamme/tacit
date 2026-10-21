// What the first-generation association-set pool's client reads and calls outside the chain's own RPC: the approval
// service's published lists and review status, the pool's events (through an explorer's log API, filtered by the
// depositor where it can be), and a withdrawal relayer. Every answer is data the caller checks against the chain
// (assoc-pool.js: the lists must fold to the pool's roots; an event must reproduce its commitment), so nothing here is
// trusted for what it says, only for what it hands over.
//
// Deps injected: { fetchImpl, rpc } where rpc(method, params) is a JSON-RPC call to Ethereum.

import { ETH_POOL, NATIVE, SEL, TOPIC } from './assoc-pool.js';

export const ASP_URL = 'https://api.0xbow.io';
export const SCAN_URL = 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api';
// A page can call this relayer (it answers any origin). The other relayer the pool's own app lists does not answer pages.
export const RELAYERS = ['https://fastrelay.xyz'];
export const MAX_RELAY_BPS = 1000;   // the entrypoint refuses a relay fee above 10% of the amount

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wordsOf = (data) => { const h = String(data).replace(/^0x/, ''); return Array.from({ length: h.length / 64 }, (_, i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64))); };
const pad32 = (a) => '0x' + String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const byPlace = (a, b) => a.block - b.block || a.logIndex - b.logIndex;

export function makeAssocNet({ fetchImpl = globalThis.fetch?.bind(globalThis), rpc, aspUrl = ASP_URL, scanUrl = SCAN_URL, relayers = RELAYERS, target = ETH_POOL, gapMs = 250 }) {
  if (!fetchImpl) throw new Error('assoc-pool-net: fetch is required');
  const scope = String(target.scope);
  let last = 0;
  // One explorer call at a time with a gap, and a retry on a rate limit: these APIs ban bursts.
  let chain = Promise.resolve();
  const polite = (fn) => { const run = chain.then(async () => { const wait = last + gapMs - Date.now(); if (wait > 0) await sleep(wait); try { return await fn(); } finally { last = Date.now(); } }); chain = run.catch(() => {}); return run; };
  async function json(url, init, { tries = 3 } = {}) {
    for (let t = 0; ; t++) {
      const r = await fetchImpl(url, init);
      if ((r.status === 429 || r.status >= 500) && t < tries - 1) { await sleep(1500 * (t + 1)); continue; }
      if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
      return r.json();
    }
  }

  // ──────────────────── the approval service ────────────────────

  const aspHeaders = { 'X-Pool-Scope': scope };
  const decimals = (xs, what) => {
    if (!Array.isArray(xs) || xs.some((x) => typeof x !== 'string' || !/^[0-9]+$/.test(x))) throw new Error(`the approval service sent a malformed ${what}`);
    return xs.map(BigInt);
  };
  // The approved labels and the pool's commitments, in tree order. Both are checked against the chain by the caller.
  async function leaves() {
    const d = await json(`${aspUrl}/${target.chainId}/public/mt-leaves`, { headers: aspHeaders });
    return { aspLeaves: decimals(d?.aspLeaves, 'approval list'), stateLeaves: decimals(d?.stateTreeLeaves, 'commitment list') };
  }
  // Review status per label: pending, approved, declined, … (what its own app shows). A label it has not seen is absent.
  async function reviews(labels) {
    if (!labels.length) return new Map();
    const d = await json(`${aspUrl}/${target.chainId}/public/deposits-by-label`, { headers: { ...aspHeaders, 'X-Labels': labels.map(String).join(',') } });
    const out = new Map();
    if (Array.isArray(d)) for (const x of d) if (x?.label != null) out.set(BigInt(x.label), String(x.reviewStatus || 'pending'));
    return out;
  }

  // ──────────────────── the chain ────────────────────

  const callBig = async (to, data) => BigInt(await rpc('eth_call', [{ to, data }, 'latest']));
  async function head() {
    const [stateRoot, aspRoot, nonce, treeSize, block] = await Promise.all([
      callBig(target.pool, SEL.currentRoot), callBig(target.entrypoint, SEL.latestRoot), callBig(target.pool, SEL.nonce), callBig(target.pool, SEL.currentTreeSize), rpc('eth_blockNumber', []),
    ]);
    return { stateRoot, aspRoot, nonce, treeSize, block: Number(BigInt(block)) };
  }
  // The entrypoint's terms for ETH: its smallest deposit, the fee it keeps from one, and the most a relay may take. Read
  // for a few minutes at a time; the constants stand in when the read fails.
  let cfg = null;
  async function config() {
    if (cfg && Date.now() - cfg.at < 300e3) return cfg.v;
    let v = { minDeposit: 10n ** 16n, vettingBps: 50n, maxRelayBps: BigInt(MAX_RELAY_BPS) };
    try {
      const w = wordsOf(await rpc('eth_call', [{ to: target.entrypoint, data: SEL.assetConfig + pad32(target.asset).slice(2) }, 'latest']));
      if (w.length >= 4 && w[1] > 0n) v = { minDeposit: w[1], vettingBps: w[2], maxRelayBps: w[3] };
    } catch {}
    cfg = { v, at: Date.now() };
    return v;
  }
  // Whether the pool still accepts `root` as a state root: its current one, or one of the last 64 it kept.
  async function stateRootKnown(root) {
    if (root === (await callBig(target.pool, SEL.currentRoot))) return true;
    const slots = await Promise.all(Array.from({ length: 64 }, (_, i) => callBig(target.pool, SEL.roots + i.toString(16).padStart(64, '0')).catch(() => 0n)));
    return slots.includes(root);
  }

  // ──────────────────── events ────────────────────

  // The explorer's log API, paged: a depositor (or any indexed address) as topic1 narrows it to one account's events.
  async function logs({ topic0, topic1, from = target.entryBlock, to = 'latest', address = target.pool, pageSize = 1000, maxPages = 60 }) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const q = new URLSearchParams({ module: 'logs', action: 'getLogs', address, topic0, fromBlock: String(from), toBlock: String(to), page: String(page), offset: String(pageSize) });
      if (topic1) { q.set('topic1', pad32(topic1)); q.set('topic0_1_opr', 'and'); }
      const d = await polite(() => json(`${scanUrl}?${q}`));
      if (!Array.isArray(d?.result)) { if (/no records/i.test(String(d?.message || d?.result || ''))) break; throw new Error('the explorer did not answer the log query'); }
      out.push(...d.result);
      if (d.result.length < pageSize) return out;
    }
    throw new Error('more events than the page limit: narrow the range');
  }
  // The explorer sometimes lists a log with its data missing (five of the pool's deposits and five of its withdrawals).
  // A log of the wrong shape is read again from its transaction's receipt, and the result is one entry per log.
  // A receipt from the RPC, else from the explorer (public RPCs forget old transactions).
  async function receiptOf(hash) {
    const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r?.logs) return r;
    const d = await polite(() => json(`${scanUrl}?module=proxy&action=eth_getTransactionReceipt&txhash=${hash}`)).catch(() => null);
    return d?.result?.logs ? d.result : null;
  }
  const SHAPE = new Map([[TOPIC.deposited, 4], [TOPIC.withdrawn, 3], [TOPIC.ragequit, 3]]);
  const wellFormed = (l) => Array.isArray(l?.topics) && l.topics.length === 2 && wordsOf(l.data || '').length === SHAPE.get(l.topics[0]);
  const logKey = (l) => `${l.transactionHash}:${BigInt(l.logIndex || 0)}`;
  async function sound(ls) {
    const out = new Map();
    for (const l of ls) {
      let g = wellFormed(l) ? l : null;
      if (!g) {
        const rc = await receiptOf(l.transactionHash);
        const cands = (rc?.logs || []).filter((x) => x.address.toLowerCase() === l.address.toLowerCase() && x.topics[0] === l.topics[0] && wellFormed(x));
        const same = cands.find((x) => BigInt(x.logIndex) === BigInt(l.logIndex || 0));
        g = same || (cands.length === 1 ? cands[0] : null);
        if (g) g = { ...g, blockNumber: g.blockNumber || l.blockNumber };
      }
      if (g && !out.has(logKey(g))) out.set(logKey(g), g);
    }
    return [...out.values()];
  }
  const place = (l) => ({ block: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex || 0)), tx: l.transactionHash });
  const asDeposit = (l) => { const w = wordsOf(l.data); return { depositor: '0x' + l.topics[1].slice(26), commitment: w[0], label: w[1], value: w[2], precommitment: w[3], ...place(l) }; };
  const asWithdrawal = (l) => { const w = wordsOf(l.data); return { processooor: '0x' + l.topics[1].slice(26), value: w[0], spentNullifier: w[1], newCommitment: w[2], ...place(l) }; };
  const asRagequit = (l) => { const w = wordsOf(l.data); return { ragequitter: '0x' + l.topics[1].slice(26), commitment: w[0], label: w[1], value: w[2], ...place(l) }; };
  const decode = async (ls, f) => (await sound(ls)).map(f).sort(byPlace);
  const deposits = async ({ depositor, from } = {}) => decode(await logs({ topic0: TOPIC.deposited, topic1: depositor, from }), asDeposit);
  const withdrawals = async ({ from } = {}) => decode(await logs({ topic0: TOPIC.withdrawn, from }), asWithdrawal);
  const ragequits = async ({ ragequitter, from } = {}) => decode(await logs({ topic0: TOPIC.ragequit, topic1: ragequitter, from }), asRagequit);

  // Everything of one account that made its deposits from `depositor`: its deposits, then the withdrawals since the first
  // of them (a note's chain of change can only start there), and its public exits.
  async function historyOf(depositor) {
    const [dep, rq] = await Promise.all([deposits({ depositor }), ragequits({ ragequitter: depositor })]);
    const from = dep.length ? Math.min(...dep.map((d) => d.block)) : null;
    const wd = from == null ? [] : await withdrawals({ from });
    return { deposits: dep, withdrawals: wd, ragequits: rq };
  }
  // Every deposit event of the pool, for an account whose deposits were made from other wallets (its phrase loaded in
  // the pool's own app). The count must equal the pool's nonce, else some were missed (or one was made since).
  async function allDeposits() {
    const [raw, h] = await Promise.all([logs({ topic0: TOPIC.deposited }), head()]);
    const events = await decode(raw, asDeposit);
    return { events, complete: BigInt(events.length) === h.nonce, expected: h.nonce };
  }
  // Every withdrawal since `from`, and whether that is all of them: from the pool's first block, each withdrawal and each
  // deposit added one leaf, so their counts add up to the tree's size.
  async function allWithdrawals({ from = target.entryBlock } = {}) {
    const [raw, h] = await Promise.all([logs({ topic0: TOPIC.withdrawn, from }), head()]);
    const events = await decode(raw, asWithdrawal);
    return { events, complete: from > target.entryBlock ? null : BigInt(events.length) === h.treeSize - h.nonce, expected: h.treeSize - h.nonce };
  }
  // Whether the pool has marked a nullifier hash spent: the check that no event was missed for a note about to be spent.
  const spent = async (nullifierHash) => (await callBig(target.pool, SEL.nullifierHashes + BigInt(nullifierHash).toString(16).padStart(64, '0'))) !== 0n;

  // ──────────────────── a relayer ────────────────────

  const relayerOf = (url) => ({
    url,
    details: () => json(`${url}/relayer/details?chainId=${target.chainId}&assetAddress=${NATIVE}`),
    quote: (amount) => json(`${url}/relayer/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: target.chainId, amount: String(amount), asset: NATIVE }) }, { tries: 1 }),
    async request({ withdrawal, proof, publicSignals, scope: s = target.scope }) {
      const r = await fetchImpl(`${url}/relayer/request`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ withdrawal, proof, publicSignals: publicSignals.map(String), scope: String(s), chainId: target.chainId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.success === false) throw new Error(body.error || body.message || `the relayer refused (HTTP ${r.status})`);
      return body;
    },
  });
  // The first relayer that answers, with its fee address and the fee it asks for `amount`.
  async function pickRelayer(amount) {
    let err = null;
    for (const url of relayers) {
      try {
        const r = relayerOf(url);
        const [d, q] = await Promise.all([r.details(), r.quote(amount)]);
        if (!/^0x[0-9a-fA-F]{40}$/.test(String(d.feeReceiverAddress))) throw new Error('no fee address');
        const ask = BigInt(q.feeBPS);
        // Gas can move between the quote and the relay; ask a fifth more, within the entrypoint's cap, and an amount that
        // needs more than the cap is too small to relay at today's gas.
        const bps = ask + (ask + 4n) / 5n, cap = (await config()).maxRelayBps;
        return { relayer: r, feeReceiver: d.feeReceiverAddress, quotedBps: ask, bps: bps > cap ? (ask <= cap ? cap : null) : bps, capBps: cap, gasPrice: BigInt(q.gasPrice ?? 0), maxGasPrice: BigInt(d.maxGasPrice ?? 0) };
      } catch (e) { err = e; }
    }
    throw new Error(`no relayer answered${err ? `: ${err.message}` : ''}`);
  }

  return { leaves, reviews, head, config, stateRootKnown, spent, logs, deposits, withdrawals, ragequits, historyOf, allDeposits, allWithdrawals, relayerOf, pickRelayer };
}
