#!/usr/bin/env node
// What the ops multisig signs to move the TAC vaults' first lending terms: the minimum debt down and the depth share up, on both vaults, as one
// transaction per step (the multisig's own `batch`), with the typed data its owners sign and the call that sends it once enough have.
//
//   RPC=<endpoint> node tools/tac-vault-multisig.mjs plan                       the steps, the numbers and what each allows
//   RPC=<endpoint> node tools/tac-vault-multisig.mjs payload <queue|execute>    the typed data to sign, its digest, and the approval call, at the multisig's next nonce
//   RPC=<endpoint> node tools/tac-vault-multisig.mjs assemble <queue|execute> <sig|approved:0xowner>...   the `execute` call data from the signatures collected
//   RPC=<endpoint> node tools/tac-vault-multisig.mjs queued <queue|execute> <nonce>   when that step may be run, and its `executeQueued` call data
//
// How the multisig works (Multisig, 2 of 4, a delay of an hour): the owners sign Execute(target, value, data, nonce), anyone sends `execute` with
// the signatures sorted by signer, and the call is queued; after the delay anyone sends `executeQueued`. The vaults then add their own wait: a
// term announced by `queueParam` is applied by `executeParam` two days later and not after fourteen more. So the order is
//   queue step:   sign, send `execute`, wait an hour, send `executeQueued`        (the vaults announce)
//   two days later, execute step: the same three moves                           (the vaults apply the terms)
// Sign the execute step only when it is due: its nonce is the multisig's next at that time. A signature is for one nonce and one set of terms.
// Each owner may instead approve the digest on chain (`approve(digest, true)`) and give `approved:<owner address>` in place of a signature.
//
// The terms: each vault's MIN_DEBT goes to a tenth of its base, the floor the contract allows, and its DEPTH_BPS to twice what it is plus 25
// (15 → 55), the most one change allows. Override with MIN_DEBT_USD / MIN_DEBT_ETH (wei) and DEPTH_BPS. Nothing is sent: this prints.

import { execFileSync } from 'node:child_process';

const RPC = process.env.RPC;
if (!RPC) { console.error('set RPC'); process.exit(2); }
const MULTISIG = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const VAULTS = [['usd', 'TACD', '0x00000087ac9ed3E1Bd443E00FBe18B4EdcAEeb1F'], ['eth', 'TACE', '0x00000047bFC8cF504967049D9Cf9E1FD9651ED80']];
const DEPTH = 0, MIN_DEBT = 6;                                             // TacVault.Param
const cast = (args) => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const view = (to, sig, ...a) => cast(['call', to, sig, ...a, '--rpc-url', RPC]).split('\n')[0].split(' ')[0];
const eth = (wei) => `${(Number(wei) / 1e18).toFixed(4)}`;

// The terms asked for each vault, from what the vault holds now.
function terms() {
  return VAULTS.map(([key, sym, vault]) => {
    const base = BigInt(view(vault, 'MIN_DEBT_BASE()(uint256)'));
    const depthNow = BigInt(view(vault, 'DEPTH_BPS()(uint256)')), minNow = BigInt(view(vault, 'MIN_DEBT()(uint256)'));
    const depth = BigInt(process.env.DEPTH_BPS ?? (2n * depthNow + 25n));
    const min = BigInt(process.env[`MIN_DEBT_${key.toUpperCase()}`] ?? base / 10n);
    let ceiling = null;                                                    // the cap needs a price (a stale ETH/USD feed or an unrecorded window refuses), and only `plan` shows it
    try { ceiling = BigInt(view(vault, 'depthCeiling()(uint256)')); } catch { /* shown as unknown */ }
    return { key, sym, vault, base, depthNow, minNow, depth, min, ceiling };
  });
}

