#!/usr/bin/env node
// Buying a listed lot straight into the Bitcoin pool (dapp/sats/secret.js buyAndShield) checks the lot before anything is proved or paid:
// its ancestry must validate as a note of the asset (as every other buy checks), and a note homed to a pool deployment is refused.
// The explorer and the dapp's chain reads are stood in; the run ends at the first refusal, so no proof is built.
//   node tests/secret-buy-validates-lot.test.mjs
import assert from 'node:assert';
import { buyAndShield, pool } from '../dapp/sats/secret.js';
import { secp } from '../dapp/vendor/tacit-deps.min.js';

const ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const LOT = { txid: 'ab'.repeat(32), vout: 0, value: 546 };
const AMOUNT = 12345n, BLINDING = 987654321n;
const { cx, cy } = pool.commitXY(AMOUNT, '0x' + BLINDING.toString(16).padStart(64, '0'));
const commitment = secp.ProjectivePoint.fromAffine({ x: BigInt(cx), y: BigInt(cy) }).toRawBytes(true);
const sale = {
  asset_outpoint: { txid: LOT.txid, vout: LOT.vout, value: LOT.value },
  asset_opening: { amount: AMOUNT.toString(), blinding: BLINDING.toString(16).padStart(64, '0') },
  seller_pubkey: '02' + '11'.repeat(32), seller_asset_spend_sig: '00'.repeat(70), seller_payout_script: '0014' + '22'.repeat(20), min_price_sats: 1000,
};
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ vout: [{ value: LOT.value }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const tacitWith = (over) => ({
  NET: { api: 'https://esplora.test', api2: null },
  txOutputEnvelope: () => ({ opcode: 0x01, payload: new Uint8Array(0) }),
  getParentEnvelopeData: async () => ({ assetIdHex: ASSET, commitment }),
  wallet: { pub: new Uint8Array(33) },
  ...over,
});
const asked = [];
try {
  // A lot whose ancestry does not validate is refused, and the check ran on the listed outpoint.
  {
    const tacit = tacitWith({ requireValidatedLot: async (txid, vout, label) => { asked.push([txid, vout, label]); throw new Error(`${label} does not validate as this asset on Bitcoin, so it was not bought and nothing was sent`); } });
    await assert.rejects(buyAndShield(tacit, { status: { asset_id: ASSET }, sale, poolWallet: { addressString: 'x', network: 'mainnet' } }), /does not validate as this asset/);
    ok(asked.length === 1 && asked[0][0] === LOT.txid && asked[0][1] === LOT.vout, 'the listed outpoint was validated before the buy');
  }
  // A note homed to a pool deployment is refused before its ancestry is walked.
  {
    asked.length = 0;
    const tacit = tacitWith({ txOutputEnvelope: () => ({ opcode: 0x39, payload: new Uint8Array(0) }), requireValidatedLot: async (...a) => { asked.push(a); } });
    await assert.rejects(buyAndShield(tacit, { status: { asset_id: ASSET }, sale, poolWallet: { addressString: 'x', network: 'mainnet' } }), /bound to a pool deployment/);
    ok(asked.length === 0, 'a bound note is refused without walking its ancestry');
  }
} finally { globalThis.fetch = realFetch; }
console.log(`${n} checks`);
