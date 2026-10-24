# Virtual farms and the liquidity campaign

A virtual farm pays TAC to the people who keep liquidity in a pool, without a staking contract: the shares stay in the holder's own
wallet, and what they held, and for how long, is read from the pool's own `Transfer` logs. The first one is the liquidity campaign
for the TACD and TACE pools. Any pool whose shares are an ERC-20 and that is against ETH or USDC can have one.

Code: [`points-lp.js`](../worker-relay/src/lib/points-lp.js) (the rules, pure), [`points-lp-service.js`](../worker-relay/src/lib/points-lp-service.js)
(the scan, the readings, the credits), [`points-lp-record.js`](../worker-relay/src/lib/points-lp-record.js) (the day's record and its check).

## How a day is paid

- **Duration.** An address is paid on the *lowest* number of shares it held at any moment of the UTC day. Shares that arrive at 00:01
  earn nothing that day; shares that leave at 23:59 lose the day; a flash of liquidity earns nothing. A day of unbroken holding is a full
  credit, and `streak` (on `/lp?address=`) counts the days in a row.
- **Value.** The lowest shares times the pool's value per share, which is the median of 24 hourly readings (at least 12 are needed).
  A pegged token (TACD, TACE) is marked at the lower of the pool's price and the peg; a pool listed with `/spot` is marked at its own price.
- **Share.** The day's `daily` amount is shared by weighted dollars held, no address paid more than `cap` TAC per weighted dollar. What the
  cap and rounding leave stays in the pocket.
- **Pocket.** Credits are ledger adjustments: they add to what an address is owed and touch no day of the regular points split. Each
  campaign has a pocket (the most it may ever credit) and an end, and every credit waits (never drops) while the pocket would be overdrawn or
  the distributor would cover fewer than two days of the regular pot. `/rewards` lists the pockets and `funding.headroomAfterPocketsWei`.

## Proving a day

When a day is paid the service keeps a record of what it rests on, with its sha256: the terms, each pool's replay point (a block and the
supply there), every hourly reading *at a block* (reserves, price, the ETH feed's round), the day's median, each holder's lowest shares, and
the credits. `GET /lp/day/<n>` (with `?farm=<name>` for a farm) returns it.

```
node tools/lp-verify.mjs <day> [--farm <name>] [--rpc <archive node>]
```

reads all of it again from the chain: the readings at their blocks, the pool's logs replayed and checked against the supply, every holder's
lowest balance, and the credits by the same rule, then compares each figure and the credits to the ledger (`/rewards`). A reading made before
readings were pinned is a note, not a failure. What the chain cannot say is the campaign's own terms (amounts, cap, weights, who is never
paid); those are the operator's published schedule, and the check lists the addresses left out.

## Starting a farm

A farm is a campaign of its own: its pools, schedule, pocket and end, its tables (`vf_<name>_*`) and its credit ids (`vf:<name>:…`), so what
it pays is shared only among the liquidity in its own pools and never thins another campaign. On the points service
(`tacit-points`), set `POINTS_LP_FARMS` to a JSON list and deploy:

```json
[{ "name": "taceth",
   "schedule": "20760:daily=60,create=0,cap=0.03",
   "pools": "0x<pool>=1/spot",
   "pocketWei": "3000000000000000000000",
   "endSec": 1797712559,
   "fromBlock": 24000000,
   "exclude": ["0x<a farm contract that holds shares for others>"] }]
```

`fromBlock` must be before the pool was created (the replay is checked against the supply and the pool is not counted if it is not).
`create` pays whoever opened the pool once; `minUsd`, `minSamples` and `reserveDays` are optional. A pool that already has a staking
farm needs that contract in `exclude`, or it is paid as one holder. A schedule entry replaces an earlier one from its day on, and `<day>:off`
ends it; never edit an entry for a day that has been paid. The first campaign is still `POINTS_LP_SCHEDULE`, `POINTS_LP_POOLS`,
`POINTS_LP_POCKET_WEI` and `POINTS_LP_END_SEC`.

Private (shielded) pools cannot be followed this way; their farm is the escrowed one in [`FARMS.md`](./FARMS.md).
