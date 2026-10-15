// Prove a confidential-pool op with your own Succinct prover-network account, then send its settle yourself or put it on
// the open board for any relayer to send. Nothing here asks Tacit's relay to prove anything, and the witness goes only to
// the network (as a private input: the binaries request with private_stdin, so only the network's executor and the
// prover that wins the job can read it).
//
//   node src/self-prove.js deposit <PROVE>          approve + SuccinctVApp.deposit from NETWORK_PRIVATE_KEY's account. The
//                                                   network credits it once indexed (up to about 5 minutes). One groth16
//                                                   request needs about 1 PROVE on hand and spends about 0.4.
//   node src/self-prove.js prove <job.json> [--send | --post]
//        job.json = { "type", "op", "memos" }: exactly what a page submits to /confidential/submit (the op witness and the
//        memos sealed for it). The exec-<op> binary for the type proves it; public_values.hex and proof_bytes.hex are
//        written next to job.json.
//        --send   simulate, then send settle() from SETTLE_KEY (default: NETWORK_PRIVATE_KEY's account). It is paid
//                 the fee legs the proof binds, so a holder settling their own op gets any fee back.
//        --post   post the proof to the open board (POST /confidential/submit, mode 'preproven'); whoever sends it is
//                 paid its fee, Tacit's relay included when that fee covers the settle.
//   node src/self-prove.js send <job.json>          send a proof made earlier (the .hex files beside job.json).
//
// Env: NETWORK_PRIVATE_KEY (the account whose vApp credit pays; an EOA), RPC_URL (Ethereum JSON-RPC), SETTLE_KEY
// (optional), PROVER_BIN_DIR (the exec-* binaries; default prover/bin, as the relay image lays them out; they are the
// Linux x86-64 builds of the prover-bins release, checked against prover/bin/SHA256SUMS before they run), API_BASE
// (default https://api.tacit.finance), POOL_ADDR, EXPECT_VKEY (the pool's pinned program vkey).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, parseUnits, encodeFunctionData, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const POOL = getAddress(env('POOL_ADDR', '0x000000000Ed1eabD231Be41d93b719056F7febFC'));
const VAPP = getAddress(env('VAPP_DEPOSIT_ADDR', '0x5Ad5Bc4B18f7c173DcE17A57682Cb0Dc8788951F'));
const PROVE = getAddress(env('PROVE_TOKEN_ADDR', '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29'));
const API = env('API_BASE', 'https://api.tacit.finance').replace(/\/$/, '');
const BIN_DIR = path.resolve(env('PROVER_BIN_DIR', path.join(HERE, '..', 'prover', 'bin')));
const EXPECT_VKEY = env('EXPECT_VKEY', '0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3');
// Relay op type → its prover binary (the same map as lib/prover.js).
const BIN = {
  wrap: 'exec-wrap', transfer: 'exec-prove', unwrap: 'exec-unwrap', sendunwrap: 'exec-sendunwrap', swap: 'exec-swap', route: 'exec-route',
  lp: 'exec-lp', lpremove: 'exec-lpremove', lpbond: 'exec-lpbond', otc: 'exec-otc', bid: 'exec-bid', bridgeburn: 'exec-bridgeburn',
  cdpmint: 'exec-cdpmint', cdpclose: 'exec-cdpclose', cdptopup: 'exec-cdptopup', cdpliquidate: 'exec-cdpliquidate',
  stealthlock: 'exec-stealthlock', stealthclaim: 'exec-stealthclaim', stealthrefund: 'exec-stealthrefund', stealthlockbatch: 'exec-stealthlockbatch',
  farmbond: 'exec-farmbond', farmharvest: 'exec-farmharvest', farmunbond: 'exec-farmunbond',
  adaptorlock: 'exec-adaptorlock', adaptorclaim: 'exec-adaptorclaim', adaptorrefund: 'exec-adaptorrefund',
};
const POOL_ABI = parseAbi(['function settle(bytes publicValues, bytes proof, bytes[] memos)']);
const ERC20_ABI = parseAbi(['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const VAPP_ABI = parseAbi(['function deposit(uint256 amount)', 'function minDepositAmount() view returns (uint256)']);

const die = (msg) => { console.error(msg); process.exit(1); };
const key = (name) => { const k = env(name); if (!k) die(`set ${name}`); return k.startsWith('0x') ? k : `0x${k}`; };
const rpc = () => env('RPC_URL') || die('set RPC_URL (an Ethereum mainnet JSON-RPC endpoint)');
const pub = () => createPublicClient({ chain: mainnet, transport: http(rpc()) });
const wallet = (k) => createWalletClient({ chain: mainnet, transport: http(rpc()), account: privateKeyToAccount(k) });

async function deposit(amountText) {
  if (!amountText) die('usage: self-prove.js deposit <PROVE>');
  const w = wallet(key('NETWORK_PRIVATE_KEY')), c = pub(), me = w.account.address;
  const amt = parseUnits(String(amountText), 18);
  const [min, bal, allowance] = await Promise.all([
    c.readContract({ address: VAPP, abi: VAPP_ABI, functionName: 'minDepositAmount' }).catch(() => 0n),
    c.readContract({ address: PROVE, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] }),
    c.readContract({ address: PROVE, abi: ERC20_ABI, functionName: 'allowance', args: [me, VAPP] }),
  ]);
  if (amt < min) die(`the vApp takes at least ${Number(min) / 1e18} PROVE`);
  if (bal < amt) die(`${me} holds ${Number(bal) / 1e18} PROVE, less than ${amountText}`);
  if (allowance < amt) {
    const h = await w.writeContract({ address: PROVE, abi: ERC20_ABI, functionName: 'approve', args: [VAPP, amt] });
    console.log(`approve ${h}`);
    await c.waitForTransactionReceipt({ hash: h });
  }
  const h = await w.writeContract({ address: VAPP, abi: VAPP_ABI, functionName: 'deposit', args: [amt] });
  const r = await c.waitForTransactionReceipt({ hash: h });
  if (r.status !== 'success') die(`deposit reverted: ${h}`);
  console.log(`deposited ${amountText} PROVE for ${me}: ${h}. The network credits it once indexed (up to about 5 minutes).`);
}

// A binary runs only when its bytes are the ones the release pinned.
async function checkedBin(name) {
  const file = path.join(BIN_DIR, name);
  const sums = await readFile(path.join(BIN_DIR, 'SHA256SUMS'), 'utf8').catch(() => die(`no SHA256SUMS in ${BIN_DIR}`));
  const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === name)?.[0];
  if (!want) die(`${name} is not in ${BIN_DIR}/SHA256SUMS`);
  const got = createHash('sha256').update(await readFile(file).catch(() => die(`no ${file}: fetch the prover-bins release into ${BIN_DIR}`))).digest('hex');
  if (got !== want) die(`${file} does not match its pinned sha256 (${got} != ${want})`);
  return file;
}

