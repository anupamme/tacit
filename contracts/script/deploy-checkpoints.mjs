#!/usr/bin/env node
// The catch-up registry's admin page, on localhost: deploys TacitEvmPoolCheckpoints from a browser wallet on each chain the
// pool is on, shows what each chain holds, and posts a point from the wallet.
//
// Deploy: CreateX's CREATE2 (deployCreate2) under one salt that anyone may use (20 zero bytes and the flag 0x00, so CreateX guards
// it as keccak256(salt) alone: no deployer and no chain id is mixed in). The registry lands at the same address on every chain,
// and since the address is CREATE2's it is fixed by the init code: nothing but this exact code can ever be there, so any wallet
// may deploy it and a task may pay for it. A changed build has another address, so another salt is mined for it (the salts are
// kept by init code hash in checkpoints-salts.json); the page says when this build's address differs from the one the anon.wei
// page, the keepers and the docs name. The page reads the code on chain and says whether it is this checkout's build. Each deploy
// is dry-run from the connected wallet first and sent only if it lands at the address.
//
// Post: the server rebuilds the pool's tree from the relay's event index (or the chain's logs, where the relay is down
// or RELAY_<chainId>= is empty), takes its edge at the index's confirmed block, and offers it only once the pool holds
// its root at that count and the logs after that block start where it ends. The registry checks the root again when the
// post lands; the wallet signs, nothing here holds a key.
//
//   (cd contracts && FOUNDRY_PROFILE=checkpoints forge build)
//   node contracts/script/deploy-checkpoints.mjs [port]                 → http://127.0.0.1:8796
// RPC_<chainId>=<url> reads (and dry-runs) a chain through another node, a local fork for instance; RELAY_<chainId>=<url>
// names another relay, or none when empty; CHAINS=1,8453 limits the page to those chains; SALTS_FILE=<path> keeps the
// salts elsewhere.
import http from 'node:http';
import net from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3';
import * as poseidonLite from 'poseidon-lite';
import { makeEvmPoolZk } from '../../dapp/evm-pool-zk.js';

// Some public nodes answer only over IPv4; Node's dual-stack racing then times out.
net.setDefaultAutoSelectFamily?.(false);

