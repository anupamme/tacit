# tacit-prover

Proves Tacit V1 settle ops on your own machine. The dapp finds it on `127.0.0.1:47815` and sends it the op's program input.
The machine makes the Groth16 proof the pool verifies, and you send the settle from your own wallet. No relay, no prover
network and no credit are involved, and the op's details never leave the machine.

It takes the ops whose proofs pin nothing that moves while it works: wraps (`wrap`, `wraptransfer`), private sends
(`transfer`, `stealthlock`), withdrawals (`unwrap`, `sendunwrap`) and stealth claims and refunds (`stealthclaim`,
`stealthrefund`). A proof that takes minutes is then as good as one that takes seconds. Swaps, pool joins and borrows pin the
pool's price, so the page leaves those to Tacit's relay. The list is `DEVICE_TYPES` in `dapp/device-prover.js`.

## Build

You need Rust (stable), Go 1.24 or newer (for the Groth16 step) and a C compiler. On macOS, Xcode's command line tools
supply the C compiler and the Metal framework. On Linux, `build-essential` does.

```sh
cd contracts/sp1/confidential/device-prover
cargo build --release
```

The build fails if `../elf/cxfer-guest` is not the pinned guest (`build.rs`). At startup the prover refuses to run if the
guest's verifying key is not the pool's `PROGRAM_VKEY` (`0x006cd47f…d6e3`).

## Run

```sh
./target/release/tacit-prover            # serve on 127.0.0.1:47815
./target/release/tacit-prover check      # GPU leaf hashing against the CPU hasher, then exit
./target/release/tacit-prover prove f    # one proof of the bincode SP1Stdin in f, to f.proof.json
```

Then, on tacit.finance, open **Prove** and switch on **Prove on this computer**. On the tETH page it is the prover sheet's
**This computer** switch. Your browser asks once before the page reaches the local network.

The first proof downloads SP1's Groth16 circuit, v6.1.0: 6.2 GB, 8.4 GB unpacked, to `~/.sp1/circuits`. Its verifying key
hashes to the mainnet verifier's `VERIFIER_HASH`. The prover then writes a lean copy of the circuit once (~2 min). Every later
start loads in seconds.

| env | default | |
|---|---|---|
| `TACIT_PROVER_PORT` | `47815` | the page looks here |
| `TACIT_PROVER_ORIGINS` | tacit.finance, www.tacit.finance, and localhost:8080 / 127.0.0.1:8080 for a local dapp | pages allowed to ask for a proof |
| `TACIT_PROVER_DIR` | `~/.tacit-prover` | finished proofs, kept by input hash |
| `TACIT_METAL` | on, on macOS | `0` hashes Merkle leaves on the CPU |
| `SP1_WORKER_NUM_*_WORKERS` | 1 per stage under 16 GB of RAM | the SDK's own concurrency settings |

The server listens on 127.0.0.1 only and answers a browser only from an allowed origin. It makes one proof at a time, and
the rest wait in a queue. A job's id is the hash of its input, so a page reloaded mid-proof picks up the same job. Finished
proofs are kept on disk, without their inputs.

## How long a proof takes

These are real mainnet wraps, each accepted by the live verifier `0xb69f2584…f4e2` and settled on a fork.

| machine | time |
|---|---|
| MacBook Air M2, 8 GB, fanless, stock SP1 | 41 min, 27 GB peak footprint |
| the same Air, this prover | **23 min**, 17 GB peak; Groth16 alone 11 min → 4 min |
| an M-series with 16 GB or more | expected 5–10 min |
| a 12-core desktop or M4 Pro | expected 5–6 min |

Most of the time goes to SP1's BN254 wrap STARK. On macOS its Merkle leaf hashing runs on the GPU, checked against the CPU
on every commit (see below).

## What the patches change

`patches/` holds four crates that replace their crates.io versions through `[patch.crates-io]`. Each one changes how a value
is computed, never which value. Proofs are byte-for-byte what stock SP1 6.2.4 makes, and `tacit-prover check` compares the
GPU path against the CPU path.

| crate | upstream | change |
|---|---|---|
| `sp1-recursion-gnark-ffi` | 6.2.4 | Groth16 loads the proving key by `mmap` and a debug-stripped R1CS, and runs its MSMs one at a time: peak memory 19 → 8–10 GB, key loads 98 s → 2 s |
| `p3-bn254-fr` | 0.4.3-succinct | CIOS Montgomery multiplication without a final carry chain (BN254 has two spare bits), the Poseidon2 internal layer's diffusion as additions, and `#[inline]` across crates: the wrap STARK 2.5× faster |
| `p3-symmetric` | 0.4.3-succinct | packs 31-bit field elements into BN254 two at a time (62-bit words), the same integer as one at a time |
| `p3-merkle-tree` | 0.4.3-succinct | the first digest layer of a BN254 tree hashed by `crates/leafhash` on the GPU (Metal). Three rows of every commit are rehashed on the CPU, and any mismatch falls back to the CPU for the whole layer |

`crates/leafhash` is the Metal kernel: BN254 Poseidon2 on eight 32-bit limbs, with the KoalaBear packing done in the kernel.
The round constants (`src/rc.rs`) are the Horizen Labs set SP1 uses.

All four crates keep their upstream licences (MIT OR Apache-2.0).
