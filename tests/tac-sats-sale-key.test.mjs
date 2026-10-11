// "To sats" sale keys (dapp/sats/secret.js saleKey, saleKeys, exitToSaleKey): shielded TAC leaves the pool through the
// relay to a new P2WPKH key of the pool wallet, so the wallet's own Bitcoin address never funds or signs anything.
// The relay, the explorer and the prover are stubbed; a post from the wallet's address is seen as tacit.wallet.xonly()
// being reached, which broadcastCarrier calls first.
//   node tests/tac-sats-sale-key.test.mjs

import assert from 'node:assert/strict';
import { secp, sha256, ripemd160, bech32, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';

const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, 0, ...a);       // the relay's five-minute wait, at once
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const secret = await import('../dapp/sats/secret.js');
const { pool } = secret;
const client = secret.poolClientFor('mainnet');
const ASSET = secret.TAC_ASSET_MAINNET;
const pw = secret.poolWalletFor(new Uint8Array(32).fill(7), 'mainnet');
const relayAddr = secret.poolWalletFor(new Uint8Array(32).fill(8), 'mainnet').addressString;

// ── saleKey: a P2WPKH key the wallet can recover, and an address that pays its script ──
const k0 = secret.saleKey(pw, 0), k1 = secret.saleKey(pw, 1);
assert.equal(k0.pub, bytesToHex(secp.getPublicKey(hexToBytes(k0.priv), true)), 'pub is the priv’s point');
assert.equal(k0.scriptPubKey, '0014' + bytesToHex(ripemd160(sha256(hexToBytes(k0.pub)))), 'P2WPKH of that point');
const dec = bech32.decode(k0.address);
assert.equal(dec.prefix, 'bc'); assert.equal(dec.words[0], 0, 'witness version 0, bech32 (not bech32m)');
assert.equal(bytesToHex(bech32.fromWords(dec.words.slice(1))), k0.scriptPubKey.slice(4), 'the address pays the script');
assert.notEqual(k0.address, k1.address, 'one key per counter');
assert.deepEqual(secret.saleKey(pw, 0), k0, 'the same counter gives the same key: recoverable from the backup');
assert.equal(pool.deriveExitKey(pw, 0, 'p2tr').priv.replace(/^0x/, ''), k0.priv, 'P2TR and P2WPKH of one counter share a secret, so a counter serves one script only');
const tbKey = secret.saleKey(secret.poolWalletFor(new Uint8Array(32).fill(7), 'signet'), 0);
assert.ok(tbKey.address.startsWith('tb1q'), 'signet keys are tb1q');

