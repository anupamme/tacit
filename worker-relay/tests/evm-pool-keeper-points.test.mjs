// The keeper posts a catch-up point when the pool has grown enough, or the newest point is old, and otherwise leaves the
// registry alone; a chain without the registry is skipped; a failed send waits before another try.
// Usage: node tests/evm-pool-keeper-points.test.mjs
import { makePointPoster } from '../src/lib/evm-pool-keeper-points.js';

let failures = 0, passed = 0;
const ok = (c, m, x = '') => { console.log(`${c ? 'ok' : 'not ok'} - ${m}${x ? '  ' + x : ''}`); c ? passed++ : failures++; };

const cfg = { pointsAddress: '0x00000000C3267616ED5E0DAA6F6490D109d6844D', pointsEvery: 2000, pointsMaxAgeSecs: 86400, pointsGas: 2500000n };
const tree = (size) => ({ size, toJSON: () => ({ filled: Array.from({ length: 32 }, (_, i) => String(BigInt(size) * 1000n + BigInt(i))) }) });
const synced = (size, block) => ({ confirmed: { tree: tree(size), block } });
function fakeChain({ code = true, latest = 0, postedAt = 0, front = true, rich = true, fail = false } = {}) {
  const sent = [];
  return {
    sent,
    hasCode: async () => code,
    pointLatest: async () => latest,
    pointPostedAt: async () => postedAt,
    canFront: async () => ({ ok: front, balance: rich ? 10n ** 18n : 10n, need: 10n ** 15n }),
    send: async (fn, args, opts) => { if (fail) throw new Error('execution reverted: Known()'); sent.push({ fn, args, opts }); return '0xhash' + sent.length; },
  };
}
let t = 1_000_000_000_000;
const now = () => t;

