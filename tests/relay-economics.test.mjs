// The relay economics endpoint's logic (worker/src/relay-economics.js): the ledger a heartbeat carries is copied field by field, the week sums
// add up, a log scan never skips a range and calls itself whole, and the chain read builds what the page shows from an injected RPC.
// Run: node tests/relay-economics.test.mjs
import { keccak_256 } from '@noble/hashes/sha3';
import { TOPIC, DEFAULTS, sanitizeLedger, sumDays, scanLogs, readChain, readTips, buildEconomics } from '../worker/src/relay-economics.js';
import { encSetShares } from '../dapp/splitter/abi.js';

let n = 0, failed = 0;
const ok = (c, m) => { n++; if (!c) { failed++; console.log('  FAIL -', m); } else console.log('  ok -', m); };
const topic = (sig) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex');
const W = (v) => BigInt(v).toString(16).padStart(64, '0');
const E = 10n ** 18n;

ok(TOPIC.bought === topic('Bought(uint8,uint256,uint256)') && TOPIC.wrappedWithTip === topic('WrappedWithTip(bytes32,uint256,uint256,address)'), 'the two event topics are the keccak of their signatures');

// ── sanitize ──
const day = (o = {}) => ({ settled: 10, priced: 6, unpriced: 3, proveOnly: 1, feeUsd: { eth: 5, converted: 2, tac: 1, other: 0.5 }, gasEth: 0.01, proveIn: 20, buybackEth: 0.002, splitterSends: 1, ...o });
const good = { since: '2026-10-15T10:00:00.000Z', cfg: { buybackBps: 1000, buybackKeepEth: 0.002, splitter: '0x' + '5'.repeat(40), buyback: DEFAULTS.buyback, evil: 'x' }, owedEth: 0.001, days: { '2026-10-14': day(), '2026-10-15': day({ settled: 4 }) }, secret: 'x' };
const s = sanitizeLedger(good);
ok(s.cfg.buybackBps === 1000 && s.cfg.evil === undefined && s.secret === undefined && s.days['2026-10-15'].settled === 4, 'a ledger is copied field by field: what is not named is dropped');
ok(sanitizeLedger(null) === null && sanitizeLedger('x') === null && sanitizeLedger([1]) === null, 'a ledger that is not an object is dropped');
const bad = sanitizeLedger({ since: 'yesterday', owedEth: -3, cfg: { buybackBps: 'lots', splitter: 'not an address' }, days: { today: day(), '2026-10-15': { settled: Infinity, feeUsd: { eth: 'x' } } } });
ok(bad.since === null && bad.owedEth === 0 && bad.cfg.buybackBps === 0 && bad.cfg.splitter === null && !('today' in bad.days) && bad.days['2026-10-15'].settled === 0 && bad.days['2026-10-15'].feeUsd.eth === 0, 'junk values read as zero or nothing, and a day not dated is dropped');
const many = { days: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`2026-09-${String(i + 1).padStart(2, '0')}`, day()])) };
ok(Object.keys(sanitizeLedger(many).days).length === 10, 'no more than ten days are kept');

// ── week sums ──
const t = sumDays(s.days, 7);
ok(t.days === 2 && t.settled === 14 && t.feeUsd.eth === 10 && t.feeUsd.convertible === 14 && t.proveIn === 40 && t.buybackEth === 0.004, `the days add up (${JSON.stringify(t.feeUsd)})`);
ok(sumDays({}).settled === 0 && sumDays(undefined).days === 0, 'no days sum to nothing');

