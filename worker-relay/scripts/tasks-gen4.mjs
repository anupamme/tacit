// Builds the task job for the next anon.wei (generation 4) from the page build and the catch-up registry's init code, merging it into
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices
//   dapp/tasks/jobs.json                          what the /tasks page shows
//   dapp/tasks/anon-wei-4-payload.json            the transactions a visitor sends
//
//   node worker-relay/scripts/tasks-gen4.mjs --page /path/to/tacit-pay --registry-init init.txt --registry-salt 0x… --registry-address 0x…
//        --min-base 25000 --min-robinhood 2000 --opens <unix secs> [--rpc-1 <node>] [--rpc-8453 <node>] [--rpc-4663 <node>] [--rpc-4326 <node>]
//        [--no-estimate (keep the gas already in the files)] [--out <dir>]
//
// The job: the page's chunks on Ethereum (each a CreateX CREATE2 deployment under a chain-bound salt anyone may use, so its
// address is fixed by its code), the catch-up registry on four chains (CreateX CREATE2 under one salt anyone may use: the same
// address on every chain, fixed by its code), and the first point posted to the registry on the two chains where a long history
// slows the first read. The page's wrapper (`deployNext`, from the steward) and the name `anon.wei` are the steward's and are not
// part of the job.
//
// Gas is read from each chain's own node (`eth_estimateGas` on the step's call, which sends nothing), rounded up to a thousand.
// A step pays its gas at a slow price in TAC with the tip; a step on a chain where gas costs next to nothing still takes the time of
// whoever sends it, so each step names its least and most (below), in TAC.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak256, concat, toHex, pad, encodeAbiParameters, getAddress } from 'viem';
import { writeJobs } from './tasks-merge.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const need = (k) => { const v = arg(k); if (!v) throw new Error(`--${k} is required`); return v; };
const root = fileURLToPath(new URL('../../', import.meta.url));
// --out <dir> writes the three files there instead (a test's own copies), under these names.
const out = arg('out');
const SERVICE_OUT = out ? `${out}/service-jobs.json` : `${root}worker-relay/src/lib/points-tasks-jobs.json`;
const PAGE_OUT = out ? `${out}/page-jobs.json` : `${root}dapp/tasks/jobs.json`;
const PAYLOAD_OUT = out ? `${out}/payload.json` : `${root}dapp/tasks/anon-wei-4-payload.json`;

const CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
const DEPLOY_CREATE2 = '0x26307668';                                      // deployCreate2(bytes32 salt, bytes initCode)
const TAC = 10n ** 18n;
const CHAINS = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood Chain', 4326: 'MegaETH' };
const NODES = { 1: 'https://ethereum-rpc.publicnode.com', 8453: 'https://mainnet.base.org', 4663: 'https://rpc.mainnet.chain.robinhood.com', 4326: 'https://mainnet.megaeth.com/rpc' };
// What a step pays at least and at most, in TAC, whatever gas costs.
const BOUNDS = { chunk: [8n, 80n], registryEthereum: [12n, 80n], registryOther: [15n, 40n], post: [25n, 60n] };
const POST_GAS = 1_743_000;                                                // measured: 1,742,487 on forks of Ethereum and Base (the admin page's end-to-end test)

const hex = (b) => `0x${Buffer.from(b).toString('hex')}`;
const create2 = (factory, guarded, initHash) => getAddress(`0x${keccak256(concat(['0xff', factory, guarded, initHash])).slice(26)}`);
const deployData = (salt, initCode) => {
  const n = (initCode.length - 2) / 2;
  return concat([DEPLOY_CREATE2, salt, pad(toHex(64), { size: 32 }), pad(toHex(n), { size: 32 }), initCode, `0x${'00'.repeat((32 - (n % 32)) % 32)}`]);
};
const boundSalt = (chainId, salt) => keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [BigInt(chainId), salt]));

// ── the page's chunks ──
const page = need('page').replace(/\/$/, '');
const manifest = JSON.parse(readFileSync(`${page}/manifest.json`, 'utf8'));
const steps = [];
const files = [];
for (let i = 1; ; i++) { try { files.push(readFileSync(`${page}/out/TacitPay8244.chunk${i}.creation.txt`, 'utf8').trim()); } catch { break; } }
if (!files.length) throw new Error(`no chunks in ${page}/out`);
// The chunks are the page: their code, in order, is the page the manifest pins.
const runtime = Buffer.concat(files.map((c) => Buffer.from(c.slice(2 + 20 + 2), 'hex')));
if (runtime.compare(readFileSync(`${page}/${manifest.page}`)) !== 0) throw new Error('the chunks do not reassemble to the page the manifest pins');
files.forEach((init, i) => {
  const salt = hex(Buffer.concat([Buffer.alloc(20), Buffer.from([1]), Buffer.from(`g4chunk${String(i + 1).padStart(2, '0')}`), Buffer.alloc(2)]));
  const initHash = keccak256(init), expected = create2(CREATEX, boundSalt(1, salt), initHash);
  steps.push({ id: `${String(i + 1).padStart(2, '0')}-chunk-${i + 1}`, chainId: 1, group: 'Page chunks', kind: 'createx', to: CREATEX, data: deployData(salt, init), expected, salt, initCodeHash: initHash, label: `Page chunk ${i + 1} of ${files.length}`, bounds: BOUNDS.chunk });
});

