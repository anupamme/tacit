// dapp/tacit-session.js, tacit.js held under a page's key: loaded once and pinned to mainnet, its calls taken one at a time, the key put into its
// wallet only for a call made under that key and refused for another, the shared wallet keys put back after a call unless another tab changed
// them, and the key wiped by drop.
//   node tests/tacit-session.test.mjs
import assert from 'node:assert/strict';

// a browser's storage and window, enough for the module
const mem = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
globalThis.localStorage = mem(); globalThis.sessionStorage = mem();
const listeners = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = (t, f) => { (listeners.get(t) || listeners.set(t, new Set()).get(t)).add(f); };
globalThis.removeEventListener = (t, f) => listeners.get(t)?.delete(f);
const fire = (t, e) => [...(listeners.get(t) || [])].forEach((f) => f(e));

// the library it loads: a module that has the wallet and the cache hook, and says what the network was when it was loaded
const lib = `export const wallet = { priv: null, pub: null }; export const loadedOn = globalThis.localStorage.getItem('tacit-network-v1'); export const flushes = []; export const invalidateHoldingsCache = (o) => flushes.push(o); globalThis.__libLoads = (globalThis.__libLoads || 0) + 1;`;
const url = 'data:text/javascript,' + encodeURIComponent(lib);
const { makeTacitSession } = await import('../dapp/tacit-session.js');

const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const secp = { getPublicKey: (priv) => Uint8Array.from([2, ...priv.slice(0, 32)]) };       // a stand-in: the public key is the key behind a prefix
let open = { pubHex: null, priv: null };
const setKey = (privHex) => { open = privHex ? { priv: privHex, pubHex: hex(secp.getPublicKey(unhex(privHex))) } : null; return open; };
const TS = makeTacitSession({ url, key: () => open, secp, bytesToHex: hex, hexToBytes: unhex, onLoad: (m) => { TS.loaded = m; } });
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);

// loaded once, on mainnet, whatever the network was; put back when the page closes
localStorage.setItem('tacit-network-v1', 'signet');
const [m1, m2] = await Promise.all([TS.load(), TS.load()]);
assert.equal(m1, m2); assert.equal(globalThis.__libLoads, 1, 'loaded once, however many ask');
assert.equal(m1.loadedOn, 'mainnet', 'pinned to mainnet for the library'); assert.equal(globalThis.__TACIT_NO_INIT__, true); assert.equal(TS.T, m1); assert.equal(TS.loaded, m1);
assert.equal(sessionStorage.getItem('tacit-lite-prev-net-v1'), 'signet', 'what the network was is kept for the page closing');
fire('pagehide'); assert.equal(localStorage.getItem('tacit-network-v1'), 'signet', 'and put back when the page closes'); assert.equal(sessionStorage.getItem('tacit-lite-prev-net-v1'), null);

// the key is in the wallet for a call made under it, and for no other
const a = setKey(A);
let seen = null;
await TS.withKey(async (t) => { seen = [hex(t.wallet.priv), hex(t.wallet.pub)]; return 1; }, a.pubHex);
assert.deepEqual(seen, [A, a.pubHex], 'the key and its public key are put into the wallet for the call'); assert.deepEqual(m1.flushes.at(-1), { fromPoll: true }, 'the wallet\'s caches are dropped with a new key');
const before = m1.flushes.length;
await TS.withKey(async () => 1, a.pubHex); assert.equal(m1.flushes.length, before, 'the same key again: nothing to drop');
setKey(B);
await assert.rejects(TS.withKey(async () => 1, a.pubHex), /wallet changed/, 'a call for a key that is no longer the page\'s is refused'); 
let ran = false;
await assert.rejects(TS.withKey(async () => { ran = true; }, a.pubHex)); assert.equal(ran, false, 'and its function never runs');
setKey(null);
await assert.rejects(TS.withKey(async () => 1, a.pubHex), /wallet changed/, 'a locked page refuses too');

// the key is wiped by drop (once the calls in flight are done)
setKey(A);
await TS.withKey(async () => 1, open.pubHex);
const priv = m1.wallet.priv; assert.ok(priv && priv.some((x) => x));
TS.drop(); await TS.turn(async () => {});
assert.equal(m1.wallet.priv, null); assert.equal(m1.wallet.pub, null); assert.ok(priv.every((x) => x === 0), 'the key\'s bytes are zeroed, not just forgotten');

// calls are taken one at a time, in order
const order = [];
const slow = TS.turn(async () => { order.push('a:start'); await new Promise((r) => setTimeout(r, 30)); order.push('a:end'); });
const fast = TS.turn(async () => { order.push('b'); });
await Promise.all([slow, fast]); assert.deepEqual(order, ['a:start', 'a:end', 'b'], 'one at a time');
await assert.rejects(TS.turn(async () => { throw new Error('x'); }), /x/); await TS.turn(async () => order.push('after')); assert.equal(order.at(-1), 'after', 'a call that fails does not hold up the next');

// the wallet choice shared with tacit.finance's other tabs and pages is put back after a call, unless another tab changed it meanwhile
localStorage.setItem('tacit-active-mode-v1', 'local'); localStorage.removeItem('tacit-eth-identity');
await TS.turn(async () => { localStorage.setItem('tacit-active-mode-v1', 'btc'); localStorage.setItem('tacit-eth-identity', '{"x":1}'); });
assert.equal(localStorage.getItem('tacit-active-mode-v1'), 'local', 'a key the library rewrote is put back as it was');
assert.equal(localStorage.getItem('tacit-eth-identity'), null, 'and one it added is taken away');
await TS.turn(async () => { localStorage.setItem('tacit-active-mode-v1', 'passkey'); fire('storage', { storageArea: localStorage, key: 'tacit-active-mode-v1' }); });
assert.equal(localStorage.getItem('tacit-active-mode-v1'), 'passkey', 'one another tab changed meanwhile (a storage event) is left as that tab set it');
await TS.turn(async () => { localStorage.setItem('tacit-ext-mode-v1', 'z'); fire('storage', { storageArea: localStorage, key: null }); });
assert.equal(localStorage.getItem('tacit-ext-mode-v1'), 'z', 'a cleared storage is left as it is');
assert.equal((listeners.get('storage') || new Set()).size, 0, 'the listener for other tabs is removed after each call');
// tPriv takes the key out of the library's wallet as hex, wiping it
setKey(A); await TS.withKey(async () => 1, open.pubHex);
const wp = m1.wallet.priv; assert.equal(TS.tPriv(), A); assert.equal(m1.wallet.priv, null); assert.ok(wp.every((x) => x === 0));
// a library that fails to load can be asked for again
let tries = 0; const flaky = makeTacitSession({ url: 'data:text/javascript,' + encodeURIComponent('throw new Error("down")'), key: () => null, secp, bytesToHex: hex, hexToBytes: unhex });
await assert.rejects(flaky.load(), /down/); await assert.rejects(flaky.load(), /down/, 'asked again, not remembered as failed for good');
console.log('tacit-session: all checks passed');