// ── a scan never skips a range ──
const logsAt = (a, b) => [{ blockNumber: '0x' + a.toString(16), data: '0x', topics: [] }];
let calls = [];
const goodRpc = async (m, p) => { calls.push(p[0].fromBlock); return logsAt(parseInt(p[0].fromBlock, 16)); };
let r = await scanLogs(goodRpc, {}, 100, 350, 100);
ok(r.complete && r.scanned === 350 && r.logs.length === 3 && calls.join() === '0x64,0xc8,0x12c', 'a scan covers every range once, oldest first');
r = await scanLogs(async (m, p) => (parseInt(p[0].fromBlock, 16) <= 250 && parseInt(p[0].toBlock, 16) >= 250 ? null : logsAt(parseInt(p[0].fromBlock, 16))), {}, 100, 350, 100, 40);
ok(!r.complete && r.scanned >= 199 && r.scanned < 250 && r.logs.length >= 1, `a range that keeps failing stops the scan before it, and says how far it got (${r.scanned})`);
let wide = 0;
r = await scanLogs(async (m, p) => { const a = parseInt(p[0].fromBlock, 16), b = parseInt(p[0].toBlock, 16); if (b - a + 1 > 30) { wide++; return null; } return [{ blockNumber: '0x' + a.toString(16), data: '0x', topics: [] }]; }, {}, 100, 259, 160, 10);
ok(r.complete && r.scanned === 259 && r.logs.map((l) => parseInt(l.blockNumber, 16)).join() === '100,120,140,160,180,200,220,240' && wide === 7, `a range the nodes refuse as too wide is split in halves until they take it (${wide} refusals, ${r.logs.length} pieces, in order)`);
r = await scanLogs(goodRpc, {}, 500, 400, 100);
ok(r.complete && r.logs.length === 0 && r.scanned === 499, 'nothing to scan is complete');

// ── the chain read ──
const SETTLE = DEFAULTS.settle.toLowerCase(), RELAY = DEFAULTS.relay.toLowerCase(), BB = DEFAULTS.buyback.toLowerCase(), SPL = '0x' + '5'.repeat(40);
const sharesRet = '0x' + encSetShares([DEFAULTS.relay, DEFAULTS.settle, DEFAULTS.buyback], [63n, 27n, 10n]).slice(10);   // setShares' arguments are shares()' return: two arrays behind two offsets
const fakeRpc = ({ bought = [], tips = [], failBuy = false, head = 26_400_000 } = {}) => async (method, params) => {
  const p = params[0];
  if (method === 'eth_blockNumber') return '0x' + head.toString(16);
  if (method === 'eth_getBalance') return '0x' + ({ [SETTLE]: 3n * E / 1000n, [RELAY]: 12n * E / 1000n, [BB]: E / 100n, [SPL]: E / 50n }[String(p).toLowerCase()] ?? 0n).toString(16);
  if (method === 'eth_call') {
    if (String(p.data).startsWith('0x70a08231')) return '0x' + (25n * E).toString(16);                       // PROVE balanceOf
    if (p.data === '0x03314efa') return 'SHARES';
  }
  if (method === 'eth_getLogs') {
    const inRange = (l) => parseInt(l.blockNumber, 16) >= parseInt(p.fromBlock, 16) && parseInt(l.blockNumber, 16) <= parseInt(p.toBlock, 16);
    if (String(p.address).toLowerCase() === BB) return failBuy ? null : bought.filter(inRange);
    return tips.filter(inRange);
  }
  return null;
};
const buyLog = (block, ethIn, tacOut) => ({ blockNumber: '0x' + block.toString(16), data: '0x' + W(ethIn) + W(tacOut), topics: [TOPIC.bought, '0x' + W(0)] });
const tipLog = (tip, to) => ({ blockNumber: '0x' + (26_390_000).toString(16), data: '0x' + W(E) + W(tip), topics: [TOPIC.wrappedWithTip, '0x' + W(1), '0x' + '00'.repeat(12) + to.slice(2).toLowerCase()] });
let rpc = fakeRpc({ bought: [buyLog(26_080_411, 1234000000000000n, 5n * E)], tips: [tipLog(300000000000000n, '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2'), tipLog(200000000000000n, '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2'), tipLog(100000000000000n, SPL)] });
let c = await readChain({ rpc, now: 1_000, addrs: {} });
ok(c.wallets.settle.eth === 0.003 && c.wallets.relay.eth === 0.012 && c.wallets.relay.prove === 25, 'the two wallets and the relay wallet\'s PROVE are read');
ok(c.buyback.buys === 1 && c.buyback.ethSpent === 0.001234 && c.buyback.tacBought === 5 && c.buyback.ethHeld === 0.01 && c.buyback.complete && c.buyback.lastBuyBlock === 26_080_411, 'the buyback\'s buys are summed from its events');
const tips = await readTips({ rpc, now: 1_000 });
ok(tips.wraps === 3 && tips.eth === 0.0006 && tips.byRecipient[0].eth === 0.0005 && tips.complete, 'the thirty days of tips are counted and grouped by who got them');
ok(!('tips' in c), 'the chain read does not wait for the tips');
ok(c.splitter === null, 'with no splitter configured there is none');

