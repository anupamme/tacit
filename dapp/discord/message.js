// What the holder's Ethereum wallet signs to claim the Discord holder role. The page asks for it and the API recovers the signer from it, so
// both build it here. It names the link's nonce, so a signature is good for that one link and no other.
export const discordGateMessage = (nonce) =>
  `Tacit Discord verification\nNonce: ${nonce}\nThis proves you hold TAC to get the holder role in the Discord server. No funds move.`;
