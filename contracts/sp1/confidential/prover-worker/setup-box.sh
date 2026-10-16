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
# A rented pod sees the host's cores but may use a few (its cgroup quota); threads past the quota only thrash. Export these
# (the SDK's sp1-gpu-server child inherits them) when running the worker:
Q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null || echo -1); P=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null || echo 100000)
[ "$Q" -gt 0 ] && echo "cores: quota $(( (Q + P - 1) / P )) of $(nproc) seen — run with GOMAXPROCS=$(( (Q + P - 1) / P )) RAYON_NUM_THREADS=$(( (Q + P - 1) / P ))"
echo "run:   BOARD_URL=https://api.tacit.finance WORKER_TOKEN=… WORKER_NAME=… EXPECT_VKEY=<the pool's PROGRAM_VKEY> ./target/release/tacit-prover-worker"
