// Module worker for holding claims (holding-claim.js): holds the circuit and key and does the work that hashes a whole pool, so
// neither blocks the page.
//   { op: 'init', wasm, zkey, vk }  → {}
//   { op: 'build', args }           → { claims }   holdingClaims over a snapshot: the tree of every leaf and the spent set are hashed here
//   { op: 'prove', input }          → { proof, publicSignals }   self-verified against vk
// Threaded proving holds a wasm heap per thread; if it fails (low memory), the proof is retried on one thread.
import { makeEvmPoolZk } from '/evm-pool-zk.js?cb=2f062779';
import { holdingClaims } from '/holding-claim.js?cb=73df9b31';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from '/vendor/tacit-poseidon.min.js';
import { poseidon8 } from '/vendor/tacit-poseidon8.min.js';

const PO = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7, 8: poseidon8 };
const zk = makeEvmPoolZk({ poseidon: (xs) => PO[xs.length](xs) });
const plain = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

let art = null, snarkjs = null;

self.onmessage = async ({ data: m }) => {
  const reply = (x) => self.postMessage({ id: m.id, ok: true, ...x });
  try {
    if (m.op === 'build') {
      const claims = holdingClaims({ zk, ...m.args, asset: BigInt(m.args.asset) });
      reply({ claims: claims.map((c) => ({ index: c.index, bucketWei: String(c.bucketWei), retNf: String(c.retNf), input: plain(c.input) })) });
      return;
    }
    snarkjs ||= (await import('./vendor/tacit-mixer.min.js')).snarkjs;
    if (m.op === 'init') {
      art = { wasm: m.wasm, zkey: m.zkey, vk: m.vk };
      reply({});
    } else if (!art) {
      throw new Error('prover not initialised');
    } else if (m.op === 'prove') {
      let out;
      try { out = await snarkjs.groth16.fullProve(m.input, art.wasm, art.zkey); }
      catch { out = await snarkjs.groth16.fullProve(m.input, art.wasm, art.zkey, undefined, undefined, { singleThread: true }); }
      const { proof, publicSignals } = out;
      if (publicSignals.length !== 7 || !(await snarkjs.groth16.verify(art.vk, publicSignals, proof))) throw new Error('fresh proof does not verify');
      reply({ proof, publicSignals });
    } else {
      throw new Error(`unknown op ${m.op}`);
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String(e?.message || e) });
  }
};
