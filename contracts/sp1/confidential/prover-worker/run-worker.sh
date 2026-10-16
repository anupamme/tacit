#!/usr/bin/env bash
# Keeps tacit-prover-worker running: restarts it after a crash (with a pause), cleans the GPU prover's leftovers first
# (orphaned sp1-native-runn executors and /dev/shm files make every later proof hang), and re-reads worker.env on each
# start, so an edit takes effect on the next restart (touch $RELOAD_FLAG to ask for one between jobs).
#
# A rented pod's container disk is wiped on restart while /workspace (a volume) persists, so the pieces the SDK would
# otherwise fetch again are kept there and put back: the GPU server built with the Groth16 CUDA feature (the SDK would
# download the stock one, which proves Groth16 on the CPU) and the 8 GB Groth16 circuit artifacts.
set -u
ulimit -c 0   # the SDK's client aborts in a destructor on exit (harmless); no core files for it
cd /workspace/tacit/contracts/sp1/confidential/prover-worker
export HOME=/root
SERVER=/workspace/sp1-gpu-server-icicle-ts
restore() {
  mkdir -p /root/.sp1/bin /workspace/.sp1/circuits
  # The ICICLE libraries the server links (built once, kept on the volume) go back under /usr/local/lib after a restart.
  if [ -d /workspace/icicle-lib ] && [ ! -e /usr/local/lib/libicicle_device.so ]; then cp -a /workspace/icicle-lib/. /usr/local/lib/ && echo "[run-worker] ICICLE libraries restored"; fi
  if [ -x "$SERVER" ] && ! cmp -s "$SERVER" /root/.sp1/bin/sp1-gpu-server; then cp -a "$SERVER" /root/.sp1/bin/sp1-gpu-server.new && mv -f /root/.sp1/bin/sp1-gpu-server.new /root/.sp1/bin/sp1-gpu-server; fi
  if [ ! -d /root/.sp1/circuits ] && [ -n "$(ls -A /workspace/.sp1/circuits 2>/dev/null)" ]; then echo "[run-worker] restoring circuit artifacts from /workspace"; cp -a /workspace/.sp1/circuits /root/.sp1/; fi
}
# After a proof the SDK has the artifacts; keep a copy on the volume (once) for the next container.
keep() {
  if [ -d /root/.sp1/circuits/groth16 ] && [ ! -d /workspace/.sp1/circuits/groth16 ]; then (cp -a /root/.sp1/circuits /workspace/.sp1/ && echo "[run-worker] circuit artifacts kept on /workspace") & fi
}
while true; do
  set -a; . /workspace/worker.env; set +a
  # The pod sees the host's cores but may use a few (cgroup quota); threads past the quota only thrash.
  Q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null || echo -1); P=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null || echo 100000)
  if [ "$Q" -gt 0 ]; then N=$(( (Q + P - 1) / P )); export GOMAXPROCS=$N RAYON_NUM_THREADS=$N TOKIO_WORKER_THREADS=$N; fi
  # Those threads are also pinned to as many distinct physical cores (the first of each core's siblings): the Groth16 witness solver
  # is bound by memory latency, and two of its threads on one core's two hardware threads share its cache and halve it (measured:
  # 14.7 s to 7.9 s with 8 threads on 8 cores). A worker that cannot read the topology runs unpinned.
  PIN=""
  if [ "$Q" -gt 0 ] && command -v taskset >/dev/null && command -v lscpu >/dev/null; then
    CPUS=$(lscpu -p=CPU,CORE 2>/dev/null | grep -v '^#' | awk -F, -v n="$N" '!seen[$2]++ && c < n { printf "%s%s", (c ? "," : ""), $1; c++ }')
    [ -n "$CPUS" ] && PIN="taskset -c $CPUS" && echo "[run-worker] pinned to cpus $CPUS"
  fi
  for p in $(pgrep -x sp1-native-runn) $(pgrep -x sp1-gpu-server); do kill -9 $p 2>/dev/null; done
  rm -f /dev/shm/sp1* /dev/shm/sem.sp1* 2>/dev/null
  restore
  echo "[run-worker] $(date -u +%FT%TZ) starting"
  $PIN ./target/release/tacit-prover-worker &
  W=$!
  ( sleep 600; keep ) &
  wait $W
  echo "[run-worker] $(date -u +%FT%TZ) exited ($?); restarting in 20 s"
  sleep 20
done
