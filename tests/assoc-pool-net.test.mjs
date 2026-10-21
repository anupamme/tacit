// dapp/assoc-pool-net.js against stand-in services: the approval service's lists and review status, the explorer's
// log pages (paging, a depositor filter, an empty answer, a log that arrives without its data), the entrypoint's terms,
// the relayer's fee and the margin put on it, and what a refusal looks like. No network.
//   node tests/assoc-pool-net.test.mjs
import assert from 'node:assert';
import { makeAssocNet, MAX_RELAY_BPS } from '../dapp/assoc-pool-net.js';
import { ETH_POOL, NATIVE, SEL, TOPIC } from '../dapp/assoc-pool.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const w32 = (x) => BigInt(x).toString(16).padStart(64, '0');
const pad = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const DEPOSITOR = '0x1111111111111111111111111111111111111111';
const hexBlock = (b) => '0x' + b.toString(16);
const depositLog = (i, { block = 100 + i, logIndex = 1, depositor = DEPOSITOR, broken = false } = {}) => ({
  address: ETH_POOL.pool, topics: [TOPIC.deposited, pad(depositor)], data: broken ? '' : '0x' + [1000 + i, 2000 + i, 5, 3000 + i].map(w32).join(''),
  blockNumber: hexBlock(block), logIndex: hexBlock(logIndex), transactionHash: '0x' + w32(9000 + i),
});
const withdrawLog = (i, { block = 200 + i, logIndex = 2 } = {}) => ({
  address: ETH_POOL.pool, topics: [TOPIC.withdrawn, pad(ETH_POOL.entrypoint)], data: '0x' + [7, 4000 + i, 5000 + i].map(w32).join(''),
  blockNumber: hexBlock(block), logIndex: hexBlock(logIndex), transactionHash: '0x' + w32(9500 + i),
});
const res = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('not json'); return body; } });

// ── the approval service ──
{
  const seen = [];
  const net = makeAssocNet({ rpc: async () => '0x', gapMs: 0, fetchImpl: async (url, init) => {
    seen.push({ url, h: init?.headers });
    if (url.endsWith('/mt-leaves')) return res({ aspLeaves: ['1', '22', '333'], stateTreeLeaves: ['4', '5'] });
    if (url.endsWith('/deposits-by-label')) return res([{ label: '22', reviewStatus: 'approved' }, { label: '7', reviewStatus: 'declined' }, { type: 'noise' }]);
    throw new Error('unexpected ' + url);
  } });
  const l = await net.leaves();
  assert.deepEqual(l.aspLeaves, [1n, 22n, 333n]);
  assert.deepEqual(l.stateLeaves, [4n, 5n]);
  assert.equal(seen[0].h['X-Pool-Scope'], String(ETH_POOL.scope));
  assert.ok(seen[0].url.startsWith('https://api.0xbow.io/1/public/'));
  const r = await net.reviews([22n, 7n, 8n]);
  assert.equal(r.get(22n), 'approved');
  assert.equal(r.get(7n), 'declined');
  assert.equal(r.has(8n), false);
  assert.equal(seen[1].h['X-Labels'], '22,7,8');
  assert.equal((await net.reviews([])).size, 0);
  ok('the lists and the review status are read with the pool scope; an unseen label is absent');

  const bad = makeAssocNet({ rpc: async () => '0x', fetchImpl: async () => res({ aspLeaves: ['1', 'x'], stateTreeLeaves: [] }) });
  await assert.rejects(() => bad.leaves(), /malformed approval list/);
  const bad2 = makeAssocNet({ rpc: async () => '0x', fetchImpl: async () => res({ aspLeaves: ['1'], stateTreeLeaves: [12] }) });
  await assert.rejects(() => bad2.leaves(), /malformed commitment list/);
  ok('a list with anything but decimal strings in it is refused');
}

