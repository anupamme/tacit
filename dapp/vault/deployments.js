// The vaults' addresses on Ethereum mainnet: { key: 'usd' | 'eth', vault: '0x…' } for the dollar vault and the ETH vault. Everything else
// (the two tokens, the terms, the prices) is read from the vault itself. Empty until they are deployed: the page then says it opens soon.
// `router`: the TacVaultRouter built for these two vaults, once deployed (empty until then: the page does without it).
export const DEPLOYMENTS = Object.freeze({
  chainId: 1,
  router: '0x000000F9ab49650502BeC910D13b4717F0082598',
  // The markets where a vault's token sells: a Precision pool for each (pools.js). `factory`: the Precision pool factory. `recipient`: the one address that may open a market (a market
  // with a front end is named so that nobody else can open it at a price of their own); the pool's address follows from the market, so changing a number here before it is opened
  // changes which pool the page means, and after it is opened a different one. `open`, `low` and `high`: the synth's price in the quote (tokens of the synth per unit of the quote),
  // where the market opens and the ends of the range it trades in; `fee`: in pips (500 = 0.05%).
  pools: Object.freeze({
    factory: '0x000000Eb27B557aB426d9E99cFd54EC455799e81',
    recipient: '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2',
    markets: Object.freeze([
      Object.freeze({ vault: 'usd', quote: Object.freeze({ sym: 'USDC', addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6 }), fee: 500, open: '1', low: '9/10', high: '10/9' }),
      Object.freeze({ vault: 'eth', quote: Object.freeze({ sym: 'ETH', addr: null, dec: 18 }), fee: 500, open: '1', low: '7/10', high: '10/7' }),
    ]),
  }),
  vaults: Object.freeze([
    Object.freeze({ key: 'usd', vault: '0x00000087ac9ed3E1Bd443E00FBe18B4EdcAEeb1F' }),
    Object.freeze({ key: 'eth', vault: '0x00000047bFC8cF504967049D9Cf9E1FD9651ED80' }),
  ]),
});
