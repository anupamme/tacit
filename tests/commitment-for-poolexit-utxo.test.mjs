// commitmentForUtxo must resolve an exit of the Bitcoin shielded pool (a T_BTC_SPEND, 0x6D, output). Without it every
// route that resolves a note's commitment (listings, preauth sales, intents, bids, AMM inputs) answers "unsupported
// envelope opcode" for TAC that has left the pool, so it cannot be sold or traded on the market at all.
// The envelope cannot say whether the pool accepted the spend, so the answer comes from the pool service's record of
// the exit and never from the envelope's own bytes.
// Offline: node tests/commitment-for-poolexit-utxo.test.mjs
import { bytesToHex } from '@noble/hashes/utils';
const worker = await import('../worker/src/index.js');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };

const xonly = new Uint8Array(32).fill(5);
// A pool spend's envelope: opcode 0x6D then its body. Only the opcode is read here.
const payload = new Uint8Array([0x6d, ...new Uint8Array(40).fill(0x77)]);
// tapscript: <xonly> OP_CHECKSIG OP_FALSE OP_IF <"TACIT"> <0x01> <payload in one PUSHDATA2> OP_ENDIF
const envScript = bytesToHex(new Uint8Array([32, ...xonly, 0xac, 0x00, 0x63, 5, ...new TextEncoder().encode('TACIT'), 1, 1, 0x4d, payload.length & 255, payload.length >> 8, ...payload, 0x68]));
const TXID = 'cd'.repeat(32);
const ASSET = '0x' + 'f0'.repeat(32);
const CX = '0x' + '33'.repeat(32);
const CY_EVEN = '0x' + '55'.repeat(31) + '00';
const CY_ODD = '0x' + '55'.repeat(31) + '01';
const e = { REGISTRY_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

let asked = [];
// The parent transaction from the explorer, and the pool service's answer for the exit.
function serve(pool) {
  asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/btc-pool/exit/')) { asked.push(u); return typeof pool === 'function' ? pool(u) : json(pool); }
    return json({ txid: TXID, vin: [{ witness: ['00', envScript, 'c0'] }] });
  };
}
const rec = (over = {}) => ({ exists: true, txid: TXID, vout: 0, height: 970953, asset: ASSET, Cx: CX, Cy: CY_EVEN, ...over });
const rejects = async (p, re) => { try { await p; return false; } catch (x) { return re.test(String(x.message)); } };

serve(rec());
const r0 = await worker.commitmentForUtxo(e, TXID, 0, 'mainnet');
ok('an accepted exit resolves instead of throwing "unsupported envelope opcode"', !!r0);
ok('the asset is the pool record\'s, without the 0x', r0.asset_id === 'f0'.repeat(32));
ok('even cy -> 0x02 prefix then cx', r0.commitment === '02' + '33'.repeat(32));
ok('the mainnet pool service is asked about this output', asked.length === 1 && asked[0] === `https://tacit-btc-pool-mainnet.onrender.com/btc-pool/exit/${TXID}/0`, asked.join(','));

serve(rec({ Cy: CY_ODD }));
const r1 = await worker.commitmentForUtxo(e, TXID, 0, 'mainnet');
ok('odd cy -> 0x03 prefix', r1.commitment === '03' + '33'.repeat(32));

// Upper-case hex and a vout other than 0 (an exit can be at any output) are read the same way.
serve(rec({ vout: 2, Cx: CX.toUpperCase().replace('0X', '0x'), asset: ASSET.toUpperCase().replace('0X', '0x') }));
const r2 = await worker.commitmentForUtxo(e, TXID, 2, 'mainnet');
ok('vout 2 resolves; hex case does not matter', r2.commitment === '02' + '33'.repeat(32) && r2.asset_id === 'f0'.repeat(32) && asked[0].endsWith('/2'));

serve(rec({ exists: false, height: 970950 }));
ok('an exit the pool has not recorded is not a note', await rejects(worker.commitmentForUtxo(e, TXID, 0, 'mainnet'), /not an accepted pool exit/));
serve(rec({ txid: 'ab'.repeat(32) }));
ok('a record for another transaction is refused', await rejects(worker.commitmentForUtxo(e, TXID, 0, 'mainnet'), /not an accepted pool exit/));
serve(rec({ vout: 1 }));
ok('a record for another output is refused', await rejects(worker.commitmentForUtxo(e, TXID, 0, 'mainnet'), /not an accepted pool exit/));
serve(rec({ Cx: '0x1234' }));
ok('a malformed commitment is refused', await rejects(worker.commitmentForUtxo(e, TXID, 0, 'mainnet'), /malformed exit record/));
serve(rec({ asset: null }));
ok('a record with no asset is refused', await rejects(worker.commitmentForUtxo(e, TXID, 0, 'mainnet'), /malformed exit record/));
serve(() => new Response('busy', { status: 503 }));
ok('a pool service that errors is not an answer', await rejects(worker.commitmentForUtxo(e, TXID, 0, 'mainnet'), /did not answer \(HTTP 503\)/));
serve(() => { throw new Error('socket hang up'); });
ok('a pool service that cannot be reached is not an answer', await rejects(worker.commitmentForUtxo(e, TXID, 0, 'mainnet'), /did not answer \(socket hang up\)/));

// Other networks and deployments name their own pool service.
serve(rec());
await worker.commitmentForUtxo({ ...e, BTC_POOL_API_MAINNET: 'https://pool.example/' }, TXID, 0, 'mainnet');
ok('a deployment can name the mainnet pool service (a trailing slash is dropped)', asked[0] === `https://pool.example/btc-pool/exit/${TXID}/0`, asked[0]);
await worker.commitmentForUtxo(e, TXID, 0, 'signet');
ok('signet asks the signet pool service', asked.at(-1) === `https://tacit-btc-pool.onrender.com/btc-pool/exit/${TXID}/0`, asked.at(-1));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
