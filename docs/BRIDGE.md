# The Tacit bridge

TAC, tETH and cBTC move between Bitcoin and Ethereum by proof. Each chain's state is proven to the other
in zero knowledge, and a bridge waits for a proof, never for a signature. No multisig, federation or
attestor set signs a bridge message. Nothing on Bitcoin had to change for it: it runs on Bitcoin and
Ethereum mainnet today.

The app: [tacit.finance/bridge](https://tacit.finance/bridge/). The rules: [`SPEC.md` §6](../SPEC.md#6-reflection-and-the-bridge).

## Reflection

Each chain keeps a proven copy of the other's Tacit state. Bitcoin's blocks, once 24 deep, are folded
into proven roots; Ethereum's finalized blocks are verified by a light client; both go into one proof,
which the pool on Ethereum verifies. Nobody signs it, and anyone can make it.

## Burn, prove, mint

Every bridge is three moves:

| | Bitcoin → Ethereum | Ethereum → Bitcoin |
| --- | --- | --- |
| **Burn** | The note is burned on Bitcoin. | The note is burned in the pool, and the cross-out is recorded in its storage. |
| **Prove** | Once 24 blocks deep, the burn is folded into Bitcoin's proof, and the pool verifies it. | Once Ethereum finalizes it, the cross-out is proven inside Bitcoin's proof. |
| **Mint** | The pool mints a fresh note of the same value, privately, once per burn. | A Bitcoin transaction mints a fresh note of the same value, once, as a proven member of the cross-outs. |

The amount is not published on either chain. Whoever makes the mint's proof sees it, and today that is
Tacit's prover.

## One format, two chains

A Tacit note is a Pedersen commitment `C = v·H + r·G` on secp256k1, the curve both chains already use. On
Bitcoin it is an output of a Taproot envelope, with a kernel signature and range proof; in the pool on
Ethereum it is a leaf of the note tree. A bridge burns a note on one chain and mints a fresh one of the same
value on the other, keeping `v` and picking a new `r`, with a proof that nothing was added or lost.

## Bitcoin → Ethereum

1. **Headers, by work.** `BitcoinLightRelay`, a permissionless relay on Ethereum, checks every Bitcoin
   header's proof of work and follows the heaviest chain. Anyone can submit headers.
2. **Every envelope folded.** The Bitcoin reflection program
   ([`reflect.rs`](../contracts/sp1/confidential/src/reflect.rs)) re-hashes each block to its Merkle root,
   checks the witness commitment, and folds every Tacit envelope in it: transfers, trades, AMM and farm
   ops, bridge burns, cBTC locks.
3. **One proof.** SP1 proves the fold. The pool accepts it only if its tip is an ancestor of the relay's
   tip buried at least 24 blocks deep, and it continues the digest the pool already holds.
4. **Checked by the pool.** `attestBitcoinStateProven` verifies the proof on-chain against
   `BITCOIN_RELAY_VKEY`. A proven burn is then minted into the pool once, keyed by its `burn_id`.

## Ethereum → Bitcoin

1. **Finality, signed.** The Ethereum reflection program
   ([`eth-reflection`](../contracts/sp1/eth-reflection/src/main.rs)) is a light client built on sp1-helios.
   It checks the sync committee's signatures over finalized blocks, chained period to period from a pinned
   anchor, and binds to Ethereum mainnet's genesis validators root so no other chain's proof passes.
2. **The pool's storage.** Storage proofs against the finalized execution state root read the pool's
   cross-outs (`crossOutCommitment`), the Bitcoin notes it consumed, and its `EthCallOutbox` messages.
3. **Inside Bitcoin's proof.** The Bitcoin reflection program verifies the Ethereum proof recursively, so
   one proof, checked by the pool, carries both chains.
4. **Folded on Bitcoin.** A `T_CROSSOUT_MINT` re-mints a crossed-out note on Bitcoin only if its claim is
   proven a member of the cross-out set, and only once.

## Who checks what

| Hop | Checked by |
| --- | --- |
| Bitcoin's history | Proof of work, on Ethereum, by a permissionless relay. A reorg deeper than the confirmation depth halts reflection rather than rewriting it. |
| Ethereum's finality | The sync committee's signatures, inside the proof. |
| Every state change | An immutable pool contract, against pinned verifying keys ([`DEPLOYMENTS.md`](./DEPLOYMENTS.md#verification-anchors)). |
| Bitcoin's side | The rules in `SPEC.md`: every indexer that runs them over the same chain reaches the same state, and the reflection proves that state. |
| The programs | Each rebuilds byte for byte from source and is pinned by SHA-256 to its key ([`REPRODUCIBLE-BUILDS.md`](./REPRODUCIBLE-BUILDS.md)). |

Reflection advances when someone runs the provers. The reference relayer does, and anyone else can.

## Run it yourself

Tacit's services keep reflection current, and anyone can run it. Every step is an on-chain call that needs
no permission, and you pay only the network fee:

1. **Send the headers.** `BitcoinLightRelay.advanceTip(headers)` takes Bitcoin's block headers and checks
   each one's proof of work, so only real blocks are accepted.
2. **Make the proof.** Run the reflection prover
   ([`worker-relay/src/reflection-folder.js`](../worker-relay/src/reflection-folder.js)) with your own
   account on Succinct's prover network. Everyone runs the same program on the same public inputs.
3. **Submit it.** `attestBitcoinStateProven(publicValues, proof)` accepts any valid proof over the pool's
   current state, from any wallet.

[Community ops](https://tacit.finance/weld/keeper/) does the first and the last from your own wallet. To
check the deployment itself, run [`tools/verify-live.mjs`](./VERIFY-LIVE.md) and rebuild the programs from
source ([`REPRODUCIBLE-BUILDS.md`](./REPRODUCIBLE-BUILDS.md)).

## What you trust

Bitcoin's proof of work, Ethereum's validators (through its sync committee), and a proof system whose
pinned verifying keys anyone can rebuild from source. No signer set is in the path.

## How long it takes

Bitcoin → Ethereum waits for 24 Bitcoin confirmations (about four hours) and then the next proof, which
lands on Ethereum about every half hour. Ethereum → Bitcoin waits for Ethereum to finalize (about 13
minutes) and then the Bitcoin mint confirms. [tacit.finance/bridge](https://tacit.finance/bridge/) shows
the live cadence and follows every bridge a browser has under way.

## The assets

| Asset | To Ethereum | To Bitcoin |
| --- | --- | --- |
| TAC | Burn on Bitcoin, minted privately in the pool once proven | Cross-out from the pool, minted on Bitcoin once proven |
| tETH | Burn on Bitcoin, minted back in the pool once proven | Cross-out from the pool |
| cBTC | Lock BTC at your own key's output, with a wstETH bond behind it; the pool mints cBTC 1:1 once the lock is proven. Borrow cUSD against it. | Will be burned on Bitcoin to redeem a lock |

## On mainnet

The ERC-20 supply of TAC (~2.5M) was all minted by the pool from TAC proven to have left Bitcoin. TAC has
made the whole round trip, each leg a settled transaction:

1. Out of the pool: [`0xc7bfc7ce…3c29a8f`](https://etherscan.io/tx/0xc7bfc7cec938e59c5d256d1c44c2aea5269eb7c237ac018878f21b2a93c29a8f)
2. Minted on Bitcoin: [`aaa68792…97bcf2`](https://mempool.space/tx/aaa687924435ef64f056aa83beb7fabef4f57087f315655b52c596f83897bcf2)
3. Burned on Bitcoin: [`7320b6b6…36b0fbb`](https://mempool.space/tx/7320b6b654726ba99489bcf47f3d31dcf8a87040241def827b5fccd8836b0fbb)
4. Back in the pool, as a fresh note: [`0f0793f6…006465bb`](https://etherscan.io/tx/0x0f0793f61e57a0eb40ef551ef516e9a33ba0f270343abedf4ea014aa006465bb)

## Next: covenants

When Bitcoin can enforce where an output is spent (CTV, `OP_CAT`, `OP_CHECKSIGFROMSTACK` or an
equivalent), a cBTC lock becomes a vault that only a redemption opens, minted with no bond behind it.
The bytes are already reserved ([`SPEC.md` §10](../SPEC.md#10-extensions-and-covenant-placeholders)).