const DIR = new URL('../', import.meta.url).pathname;
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
const CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
// The address the anon.wei page, the keepers and the docs name (this build's open salt). Another build lands elsewhere: the page
// says so.
const NAMED = '0x00000000c3267616ed5e0daa6f6490d109d6844d';
const keeper = (chainId) => `https://tacit-evm-pool-keepers.onrender.com/${chainId}/evm-pool/keeper`;
let CHAINS = [
  { id: 1, name: 'Ethereum', rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://mainnet.gateway.tenderly.co'], explorer: 'https://etherscan.io', relay: keeper(1), deployBlock: 26069245, logStep: 50_000 },
  { id: 8453, name: 'Base', rpc: ['https://mainnet.base.org', 'https://base.gateway.tenderly.co', 'https://base.drpc.org'], explorer: 'https://basescan.org', relay: keeper(8453), deployBlock: 51864014, logStep: 500 },
  { id: 4663, name: 'Robinhood Chain', rpc: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'], explorer: 'https://robinhoodchain.blockscout.com', relay: keeper(4663), deployBlock: 73991661, logStep: 1_000_000 },
  { id: 4326, name: 'MegaETH', rpc: ['https://mainnet.megaeth.com/rpc', 'https://megaeth.drpc.org'], explorer: 'https://mega.etherscan.io', relay: keeper(4326), deployBlock: 28397750, logStep: 100_000 },
];
for (const c of CHAINS) {
  if (process.env['RPC_' + c.id]) c.rpc = [process.env['RPC_' + c.id]];
  if (process.env['RELAY_' + c.id] !== undefined) c.relay = process.env['RELAY_' + c.id] || null;
}
if (process.env.CHAINS) { const keep = process.env.CHAINS.split(',').map(Number); CHAINS = CHAINS.filter((c) => keep.includes(c.id)); }
const chainOf = (id) => CHAINS.find((c) => c.id === Number(id));

// ── bytes ──
const hex = (b) => Buffer.from(b).toString('hex');
const keccak = (h) => '0x' + hex(keccak_256(Buffer.from(h.replace(/^0x/, ''), 'hex')));
const word = (x) => BigInt(x).toString(16).padStart(64, '0');
const sel = (sig) => keccak(Buffer.from(sig).toString('hex')).slice(0, 10);
const checksum = (a) => {
  const l = a.toLowerCase().replace(/^0x/, ''), h = hex(keccak_256(l));
  return '0x' + [...l].map((ch, i) => (parseInt(h[i], 16) >= 8 ? ch.toUpperCase() : ch)).join('');
};

// ── the build and its address ──
const ART = DIR + 'out/checkpoints/TacitEvmPoolCheckpoints.sol/TacitEvmPoolCheckpoints.json';
let art;
try { art = JSON.parse(readFileSync(ART, 'utf8')); }
catch { console.error(`No build at ${ART}. Run: (cd contracts && FOUNDRY_PROFILE=checkpoints forge build)`); process.exit(1); }
const INIT = '0x' + art.bytecode.object.replace(/^0x/, '') + word(POOL);
// The runtime this build leaves on chain: the pool, its one immutable, written into the places the compiler left for it.
const RUNTIME = (() => {
  let r = art.deployedBytecode.object.replace(/^0x/, '').toLowerCase();
  for (const refs of Object.values(art.deployedBytecode.immutableReferences || {})) for (const { start, length } of refs) r = r.slice(0, 2 * start) + word(POOL).slice(64 - 2 * length) + r.slice(2 * (start + length));
  return r;
})();
const SALTS_FILE = process.env.SALTS_FILE || new URL('./checkpoints-salts.json', import.meta.url).pathname;
let salts = {};
try { salts = JSON.parse(readFileSync(SALTS_FILE, 'utf8')); } catch {}
// CreateX's CREATE2 address under an open salt: the salt is guarded as its own hash, and the address is CREATE2's over that,
// CreateX and the init code's hash.
const INIT_HASH = keccak(INIT);
const addressOf = (salt) => checksum('0x' + keccak('0xff' + CREATEX.slice(2) + keccak(salt).slice(2) + INIT_HASH.slice(2)).slice(-40));
const key = INIT_HASH;
if (!salts[key]) {
  const zeros = Number(process.env.ZEROS ?? 4);
  console.log(`No salt for init code ${INIT_HASH.slice(0, 14)}… yet: mining one for ${zeros} leading zero bytes with create3-vanity create2 (each extra zero byte takes about 256 times as long; four take about 20 minutes)…`);
  const bin = new URL('./create3-vanity/target/release/create3-vanity', import.meta.url).pathname;
  try {
    try { readFileSync(bin); } catch { execFileSync('cargo', ['build', '--release', '--offline', '--manifest-path', new URL('./create3-vanity/Cargo.toml', import.meta.url).pathname], { stdio: 'inherit' }); }
    const out = execFileSync(bin, ['create2', CREATEX, INIT_HASH, String(zeros)], { encoding: 'utf8', timeout: 7_200_000 });
    const m = /salt (0x[0-9a-f]{64}) guarded (0x[0-9a-f]{64}) address (0x[0-9a-f]{40})/.exec(out);
    if (!m) throw new Error(out.slice(-300));
    if (addressOf(m[1]).toLowerCase() !== m[3]) throw new Error('the miner and this script disagree on the address');
    salts[key] = { salt: m[1], address: addressOf(m[1]) };
  } catch (e) { console.error(`Could not mine a salt: ${String(e.message).slice(0, 300)}`); process.exit(1); }
  writeFileSync(SALTS_FILE, JSON.stringify(salts, null, 2) + '\n');
}
const { salt: SALT } = salts[key], ADDR = addressOf(SALT);
if (salts[key].address.toLowerCase() !== ADDR.toLowerCase()) { console.error(`${SALTS_FILE} names ${salts[key].address} for this salt, which lands at ${ADDR}`); process.exit(1); }
if (!/^0x0{40}00[0-9a-f]{22}$/i.test(SALT)) { console.error('The salt does not start with 20 zero bytes and 0x00, so CreateX would not guard it as its own hash.'); process.exit(1); }
// deployCreate2(bytes32 salt, bytes initCode)
const initLen = (INIT.length - 2) / 2;
const DEPLOY_DATA = sel('deployCreate2(bytes32,bytes)') + SALT.slice(2) + word(64) + word(initLen) + INIT.slice(2) + '00'.repeat((32 - (initLen % 32)) % 32);

// ── reads ──
async function rpc(c, method, params = []) {
  let last;
  for (const url of c.rpc) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method === 'eth_getLogs' ? 30_000 : 15_000) });
      const j = await r.json().catch(() => { throw new Error(`${new URL(url).host} answered ${r.status}`); });
      if (j.error) {
        const e = Object.assign(new Error(j.error.message || 'rpc error'), { data: j.error.data });
        if (/revert/i.test(e.message) || method === 'eth_estimateGas') throw e;
        last = e; continue;
      }
      return j.result;
    } catch (e) { if (e.data !== undefined || /revert/i.test(e.message)) throw e; last = e; }
  }
  throw last || new Error('no node answered');
}
const call = (c, to, data, tag = 'latest', from) => rpc(c, 'eth_call', [{ to, data, ...(from ? { from } : {}) }, tag]);
const num = (h) => (h && h !== '0x' ? BigInt(h) : 0n);
const REVERTS = Object.fromEntries(['NotEven()', 'BadBlock()', 'Known()', 'NotHeld()', 'UnknownMembershipRoot()'].map((s) => [sel(s), s.slice(0, -2)]));
const why = (e) => { const d = String(e?.data?.data ?? e?.data ?? ''); return REVERTS[d.slice(0, 10)] || String(e?.message || e).slice(0, 200); };

