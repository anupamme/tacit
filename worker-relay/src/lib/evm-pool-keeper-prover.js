// Groth16 proving for the keeper's deposit completions (dapp/circuits/evm-pool/transact.circom), and the
// Poseidon-backed witness model. Every fresh proof is verified against the verification key before it is
// submitted, and the key can be pinned by hash. With EVM_POOL_KEEPER_NATIVE_PROVER set, the proof itself comes
// from rapidsnark's binary, with snarkjs behind it for any proof it does not give.

import { createHash } from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeEvmPoolZk } from '../../../dapp/evm-pool-zk.js';
import { N_PUBLIC, proveTransact, verifyTransact, vkHash as hashVk } from '../../../dapp/evm-pool-zk-prover.js';

export async function loadPoseidon() {
  const p = await import('poseidon-lite');
  const byArity = { 2: p.poseidon2, 3: p.poseidon3, 4: p.poseidon4, 5: p.poseidon5, 7: p.poseidon7 };
  return (xs) => {
    const f = byArity[xs.length];
    if (!f) throw new Error(`no Poseidon of arity ${xs.length}`);
    return f(xs);
  };
}

export async function loadZk() {
  return makeEvmPoolZk({ poseidon: await loadPoseidon() });
}

async function loadSnarkjs() {
  try { return await import('snarkjs'); }
  catch { return (await import('../../../dapp/vendor/tacit-mixer.min.js')).snarkjs; }
}

// snarkjs proof → the verifier's calldata shape (G2 coordinates swapped, as exportSolidityCallData does).
export function toSolidityProof(proof, publicSignals) {
  const b = (x) => BigInt(x);
  return {
    pA: [b(proof.pi_a[0]), b(proof.pi_a[1])],
    pB: [[b(proof.pi_b[0][1]), b(proof.pi_b[0][0])], [b(proof.pi_b[1][1]), b(proof.pi_b[1][0])]],
    pC: [b(proof.pi_c[0]), b(proof.pi_c[1])],
    publicInputs: publicSignals.map(b),
  };
}

// The inverse, for checking a proof that arrives as calldata.
export function fromSolidityProof({ pA, pB, pC }) {
  const s = (x) => BigInt(x).toString();
  return {
    protocol: 'groth16', curve: 'bn128',
    pi_a: [s(pA[0]), s(pA[1]), '1'],
    pi_b: [[s(pB[0][1]), s(pB[0][0])], [s(pB[1][1]), s(pB[1][0])], ['1', '0']],
    pi_c: [s(pC[0]), s(pC[1]), '1'],
  };
}

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

// A local path, or an https URL pinned by SHA-256 and cached under `dir` (fetched once, checked on every load).
export async function loadArtifact(src, { sha256 = '', dir, name, fetchImpl = fetch }) {
  const want = String(sha256).replace(/^0x/, '').toLowerCase();
  if (!/^https:\/\//.test(src)) {
    const b = readFileSync(src);
    if (want && sha256hex(b) !== want) throw new Error(`${name} at ${src} does not match its pinned sha256`);
    return b;
  }
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error(`${name} is fetched from a URL, so its sha256 must be pinned`);
  const file = join(dir, `${name}-${want}`);
  if (existsSync(file)) {
    const b = readFileSync(file);
    if (sha256hex(b) === want) return b;
  }
  const r = await fetchImpl(src);
  if (!r.ok) throw new Error(`${name}: ${src} returned ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (sha256hex(b) !== want) throw new Error(`${name} from ${src} does not match its pinned sha256`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.tmp`, b);
  renameSync(`${file}.tmp`, file);
  return b;
}

