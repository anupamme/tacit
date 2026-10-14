// The vaults' addresses on Ethereum mainnet: { key: 'usd' | 'eth', vault: '0x…' } for the dollar vault and the ETH vault. Everything else
// (the two tokens, the terms, the prices) is read from the vault itself. Empty until they are deployed: the page then says it opens soon.
export const DEPLOYMENTS = Object.freeze({ chainId: 1, vaults: Object.freeze([]) });
