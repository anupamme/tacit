// What the holder's Ethereum wallet signs to claim the Discord holder role. The page asks for it and the API recovers the signer from it, so
// both build it here. It names the link's nonce, so a signature is good for that one link and no other.
// The least TAC that earns the holder role, in base units (8 decimals). The page reads the ERC-20 (18 decimals) against the second figure, the API
// checks both ways of showing it, and a Bitcoin proof is made for exactly this threshold (tacit.js keeps the same figure for its modal).
export const DISCORD_MIN_TAC_BASE_UNITS = 100n * 10n ** 8n;
export const DISCORD_MIN_TAC_ERC20 = DISCORD_MIN_TAC_BASE_UNITS * 10n ** 10n;

export const discordGateMessage = (nonce) =>
  `Tacit Discord verification\nNonce: ${nonce}\nThis proves you hold TAC to get the holder role in the Discord server. No funds move.`;