// The file an artifact is read from, as an absolute path (the binary runs in a directory of its own): the path itself, or where
// loadArtifact cached it (after it has loaded it).
export function artifactFile(src, { sha256 = '', dir, name }) {
  return resolve(/^https:\/\//.test(src) ? join(dir, `${name}-${String(sha256).replace(/^0x/, '').toLowerCase()}`) : src);
}

// snarkjs's curve library (ffjavascript) starts a worker thread for every CPU os.cpus() lists, and a container lists its host's, not
// its quota of a core or two: one proof then starts dozens of threads that use the quota up and starve the rest of the process,
// the health check included. What it is told of is capped here, once, before the first proof starts one.
let threadCap = 0;
export function capProverThreads(n) {
  if (!(n >= 1) || threadCap) return threadCap || null;
  const real = os.cpus.bind(os);
  os.cpus = () => { const all = real(); return all.length > n ? all.slice(0, n) : all; };
  return (threadCap = Math.floor(n));
}

// Native proving is switched off after `after` failures in a row and tried again once `coolMs` has passed: that one attempt closes the
// breaker if it works and opens it again if not.
export function makeBreaker({ after = 3, coolMs = 600_000, now = Date.now } = {}) {
  let fails = 0, openedAt = 0;
  return {
    get open() { return fails >= after && now() - openedAt < coolMs; },
    ok() { fails = 0; },
    fail() { fails++; if (fails >= after) openedAt = now(); },
  };
}

// The binary runs with nothing of this process's environment (the keeper keys are in it), and its exit is data, not a throw.
const runNative = (bin, args, { timeout, cwd }) => new Promise((resolve) => {
  execFile(bin, args, { timeout, cwd, killSignal: 'SIGKILL', maxBuffer: 1 << 16, windowsHide: true, env: { PATH: '/usr/bin:/bin' } },
    (error, stdout, stderr) => resolve({ error, out: `${stdout}${stderr}` }));
});
const said = (out) => String(out).replace(/\s+/g, ' ').trim().slice(0, 160);
const why = (e, out = '') => {
  if (!e) return said(out) || 'no output';
  if (e.killed) return 'timed out';
  const how = e.signal ? `signal ${e.signal}` : Number.isInteger(e.code) ? `exit ${e.code}` : said(e.message ?? e);
  return Number.isInteger(e.code) || e.signal ? [how, said(out)].filter(Boolean).join(': ') : how;
};

// → { prove(input) → { pA, pB, pC, publicInputs, via }, vkHash }. wasm / zkey / vk are paths or pinned https URLs.
//
// nativeProver is rapidsnark's `prover <zkey> <witness> <proof.json> <public.json>`: the witness comes from the circuit's wasm as with
// snarkjs, the proof from the binary, in a directory of its own that is removed after. Each of its proofs is checked against the
// verification key, and one that is not given (no binary, a crash, a timeout, a proof that does not verify) is made by snarkjs instead;
// repeated failures switch it off for a while. (rapidsnark sizes its thread pool by the host's CPUs; no setting changes that.)
export async function makeKeeperProver({
  wasm, zkey, vk, vkHash = '', wasmSha256 = '', zkeySha256 = '', artifactDir = '', singleThread = false, proverThreads = 2,
  nativeProver = '', nativeTimeoutMs = 60_000, nativeBreakAfter = 3, nativeBreakSecs = 600,
  nativeTmp = os.tmpdir(), now = Date.now, snarkjs: snarkjsImpl, log = (...a) => console.log('[evm-pool-keeper prover]', ...a),
}) {
  capProverThreads(proverThreads);
  const opts = (name, sha256) => ({ name, sha256, dir: artifactDir });
  const remoteVk = /^https:\/\//.test(vk);
  if (remoteVk && !vkHash) throw new Error('the verification key is fetched from a URL, so EVM_POOL_VK_HASH must pin it');
  let vkBytes;
  if (remoteVk) {
    const r = await fetch(vk);
    if (!r.ok) throw new Error(`vk: ${vk} returned ${r.status}`);
    vkBytes = Buffer.from(await r.arrayBuffer());
  } else vkBytes = readFileSync(vk);
  const vkJson = JSON.parse(vkBytes.toString('utf8'));
  const hash = hashVk(vkJson);
  if (vkHash && hash !== vkHash.replace(/^0x/, '').toLowerCase()) throw new Error(`verification key ${hash} is not the pinned ${vkHash}`);
  const snarkjs = snarkjsImpl ?? await loadSnarkjs();
  const wasmBytes = await loadArtifact(wasm, opts('wasm', wasmSha256));
  const zkeyBytes = await loadArtifact(zkey, opts('zkey', zkeySha256));
  const zkeyFile = artifactFile(zkey, opts('zkey', zkeySha256));

  let nativeBin = '';
  const breaker = makeBreaker({ after: nativeBreakAfter, coolMs: nativeBreakSecs * 1000, now });
  if (nativeProver) {
    const bin = nativeProver.includes('/') ? resolve(nativeProver) : nativeProver;
    // run with no arguments, it prints its usage: that shows it starts (is there, executable, finds its libraries)
    const { error, out } = await runNative(bin, [], { timeout: 10_000, cwd: os.tmpdir() });
    if (!/Usage:\s*prover/.test(out)) log(`EVM_POOL_KEEPER_NATIVE_PROVER=${nativeProver} does not start (${why(error, out)}); proofs come from snarkjs`);
    else if (typeof snarkjs.wtns?.calculate !== 'function') log('native prover not used: this snarkjs cannot write a witness; proofs come from snarkjs');
    else {
      nativeBin = bin;
      log(`native prover ${nativeProver} starts; its proofs are checked against the verification key, with snarkjs behind it`);
    }
  }

  // → the proof, or null for snarkjs to make it. A bad input fails at the witness, which is not the binary's doing: snarkjs is asked
  // (and fails the same way), and the breaker is left alone; a failure to make the working directory, the binary or its output counts.
  async function proveNative(input) {
    let dir, stage = 'setup';
    try {
      dir = await mkdtemp(join(nativeTmp, 'keeper-prove-'));
      const wtns = join(dir, 'w.wtns'), proofFile = join(dir, 'proof.json'), publicFile = join(dir, 'public.json');
      stage = 'witness';
      // into memory (as fullProve does), then to the file: a circuit that refuses the input then leaves no file open behind it
      const mem = { type: 'mem' };
      await snarkjs.wtns.calculate(input, wasmBytes, mem);
      await writeFile(wtns, mem.data);
      stage = 'prove';
      const { error, out } = await runNative(nativeBin, [zkeyFile, wtns, proofFile, publicFile], { timeout: nativeTimeoutMs, cwd: dir });
      if (error) throw Object.assign(error, { out });
      const proof = JSON.parse(await readFile(proofFile, 'utf8'));
      const publicSignals = JSON.parse(await readFile(publicFile, 'utf8'));
      stage = 'check';
      if (!Array.isArray(publicSignals) || publicSignals.length !== N_PUBLIC) throw new Error(`${publicSignals?.length} public signals, not ${N_PUBLIC}`);
      if (!(await verifyTransact(vkJson, publicSignals, proof, { snarkjs }))) throw new Error('the proof does not verify');
      breaker.ok();
      return { ...toSolidityProof(proof, publicSignals), via: 'native' };
    } catch (e) {
      if (stage !== 'witness') breaker.fail();
      log(`native prover (${stage}): ${why(e, e?.out)}; this proof comes from snarkjs${breaker.open ? `, and native proving is off for ${nativeBreakSecs} s` : ''}`);
      return null;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    vkHash: hash,
    // A proof in the verifier's calldata shape (a user's relayed transaction) against the ceremony key.
    verify: ({ pA, pB, pC, publicInputs }) => verifyTransact(vkJson, publicInputs.map(String), fromSolidityProof({ pA, pB, pC }), { snarkjs }),
    async prove(input) {
      const fast = nativeBin && !breaker.open ? await proveNative(input) : null;
      if (fast) return fast;
      const { proof, publicSignals } = await proveTransact(input, { wasm: wasmBytes, zkey: zkeyBytes, snarkjs, singleThread });
      if (!(await verifyTransact(vkJson, publicSignals, proof, { snarkjs }))) throw new Error('fresh proof does not verify');
      return { ...toSolidityProof(proof, publicSignals), via: 'snarkjs' };
    },
  };
}
