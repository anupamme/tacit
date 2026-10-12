// The browser wallet for the TAC trade page: found through EIP-6963 (or window.ethereum), asked for an account on Ethereum mainnet,
// and used for the three things the ticket needs: sending a transaction, signing TAC's EIP-2612 permit, and waiting for a receipt.
// Nothing is kept: no key is ever seen here, and the page reads balances through its own RPCs.

export const MAINNET = '0x1';
export class UserStopped extends Error { constructor() { super('Cancelled in your wallet. Nothing was sent.'); this.userStopped = true; } }

export function makeWallet({ rpc }) {
  const found = new Map();
  const W = { prov: null, name: '', account: null, chain: null, listeners: new Set() };
  const emit = () => { for (const f of W.listeners) f(); };
  addEventListener('eip6963:announceProvider', (e) => { if (e.detail?.provider?.request) found.set(e.detail.info?.uuid || String(found.size), e.detail); });
  dispatchEvent(new Event('eip6963:requestProvider'));
  const available = () => { const l = [...found.values()]; if (!l.length && globalThis.ethereum?.request) l.push({ info: { name: 'Browser wallet' }, provider: globalThis.ethereum }); return l; };
  // A wallet that says no is the person, not a fault.
  const wrap = async (p) => { try { return await p; } catch (e) { if (e?.code === 4001 || /user (rejected|denied)|rejected the request/i.test(e?.message || '')) throw new UserStopped(); throw e; } };
  const req = (method, params) => wrap(W.prov.request({ method, params }));

  async function connect(w) {
    W.prov = w.provider; W.name = w.info?.name || 'Wallet';
    const accounts = await req('eth_requestAccounts');
    W.account = accounts?.[0] ? String(accounts[0]) : null;
    W.chain = await req('eth_chainId');
    W.prov.on?.('accountsChanged', (a) => { W.account = a?.[0] ? String(a[0]) : null; emit(); });
    W.prov.on?.('chainChanged', (c) => { W.chain = c; emit(); });
    emit();
  }
  async function ensureMainnet() {
    W.chain = await req('eth_chainId');
    if (W.chain === MAINNET) return;
    await req('wallet_switchEthereumChain', [{ chainId: MAINNET }]);
    W.chain = await req('eth_chainId');
    if (W.chain !== MAINNET) throw new Error('Switch your wallet to Ethereum mainnet.');
  }
  async function sendTx({ to, data, value = 0n }) {
    await ensureMainnet();
    return req('eth_sendTransaction', [{ from: W.account, to, data, ...(value ? { value: '0x' + BigInt(value).toString(16) } : {}) }]);
  }
  // TAC's permit to `spender`: the typed data the wallet shows, and the split signature.
  async function signPermit({ token, name, spender, value, deadline, nonce }) {
    await ensureMainnet();
    const typed = {
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Permit', domain: { name, version: '1', chainId: 1, verifyingContract: token },
      message: { owner: W.account, spender, value: String(value), nonce: String(nonce), deadline: String(deadline) },
    };
    const sig = await req('eth_signTypedData_v4', [W.account, JSON.stringify(typed)]);
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
  return { state: W, available, connect, ensureMainnet, sendTx, signPermit, receipt, onChange: (f) => W.listeners.add(f) };
}
