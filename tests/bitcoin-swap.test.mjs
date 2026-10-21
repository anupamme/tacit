// The functions the swap page's Bitcoin lane calls in tacit.js (bitcoinSwapQuote, bitcoinSwapFundsNeeded, bitcoinSwap, bitcoinSwapOutcome), against a chain
// and a worker that are answered here: the quote is the pool's constant-product formula over the reserves with the swaps in flight counted, the swap
// refuses what it should before it sends anything, and a swap that goes out is a commit and a reveal, broadcast in that order, that spends the exact amount.
//   node tests/bitcoin-swap.test.mjs

const store = new Map();
const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el() };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', hash: '', search: '', pathname: '/', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true, language: 'en' }, configurable: true }); } catch {}
globalThis.addEventListener = () => {};
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
store.set('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; } };
const refuses = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e?.message)); } };

const SK = hexToBytes('0c'.repeat(32));
dapp.wallet.priv = SK; dapp.wallet.pub = secp.getPublicKey(SK, true); dapp.wallet.mode = 'passkey';
const ADDR = dapp.wallet.address();
const TETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const POOL_ID = 'aa'.repeat(32), RA = 20000n, RB = 182704255n;
const BLINDING = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;
const NOTE_TXID = 'ab'.repeat(32);

let head = { projected: { reserve_a: String(RA), reserve_b: String(RB) }, pending_count: 0 }, broadcasts = [], pools = [{ pool_id: POOL_ID, asset_a: TETH, asset_b: TAC, reserve_a: String(RA), reserve_b: String(RB), fee_bps: 30, validation: 'xcurve-verified' }];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = (opts.method || 'GET').toUpperCase();
  if (method === 'POST' && typeof opts.body === 'string' && opts.body.includes('"jsonrpc"')) return json({ jsonrpc: '2.0', id: JSON.parse(opts.body).id, result: '0x' + '00'.repeat(32) });
  if (u.includes('/amm/pools?')) return json({ pools });
  if (u.includes(`/amm/pool/${POOL_ID}/head`)) return json(head);
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: 10, halfHourFee: 5, hourFee: 2, economyFee: 1, minimumFee: 1 });
  if (u.includes('/scripthash/')) return json([]);
  if (u.includes(`/address/${ADDR}/utxo`)) return json([{ txid: 'ee'.repeat(32), vout: 0, value: 5_000_000, status: { confirmed: true } }]);
  if (method === 'POST' && u.endsWith('/tx')) { if (!broadcasts.includes(opts.body)) broadcasts.push(opts.body); return new Response('0'.repeat(64), { status: 200 }); }
  if (/\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(u)) return json({ spent: false });
  if (method === 'GET' && /\/tx\/[0-9a-f]{64}$/.test(u)) return broadcasts.length ? json({ txid: u.slice(-64), status: { confirmed: false }, vout: [], vin: [] }) : json({ error: 'Not found' }, 404);
  if (u.includes('/blocks/tip/height')) return new Response('800000', { status: 200 });
  if (u.includes('/amm/swap-accepted')) return json(swapAccepted);
  return json({ error: 'mock: no handler for ' + u }, 404);
};
let swapAccepted = { accepted: false };
dapp._testSetScanHoldingsOverride(() => new Map([[TETH, { balance: 2000n, utxos: [{ utxo: { txid: NOTE_TXID, vout: 1, value: 546 }, amount: 2000n, blinding: BLINDING }] }]]));

const curve = (din) => { const g = 9970n; return (RB * g * din) / (RA * 10000n + g * din); };

console.log('The quote:');
{
  const q = await dapp.bitcoinSwapQuote({ fromAid: TETH, toAid: TAC, amountIn: 2000n, slipBps: 100 });
  ok('0.00002 tETH quotes the pool formula\'s output', q?.kind === 'direct' && q.deltaOut === curve(2000n) && q.deltaOut === 16564166n, String(q?.deltaOut));
  ok('the least it takes is 1% under that', q.minOut === (q.deltaOut * 9900n) / 10000n && q.minOut === 16398524n);
  ok('the pool, its fee and the direction are named', q.poolId === POOL_ID && q.feeBps === 30 && q.direction === 0 && q.reserveA === RA && q.reserveB === RB);
  const back = await dapp.bitcoinSwapQuote({ fromAid: TAC, toAid: TETH, amountIn: 100000000n, slipBps: 50 });
  ok('the other way round it prices TAC into tETH', back.direction === 1 && back.deltaOut === (RA * 9970n * 100000000n) / (RB * 10000n + 9970n * 100000000n));
  ok('a pair with no pool is null', (await dapp.bitcoinSwapQuote({ fromAid: TETH, toAid: 'dd'.repeat(32), amountIn: 1000n })) === null);
  head = { projected: { reserve_a: '30000', reserve_b: '121802836' }, pending_count: 2 };
  const moved = await dapp.bitcoinSwapQuote({ fromAid: TETH, toAid: TAC, amountIn: 2000n, fresh: true });
  ok('swaps still in flight are counted: it quotes against the projected reserves', moved.pending === 2 && moved.reserveA === 30000n && moved.deltaOut < q.deltaOut, String(moved.deltaOut));
  head = { projected: { reserve_a: String(RA), reserve_b: String(RB) }, pending_count: 0 };
}