async function state(c, from) {
  const out = { id: c.id };
  const [code, gp, head, leaves, bal, cx] = await Promise.all([
    rpc(c, 'eth_getCode', [ADDR, 'latest']), rpc(c, 'eth_gasPrice').catch(() => null), rpc(c, 'eth_blockNumber').catch(() => null),
    call(c, POOL, sel('nextIndex()')).catch(() => null), from ? rpc(c, 'eth_getBalance', [from, 'latest']).catch(() => null) : null,
    rpc(c, 'eth_getCode', [CREATEX, 'latest']).catch(() => null),
  ]);
  Object.assign(out, { gasPrice: gp && String(num(gp)), head: head && Number(num(head)), poolLeaves: leaves && Number(num(leaves)), balance: bal && String(num(bal)) });
  out.deployed = !!code && code !== '0x';
  if (out.deployed) {
    out.codeBytes = (code.length - 2) / 2;
    out.sameCode = code.slice(2).toLowerCase() === RUNTIME;
    out.wired = (await call(c, ADDR, sel('POOL()')).catch(() => '0x')).slice(-40).toLowerCase() === POOL.slice(2).toLowerCase();
    const latest = Number(num(await call(c, ADDR, sel('latest()'))));
    out.latest = latest ? { size: latest, block: Number(num((await call(c, ADDR, sel('pointAt(uint256)') + word(latest))).slice(0, 66))), postedAt: Number(num(await call(c, ADDR, sel('postedAt(uint256)') + word(latest)))) } : null;
  } else if (!cx || cx === '0x') {
    out.problem = 'CreateX is not on this chain at ' + CREATEX;
  } else if (!from) {
    out.dryRun = 'connect';
  } else {
    try {
      const lands = await call(c, CREATEX, DEPLOY_DATA, 'latest', from);
      out.dryRun = '0x' + lands.slice(-40).toLowerCase() === ADDR.toLowerCase() ? 'lands' : 'elsewhere: ' + lands;
    } catch (e) { out.dryRun = 'reverts: ' + why(e); }
    out.deployGas = await rpc(c, 'eth_estimateGas', [{ to: CREATEX, data: DEPLOY_DATA, from }]).then((g) => String(num(g)), () => null);
  }
  return out;
}

// ── a point: the pool's tree edge at the confirmed block ──
const zk = makeEvmPoolZk({ poseidon: (xs) => ({ 2: poseidonLite.poseidon2, 3: poseidonLite.poseidon3, 4: poseidonLite.poseidon4, 5: poseidonLite.poseidon5, 7: poseidonLite.poseidon7 })[xs.length](xs) });
const T_TRANSACT = keccak(Buffer.from('Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)').toString('hex'));
const jobs = new Map(); // chainId → { state: 'reading'|'ready'|'failed', note, point, err, at }

