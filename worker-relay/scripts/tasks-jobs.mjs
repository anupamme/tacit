// Builds the task job files for the TAC vault package from its deployment payload and manifest:
//   worker-relay/src/lib/points-tasks-jobs.json   what the points service verifies and prices (no call data)
//   dapp/tasks/jobs.json                          what the /tasks page shows (the same steps, with their labels)
//   dapp/tasks/tac-vaults-payload.json            the transactions a visitor sends, in order
//
//   node worker-relay/scripts/tasks-jobs.mjs --payload payload.json --manifest tac-vaults.json --rpc http://127.0.0.1:8546 [--opens <unix secs>]
//
// Each step's gas is measured, not guessed: with --rpc (an anvil fork of mainnet, whose first account sends them) the steps run in
// order and each one's gas used is read from its receipt, then the fork is rolled back. Without --rpc the gas already in
// the job files is kept, so the files can be rebuilt after a text change.
//
// The job opens at --opens (UTC seconds): a step mined before it is never credited, so a package deployed early pays nothing.
// Without it the job stays closed (opensAt 0 is read as "not open").
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak256, encodeAbiParameters } from 'viem';
import { writeJobs } from './tasks-merge.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE_OUT = `${root}worker-relay/src/lib/points-tasks-jobs.json`;
const PAGE_OUT = `${root}dapp/tasks/jobs.json`;
const PAYLOAD_OUT = `${root}dapp/tasks/tac-vaults-payload.json`;

const payload = JSON.parse(readFileSync(arg('payload'), 'utf8'));
const manifest = JSON.parse(readFileSync(arg('manifest'), 'utf8'));
const opensAt = Number(arg('opens', 0));

const saltOf = new Map(manifest.contracts.map((c) => [c.name, c.salt]));
const LABEL = {
  PRECISION_ORACLE: 'Price oracle for the Precision pool', AMM_ORACLE: 'Price oracle for the Tacit AMM', PAIR_ORACLE: 'Oracle that combines the two',
  ETH_FEED: 'Fixed ETH price feed', USD_VAULT: 'TAC-collateral vault that lends TACD (a dollar)', ETH_VAULT: 'TAC-collateral vault that lends TACE (ether)',
  TAC_POOL: 'EVM pool for TAC', TAC_ROUTER: 'Router for the TAC pool', USD_POOL: 'EVM pool for TACD', USD_ROUTER: 'Router for the TACD pool',
  ETH_POOL: 'EVM pool for TACE', ETH_ROUTER: 'Router for the TACE pool', USD_ZAP: 'Zap into the TACD vault', ETH_ZAP: 'Zap into the TACE vault',
  REGISTER_USD: 'Register TACD in the confidential pool', REGISTER_ETH: 'Register TACE in the confidential pool',
  PAIR_1: 'Create the TAC / TACD pair', PAIR_2: 'Create the TAC / TACE pair', PAIR_3: 'Create the ETH / TACE pair', PAIR_4: 'Create the TACD / TACE pair', PAIR_5: 'Create the TACD / cUSD pair',
};

// What the page says about the job, in neutral terms. Edit it here and run this script again.
const COPY = {
  title: 'Deploy the TAC vaults',
  tagline: 'Put the TAC vaults on Ethereum: 21 transactions, from any wallet.',
  about: [
    { h: 'What it does', p: 'Lets people deposit TAC and borrow TAC Dollar (TACD) or TAC Ether (TACE) against it. No interest, one fee when you borrow.' },
    { h: 'What gets deployed', p: 'Fourteen contracts: three price oracles, a fixed ETH feed, the two vaults, a pool and a router for each of TAC, TACD and TACE, and a zap into each vault. Then seven calls to the confidential pool register the two tokens and create five trading pairs.' },
    { h: 'Who controls it', p: 'The Tacit ops multisig (0x006C…49F2) owns both vaults and receives their fees. It can change the terms, the oracle or the minters only after an announced wait of two to three days, and only within fixed limits. It can also pause liquidations and redemptions for up to twelve hours at a time.' },
    { h: 'Who can send it', p: 'Anyone. Each address is fixed in advance from the exact code, its settings and its owner, so the sender cannot change what lands there.' },
  ],
  links: [
    { label: 'LeftClaw audit report', href: 'https://bafkreia5dlfgcnxsp2mdbwkvtpovg3ob7dizqgcjeulgx5uopahzh2tpeq.ipfs.community.bgipfs.com/' },
  ],
  // Set once every contract's source is verified on Etherscan, which the page then says and links.
  verified: true,
  // What the job's contracts created in turn: the vaults make their own tokens.
  created: [
    { label: 'TACD token', address: manifest.synths.USD },
    { label: 'TACE token', address: manifest.synths.ETH },
  ],
  payloadUrl: '/tasks/tac-vaults-payload.json',
};
const slug = (n) => n.toLowerCase().replace(/_/g, '-');

