// The router (contracts/src/TacVaultRouter.sol) for a wallet that cannot send a batch of calls itself: the price records the vault waits for, the TAC in (a permit signed for
// the router) and the borrow or withdraw (a signature the vault checks) go in one transaction, `multicall`, which acts only for the account that sends it. The page signs
// the borrow or withdraw as typed data for the vault, builds the calls here and tests them with a plain eth_call from the account.
const strip = (h) => String(h).replace(/^0x/, '');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addr = (a) => strip(a).toLowerCase().padStart(64, '0');
const pad32 = (h) => h.padEnd(Math.ceil(h.length / 64) * 64, '0');
const bytesArg = (hex) => { const h = strip(hex); return word(h.length / 2) + pad32(h); };

export const ROUTER_SEL = {
  records: '0x6f12165d',                    // records(address vault, address[] venues, bytes[] data)
  borrow: '0xa5054d25',                     // borrow(address vault, uint256 tacIn, uint256 amount, uint256 maxFeeBps, uint256 minCollateral, uint256 deadline, bytes sig)
  withdraw: '0x0bd0ca9a', deposit: '0x47e7ef24', repay: '0x22867d78', permitSynth: '0xf01b062b',                   // withdraw(address vault, uint256 amount, uint256 deadline, bytes sig)
  vaultA: '0x67c0037c', vaultB: '0x109b221c',
};
// `permitTac` and `multicall` have the vault's own selectors and encoding (chain.js encPermit and encMulticall).

export function encRouterRecords(vault, recs) {
  const venues = word(recs.length) + recs.map((r) => addr(r.to)).join('');
  let head = '', tail = '', off = recs.length * 32;
  for (const r of recs) { const b = bytesArg(r.data); head += word(off); tail += b; off += b.length / 2; }
  return ROUTER_SEL.records + addr(vault) + word(96) + word(96 + venues.length / 2) + venues + word(recs.length) + head + tail;
}
export const encRouterBorrow = (vault, { tacIn, amount, maxFeeBps, minCollateral, deadline }, sig) =>
  ROUTER_SEL.borrow + addr(vault) + word(tacIn) + word(amount) + word(maxFeeBps) + word(minCollateral) + word(deadline) + word(224) + bytesArg(sig);
export const encRouterWithdraw = (vault, { amount, deadline }, sig) => ROUTER_SEL.withdraw + addr(vault) + word(amount) + word(deadline) + word(128) + bytesArg(sig);

// The vault's typed data (TacVault.digest): domain { name "TacVault", chainId, verifyingContract }, and the structs it checks `borrowFor` and `withdrawFor` against. The
// recipient is always the signer: the router asks for nobody else.
const DOMAIN = [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
export const borrowTyped = (vault, owner, { amount, maxFeeBps, minCollateral, nonce, deadline }) => ({
  types: { EIP712Domain: DOMAIN, Borrow: [
    { name: 'owner', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'maxFeeBps', type: 'uint256' }, { name: 'minCollateral', type: 'uint256' },
    { name: 'to', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Borrow', domain: { name: 'TacVault', chainId: 1, verifyingContract: vault },
  message: { owner, amount: String(amount), maxFeeBps: String(maxFeeBps), minCollateral: String(minCollateral), to: owner, nonce: String(nonce), deadline: String(deadline) },
});
export const withdrawTyped = (vault, owner, { amount, nonce, deadline }) => ({
  types: { EIP712Domain: DOMAIN, Withdraw: [
    { name: 'owner', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Withdraw', domain: { name: 'TacVault', chainId: 1, verifyingContract: vault },
  message: { owner, amount: String(amount), to: owner, nonce: String(nonce), deadline: String(deadline) },
});

export const encRouterDeposit = (vault, tacIn) => ROUTER_SEL.deposit + addr(vault) + word(tacIn);
export const encRouterRepay = (vault, amount) => ROUTER_SEL.repay + addr(vault) + word(amount);
export const encRouterPermitSynth = (vault, { value, deadline, v, r, s }) => ROUTER_SEL.permitSynth + addr(vault) + word(value) + word(deadline) + word(v) + strip(r).padStart(64, '0') + strip(s).padStart(64, '0');
