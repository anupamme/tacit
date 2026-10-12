# TAC

TAC is Tacit's native token. It was issued once on Bitcoin with a fixed supply of 21,000,000 and no mint
authority. On Ethereum it is an ERC-20 that only the confidential pool can mint, from TAC proven to have left
Bitcoin ([SPEC §7.3](../SPEC.md#73-tac), [deployment details](./DEPLOYMENTS.md#tac)). Verify the fixed supply
yourself, from Bitcoin and IPFS, at [tacit.finance/verify.html](https://tacit.finance/verify.html) — no
server or indexer trusted, the page recomputes it in your browser.

## Trading TAC

[tacit.finance/trade/tac](https://tacit.finance/trade/tac/) prices every place TAC trades and quotes the best way to trade an amount:

- **The Bitcoin order book**, in sats: listings (taken whole) and standing bids. A sale to a bid settles when its bidder is online;
  a sale can also be listed at your price.
- **The Precision pool** on Ethereum (TAC/ETH, 0.30% fee), the deepest. It records a price tape on chain (5-minute and 4-hour
  candles), read with `eth_call` and no indexer, which is the page's Ethereum chart. It is a chart, not an oracle: it shows executed
  prices with fees, and one small trade can move a candle's high or low.
- **The Tacit pool**, the AMM inside the confidential pool: one set of reserves, swapped publicly through
  [TacitPublicAmm](./DEPLOYMENTS.md) (amounts visible) or privately with shielded notes.
- **Uniswap v4 and other pools.** Three hookless ETH/TAC pools exist on Uniswap v4 (fees of 15%, 30% and 40%) and hold no liquidity
  today. zQuoter, which finds routes on Uniswap v2/v3, Sushi, Curve and v4's standard fee tiers, does not look at fees that high, so the
  page reads those pools itself.
- **zSwap's order boards** (Swapboard v1 and v2, Dutchboard, Floorboard). The page reads every TAC order on them and fills one, or the
  best several in a single `snwap` through zSwap's Swapbol executor. It uses them on its own when they take the whole amount and pay 1%
  more than the pools. Orders made out to one account are not offered. `dapp/zboards.js` has the reading and the calldata, and
  `tests/zboards-fork.mjs` places and fills orders on all four boards on a mainnet fork.

An order can be **split across the Precision pool and the Tacit pool in one transaction**, which pays more once it is large enough
to move either price. zRouter's own legs cannot do this with ETH (each forwards the whole transaction value, and the Precision route
requires its input to equal that value), so the split is a single `snwap` whose executor is Multicall3: its `aggregate3Value` gives
each pool its exact share, and one minimum bounds the total received. The page splits only when the extra output is worth the extra
gas, tests the transaction once without sending it, and falls back to one pool if that fails. `dapp/evm-trade-venues.js` has the
quoting and the calldata, and `tests/tac-split-fork.mjs` runs both directions on a mainnet fork.

## Holding TAC

- **Boosted points.** Hold 100 / 1,000 / 10,000 public TAC at the address that sends a points activity and
  its points are multiplied by 1.25× / 1.5× / 2×. The tier is the lowest balance the address held over the
  previous 24 hours (7,200 blocks), so buying just before an activity and selling after earns nothing. Only
  the public ERC-20 counts; TAC held privately or on Bitcoin does not. It applies to every points activity
  (ETH wraps, EVM pool deposits, zRouter and zSwap ETH swaps, zSwap bets and markets, .wei names, wstETH bond
  posts and cUSD mints, on Ethereum, Base and Robinhood Chain) from block 26061220 on.
- **Cheaper private exits.** The dapp lowers the relayed exit fee for TAC holders from 0.30% to 0.25% /
  0.20% / 0.15% at the same tiers, counting private TAC notes, the public TAC on the wallet's own Ethereum
  account and TAC in a connected Ethereum wallet. The relay's cost floor still applies, so small exits pay the floor either way.
- **Governance.** Holders vote on how the protocol's governed parts are run (see [Governance](#governance)).

## Where usage flows

- **Relay fees paid in TAC are never sold.** The relay moves any TAC it collects to the protocol reserve,
  the ops multisig, once it reaches 100 TAC.
- **A quarter of the relay's ETH surplus goes to buybacks.** Relay fees first pay for gas and proving. A
  quarter of any ETH left over is sent to TacBuyback.
- **Buybacks.** [TacBuyback](https://etherscan.io/address/0x6919cbEf0e70AFFA02Ae02c86c532A137154f250) holds
  ETH sent to it and buys TAC on the public TAC/ETH market, on the Tacit public pool or the TAC/ETH Precision
  pool, whichever quotes better. The TAC goes straight to the reserve; the contract never holds it.
  - Each buy is at most 0.25 ETH, at most one every 6 hours, and at most 1% of that pool's ETH liquidity, so
    buys stay small and grow with the market.
  - The contract is immutable and has no owner. Its ETH can only become TAC for the reserve or be returned
    to the reserve.
  - A keeper submits buys privately and holds off when a buy would be too small to be worth the gas.
- **The reserve is not sold.** Reserve TAC is used for liquidity, rewards and grants.

## Governance

Governance oversees everything the ops multisig controls: the treasury and reserve, CollateralEngine
(collateral ratios, price feeds, the cUSD stability fee), FarmManager (reward weights), the airdrop guardian
and pool succession. The **Protocol** view in the dapp's Govern tab shows each of these with live on-chain
values, who holds the role, and anything queued to change, with a button to propose a change to it.

- **Proposing** takes proof of at least 100 TAC. Proposals and final results are pinned to IPFS.
- **Voting.** Bitcoin TAC holders vote by proving a balance tier (1 / 10 / 100 / 1,000 / 10,000 / 100,000 TAC)
  without revealing the exact balance. Holders of the public ERC-20 vote by signing with their Ethereum
  wallet, and their exact balance counts.
- **Snapshots.** Weight is fixed when a proposal opens: TAC counts only if it was held then and not yet
  spent, so TAC moved afterwards cannot vote again.
- **Execution.** Results are advisory. The ops multisig carries out passed proposals, and each one's page links
  the multisig transaction that did it, checked on-chain, or shows it as still awaiting execution.

The same data is available at `GET https://api.tacit.finance/governance/oversight?network=mainnet`, and
proposals at `/governance/proposals`.

## Addresses (Ethereum)

| | Address |
| --- | --- |
| TAC ERC-20 | [`0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`](https://etherscan.io/address/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279) |
| TacBuyback | [`0x6919cbEf0e70AFFA02Ae02c86c532A137154f250`](https://etherscan.io/address/0x6919cbEf0e70AFFA02Ae02c86c532A137154f250) |
| TacBuyback keeper | [`0x1eeb713E6EAfbcFADb217664d53CF8DBDEc45fda`](https://etherscan.io/address/0x1eeb713E6EAfbcFADb217664d53CF8DBDEc45fda) |
| Reserve (ops multisig) | [`0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`](https://etherscan.io/address/0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2) |
| PointsDistributor | [`0x000000C918e44A3a443937fA7594eA4f7C95D6b9`](https://etherscan.io/address/0x000000C918e44A3a443937fA7594eA4f7C95D6b9) |

Source: [`TacBuyback.sol`](../contracts/src/TacBuyback.sol), the keeper
[`buyback-keeper.js`](../worker-relay/src/buyback-keeper.js), the points boost
[`tac-holder-boost.js`](../worker-relay/src/lib/tac-holder-boost.js).
