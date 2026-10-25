#!/usr/bin/env node
// Writes the deployment of the catch-up hub (TacitEvmPoolCheckpointsHub, contracts/src/checkpoints) on Ethereum, Base and Robinhood
// Chain: one transaction per chain, CreateX's CREATE2 (deployCreate2) under one open salt (20 zero bytes and the flag 0x00, so CreateX
// guards it as keccak256(salt) alone: no deployer and no chain id is mixed in). The hub's constructor takes the ETH pool's single-pool
// registry, which is at the same address on all three, so the init code, and with it the hub's address, is the same on each, and
// nothing but this exact code can ever be there: any wallet may send it. dapp/admin/token-pools/ lists it beside the token pools' kits.
//
// Before anything is written, each chain is read: CreateX is there; the registry the hub wraps is there, is this checkout's
// TacitEvmPoolCheckpoints build for the ETH pool, and has the same code on every chain; the transaction, run with eth_call from a plain
// address, creates the hub at the expected address; and eth_estimateGas gives its gas (written with a quarter more for room, as the
// token pools' kits are, since an L2's share of L1 gas moves with Ethereum's price). The hub's code, as the chain's own constructor run
// returns it, is then put at that address for an eth_call (a state override, nothing sent) and read: it wraps the registry, reads
// the registry's newest point through, and refuses that count as known. Where the hub is deployed already, its code must be this code.
//   dapp/admin/token-pools/hub.json   [{ chainId, to, data, value, gas, expected, salt, initCodeHash }]
//
//   (cd contracts && FOUNDRY_PROFILE=checkpoints forge build)
//   node tools/checkpoint-hub-kit.mjs [--out <dir>]
// RPC_<chainId>=<url> reads a chain through another node (an anvil fork, say); CHAINS=1,8453 limits the kit to those chains.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { keccak_256 } from '@noble/hashes/sha3';

// Some public nodes answer only over IPv4; Node's dual-stack racing then times out.
net.setDefaultAutoSelectFamily?.(false);

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const OUT = flag('--out', new URL('../dapp/admin/token-pools/', import.meta.url).pathname);

const CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
// The ETH pool's single-pool registry, the same address on every chain, and the pool it serves.
const PREVIOUS = '0x00000000C3267616ED5E0DAA6F6490D109d6844D';
const ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
// The open salt mined for this build's init code (create3-vanity create2, four zero bytes). A changed build has another init code hash
// and so another address: the kit stops until a salt is mined for it and named here.
const SALTS = {
  '0x265379fcb74b7e93caf86745faddec0d2f6384c8dcafcb5e33e7d718da8745ba': '0x0000000000000000000000000000000000000000002aa9284000000036664639',
};
const PLAIN = '0x000000000000000000000000000000000000dEaD'; // an address with no code, whose calls stand for the sender's

let CHAINS = [
  { id: 1, name: 'Ethereum', rpc: ['https://mainnet.gateway.tenderly.co', 'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'] },
  { id: 8453, name: 'Base', rpc: ['https://mainnet.base.org', 'https://base.gateway.tenderly.co', 'https://base-rpc.publicnode.com'] },
  { id: 4663, name: 'Robinhood Chain', rpc: ['https://rpc.mainnet.chain.robinhood.com'] },
];
for (const c of CHAINS) if (process.env['RPC_' + c.id]) c.rpc = [process.env['RPC_' + c.id]];
if (process.env.CHAINS) { const keep = process.env.CHAINS.split(',').map(Number); CHAINS = CHAINS.filter((c) => keep.includes(c.id)); }

// ── bytes ──
const lc = (s) => String(s || '').toLowerCase();
const strip = (h) => String(h).replace(/^0x/, '');
const w = (h) => strip(typeof h === 'bigint' ? h.toString(16) : h).toLowerCase().padStart(64, '0');
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const kh = (hex) => '0x' + hexOf(keccak_256(Uint8Array.from(strip(hex).match(/../g) || [], (x) => parseInt(x, 16))));
const sel = (sig) => kh(Buffer.from(sig).toString('hex')).slice(0, 10);
const checksum = (a) => { const l = lc(strip(a)), h = strip(kh(Buffer.from(l).toString('hex'))); return '0x' + [...l].map((ch, i) => (parseInt(h[i], 16) >= 8 ? ch.toUpperCase() : ch)).join(''); };
const word = (r, i) => BigInt('0x' + (strip(r).slice(64 * i, 64 * i + 64) || '0'));
const addrAt = (r, i = 0) => checksum('0x' + strip(r).slice(64 * i + 24, 64 * i + 64));

