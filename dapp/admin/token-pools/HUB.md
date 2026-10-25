# Catch-up hub: operator note

`TacitEvmPoolCheckpointsHub` at `0x00000000C824B4F120C03f4Bdd4Bf4656232E835` on Ethereum, Base and Robinhood Chain keeps catch-up points for every pool. It reads the ETH pool's points through from the old registry `0x00000000C3267616ED5E0DAA6F6490D109d6844D`.

## Deploy order
1. Re-check the kit: `(cd contracts && FOUNDRY_PROFILE=checkpoints forge build)`, then `node tools/checkpoint-hub-kit.mjs`. It reads each chain before it rewrites `hub.json`.
2. Deploy the hub from this page: on each "Catch-up hub" row, press Check, then Send. Any wallet can send it. The hub needs only the registry, which is live on all three chains, so it can go before or after any kit.
3. Deploy `tacit-evm-pool-keepers` by hand on Render (autoDeploy is off). Each keeper finds the hub on its own: it asks once every 30 minutes until the hub has code, then keeps it.
4. Open the token-pool kits in any order. Each new pool's keeper posts the pool's first point to the hub as soon as it runs.

## Env vars
- Nothing needs to be set. A keeper whose pool is not the registry's (TAC, TACD, TACE, USDC, USDT and every kit pool) posts to the hub once the hub has code on its chain. The ETH pool's keepers (`1`, `8453`, `4663`) keep posting to the old registry.
- To turn the hub off: `EVM_POOL_KEEPER_POINTS_HUB=0` everywhere, `EVM_POOL_KEEPER_POINTS_HUB_<chainId>=0` on one chain (e.g. `_8453`), or `EVM_POOL_KEEPER_POINTS_HUB_<CHAINID>_<NAME>=0` for one pool (e.g. `_1_TAC`). `EVM_POOL_KEEPER_POINTS=0` stops every post, to the registry and the hub.
- A pool posts only while its keeper runs. A kit pool on Base or Robinhood needs `EVM_POOL_TOKEN_POOLS_<chainId>=<block>` and `EVM_POOL_TOKEN_POOLS_ALLOW_<chainId>=<tokens>`, and Ethereum wstETH needs `EVM_POOL_TOKEN_POOLS_ALLOW_1`.
- A pool served on a day's gas allowance (named through `POST /token-pools`) posts no points.
- The throttles are the registry's:
  - one try per pool every 10 minutes;
  - a post every 2,000 leaves, or after 24 hours if at least 200 leaves were added;
  - the first point at once;
  - posts from one key on one chain at least 5 minutes apart;
  - nothing is sent unless the keeper holds 3× the post's cost;
  - a 2.5M gas cap (`EVM_POOL_KEEPER_POINTS_GAS`, `_EVERY`, `_MAX_AGE_SECS`).

## Are points flowing?
```
HUB=0x00000000C824B4F120C03f4Bdd4Bf4656232E835
cast call $HUB 'newest(address[])((uint256,uint256,bytes32[32])[])' "[$POOLS]" --rpc-url $RPC
```
- Each result starts with the pool's size and block. A size of 0 means the pool has no point yet.
- Check the size against `cast call <pool> 'nextIndex()(uint256)'`. A pool with traffic should be fewer than 2,000 leaves behind, or have a point less than a day old.
- The keeper logs say `posted catch-up point at N leaves (block B) to the hub: 0x…`, or why no point was posted.
- `$POOLS` on Ethereum: ETH `0x000000c2A20657CE25f2Ba99737933D031AFBEE9` (read through from the registry), TAC `0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe`, TACD `0x0000007bDb91d1aa0b5D3106Fd1c44C784b33DBA`, TACE `0x00000091974fB81e7eBA4cF2Cb24869c00a9A1a1`, USDC `0x6C0be904750Fe1b50cd7207cc94731642d99e908`, USDT `0x73872ceEaADd2C603BD057073D403f08DCB31EB9`, wstETH `0x0a83Fb67EE2708F10BCdd8FE23Fa3B30A0247Aac`.
- `$POOLS` on Base: ETH, USDC `0xCAf6BE2e337AEcAB4a4eA183452f78800fD1616D`, USDT `0xC720d51Fa8B768F6b0ba58Bf0812CA76355bcee4`, wstETH `0x95e51d1BF626390c2C99b748d7A2D31829D94746`.
- `$POOLS` on Robinhood Chain: ETH, USDG `0x4430C0eFdFef640d54abB5a7cDdC63819468d8CA`, USDe `0x1BC62D5fF0a76b8f944C70Bf324EAf9a028f062F`.

## Gas per post
- A hub post is about 1.75M gas for the whole transaction: 32 Poseidon hashes and 33 new storage slots. A keeper's post measured 1,753,199 gas on an Ethereum fork. The cap is 2.5M.
- That is about 0.0018 ETH at 1 gwei on Ethereum. Base and Robinhood add the L1 data fee on about 1.1 KB.
- The registry's post costs about the same: 1,726,147 gas on the same fork.
- Deploying the hub costs about 4.67M gas per chain; `hub.json` sends it with 5.94M.
