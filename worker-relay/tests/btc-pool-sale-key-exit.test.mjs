// "To sats" take-out (dapp/sats/secret.js exitToSaleKey) against a real relayer over HTTP: the spend is built by the
// real pool model, the relayer runs its own checks on it (quoted P2WPKH script, exit boundary, fee note received
// under its viewing key, bind), carries it, and its carrier pays the sale key at the signed exit output. An exit
// output already taken in the open carrier is answered with a 409 and the spend is re-signed for the output named.
// The opening recorded for the exit opens its commitment and is the one recoverExit finds from the pool seed.
// The proof is a stub wire the stub verifier accepts; the pool view, chain and mempool are mocks.
//   node worker-relay/tests/btc-pool-sale-key-exit.test.mjs

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { secp, sha256, keccak_256, hexToBytes, bytesToHex } from '../../dapp/vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../../dapp/btc-shielded-pool.js';
import { HALO2_PROOF_LEN } from '../../dapp/btc-pool-halo2-prover.js';
import { parseTx } from '../src/lib/btc-pool-chain.js';
import { createRelayer } from '../src/lib/btc-pool-relayer.js';

const realTimeout = globalThis.setTimeout;
const ASSET_HEX = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const ASSET = '0x' + ASSET_HEX;
const FEE = 1_500_000_000n;
const TIP = 1000, ANCHOR = 996, ANCHOR_ROOT = '0a'.repeat(32);
const BTC_KEY = new Uint8Array(32).fill(5), POOL_SEED = new Uint8Array(32).fill(6);
const COINS = [
  { txid: 'ee'.repeat(32), vout: 1, value: 200_000 }, { txid: 'dd'.repeat(32), vout: 0, value: 50_000 },
  { txid: 'bb'.repeat(32), vout: 3, value: 20_000 },
  // A carrier's coins stay reserved until it confirms, so each batch below needs coins of its own.
  ...[1, 2, 3, 4, 5, 6].map((i) => ({ txid: i.toString(16).repeat(64).slice(0, 64), vout: i, value: 20_000 + 40_000 * i })),
];
const OK_PROOF = (() => { const w = new Uint8Array(HALO2_PROOF_LEN); w[0] = 1; w[1] = 2; return w; })();

function relayer() {
  const broadcasts = [];
  let clock = 1_700_000_000_000;
  const r = createRelayer({
    network: 'mainnet', btcKey: BTC_KEY, poolSeed: POOL_SEED, fees: { [ASSET]: FEE },
    pool: { tip: () => TIP, chainTip: () => TIP, rootAt: (h) => (h === ANCHOR ? ANCHOR_ROOT : null), isSpent: () => false, pendingSpend: () => null, aheadComplete: () => true },
    verifier: { enabled: true, verify: async ({ proof }) => proof[0] === 1 },
    chain: { utxos: async () => COINS.map((c) => ({ ...c, status: { confirmed: true } })), feeRate: async () => 2, broadcast: async (hex) => { broadcasts.push(hex); return 'ok'; }, txStatus: async () => null },
    mempool: { refresh: async () => {}, conflict: () => null },
    batchMs: 60_000, now: () => clock,
  });
  return { r, broadcasts, advance: (ms) => { clock += ms; } };
}

const R = relayer();
const server = createServer(R.r.wrap((req, res) => { res.writeHead(404); res.end(); }));
// The proving between the two takes below outlasts the server's 5 s keep-alive: it closes an idle socket just as fetch reuses it, and the
// take-out's first read fails with ECONNRESET. No timeout, so the test never depends on how fast the machine is.
server.keepAliveTimeout = 0;
await new Promise((ok) => server.listen(0, ok));
globalThis.__TACIT_BTC_POOL_RELAY_MAINNET__ = `http://127.0.0.1:${server.address().port}`;
const secret = await import('../../dapp/sats/secret.js');
const { pool } = secret;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, 0, ...a);       // the page's polling, at once

const pw = secret.poolWalletFor(new Uint8Array(32).fill(7), 'mainnet');
const other = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 }).walletFromSeed(new Uint8Array(32).fill(9), 'mainnet');
let leaf = 0;
const owned = (w, value) => { const n = pool.createNote(w.addressString, ASSET, value); const x = pool.tryReceive(w, { ...n, leafIndex: leaf++ }); assert.ok(x?.nkNote); return x; };
const client = secret.poolClientFor('mainnet');
let mine = [];
client.walletNotes = async () => mine;
client.anchorAndPaths = async (inputs) => ({ hAnchor: ANCHOR, root: '0x' + ANCHOR_ROOT, notes: inputs, tip: TIP });
secret.poolClient.artifactBytes = async () => 0;
secret.poolClient.system = async () => ({});
pool.prove = async (built) => { const payload = pool.assembleSpendEnvelope(built.body, OK_PROOF); return { payload, payloadHex: bytesToHex(payload) }; };