// ── the build and its address ──
const artifact = (name) => {
  const path = new URL(`../contracts/out/checkpoints/${name}.sol/${name}.json`, import.meta.url).pathname;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { console.error(`No build at ${path}. Run: (cd contracts && FOUNDRY_PROFILE=checkpoints forge build)`); process.exit(1); }
};
const hubArt = artifact('TacitEvmPoolCheckpointsHub'), regArt = artifact('TacitEvmPoolCheckpoints');
// Whether `code` is this build's runtime with one of `values` at each immutable (the same one at every reference to it), as a constructor
// writes them.
function isBuild(code, art, values) {
  let a = lc(strip(code)), b = lc(strip(art.deployedBytecode.object));
  if (a.length !== b.length) return false;
  for (const refs of Object.values(art.deployedBytecode.immutableReferences || {})) {
    const at = new Set(refs.map(({ start, length }) => a.slice(2 * start, 2 * (start + length))));
    if (at.size !== 1 || !values.some((v) => w(v).slice(64 - 2 * refs[0].length) === [...at][0])) return false;
    for (const { start, length } of refs) {
      a = a.slice(0, 2 * start) + '00'.repeat(length) + a.slice(2 * (start + length));
      b = b.slice(0, 2 * start) + '00'.repeat(length) + b.slice(2 * (start + length));
    }
  }
  return a === b;
}
const INIT = '0x' + strip(hubArt.bytecode.object) + w(PREVIOUS);
const INIT_HASH = kh(INIT);
const SALT = SALTS[INIT_HASH];
if (!SALT) {
  console.error(`No salt for init code ${INIT_HASH}. Mine one, and name it in SALTS:\n  create3-vanity create2 ${CREATEX} ${INIT_HASH} 4   (contracts/script/create3-vanity)`);
  process.exit(1);
}
if (!/^0x0{40}00[0-9a-f]{22}$/i.test(SALT)) { console.error('The salt does not start with 20 zero bytes and 0x00, so CreateX would not guard it as its own hash.'); process.exit(1); }
// CreateX's CREATE2 address under an open salt: CREATE2's over CreateX, the salt's hash and the init code's hash.
const EXPECTED = checksum('0x' + kh('0xff' + strip(CREATEX) + strip(kh(SALT)) + strip(INIT_HASH)).slice(-40));
const initLen = strip(INIT).length / 2;
// deployCreate2(bytes32 salt, bytes initCode)
const DATA = sel('deployCreate2(bytes32,bytes)') + strip(SALT) + w(64n) + w(BigInt(initLen)) + strip(INIT) + '00'.repeat((32 - (initLen % 32)) % 32);

// ── reads ──
const rpcOf = (c) => async (method, params) => {
  let last;
  for (const url of c.rpc) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      const j = await r.json();
      // A revert is the chain's answer; any other error (a node's limit, its trouble) asks the next node.
      if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { revert: /revert/i.test(`${j.error.message} ${JSON.stringify(j.error.data ?? '')}`), data: j.error.data });
      return j.result;
    } catch (e) { if (e.revert) throw e; last = e; }
  }
  throw last;
};
const revertData = (e) => lc(typeof e.data === 'string' ? e.data : e.data?.data ?? '');

