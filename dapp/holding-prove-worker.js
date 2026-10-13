// Module worker for holding claims (holding-claim.js): holds the circuit and key so proving never blocks the page.
//   { op: 'init', wasm, zkey, vk } → {}
//   { op: 'prove', input }         → { proof, publicSignals }   self-verified against vk
// Threaded proving holds a wasm heap per thread; if it fails (low memory), the proof is retried on one thread.

let art = null, snarkjs = null;

self.onmessage = async ({ data: m }) => {
  const reply = (x) => self.postMessage({ id: m.id, ok: true, ...x });
  try {
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
