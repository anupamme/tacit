// The relayer's chain view over esplora (makeEsploraRelayChain). Esplora answers `/tx/:txid/status` with
// 200 {"confirmed":false} for a txid it has never seen, and the transaction itself (`/tx/:txid`) with 404. The relayer's
// contract is txStatus → { confirmed, … } | null with null for a transaction no node has, because a refused
// broadcast is told from a landed one by it (pushTx), and a carrier missing from the chain is rebroadcast by it (watch).
// Checked here against a fake esplora that answers like the real ones: the chain view alone, then a relayer whose reveal
// is refused once, which must not be reported as broadcast and must go out on the next tick.
//   node worker-relay/tests/btc-pool-relayer-txstatus.test.mjs

import assert from 'node:assert/strict';
import { secp, sha256, keccak_256, hexToBytes, bytesToHex } from '../../dapp/vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../../dapp/btc-shielded-pool.js';
import { HALO2_PROOF_LEN } from '../../dapp/btc-pool-halo2-prover.js';
import { parseTx } from '../src/lib/btc-pool-chain.js';
import { createRelayer, makeEsploraRelayChain } from '../src/lib/btc-pool-relayer.js';

const BASE = 'https://esplora.test/api';
const NOT_FOUND = 'Transaction not found';

// An esplora that keeps the quirk: status answers for any txid. `refuseReveal` refuses that many broadcasts of a
// transaction that spends an output of one it already holds (the reveal), as a node does for its own policy.
function fakeEsplora({ coins = [], refuseReveal = 0 } = {}) {
  const held = new Map(), confirmed = new Map(), spentBy = new Set();
  const posts = [];
  let refuse = refuseReveal;
  const reply = (code, body) => ({ ok: code < 300, status: code, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname.replace(/^\/api/, '');
    let m;
    if (p === '/tx' && init.method === 'POST') {
      const tx = parseTx(hexToBytes(init.body)).tx;
      const isReveal = tx.vin.some((i) => held.has(i.txid));
      posts.push({ txid: tx.txid, isReveal });
      if (isReveal && refuse > 0) { refuse--; return reply(400, 'sendrawtransaction RPC error: min relay fee not met'); }
      if (!isReveal && tx.vin.some((i) => !coins.some((c) => c.txid === i.txid && c.vout === i.vout))) return reply(400, 'bad-txns-inputs-missingorspent');
      held.set(tx.txid, init.body);
      for (const i of tx.vin) spentBy.add(`${i.txid}:${i.vout}`);
      return reply(200, tx.txid);
    }
    if ((m = p.match(/^\/tx\/([0-9a-f]{64})\/status$/))) return reply(200, confirmed.get(m[1]) || { confirmed: false });
    if ((m = p.match(/^\/tx\/([0-9a-f]{64})$/))) return held.has(m[1]) ? reply(200, { txid: m[1] }) : reply(404, NOT_FOUND);
    if ((m = p.match(/^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/))) return reply(200, { spent: spentBy.has(`${m[1]}:${m[2]}`) });
    if (p.match(/^\/address\/[^/]+\/utxo$/)) return reply(200, coins.filter((c) => !spentBy.has(`${c.txid}:${c.vout}`)).map((c) => ({ ...c, status: { confirmed: true } })));
    if (p === '/fee-estimates') return reply(200, { 3: 2 });
    return reply(404, 'not found');
  };
  return { fetchImpl, held, confirmed, posts, refuseOnce: (n = 1) => { refuse = n; } };
}

// ── the chain view ──
{
  const e = fakeEsplora();
  const chain = makeEsploraRelayChain([BASE], { fetchImpl: e.fetchImpl });
  const known = 'aa'.repeat(32), mined = 'bb'.repeat(32), unknown = 'cc'.repeat(32);
  e.held.set(known, '00'); e.held.set(mined, '00');
  e.confirmed.set(mined, { confirmed: true, block_height: 900 });
  assert.equal(await chain.txStatus(unknown), null, 'no node has it: null, whatever the status endpoint says');
  assert.deepEqual(await chain.txStatus(known), { confirmed: false }, 'in the mempool: unconfirmed');
  assert.deepEqual(await chain.txStatus(mined), { confirmed: true, block_height: 900 });
  // A base that fails is not an answer: the status is unknown to the caller, not absent.
  const down = makeEsploraRelayChain([BASE], { fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'busy' }) });
  await assert.rejects(down.txStatus(unknown), (err) => err.status === 503);
  // Known to the second base only.
  const e2 = fakeEsplora(); e2.held.set(unknown, '00');
  const two = makeEsploraRelayChain([BASE, 'https://other.test/api'], { fetchImpl: (u, i) => (u.startsWith(BASE) ? e.fetchImpl(u, i) : e2.fetchImpl(u, i)) });
  assert.deepEqual(await two.txStatus(unknown), { confirmed: false }, 'a transaction one base holds is known');
}