// a failed scan keeps what was read, a later one carries on from there, and totals are never counted twice
const failed1 = await readChain({ rpc: fakeRpc({ failBuy: true }), now: 2_000 });
ok(failed1.buyback.complete === false && failed1.buyback.buys === 0 && failed1.buyback.scanned === DEFAULTS.buybackFromBlock - 1, 'a failed scan says it is incomplete and does not move its marker');
const later = (head) => fakeRpc({ head, bought: [buyLog(26_080_411, 1234000000000000n, 5n * E), buyLog(26_450_000, E / 100n, 2n * E)] });
const again = await readChain({ rpc: later(26_500_000), prev: c, now: 3_000 });
ok(again.buyback.buys === 2 && again.buyback.complete && again.buyback.scanned === 26_500_000 && again.buyback.lastBuyBlock === 26_450_000, 'a scan continues from the last block it reached and adds to the totals');
const noNew = await readChain({ rpc: later(26_500_000), prev: again, now: 4_000 });
ok(noNew.buyback.buys === 2 && noNew.buyback.scanned === 26_500_000, 'nothing already counted is counted again');
const noTips = await readTips({ rpc: async () => null });
ok(noTips === null, 'tips that cannot be read are null, not zero');
const partialTips = await readTips({ rpc: async (m, p) => (m === 'eth_getLogs' ? null : fakeRpc()(m, p)) });
ok(partialTips.complete === false, 'tips read only in part say so');

rpc = async (m, p) => { const r = await fakeRpc()(m, p); return r === 'SHARES' ? sharesRet : r; };
const withSplitter = await readChain({ rpc, addrs: { splitter: SPL } });
ok(withSplitter.splitter.address === SPL && withSplitter.splitter.ethHeld === 0.02 && withSplitter.splitter.shares.length === 3 && withSplitter.splitter.shares[0].percent === '63' && withSplitter.splitter.shares[2].percent === '10', 'a configured splitter shows what it holds and who it pays, in percent');
const dead = await readChain({ rpc: async () => null });
ok(dead.wallets.settle.eth === null && dead.buyback.complete === true && dead.head === null && dead.unread === true, 'a chain that does not answer gives nulls and says it was not read, not a crash');
const partial = await readChain({ rpc: async (m, p) => (m === 'eth_getBalance' ? null : fakeRpc()(m, p)), prev: c, now: 9_000 });
ok(partial.wallets.settle.eth === 0.003 && partial.wallets.relay.eth === 0.012 && partial.buyback.ethHeld === 0.01 && partial.unread === false, 'a figure that could not be read keeps the last one that could');

// ── the response ──
const resp = buildEconomics({ ledger: s, heartbeatAt: 1_000_000, chain: c, tips, now: 1_000_000 + 60e3 });
ok(resp.ledger.stale === false && resp.ledger.recent.length === 2 && resp.ledger.week.settled === 14 && !('days' in resp.ledger) && resp.chain.wallets === c.wallets && resp.chain.tips === tips, 'the response carries the recent days, the week, and the chain facts');
ok(buildEconomics({ ledger: s, heartbeatAt: 1_000_000, now: 1_000_000 + 11 * 60e3 }).ledger.stale === true, 'a ledger whose heartbeat is ten minutes old is marked stale');
ok(buildEconomics({ ledger: s, now: 5 }).ledger.stale === true && buildEconomics({}).ledger === null, 'no heartbeat time is stale, and no ledger is null');

console.log(failed ? `\n${failed} FAILED (${n} checks)` : `\nall ${n} relay-economics checks passed`);
process.exit(failed ? 1 : 0);