{
  const chain = fakeChain(), p = makePointPoster({ chain, cfg, now });
  ok(await p.maybePost(synced(400, 123)) === '0xhash1', 'the first point is posted whatever the count');
  const s = chain.sent[0];
  ok(s.fn === 'checkpoints.post' && s.args[0] === 400n && s.args[1] === 123n && s.args[2].length === 32 && s.args[2][5] === `0x${(400n * 1000n + 5n).toString(16).padStart(64, '0')}` && s.opts.gas === 2500000n, 'with the count, the block, the edge as 32 words and the gas', [s.args[0], s.args[1], s.args[2][5]].map(String).join(" "));
}
{
  const chain = fakeChain({ latest: 10000, postedAt: t / 1000 - 3600 }), p = makePointPoster({ chain, cfg, now });
  ok((await p.maybePost(synced(11000, 900))) === null && !chain.sent.length, 'a pool 1000 leaves past a point an hour old: nothing is posted');
  ok((await p.maybePost(synced(12000, 950))) === '0xhash1', '2000 leaves past it: posted');
  t += 601_000;
  const stale = fakeChain({ latest: 12000, postedAt: t / 1000 - 90_000 }), q = makePointPoster({ chain: stale, cfg, now });
  ok((await q.maybePost(synced(12002, 1000))) === null && !stale.sent.length, 'one pair past a point a day old is not worth a post');
  ok((await q.maybePost(synced(12200, 1000))) === '0xhash1', 'two hundred leaves past a point a day old: posted');
  ok((await q.maybePost(synced(12400, 1001))) === null && stale.sent.length === 1, 'and not again within ten minutes');
  ok((await makePointPoster({ chain: fakeChain({ latest: 12000 }), cfg, now }).maybePost(synced(12000, 1000))) === null, 'nothing new to post at the same count');
}
{
  const chain = fakeChain({ code: false }), p = makePointPoster({ chain, cfg, now });
  ok((await p.maybePost(synced(400, 123))) === null && !chain.sent.length, 'a chain without the registry is left alone');
  ok((await makePointPoster({ chain: fakeChain(), cfg: { ...cfg, pointsAddress: null }, now }).maybePost(synced(400, 123))) === null, 'and so is one configured off');
  ok((await makePointPoster({ chain: fakeChain({ front: false }), cfg, now }).maybePost(synced(400, 123))) === null, 'a keeper short of ETH posts nothing');
  const logs = [], poor = makePointPoster({ chain: fakeChain({ rich: false }), cfg, now, log: (m) => logs.push(m) });
  ok((await poor.maybePost(synced(400, 123))) === null && /holds 10 wei/.test(logs.join()), 'and one that could afford a post but not with room to spare posts nothing, and says why', logs.join());
  // A keeper that started before the registry was deployed looks again, not never.
  let has = false, asked = 0;
  const late = fakeChain(); late.hasCode = async () => { asked++; return has; };
  let clock = t; const lp = makePointPoster({ chain: late, cfg, now: () => clock });
  ok((await lp.maybePost(synced(400, 123))) === null && asked === 1, 'before the registry has code, nothing is posted');
  clock += 10 * 60_000; has = true;
  ok((await lp.maybePost(synced(400, 123))) === null && asked === 1, 'it is not asked again within half an hour');
  clock += 31 * 60_000;
  ok((await lp.maybePost(synced(400, 123))) === '0xhash1' && asked === 2, 'and once it has code, the next look finds it and posts');
  // What is posted is the tree as it was when the sync returned, not as it is by the time the chain has been asked.
  let live = 400; const moving = { get size() { return live; }, toJSON: () => ({ filled: Array.from({ length: 32 }, (_, i) => String(BigInt(live) * 1000n + BigInt(i))) }) };
  const slow = fakeChain(); slow.pointLatest = async () => { live = 600; return 0; };
  const sp = makePointPoster({ chain: slow, cfg, now });
  await sp.maybePost({ confirmed: { tree: moving, block: 123 } });
  const sent = slow.sent[0]?.args;
  ok(sent && sent[0] === 400n && sent[2][0] === `0x${(400n * 1000n).toString(16).padStart(64, '0')}`, 'a tree that grows while the chain is asked still posts one moment’s size and edge together', sent && `${sent[0]} ${sent[2][0].slice(-8)}`);
  const failing = fakeChain({ fail: true }), f = makePointPoster({ chain: failing, cfg, now });
  ok((await f.maybePost(synced(400, 123))) === null, 'a post that reverts (someone posted this count first) is logged, not thrown');
  ok((await makePointPoster({ chain: fakeChain(), cfg, now }).maybePost(synced(401, 123))) === null, 'an odd count is never posted');
  ok((await makePointPoster({ chain: fakeChain(), cfg, now }).maybePost({ tree: tree(400) })) === null, 'a sync without the confirmed tree posts nothing');
}
{
  // The registry keeps one pool's points: a keeper for another pool on the chain (the TAC pool) posts nothing to it, and looks no more.
  const ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', TAC_POOL = '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe';
  let asked = 0;
  const other = { ...fakeChain(), pool: TAC_POOL, pointPool: async () => { asked++; return ETH_POOL; } }, logs = [];
  let clock = t; const op = makePointPoster({ chain: other, cfg, now: () => clock, log: (m) => logs.push(m) });
  ok((await op.maybePost(synced(400, 123))) === null && !other.sent.length && /keeps pool 0x000000c2/.test(logs.join()), 'a keeper for another pool posts nothing to the registry, and says why', logs.join());
  clock += 2 * 3600_000;
  ok((await op.maybePost(synced(4000, 999))) === null && asked === 1 && !other.sent.length, 'and does not ask again');
  const own = { ...fakeChain(), pool: ETH_POOL, pointPool: async () => ETH_POOL.toLowerCase() };
  ok((await makePointPoster({ chain: own, cfg, now }).maybePost(synced(400, 123))) === '0xhash1', "the registry's own pool's keeper still posts");
  const blind = { ...fakeChain(), pool: ETH_POOL, pointPool: async () => { throw new Error('node down'); } };
  ok((await makePointPoster({ chain: blind, cfg, now }).maybePost(synced(400, 123))) === null && !blind.sent.length, "a registry whose pool cannot be read is not posted to");
}
// ── the hub: every pool's points but the ETH pool's (whose registry the hub reads through) ──
const HUB = '0x00000000C824B4F120C03f4Bdd4Bf4656232E835', ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
const USDC_POOL = '0x6C0bE904c0d3a9eeA3a7a1f2AE3C4e8bb2fBc0c1';
const hcfg = { ...cfg, pointsHub: HUB };
// A chain whose registry keeps the ETH pool's points and whose hub has code (or not yet): `pool` is the pool this keeper serves.
function hubChain({ pool = USDC_POOL, regCode = true, hubCode = true, hubLatest = 0, hubPostedAt = 0, regLatest = 0, rich = true } = {}) {
  const c = fakeChain({ latest: regLatest, rich }), asked = { reg: 0, hub: 0, pool: 0 };
  c.pool = pool;
  c.hasCode = async (a) => { if (a === cfg.pointsAddress) { asked.reg++; return regCode; } if (a === HUB) { asked.hub++; return typeof hubCode === 'function' ? hubCode() : hubCode; } return false; };
  c.pointPool = async () => { asked.pool++; return ETH_POOL; };
  c.hubLatest = async () => hubLatest;
  c.hubPostedAt = async () => hubPostedAt;
  c.asked = asked;
  return c;
}
{
  const chain = hubChain(), logs = [], p = makePointPoster({ chain, cfg: hcfg, now, log: (m) => logs.push(m) });
  ok((await p.maybePost(synced(400, 123))) === '0xhash1' && p.target() === 'hub', "a token pool's keeper posts its first point to the hub", logs.join(' | '));
  const s = chain.sent[0];
  ok(s.fn === 'hub.post' && s.args[0] === USDC_POOL && s.args[1] === 400n && s.args[2] === 123n && s.args[3].length === 32 && s.args[3][5] === `0x${(400n * 1000n + 5n).toString(16).padStart(64, '0')}` && s.opts.gas === 2500000n, 'naming its pool first, then the count, the block, the edge and the 2.5M gas cap', [s.args[0], s.args[1], s.args[2]].map(String).join(' '));
  ok(/keeps pool 0x000000c2.*posting to the catch-up hub 0x00000000C824/.test(logs.join()), 'and says the registry is the ETH pool\'s, so it posts to the hub');
  const eth = hubChain({ pool: ETH_POOL }), q = makePointPoster({ chain: eth, cfg: hcfg, now });
  ok((await q.maybePost(synced(400, 123))) === '0xhash1' && eth.sent[0].fn === 'checkpoints.post' && q.target() === 'registry' && eth.asked.hub === 0, "the ETH pool's keeper posts to its registry, never the hub");
  const off = hubChain(), r = makePointPoster({ chain: off, cfg, now });
  ok((await r.maybePost(synced(400, 123))) === null && !off.sent.length, 'with no hub named (EVM_POOL_KEEPER_POINTS_HUB=0) a token pool posts nothing');
  const noReg = hubChain({ regCode: false }), nr = makePointPoster({ chain: noReg, cfg: hcfg, now });
  ok((await nr.maybePost(synced(400, 123))) === '0xhash1' && noReg.sent[0].fn === 'hub.post', 'a chain without the registry still takes a token pool\'s points at the hub');
}
{
  // The hub before it is deployed: looked at lazily, once in half an hour, and kept once it has code; the registry is not asked again.
  let has = false, clock = t;
  const chain = hubChain({ hubCode: () => has }), logs = [], p = makePointPoster({ chain, cfg: hcfg, now: () => clock, log: (m) => logs.push(m) });
  ok((await p.maybePost(synced(400, 123))) === null && !chain.sent.length && chain.asked.hub === 1 && /hub 0x00000000C824.*no code/.test(logs.join()), 'a hub with no code yet: nothing is posted, and it says so', logs.join(' | '));
  clock += 10 * 60_000; has = true;
  ok((await p.maybePost(synced(400, 123))) === null && chain.asked.hub === 1, 'the hub is not asked again within half an hour');
  clock += 21 * 60_000;
  ok((await p.maybePost(synced(400, 123))) === '0xhash1' && chain.asked.hub === 2 && chain.asked.pool === 1, 'once it has code the next look finds it and posts; the registry\'s pool was read once');
  clock += 11 * 60_000;
  await p.maybePost(synced(2400, 999));
  ok(chain.asked.hub === 2 && chain.asked.reg === 1, 'and the code is not asked for again');
  ok(logs.filter((m) => /no code/.test(m)).length === 1, 'the missing hub is said once');
}
{
  // The registry's throttles, read from the hub: 2,000 leaves, or a day with 200; and the float check.
  const young = hubChain({ hubLatest: 10000, hubPostedAt: t / 1000 - 3600 }), p = makePointPoster({ chain: young, cfg: hcfg, now });
  ok((await p.maybePost(synced(11000, 900))) === null && !young.sent.length, 'the hub: 1,000 leaves past a point an hour old, nothing is posted');
  ok((await p.maybePost(synced(12000, 950))) === '0xhash1' && young.sent[0].args[1] === 12000n, '2,000 past it: posted');
  const old = hubChain({ hubLatest: 12000, hubPostedAt: t / 1000 - 90_000 }), q = makePointPoster({ chain: old, cfg: hcfg, now });
  ok((await q.maybePost(synced(12002, 1000))) === null, 'one pair past a point a day old is not worth a post');
  ok((await q.maybePost(synced(12200, 1000))) === '0xhash1', 'two hundred past it: posted');
  ok((await makePointPoster({ chain: hubChain({ hubLatest: 12200 }), cfg: hcfg, now }).maybePost(synced(12200, 1000))) === null, 'nothing new at the count the hub holds');
  const logs = [], poor = makePointPoster({ chain: hubChain({ rich: false }), cfg: hcfg, now, log: (m) => logs.push(m) });
  ok((await poor.maybePost(synced(400, 123))) === null && /holds 10 wei/.test(logs.join()), 'a keeper without room to spare posts nothing to the hub either');
  const failing = hubChain(); failing.send = async () => { throw new Error('execution reverted: Known()'); };
  const fl = [], f = makePointPoster({ chain: failing, cfg: hcfg, now, log: (m) => fl.push(m) });
  ok((await f.maybePost(synced(400, 123))) === null && /not posted to the hub: .*Known/.test(fl.join()), 'a hub post that reverts (someone posted this count first) is logged, not thrown');
}
{
  // Pools that share a key on a chain post a few minutes apart: each keeps its own ten-minute retry, and the key one post at a time.
  const { signerGate, SPACING_MS } = await import('../src/lib/evm-pool-keeper-points.js');
  let clock = t;
  const key = '0x00000000000000000000000000000000000000a1', g = signerGate(1, key);
  ok(signerGate(1, key.toUpperCase().replace('0X', '0x')) === g && signerGate(8453, key) !== g && signerGate(1, '0x00000000000000000000000000000000000000a2') !== g, 'one gate per key on a chain');
  const a = hubChain({ pool: ETH_POOL }), b = hubChain(), c = hubChain({ pool: '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe' });
  const pa = makePointPoster({ chain: a, cfg: hcfg, now: () => clock, gate: g });
  const pb = makePointPoster({ chain: b, cfg: hcfg, now: () => clock, gate: g });
  const pc = makePointPoster({ chain: c, cfg: hcfg, now: () => clock, gate: signerGate(1, '0x00000000000000000000000000000000000000a3') });
  ok((await pa.maybePost(synced(400, 123))) === '0xhash1' && a.sent[0].fn === 'checkpoints.post', 'the ETH pool posts first');
  ok((await pb.maybePost(synced(600, 124))) === null && !b.sent.length, 'a token pool on the same key waits');
  ok((await pc.maybePost(synced(800, 125))) === '0xhash1', 'a pool on another key does not');
  clock += SPACING_MS - 1000;
  ok((await pb.maybePost(synced(600, 124))) === null, 'still waiting just short of the spacing');
  clock += 2000;
  ok((await pb.maybePost(synced(600, 124))) === '0xhash1' && b.sent[0].fn === 'hub.post', 'and posts to the hub once it has passed');
  clock += SPACING_MS + 1000;
  ok((await pb.maybePost(synced(2600, 300))) === null && b.sent.length === 1, 'each pool still waits its own ten minutes between tries');
  ok((await pa.maybePost(synced(2400, 300))) === '0xhash2', 'while another on the key, past its own, posts');
}
{
  // The chain's own calls, against a node that answers like Ethereum's: the hub's reads name the pool, and its post goes to the hub as
  // post(address,uint256,uint256,bytes32[32]) under the gas cap, signed once.
  const http = await import('node:http');
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const { decodeFunctionData, encodeAbiParameters, parseTransaction, toFunctionSelector, keccak256 } = await import('viem');
  const { makeKeeperChain, HUB_ABI } = await import('../src/lib/evm-pool-keeper-chain.js');
  const ROUTER = '0x000000Fa00000000000000000000000000000001', TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', V1 = '0x0000000000000000000000000000000000000ae1';
  const sel = (sig) => toFunctionSelector(sig).slice(2);
  const calls = [], raws = [];
  const answer = ({ method, params }) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_call') {
      const { to, data } = params[0], s = data.slice(2, 10);
      calls.push({ to, data });
      if (to.toLowerCase() === ROUTER.toLowerCase()) return encodeAbiParameters([{ type: 'address' }], [{ [sel('POOL()')]: USDC_POOL, [sel('ASSET()')]: TOKEN, [sel('V1()')]: V1 }[s]]);
      if (to.toLowerCase() === HUB.toLowerCase() && s === sel('latest(address)')) return encodeAbiParameters([{ type: 'uint256' }], [1234n]);
      if (to.toLowerCase() === HUB.toLowerCase() && s === sel('postedAt(address,uint256)')) return encodeAbiParameters([{ type: 'uint256' }], [1_700_000_000n]);
      throw new Error(`unexpected call to ${to}`);
    }
    if (method === 'eth_estimateGas') return '0x1aae00';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
    if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
    if (method === 'eth_gasPrice') return '0x77359400';
    if (method === 'eth_getBlockByNumber') return { number: '0x100', hash: `0x${'ab'.repeat(32)}`, parentHash: `0x${'cd'.repeat(32)}`, timestamp: '0x6553f100', baseFeePerGas: '0x3b9aca00', gasLimit: '0x2aea540', gasUsed: '0x0', transactions: [], uncles: [], nonce: '0x0000000000000000', difficulty: '0x0', miner: `0x${'00'.repeat(20)}`, extraData: '0x', logsBloom: `0x${'00'.repeat(256)}`, sha3Uncles: `0x${'00'.repeat(32)}`, stateRoot: `0x${'00'.repeat(32)}`, receiptsRoot: `0x${'00'.repeat(32)}`, transactionsRoot: `0x${'00'.repeat(32)}`, size: '0x0' };
    if (method === 'eth_sendRawTransaction') { raws.push(params[0]); return keccak256(params[0]); }
    throw new Error(`unexpected ${method}`);
  };
  const srv = http.createServer(async (q, r) => {
    let body = ''; for await (const x of q) body += x;
    const req = JSON.parse(body), one = (x) => { try { return { jsonrpc: '2.0', id: x.id, result: answer(x) }; } catch (e) { return { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: e.message } }; } };
    r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(Array.isArray(req) ? req.map(one) : one(req)));
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/`;
    const account = privateKeyToAccount(generatePrivateKey());
    const chain = await makeKeeperChain({ cfg: { rpcUrls: [url], sendRpcUrls: [], allowPublicSend: true, chainId: 1, pool: USDC_POOL, router: ROUTER, pointsAddress: cfg.pointsAddress, pointsHub: HUB, minPriorityFee: 1n, pipeline: false }, account });
    ok((await chain.hubLatest()) === 1234 && calls.at(-1).to.toLowerCase() === HUB.toLowerCase() && calls.at(-1).data === `0x${sel('latest(address)')}${USDC_POOL.slice(2).toLowerCase().padStart(64, '0')}`, "the hub's newest count is read for this pool");
    ok((await chain.hubPostedAt(400)) === 1_700_000_000 && calls.at(-1).data.endsWith((400).toString(16).padStart(64, '0')) && calls.at(-1).data.includes(USDC_POOL.slice(2).toLowerCase()), 'and a count\'s time, naming the pool and the count');
    const filled = Array.from({ length: 32 }, (_, i) => `0x${(400n * 1000n + BigInt(i)).toString(16).padStart(64, '0')}`);
    const hash = await chain.send('hub.post', [USDC_POOL, 400n, 123n, filled], { gas: 2_500_000n });
    const tx = parseTransaction(raws[0]), d = decodeFunctionData({ abi: HUB_ABI, data: tx.input ?? tx.data });
    ok(raws.length === 1 && hash === keccak256(raws[0]) && tx.to.toLowerCase() === HUB.toLowerCase() && tx.gas === 2_500_000n && tx.chainId === 1, 'the post is one transaction to the hub, with the gas cap', `${tx.to} ${tx.gas}`);
    ok(d.functionName === 'post' && d.args[0] === USDC_POOL && d.args[1] === 400n && d.args[2] === 123n && d.args[3].every((x, i) => x === filled[i]), 'calling post(pool, count, block, edge)');
    // the selectors the keeper uses are the hub's own, where this checkout has a build of it
    const art = new URL('../../contracts/out/checkpoints/TacitEvmPoolCheckpointsHub.sol/TacitEvmPoolCheckpointsHub.json', import.meta.url);
    const { existsSync, readFileSync } = await import('node:fs');
    if (existsSync(art)) {
      const ids = JSON.parse(readFileSync(art, 'utf8')).methodIdentifiers;
      ok(['latest(address)', 'postedAt(address,uint256)', 'post(address,uint256,uint256,bytes32[32])'].every((sig) => ids[sig] === sel(sig)), "the keeper's hub calls are the built hub's selectors");
    } else console.log('# no hub build (forge build under FOUNDRY_PROFILE=checkpoints): its selectors are not cross-checked');
  } finally { srv.close(); }
}
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
