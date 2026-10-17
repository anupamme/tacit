#!/usr/bin/env bash
# Watches the GPU server's log (it writes into /workspace/worker.log) for the warning stage of its slow regime: a Groth16 step over 14 s where a
# healthy one takes 6-8 s (ICICLE chunks the G2 multiplication as free GPU memory shrinks; 100 s proofs follow within two or three). It then creates
# /workspace/worker.recycle, and the worker (src/main.rs RECYCLE_FLAG) restarts itself and the server at its next idle moment.
LOG=${WORKER_LOG:-/workspace/worker.log}
FLAG=${RECYCLE_FLAG:-/workspace/worker.recycle}
LIMIT_MS=${SLOW_STEP_MS:-14000}
tail -n0 -F "$LOG" 2>/dev/null | grep --line-buffered "prover done" | sed -u 's/\x1b\[[0-9;]*m//g' | while IFS= read -r line; do
  if [[ $line =~ took=([0-9]+) ]]; then
    ms=${BASH_REMATCH[1]}
    if [ "$ms" -gt "$LIMIT_MS" ]; then
      touch "$FLAG"
      echo "[watch-slow] Groth16 step took ${ms} ms: recycle asked" >> "$LOG"
    fi
  fi
done