console.log('\nThe fees:');
{
  const need = await dapp.bitcoinSwapFundsNeeded();
  ok('it asks for sats in whole 500s, with room beyond the fees', need % 500 === 0 && need >= 3900, String(need));
}

console.log('\nThe swap refuses before it sends anything:');
{
  broadcasts = [];
  const ARGS = { fromAid: TETH, toAid: TAC, amountIn: 2000n, minOut: 16398524n };
  ok('a floor of nothing', await refuses(() => dapp.bitcoinSwap({ ...ARGS, minOut: 0n }), /rounds to zero/));
  ok('a floor above what the pool gives', await refuses(() => dapp.bitcoinSwap({ ...ARGS, minOut: 16564167n }), /moved past your floor/));
  ok('a pair with no pool', await refuses(() => dapp.bitcoinSwap({ ...ARGS, toAid: 'dd'.repeat(32) }), /no pool/));
  ok('more than the key holds', await refuses(() => dapp.bitcoinSwap({ ...ARGS, amountIn: 5000n }), /exceeds free balance/));
  ok('and nothing was broadcast by any of them', broadcasts.length === 0, `${broadcasts.length} broadcasts`);
}

console.log('\nA swap that goes out:');
{
  broadcasts = []; const stages = [];
  const r = await dapp.bitcoinSwap({ fromAid: TETH, toAid: TAC, amountIn: 2000n, minOut: 16398524n, onProgress: (s) => stages.push(s) });
  ok('it reports the check, the preparation and the send', ['check', 'prepare', 'send'].every((s) => stages.includes(s)), stages.join());
  ok('a note of exactly that amount needs no cutting: no prep transaction', r.prepTxid === null);
  ok('a commit and then a reveal are broadcast', broadcasts.length === 2, `${broadcasts.length} broadcasts`);
  ok('it returns the reveal\'s id and the floor it sent', typeof r.revealTxid === 'string' && r.revealTxid.length === 64 && r.floor === 16398524n, `${r.revealTxid} ${r.floor}`);
}

console.log('\nA swap from a bigger note:');
{
  dapp._testSetScanHoldingsOverride(() => new Map([[TETH, { balance: 5000n, utxos: [{ utxo: { txid: NOTE_TXID, vout: 1, value: 546 }, amount: 5000n, blinding: BLINDING }] }]]));
  broadcasts = []; const stages = [];
  const r = await dapp.bitcoinSwap({ fromAid: TETH, toAid: TAC, amountIn: 2000n, minOut: 16398524n, onProgress: (s) => stages.push(s) });
  ok('the exact amount is cut first (a transaction pair), then the swap goes out (another)', broadcasts.length === 4 && /^[0-9a-f]{64}$/.test(r.prepTxid || ''), `${broadcasts.length} broadcasts, prep ${r.prepTxid}`);
  ok('the swap is the one that spends the cut note, and its id is returned', r.revealTxid.length === 64 && r.revealTxid !== r.prepTxid);
}

console.log('\nWhat became of a sent swap:');
{
  swapAccepted = { accepted: false };
  ok('not yet seen: waiting', (await dapp.bitcoinSwapOutcome('cc'.repeat(32))).state === 'waiting');
  swapAccepted = { accepted: true, outcome: 'execute', delta_out_actual: '16500000' };
  const f = await dapp.bitcoinSwapOutcome('cc'.repeat(32));
  ok('filled, with what it got', f.state === 'filled' && f.got === 16500000n);
  swapAccepted = { accepted: true, outcome: 'pass_through', pass_reason: 'floor miss', refund_amount: '2000' };
  const p = await dapp.bitcoinSwapOutcome('cc'.repeat(32));
  ok('refunded, with why and how much', p.state === 'refunded' && p.reason === 'floor miss' && p.refund === 2000n);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
