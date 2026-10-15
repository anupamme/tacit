// Proving with the holder's own prover account.
//
// The Tacit account (the EOA the pool UX derives from the Tacit key, which already sends self-settled transactions) is also
// the holder's account on the Succinct prover network: its credit there pays for the proofs it asks for, and it signs each
// request itself. Nothing about the op goes to Tacit's relay. The program input is built here (sp1-stdin.js) and requested
// as a private input (succinct-net.js), so only the network's executor and the prover that wins the request read it. The
// network's artifact store takes no uploads from a browser, so the input and the finished proof pass through tacit-api's two
// byte-forwarding routes (/prover/upload, /prover/download), which keep nothing.
//
// `makeSelfProver(...).prove` is what relay.useProver takes. The funding helpers build the transactions that put PROVE into
// the account's network credit: from the account itself (approve, then deposit), or from any wallet with one signature by the
// account (SuccinctVApp.permitAndDeposit pulls PROVE the account holds and credits the account).

import { stdinFor, zstdFrame, LIMITS, SELF_PROVE_TYPES } from './sp1-stdin.js';
import { makeSuccinctNetwork } from './succinct-net.js';

export const PROVE_TOKEN = '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29';
export const VAPP = '0x5Ad5Bc4B18f7c173DcE17A57682Cb0Dc8788951F';
export const MIN_DEPOSIT_WEI = 10n ** 16n;                        // SuccinctVApp.minDepositAmount(): 0.01 PROVE
export const PROVE_PER_PROOF = 0.45;                              // about what one groth16 proof spends (base fee 0.39 + gas)

const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { const s = String(h).replace(/^0x/, ''); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16); return out; };
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');

// priv: () => the Tacit account's private key (0x-hex), read at each use so a locked page never holds it here.
// address: that account's address. secp, keccak256: as the pool UX gets them. proxyBase: tacit-api.
export function makeSelfProver({ priv, address, secp, keccak256, fetchImpl, proxyBase = 'https://api.tacit.finance', rpc } = {}) {
  if (typeof priv !== 'function') throw new Error('self-prover: priv must be a function returning the account key');
  const net = makeSuccinctNetwork({ fetchImpl, proxyBase, secp, keccak256, ...(rpc ? { rpc } : {}) });
  const supports = (type) => SELF_PROVE_TYPES.includes(type);
  const limits = (type) => {
    const l = LIMITS[type];
    if (!l) throw new Error(`self-prover: ${type} cannot be proved from this page`);
    return l;
  };

  // The credit a request for this op needs on hand (the network refuses one it could not pay for at its gas limit).
  const needWei = (type) => net.needWei({ gasLimit: limits(type).gasLimit });

  // relay.useProver's contract: { type, op, memos, onUpdate } → { requestId, publicValues, proof }. The guest commits to
  // keccak256 of each memo, in order, as the relay's own prover feeds it.
  async function prove({ type, op, memos = [], onUpdate = () => {} }) {
    const { cycleLimit, gasLimit } = limits(type);
    const memoHashes = memos.map((m) => hex(keccak256(unhex(m))));
    const stdin = stdinFor(type, { ...op, memoHashes });
    const [have, need] = await Promise.all([net.balance(address), net.needWei({ gasLimit })]);
    if (have < need) {
      const e = new Error(`your prover credit is ${fmt(have)} PROVE; this proof needs ${fmt(need)} PROVE on hand`);
      e.code = 'prover_credit'; e.have = have; e.need = need;
      throw e;
    }
    onUpdate({ status: 'proving', stage: 'uploading' });
    const { requestId } = await net.requestProof({ priv: priv(), stdinZstd: zstdFrame(stdin), cycleLimit, gasLimit });
    onUpdate({ requestId, status: 'proving', stage: 'requested' });
    const out = await net.waitProof(requestId, { onUpdate: (u) => onUpdate({ requestId, status: u.status === 'failed' ? 'failed' : 'proving', stage: u.status }) });
    return { requestId, publicValues: out.publicValues, proof: out.proof };
  }

  return { address, supports, needWei, balance: () => net.balance(address), prove };
}

const fmt = (wei) => (Number(wei) / 1e18).toFixed(2);

// ── funding the account's network credit ──
// From the account itself: approve the vApp for `amountWei` of PROVE, then deposit it (two transactions, its own gas).
export function approveData(amountWei) {
  return '0x095ea7b3' + addrWord(VAPP) + word(amountWei);              // approve(address,uint256)
}
export function depositData(amountWei) {
  return '0xb6b55f25' + word(amountWei);                               // deposit(uint256)
}
// From any wallet, one transaction: SuccinctVApp.permitAndDeposit(from, amount, deadline, v, r, s) pulls `amountWei` of the
// PROVE `from` holds (with its EIP-2612 permit, signed here by the account's key) and credits `from`.
export function permitAndDepositData({ from, amountWei, deadline, v, r, s }) {
  return '0x58981c7e' + addrWord(from) + word(amountWei) + word(deadline) + word(v) + String(r).replace(/^0x/, '').padStart(64, '0') + String(s).replace(/^0x/, '').padStart(64, '0');
}
// The account's EIP-2612 signature over Permit(owner, spender = vApp, value, nonce, deadline) for PROVE. `domainSeparator` is
// PROVE's own DOMAIN_SEPARATOR() and `nonce` its nonces(owner), both read from the chain by the caller.
export function signPermit({ secp, keccak256, privHex, owner, amountWei, nonce, deadline, domainSeparator }) {
  const enc = new TextEncoder();
  const typeHash = keccak256(enc.encode('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));
  const structHash = keccak256(unhex(hex(typeHash) + addrWord(owner) + addrWord(VAPP) + word(amountWei) + word(nonce) + word(deadline)));
  const digest = keccak256(unhex('0x1901' + String(domainSeparator).replace(/^0x/, '') + hex(structHash).slice(2)));
  const sig = secp.sign(digest, unhex(privHex));
  return { v: 27 + Number(sig.recovery), r: '0x' + word(sig.r), s: '0x' + word(sig.s) };
}
export const NONCES_SELECTOR = '0x7ecebe00';                         // nonces(address)
export const DOMAIN_SEPARATOR_SELECTOR = '0x3644e515';              // DOMAIN_SEPARATOR()
export const BALANCE_OF_SELECTOR = '0x70a08231';                     // balanceOf(address)
