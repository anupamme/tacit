# Holding proof key: setup record

The proving key for `holding.circom` (the holding reward's claims, checked by the points service), made by the project
itself. Anyone can re-check every step with snarkjs 0.7.6.

1. **Phase 1:** `powersOfTau28_hez_final_16.ptau` (Hermez public ceremony), blake2b pinned in `ceremony-env.sh`.
2. **Circuit:** `holding.circom` sha256 `79e6eea38345246f1593ea3e3f8a92d69f5da63129ee34828b94db7146774451`, circom 2.2.3.
3. **Genesis:** `snarkjs groth16 setup` → `ceremony/holding/holding_0000.zkey` sha256 `bde62774eb5fdcb073bdb7d30341144c0d8b2876a5926fa22dc1dee75b3de74c`.
4. **Contribution 1:** made in a single process from 64 bytes of operating-system randomness that was never printed,
   written or sent and ended with the process. `holding_0001.zkey` sha256 `33d49f16196fd6dd9249cca906389e20e12b40fd6707a2a0245acf7d3e804fd4`, contribution hash
   `639c3a1ff8f886a078c14fc6e0027c023c195bb0214f165a96da545c5f8f6db912c46ee5b2947268803a4e58cbc2b773466bd8c32bd420a5a339f120fec6fb61`.
5. **Seal:** the hash of Bitcoin block **971234**, announced here at height 971231 before it existed, applied as a snarkjs beacon
   (2^10 iterations) to make the final key.