// ── events: paging, the depositor filter, an empty answer, a log without data ──
{
  const asked = [];
  const all = Array.from({ length: 7 }, (_, i) => depositLog(i));
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams;
    asked.push(Object.fromEntries(q));
    if (q.get('module') === 'proxy') {
      // the receipt of the transaction whose log came without its data: the real log sits at another index
      return res({ result: { logs: [{ ...depositLog(3, { logIndex: 5 }), logIndex: '0x5' }] } });
    }
    let rows = all.slice();
    if (q.get('topic1')) rows = rows.filter((l) => l.topics[1] === q.get('topic1'));
    const page = Number(q.get('page')), size = Number(q.get('offset')), part = rows.slice((page - 1) * size, page * size);
    return res(part.length ? { status: '1', message: 'OK', result: part } : { status: '0', message: 'No records found', result: [] });
  };
  const net = makeAssocNet({ rpc: async () => null, gapMs: 0, fetchImpl });
  const raw = await net.logs({ topic0: TOPIC.deposited, pageSize: 3 });
  assert.equal(raw.length, 7);
  assert.deepEqual(asked.filter((a) => a.module === 'logs').map((a) => a.page), ['1', '2', '3']);
  assert.equal(asked[0].address, ETH_POOL.pool);
  assert.equal(asked[0].topic0, TOPIC.deposited);
  assert.equal(asked[0].topic1, undefined);
  ok('log pages are read until one comes back short; the range starts at the entrypoint\'s deploy block');

  asked.length = 0;
  const mine = await net.deposits({ depositor: DEPOSITOR });
  assert.equal(mine.length, 7);
  assert.equal(asked[0].topic1, pad(DEPOSITOR));
  assert.equal(asked[0].topic0_1_opr, 'and');
  assert.deepEqual(mine[0], { depositor: DEPOSITOR, commitment: 1000n, label: 2000n, value: 5n, precommitment: 3000n, block: 100, logIndex: 1, tx: '0x' + w32(9000) });
  assert.deepEqual(mine.map((d) => d.block), [100, 101, 102, 103, 104, 105, 106]);
  const none = await net.deposits({ depositor: '0x2222222222222222222222222222222222222222' });
  assert.deepEqual(none, []);
  ok('a depositor filter narrows the query and decodes each deposit; an account with none gets an empty list');

  // one log without its data: repaired from its receipt (the explorer's, when the node has forgotten it)
  const withBroken = [...all.slice(0, 3), depositLog(3, { broken: true }), ...all.slice(4)];
  const net2 = makeAssocNet({ rpc: async () => null, gapMs: 0, fetchImpl: async (url) => {
    const q = new URL(url).searchParams;
    if (q.get('module') === 'proxy') return res({ result: { logs: [{ ...depositLog(3), logIndex: '0x5' }] } });
    return res({ status: '1', message: 'OK', result: Number(q.get('page')) === 1 ? withBroken : [] });
  } });
  const fixed = await net2.deposits({});
  assert.equal(fixed.length, 7);
  assert.equal(fixed.find((d) => d.label === 2003n).logIndex, 5);
  // a broken log nobody can repair is dropped, not decoded into undefined fields
  const net3 = makeAssocNet({ rpc: async () => null, gapMs: 0, fetchImpl: async (url) => new URL(url).searchParams.get('module') === 'proxy' ? res({ result: null }) : res({ status: '1', message: 'OK', result: Number(new URL(url).searchParams.get('page')) === 1 ? withBroken : [] }) });
  assert.equal((await net3.deposits({})).length, 6);
  // the same log listed twice is one
  const net4 = makeAssocNet({ rpc: async () => null, gapMs: 0, fetchImpl: async (url) => res({ status: '1', message: 'OK', result: Number(new URL(url).searchParams.get('page')) === 1 ? [all[0], all[0], all[1]] : [] }) });
  assert.equal((await net4.deposits({})).length, 2);
  ok('a log that arrives without data is read again from its receipt, dropped if it cannot be, and a repeated one counts once');

  const failing = makeAssocNet({ rpc: async () => null, gapMs: 0, fetchImpl: async () => res({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }) });
  await assert.rejects(() => failing.deposits({}), /did not answer/);
  const limited = makeAssocNet({ rpc: async () => null, gapMs: 0, fetchImpl: async () => res({}, 500) });
  await assert.rejects(() => limited.deposits({}), /HTTP 500/);
  ok('a refused or failing explorer is an error, not an empty history');
}

