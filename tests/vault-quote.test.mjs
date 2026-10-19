#!/usr/bin/env node
// dapp/vault/quote.js: what the small Borrow boxes on the trade and rewards pages say an amount of TAC could borrow. The figures must be the vault page's
// own (math.js borrowLimit, rounded down to the token's places), the calls the vault page's (chain.js lists, by name), one Multicall3 read for both vaults, and
// no figure at all when a vault cannot lend (no price, no room, an auction on the account's vault).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };

// The modules import each other by their address on the site; here they are copies in a temporary folder, importing each other by path.
const dapp = new URL('../dapp/', import.meta.url), tmp = mkdtempSync(join(tmpdir(), 'vault-quote-'));
const at = (name) => pathToFileURL(join(tmp, name)).href;
const copy = (rel, name) => writeFileSync(join(tmp, name), readFileSync(new URL(rel, dapp), 'utf8')
  .replace(/'\/evm-trade-venues\.js\?cb=[^']*'/g, `'${new URL('evm-trade-venues.js', dapp).href}'`)
  .replace(/'\.\.\/rpc-body\.js'/g, `'${new URL('rpc-body.js', dapp).href}'`)
  .replace(/'\/vault\/(math|chain|deployments)\.js\?cb=[^']*'/g, (m, f) => `'${at(`${f}.mjs`)}'`));
for (const f of ['math', 'chain', 'deployments']) copy(`vault/${f}.js`, `${f}.mjs`);
copy('vault/quote.js', 'quote.mjs');
const Q = await import(at('quote.mjs')), M = await import(at('math.mjs')), C = await import(at('chain.mjs')), { DEPLOYMENTS } = await import(at('deployments.mjs'));

const E18 = 10n ** 18n, USD = DEPLOYMENTS.vaults.find((v) => v.key === 'usd').vault, ETH = DEPLOYMENTS.vaults.find((v) => v.key === 'eth').vault;
const ME = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const w = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const ws = (...v) => '0x' + v.map((x) => BigInt(x).toString(16).padStart(64, '0')).join('');
const units = (s) => M.parseUnits(s, 18);

// ── the calls ──
{
  const names = (a) => Q.callsFor(USD, a).map(([k]) => k);
  assert.deepEqual(names(null), ['mint', 'minDebt', 'totalDebt', 'debtCeiling', 'depthCeiling', 'feeBps', 'pB']);
  assert.deepEqual(names(ME), ['mint', 'minDebt', 'totalDebt', 'debtCeiling', 'depthCeiling', 'feeBps', 'pB', 'vault']);
  // Each is byte for byte the vault page's own call of that name.
  const page = [...C.staticCalls(USD), ...C.dynamicCalls({ addr: USD, tac: USD, synth: USD, oracle: USD, feed: USD }, ME)];
  for (const [k, to, data] of Q.callsFor(USD, ME)) { const p = page.find(([pk]) => pk === k); assert.equal(to, p[1], k); assert.equal(data, p[2], k); }
  assert.ok(Q.callsFor(USD, ME).every(([, to]) => to === USD), 'every call goes to the vault itself (nothing of the oracle, the feed or the tokens is read)');
  ok('the calls are the vault page’s own, 7 per vault (8 with an account), all to the vault');
}

// ── a fake chain: the vault's figures by call name, per vault ──
const BASE = { mint: 30000n, minDebt: 10n * E18, totalDebt: 0n, debtCeiling: 1000000n * E18, depthCeiling: 5000n * E18, feeBps: 50n, pB: 2n * E18 / 10n, vault: [0n, 0n, 0n] };
function chain(byVault) {
  const seen = [];
  const batch = async (calls) => {
    seen.push(calls.length);
    return calls.map(([k, to]) => {
      const f = byVault[to.toLowerCase()] || BASE, v = f[k];
      if (v == null) return null;                                                        // a view that refused (no price yet)
      return Array.isArray(v) ? ws(...v) : w(v);
    });
  };
  return { batch, seen };
}
const lc = (a) => a.toLowerCase();

// ── an amount of TAC alone ──
{
  const c = chain({ [lc(USD)]: BASE, [lc(ETH)]: { ...BASE, minDebt: 4n * E18 / 1000n, pB: 8n * E18 / 100000n, depthCeiling: 2n * E18 } });
  const q = await Q.quoteBorrow({ tac: 1000n * E18, batch: c.batch });
  assert.deepEqual(c.seen, [14], 'one read for both vaults');
  // 1,000 TAC at $0.20 is $200; at a 300% line that is $66.67 of debt; less the 0.5% fee that rides on top, 66.33 (rounded down).
  assert.equal(q.usd.state, 'open'); assert.equal(q.usd.text, '66.33'); assert.equal(q.usd.amount, units('66.33'));
  assert.equal(q.usd.href, '/vault/#v=usd&amt=66.33'); assert.equal(q.usd.sym, 'TACD'); assert.equal(q.usd.vault, false);
  const want = M.floorTo(M.borrowLimit({ collateral: 1000n * E18, debt: 0n, pB: BASE.pB, mint: 30000n, feeBps: 50n, room: 5000n * E18, minDebt: 10n * E18 }).amount, 2);
  assert.equal(q.usd.amount, want, 'the vault page’s arithmetic');
  // The vault page would accept exactly that amount as a borrow of the TAC deposited with it.
  assert.equal(M.checkBorrow({ amount: q.usd.amount, collateral: 1000n * E18, debt: 0n, pB: BASE.pB, mint: 30000n, feeBps: 50n, room: 5000n * E18, minDebt: 10n * E18 }).ok, true);
  // TAC Ether: 1,000 TAC × 0.00008 ETH = 0.08 ETH, /3 = 0.02667, less the fee = 0.026533…, to 4 places 0.0265.
  assert.equal(q.eth.state, 'open'); assert.equal(q.eth.text, '0.0265'); assert.equal(q.eth.href, '/vault/#v=eth&amt=0.0265'); assert.equal(q.eth.sym, 'TACE');
  ok(`1,000 TAC: ${q.usd.text} TACD (link ${q.usd.href}) or ${q.eth.text} TACE, one read`);
}

// ── the room the market has left binds ──
{
  const c = chain({ [lc(USD)]: { ...BASE, depthCeiling: 20n * E18, totalDebt: 5n * E18 } });
  const q = await Q.quoteBorrow({ tac: 1000n * E18, batch: c.batch });
  assert.equal(q.usd.state, 'open'); assert.equal(q.usd.amount, M.floorTo(M.amountForDebt(15n * E18, 50n), 2)); assert.equal(q.usd.text, '14.92');
  ok('room left (15 TACD) caps the figure: 14.92 after the fee');
}

// ── vaults that cannot lend give no figure ──
{
  const c = chain({ [lc(USD)]: { ...BASE, depthCeiling: 12n * E18, totalDebt: 7n * E18 }, [lc(ETH)]: { ...BASE, pB: null, depthCeiling: null } });
  const q = await Q.quoteBorrow({ tac: 1000n * E18, batch: c.batch });
  assert.equal(q.usd.state, 'closed'); assert.equal(q.usd.amount, null); assert.equal(q.usd.href, '/vault/');
  assert.equal(q.eth.state, 'unknown'); assert.equal(q.eth.amount, null); assert.equal(q.eth.href, '/vault/#v=eth');
  const off = await Q.quoteBorrow({ tac: 1000n * E18, batch: chain({ [lc(USD)]: { ...BASE, debtCeiling: 0n } }).batch });
  assert.equal(off.usd.state, 'closed', 'switched off by the owner');
  ok('room under the smallest debt or switched off: closed; no recorded price: unknown; neither has a figure');
}

// ── too little TAC ──
{
  const q = await Q.quoteBorrow({ tac: 10n * E18, batch: chain({}).batch });
  assert.equal(q.usd.state, 'small'); assert.equal(q.usd.amount, null); assert.equal(q.usd.min, 10n * E18);
  // Rounding down must not leave the debt under the smallest one: a limit of 9.9512… (debt 10.0009…) rounds to 9.95, whose debt (9.9997…) is under 10.
  const edge = await Q.quoteBorrow({ tac: units('10.001'), batch: chain({ [lc(USD)]: { ...BASE, mint: 10000n, pB: E18 } }).batch });
  assert.equal(edge.usd.state, 'small');
  ok('10 TAC is under the smallest loan, and a figure that would round under it is not given');
}

// ── an account's own vault ──
{
  const c = chain({ [lc(USD)]: { ...BASE, vault: [500n * E18, 20n * E18, 0n] } });
  const q = await Q.quoteBorrow({ tac: 500n * E18, account: ME, batch: c.batch });
  assert.deepEqual(c.seen, [16]);
  const want = M.floorTo(M.borrowLimit({ collateral: 1000n * E18, debt: 20n * E18, pB: BASE.pB, mint: 30000n, feeBps: 50n, room: 5000n * E18, minDebt: 10n * E18 }).amount, 2);
  assert.equal(q.usd.state, 'open'); assert.equal(q.usd.amount, want); assert.equal(q.usd.vault, true);
  const auct = await Q.quoteBorrow({ tac: 500n * E18, account: ME, batch: chain({ [lc(USD)]: { ...BASE, vault: [500n * E18, 20n * E18, 1700000000n] } }).batch });
  assert.equal(auct.usd.state, 'unknown', 'an auction on the vault: borrowing waits');
  ok(`with the account’s vault (500 TAC in, 20 TACD owed) and 500 TAC more: ${q.usd.text} TACD; in an auction: no figure`);
}

// ── a read that fails throws (the boxes then show their plain line) ──
await assert.rejects(Q.quoteBorrow({ tac: E18, batch: async () => { throw new Error('nodes down'); } }), /nodes down/);
ok('a failed read throws');

console.log(`vault-quote: ${n} passed`);
