// A relayer for the open board: anyone can run it with their own key. It reads the proofs waiting for a sender
// (GET /confidential/open), sends the first whose fee covers its settle with a margin, and reports the landing
// (POST /confidential/landed) so the holder's page reads it settled. The pool pays each fee leg the proof binds to the
// sender inside the same settle, and the proof fixes every other effect, so a sender can earn the fee and do nothing
// else. Two senders racing for one job cost the slower one a reverted simulation, never a reverted transaction: each
// settle is simulated first, and a private endpoint keeps it out of the public mempool.
//
//   RELAYER_KEY=0x… RPC_URL=https://… node src/open-relayer.js
//
// Env: RELAYER_KEY (the account that sends and is paid), RPC_URL (reads and simulation), SEND_RPC_URL (where the signed
// settle goes; default Flashbots Protect, fast mode, hash-only hints), API_BASE (default https://api.tacit.finance),
// MARGIN_BPS (fee over the settle's cost, default 2000 = 20%), POLL_SECS (default 15), ONCE=1 (one pass, then exit).
// Only tETH fee legs are priced here; a proof paid in another asset is left for a relayer that values it.

import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { pickOpen } from './lib/open-board.js';

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const API = env('API_BASE', 'https://api.tacit.finance').replace(/\/$/, '');
const ETH_ASSET_ID = env('ETH_ASSET_ID', '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34');
const ETH_UNIT_SCALE = BigInt(env('ETH_UNIT_SCALE', '10000000000'));
const MARGIN_BPS = BigInt(env('MARGIN_BPS', '2000'));
const POLL_SECS = Number(env('POLL_SECS', '15'));
const SETTLE_GAS = 600_000n; // an ordinary settle; the estimate below is what is actually sent
const POOL_ABI = parseAbi(['function settle(bytes publicValues, bytes proof, bytes[] memos)']);
const log = (...a) => console.log(`[open-relayer ${new Date().toISOString()}]`, ...a);

const k = env('RELAYER_KEY');
if (!k || !env('RPC_URL')) { console.error('set RELAYER_KEY and RPC_URL'); process.exit(1); }
const account = privateKeyToAccount(k.startsWith('0x') ? k : `0x${k}`);
const reader = createPublicClient({ chain: mainnet, transport: http(env('RPC_URL')) });
const sender = createWalletClient({ chain: mainnet, account, transport: http(env('SEND_RPC_URL', 'https://rpc.flashbots.net/fast?hint=hash')) });
const tried = new Map(); // jobId -> when it last failed here, so one bad proof is not simulated every pass

async function board() {
  const res = await fetch(`${API}/confidential/open?limit=64`);
  if (!res.ok) throw new Error(`board: HTTP ${res.status}`);
  return res.json();
}

async function pass() {
  const { pool, jobs } = await board();
  if (!pool || !jobs?.length) return false;
  const gasPrice = await reader.getGasPrice();
  const fresh = jobs.filter((j) => !(tried.get(j.jobId) > Date.now() - 10 * 60_000));
  // The board's own jobs carry no "posted" preference here: every job is priced by the fee it pays this sender.
  const pick = pickOpen(fresh.map((j) => ({ ...j, posted: true })), {
    settleCostWei: SETTLE_GAS * gasPrice, ethAssetId: ETH_ASSET_ID, ethUnitScale: ETH_UNIT_SCALE, marginBps: MARGIN_BPS,
  });
  if (!pick) return false;
  const call = { address: getAddress(pool), abi: POOL_ABI, functionName: 'settle', args: [pick.publicValues, pick.proof, pick.memos || []], account };
  let gas;
  try { await reader.simulateContract(call); gas = await reader.estimateContractGas(call); }
  catch (e) { tried.set(pick.jobId, Date.now()); log(`job ${pick.jobId}: the pool would refuse it now (${(e.shortMessage || e.message).slice(0, 120)})`); return true; }
  const block = await reader.getBlock({ blockTag: 'latest' });
  const tip = 10n ** 8n; // 0.1 gwei
  const h = await sender.sendTransaction({ to: call.address, data: encodeFunctionData(call), gas: (gas * 12n) / 10n,
    maxFeePerGas: (block.baseFeePerGas ?? gasPrice) * 2n + tip, maxPriorityFeePerGas: tip });
  log(`job ${pick.jobId} (${pick.type}): sent ${h}`);
  const r = await reader.waitForTransactionReceipt({ hash: h, timeout: 180_000 }).catch(() => null);
  if (!r) { log(`job ${pick.jobId}: ${h} not included yet; it may still land`); tried.set(pick.jobId, Date.now()); return true; }
  if (r.status !== 'success') { log(`job ${pick.jobId}: ${h} reverted`); tried.set(pick.jobId, Date.now()); return true; }
  const res = await fetch(`${API}/confidential/landed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: pick.jobId, txHash: h }) });
  log(`job ${pick.jobId}: settled in block ${r.blockNumber}; reported ${res.ok ? 'and recorded' : `(the API answered ${res.status})`}`);
  return true;
}

for (;;) {
  let worked = false;
  try { worked = await pass(); } catch (e) { log(`pass failed: ${e.message}`); }
  if (env('ONCE') === '1') break;
  if (!worked) await new Promise((r) => setTimeout(r, POLL_SECS * 1000));
}
