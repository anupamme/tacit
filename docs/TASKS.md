# Tasks: TAC for doing a listed job

`tacit.finance/tasks` lists jobs anyone can do from their own wallet. Each step of a job (one transaction) is paid in TAC to the
account that sent it, from a budget of its own. The points service verifies and prices the steps; the page sends them.

## What a step pays

    reward = gas of the step × slow-mode gas price × TAC per ETH × (1 + tip)

kept between the step's share of the job's floor and its share of the job's cap (shares are by gas), rounded down to 0.01 TAC.

- **Gas** is measured per step (`worker-relay/scripts/tasks-jobs.mjs` runs each step on a mainnet fork), not guessed.
- **Gas price** comes from the block the step landed in: its base fee plus the tenth percentile of the tips its transactions paid
  (between 0.01 and 2 gwei). It needs nothing but the block, so it is the same whenever it is asked for.
- **TAC per ETH** is what 0.01 ETH buys on the venue that pays the most TAC for 1 ETH (Precision's band or the Tacit AMM), sampled
  every two minutes. A step is priced at the lower of the sample nearest its block (within two hours) and the median of the six
  hours before it, so a dump of TAC or a gap in the samples never raises a reward.
- **Tip, floor, cap** default to 100%, 150 TAC and 2,500 TAC per job (`POINTS_TASKS_TIP_BPS`, `_FLOOR_WEI`, `_CAP_WEI`).

## How a step is credited

1. The visitor sends the step. The page names the transaction to `POST /tasks/claim` (anyone may name any transaction).
2. After 12 confirmations the service reads it from the chain and decides which steps it completed:
   - a CreateX deployment: CreateX's own `ContractCreation` log for the planned address and the chain-bound salt (the address
     commits to the init code, constructor arguments and owner, so nothing else can be there);
   - a registration in the confidential pool: the pool's `AssetRegistered` event for the planned asset;
   - a pair: a top-level call to the pool with exactly the planned call data (`createPair` reverts when the pair exists, so a
     call that succeeded made it).
3. The reward is fixed then, for the account that **sent** the transaction (`tx.from`; nobody can name another account).
   It is recorded as a pending claim, once per step.
4. Each cycle a pending claim becomes a ledger adjustment (`task:<job>:<step>`), when
   - the tasks budget has room (`POINTS_TASKS_BUDGET_WEI` is a ceiling on everything ever credited),
   - it is before `POINTS_TASKS_END_SEC`, and
   - after the credit the distributor's funding still covers `POINTS_TASKS_RESERVE_DAYS` (default 2) whole days of the regular
     pot. Publishing a root is all or nothing, so a task credit must never be what holds the daily rewards back.

   A claim that waits is kept and credited later. The next root carries it; it is claimed from the distributor like any reward.

The daily split reads only that day's counted points, its budget and the rate ceiling, never the ledger, so task credits change
nobody's daily share.

## Turning it on

Set `POINTS_TASKS_BUDGET_WEI` (what was topped up for tasks, in wei) and `POINTS_TASKS_END_SEC` on `tacit-points`, then deploy it.
Both unset (or the budget 0) leaves `/tasks` answering `{ "enabled": false }` and the page closed. A job also needs an
`opensAt` in its job files: a step mined before it is never credited, and a job with none is closed.

After a top-up for tasks, raise the budget by the same amount. The root-setter's deadline is on chain (`ROOT_UPDATE_DEADLINE`);
the end must come before it.

## Adding or changing a job

`worker-relay/scripts/tasks-jobs.mjs` builds the three files from a deployment payload and its manifest:

    worker-relay/src/lib/points-tasks-jobs.json   what the service verifies and prices
    dapp/tasks/jobs.json                          the same steps plus the page's copy (edit the COPY object in the script)
    dapp/tasks/tac-vaults-payload.json            the transactions a visitor sends

    node worker-relay/scripts/tasks-jobs.mjs --payload payload.json --manifest tac-vaults.json --rpc <anvil fork> --opens <unix secs>

A change to the contracts changes the addresses: rebuild the files, run the tests and `npm run build`.

## Tests

    node worker-relay/tests/points-tasks.test.mjs                       rewards, matching, guards, store, the service
    anvil --fork-url <mainnet rpc> --port 8546 --chain-id 1
    FORK_RPC=http://127.0.0.1:8546 node worker-relay/tests/points-tasks-fork.test.mjs   all 21 steps, claimed and credited
    FORK_RPC=http://127.0.0.1:8546 node worker-relay/tests/tasks-page-e2e.mjs           the page in Chrome, wallet and all
