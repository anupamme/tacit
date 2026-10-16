# Building sp1-gpu-server for smaller cards

The SDK runs `~/.sp1/bin/sp1-gpu-server` and checks only its `--version`, so a server built from the same sp1 tag with
`lowmem.patch` applied is used in place of the downloaded one. sp1-gpu is MIT/Apache-2.0 at v6.2.3.

On a Linux box with CUDA 12 (nvcc) and the Rust toolchain:

```sh
git clone --depth 1 --branch v6.2.3 https://github.com/succinctlabs/sp1 && cd sp1
patch -p1 < /path/to/lowmem.patch
CUDA_ARCHS="86" cargo install --locked --root "$HOME/.sp1" --path sp1-gpu/crates/server/   # 86 Ampere (3060/3090/A4000/A5000), 89 Ada (4070/4090), 120 Blackwell
```

Then, for a 12–16 GB card, run the worker (or any sp1 CUDA client) with:

```sh
SP1_GPU_MIN_GB=16 SP1_GPU_ELEMENT_THRESHOLD=134217728 ./tacit-prover-worker …
```

What to measure first (an A4000 16 GB or RTX 3060 12 GB pod): `BENCH=tests/fixtures/sp1-stdin BENCH_RUNS=3` over wrap,
transfer and an 18M-cycle op. The open question is whether the recursion and wrap stages fit beside the core buffers at
this VRAM; if the warm-up proof completes, every card from 12 GB up can join the board.
