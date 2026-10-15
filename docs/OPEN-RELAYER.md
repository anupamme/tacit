# Sending and proving confidential-pool ops yourself

`ConfidentialPool.settle(publicValues, proof, memos)` is open to any account. The pool checks the proof
against its pinned program key, applies every effect the proof commits to, and pays each fee leg the proof
binds to `msg.sender`. Who sends a settle changes nothing else. That leaves three roles anyone can take:

- **Send a proof that is waiting** (the open board) and earn its fee.
- **Prove an op with your own Succinct prover account**, then send it yourself or post it to the board.
- **Pay for the relay's proofs** with PROVE.

API base `https://api.tacit.finance`. Every route here is public and CORS-open.

## The open board

A proof lands on the board in one of two ways:

- **Proved by the relay but not sent yet.** The relay sends relayed (`mode: 'settle'`) jobs itself. While
  it can't pay for a settle, it keeps proving the ones any account could send and puts them on the board.
- **Posted by its holder** with `mode: 'preproven'`.

| route | |
|---|---|
| `GET /confidential/open?limit=` | `{ pool, jobs }`, oldest first (the list can be up to five seconds old). Each job has `{ jobId, type, status, posted, publicValues, proof, memos, openSince, expiresAt, feeUsd, feeAsset }`. `status` is `open`, or `sending` while a relay has taken the job to send; a send that never finishes goes back to `open` after five minutes. `expiresAt` is in ms (0 means none). |
| `POST /confidential/landed` | `{ jobId, txHash }`. Closes the job once the API sees that the transaction succeeded, reached the pool, carries the job's public values, and that the same settle would now be refused. |
| `POST /confidential/submit` | `{ type, mode: 'preproven', publicValues, proof, memos }` posts your own proof. Its settle is simulated first, and a proof the pool would refuse now is turned away. The same public values posted twice are one job. |
| `GET /confidential/status?id=` | One job's status. An open job carries the same proof and memos as on the board. |

**What goes on the board.** Only ops whose settle is a plain `pool.settle`:

- **Never listed:**
  - router-embedded proofs: `wraptransfer`, `wraplp`, `wrapswap`, `wrapcdpmint`;
  - proofs pinned to a root that moves with the reflection: `bridgemint`, `cbtcmint`, `fastlane`;
  - adaptor-swap legs (`adaptorlock`, `adaptorclaim`, `adaptorrefund`): when one lands is part of the swap;
  - exits that carry an L2 recipe for the relay to activate.
- **Leaving the board:** a relayed job stays until its own deadline. A posted proof also leaves after a day if
  nobody sent it. A landing closes every job on the board that carries the same proof.

**Reading a job's fee.** `publicValues` is `abi.encode(PublicValues)` of the struct in
[`ConfidentialPool.sol`](../contracts/src/ConfidentialPool.sol).

- Word 0 is the tuple offset.
- Head word 8 points to `fees`, a list of `{ bytes32 assetId, uint256 value }` in the pool's units. Multiply
  `value` by the asset's `unitScale` from [`confidential-deployments.js`](../dapp/confidential-deployments.js).
- Head word 16 is the settle `deadline` in unix seconds (0 means none).

[`worker/src/confidential-open.js`](../worker/src/confidential-open.js) reads these fields and builds the call.

**Running a relayer.** [`worker-relay/src/open-relayer.js`](../worker-relay/src/open-relayer.js) is a
complete one. It:

1. reads the board;
2. picks the oldest job whose tETH fee covers the settle's gas with a margin;
3. simulates the settle;
4. sends it through Flashbots Protect, so a reverting copy is never mined and the calldata stays private
   until it lands;
5. reports the landing.

```sh
cd worker-relay && npm ci
RELAYER_KEY=0x… RPC_URL=https://… node src/open-relayer.js     # MARGIN_BPS=2000 POLL_SECS=15 ONCE=1
```

Other senders take jobs too, Tacit's relay among them. Simulate before every send: if you lose the race,
the cost is that simulation, not a reverted transaction.

## Proving with your own prover account

Tacit's relay proves on the [Succinct prover network](https://docs.succinct.xyz/docs/sp1/prover-network/quickstart)
and pays for it from its own prover account. You can do the same from yours. Then nothing depends on the
relay's queue or credit, and your op's witness goes from your machine to the network only.

1. **Fund the account.** Deposit PROVE into the network's vApp
   (`SuccinctVApp.deposit`, `0x5Ad5Bc4B18f7c173DcE17A57682Cb0Dc8788951F`; PROVE is
   `0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29`).
   - The deposit credits the account that sends it. The account must be an EOA, because the network
     checks requests with `ecrecover`.
   - The network credits the deposit once indexed, which takes up to about five minutes. The minimum is
     0.01 PROVE.
   - A groth16 request needs about 1 PROVE on hand and spends about 0.4.
2. **Prove the op.** Use the same `{ type, op, memos }` a page sends to `/confidential/submit`. The op
   builders in `confidential-pool-ux.js` and the fixtures in `contracts/sp1/confidential/fixtures/` show
   each type's shape. The `exec-<op>` binary for the type proves it.
3. **Send it, or post it.**
   - Send `settle()` from any account; you are paid the fee legs you bound, so a fee you set comes back to you.
   - Or post the proof to the board, and whoever sends it is paid that fee.

[`worker-relay/src/self-prove.js`](../worker-relay/src/self-prove.js) does all three:

```sh
cd worker-relay && npm ci
export NETWORK_PRIVATE_KEY=0x… RPC_URL=https://…
node src/self-prove.js deposit 5                  # approve + deposit 5 PROVE for this key's account
node src/self-prove.js prove job.json --send      # prove with your credit, then settle from SETTLE_KEY (default: the same key)
node src/self-prove.js prove job.json --post      # prove, then put it on the open board
```

**The prover binaries.** These are the Linux x86-64 builds in the `prover-bins` release that
[`worker-relay/Dockerfile`](../worker-relay/Dockerfile) names. They embed the pool's pinned guest, and
`self-prove.js` checks each one against `worker-relay/prover/bin/SHA256SUMS` before running it.

- On another system, build the relay image and run the script inside it:
  `docker build -t tacit-relay worker-relay` then
  `docker run --rm -e NETWORK_PRIVATE_KEY -e RPC_URL -v "$PWD:/job" tacit-relay node src/self-prove.js prove /job/job.json --post`.
- To build them yourself, use
  [`contracts/sp1/confidential/build-all-network.sh`](../contracts/sp1/confidential/build-all-network.sh).

**Who sees the witness.** The network request carries it as a private input (`private_stdin`). Only the
network's executor and the prover that wins the request can read it; Tacit's relay never sees it.

## Paying for the relay's proofs

Every proof Tacit's relay makes is paid in PROVE from its prover account,
`0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7`.

- **How soon it is used.** PROVE sent there goes into the prover network within a few minutes once 2 PROVE
  or more has arrived. Smaller amounts go in at the relay's next half-hourly top-up.
- **What it buys.** About 0.4 PROVE pays for one proof.
- **Where to do it.** [tacit.finance/relay/#prove](https://tacit.finance/relay/#prove) sends PROVE, or pays
  ETH that zRouter swaps to PROVE for that account in one transaction.
