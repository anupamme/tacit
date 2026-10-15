# TAC vaults: public deployment

The TAC vaults are deployed by anyone, in a handful of transactions, to addresses fixed in advance. Nothing about the
sender matters: the addresses commit to the exact code, constructor arguments and owner, so the only thing a deployer
chooses is whether to pay the gas.

## How it is fixed

Each contract goes through CreateX (`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`) with `deployCreate2(salt, initCode)`.
The salt is tied to no sender, so any account can send it, but to this chain (it starts with 20 zero bytes and the
flag `0x01`, which CreateX hashes with the chain id). The address is

    CREATE2(CreateX, keccak256(abi.encode(chainId, salt)), keccak256(initCode))

Because the init code carries the constructor arguments, a different owner, parameter or contract gives a different
hash and so a different address. Different code cannot take a planned address, a planned address cannot be taken
by anything but its own code, and no one can take the same addresses on another chain. (CREATE3 would not give this: its address ignores the init code, so anyone could land
other code there first.) Each address begins with three zero bytes, found by `tools/vanity-create2`.

Later contracts take earlier addresses as arguments, so they are fixed in order: the two venue oracles, their pair, the
ETH feed, the two vaults (a vault's synth is its first contract, so its address follows), then a pool and router for TAC
and for each synth, then a zap per vault. `contracts/deployments/tac-vaults.json` lists every salt, init code hash,
constructor argument blob and address; `contracts/script/TacVaultsDeployment.sol` holds the same as constants.

The owner of both vaults, and the recipient of fees and absorbed TAC, is the ops multisig
`0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`. All other settings are in `contracts/deployments/tac-vaults.config.json`.

## Deploying

With Foundry, from `contracts/` (any funded account will do; the build must use the project's settings):

    forge script script/DeployTacVault.s.sol --rpc-url $RPC --broadcast --account <account>

The script rebuilds each init code from the compiled contracts and refuses to send one whose hash or address differs
from the plan. A contract that is already at its address is skipped, so a partial or repeated run is safe, and anyone
can finish what another started. Afterwards it registers both synths in the confidential pool and creates the five
pairs (each only if missing), and checks the result. Dry-run it first by leaving out `--broadcast`: 21 transactions,
about 44M gas.

Without Foundry, send the transactions in `payload.json` in order (`to`, `data`, `value` 0): 14 to CreateX, then 7 to the
confidential pool. A page can do the same: for each deployment, read the code at `expectedAddress` and send the
transaction only if there is none; check `tools/tac-vaults-check.mjs` passes for the payload it ships.

## Checking

- `node tools/tac-vaults-check.mjs payload.json contracts/deployments/tac-vaults.json` re-derives every hash and address
  from the payload with `cast` alone and checks the manifest agrees.
- `DeployTacVault.verifyAll()` (run by the script) checks the owners, wiring, depth share, the venue storage slots
  against the live pools, and the registry entries. It can be called on its own.
- `node tools/tac-vaults-etherscan.mjs` prints the `forge verify-contract` commands.

## After deployment

Lending opens once the oracle has recorded the whole 8-hour window: run `tools/tac-vault-keeper.mjs` with
`ORACLE=<Precision oracle>,<AMM oracle>` (see its header). Until then every priced function fails closed and repayment
and debt-free withdrawal work. The owner's tools are in `tools/tac-vault-admin.mjs`.

## Changing anything

A change to a contract or to the config changes init code hashes, so the plan is made again:

    node tools/tac-vaults-plan.mjs --out contracts/out --payload payload.json

It mines the addresses in order (about a minute) and rewrites the manifest and the constants. Run the fork tests
(`forge test --match-path test/TacDeployFork.t.sol`, with `FORK_URL`) and commit the manifest and constants together.

## What a stranger can and cannot do

- Send the deployment, or part of it, in any order the contracts' constructors allow: the result is the same.
- Land the right code early: harmless, that is the plan.
- Land different code or a different owner under any planned salt: it lands at another address.
- Deploy the plan on another chain at the same addresses: the salts are bound to chain 1, so they land elsewhere.
- Register a synth or create a pair in the confidential pool first: a plain token's asset id comes from the token alone and
  takes no cross-chain link, and a pair's id includes its fee, so the entry is the one the script needs, and the script
  reads the terms back.
- Pre-fund an address: no effect.