// The calls of a step, and the multisig call that makes them together.
function calls(step, ts) {
  return ts.flatMap((t) => (step === 'queue'
    ? [[t.vault, cast(['calldata', 'queueParam(uint8,uint256)', String(MIN_DEBT), String(t.min)])], [t.vault, cast(['calldata', 'queueParam(uint8,uint256)', String(DEPTH), String(t.depth)])]]
    : [[t.vault, cast(['calldata', 'executeParam(uint8)', String(MIN_DEBT)])], [t.vault, cast(['calldata', 'executeParam(uint8)', String(DEPTH)])]]));
}
function batch(step, ts) {
  const list = calls(step, ts);
  const data = cast(['calldata', 'batch(address[],uint256[],bytes[])', `[${list.map((c) => c[0]).join(',')}]`, `[${list.map(() => 0).join(',')}]`, `[${list.map((c) => c[1]).join(',')}]`]);
  return { list, data };
}
const nonceNow = () => Number(view(MULTISIG, 'nonce()(uint32)'));
const digestOf = (data, nonce) => cast(['call', MULTISIG, 'getTransactionHash(address,uint256,bytes,uint32)(bytes32)', MULTISIG, '0', data, String(nonce), '--rpc-url', RPC]);

function needStep(s) { if (s !== 'queue' && s !== 'execute') { console.error('the step is queue or execute'); process.exit(2); } return s; }

const [cmd, a1, ...rest] = process.argv.slice(2);