async function check(c) {
  const rpc = rpcOf(c), call = (to, data, extra = {}, override) => rpc('eth_call', [{ from: PLAIN, to, data, ...extra }, 'latest', ...(override ? [override] : [])]);
  const [id, block, cx, prevCode, hubCode] = await Promise.all([
    rpc('eth_chainId', []), rpc('eth_blockNumber', []), rpc('eth_getCode', [CREATEX, 'latest']), rpc('eth_getCode', [PREVIOUS, 'latest']), rpc('eth_getCode', [EXPECTED, 'latest']),
  ]);
  if (Number(id) !== c.id) throw new Error(`the node serves chain ${Number(id)}`);
  if (!cx || cx === '0x') throw new Error(`CreateX is not at ${CREATEX}`);
  if (!prevCode || prevCode === '0x') throw new Error(`the registry is not at ${PREVIOUS}`);
  if (!isBuild(prevCode, regArt, [ETH_POOL])) throw new Error(`the code at ${PREVIOUS} is not this checkout's TacitEvmPoolCheckpoints for ${ETH_POOL}`);
  if (lc(addrAt(await call(PREVIOUS, sel('POOL()')))) !== lc(ETH_POOL)) throw new Error('the registry serves another pool');
  const out = { chainId: c.id, name: c.name, block: Number(block), previousCodeHash: kh(prevCode) };

  // The hub's code as this chain's own run of the constructor leaves it (a creation run with eth_call returns the runtime), which must be
  // this build's with PREVIOUS and its pool written in.
  const runtime = lc(await rpc('eth_call', [{ from: PLAIN, data: INIT }, 'latest']));
  if (!isBuild(runtime, hubArt, [PREVIOUS, ETH_POOL])) throw new Error('the constructor, run here, leaves code other than this build');
  out.runtimeBytes = strip(runtime).length / 2;

  if (hubCode && hubCode !== '0x') {
    if (lc(hubCode) !== runtime) throw new Error(`${EXPECTED} has code, and it is not this build`);
    out.deployed = true;
  } else {
    // The deploy, run from a plain address: CreateX returns the address it made.
    const made = addrAt(await call(CREATEX, DATA));
    if (lc(made) !== lc(EXPECTED)) throw new Error(`the deploy makes ${made}, not ${EXPECTED}`);
    out.estimate = BigInt(await rpc('eth_estimateGas', [{ from: PLAIN, to: CREATEX, data: DATA }]));
    out.gas = ((out.estimate * 5n) / 4n + 9_999n) / 10_000n * 10_000n;
    out.deployed = false;
  }

  // The hub's code at its address, read in an eth_call that puts it there (nothing sent), or the hub itself where it is deployed.
  const at = out.deployed ? undefined : { [EXPECTED]: { code: runtime } };
  const hub = (data) => call(EXPECTED, data, {}, at);
  if (lc(addrAt(await hub(sel('PREVIOUS()')))) !== lc(PREVIOUS) || lc(addrAt(await hub(sel('PREVIOUS_POOL()')))) !== lc(ETH_POOL)) throw new Error('the hub does not wrap the registry');
  const live = word(await call(PREVIOUS, sel('latest()')), 0);
  if (word(await hub(sel('latest(address)') + w(ETH_POOL)), 0) < live) throw new Error('the hub does not read the registry\'s newest point through');
  out.registryLatest = Number(live);
  if (live > 0n) {
    const point = strip(await call(PREVIOUS, sel('pointAt(uint256)') + w(live)));
    // newest([ETH_POOL]): one Newest, after the array's offset and length: size, block, then the edge.
    const n = strip(await hub(sel('newest(address[])') + w(32n) + w(1n) + w(ETH_POOL)));
    // Where the hub is deployed it may hold a newer point of its own.
    const same = word(n, 2) === live && word(n, 3) === word(point, 0) && n.slice(64 * 4, 64 * 36) === point.slice(64 * 2, 64 * 34);
    if (word(n, 1) !== 1n || !(same || (out.deployed && word(n, 2) > live))) throw new Error('newest does not give the registry\'s point');
    // The registry's own point, posted to the hub: known already.
    const known = await hub(sel('post(address,uint256,uint256,bytes32[32])') + w(ETH_POOL) + w(live) + point.slice(0, 64) + point.slice(64 * 2, 64 * 34)).then(() => null, (e) => revertData(e));
    if (known !== sel('Known()')) throw new Error(`the hub does not refuse the registry's count as known (${known})`);
  }
  return out;
}
console.log(`hub ${EXPECTED}: CreateX ${CREATEX}, open salt ${SALT}, init code ${initLen} bytes (${INIT_HASH}), wrapping ${PREVIOUS}`);
const rows = [];
for (const c of CHAINS) {
  const r = await check(c);
  rows.push(r);
  console.log(`${r.name} (${r.chainId}) at block ${r.block}: ${r.deployed ? 'deployed already, this build' : `deploy lands at ${EXPECTED}, ${r.estimate} gas (sent with ${r.gas})`}; registry's newest point ${r.registryLatest}, read through and refused as known`);
}
const hashes = new Set(rows.map((r) => r.previousCodeHash));
if (hashes.size !== 1) throw new Error('the registry has different code on different chains');

const kit = rows.map((r) => ({
  chainId: r.chainId, to: CREATEX, data: DATA, value: '0', gas: r.deployed ? null : String(r.gas), expected: EXPECTED, salt: SALT, initCodeHash: INIT_HASH,
}));
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'hub.json'), JSON.stringify(kit, null, 2) + '\n');
console.log(`wrote ${join(OUT, 'hub.json')}`);