// ── the chain: roots, counters, terms, spent ──
{
  const roots = Array.from({ length: 64 }, (_, i) => BigInt(1000 + i));
  const rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x64';
    if (method === 'eth_getTransactionReceipt') return null;
    const { to, data } = params[0];
    if (data.startsWith(SEL.currentRoot)) return '0x' + w32(777);
    if (data.startsWith(SEL.latestRoot)) return '0x' + w32(888);
    if (data.startsWith(SEL.nonce)) return '0x' + w32(6350);
    if (data.startsWith(SEL.currentTreeSize)) return '0x' + w32(13763);
    if (data.startsWith(SEL.roots)) return '0x' + w32(roots[parseInt(data.slice(10), 16)] ?? 0);
    if (data.startsWith(SEL.nullifierHashes)) return '0x' + w32(BigInt('0x' + data.slice(10)) === 55n ? 1 : 0);
    if (data.startsWith(SEL.assetConfig)) { assert.equal(to, ETH_POOL.entrypoint); assert.equal(data.slice(10), pad(NATIVE).slice(2)); return '0x' + [ETH_POOL.pool, 4_000_000_000_000_000n, 25, 500].map(w32).join(''); }
    throw new Error('unexpected call ' + data.slice(0, 10));
  };
  const net = makeAssocNet({ rpc, fetchImpl: async () => res({}) });
  assert.deepEqual(await net.head(), { stateRoot: 777n, aspRoot: 888n, nonce: 6350n, treeSize: 13763n, block: 100 });
  assert.equal(await net.stateRootKnown(777n), true);
  assert.equal(await net.stateRootKnown(1030n), true);
  assert.equal(await net.stateRootKnown(5n), false);
  assert.equal(await net.spent(55n), true);
  assert.equal(await net.spent(56n), false);
  ok('the head, a known state root (the current one or one of the last 64), and a spent nullifier are read from the chain');
  assert.deepEqual(await net.config(), { minDeposit: 4_000_000_000_000_000n, vettingBps: 25n, maxRelayBps: 500n });
  const down = makeAssocNet({ rpc: async () => { throw new Error('down'); }, fetchImpl: async () => res({}) });
  assert.deepEqual(await down.config(), { minDeposit: 10n ** 16n, vettingBps: 50n, maxRelayBps: BigInt(MAX_RELAY_BPS) });
  ok('the entrypoint\'s terms are read for ETH; the constants stand in when the read fails');
}

// ── a relayer: the fee, the margin on it, the cap, and a refusal ──
{
  const relayerFetch = (quoteBps, { feeReceiverAddress = '0xEC15c20015e72748F03065ed80c41cb882E3fB66', ok: up = true } = {}) => async (url, init) => {
    if (!up) throw new Error('unreachable');
    if (url.includes('/relayer/details')) return res({ feeBPS: '10', feeReceiverAddress, chainId: 1, assetAddress: NATIVE, minWithdrawAmount: '0', maxGasPrice: '40000000000' });
    if (url.endsWith('/relayer/quote')) { assert.deepEqual(JSON.parse(init.body), { chainId: 1, amount: '20000000000000000', asset: NATIVE }); return res({ baseFeeBPS: '10', feeBPS: String(quoteBps), gasPrice: '59375698', detail: {} }); }
    throw new Error('unexpected ' + url);
  };
  const rpc = async () => '0x' + [ETH_POOL.pool, 10n ** 16n, 50, 1000].map(w32).join('');
  const amount = 20_000_000_000_000_000n;
  const pick = (bps, o) => makeAssocNet({ rpc, gapMs: 0, fetchImpl: relayerFetch(bps, o) }).pickRelayer(amount);
  assert.equal((await pick(10)).bps, 12n);
  assert.equal((await pick(29)).bps, 35n);
  assert.equal((await pick(29)).quotedBps, 29n);
  assert.equal((await pick(900)).bps, 1000n);          // a fifth more would pass the cap: ask the cap itself
  assert.equal((await pick(1000)).bps, 1000n);
  assert.equal((await pick(1001)).bps, null);          // too small to relay at this gas
  const r = await pick(29);
  assert.equal(r.feeReceiver, '0xEC15c20015e72748F03065ed80c41cb882E3fB66');
  assert.equal(r.gasPrice, 59375698n);
  assert.equal(r.capBps, 1000n);
  await assert.rejects(() => pick(10, { feeReceiverAddress: 'nope' }), /no relayer answered: no fee address/);
  await assert.rejects(() => pick(10, { ok: false }), /no relayer answered: unreachable/);
  ok('a relayer\'s quote gets a fifth added within the entrypoint\'s cap, an amount over the cap is marked too small, a bad answer is skipped');

  const sent = [];
  const reqNet = (reply) => makeAssocNet({ rpc, gapMs: 0, fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return reply; }, relayers: ['https://relay.example'] }).relayerOf('https://relay.example');
  const body = { withdrawal: { processooor: ETH_POOL.entrypoint, data: '0x00' }, proof: { pi_a: ['1', '2', '1'] }, publicSignals: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n], scope: ETH_POOL.scope };
  const done = await reqNet(res({ success: true, txHash: '0xabc', requestId: 'r' })).request(body);
  assert.equal(done.txHash, '0xabc');
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['chainId', 'proof', 'publicSignals', 'scope', 'withdrawal']);
  assert.deepEqual(sent[0].body.publicSignals, ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(sent[0].body.scope, String(ETH_POOL.scope));
  assert.equal(sent[0].body.chainId, 1);
  assert.equal(sent[0].url, 'https://relay.example/relayer/request');
  await assert.rejects(() => reqNet(res({ message: 'Failed to parse request payload' }, 400)).request(body), /Failed to parse request payload/);
  await assert.rejects(() => reqNet(res({ success: false, error: 'the relay reverted' })).request(body), /the relay reverted/);
  await assert.rejects(() => reqNet(res(undefined, 500)).request(body), /refused \(HTTP 500\)/);
  ok('a withdrawal request is exactly the relayer\'s schema, with every number a string; its refusals come back as errors with its words');
}

