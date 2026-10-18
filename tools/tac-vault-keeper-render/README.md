# TAC vault keeper on Render

What it does: records the vaults' price oracle intervals (about 288 records a day, each ~0.93M gas, proven from an archive node) so that borrowing is
open and nobody has to catch up first; with VAULTS set it also watches the vaults (liquidations, auctions, alerts).

Service: a Render **background worker** (no HTTP port), Docker, `tools/tac-vault-keeper-render/Dockerfile`, Starter plan, auto-deploy off.

Environment (secrets marked):
- `KEEPER_PRIV` (secret): the keeper wallet's key. The wallet is a hot wallet holding only gas money (about 0.02 ETH a day at 0.06 gwei).
- `RPC`: an archive endpoint that serves `eth_getProof` and old headers (eth.drpc.org's free tier works but rate limits; a keyed archive endpoint is better).
- `SEND_RPC`: where transactions go (`https://ethereum-rpc.publicnode.com`).
- `ORACLE=0x0000002C48F347Fc4245226b71457E6bC85A5724,0x000000cD99De6AD4079F9e327c2A61eD58AB8551`
- `VAULTS=0x00000087ac9ed3E1Bd443E00FBe18B4EdcAEeb1F,0x00000047bFC8cF504967049D9Cf9E1FD9651ED80` and `FROM_BLOCK=26203600` (the vaults' deploy block area).
- Gas policy: `MAX_GWEI`, `URGENT_MAX_GWEI`, `RECORD_TIP_GWEI=0.001`, `URGENT_TIP_GWEI=0.001`, `URGENT_AFTER_BLOCKS`. The node refuses a send unless the wallet holds
  gasLimit x fee cap, so a small wallet needs a low cap.
- `ALERT_WEBHOOK` (optional): where ALERT lines are posted.

Funding: the keeper never checks its own balance; a dry wallet silently stops recording and borrowing pauses once an interval is late (anyone can still
record it for about 21 hours, from the dapp). Watch the balance.
