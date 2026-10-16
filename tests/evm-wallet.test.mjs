// dapp/evm-wallet.js with two wallets announced (EIP-6963): which wallet a connect or a sign-in goes to, what a failed one
// keeps, and whose account changes reach the page.
//   node tests/evm-wallet.test.mjs
import assert from 'node:assert';
import { secp, sha256, keccak_256, hmac, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { prfBytesToScalar } from '../dapp/prf-wallet.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m)); // as tacit.js sets it
globalThis.window = new EventTarget();
const heard = [];
window.addEventListener('tacit:evm-accounts', (e) => heard.push(e.detail));
const { makeEvmWallet } = await import('../dapp/evm-wallet.js');

let pass = 0;
const ok = (name, c) => { assert.ok(c, name); pass++; console.log('  ok  ' + name); };
const enc = (s) => new TextEncoder().encode(s);

// A browser wallet holding one key: it announces itself, answers the requests a sign-in makes (any of which it can be set
// to refuse, as a person refusing it would), and emits accountsChanged when told.
function wallet(name, privHex) {
  const priv = hexToBytes(privHex), addr = '0x' + bytesToHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(12));
  const on = {}, w = { refuse: new Set() };
  w.provider = {
    async request({ method, params }) {
      if (w.refuse.has(method)) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      if (method === 'eth_requestAccounts') return [addr];
      if (method === 'eth_getCode') return '0x';
      if (method === 'personal_sign') {
        const m = hexToBytes(params[0].slice(2)), s = secp.sign(keccak_256(new Uint8Array([...enc(`\x19Ethereum Signed Message:\n${m.length}`), ...m])), priv);
        return '0x' + bytesToHex(s.toCompactRawBytes()) + (27 + s.recovery).toString(16);
      }
      throw new Error('unexpected ' + method);
    },
    on(ev, f) { (on[ev] ||= []).push(f); },
  };
  w.emit = (accounts) => { for (const f of on.accountsChanged || []) f(accounts); };
  const detail = { info: { uuid: 'uuid-' + name, name, icon: '', rdns: 'test.' + name.toLowerCase() }, provider: w.provider };
  window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
  return w;
}
const A = wallet('A', '11'.repeat(32)), B = wallet('B', '22'.repeat(32));
const evm = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' });
let picks = 0, choice = 'A';
const pick = async (list) => { picks++; return list.find((w) => w.name === choice)?.uuid; };
// Which wallets' account changes reach the page.
const reach = () => { heard.length = 0; A.emit([]); B.emit([]); return heard.map((d) => (d.provider === A.provider ? 'A' : d.provider === B.provider ? 'B' : '?')).join(); };

A.refuse.add('eth_requestAccounts');
await assert.rejects(evm.connect({ pick }), /rejected/);
A.refuse.clear();
await evm.connect({ pick });
ok('a wallet that refused the connection is asked about again on the next connect', picks === 2);
await evm.connect({ pick });
ok('a wallet that connected is kept: the next connect goes straight to it', picks === 2);
ok('the account changes of the wallet in use reach the page', reach() === 'A');

// The key is locked (the choice forgotten) and opened with the other wallet.
evm.deselectProvider();
choice = 'B';
const idB = await evm.deriveIdentity({ pick });
ok('after a lock the next sign-in asks which wallet', picks === 3 && idB.provider === B.provider && idB.label === 'B');
ok('a wallet connected before and since left is not heard: only the one in use is', reach() === 'B');

// A sign-in with a wallet chosen for it fails at the signature.
evm.deselectProvider();
choice = 'A';
A.refuse.add('personal_sign');
await assert.rejects(evm.deriveIdentity({ pick }), /rejected/);
ok('a sign-in that failed leaves the wallet in use as it was', reach() === 'B');
A.refuse.clear();
const p0 = picks;
const idA = await evm.deriveIdentity({ pick });
ok('the sign-in after it asks which wallet again', picks === p0 + 1 && idA.provider === A.provider);
ok('and once it succeeds, its wallet is the one heard', reach() === 'A');

// A sign-in with the wallet chosen before fails at the signature: that choice stands.
A.refuse.add('personal_sign');
const p1 = picks;
await assert.rejects(evm.deriveIdentity({ pick }), /rejected/);
A.refuse.clear();
await evm.deriveIdentity({ pick });
ok('a wallet chosen before stays chosen after a failed sign-in with it', picks === p1);

// A sign-in for a known account that the wallet is not on is refused before it signs, and keeps nothing.
evm.deselectProvider();
choice = 'B';
await assert.rejects(evm.deriveIdentity({ pick, expect: idA.address }), /Switch your wallet/);
const p2 = picks;
choice = 'A';
await evm.deriveIdentity({ pick, expect: idA.address });
ok('a sign-in refused for the wrong account asks which wallet again', picks === p2 + 1 && reach() === 'A');

console.log(`\n${pass} passed, 0 failed`);
