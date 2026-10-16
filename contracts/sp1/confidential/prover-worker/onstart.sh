#!/usr/bin/env bash
# The pod's start command (RunPod "docker command"): the image's own start (sshd, from PUBLIC_KEY) in the background, then
# the worker loop once the volume is there, so a restarted pod proves again on its own.
/start.sh &
for i in $(seq 1 60); do [ -x /workspace/run-worker.sh ] && break; sleep 2; done
setsid nohup /workspace/run-worker.sh >> /workspace/worker.log 2>&1 < /dev/null &
wait