if (cmd === 'plan') {
  const ts = terms();
  const delay = Number(view(MULTISIG, 'delay()(uint32)'));
  console.log(`ops multisig ${MULTISIG}: ${view(MULTISIG, 'threshold()(uint16)')} of ${view(MULTISIG, 'ownerCount()(uint16)')}, delay ${delay / 60} min, next nonce ${nonceNow()}`);
  for (const t of ts) {
    const ceilAfter = t.ceiling == null ? null : t.ceiling * t.depth / t.depthNow;
    console.log(`\n${t.sym} vault ${t.vault}`);
    console.log(`  minimum debt   ${eth(t.minNow)} → ${eth(t.min)} ${t.sym}   (base ${eth(t.base)}, floor ${eth(t.base / 10n)})`);
    console.log(`  depth share    ${t.depthNow} → ${t.depth} bps   (one change may reach 2x + 25 = ${2n * t.depthNow + 25n})`);
    console.log(ceilAfter == null ? '  lending cap    not priced just now (the oracle window or the ETH/USD feed)' : `  lending cap    ${eth(t.ceiling)} → about ${eth(ceilAfter)} ${t.sym} in total at today's depth${ceilAfter >= t.min ? ', which is room for a vault of the minimum' : ', STILL UNDER the minimum'}`);
  }
  console.log('\nsteps: queue now (multisig execute, then executeQueued after the delay), then execute two days after the vaults announce');
} else if (cmd === 'payload') {
  const step = needStep(a1), ts = terms(), { list, data } = batch(step, ts), nonce = nonceNow();
  if (step === 'queue') {
    for (const [target, d] of list) cast(['call', target, '--data', d, '--from', MULTISIG, '--rpc-url', RPC]);      // each call as the multisig, so one the vault would refuse stops here
  }
  const digest = digestOf(data, nonce);
  const typedData = {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Execute: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'nonce', type: 'uint32' }] },
    primaryType: 'Execute', domain: { name: 'Multisig', version: '1', chainId: 1, verifyingContract: MULTISIG }, message: { target: MULTISIG, value: '0', data, nonce },
  };
  console.log(JSON.stringify({
    step, to: MULTISIG, target: MULTISIG, value: '0', nonce, digest,
    does: list.map(([v, d]) => `${VAULTS.find((x) => x[2] === v)[1]} vault ${v}: ${step === 'queue' ? 'queueParam' : 'executeParam'}(${Number(`0x${d.slice(10, 74)}`) === MIN_DEBT ? 'minDebt' : 'depthBps'}${step === 'queue' ? `, ${BigInt(`0x${d.slice(74, 138)}`)}` : ''})`),
    data, typedData,
    approveCall: { to: MULTISIG, data: cast(['calldata', 'approve(bytes32,bool)', digest, 'true']) },
    signWithCast: `cast wallet sign --no-hash ${digest} --account <keystore>   (each owner; any two)`,
  }, null, 2));
} else if (cmd === 'assemble') {
  const step = needStep(a1), ts = terms(), { data } = batch(step, ts), nonce = nonceNow(), digest = digestOf(data, nonce);
  const threshold = Number(view(MULTISIG, 'threshold()(uint16)'));
  const pad = (h, n = 64) => h.replace(/^0x/, '').toLowerCase().padStart(n, '0');
  const entries = rest.map((s) => {
    if (s.startsWith('approved:')) {
      const owner = s.slice(9).toLowerCase();
      if (view(MULTISIG, 'approved(address,bytes32)(bool)', owner, digest) !== 'true') throw new Error(`${owner} has not approved ${digest}`);
      return { signer: owner, sig: `${pad(owner)}${'0'.repeat(64)}00` };
    }
    const h = s.replace(/^0x/, '');
    if (h.length !== 130) throw new Error('a signature is 65 bytes');
    const v = parseInt(h.slice(128), 16) < 27 ? parseInt(h.slice(128), 16) + 27 : parseInt(h.slice(128), 16);
    const out = cast(['call', '0x0000000000000000000000000000000000000001', '--data', `0x${pad(digest)}${pad(v.toString(16))}${h.slice(0, 64)}${h.slice(64, 128)}`, '--rpc-url', RPC]);
    const signer = `0x${out.slice(-40)}`.toLowerCase();
    return { signer, sig: `${h.slice(0, 128)}${v.toString(16)}` };
  });
  for (const e of entries) if (view(MULTISIG, 'isOwner(address)(bool)', e.signer) !== 'true') throw new Error(`${e.signer} is not an owner of the multisig (wrong nonce or terms?)`);
  const uniq = [...new Map(entries.map((e) => [e.signer, e])).values()].sort((x, y) => (BigInt(x.signer) < BigInt(y.signer) ? -1 : 1));
  if (uniq.length < threshold) throw new Error(`${uniq.length} owners of ${threshold} needed`);
  const sigs = `0x${uniq.slice(0, threshold).map((e) => e.sig).join('')}`;
  const call = cast(['calldata', 'execute(address,uint256,bytes,bytes)', MULTISIG, '0', data, sigs]);
  console.log(JSON.stringify({ step, nonce, digest, signers: uniq.slice(0, threshold).map((e) => e.signer), to: MULTISIG, value: '0', data: call }, null, 2));
} else if (cmd === 'queued') {
  const step = needStep(a1), nonce = rest[0];
  if (nonce == null) { console.error('give the nonce the step was sent at'); process.exit(2); }
  const { data } = batch(step, terms()), digest = digestOf(data, Number(nonce));
  const eta = BigInt(view(MULTISIG, 'queued(bytes32)(uint256)', digest));
  const now = BigInt(cast(['block', 'latest', '--field', 'timestamp', '--rpc-url', RPC]));        // the chain's clock, which is what the multisig tests
  console.log(JSON.stringify({
    step, nonce: Number(nonce), digest, queuedUntil: eta === 0n ? null : new Date(Number(eta) * 1000).toISOString(),
    state: eta === 0n ? 'not queued (not sent, or already run)' : now >= eta ? 'ready: anyone can send executeQueued' : `wait ${Number(eta - now)} s`,
    to: MULTISIG, value: '0', data: cast(['calldata', 'executeQueued(address,uint256,bytes,uint32)', MULTISIG, '0', data, String(nonce)]),
  }, null, 2));
} else {
  console.error('plan | payload <queue|execute> | assemble <queue|execute> <sig>... | queued <queue|execute> <nonce>');
  process.exit(2);
}
