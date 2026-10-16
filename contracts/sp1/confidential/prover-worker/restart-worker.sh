#!/usr/bin/env bash
# Restarts the worker loop (and the worker and GPU server under it), e.g. after a server or env change. Between jobs, a
# gentler way is `touch /workspace/worker.reload`: the worker exits on its own once idle and the loop starts a fresh one.
for p in $(pgrep -f /workspace/run-worker.sh) $(pgrep -f "release/tacit-prover-worker$") $(pgrep -x sp1-gpu-server) $(pgrep -x sp1-native-runn); do kill $p 2>/dev/null; done
sleep 3
rm -f /dev/shm/sp1* /dev/shm/sem.sp1*
setsid nohup /workspace/run-worker.sh >> /workspace/worker.log 2>&1 < /dev/null &
sleep 2; echo "restarted: loop $(pgrep -f /workspace/run-worker.sh | head -1)"
