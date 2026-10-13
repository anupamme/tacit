// The browser wallet for the TAC trade page: found through EIP-6963 (or window.ethereum), asked for an account on Ethereum mainnet,
// and used for the three things the ticket needs: sending a transaction, signing TAC's EIP-2612 permit, and waiting for a receipt.
// Nothing is kept: no key is ever seen here, and the page reads balances through its own RPCs.

export const MAINNET = '0x1';
export class UserStopped extends Error { constructor() { super('Cancelled in your wallet. Nothing was sent.'); this.userStopped = true; } }

export function makeWallet({ rpc, leave = null }) {
  const found = new Map();
  const W = { prov: null, name: '', account: null, chain: null, listeners: new Set() };
  const emit = () => { for (const f of W.listeners) f(); };
  addEventListener('eip6963:announceProvider', (e) => { if (e.detail?.provider?.request) found.set(e.detail.info?.uuid || String(found.size), e.detail); });
  dispatchEvent(new Event('eip6963:requestProvider'));
  const available = () => { const l = [...found.values()]; if (!l.length && globalThis.ethereum?.request) l.push({ info: { name: 'Browser wallet' }, provider: globalThis.ethereum }); return l; };
  // A wallet that says no is the person, not a fault.
  const wrap = async (p) => { try { return await p; } catch (e) { if (e?.code === 4001 || /user (rejected|denied)|rejected the request/i.test(e?.message || '')) throw new UserStopped(); throw e; } };
  const req = (method, params) => wrap(W.prov.request({ method, params }));

  // A wallet's listeners are taken off the provider it is leaving, so a wallet left behind cannot change the account of the one in use.
  let off = null;
  async function connect(w) {
    off?.(); off = null;
    W.prov = w.provider; W.name = w.info?.name || 'Wallet';
    const accounts = await req('eth_requestAccounts');
    W.account = accounts?.[0] ? String(accounts[0]) : null;
    W.chain = await req('eth_chainId');
    const prov = W.prov, onAccounts = (a) => { if (prov === W.prov) { W.account = a?.[0] ? String(a[0]) : null; emit(); } }, onChain = (c) => { if (prov === W.prov) { W.chain = c; emit(); } };
    prov.on?.('accountsChanged', onAccounts); prov.on?.('chainChanged', onChain);
    off = () => { prov.removeListener?.('accountsChanged', onAccounts); prov.removeListener?.('chainChanged', onChain); };
    emit();
  }
  // Forgets the wallet in this page. `leave(provider)` ends a session that lives elsewhere (a WalletConnect pairing).
  async function disconnect() {
    off?.(); off = null;
    const prov = W.prov;
    W.prov = null; W.name = ''; W.account = null; W.chain = null;
    try { await leave?.(prov); } catch { /* the session is gone either way */ }
    emit();
  }
  // What was reviewed was for one account: a wallet whose account has changed since is not asked to send or sign it.
  const same = (from) => { if (from && String(from).toLowerCase() !== String(W.account || '').toLowerCase()) throw new Error('The wallet\'s account changed. Nothing was sent; review it again.'); };
  async function ensureMainnet() {
    W.chain = await req('eth_chainId');
    if (W.chain === MAINNET) return;
    await req('wallet_switchEthereumChain', [{ chainId: MAINNET }]);
    W.chain = await req('eth_chainId');
    if (W.chain !== MAINNET) throw new Error('Switch your wallet to Ethereum mainnet.');
  }
  async function sendTx({ to, data, value = 0n, from = null }) {
    same(from);
    await ensureMainnet();
    same(from);
    return req('eth_sendTransaction', [{ from: from || W.account, to, data, ...(value ? { value: '0x' + BigInt(value).toString(16) } : {}) }]);
  }
  // TAC's permit to `spender`: the typed data the wallet shows, and the split signature.
  async function signPermit({ token, name, spender, value, deadline, nonce, owner = null }) {
    same(owner);
    await ensureMainnet();
    same(owner);
    const typed = {
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Permit', domain: { name, version: '1', chainId: 1, verifyingContract: token },
      message: { owner: owner || W.account, spender, value: String(value), nonce: String(nonce), deadline: String(deadline) },
    };
    const sig = await req('eth_signTypedData_v4', [owner || W.account, JSON.stringify(typed)]);
    const h = String(sig).replace(/^0x/, '');
    if (h.length !== 130) throw new Error('The wallet returned a signature of the wrong length.');
    let v = parseInt(h.slice(128, 130), 16); if (v < 27) v += 27;
    return { v, r: '0x' + h.slice(0, 64), s: '0x' + h.slice(64, 128) };
  }
  // Through the page's own RPCs, so a wallet that is slow to report a receipt does not stall the page.
  async function receipt(hash, { timeoutMs = 5 * 60e3, every = 3000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) return r;
      if (Date.now() - t0 > timeoutMs) throw new Error('Sent, but not confirmed yet. Check it on Etherscan before trying again.');
      await new Promise((res) => setTimeout(res, every));
    }
  }
  return { state: W, available, connect, disconnect, ensureMainnet, sendTx, signPermit, receipt, onChange: (f) => W.listeners.add(f) };
}
