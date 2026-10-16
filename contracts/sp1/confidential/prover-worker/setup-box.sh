#!/usr/bin/env bash
# Prepares a fresh Linux x86-64 box with an NVIDIA GPU (CUDA 12 driver) to build and run tacit-prover-worker, then builds it.
# Run as root in a checkout that has contracts/sp1/confidential/{prover-worker,elf/cxfer-guest}. Durable state (the Rust
# toolchain, the cargo cache and the SP1 artifacts the SDK fetches) goes under $TACIT_HOME (default /workspace), so a
# rented pod keeps it across restarts when that path is a persistent volume.
set -euo pipefail
TACIT_HOME="${TACIT_HOME:-/workspace}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends build-essential pkg-config libssl-dev clang libclang-dev curl git ca-certificates protobuf-compiler libprotobuf-dev >/dev/null
export CARGO_HOME="$TACIT_HOME/.cargo" RUSTUP_HOME="$TACIT_HOME/.rustup"
[ -x "$CARGO_HOME/bin/cargo" ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null
export PATH="$CARGO_HOME/bin:$PATH"
mkdir -p "$TACIT_HOME/.sp1" && ln -sfn "$TACIT_HOME/.sp1" "$HOME/.sp1"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
cd "$(dirname "$0")"
cargo build --release
echo "built: $(pwd)/target/release/tacit-prover-worker"
echo "run:   BOARD_URL=https://api.tacit.finance WORKER_TOKEN=… WORKER_NAME=… EXPECT_VKEY=<the pool's PROGRAM_VKEY> ./target/release/tacit-prover-worker"