// Inserting transacts in (from, to], from the chain's logs, a range at a time: { firstIndex, leaves } in order.
async function logsBetween(c, from, to, job) {
  const out = [];
  let step = c.logStep;
  for (let a = from; a <= to;) {
    const b = Math.min(to, a + step - 1);
    try {
      const logs = await rpc(c, 'eth_getLogs', [{ address: POOL, topics: [T_TRANSACT], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]);
      for (const l of logs) { const d = l.data.slice(2); out.push({ firstIndex: Number(BigInt('0x' + d.slice(128, 192))), leaves: [BigInt('0x' + d.slice(0, 64)), BigInt('0x' + d.slice(64, 128))] }); }
      a = b + 1;
      if (job) job.note = `reading the chain’s logs: block ${a.toLocaleString('en-US')} of ${to.toLocaleString('en-US')}`;
    } catch (e) {
      const named = [...String(e.message).matchAll(/(\d[\d,]*)\s*(?:blocks?|range)\b/gi)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n > 0 && n < step);
      if (named.length) { step = Math.max(...named); continue; }
      if (step > 10) { step = Math.max(10, Math.floor(step / 4)); continue; }
      throw e;
    }
  }
  return out.filter((t) => t.leaves[0] || t.leaves[1]).sort((x, y) => x.firstIndex - y.firstIndex);
}
// Every inserting transact through the relay's confirmed block: { ts, through }.
async function fromRelay(c, job) {
  const ts = [];
  let from = c.deployBlock, through = c.deployBlock - 1;
  for (let page = 0; page < 1000; page++) {
    const r = await fetch(`${c.relay}/events?from=${from}`, { signal: AbortSignal.timeout(60_000) }).then((x) => { if (!x.ok) throw new Error(`relay answered ${x.status}`); return x.json(); });
    if (Number(r.chainId) !== c.id || String(r.pool).toLowerCase() !== POOL.toLowerCase()) throw new Error('the relay serves another pool');
    if (Number(r.through) < from) break;
    for (const e of r.events) if (e.kind === 'transact') ts.push({ firstIndex: Number(e.firstIndex), leaves: [BigInt(e.outLeaf0), BigInt(e.outLeaf1)] });
    through = Number(r.through); from = through + 1;
    job.note = `reading the relay’s index: through block ${through.toLocaleString('en-US')}`;
  }
  return { ts: ts.filter((t) => t.leaves[0] || t.leaves[1]).sort((x, y) => x.firstIndex - y.firstIndex), through };
}
async function computePoint(c, job) {
  let ts, through, source;
  if (c.relay) {
    try { ({ ts, through } = await fromRelay(c, job)); source = 'the relay’s index'; }
    catch (e) { job.note = `the relay could not be read (${String(e.message).slice(0, 80)}); reading the chain instead`; }
  }
  // The head is read after the relay (which can take a while to page), so a relay that is only a little ahead is not ahead.
  const head = Number(num(await rpc(c, 'eth_blockNumber')));
  if (!ts) { through = head - 32; ts = await logsBetween(c, c.deployBlock, through, job); source = 'the chain’s logs'; }
  if (through > head) throw new Error(`the relay is ahead of this node (block ${through} > ${head}); try again shortly`);
  const tree = zk.incTree(), leaves = [];
  ts.forEach((t, k) => { if (t.firstIndex !== 2 * k) throw new Error(`insertion ${k} is at leaf ${t.firstIndex}, not ${2 * k}: events are missing`); leaves.push(...t.leaves); });
  job.note = `hashing ${leaves.length.toLocaleString('en-US')} leaves`;
  for (let i = 0; i < leaves.length; i += 2048) { tree.append(leaves.slice(i, i + 2048)); await new Promise((r) => setImmediate(r)); }
  const size = tree.size;
  if (!size) throw new Error('the pool is empty here');
  const filled = tree.toJSON().filled.map((x) => '0x' + word(x));
  // The edge folds to the tree's root, as the registry folds it.
  let cur = 0n;
  for (let L = 0; L < 32; L++) cur = Math.floor(size / 2 ** L) % 2 ? zk.H([BigInt(filled[L]), cur]) : zk.H([cur, zk.zeros[L]]);
  if (cur !== tree.root) throw new Error('the edge does not fold to the tree’s root');
  // The pool held this root at this count.
  const held = await call(c, POOL, sel('rootSize(bytes32)') + word(tree.root)).then((r) => Number(num(r)), (e) => { throw new Error(`the pool never held this root (${why(e)})`); });
  if (held !== size) throw new Error(`the pool held this root at ${held} leaves, not ${size}`);
  // And the tree had this count at the end of `through`: the first insertion after it starts at `size`, or there is none
  // and the pool still has `size` leaves.
  job.note = 'checking the blocks after it';
  const after = await logsBetween(c, through + 1, head, null);
  if (after.length ? after[0].firstIndex !== size : Number(num(await call(c, POOL, sel('nextIndex()'), '0x' + head.toString(16)))) !== size) throw new Error('the events after this block do not start where it ends; try again shortly');
  const data = sel('post(uint256,uint256,bytes32[32])') + word(size) + word(through) + filled.map((f) => f.slice(2)).join('');
  return { size, block: through, root: '0x' + word(tree.root), source, data };
}
function pointJob(c, fresh) {
  let job = jobs.get(c.id);
  if (job?.state === 'reading') return job;
  if (job && !fresh && Date.now() - job.at < 60_000) return job;
  job = { state: 'reading', note: 'starting', at: Date.now() };
  jobs.set(c.id, job);
  computePoint(c, job).then((p) => Object.assign(job, { state: 'ready', point: p, at: Date.now() }), (e) => Object.assign(job, { state: 'failed', err: String(e.message || e).slice(0, 300), at: Date.now() }));
  return job;
}
// A post, dry-run from the wallet's account against the chain as it is now, with its gas.
async function dryPost(c, data, from) {
  // A call to an address with no code succeeds and proves nothing.
  const code = await rpc(c, 'eth_getCode', [ADDR, 'latest']).catch(() => '0x');
  if (!code || code === '0x') return { ok: false, why: 'the registry is not deployed on this chain yet' };
  try {
    await call(c, ADDR, data, 'latest', from);
    const gas = await rpc(c, 'eth_estimateGas', [{ to: ADDR, data, from }]).then((g) => String(num(g)), () => null);
    return { ok: true, gas };
  } catch (e) { return { ok: false, why: why(e) }; }
}

// ── the page ──
const page = readFileSync(new URL('./deploy-checkpoints.html', import.meta.url), 'utf8').replace('/*CONFIG*/null', () => JSON.stringify({
  address: ADDR, named: NAMED, createx: CREATEX, pool: POOL, salt: SALT, initBytes: initLen, runtimeBytes: RUNTIME.length / 2, deployData: DEPLOY_DATA,
  chains: CHAINS.map(({ id, name, rpc: r, explorer }) => ({ id, name, rpc: r[0], explorer })),
}));
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const server = http.createServer(async (req, res) => {
  try {
    // Only this machine's own browser tab: a page on another site cannot drive this server (a request it can send blind
    // names another site, and DNS rebinding changes the Host it is answered under).
    const port = server.address().port;
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host || '') || (req.headers['sec-fetch-site'] || 'none') === 'cross-site') return send(res, 403, { error: 'not for this page' });
    const u = new URL(req.url, 'http://x'), c = chainOf(u.searchParams.get('chain')), from = isAddr(u.searchParams.get('from')) ? u.searchParams.get('from') : undefined;
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(page); }
    if (!c) return send(res, 404, { error: 'no such chain' });
    if (u.pathname === '/api/state') return send(res, 200, await state(c, from));
    if (u.pathname === '/api/point') {
      const job = pointJob(c, u.searchParams.has('fresh'));
      if (job.state !== 'ready') return send(res, 200, { state: job.state, note: job.note, err: job.err });
      return send(res, 200, { state: 'ready', point: job.point, dry: from ? await dryPost(c, job.point.data, from) : null });
    }
    if (u.pathname === '/api/receipt') {
      const hash = u.searchParams.get('hash') || '';
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return send(res, 400, { error: 'not a transaction hash' });
      const r = await rpc(c, 'eth_getTransactionReceipt', [hash]);
      return send(res, 200, r ? { status: r.status, gasUsed: String(num(r.gasUsed)), block: Number(num(r.blockNumber)) } : { status: null });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) { return send(res, 502, { error: String(e.message || e).slice(0, 300) }); }
});
server.listen(Number(process.argv[2] || 8796), '127.0.0.1', function () {
  console.log(`Catch-up registry admin: http://127.0.0.1:${this.address().port}`);
  console.log(`  registry ${ADDR}${ADDR.toLowerCase() === NAMED.toLowerCase() ? '' : `  (NOT the ${NAMED} the page and keepers name)`}`);
  console.log(`  CREATE2 through CreateX ${CREATEX}, open salt ${SALT}, init code ${initLen} bytes (${INIT_HASH})`);
  console.log(`  chains: ${CHAINS.map((c) => c.name).join(', ')}`);
});