function run(bin, { cwd, extraEnv }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

async function readJob(file) {
  const job = JSON.parse(await readFile(file, 'utf8'));
  if (!job || typeof job !== 'object' || !job.type || !job.op) die('job.json must hold { type, op, memos }');
  if (!BIN[job.type]) die(`no prover binary for type ${job.type} here (have: ${Object.keys(BIN).join(', ')})`);
  return { ...job, memos: Array.isArray(job.memos) ? job.memos : [] };
}

async function prove(file) {
  const job = await readJob(file);
  const dir = path.dirname(path.resolve(file));
  const bin = await checkedBin(BIN[job.type]);
  // The guest commits to keccak256 of each memo; the settle carries the memos themselves and the pool checks the two match.
  const memoHashes = job.memos.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
  const opFile = path.join(dir, `${job.type}_op.json`);
  await writeFile(opFile, JSON.stringify({ ...job.op, memoHashes }));
  console.log(`proving ${job.type} on the Succinct network with ${privateKeyToAccount(key('NETWORK_PRIVATE_KEY')).address}'s credit…`);
  const code = await run(bin, { cwd: dir, extraEnv: {
    MODE: 'groth16', OP_TYPE: job.type, OP_FILE: opFile, SP1_PROVER: 'network', EXPECT_VKEY,
    NETWORK_PRIVATE_KEY: key('NETWORK_PRIVATE_KEY'), NETWORK_RPC_URL: env('NETWORK_RPC_URL', 'https://rpc.mainnet.succinct.xyz'),
  } });
  const proof = await readProof(dir).catch(() => die(`the prover exited ${code} with no proof`));
  console.log(`proved: public values ${proof.publicValues.length / 2 - 1} bytes, proof ${proof.proof.length / 2 - 1} bytes`);
  return { job, proof };
}

async function readProof(dir) {
  const hex = async (f) => { const s = (await readFile(path.join(dir, f), 'utf8')).trim().replace(/^0x/, ''); if (!/^[0-9a-fA-F]+$/.test(s)) throw new Error(f); return `0x${s}`; };
  return { publicValues: await hex('public_values.hex'), proof: await hex('proof_bytes.hex') };
}

async function send({ publicValues, proof }, memos) {
  const w = wallet(env('SETTLE_KEY') ? key('SETTLE_KEY') : key('NETWORK_PRIVATE_KEY')), c = pub();
  const call = { address: POOL, abi: POOL_ABI, functionName: 'settle', args: [publicValues, proof, memos], account: w.account };
  try { await c.simulateContract(call); }
  catch (e) { die(`the pool would refuse this settle now: ${e.shortMessage || e.message}`); }
  const gas = await c.estimateContractGas(call);
  const h = await w.sendTransaction({ to: POOL, data: encodeFunctionData(call), gas: (gas * 12n) / 10n });
  console.log(`settle sent from ${w.account.address}: ${h}`);
  const r = await c.waitForTransactionReceipt({ hash: h });
  console.log(r.status === 'success' ? `settled in block ${r.blockNumber}` : `settle reverted: ${h}`);
  if (r.status !== 'success') process.exit(1);
}

async function post(type, { publicValues, proof }, memos) {
  const res = await fetch(`${API}/confidential/submit`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, mode: 'preproven', publicValues, proof, memos }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(`the board refused it: ${body.error || res.status}`);
  console.log(`on the open board as ${body.jobId} (${body.status}); follow it at ${API}/confidential/status?id=${body.jobId}`);
}

const [cmd, arg, ...flags] = process.argv.slice(2);
if (cmd === 'deposit') await deposit(arg);
else if (cmd === 'prove') {
  if (!arg) die('usage: self-prove.js prove <job.json> [--send | --post]');
  const { job, proof } = await prove(arg);
  if (flags.includes('--send')) await send(proof, job.memos);
  else if (flags.includes('--post')) await post(job.type, proof, job.memos);
} else if (cmd === 'send') {
  if (!arg) die('usage: self-prove.js send <job.json>');
  const job = await readJob(arg);
  await send(await readProof(path.dirname(path.resolve(arg))), job.memos);
} else {
  die('usage: self-prove.js deposit <PROVE> | prove <job.json> [--send | --post] | send <job.json>');
}