// The page's view: status polls carry the open batch once, as the relay does when its batch closes.
const submitted = [];
const realSubmit = client.submit, realStatus = client.relayStatus;
let carried = false, before = null;
client.submit = async (body) => { if (before) { const f = before; before = null; await f(); } submitted.push(body.payload); return realSubmit(body); };
client.relayStatus = async (id) => { if (!carried) { carried = true; R.advance(61_000); await R.r.flush(); } return realStatus(id); };
const opened = [];
const tacit = { DUST: 546, recordOpening: (...a) => opened.push(a), wallet: { pub: new Uint8Array(33), xonly() { throw new Error('SELF_POST'); } } };

try {
  // ── a take-out to sale key 0 ──
  mine = [owned(pw, 10_000_000_000n)];
  const key = secret.saleKey(pw, 0);
  const amount = 2_500_000_000n;
  const r = await secret.exitToSaleKey(tacit, { poolWallet: pw, amount, asset: ASSET_HEX, key });
  assert.equal(r.amount, amount); assert.equal(r.fee, FEE); assert.equal(r.exitVout, 0);
  const reveal = parseTx(hexToBytes(R.broadcasts.at(-1))).tx;
  assert.equal(r.revealTxid, reveal.txid, 'the relay’s carrier');
  assert.equal(bytesToHex(reveal.vout[r.exitVout].scriptPubKey), key.scriptPubKey, 'the carrier pays the sale key’s P2WPKH script');
  assert.equal(Number(reveal.vout[r.exitVout].value), 546);
  const sp = pool.parseSpend(hexToBytes(submitted.at(-1)), { full: true });
  const [, , asset, amt, blinding] = opened.at(-1);
  assert.deepEqual(opened.at(-1).slice(0, 3), [reveal.txid, 0, ASSET_HEX]);
  assert.equal(amt, amount);
  const C = pool.commitXY(amt, blinding);
  assert.equal(BigInt(C.cx), BigInt(sp.exit.cx)); assert.equal(BigInt(C.cy), BigInt(sp.exit.cy));
  assert.throws(() => pool.recoverExit(pw, hexToBytes(submitted.at(-1)), mine), /not recovered/, 'without the relay’s address the fee note hides the exit’s amount');
  const back = pool.recoverExit(pw, hexToBytes(submitted.at(-1)), mine, { addresses: [R.r.address] });
  assert.equal(BigInt(back.value), amount, 'recovered from the pool seed');
  assert.equal(BigInt(back.blinding), blinding);
  assert.equal(asset, ASSET_HEX);
  // Fee and change: one output decrypts to the relayer at the fee; the change returns to this wallet.
  const toMe = sp.outputs.map((o) => pool.tryReceive(pw, { ...o, leafIndex: leaf++ })).filter(Boolean).reduce((t, x) => t + BigInt(x.value), 0n);
  assert.equal(toMe, 10_000_000_000n - amount - FEE, 'change stays shielded');

  // ── the assigned exit output is taken first: 409, re-signed for the output the relay names ──
  carried = false;
  mine = [owned(pw, 10_000_000_000n)];
  const key1 = secret.saleKey(pw, 1);
  before = async () => {
    const spk = '0014' + '77'.repeat(20);
    const q = await R.r.quote({ asset: ASSET, exitScriptPubKey: spk });
    const b = pool.buildSpendBody({ asset: ASSET, hAnchor: ANCHOR, root: '0x' + ANCHOR_ROOT, inputs: [owned(other, 5_000_000_000n)], outputs: [{ address: q.address, value: FEE }, { address: other.internalAddress, network: 'mainnet', value: 5_000_000_000n - FEE - 1n }], wallet: other, bind: q.bind, exit: { exitVout: q.exitVout, scriptPubKey: '0x' + spk, value: 1n } });
    await R.r.submit({ payload: bytesToHex(pool.assembleSpendEnvelope(b.body, OK_PROOF)), quoteId: q.quoteId });
  };
  const r1 = await secret.exitToSaleKey(tacit, { poolWallet: pw, amount, asset: ASSET_HEX, key: key1 });
  assert.equal(r1.exitVout, 1, 'the output the relay named');
  const reveal1 = parseTx(hexToBytes(R.broadcasts.at(-1))).tx;
  assert.equal(bytesToHex(reveal1.vout[1].scriptPubKey), key1.scriptPubKey);
  assert.equal(bytesToHex(reveal1.vout[0].scriptPubKey), '0014' + '77'.repeat(20), 'the other take-out keeps its output');
  assert.deepEqual(opened.at(-1).slice(0, 2), [reveal1.txid, 1]);

  // ── a relay that never carries it: declined, nothing from the wallet ──
  carried = true;
  mine = [owned(pw, 10_000_000_000n)];
  await assert.rejects(secret.exitToSaleKey(tacit, { poolWallet: pw, amount, asset: ASSET_HEX, key: secret.saleKey(pw, 2) }), (e) => e.relayDeclined === true && /may still/.test(e.message));
  console.log('btc-pool-sale-key-exit: all checks passed');
} finally {
  server.close();
}
