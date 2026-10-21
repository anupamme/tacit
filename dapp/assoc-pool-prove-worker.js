// Module worker for the association-set pool's two circuits: holds their files, builds the trees a withdrawal folds
// through (about twenty thousand Poseidon hashes) and proves, so none of it blocks the page.
//   { op: 'init', circuit: 'withdraw' | 'commitment', wasm, zkey, vk } → {}
//   { op: 'withdraw', keys, acct, amount, recipient, feeRecipient, feeBps, stateLeaves, aspLeaves, scope?, entrypoint? }
//                                          → { plan, proof, publicSignals }     self-verified against the key
//   { op: 'exit', acct }                   → { expect, proof, publicSignals }
// Threaded proving is faster but holds a wasm heap per thread; if it fails (low memory) the proof is retried on one.

import { makeAssocPool } from './assoc-pool.js';
import { secp, keccak_256, sha256, hmac } from './vendor/tacit-deps.min.js';
import { poseidon1, poseidon2, poseidon3 } from './vendor/tacit-poseidon.min.js';

const pool = makeAssocPool({ secp, keccak256: keccak_256, sha256, hmac, poseidon1, poseidon2, poseidon3 });
const arts = {};
let snarkjsP = null;
const snark = () => (snarkjsP ||= import('./vendor/tacit-mixer.min.js').then((m) => m.snarkjs));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const strs = (v) => (Array.isArray(v) ? v.map(strs) : v.toString());

async function prove(circuit, input) {
  const a = arts[circuit];
  if (!a) throw new Error(`${circuit} circuit not initialised`);
  const s = await snark();
  const run = (opts) => s.groth16.fullProve(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, strs(v)])), a.wasm, a.zkey, undefined, undefined, opts);
  let out;
  try { out = await run(undefined); } catch { out = await run({ singleThread: true }); }
  if (!(await s.groth16.verify(a.vk, out.publicSignals, out.proof, quiet))) throw new Error('fresh proof does not verify');
  return out;
}

self.onmessage = async ({ data: m }) => {
  const reply = (x, transfer = []) => self.postMessage({ id: m.id, ok: true, ...x }, transfer);
  try {
    if (m.op === 'init') {
      arts[m.circuit] = { wasm: m.wasm, zkey: m.zkey, vk: m.vk };
      reply({});
    } else if (m.op === 'withdraw') {
      const stateLevels = pool.levelsOf(m.stateLeaves), aspLevels = pool.levelsOf(m.aspLeaves);
      const plan = pool.planWithdraw({ keys: m.keys, acct: m.acct, amount: m.amount, recipient: m.recipient, feeRecipient: m.feeRecipient, feeBps: m.feeBps, scope: m.scope, entrypoint: m.entrypoint, stateLevels, aspLevels });
      const { proof, publicSignals } = await prove('withdraw', plan.input);
      if (publicSignals.length !== plan.expect.length || publicSignals.some((x, i) => BigInt(x) !== plan.expect[i])) throw new Error('the circuit returned other signals than planned');
      const { input, ...rest } = plan;
      reply({ plan: rest, proof, publicSignals });
    } else if (m.op === 'exit') {
      const rq = pool.ragequitInput(m.acct);
      const { proof, publicSignals } = await prove('commitment', rq.input);
      if (publicSignals.some((x, i) => BigInt(x) !== rq.expect[i])) throw new Error('the circuit returned other signals than planned');
      reply({ expect: rq.expect, proof, publicSignals });
    } else {
      throw new Error(`unknown op ${m.op}`);
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String(e?.message || e) });
  }
};