// ── saleKeys: walks the chain for used keys, opens the exits at them, finds the first free counter ──
const API = 'https://esplora.test/api';
const p2trAddr = (c) => secret.p2trAddress(pool.deriveExitKey(pw, c, 'p2tr').scriptPubKey, 'mainnet');
function chain({ wpkh = {}, tr = new Set() } = {}) {
  const seen = [];
  globalThis.fetch = async (url) => {
    const p = String(url).slice(API.length);
    let m;
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if ((m = p.match(/^\/address\/([^/]+)\/utxo$/))) return ok(Object.entries(wpkh).find(([c]) => secret.saleKey(pw, +c).address === m[1])?.[1] || []);
    if ((m = p.match(/^\/address\/([^/]+)$/))) {
      seen.push(m[1]);
      const c = Object.keys(wpkh).find((c) => secret.saleKey(pw, +c).address === m[1]);
      const hit = c != null || [...tr].some((t) => p2trAddr(t) === m[1]);
      return ok({ chain_stats: { tx_count: hit ? 1 : 0 }, mempool_stats: { tx_count: 0 } });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return seen;
}
const recorded = [];
const tx = (id, opcode) => ({ id, opcode });
const tacitScan = {
  NET: { api: API },
  getTx: async (id) => tx(id, id.startsWith('ee') ? 0x6d : 0x39),
  txOutputEnvelope: (t) => ({ opcode: t.opcode, payload: new Uint8Array([1]) }),
  recordOpening: (...a) => recorded.push(a),
};
let wantAddrs = [relayAddr];
pool.recoverExit = (wallet, payload, notes, opts) => { assert.equal(wallet, pw); assert.ok(Array.isArray(notes)); assert.deepEqual(opts?.addresses, wantAddrs, 'the relay’s address opens the fee note'); return { exitVout: 1, value: '250000000', blinding: '0x' + '05'.padStart(64, '0') }; };

{
  const seen = chain({
    wpkh: { 0: [
      { txid: 'ee'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },   // a take-out
      { txid: 'ee'.repeat(31) + 'ef', vout: 0, value: 546, status: { confirmed: false } },   // an exit at another output than the one it opens
      { txid: '39'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },   // not a pool exit
    ] },
    tr: new Set([1]),
  });
  recorded.length = 0;
  const r = await secret.saleKeys(tacitScan, pw, [], ASSET, { addresses: [relayAddr] });
  assert.equal(r.keys.length, 1);
  assert.equal(r.keys[0].counter, 0);
  assert.deepEqual(r.keys[0].notes, [{ txid: 'ee'.repeat(32), vout: 1, value: 250000000n, confirmed: true }]);
  assert.deepEqual(recorded, [['ee'.repeat(32), 1, ASSET, 250000000n, 5n]], 'the opening is recorded for the holdings scan');
  assert.equal(r.free, 2, 'counter 1 is skipped: its P2TR key has history');
  assert.ok(seen.includes(secret.saleKey(pw, 7).address) && !seen.includes(secret.saleKey(pw, 8).address), 'six quiet counters end the walk');
}
{
  chain();
  const r = await secret.saleKeys(tacitScan, pw, [], ASSET);
  assert.deepEqual(r, { keys: [], free: 0 }, 'a new wallet starts at counter 0');
}

// ── a first explorer that is down or erroring: the dapp's second explorer answers; both down is a failure, not "none" ──
{
  const two = { ...tacitScan, NET: { api: 'https://down.test/api', api2: API } };
  for (const kind of ['throws', '503']) {
    chain();
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://down.test')) {
        if (kind === 'throws') throw new TypeError('fetch failed');
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return inner(url, init);
    };
    assert.deepEqual(await secret.saleKeys(two, pw, [], ASSET, { addresses: [relayAddr] }), { keys: [], free: 0 }, `first explorer ${kind}: the second one answers`);
  }
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(secret.saleKeys(two, pw, [], ASSET), /fetch failed/, 'no explorer answering is a failed read, never "no take-outs"');
}

// ── exitToSaleKey ──
const NOT_NOW = 'The relay isn’t taking TAC out right now. Nothing was sent; try again in a few minutes.';
const SLOW = 'The relay hasn’t posted it yet and may still. Nothing else was sent; once it posts, the TAC shows here, ready to list.';
const TOTAL = 10_000_000_000n;   // 100 TAC: the 2.5 TAC taken out, the 15 TAC fee and the change
const notes = [{ asset: '0x' + ASSET, value: TOTAL.toString(), nf: '0x01', txid: 'aa'.repeat(32), leafIndex: 0 }];
const FEE = 1500000000n;
let log;
function stub({ fee = FEE, quoteFee = fee, quote = 'ok', submit = [], status = (n) => (n === 2 ? { carrier: 'cc'.repeat(32) } : { state: 'queued' }), wait = null } = {}) {
  log = { quotes: [], submits: 0, statuses: 0, proofs: 0, builds: [], posts: 0, opened: [] };
  client.relayInfo = async () => (fee == null ? null : { fees: { ['0x' + ASSET]: fee.toString() } });
  client.quote = async (body) => {
    log.quotes.push(body);
    if (quote === 'fail') throw new Error('quote table full');
    return { fee: quoteFee.toString(), address: relayAddr, bind: { txid: 'bb'.repeat(32), vout: 0 }, quoteId: 'q' + log.quotes.length, exitVout: 0 };
  };
  client.submit = async () => { const e = submit[log.submits++]; if (e) throw e; return { id: 's1' }; };
  client.relayStatus = async () => status(++log.statuses);
  client.walletNotes = async () => notes;
  client.anchorAndPaths = async (inputs) => (wait ? { wait, tip: 900010 } : { hAnchor: 900000, root: '0x00', notes: inputs, tip: 900010 });
  secret.poolClient.artifactBytes = async () => 0;
  secret.poolClient.system = async () => ({});
  pool.selectInputs = (live) => ({ inputs: live, total: live.reduce((t, x) => t + BigInt(x.value), 0n) });
  pool.buildSpendBody = (a) => { log.builds.push(a); return { exit: { exitVout: a.exit.exitVout, blinding: '0x' + '09'.padStart(64, '0') } }; };
  pool.prove = async () => { log.proofs++; return { payload: new Uint8Array(4), payloadHex: '00000000' }; };
}
const tacit = { DUST: 546, recordOpening: (...a) => log.opened.push(a), wallet: { pub: new Uint8Array(33), xonly() { log.posts++; throw new Error('SELF_POST'); } } };
const key = secret.saleKey(pw, 3);
const out = (opts = {}) => secret.exitToSaleKey(tacit, { poolWallet: pw, amount: 250000000n, asset: ASSET, key, ...opts });
const declined = (p, msg) => assert.rejects(p, (e) => e.relayDeclined === true && e.said === true && e.message === msg);
const conflict = (exitVout) => Object.assign(new Error('exit_vout is not free in the open carrier; re-sign with exitVout'), { status: 409, body: { exitVout } });

// The relay takes it out: the exit pays the sale key, the relay's fee is a pool output, the bind is the quote's.
stub();
store.clear();
let r = await out();
assert.deepEqual(r, { revealTxid: 'cc'.repeat(32), exitVout: 0, amount: 250000000n, fee: FEE });
assert.deepEqual(log.quotes, [{ asset: '0x' + ASSET, exitScriptPubKey: key.scriptPubKey }], 'the quote names the sale key’s script');
const b = log.builds[0];
assert.deepEqual(b.exit, { exitVout: 0, scriptPubKey: '0x' + key.scriptPubKey, value: 250000000n });
assert.equal(b.outputs.length, 3, 'padded to three pool outputs');
assert.deepEqual(b.outputs[0], { address: relayAddr, value: FEE }, 'the relay’s fee, paid in the pool');
assert.deepEqual(b.outputs.slice(1), [{ address: pw.internalAddress, network: 'mainnet', value: TOTAL - 250000000n - FEE }, { address: pw.internalAddress, network: 'mainnet', value: 0n }], 'change and padding to the internal address');
assert.equal(b.outputs.reduce((t, o) => t + o.value, 0n) + b.exit.value, TOTAL, 'outputs plus the exit are the inputs, exactly');
assert.deepEqual(b.bind, { txid: 'bb'.repeat(32), vout: 0 });
assert.equal(b.wallet, pw, 'change and padding go to the pool wallet');
assert.deepEqual(log.opened, [['cc'.repeat(32), 0, ASSET, 250000000n, 9n]], 'the exit’s opening is recorded under its outpoint');
assert.equal(log.posts, 0, 'nothing from the wallet’s address');
assert.ok(JSON.parse(store.get('tacit-pool-sale-keys-v1'))[pw.addressString.slice(-16)][3] > 0, 'the counter is held');
{
  chain();
  const r2 = await secret.saleKeys(tacitScan, pw, [], ASSET);
  assert.equal(r2.free, 0, 'counters below a held one stay free');
  stub(); store.clear();
  await secret.exitToSaleKey(tacit, { poolWallet: pw, amount: 250000000n, asset: ASSET, key: secret.saleKey(pw, 0) });
  chain();
  assert.equal((await secret.saleKeys(tacitScan, pw, [], ASSET)).free, 1, 'a held counter is skipped until its take-out shows on chain');
}

// No relay, a quote that fails twice, a fee far above the listed one: nothing is proved or posted.
stub({ fee: null }); await declined(out(), NOT_NOW);
assert.equal(log.proofs, 0); assert.equal(log.posts, 0); assert.equal(log.quotes.length, 0);
stub({ quote: 'fail' }); await declined(out(), NOT_NOW);
assert.equal(log.quotes.length, 2, 'asked once more after a moment'); assert.equal(log.proofs, 0); assert.equal(log.posts, 0);
stub({ quoteFee: FEE * 2n }); await assert.rejects(out(), (e) => e.feeMoved === FEE * 2n);
assert.equal(log.proofs, 0);

// The newest note is too young: { wait }, nothing proved.
stub({ wait: 2 });
assert.deepEqual(await out(), { wait: 2, tip: 900010 });
assert.equal(log.proofs, 0);

// The relay's carrier filled the assigned output first: the same spend, re-signed for the output it names.
stub({ submit: [conflict(2)] });
r = await out();
assert.equal(r.exitVout, 2);
assert.deepEqual(log.builds.map((x) => x.exit.exitVout), [0, 2]);
assert.equal(log.proofs, 2); assert.equal(log.submits, 2);
assert.deepEqual(log.opened[0].slice(0, 2), ['cc'.repeat(32), 2]);

// The quote ran out while proving: asked once more, with the same notes.
stub({ submit: [new Error('quote expired')] });
r = await out();
assert.equal(log.quotes.length, 2); assert.equal(log.proofs, 2); assert.equal(r.revealTxid, 'cc'.repeat(32));
assert.equal(log.builds[1].inputs, log.builds[0].inputs, 'the same notes');

// The relay never posts it: ends after its sixty polls, and never from the wallet.
stub({ status: () => ({ state: 'queued' }) });
await declined(out(), SLOW);
assert.equal(log.statuses, 60); assert.equal(log.posts, 0); assert.equal(log.opened.length, 0);

// The relay drops it because the notes are spent elsewhere, or for another reason.
stub({ status: () => ({ state: 'rejected', reason: 'nullifier already spent' }) });
await assert.rejects(out(), /already being spent by another payment/);
stub({ status: () => ({ state: 'dropped', reason: 'anchor expired' }) });
await assert.rejects(out(), /could not post it \(anchor expired\)\. Nothing was sent\./);
assert.equal(log.posts, 0);

// Confirmed with no carrier reported: done, and saleKeys finds the note from the chain.
stub({ status: () => ({ state: 'confirmed' }) });
r = await out();
assert.equal(r.revealTxid, null); assert.equal(log.opened.length, 0);

console.log('tac-sats-sale-key: all checks passed');