// ── the registry, on four chains, under one open salt ──
const regInit = readFileSync(need('registry-init'), 'utf8').trim(), regSalt = need('registry-salt'), regAddr = getAddress(need('registry-address'));
const regHash = keccak256(regInit);
if (!/^0x0{40}00[0-9a-f]{22}$/i.test(regSalt)) throw new Error('the registry salt must start with 20 zero bytes and the flag 0x00');
if (create2(CREATEX, keccak256(regSalt), regHash) !== regAddr) throw new Error(`the salt and init code give ${create2(CREATEX, keccak256(regSalt), regHash)}, not ${regAddr}`);
for (const id of [1, 8453, 4663, 4326]) {
  steps.push({ id: `${String(steps.length + 1).padStart(2, '0')}-registry-${CHAINS[id].toLowerCase().replace(/[^a-z]+/g, '-')}`, chainId: id, group: 'Catch-up registry', kind: 'createx', bound: false, to: CREATEX, data: deployData(regSalt, regInit), expected: regAddr, salt: regSalt, initCodeHash: regHash, label: `Catch-up registry on ${CHAINS[id]}`, bounds: id === 1 ? BOUNDS.registryEthereum : BOUNDS.registryOther });
}
// ── the first points, where the pool has a long history ──
for (const [id, min] of [[8453, Number(need('min-base'))], [4663, Number(need('min-robinhood'))]]) {
  steps.push({ id: `${String(steps.length + 1).padStart(2, '0')}-point-${CHAINS[id].toLowerCase().split(' ')[0]}`, chainId: id, group: 'First points', kind: 'post', to: regAddr, minSize: min, label: `First catch-up point on ${CHAINS[id]}`, bounds: BOUNDS.post, gas: POST_GAS });
}

// ── gas, from each chain's own node ──
const node = (id) => arg(`rpc-${id}`, NODES[id]);
async function estimate(id, to, data) {
  const r = await (await fetch(node(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_estimateGas', params: [{ from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', to, data }] }), signal: AbortSignal.timeout(60_000) })).json();
  if (r.error) throw new Error(`${CHAINS[id]}: ${r.error.message}`);
  return Math.ceil(Number(BigInt(r.result)) / 1000) * 1000;
}
const old = new Map();
try { for (const j of JSON.parse(readFileSync(SERVICE_OUT, 'utf8')).jobs) if (j.id === 'anon-wei-4') for (const s of j.steps) old.set(s.id, s.gas); } catch { /* none yet */ }
for (const s of steps) {
  if (s.gas) continue;
  if (arg('no-estimate')) { s.gas = old.get(s.id); if (!s.gas) throw new Error(`no gas for ${s.id}: run without --no-estimate`); continue; }
  s.gas = await estimate(s.chainId, s.to, s.data);
  console.log(`${s.id}: ${s.gas} gas on ${CHAINS[s.chainId]}`);
}

// ── what the page says about the job ──
const COPY = {
  title: 'Deploy the next anon.wei',
  tagline: `Put anon.wei's next version on Ethereum, its catch-up registry on four chains, and the first points: ${steps.length} transactions, from any wallet.`,
  about: [
    { h: 'What it does', p: 'anon.wei opens a new device by reading the pool\'s whole history, which on a busy chain takes a long time. The catch-up registry holds the pool\'s tree edge at a count, checked against the pool when it is posted, so a new device starts from the newest point and reads the older history in the background. The next version of the page also adds wallet apps by WalletConnect and a round of fixes.' },
    { h: 'What gets deployed', p: `The page's ${files.length} chunks on Ethereum (plain code the page is read from), then the registry on Ethereum, Base, Robinhood Chain and MegaETH at one address, then one catch-up point on Base and one on Robinhood Chain, where the pool's history is longest. The page's own contract and the anon.wei name are the steward's to set afterwards.` },
    { h: 'Who controls it', p: 'Nobody. The registry has no owner and no settings: anyone may post a point, and it keeps one only if the pool itself held that root at that count. The chunks are code with no owner.' },
    { h: 'Who can send it', p: 'Anyone. Each address is fixed in advance by the exact code, so the sender cannot change what lands there. A point is read from the chain\'s keeper when it is sent, and the registry refuses one the pool did not hold.' },
  ],
  links: [],
  verified: false,
  created: [],
  payloadUrl: '/tasks/anon-wei-4-payload.json',
};

// ── the files ──
const opensAt = Number(arg('opens', 0));
const kept = (s) => ({
  id: s.id, ...(s.chainId !== 1 ? { chainId: s.chainId } : {}), kind: s.kind, to: s.to, gas: s.gas,
  ...(s.kind === 'createx' ? { expected: s.expected, salt: s.salt, initCodeHash: s.initCodeHash, ...(s.bound === false ? { bound: false } : {}) } : { minSize: s.minSize }),
  minWei: String(s.bounds[0] * TAC), maxWei: String(s.bounds[1] * TAC),
});
const job = { id: 'anon-wei-4', chainId: 1, opensAt, steps: steps.map(kept) };
writeJobs(SERVICE_OUT, job);
writeJobs(PAGE_OUT, { ...job, ...COPY, steps: steps.map((s) => ({ ...kept(s), label: s.label, group: s.group })) });
writeFileSync(PAYLOAD_OUT, JSON.stringify({ chainId: 1, factory: CREATEX, steps: steps.map((s) => (s.kind === 'post' ? { id: s.id, chainId: s.chainId, to: s.to, dynamic: 'point' } : { id: s.id, ...(s.chainId !== 1 ? { chainId: s.chainId } : {}), to: s.to, data: s.data, value: '0x0' })) }) + '\n');
console.log(`${steps.length} steps; opens ${opensAt || 'never (closed)'}; expected pay at the minimums ${steps.reduce((n, s) => n + s.bounds[0], 0n)} TAC, at the maximums ${steps.reduce((n, s) => n + s.bounds[1], 0n)} TAC`);

