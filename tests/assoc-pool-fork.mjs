// Opt-in: the first-generation association-set pool's real contracts and circuits accept what dapp/assoc-pool.js builds.
// An anvil fork of Ethereum mainnet at the live head (anvil, network access and the pool's circuit files needed):
//   1  real Deposited events recompute their commitments with this module's Poseidon form
//   2  the approval service's two published leaf sets fold to the chain's roots (pool.currentRoot, entrypoint.latestRoot)
//   3  an account made from a Tacit key deposits; the new leaf folds to the pool's new root
//   4  the approval root is moved, as the service's poster, to include the deposit's label
//   5  a partial withdrawal to a fresh Tacit receive box is proved with the real circuit, verified, and relayed through
//      the entrypoint: the box and the relay receive what the fee split says; changing the recipient reverts
//   6  a new session from the key alone finds the deposit and its change, and spends the change in a second withdrawal
//   7  a deposit nobody approves is exited publicly with the commitment circuit, by its depositor only
//   8  the page's workflow (assoc-pool-session.js) end to end on a second key: load, deposit, review status, a withdrawal
//      through a stand-in relayer, a new session finding the change, a public exit, and a deposit index already taken
//   ASSOC_ARTIFACTS=<dir with withdraw.{wasm,zkey,vkey} commitment.{wasm,zkey,vkey}>   RPC=<mainnet url, default publicnode>
//   node tests/assoc-pool-fork.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import * as snarkjs from 'snarkjs';
import { secp, keccak_256, sha256, hmac, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { poseidon1, poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from '../dapp/vendor/tacit-poseidon.min.js';
import { makeAssocPool, ETH_POOL, SEL, TOPIC, CIRCUITS } from '../dapp/assoc-pool.js';
import { makeAssocSession } from '../dapp/assoc-pool-session.js';
import { makeEvmPoolZk } from '../dapp/evm-pool-zk.js';
import { evmPoolWallet, receiveKeys, receiveBoxAddress, EVM_POOL_ROUTER, RECEIVE_FEE_BPS } from '../dapp/evm-pool-gateway.js';

// The files are the pool's published circuit artifacts; CIRCUITS holds the hashes its SDK pins for them.
const PINS = Object.fromEntries(['withdraw', 'commitment'].flatMap((c) => ['wasm', 'zkey', 'vkey'].map((k) => [CIRCUITS[c][k].file, CIRCUITS[c][k].sha256])));
const ART = process.env.ASSOC_ARTIFACTS;
if (!ART) { console.log('ASSOC_ARTIFACTS must name a directory holding the six files in PINS'); process.exit(2); }
for (const [f, h] of Object.entries(PINS)) assert.equal(createHash('sha256').update(readFileSync(join(ART, f))).digest('hex'), h, `${f} is not the pinned artifact`);
const WASM = join(ART, 'withdraw.wasm'), ZKEY = join(ART, 'withdraw.zkey'), VKEY = JSON.parse(readFileSync(join(ART, 'withdraw.vkey'), 'utf8'));
const CWASM = join(ART, 'commitment.wasm'), CZKEY = join(ART, 'commitment.zkey'), CVKEY = JSON.parse(readFileSync(join(ART, 'commitment.vkey'), 'utf8'));

const UPSTREAM = process.env.RPC || 'https://ethereum-rpc.publicnode.com';
const ASP = 'https://api.0xbow.io', SCAN = 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api';
const POOL = ETH_POOL.pool, ENTRY = ETH_POOL.entrypoint;
const PORT = 21500 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hq = (n) => '0x' + BigInt(n).toString(16);
const ETH = 10n ** 18n;
let steps = 0;
const ok = (s) => { console.log('  ok -', s); steps++; };

const pool = makeAssocPool({ secp, keccak256: keccak_256, sha256, hmac, poseidon1, poseidon2, poseidon3 });
const P = { 1: poseidon1, 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });

let anvil = null;
const rpc = async (method, params = []) => {
  const r = await (await fetch(`http://127.0.0.1:${PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const call = (to, data, from) => rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const callBig = async (to, data) => BigInt(await call(to, data));
const bal = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
async function send(from, to, data, value = 0n) {
  const hash = await rpc('eth_sendTransaction', [{ from, to, data, value: hq(value), gas: '0x1e8480' }]);
  for (let i = 0; i < 60; i++) { const rc = await rpc('eth_getTransactionReceipt', [hash]); if (rc) return rc; await sleep(250); }
  throw new Error('the fork did not mine ' + hash);
}
async function startFork() {
  anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', UPSTREAM, '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
  process.on('exit', () => anvil.kill('SIGKILL'));
  for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }
  await rpc('anvil_autoImpersonateAccount', [true]);
}

const words = (data) => { const h = data.slice(2); return Array.from({ length: h.length / 64 }, (_, i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64))); };
function events(logs) {
  const deposits = [], withdrawals = [], ragequits = [];
  for (const l of logs) {
    const w = words(l.data), block = Number(l.blockNumber), tx = l.transactionHash;
    if (l.topics[0] === TOPIC.deposited) deposits.push({ depositor: '0x' + l.topics[1].slice(26), commitment: w[0], label: w[1], value: w[2], precommitment: w[3], block, tx });
    else if (l.topics[0] === TOPIC.withdrawn) withdrawals.push({ value: w[0], spentNullifier: w[1], newCommitment: w[2], block, tx });
    else if (l.topics[0] === TOPIC.ragequit) ragequits.push({ commitment: w[0], label: w[1], value: w[2], block, tx });
  }
  return { deposits, withdrawals, ragequits };
}
const toStr = (v) => (Array.isArray(v) ? v.map(toStr) : v.toString());
const proveWith = async (input, wasm, zkey, vkey) => {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, toStr(v)])), wasm, zkey);
  assert.ok(await snarkjs.groth16.verify(vkey, publicSignals, proof), 'the proof does not verify against the pinned key');
  return { proof, publicSignals };
};
const sel = (sig) => '0x' + hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const word = (n) => hex(Uint8Array.from(BigInt(n).toString(16).padStart(64, '0').match(/../g), (b) => parseInt(b, 16)));
const scanLogs = async (topic0, address, fromBlock) => {
  const r = await (await fetch(`${SCAN}?module=logs&action=getLogs&address=${address}&topic0=${topic0}&fromBlock=${fromBlock}&toBlock=latest&page=1&offset=1000`)).json();
  if (!Array.isArray(r.result)) throw new Error('explorer: ' + JSON.stringify(r).slice(0, 200));
  return r.result;
};

try {
  // ── the two published leaf sets, and a fork whose roots they match ──
  let state, asp, stateLevels, aspLevels, tries = 0;
  for (;; tries++) {
    const d = await (await fetch(`${ASP}/1/public/mt-leaves`, { headers: { 'X-Pool-Scope': String(ETH_POOL.scope) } })).json();
    state = d.stateTreeLeaves.map(BigInt); asp = d.aspLeaves.map(BigInt);
    stateLevels = pool.levelsOf(state); aspLevels = pool.levelsOf(asp);
    if (anvil) anvil.kill('SIGKILL');
    await startFork();
    if (pool.rootOf(stateLevels) === await callBig(POOL, SEL.currentRoot) && pool.rootOf(aspLevels) === await callBig(ENTRY, SEL.latestRoot)) break;
    if (tries >= 6) throw new Error('the published leaf sets never matched the chain head');
  }
  const forkBlock = Number(await rpc('eth_blockNumber'));
  ok(`2: ${state.length} state leaves and ${asp.length} approved labels fold to the pool's current root and the entrypoint's latest root (fork at block ${forkBlock})`);

  // ── real events ──
  {
    const real = events(await scanLogs(TOPIC.deposited, POOL, forkBlock - 300000)).deposits;
    assert.ok(real.length > 50, 'too few real events to mean anything');
    for (const e of real) assert.equal(pool.commitmentOf(e.value, e.label, e.precommitment), e.commitment);
    ok(`1: ${real.length} real Deposited events: commitment = Poseidon(value, label, precommitment) for every one`);
  }

  // ── the account, from a Tacit key ──
  const tacitPriv = new Uint8Array(randomBytes(32));
  const key = pool.poolKey(tacitPriv);
  await rpc('anvil_setBalance', [key.address, hq(10n * ETH)]);
  const keysOf = async (priv) => pool.masterKeys(await pool.phraseOf(pool.poolKey(priv).priv));
  const keys = await keysOf(tacitPriv);
  const scope = await callBig(POOL, SEL.scope);
  assert.equal(scope, ETH_POOL.scope);

  // ── a deposit ──
  const s0 = pool.depositSecrets(keys, scope, 0n), pre0 = pool.precommitmentOf(s0.nullifier, s0.secret);
  const rc1 = await send(key.address, ENTRY, pool.depositCalldata(pre0), 5n * 10n ** 16n);
  assert.equal(rc1.status, '0x1');
  const poolLogs = (rc) => rc.logs.filter((l) => l.address.toLowerCase() === POOL.toLowerCase());
  const dep = events(poolLogs(rc1)).deposits[0];
  assert.equal(dep.precommitment, pre0);
  assert.equal(dep.commitment, pool.commitmentOf(dep.value, dep.label, pre0));
  assert.equal(dep.depositor.toLowerCase(), key.address.toLowerCase());
  const afterDeposit = pool.levelsOf([...state, dep.commitment]);
  assert.equal(pool.rootOf(afterDeposit), await callBig(POOL, SEL.currentRoot));
  const leafEv = poolLogs(rc1).find((l) => l.topics[0] === TOPIC.leafInserted);
  assert.equal(words(leafEv.data)[1], dep.commitment);
  ok(`3: deposit of 0.05 ETH from the pool key (${dep.value} after the entry fee); the commitment is the derived one and the new leaf folds to the pool's new root`);

  // ── approval: the service's poster adds the label ──
  const ru = (await scanLogs(TOPIC.rootUpdated, ENTRY, forkBlock - 600000)).sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber))).pop();
  const txj = await (await fetch(`${SCAN}?module=proxy&action=eth_getTransactionByHash&txhash=${ru.transactionHash}`)).json();
  const postman = txj.result.from;
  await rpc('anvil_setBalance', [postman, hq(ETH)]);
  const aspAfter = pool.levelsOf([...asp, dep.label]);
  const cid = new TextEncoder().encode('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
  const upd = sel('updateRoot(uint256,string)') + word(pool.rootOf(aspAfter)) + word(0x40) + word(cid.length) + hex(cid).padEnd(64, '0');
  const rcU = await send(postman, ENTRY, upd);
  assert.equal(rcU.status, '0x1', 'the poster could not move the approval root');
  assert.equal(await callBig(ENTRY, SEL.latestRoot), pool.rootOf(aspAfter));
  ok('4: the approval root now includes the deposit\'s label');

  // ── the first withdrawal: to a fresh receive box ──
  const wallet = evmPoolWallet(zk, tacitPriv);
  const boxAt = (i) => receiveBoxAddress(receiveKeys(zk, wallet, i).npk, RECEIVE_FEE_BPS, EVM_POOL_ROUTER);
  const box1 = boxAt(1), box2 = boxAt(2), feeTo = '0x7777777777777777777777777777777777777777', sender = '0x8888888888888888888888888888888888888888';
  await rpc('anvil_setBalance', [sender, hq(ETH)]);
  const chainRoots = async () => ({ stateRoots: new Set([await callBig(POOL, SEL.currentRoot)]), aspRoot: await callBig(ENTRY, SEL.latestRoot) });
  const acct1 = pool.scan({ keys, scope, deposits: [dep] })[0];
  const take1 = 2n * 10n ** 16n, bps = 10;
  const plan1 = pool.planWithdraw({ keys, acct: acct1, amount: take1, recipient: box1, feeRecipient: feeTo, feeBps: bps, stateLevels: afterDeposit, aspLevels: aspAfter });
  assert.equal(pool.check(plan1, await chainRoots()), null);
  const t0 = Date.now();
  const pr1 = await proveWith(plan1.input, WASM, ZKEY, VKEY);
  assert.deepEqual(pr1.publicSignals.map(BigInt), plan1.expect);
  console.log(`   proved and verified in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const args1 = pool.proofArgs(pr1.proof, pr1.publicSignals);
  // the proof is bound to its recipient: a different one reverts
  const other = { ...plan1.withdrawal, data: pool.withdrawalData('0x9999999999999999999999999999999999999999', feeTo, bps) };
  await assert.rejects(() => call(ENTRY, pool.relayCalldata(other, args1, scope), sender), /revert/i);
  const before = { box: await bal(box1), fee: await bal(feeTo), pool: await bal(POOL) };
  const rc2 = await send(sender, ENTRY, pool.relayCalldata(plan1.withdrawal, args1, scope));
  assert.equal(rc2.status, '0x1');
  const fee1 = (take1 * BigInt(bps)) / 10000n;
  assert.equal((await bal(box1)) - before.box, take1 - fee1);
  assert.equal((await bal(feeTo)) - before.fee, fee1);
  assert.equal(before.pool - (await bal(POOL)), take1);
  const wev = events(poolLogs(rc2)).withdrawals[0];
  assert.equal(wev.spentNullifier, plan1.expect[1]);
  assert.equal(wev.newCommitment, plan1.newCommitment);
  assert.equal(wev.value, take1);
  await assert.rejects(() => call(ENTRY, pool.relayCalldata(plan1.withdrawal, args1, scope), sender), /revert/i);
  ok(`5: 0.02 ETH to the receive box ${box1.slice(0, 10)}… through the entrypoint (the box got ${take1 - fee1}, the relay ${fee1}); another recipient and a replay both revert`);

  // ── a new session, from the key alone ──
  const after1 = events(await rpc('eth_getLogs', [{ address: POOL, fromBlock: hq(forkBlock), toBlock: 'latest', topics: [[TOPIC.deposited, TOPIC.withdrawn, TOPIC.ragequit]] }]));
  const keys2 = await keysOf(tacitPriv);
  const found2 = pool.scan({ keys: keys2, scope, ...after1 });
  assert.equal(found2.length, 1);
  assert.equal(found2[0].children.length, 1);
  assert.equal(found2[0].last.value, dep.value - take1);
  assert.equal(found2[0].last.commitment, plan1.newCommitment);
  const afterW1 = pool.levelsOf([...state, dep.commitment, plan1.newCommitment]);
  assert.equal(pool.rootOf(afterW1), await callBig(POOL, SEL.currentRoot));
  const take2 = 10n ** 16n;
  const plan2 = pool.planWithdraw({ keys: keys2, acct: found2[0], amount: take2, recipient: box2, feeRecipient: feeTo, feeBps: bps, stateLevels: afterW1, aspLevels: aspAfter });
  assert.equal(pool.check(plan2, await chainRoots()), null);
  const pr2 = await proveWith(plan2.input, WASM, ZKEY, VKEY);
  assert.deepEqual(pr2.publicSignals.map(BigInt), plan2.expect);
  const b2 = await bal(box2);
  const rc3 = await send(sender, ENTRY, pool.relayCalldata(plan2.withdrawal, pool.proofArgs(pr2.proof, pr2.publicSignals), scope));
  assert.equal(rc3.status, '0x1');
  assert.equal((await bal(box2)) - b2, take2 - (take2 * BigInt(bps)) / 10000n);
  const found3 = pool.scan({ keys: keys2, scope, ...events(await rpc('eth_getLogs', [{ address: POOL, fromBlock: hq(forkBlock), toBlock: 'latest', topics: [[TOPIC.deposited, TOPIC.withdrawn, TOPIC.ragequit]] }])) });
  assert.equal(found3[0].children.length, 2);
  assert.equal(found3[0].last.value, dep.value - take1 - take2);
  assert.equal(pool.nextIndex(found3), 1n);
  ok('6: a fresh session from the key alone found the deposit and its change, spent the change (child 1) through the circuit, and then found both withdrawals');

  // ── a deposit nobody approves: exit it publicly ──
  const s1 = pool.depositSecrets(keys2, scope, pool.nextIndex(found3)), pre1 = pool.precommitmentOf(s1.nullifier, s1.secret);
  const rc4 = await send(key.address, ENTRY, pool.depositCalldata(pre1), 3n * 10n ** 16n);
  assert.equal(rc4.status, '0x1');
  const dep2 = events(poolLogs(rc4)).deposits[0];
  const logs4 = events(await rpc('eth_getLogs', [{ address: POOL, fromBlock: hq(forkBlock), toBlock: 'latest', topics: [[TOPIC.deposited, TOPIC.withdrawn, TOPIC.ragequit]] }]));
  const found4 = pool.scan({ keys: keys2, scope, ...logs4 });
  assert.equal(found4.length, 2);
  const acct2 = found4[1];
  assert.equal(acct2.index, 1n);
  assert.equal(acct2.label, dep2.label);
  const rq = pool.ragequitInput(acct2);
  const prq = await proveWith(rq.input, CWASM, CZKEY, CVKEY);
  assert.deepEqual(prq.publicSignals.map(BigInt), rq.expect);
  const rqData = pool.ragequitCalldata(pool.proofArgs(prq.proof, prq.publicSignals));
  await assert.rejects(() => call(POOL, rqData, sender), /revert/i);                 // only the original depositor
  const kb = await bal(key.address);
  const rc5 = await send(key.address, POOL, rqData);
  assert.equal(rc5.status, '0x1');
  const gas = BigInt(rc5.gasUsed) * BigInt(rc5.effectiveGasPrice);
  assert.equal((await bal(key.address)) - kb + gas, dep2.value);
  const rqEv = events(poolLogs(rc5)).ragequits[0];
  assert.equal(rqEv.label, dep2.label);
  assert.equal(rqEv.value, dep2.value);
  ok(`7: an unapproved deposit of ${dep2.value} wei came back to its depositor through the commitment circuit; another sender reverts`);

  // ── the session workflow, as the page drives it ──
  {
    const tacit2 = new Uint8Array(randomBytes(32));
    const key2 = pool.poolKey(tacit2);
    await rpc('anvil_setBalance', [key2.address, hq(10n * ETH)]);
    const approved = [dep.label];                                 // what the stand-in approval service lists beyond the live set
    const byPlace = (a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex));
    const forkLogs = (topics) => rpc('eth_getLogs', [{ address: POOL, fromBlock: hq(forkBlock), toBlock: 'latest', topics }]);
    const relayed = [];
    const fakeNet = {
      async leaves() {
        const ls = (await forkLogs([TOPIC.leafInserted])).sort(byPlace);
        return { aspLeaves: [...asp, ...approved], stateLeaves: [...state, ...ls.map((l) => words(l.data)[1])] };
      },
      async reviews(labels) { return new Map(labels.map((l) => [l, approved.includes(l) ? 'approved' : 'pending'])); },
      async config() { return { minDeposit: 10n ** 16n, vettingBps: 50n, maxRelayBps: 1000n }; },
      async head() { return { stateRoot: await callBig(POOL, SEL.currentRoot), aspRoot: await callBig(ENTRY, SEL.latestRoot), nonce: await callBig(POOL, SEL.nonce), treeSize: await callBig(POOL, SEL.currentTreeSize), block: Number(await rpc('eth_blockNumber')) }; },
      async stateRootKnown(r) { return r === (await callBig(POOL, SEL.currentRoot)); },
      async spent(nf) { return (await callBig(POOL, SEL.nullifierHashes + word(nf))) !== 0n; },
      async historyOf(addr) {
        const ev = events(await forkLogs([[TOPIC.deposited, TOPIC.withdrawn, TOPIC.ragequit]]));
        const mine = (a) => a.toLowerCase() === addr.toLowerCase();
        return { deposits: ev.deposits.filter((d) => mine(d.depositor)), withdrawals: ev.withdrawals, ragequits: ev.ragequits };
      },
      async allWithdrawals() { return { events: events(await forkLogs([TOPIC.withdrawn])).withdrawals, complete: null }; },
      async pickRelayer() {
        return {
          feeReceiver: feeTo, quotedBps: 10n, bps: 12n, capBps: 1000n, gasPrice: 1n, maxGasPrice: 0n,
          relayer: { async request({ withdrawal, proof, publicSignals }) {
            const rc = await send(sender, ENTRY, pool.relayCalldata(withdrawal, pool.proofArgs(proof, publicSignals), scope));
            relayed.push(rc);
            return { success: true, txHash: rc.transactionHash };
          } },
        };
      },
    };
    const prover = {
      async withdraw({ keys: k, acct, amount, recipient, feeRecipient, feeBps, stateLeaves, aspLeaves }) {
        const plan = pool.planWithdraw({ keys: k, acct, amount, recipient, feeRecipient, feeBps, stateLevels: pool.levelsOf(stateLeaves), aspLevels: pool.levelsOf(aspLeaves) });
        const { proof, publicSignals } = await proveWith(plan.input, WASM, ZKEY, VKEY);
        const { input, ...rest } = plan;
        return { plan: rest, proof, publicSignals };
      },
      async exit({ acct }) {
        const q = pool.ragequitInput(acct);
        const { proof, publicSignals } = await proveWith(q.input, CWASM, CZKEY, CVKEY);
        return { expect: q.expect, proof, publicSignals };
      },
    };
    const sendr = { key: (tx) => send(key2.address, tx.to, tx.data, tx.value ?? 0n) };
    const open = () => makeAssocSession({ pool, net: fakeNet, rpc, tacitPriv: tacit2, prover, sender: sendr, keccak256: keccak_256 });
    const session = open();

    assert.deepEqual(await session.load(), []);
    const d1 = await session.deposit({ amount: 5n * 10n ** 16n });
    assert.equal(d1.index, 0n);
    let notes = await session.load();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].status, 'reviewing');
    assert.equal(notes[0].balance, d1.value);
    // the ASP's poster lists the label
    approved.push(d1.label);
    const aspNow = pool.levelsOf([...asp, ...approved]);
    const cid2 = new TextEncoder().encode('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    assert.equal((await send(postman, ENTRY, sel('updateRoot(uint256,string)') + word(pool.rootOf(aspNow)) + word(0x40) + word(cid2.length) + hex(cid2).padEnd(64, '0'))).status, '0x1');
    notes = await session.load();
    assert.equal(notes[0].status, 'approved');

    const q = await session.quote(2n * 10n ** 16n);
    assert.equal(q.relayable, true);
    assert.equal(q.feeWei, (2n * 10n ** 16n * 12n) / 10000n);
    const steps8 = [];
    const dest = boxAt(3);
    const w1 = await session.withdraw({ note: notes[0], amount: 2n * 10n ** 16n, recipient: dest, onStep: (x) => steps8.push(x) });
    assert.deepEqual(steps8, ['lists', 'proving', 'sending', 'waiting']);
    assert.equal(w1.fee, (2n * 10n ** 16n * 12n) / 10000n);
    assert.equal(await bal(dest), w1.received);
    notes = session.notes();
    assert.equal(notes[0].balance, d1.value - 2n * 10n ** 16n);
    assert.equal(notes[0].children, 1);

    // a new session from the same key: the change is found, and spent
    const again = open();
    const n2 = await again.load();
    assert.equal(n2[0].balance, d1.value - 2n * 10n ** 16n);
    assert.equal(n2[0].children, 1);
    assert.equal(n2[0].status, 'approved');
    const dest2 = boxAt(4);
    const w2 = await again.withdraw({ note: n2[0], amount: 10n ** 16n, recipient: dest2 });
    assert.equal(await bal(dest2), w2.received);
    assert.equal(again.notes()[0].children, 2);

    // an unapproved deposit, then a public exit
    const d2 = await again.deposit({ amount: 3n * 10n ** 16n });
    assert.equal(d2.index, 1n);
    const n3 = await again.load();
    const note2 = n3.find((n) => n.label === d2.label);
    assert.equal(note2.status, 'reviewing');
    const kb2 = await bal(key2.address);
    const ex = await again.exit({ note: note2 });
    assert.equal(ex.value, note2.balance);
    assert.equal(again.notes().find((n) => n.label === d2.label).status, 'exited');
    assert.ok((await bal(key2.address)) > kb2 + ex.value - 10n ** 16n);

    // an index already taken by a deposit made elsewhere with this account: the session moves on
    const k2 = await pool.masterKeys(await pool.phraseOf(key2.priv));
    const taken = pool.depositSecrets(k2, scope, 2n), preTaken = pool.precommitmentOf(taken.nullifier, taken.secret);
    await rpc('anvil_setBalance', [sender, hq(10n * ETH)]);
    assert.equal((await send(sender, ENTRY, pool.depositCalldata(preTaken), 10n ** 16n)).status, '0x1');   // another wallet, the same account
    const d3 = await again.deposit({ amount: 10n ** 16n });
    assert.equal(d3.index, 3n);
    ok('8: the session loads an empty account, deposits (reviewing), sees the approval, withdraws through a relayer to a receive address, is found again by a new session which spends the change, exits an unapproved deposit, and steps past an index another wallet took');
  }

  console.log(`\n${steps} steps passed`);
  anvil.kill('SIGKILL');
  process.exit(0);
} catch (e) {
  console.error('\nFAILED:', e.stack || e);
  if (anvil) anvil.kill('SIGKILL');
  process.exit(1);
}
