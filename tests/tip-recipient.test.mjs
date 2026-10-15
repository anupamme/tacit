// The relay's quote names two tip addresses and keeps them apart: `recommendedTipRecipient` stays the ops multisig (a page that pinned it, an
// integrator's immutable one, adds no tip when the quote names another), and `tipSplitter` is the splitter Tacit's own pages pay, when the relay
// has one. Through the worker's own fetch, with the chain stubbed.
// Run: node tests/tip-recipient.test.mjs
import worker from '../worker/src/index.js';

let fails = 0;
const ok = (c, m, d = '') => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c || !d ? '' : ` — ${d}`)); if (!c) fails++; };
const kv = () => { const m = new Map(); return { m, async get(k, t) { if (!m.has(k)) return null; return t === 'json' ? JSON.parse(m.get(k)) : m.get(k); }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (opts && opts.method === 'POST' && /^https:\/\/(?!api\.tacit)/.test(String(url))) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x3b9aca00' }), { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, opts);
};
const MULTISIG = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2', SPLITTER = '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9';
const quote = async (env, q = 'asset=cETH') => { const r = await worker.fetch(new Request(`https://api.tacit.finance/confidential/quote?${q}`, { headers: { Origin: 'https://tacit.finance' } }), { REGISTRY_KV: kv(), ...env }, { waitUntil() {} }); return { status: r.status, body: await r.json() }; };

let r = await quote({});
ok(r.status === 200 && r.body.recommendedTipRecipient === MULTISIG && r.body.tipSplitter === null, 'with nothing set the quote names the ops multisig and no splitter');
r = await quote({ RELAY_TIP_SPLITTER_ADDR: SPLITTER });
ok(r.body.recommendedTipRecipient === MULTISIG && r.body.tipSplitter === SPLITTER, 'with a splitter set the multisig is still the recommended recipient, and the splitter is its own field');
r = await quote({ RELAY_TIP_SPLITTER_ADDR: SPLITTER }, 'asset=cETH&amountWei=100000000000000000');
ok(r.body.recommendedTipRecipient === MULTISIG && r.body.tipSplitter === SPLITTER && /^\d+$/.test(String(r.body.recommendedWrapTipWei || '0')), 'the same with an amount, alongside the tip');
r = await quote({ RELAY_TIP_SPLITTER_ADDR: 'not an address' });
ok(r.body.tipSplitter === null, 'a splitter setting that is not an address is not passed on');
r = await quote({ RELAY_TIP_RECIPIENT_ADDR: '0x' + '44'.repeat(20), RELAY_TIP_SPLITTER_ADDR: SPLITTER });
ok(r.body.recommendedTipRecipient === '0x' + '44'.repeat(20) && r.body.tipSplitter === SPLITTER, 'the recommended recipient can still be set on its own, apart from the splitter');
r = await quote({ RELAY_TIP_SPLITTER_ADDR: SPLITTER }, 'asset=cUSD');
ok(r.status === 200 && r.body.tipSplitter === SPLITTER && r.body.recommendedTipRecipient === MULTISIG, 'an asset with no relay fee policy carries both fields too');

globalThis.fetch = realFetch;
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
