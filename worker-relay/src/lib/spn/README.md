Copies of `dapp/sp1-stdin.js`, `dapp/succinct-net.js` and `dapp/self-prover.js`, byte for byte: the relay image is built
from `worker-relay/` alone (render.yaml `rootDir`), so it cannot import them from `dapp/`. `tests/spn-vendored.test.mjs`
fails when a copy drifts; refresh with `cp dapp/{sp1-stdin,succinct-net,self-prover}.js worker-relay/src/lib/spn/`.
