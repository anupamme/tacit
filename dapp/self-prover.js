
import { stdinFor, zstdFrame, LIMITS, SELF_PROVE_TYPES } from './sp1-stdin.js';
import { makeSuccinctNetwork } from './succinct-net.js';

export const PROVE_TOKEN = '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29';
export const VAPP = '0x5Ad5Bc4B18f7c173DcE17A57682Cb0Dc8788951F';
export const MIN_DEPOSIT_WEI = 10n ** 16n;
export const PROVE_PER_PROOF = 0.4;
const GAS_LIMIT = 100_000_000n;
const LP_TYPES = ['lp', 'lpremove', 'lpbond', 'wraplp'];

const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { const s = String(h).replace(/^0x/, ''); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16); return out; };
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');

export function makeSelfProver({ priv, address, secp, keccak256, fetchImpl, transport, proxyBase = 'https://api.tacit.finance', rpc, gasLimit = GAS_LIMIT, input = 'auto', whitelist } = {}) {
  if (typeof priv !== 'function') throw new Error('self-prover: priv must be a function returning the account key');
  const net = makeSuccinctNetwork({ fetchImpl, transport, proxyBase, secp, keccak256, ...(rpc ? { rpc } : {}) });
  const supports = (type) => SELF_PROVE_TYPES.includes(type);
  const limits = (type) => {
    const l = LIMITS[type];
    if (!l) throw new Error(`self-prover: ${type} cannot be proved from this page`);
    const cap = LP_TYPES.includes(type) ? BigInt(gasLimit) * 3n : BigInt(gasLimit);
    return { cycleLimit: l.cycleLimit, gasLimit: l.gasLimit < cap ? l.gasLimit : cap };
  };

  const needWei = (type) => net.needWei({ gasLimit: limits(type).gasLimit });

  let lane = Promise.resolve();
  const inLane = (fn) => { const p = lane.then(fn); lane = p.then(() => {}, () => {}); return p; };

  async function prove({ type, op, memos = [], onUpdate = () => {} }) {
    const { cycleLimit, gasLimit } = limits(type);
    const memoHashes = memos.map((m) => hex(keccak256(unhex(m))));
    return proveStdin({ stdin: stdinFor(type, { ...op, memoHashes }), cycleLimit, gasLimit, onUpdate });
  }

  async function proveStdin({ stdin, cycleLimit, gasLimit, timeoutSecs, onUpdate = () => {} }) {
    const tell = once(onUpdate);
    const r = await inLane(async () => {
      const [have, need] = await Promise.all([net.balance(address), net.needWei({ gasLimit })]);
      if (have < need) {
        const e = new Error(`your prover credit is ${fmt(have)} PROVE; this proof needs ${fmt(need)} PROVE on hand`);
        e.code = 'prover_credit'; e.have = have; e.need = need;
        throw e;
      }
      const pub = input === 'public' || (input === 'auto' && net.privateOff());
      tell({ status: 'proving', stage: 'uploading', ...(pub ? { public: true } : {}) });
      return net.requestProof({ priv: priv(), stdinZstd: zstdFrame(stdin), cycleLimit, gasLimit, input, timeoutSecs, ...(whitelist ? { whitelist } : {}),
        onPublic: () => tell({ status: 'proving', stage: 'uploading', public: true }) });
    });
    const pub = r.private === false;
    tell({ requestId: r.requestId, status: 'proving', stage: 'requested', ...(pub ? { public: true } : {}) });
    return { ...(await follow(r.requestId, tell, r.deadline, pub)), private: !pub };
  }

  const resume = (requestId, { onUpdate = () => {} } = {}) => follow(requestId, once(onUpdate), null, false);

  async function follow(requestId, tell, deadline, pub) {
    const timeoutMs = deadline ? Math.max(60e3, deadline * 1000 - Date.now() + 120e3) : 30 * 60e3;
    try {
      const out = await net.waitProof(requestId, { timeoutMs, onUpdate: (u) => tell({ requestId, status: u.status === 'failed' ? 'failed' : 'proving', stage: u.status, ...(pub ? { public: true } : {}) }) });
      return { requestId, publicValues: out.publicValues, proof: out.proof };
    } catch (e) {
      if (e && typeof e === 'object' && !e.requestId) e.requestId = requestId;
      throw e;
    }
  }

  return { address, supports, needWei, balance: () => net.balance(address), prove, proveStdin, resume, privateOff: () => net.privateOff() };
}

const fmt = (wei) => (Number(wei) / 1e18).toFixed(2);
const once = (fn) => { let said = null; return (u) => { const k = `${u.status}/${u.stage}/${!!u.public}`; if (k !== said) { said = k; fn(u); } }; };

export function approveData(amountWei) {
  return '0x095ea7b3' + addrWord(VAPP) + word(amountWei);
}
export function depositData(amountWei) {
  return '0xb6b55f25' + word(amountWei);
}
export function permitAndDepositData({ from, amountWei, deadline, v, r, s }) {
  return '0x58981c7e' + addrWord(from) + word(amountWei) + word(deadline) + word(v) + String(r).replace(/^0x/, '').padStart(64, '0') + String(s).replace(/^0x/, '').padStart(64, '0');
}
export function signPermit({ secp, keccak256, privHex, owner, amountWei, nonce, deadline, domainSeparator }) {
  const enc = new TextEncoder();
  const typeHash = keccak256(enc.encode('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));
  const structHash = keccak256(unhex(hex(typeHash) + addrWord(owner) + addrWord(VAPP) + word(amountWei) + word(nonce) + word(deadline)));
  const digest = keccak256(unhex('0x1901' + String(domainSeparator).replace(/^0x/, '') + hex(structHash).slice(2)));
  const sig = secp.sign(digest, unhex(privHex));
  return { v: 27 + Number(sig.recovery), r: '0x' + word(sig.r), s: '0x' + word(sig.s) };
}
export const NONCES_SELECTOR = '0x7ecebe00';
export const DOMAIN_SEPARATOR_SELECTOR = '0x3644e515';
export const BALANCE_OF_SELECTOR = '0x70a08231';
