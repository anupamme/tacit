// The patient send against a real node (anvil, automine off): an offer nobody mines is replaced at the same nonce by a
// raised one that the node accepts, the earlier one never lands, and an offer that is mined at once is not replaced.
// Usage: node tests/patient-send-chain.test.mjs        (anvil on PATH)
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sendPatient, raised } from '../src/lib/patient-send.js';

let failures = 0, passed = 0;
const ok = (c, m, x = '') => { console.log(`${c ? 'ok' : 'not ok'} - ${m}${x ? '  ' + x : ''}`); c ? passed++ : failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 22545 + Math.floor(Math.random() * 2000), url = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--port', String(port), '--silent', '--base-fee', '1000000000', '--chain-id', '31337'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
const rpc = async (method, params = []) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
for (let i = 0; ; i++) { try { if (await rpc('eth_chainId')) break; } catch {} if (i > 120) throw new Error('anvil did not start'); await sleep(250); }

const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const pub = createPublicClient({ chain, transport: http(url) });
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ account, chain, transport: http(url) });
const hooks = (state) => ({
  send: async ({ tip, nonce }) => {
    const base = (await pub.getBlock({ blockTag: 'latest' })).baseFeePerGas;
    let fee = base * 2n + tip;
    if (nonce != null && state.last && fee < raised(state.last)) fee = raised(state.last);
    state.last = fee;
    return wallet.sendTransaction({ to: account.address, value: 0n, gas: 21_000n, maxFeePerGas: fee, maxPriorityFeePerGas: tip, ...(nonce != null && { nonce }) });
  },
  wait: (hash, ms) => pub.waitForTransactionReceipt({ hash, timeout: ms, pollingInterval: 200 }).catch((e) => (/timeout|timed out/i.test(String(e?.name || e?.message)) ? null : Promise.reject(e))),
  nonceOf: async (hash) => (await pub.getTransaction({ hash })).nonce,
  found: async (hashes) => { for (const hash of hashes) { const receipt = await pub.getTransactionReceipt({ hash }).catch(() => null); if (receipt) return { hash, receipt }; } return null; },
});
const TIPS = [1_000_000n, 500_000_000n, 1_000_000_000n];

await rpc('evm_setAutomine', [false]);
{
  const n0 = await pub.getTransactionCount({ address: account.address });
  const state = {}; let sent = 0;
  const h = hooks(state), send = h.send; h.send = async (o) => { sent++; return send(o); };
  // Nobody mines until the cheap offer has had its wait and been replaced.
  const miner = (async () => { while (sent < 2) await sleep(100); await sleep(300); await rpc('evm_mine'); })();
  const r = await sendPatient({ ...h, tips: TIPS, waitMs: 1200 });
  await miner;
  const tx = await pub.getTransaction({ hash: r.hash });
  ok(r.receipt.status === 'success' && r.raises === 1, 'an offer nobody mines is raised once, and the raise lands', `raises ${r.raises}`);
  ok(tx.maxPriorityFeePerGas === TIPS[1], 'at the second tip', String(tx.maxPriorityFeePerGas));
  ok((await pub.getTransactionCount({ address: account.address })) === n0 + 1, 'one nonce was used: the replacement took the first offer\'s place');
  const first = await rpc('eth_getTransactionByHash', [(await pub.getBlock({ blockNumber: r.receipt.blockNumber, includeTransactions: true })).transactions[0].hash]);
  ok(first && first.hash === r.hash, 'the block holds the replacement, not the cheap original');
}
{
  const n0 = await pub.getTransactionCount({ address: account.address });
  const state = {}; let sent = 0;
  const h = hooks(state), send = h.send; h.send = async (o) => { sent++; return send(o); };
  const miner = (async () => { while (sent < 1) await sleep(50); await sleep(150); await rpc('evm_mine'); })();
  const r = await sendPatient({ ...h, tips: TIPS, waitMs: 5000 });
  await miner;
  ok(r.raises === 0 && sent === 1 && r.tip === TIPS[0], 'an offer mined at once is the only one sent', `sent ${sent}`);
  ok((await pub.getTransactionCount({ address: account.address })) === n0 + 1, 'and uses one nonce');
}
console.log(`\n${passed} passed${failures ? `, ${failures} failed` : ''}`);
process.exit(failures ? 1 : 0);