// ── completeness against the pool's counters ──
{
  const evs = Array.from({ length: 5 }, (_, i) => depositLog(i));
  const rpc = (nonce, size) => async (method, params) => {
    if (method === 'eth_blockNumber') return '0x1';
    const data = params[0].data;
    if (data.startsWith(SEL.nonce)) return '0x' + w32(nonce);
    if (data.startsWith(SEL.currentTreeSize)) return '0x' + w32(size);
    return '0x' + w32(1);
  };
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams;
    const rows = q.get('topic0') === TOPIC.deposited ? evs : [withdrawLog(0), withdrawLog(1), withdrawLog(2)];
    return res({ status: '1', message: 'OK', result: Number(q.get('page')) === 1 ? rows : [] });
  };
  const whole = makeAssocNet({ rpc: rpc(5, 8), gapMs: 0, fetchImpl });
  const d = await whole.allDeposits();
  assert.equal(d.complete, true);
  assert.equal(d.events.length, 5);
  const wd = await whole.allWithdrawals();
  assert.equal(wd.complete, true);                                          // 5 deposits + 3 withdrawals = 8 leaves
  assert.equal(wd.events[0].spentNullifier, 4000n);
  const short = makeAssocNet({ rpc: rpc(6, 9), gapMs: 0, fetchImpl });
  assert.equal((await short.allDeposits()).complete, false);
  assert.equal((await short.allWithdrawals()).complete, true);
  assert.equal((await makeAssocNet({ rpc: rpc(5, 9), gapMs: 0, fetchImpl }).allWithdrawals()).complete, false);
  assert.equal((await whole.allWithdrawals({ from: ETH_POOL.entryBlock + 10 })).complete, null);          // a partial range cannot be counted
  ok('the deposit and withdrawal lists are checked against the pool\'s nonce and tree size, and a partial range says it cannot be checked');

  const hist = await makeAssocNet({ rpc: rpc(5, 8), gapMs: 0, fetchImpl: async (url) => {
    const q = new URL(url).searchParams;
    if (q.get('topic0') === TOPIC.withdrawn) { assert.equal(q.get('fromBlock'), '100'); return res({ status: '1', message: 'OK', result: Number(q.get('page')) === 1 ? [withdrawLog(0)] : [] }); }
    if (q.get('topic0') === TOPIC.ragequit) return res({ status: '0', message: 'No records found', result: [] });
    return res({ status: '1', message: 'OK', result: Number(q.get('page')) === 1 ? evs : [] });
  } }).historyOf(DEPOSITOR);
  assert.equal(hist.deposits.length, 5);
  assert.equal(hist.withdrawals.length, 1);
  assert.deepEqual(hist.ragequits, []);
  ok('an account\'s history is its deposits, the withdrawals since the first of them, and its exits');
}

console.log(`\n${n} groups passed`);
