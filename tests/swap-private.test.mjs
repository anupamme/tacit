// dapp/swap/private.js: the swap card's private swap. Paid from the wallet's ETH it makes the ETH private (the tETH page's deposit), finds the
// new note by its leaf and routes it; paid from the private balance it routes a note of exactly the amount, cutting one to size first (a route
// spends its note whole: the pool module refuses change, and the stand-in here does too). Its imports (the key
// sheet, the deposit, the relay's state, the activity journal) are stood in for here, and so is the pool module it is handed.
//   node --test tests/swap-private.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// The page imports by site path (/teth/wrap.js?cb=…): each of private.js's imports is answered by a stand-in that reads globalThis.M.
const STUBS = {
  '/trade/key.js': `export class Cancelled extends Error { constructor(m = 'Cancelled.') { super(m); this.unlockCancelled = true; } }
    export function makeKeySession() { const s = { open: false, get unlocked() { return s.open; }, get key() { return s.open ? { pubHex: '02aa' } : null; }, priv: () => new Uint8Array([1]), lock() { s.open = false; } }; globalThis.M.session = s; return s; }
    export async function signInSheet(s) { globalThis.M.sheets++; if (globalThis.M.cancel) throw new Cancelled(); s.open = true; }`,
  '/trade/poolux.js': 'export async function forgetUx() { globalThis.M.forgot++; }',
  '/teth/wrap.js': `export const wrapEth = (a) => globalThis.M.wrapEth(a);
    export const relayState = async () => globalThis.M.relay;
    export const relayStopped = (rs) => rs?.state === 'paused' || rs?.state === 'down';
    export const relayWords = (e) => 'relay: ' + (e?.message || e);`,
  '/teth/read.js': 'export const wrapQuote = async (wei) => { globalThis.M.quoted.push(wei); return { tip: 7n, to: "0xtip" }; };',
  '/activity.js': 'export function makeRunner() { return { wait: (label, ms) => ({ timeoutMs: ms, label, onJob() {} }) }; }',
};
const hooks = `const S = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  const path = spec.split('?')[0];
  if (path in S) return { url: 'data:text/javascript,' + encodeURIComponent(S[path]), shortCircuit: true };
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const ETH = '0xeth', TAC = '0xtac';
const note = (leaf, value, asset = ETH) => ({ leaf, value: BigInt(value), asset, root: '0xroot' });

function setup({ notes = [], deposit = null, quote = 900n, quotes = null, routeErr = [], cutErr = [], fee = 20n, cutFee = 5n, submitErr = [], activation = 'done', routeOut = null } = {}) {
  const M = globalThis.M = { sheets: 0, forgot: 0, quoted: [], relay: { state: 'ok' }, cancel: false, wraps: [], routes: [], cuts: [], reads: 0, unwraps: [], submits: [] };
  let byAsset = {};
  const put = (ns) => { byAsset = {}; for (const n of ns) { const g = (byAsset[n.asset] ||= { value: 0n, notes: [] }); g.value += n.value; g.notes.push(n); } };
  put(notes);
  M.wrapEth = async (a) => { M.wraps.push(a); a.say('sent', '0xdep'); if (deposit) setTimeout(() => put([...notes, deposit]), 0); return { hash: '0xdep', built: { leaf: deposit?.leaf, note: { asset: ETH } } }; };
  const qs = quotes ? [...quotes] : null;
  const ux = {
    balance: async () => { M.reads++; return { byAsset, diag: {} }; },
    quoteRoute: async ({ fee: f }) => ({ amountOut: qs ? qs.shift() : quote, f }),
    route: async (a) => {
      M.routes.push(a);
      if (BigInt(a.inNote.value) !== BigInt(a.amountIn)) throw new Error('route: partial-spend change is not yet implemented in buildRoute');
      const e = routeErr.shift(); if (e) throw new Error(e);
      // the route's output note: tETH, worth what the swap paid
      if (routeOut) { notes = [...notes.filter((n) => n.leaf !== a.inNote.leaf), note('0xrouted', routeOut, ETH)]; put(notes); }
      return { txHash: '0xswap' };
    },
    // the exit: a fee of the floor asked (or 1% if more), the rest paid to the recipient
    quoteUnwrapFee: (value, tk, { minFee }) => { const v = BigInt(value), pct = v / 100n, f = pct > minFee ? pct : minFee; return { fee: f, net: v - f }; },
    buildUnwrap: ({ note: n, recipient, feeOpts }) => { const v = BigInt(n.value), pct = v / 100n, f = pct > feeOpts.minFee ? pct : feeOpts.minFee; M.unwraps.push({ n, recipient, fee: f }); return { op: { asset: n.asset, recipient, fee: f.toString(), value: v.toString() } }; },
    cfg: { router: '0xrouter' },
    router: { escrowAddressForCalldata: (r) => 'esc:' + r.finalRecipient + ':' + r.calls[0].value + ':' + r.nonce, activateExitCalldata: () => '0xact', reclaimExitCalldata: () => '0xback' },
    ethCall: async (to, data) => '0x' + '00'.repeat(12) + 'e5c0' + '0'.repeat(36),
    relay: {
      submitOp: async (spec) => { M.submits.push(spec); const e = submitErr.shift(); if (e) throw new Error(e); return { jobId: 'job' + M.submits.length }; },
      waitForSettle: async () => ({ status: 'settled', txHash: '0xexit' }),
      status: async () => ({ activation, activateTx: activation === 'done' ? '0xactivated' : null, activateError: activation === 'failed' ? 'the fee is below the cost' : null }),
    },
    // a send to itself: the picked notes go, a note of the amount (and the change, less the fee) comes back
    transfer: async (a) => {
      M.cuts.push(a);
      const e = cutErr.shift(); if (e) throw new Error(e);
      const spent = new Set(a.notes.map((n) => n.leaf)), sum = a.notes.reduce((x, n) => x + BigInt(n.value), 0n), left = sum - BigInt(a.amount) - BigInt(a.fee);
      notes = [...notes.filter((n) => !spent.has(n.leaf)), note('0xcut', a.amount, a.notes[0].asset), ...(left > 0n ? [note('0xchange', left, a.notes[0].asset)] : [])];
      put(notes);
      return { txHash: '0xcuttx' };
    },
    identity: () => ({ pubHex: '02aa' }),
    quoteOpFee: async (tk, kind) => (kind === 'transfer' ? cutFee : fee),
    ladderFee: (v) => v,
  };
  return { M, ux };
}
const load = async (ux) => (await import('../dapp/swap/private.js')).makePrivate({ getUx: async () => ux, pick: () => null });
const plan = (o = {}) => ({ wallet: false, units: 1000n, wei: 1000n * 10n ** 10n, asset: ETH, ticker: 'cETH', fee: 10n, path: [{ assetNext: TAC, feeBps: 30 }], minOut: 800n, label: 'Swap', ...o });
const run = (pv, p, steps = []) => pv.swap(p, { wallet: {}, from: '0xme', say: (k) => steps.push(k) });

test('from the wallet: the ETH is made private, its note found by its leaf, then routed', async () => {
  const { M, ux } = setup({ deposit: note('0xnew', 1000), notes: [note('0xold', 1000)] });
  const pv = await load(ux), steps = [];
  const r = await run(pv, plan({ wallet: true }), steps);
  assert.strictEqual(M.sheets, 1, 'the key sheet opened once');
  assert.deepStrictEqual(M.quoted, [1000n * 10n ** 10n], 'the relay tip is read for the deposit');
  assert.strictEqual(M.wraps[0].wei, 1000n * 10n ** 10n); assert.strictEqual(M.wraps[0].tip, 7n); assert.strictEqual(M.wraps[0].to, '0xtip');
  assert.strictEqual(M.routes.length, 1);
  assert.strictEqual(M.routes[0].inNote.leaf, '0xnew', 'the new note is routed, not an old one of the same value');
  assert.strictEqual(M.routes[0].amountIn, 1000n); assert.strictEqual(M.routes[0].minOut, 800n); assert.strictEqual(M.routes[0].fee, 10n);
  assert.deepStrictEqual(M.routes[0].path, [{ assetNext: TAC, feeBps: 30 }]);
  assert.strictEqual(M.routes[0].waitOpts.viaRelay, true);
  assert.deepStrictEqual({ tx: r.txHash, out: r.out }, { tx: '0xswap', out: 900n });
  assert.ok(steps.includes('note') && steps.includes('route'), `steps said (${steps})`);
});

test('ETH made private only: no route, the deposit is what the chain shows', async () => {
  const { M, ux } = setup({ deposit: note('0xnew', 1000) });
  const r = await run(await load(ux), plan({ wallet: true, path: [] }));
  assert.strictEqual(M.routes.length, 0);
  assert.deepStrictEqual(r, { made: 1000n, txHash: '0xdep' });
});

test('from the private balance: a note of exactly the amount is routed as it is', async () => {
  const { M, ux } = setup({ notes: [note('0xbig', 5000), note('0xexact', 1000)] });
  await run(await load(ux), plan());
  assert.strictEqual(M.wraps.length + M.cuts.length, 0, 'nothing is deposited or cut');
  assert.strictEqual(M.routes[0].inNote.leaf, '0xexact');
});

test('a larger note is cut to the amount first (the smallest that covers it and the fee), then the cut note is routed', async () => {
  const { M, ux } = setup({ notes: [note('0xbig', 5000), note('0xsmall', 900), note('0xfit', 1200)] }), steps = [];
  await run(await load(ux), plan(), steps);
  assert.strictEqual(M.cuts.length, 1);
  assert.deepStrictEqual(M.cuts[0].notes.map((n) => n.leaf), ['0xfit']);
  assert.strictEqual(M.cuts[0].amount, 1000n); assert.strictEqual(M.cuts[0].fee, 5n); assert.strictEqual(M.cuts[0].recipientPubHex, '02aa');
  assert.strictEqual(M.routes[0].inNote.leaf, '0xcut', 'the note the cut made is routed');
  assert.strictEqual(M.routes[0].amountIn, 1000n);
  assert.ok(steps.includes('split'));
});

test('several notes, none covering it, are combined into one of the amount; too little says how much fits', async () => {
  const a = setup({ notes: [note('0xa', 600), note('0xb', 600)] }), steps = [];
  await run(await load(a.ux), plan(), steps);
  assert.deepStrictEqual(a.M.cuts[0].notes.map((n) => n.leaf).sort(), ['0xa', '0xb']);
  assert.strictEqual(a.M.routes[0].inNote.leaf, '0xcut');
  assert.ok(steps.includes('combine'));
  const b = setup({ notes: [note('0xa', 600), note('0xb', 402)] });
  await assert.rejects(run(await load(b.ux), plan()), (e) => e.code === 'short' && e.most === 997n);
  assert.strictEqual(b.M.routes.length + b.M.cuts.length, 0);
});

test('the most one swap can spend: a lone note whole, else all of it less the fee to cut one', async () => {
  const a = setup({ notes: [note('0xa', 600)] }), pa = await load(a.ux);
  await pa.open(); assert.strictEqual(await pa.most(ETH, 'cETH'), 600n);
  const b = setup({ notes: [note('0xa', 600), note('0xb', 400)] }), pb = await load(b.ux);
  await pb.open(); assert.strictEqual(await pb.most(ETH, 'cETH'), 995n);
});

test('the relay held or paused: nothing is sent', async () => {
  for (const state of ['held', 'paused', 'down']) {
    const { M, ux } = setup({ deposit: note('0xnew', 1000) });
    M.relay = { state };
    await assert.rejects(run(await load(ux), plan({ wallet: true })), /isn’t taking private swaps/);
    assert.strictEqual(M.wraps.length + M.routes.length, 0, `${state}: no deposit, no route`);
  }
});

test('the relay’s floor moved: sent once more at its new fee, priced again', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)], routeErr: ['relay 400: fee below the current floor'], fee: 25n });
  const r = await run(await load(ux), plan());
  assert.deepStrictEqual(M.routes.map((x) => x.fee), [10n, 25n]);
  assert.strictEqual(r.txHash, '0xswap');
});

test('over two pools the new floor is the one-pool fee and 40% more, in two figures', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)], routeErr: ['fee below the current floor'], fee: 123n });
  await run(await load(ux), plan({ fee: 100n, path: [{ assetNext: ETH, feeBps: 30 }, { assetNext: TAC, feeBps: 30 }] }));
  assert.deepStrictEqual(M.routes.map((x) => x.fee), [100n, 180n]);
});

test('a price already past the quote stops before anything is sent: no deposit, no cut, no route', async () => {
  const a = setup({ notes: [note('0xbig', 5000)], quote: 700n });
  await assert.rejects(run(await load(a.ux), plan()), (e) => e.moved && !e.kept);
  assert.strictEqual(a.M.routes.length + a.M.cuts.length, 0);
  const b = setup({ deposit: note('0xnew', 1000), quote: 700n });
  await assert.rejects(run(await load(b.ux), plan({ wallet: true })), (e) => e.moved && !e.kept);
  assert.strictEqual(b.M.wraps.length + b.M.routes.length, 0, 'the ETH stays in the wallet');
});

test('a price that moves while the deposit settles: the ETH is kept as tETH and says so', async () => {
  const { M, ux } = setup({ deposit: note('0xnew', 1000), quotes: [900n, 700n] });
  await assert.rejects(run(await load(ux), plan({ wallet: true })), (e) => e.kept && /private now as tETH/.test(e.message) && /price moved/.test(e.message));
  assert.strictEqual(M.wraps.length, 1); assert.strictEqual(M.routes.length, 0);
});

test('a swap the relay may still finish is not offered again: its note stays out of the next pick', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)], routeErr: ['settle timed out after 900s'] });
  const pv = await load(ux);
  await assert.rejects(run(pv, plan()), (e) => e.pending && /may still go through/.test(e.message) && !e.kept);
  await pv.read(true);
  assert.strictEqual(pv.of(ETH).value, 0n, 'the note in flight is not counted');
  await assert.rejects(run(pv, plan()), (e) => e.code === 'short');
  assert.strictEqual(M.routes.length, 1, 'no second route of the same note');
});

test('the deposit path: a swap the relay may still finish says so, not "press again"', async () => {
  const { ux } = setup({ deposit: note('0xnew', 1000), routeErr: ['relay 202: proved, waiting for a sender'] });
  await assert.rejects(run(await load(ux), plan({ wallet: true })), (e) => e.pending && !e.kept);
});

test('a key sheet open once for two presses', async () => {
  const { M, ux } = setup();
  const pv = await load(ux);
  await Promise.all([pv.open(), pv.open()]);
  assert.strictEqual(M.sheets, 1);
});

test('a route that fails after the deposit says the ETH is private and kept', async () => {
  const { M, ux } = setup({ deposit: note('0xnew', 1000), routeErr: ['prove failed: boom'] });
  await assert.rejects(run(await load(ux), plan({ wallet: true })), (e) => e.kept && /relay: prove failed: boom/.test(e.message));
  assert.strictEqual(M.routes.length, 1);
});

test('a closed key sheet stops before anything is read or sent', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)] });
  M.cancel = true;
  await assert.rejects(run(await load(ux), plan()), (e) => e.unlockCancelled);
  assert.strictEqual(M.reads + M.routes.length, 0);
});

test('locking forgets the notes read and the key', async () => {
  const { M, ux } = setup({ notes: [note('0xn', 1000)] });
  const pv = await load(ux);
  await pv.open(); await pv.read();
  assert.strictEqual(pv.of(ETH).value, 1000n);
  pv.lock();
  assert.strictEqual(pv.held, null); assert.strictEqual(pv.unlocked, false); assert.strictEqual(M.forgot, 1);
});

// ── out of the pool, to an address ──
const ADDR = '0x00000000000000000000000000000000000a11ce', USDC = '0xusdc';
const sale = (wei, limit = 690n) => ({ callData: '0xswapcall' + String(wei), amountOut: 700n, amountLimit: limit });
const outPlan = (o = {}, out = {}) => ({ asset: '0xbtc', units: 1000n, ticker: 'cBTC', fee: 10n, eth: ETH, path: [{ assetNext: ETH, feeBps: 30 }], minOut: 400n, label: 'Out',
  out: { token: USDC, to: ADDR, minFee: 7n, min: 690n, wei: 495n * 10n ** 10n, quote: async (wei) => { globalThis.M.sales = [...(globalThis.M.sales || []), wei]; return sale(wei); }, ...out }, ...o });

test('cBTC to USDC at an address: routed to tETH, then exited through a recipe whose one call sells exactly what the escrow is paid', async () => {
  const { M, ux } = setup({ notes: [note('0xbtcnote', 1000, '0xbtc')], routeOut: 500 }), steps = [];
  const r = await (await load(ux)).swapOut(outPlan(), { say: (k) => steps.push(k) });
  assert.strictEqual(M.routes[0].inNote.leaf, '0xbtcnote'); assert.deepStrictEqual(M.routes[0].path, [{ assetNext: ETH, feeBps: 30 }]);
  const u = M.unwraps[0], sub = M.submits[0];
  assert.strictEqual(u.n.leaf, '0xrouted', 'the tETH the route made is what leaves');
  assert.strictEqual(u.fee, 7n, 'at the fee the page priced');
  const wei = (500n - 7n) * 10n ** 10n, call = sub.exit.calls[0];
  assert.deepStrictEqual(M.sales, [wei], 'the sale is priced for exactly what the unwrap pays');
  assert.strictEqual(call.target, '0x000000000000FB114709235f1ccBFfb925F600e4'); assert.strictEqual(call.value, wei.toString()); assert.strictEqual(call.data, '0xswapcall' + wei);
  assert.strictEqual(call.token, '0x0000000000000000000000000000000000000000'); assert.strictEqual(call.push, false);
  assert.strictEqual(sub.exit.finalRecipient, ADDR); assert.strictEqual(sub.exit.exitedAsset, ETH);
  assert.deepStrictEqual(sub.exit.sweepTokens, ['0x0000000000000000000000000000000000000000']);
  assert.strictEqual(sub.type, 'unwrap'); assert.strictEqual(sub.op.recipient, u.recipient);
  assert.ok(/^0x0{24}e5c0/.test('0x' + '0'.repeat(24) + u.recipient.slice(2)) && u.recipient === '0x' + 'e5c0' + '0'.repeat(36), `the unwrap pays the escrow the router named (${u.recipient})`);
  assert.ok(Number(sub.exit.deadline) > Date.now() / 1000 + 1700, 'the recipe runs for half an hour');
  assert.deepStrictEqual({ tx: r.txHash, out: r.out, to: r.to }, { tx: '0xactivated', out: 700n, to: ADDR });
  assert.deepStrictEqual(steps, ['route', 'note', 'exitswap', 'activate']);
});

test('tETH to ETH at an address: a plain unwrap to it, no recipe', async () => {
  const { M, ux } = setup({ notes: [note('0xt', 1000)] });
  const r = await (await load(ux)).swapOut(outPlan({ asset: ETH, path: [] }, { token: null, minFee: 9n }));
  assert.strictEqual(M.routes.length, 0);
  assert.strictEqual(M.unwraps[0].recipient, ADDR); assert.strictEqual(M.submits[0].exit, undefined);
  assert.deepStrictEqual({ tx: r.txHash, out: r.out }, { tx: '0xexit', out: (1000n - 10n) * 10n ** 10n });
});

test('a sale under the floor the quote promised (scaled to what the note pays) does not leave the pool: the tETH stays private', async () => {
  const { M, ux } = setup({ notes: [note('0xbtcnote', 1000, '0xbtc')], routeOut: 500 });
  const pv = await load(ux);
  await assert.rejects(pv.swapOut(outPlan({}, { quote: async (wei) => sale(wei, 600n) })), (e) => e.kept && /privately to tETH/.test(e.message) && /price moved/.test(e.message));
  assert.strictEqual(M.submits.length, 0, 'no exit was sent');
  const b = setup({ notes: [note('0xt', 1000)] });
  await assert.rejects((await load(b.ux)).swapOut(outPlan({ asset: ETH, path: [] }, { quote: async (wei) => sale(wei, 1n) })), (e) => e.moved && !e.kept);
});

test('the relay refuses to run the swap: the exit is stuck at its escrow and says so, with its recipe', async () => {
  const { ux } = setup({ notes: [note('0xt', 1000)], activation: 'failed' });
  await assert.rejects((await load(ux)).swapOut(outPlan({ asset: ETH, path: [] }, { wei: 990n * 10n ** 10n })), (e) => e.stuck && e.stuck.recipe.finalRecipient === ADDR && e.stuck.escrow && /below the cost/.test(e.stuck.why));
});

test('the relay’s floor moved before it took the exit: priced again, a new recipe at the higher fee', async () => {
  const { M, ux } = setup({ notes: [note('0xt', 1000)], submitErr: ['relay 400: fee below the current floor'] });
  await (await load(ux)).swapOut(outPlan({ asset: ETH, path: [] }, { wei: 990n * 10n ** 10n }));
  assert.strictEqual(M.submits.length, 2);
  assert.deepStrictEqual(M.unwraps.map((u) => u.fee), [10n, 14n], 'the 1% fee first, then twice the floor asked');
  assert.notStrictEqual(M.submits[0].exit.calls[0].value, M.submits[1].exit.calls[0].value, 'the second recipe sells what the higher fee leaves');
});

test('an exit the relay refuses after the route: the tETH stays private and the card can send it on', async () => {
  const { ux } = setup({ notes: [note('0xbtcnote', 1000, '0xbtc')], routeOut: 500, submitErr: ['relay 400: no'] });
  await assert.rejects((await load(ux)).swapOut(outPlan()), (e) => e.kept && /did not leave the pool/.test(e.message));
});

test('the calls a wallet can send for a stuck exit: the swap, or the ETH on to the address', async () => {
  const { ux } = setup();
  assert.deepStrictEqual(await (await load(ux)).exitCalls({}), { router: '0xrouter', activate: '0xact', reclaim: '0xback' });
});