// ── a broadcast reaches every base, so one mirror that loses a transaction does not leave the relay with nothing ──
{
  const le = (n, len) => { const b = new Uint8Array(len); let x = BigInt(n); for (let i = 0; i < len; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
  // A small, parseable, non-segwit transaction spending one coin the fake mirrors know.
  const COIN = { txid: '12'.repeat(32), vout: 0, value: 50_000 };
  const raw = bytesToHex(new Uint8Array([...le(2, 4), 1, ...hexToBytes(COIN.txid).reverse(), ...le(COIN.vout, 4), 0, ...le(0xfffffffd, 4), 1, ...le(1000, 8), 22, 0x00, 0x14, ...new Uint8Array(20).fill(7), ...le(0, 4)]));
  const txid = parseTx(hexToBytes(raw)).tx.txid;
  const U = { a: 'https://a.test/api', b: 'https://b.test/api', c: 'https://c.test/api' };
  const mirrors = (over = {}) => {
    const m = { a: fakeEsplora({ coins: [COIN] }), b: fakeEsplora({ coins: [COIN] }), c: fakeEsplora({ coins: [COIN] }) };
    const refuse = (name) => async (u, i) => (over[name] === 'refuse' && i?.method === 'POST' ? { ok: false, status: 400, text: async () => 'min relay fee not met' } : m[name].fetchImpl(u, i));
    const fetchImpl = (u, i) => (u.startsWith(U.a) ? refuse('a') : u.startsWith(U.b) ? refuse('b') : refuse('c'))(u, i);
    return { m, fetchImpl };
  };
  const settle = () => new Promise((r) => setTimeout(r, 25));

  let { m, fetchImpl } = mirrors();
  let chain = makeEsploraRelayChain(Object.values(U), { fetchImpl });
  assert.equal(await chain.broadcast(raw), txid, 'the first base to accept answers');
  await settle();
  assert.deepEqual([m.a.posts.length, m.b.posts.length, m.c.posts.length], [1, 1, 1], 'every base got it once: the winner is not sent it again');
  assert.ok(m.b.held.has(txid) && m.c.held.has(txid), 'the others hold it');

  // The first base answers 200 and then loses the transaction; the relay still finds it on the others.
  m.a.held.delete(txid);
  assert.deepEqual(await chain.txStatus(txid), { confirmed: false }, 'known to the others, so the carrier is not rebroadcast');

  // A base that refuses is not the winner, and the rest still take it.
  ({ m, fetchImpl } = mirrors({ a: 'refuse' }));
  chain = makeEsploraRelayChain(Object.values(U), { fetchImpl });
  assert.equal(await chain.broadcast(raw), txid, 'the next base accepts');
  await settle();
  assert.ok(m.b.held.has(txid) && m.c.held.has(txid), 'and the last base gets it too');

  // Every base refusing is a failure, with the own node as the last resort and no fan-out around it.
  ({ m, fetchImpl } = mirrors({ a: 'refuse', b: 'refuse', c: 'refuse' }));
  await assert.rejects(makeEsploraRelayChain(Object.values(U), { fetchImpl }).broadcast(raw), /min relay fee/);
  let own = 0;
  assert.equal(await makeEsploraRelayChain(Object.values(U), { fetchImpl, fallbackBroadcast: async () => { own++; return 'from-own-node'; } }).broadcast(raw), 'from-own-node');
  assert.equal(own, 1, 'the own node is asked once');
}

// ── a relayer whose reveal is refused once ──
const bp = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
const ASSET = '0x' + 'ab'.repeat(32), FEE = 10n, TIP = 1000, ANCHOR = 996, ANCHOR_ROOT = '0a'.repeat(32);
const OK_PROOF = (() => { const w = new Uint8Array(HALO2_PROOF_LEN); w[0] = 1; w[1] = 2; return w; })();
const COINS = [
  { txid: 'ee'.repeat(32), vout: 1, value: 200_000 }, { txid: 'dd'.repeat(32), vout: 0, value: 50_000 },
  { txid: 'bb'.repeat(32), vout: 3, value: 20_000 },
];
const POOL_SEED = new Uint8Array(32).fill(6);
const alice = bp.walletFromSeed(new Uint8Array(32).fill(1), 'signet'), bob = bp.walletFromSeed(new Uint8Array(32).fill(2), 'signet');
const relayerWallet = bp.walletFromSeed(POOL_SEED, 'signet');
const spk = Uint8Array.from([0x00, 0x14, ...new Uint8Array(20).fill(9)]);

async function run({ refuseReveal }) {
  const logs = [];
  const esplora = fakeEsplora({ coins: COINS, refuseReveal });
  let clock = 1_700_000_000_000;
  const relayer = createRelayer({
    network: 'signet', btcKey: Uint8Array.from({ length: 32 }, (_, i) => (i ? 5 : 1)), poolSeed: POOL_SEED, fees: { [ASSET]: FEE },
    pool: { tip: () => TIP, chainTip: () => TIP, rootAt: (h) => (h === ANCHOR ? ANCHOR_ROOT : null), isSpent: () => false, pendingSpend: () => null, aheadComplete: () => true },
    verifier: { enabled: true, verify: async ({ proof }) => proof[0] === 1 },
    chain: makeEsploraRelayChain([BASE], { fetchImpl: esplora.fetchImpl }),
    mempool: { refresh: async () => {}, conflict: () => null },
    batchMs: 60_000, now: () => clock, log: (m) => logs.push(String(m)),
  });
  const q = await relayer.quote({ asset: ASSET, exitScriptPubKey: bytesToHex(spk) });
  const n = bp.createNote(alice.addressString, ASSET, 100n);
  const note = bp.tryReceive(alice, { ...n, leafIndex: 0 });
  const body = bp.buildSpendBody({
    asset: ASSET, hAnchor: ANCHOR, inputs: [note], bind: q.bind, exit: { exitVout: q.exitVout, scriptPubKey: spk, value: 60n },
    outputs: [{ address: relayerWallet.addressString, value: FEE }, { address: bob.addressString, value: 30n }],
  });
  const sub = await relayer.submit({ payload: bytesToHex(bp.assembleSpendEnvelope(body.body, OK_PROOF)), quoteId: q.quoteId });
  return { relayer, esplora, sub, logs, advance: (ms) => { clock += ms; } };
}

{
  const { relayer, esplora, sub } = await run({ refuseReveal: 1 });
  const c = await relayer.flush();
  assert.deepEqual(esplora.posts.map((p) => p.isReveal), [false, true], 'the commit went out, then the reveal, which the node refused');
  assert.equal(esplora.held.size, 1, 'only the commit is on the network');
  assert.equal(c.state, 'committed', 'the carrier has not been broadcast');
  assert.equal(relayer.status(sub.id).carrier, null, 'and is not reported as sent: a client would stop waiting on it');
  assert.match(c.lastError || '', /min relay fee/);
  await relayer.tick();
  assert.deepEqual(esplora.posts.map((p) => p.isReveal), [false, true, true], 'the next tick sends the reveal again');
  assert.equal(esplora.held.size, 2);
  assert.equal(c.state, 'broadcast');
  assert.equal(relayer.status(sub.id).carrier, c.revealTxid);
  assert.ok(esplora.held.has(c.revealTxid), 'the txid it reports is on the network');
}

// A carrier the relayer believes is broadcast but no node holds is sent again, commit and reveal.
{
  const { relayer, esplora, sub } = await run({ refuseReveal: 0 });
  const c = await relayer.flush();
  assert.equal(c.state, 'broadcast');
  esplora.held.delete(c.revealTxid);      // dropped from the mempool
  const before = esplora.posts.length;
  await relayer.tick();
  assert.ok(esplora.posts.length > before, 'a carrier no node holds is rebroadcast');
  assert.ok(esplora.held.has(c.revealTxid), 'and it is back');
}

// A refusal on a later tick is logged, once per distinct message, and the carrier lands when the node takes it.
{
  const { relayer, esplora, sub, logs } = await run({ refuseReveal: 0 });
  const c = await relayer.flush();
  assert.equal(c.state, 'broadcast');
  esplora.held.delete(c.revealTxid);
  esplora.refuseOnce(2);
  await relayer.tick(); await relayer.tick();
  const refused = logs.filter((l) => /min relay fee not met/.test(l));
  assert.equal(refused.length, 1, 'the same refusal twice is one log line');
  assert.match(refused[0], new RegExp(`carrier ${c.id} \\(broadcast\\)`));
  assert.ok(!esplora.held.has(c.revealTxid), 'still not on the network');
  await relayer.tick();
  assert.ok(esplora.held.has(c.revealTxid), 'sent once the node takes it');
  assert.equal(relayer.status(sub.id).carrier, c.revealTxid);
}

console.log('btc-pool-relayer-txstatus: all checks passed');