const steps = [];
payload.deployments.forEach((d, i) => {
  if (!saltOf.has(d.name)) throw new Error(`no salt for ${d.name}`);
  steps.push({ id: `${String(i + 1).padStart(2, '0')}-${slug(d.name)}`, name: d.name, label: LABEL[d.name], kind: 'createx', to: d.to, data: d.data, expected: d.expectedAddress, salt: saltOf.get(d.name), initCodeHash: d.initCodeHash, contract: d.contract });
});
const assets = [manifest.confidentialPool.assets.USD, manifest.confidentialPool.assets.ETH];
payload.registry.forEach((r, i) => {
  const n = payload.deployments.length + i + 1;
  const id = `${String(n).padStart(2, '0')}-${slug(r.name)}`;
  if (r.name.startsWith('REGISTER_')) steps.push({ id, name: r.name, label: LABEL[r.name], kind: 'register', to: r.to, data: r.data, asset: assets[i], dataHash: keccak256(r.data) });
  else {
    // createPair(assetA, assetB, feeBps, …): the pool's id is the hash of the sorted pair and the fee.
    const [a, b, fee] = [4, 36, 68].map((o) => `0x${r.data.slice(2 + o * 2, 2 + (o + 32) * 2)}`);
    const [lo, hi] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    steps.push({ id, name: r.name, label: LABEL[r.name], kind: 'pair', to: r.to, data: r.data, dataHash: keccak256(r.data), poolId: keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], [lo, hi, BigInt(fee)])) });
  }
});

// ── gas ──
const old = existsSync(SERVICE_OUT) ? JSON.parse(readFileSync(SERVICE_OUT, 'utf8')).jobs.find((j) => j.id === 'tac-vaults') : null;
const gasOf = new Map((old?.steps ?? []).map((s) => [s.id, s.gas]));
if (arg('rpc')) {
  const rpc = async (method, params = []) => {
    const r = await (await fetch(arg('rpc'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  };
  const [from] = await rpc('eth_accounts');
  const snap = await rpc('evm_snapshot');
  try {
    for (const s of steps) {
      const hash = await rpc('eth_sendTransaction', [{ from, to: s.to, data: s.data, value: '0x0' }]);
      let rc = null;
      for (let i = 0; !rc && i < 50; i++) { rc = await rpc('eth_getTransactionReceipt', [hash]); if (!rc) await new Promise((r) => setTimeout(r, 200)); }
      if (rc.status !== '0x1') throw new Error(`${s.id} reverted on the fork`);
      gasOf.set(s.id, Math.ceil(Number(BigInt(rc.gasUsed)) / 1000) * 1000);
      console.log(`${s.id}: ${BigInt(rc.gasUsed)} gas`);
    }
  } finally { await rpc('evm_revert', [snap]); }
}
for (const s of steps) if (!gasOf.get(s.id)) throw new Error(`no gas for ${s.id}: run with --rpc`);

const kept = (s) => ({ id: s.id, kind: s.kind, to: s.to, gas: gasOf.get(s.id), ...(s.kind === 'createx' ? { expected: s.expected, salt: s.salt, initCodeHash: s.initCodeHash } : s.kind === 'register' ? { asset: s.asset, dataHash: s.dataHash } : { dataHash: s.dataHash, poolId: s.poolId }) });
const job = { id: 'tac-vaults', chainId: payload.chainId, opensAt, steps: steps.map(kept) };
writeJobs(SERVICE_OUT, job);
writeJobs(PAGE_OUT, { ...job, ...COPY, steps: steps.map((s) => ({ ...kept(s), name: s.name, label: s.label, ...(s.contract ? { contract: s.contract } : {}) })) });
writeFileSync(PAYLOAD_OUT, `${JSON.stringify({ chainId: payload.chainId, factory: payload.factory, steps: steps.map((s) => ({ id: s.id, to: s.to, data: s.data, value: '0x0' })) })}\n`);
console.log(`${steps.length} steps, ${steps.reduce((n, s) => n + gasOf.get(s.id), 0)} gas; opens ${opensAt || 'never (closed)'}`);
