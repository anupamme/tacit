# Holding proof key: setup record

The proving key for `holding.circom` (the holding reward's claims, checked by the points service), made by the project
itself. What anyone can re-check with snarkjs 0.7.6 is the final key against the circuit and the public phase-1 file (`snarkjs zkey verify` lists both contributions, ours and the Bitcoin-block seal), the verification key exported from it, and the seal's block hash. The intermediate files (genesis and our contribution) are not published, only their hashes below; that our single contribution's randomness was discarded is a claim about a process, not something the files can show.

1. **Phase 1:** `powersOfTau28_hez_final_16.ptau` (Hermez public ceremony), blake2b pinned in `ceremony-env.sh`.
2. **Circuit:** `holding.circom` sha256 `79e6eea38345246f1593ea3e3f8a92d69f5da63129ee34828b94db7146774451`, circom 2.2.3.
3. **Genesis:** `snarkjs groth16 setup` → `ceremony/holding/holding_0000.zkey` sha256 `bde62774eb5fdcb073bdb7d30341144c0d8b2876a5926fa22dc1dee75b3de74c`.
4. **Contribution 1:** made in a single process from 64 bytes of operating-system randomness that was never printed,
   written or sent and ended with the process. `holding_0001.zkey` sha256 `33d49f16196fd6dd9249cca906389e20e12b40fd6707a2a0245acf7d3e804fd4`, contribution hash
   `639c3a1ff8f886a078c14fc6e0027c023c195bb0214f165a96da545c5f8f6db912c46ee5b2947268803a4e58cbc2b773466bd8c32bd420a5a339f120fec6fb61`.
5. **Seal:** the hash of Bitcoin block **971234**, announced here at height 971231 before it existed, applied as a snarkjs beacon
   (2^10 iterations) to make the final key.

## Result

- **Seal applied:** Bitcoin block 971234 hash `00000000000000000000beb633ae08def1f2a79d8966d310118fc50700946597`
  (mempool.space and blockstream.info agree; taken with two blocks on top), `snarkjs zkey beacon … 10`.
- **Verified:** `snarkjs zkey verify build/holding.r1cs ceremony/pot16.ptau holding_final.zkey` → ZKey Ok (contribution #1
  ours, contribution #2 the beacon).
- **Final files** in `dapp/evm-pool/` (listed with their sha256 in `holding-pin.json`): `holding_final.zkey`
  `dc4c836781cf698314f4f29a9577177e9e6af424519440e1f5b2e115fcd46195`, `holding_vk.json`
  `eb6ec425be8219e9d217bcd8d0caeb63f2d7b1ede7496460b694ad0b49fdc25f` (the value for the points service's
  `HOLDING_VKEY_SHA256`), `holding.wasm`.

To re-check: rebuild the circuit with circom 2.2.3, `snarkjs zkey verify` it against the Hermez file and `holding_final.zkey`, and
compare the beacon line with the block hash above.
