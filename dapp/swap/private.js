// The private swap made on the swap card, with the Tacit key opened here. A swap paid from the wallet's ETH makes the ETH private first (the
// tETH page's deposit, which the relay settles) and then swaps that note in the Tacit pool; one paid from the private balance swaps a note of
// exactly the amount, cutting one to size first (a send to itself) when none is, as the front page does: a swap spends its note whole. A swap
// out of the pool (to ETH or a token, at an address) routes the note to tETH and then exits that note, through an exit recipe for a token. The
// relay proves and sends each step. Nothing here is loaded until the first private swap, or the first ask for a private balance; the key is
// held in this visit's memory only.
import { makeKeySession, signInSheet, Cancelled } from '/trade/key.js?cb=149c5b79';
import { forgetUx } from '/trade/poolux.js?cb=1722600f';
import { wrapEth, relayState, relayStopped, relayWords } from '/teth/wrap.js?cb=c692a14d';
import { wrapQuote } from '/teth/read.js?cb=b2a110d0';
import { secp, keccak_256, sha256, bytesToHex } from '/vendor/tacit-deps.min.js';
import { makeRunner } from '/activity.js?cb=532a162f';

export { Cancelled, relayWords };

// A Tacit address, a shielded pubkey or a name (name.wei, .gwei, .eth) as the key a private payment is made to. → { pubHex, name? }; throws with a
// sentence for the person when it is none of them (an Ethereum account address is refused: a private payment needs a Tacit address).
let namesP = null;
const names = () => (namesP ||= import('/confidential-names.js').then(({ makeConfidentialNames, makeMainnetCall }) => makeConfidentialNames({ call: makeMainnetCall(), secp, keccak256: keccak_256 })).catch((e) => { namesP = null; throw e; }));
export async function resolveTacit(raw) {
  const n = await names();
  const local = (s) => {
    try { const d = n.decodeTacitAddress(s); return d.key ? { pubHex: d.key } : { error: 'This Tacit address has no Ethereum-lane key, so it cannot receive a private payment. Ask for their pool address (bp1…) instead.' }; }
    catch (e) { return /^0x0[23][0-9a-fA-F]{64}$/.test(s) ? { pubHex: s } : { error: e.message }; }
  };
  return n.resolveRecipient(String(raw || '').trim(), { local });
}
const API = 'https://api.tacit.finance';
const lc = (s) => String(s || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const floorMiss = (e) => /fee below the current floor/i.test(String(e?.message || ''));
// A step the relay may still finish (it timed out here, or is proved and waits for a sender): its note is not offered again for a while.
const pending = (e) => !!e?.open || /settle timed out|status polling for job|prove timed out|waiting for a sender|settle held/i.test(String(e?.message || ''));
const IN_USE_MS = 20 * 60e3;
// A route's relay fee over two pools is the one-pool fee and 40% more, in two figures, as the quote above prices it.
const twoDigits = (v) => { if (v <= 0n) return 0n; const d = BigInt(String(v).length); if (d <= 2n) return v; const m = 10n ** (d - 2n); return ((v + m - 1n) / m) * m; };
// A swap that stopped after its ETH was made private: the ETH is safe as tETH, and the card offers to swap it from there.
const kept = (msg, cause) => Object.assign(new Error(msg), { kept: true, cause });
const ZERO = '0x0000000000000000000000000000000000000000', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', E10 = 10n ** 10n;
// How long an exit recipe may run before its escrow's ETH can only be sent on to the address.
const EXIT_TTL = 1800;
const nonce = () => BigInt('0x' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')).toString();

// `getUx()` gives the page's pool module; `pick(list)` chooses among several Ethereum wallets for the key sheet; `onKey(text)` is told when the key opens or is locked (`text` says why).
// A page that holds a Tacit key of its own (the front page) hands it over instead: `session` (unlocked, key, priv()), `openKey(why)` to ask for it
// (resolves once it is open), and `wait(label, ms)` for the relay's jobs to go into the page's own Activity journal.
export function makePrivate({ getUx, pick, onKey = () => {}, session = null, openKey = null, wait = null } = {}) {
  const key = session || makeKeySession({ moved: (why) => { lock(); onKey(why); } });
  let held = null, heldP = null, runner = null, opening = null;
  const busy = new Map();                                     // leaf -> when a step that spends it was sent and may still land
  const free = (n) => !(Date.now() - (busy.get(lc(n.leaf)) || 0) < IN_USE_MS);
  const run = () => (wait ? { wait } : runner ||= makeRunner({ api: API, base: async () => API, pub: () => key.key?.pubHex || null }));

  // what was read under a key: dropped when it locks, or when the page's own key changes
  function reset() { held = null; heldP = null; busy.clear(); }
  function lock() { if (!session) key.lock(); forgetUx(); reset(); }
  // one sheet at a time: a second press while it is open waits for the same one
  function open(why = 'Open your Tacit wallet to swap privately. This page never stores the key.') {
    if (key.unlocked) return Promise.resolve();
    return (opening ||= (openKey ? openKey(why) : signInSheet(key, { pick, why })).then(() => { held = null; onKey(''); }).finally(() => { opening = null; }));
  }

  // What the key holds, by pool asset id: its unspent notes and their sum. Read again after every swap.
  let readFailed = false;                                                             // the last read threw: the page offers another
  function read(force = false) {
    if (!key.unlocked) return Promise.resolve(null);
    if (held && !force) return Promise.resolve(held);
    const pub = key.key.pubHex;
    return (heldP ||= (async () => {
      const t = await getUx(), r = await t.balance(key.priv(), { bridge: false });
      if (key.key?.pubHex !== pub) return null;
      readFailed = false;
      return (held = { pub, at: Date.now(), byAsset: r.byAsset || {}, pending: r.diag?.wrap?.pending || [] });
    })().catch((e) => { readFailed = true; throw e; }).finally(() => { heldP = null; }));
  }
  // What the key holds of an asset, less the notes a step still in flight may spend.
  const of = (id) => { const g = held?.byAsset?.[lc(id)]; const notes = (g?.notes || []).filter(free); return { value: notes.reduce((a, n) => a + BigInt(n.value), 0n), notes }; };
  const byValue = (a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : BigInt(a.value) > BigInt(b.value) ? 1 : 0);

  // A note of exactly `units`: one held, or one cut to size by a send to itself (the smallest note that covers it and the relay's fee, else up
  // to 16 notes combined, largest first). The cut's fee comes out of the notes, so the amount swapped is the amount asked.
  async function exactNote({ asset, units, ticker, say }) {
    await read(true);
    const has = of(asset).notes.find((n) => BigInt(n.value) === units);
    if (has) return has;
    const t = await getUx(), fee = BigInt(await t.quoteOpFee(ticker, 'transfer')), need = units + fee, up = [...of(asset).notes].sort(byValue);
    let picked = up.filter((n) => BigInt(n.value) >= need).slice(0, 1), sum = picked.length ? BigInt(picked[0].value) : 0n;
    for (const n of picked.length ? [] : [...up].reverse()) { if (sum >= need || picked.length === 16) break; picked.push(n); sum += BigInt(n.value); }
    if (sum < need) throw Object.assign(new Error('short'), { code: 'short', most: sum > fee ? sum - fee : 0n, fee });
    say(picked.length > 1 ? 'combine' : 'split');
    const before = new Set(of(asset).notes.map((n) => lc(n.leaf)));
    const cut = (f) => t.transfer({ walletPriv: key.priv(), notes: picked, recipientPubHex: t.identity(key.priv()).pubHex, amount: units, fee: f,
      waitOpts: { ...run().wait(picked.length > 1 ? 'Combine notes' : 'Split a note', 15 * 60e3), intervalMs: 4000, viaRelay: true } });
    try {
      try { await cut(fee); }
      catch (e) { const f2 = t.ladderFee(fee * 2n); if (floorMiss(e) && sum >= units + f2) await cut(f2); else throw e; }
    } catch (e) { if (pending(e)) for (const n of picked) busy.set(lc(n.leaf), Date.now()); throw e; }
    for (const n of picked) busy.set(lc(n.leaf), Date.now());
    for (let i = 0; i < 10; i++) {
      await read(true).catch(() => null);
      const n = of(asset).notes.find((x) => BigInt(x.value) === units && !before.has(lc(x.leaf)));
      if (n) return n;
      await sleep(5000);
    }
    throw Object.assign(new Error('Your note was cut to size, but it is not showing yet. Press again in a minute to swap it.'), { said: true });
  }

  // The relay is asked before anything is sent: a swap is a step that expires, so it cannot wait in line while the relay is held.
  async function relayOpen() {
    const rs = await relayState();
    if (relayStopped(rs) || rs?.state === 'held') throw new Error('The relay isn’t taking private swaps right now, so nothing was sent. Try again in a few minutes.');
  }

  // One relayed route of `note`: priced again first (it may have waited a minute for its note), and sent again once at the relay's new floor.
  const price = async (asset, units, path, fee, minOut) => {
    const q = await (await getUx()).quoteRoute({ asset0: asset, amountIn: units, path, fee });
    if (!q || q.amountOut < minOut) throw Object.assign(new Error('The price moved past what was quoted, so the swap was not sent.'), { moved: true });
    return q;
  };
  async function route({ note, units, path, fee, minOut, ticker, label, say }) {
    const t = await getUx();
    const priced = async (f) => {
      const q = await t.quoteRoute({ asset0: note.asset, amountIn: units, path, fee: f });
      if (!q || q.amountOut < minOut) throw Object.assign(new Error('The price moved past what was quoted, so the swap was not sent.'), { moved: true });
      return q;
    };
    let q = await priced(fee);
    const send = (f) => t.route({ walletPriv: key.priv(), inNote: note, amountIn: units, path, minOut, fee: f,
      waitOpts: { ...run().wait(label, 15 * 60e3), intervalMs: 4000, viaRelay: true } });
    say('route');
    let r;
    try {
      try { r = await send(fee); }
      catch (e) {
        if (!floorMiss(e)) throw e;
        const one = BigInt(await t.quoteOpFee(ticker, 'route')), now = path.length > 1 ? twoDigits((one * 14n) / 10n) : one, f2 = now > fee ? now : t.ladderFee(fee * 2n);
        q = await priced(f2);
        r = await send(f2);
      }
    } catch (e) { if (pending(e)) busy.set(lc(note.leaf), Date.now()); throw e; }
    busy.set(lc(note.leaf), Date.now());
    held = null;
    return { txHash: r?.txHash || null, out: q.amountOut };
  }

  // The recipe's escrow, as the router itself computes it: the address the unwrap's proof pays.
  async function escrowOf(t, recipe) {
    const r = String(await t.ethCall(t.cfg.router, t.router.escrowAddressForCalldata(recipe))).replace(/^0x/, '');
    const a = '0x' + r.slice(-40);
    if (r.length < 64 || /^0x0{40}$/.test(a)) throw new Error('The exit’s escrow could not be read, so nothing was sent. Try again in a moment.');
    return lc(a);
  }
  // A new note of `asset` worth at least `min`, not among `before`: what a route just made.
  async function newNote(asset, before, min) {
    for (let i = 0; i < 10; i++) {
      await read(true).catch(() => null);
      const n = of(asset).notes.find((x) => !before.has(lc(x.leaf)) && BigInt(x.value) >= min);
      if (n) return n;
      await sleep(5000);
    }
    return null;
  }

  // A tETH note out of the pool to `out.to`: as ETH (an unwrap to the address), or as `out.token` through an exit recipe: an unwrap to the
  // recipe's escrow, whose one call sells exactly the ETH paid to it on zRouter for the token, paid to the address. The relay runs it once the
  // settle lands; past its deadline anyone can send the escrow's ETH on to the address instead (reclaimExit). `out.quote(wei)` prices the sale;
  // `out.min` is the least the quote shown would pay for the `out.wei` it priced, so the floor follows the ETH this note pays; `out.minFee` is
  // the exit's fee floor as the page priced it.
  async function exitNote({ note, out, label, say }) {
    const t = await getUx(), eth = !out.token;
    // the page's quote priced the fee: the settle's floor, and for a token the relay's activation of the swap as well
    let minFee = BigInt(out.minFee);
    for (let attempt = 0; ; attempt++) {
      const { fee, net } = t.quoteUnwrapFee(note.value, 'cETH', { minFee });
      if (net <= 0n) throw new Error('This is too small to leave the pool: the relay’s fee is more than it.');
      const wei = net * E10;
      let recipe = null, to = lc(out.to), sale = null;
      if (!eth) {
        sale = await out.quote(wei);
        if (!sale || sale.amountLimit < (out.min * wei) / out.wei) throw Object.assign(new Error('The price moved past what was quoted, so it did not leave the pool.'), { moved: true });
        recipe = { exitedAsset: note.asset, feeAsset: ZERO, finalRecipient: lc(out.to), deadline: String(Math.floor(Date.now() / 1000) + EXIT_TTL), nonce: nonce(),
          calls: [{ target: ZROUTER, value: wei.toString(), token: ZERO, amount: '0', push: false, data: sale.callData }], sweepTokens: [ZERO], minOuts: ['0'] };
        to = await escrowOf(t, recipe);
      }
      const built = t.buildUnwrap({ note, walletPriv: key.priv(), recipient: to, feeOpts: { minFee } });
      if (BigInt(built.op.fee) !== fee || lc(built.op.recipient) !== to) throw new Error('The exit did not come out as priced, so nothing was sent.');
      say(eth ? 'exit' : 'exitswap');
      const waitOpts = { ...run().wait(label, 15 * 60e3), intervalMs: 4000, viaRelay: true };
      let st, jobId = null;
      try {
        const sub = await t.relay.submitOp({ type: 'unwrap', op: built.op, memos: [], ...(recipe ? { exit: recipe } : {}) }, waitOpts);
        jobId = sub.jobId;
        st = await t.relay.waitForSettle(jobId, waitOpts);
      } catch (e) {
        if (floorMiss(e) && attempt === 0 && !jobId) { minFee = t.ladderFee(minFee * 2n); continue; }
        if (jobId || pending(e)) busy.set(lc(note.leaf), Date.now());
        if (recipe && jobId) e.stuck = { recipe, escrow: to, jobId };
        throw e;
      }
      busy.set(lc(note.leaf), Date.now()); held = null;
      if (eth) return { txHash: st.txHash || null, out: wei, to };
      // the relay sends activateExit once the settle lands: followed here for up to three minutes
      say('activate', st.txHash);
      for (let i = 0; i < 36; i++) {
        const s = await t.relay.status(jobId).catch(() => null);
        if (s?.activation === 'done' && s.activateTx) return { txHash: s.activateTx, settleTx: st.txHash || null, out: sale.amountOut, to: lc(out.to), recipe };
        if (s?.activation === 'failed') throw Object.assign(new Error('The relay did not run the swap.'), { stuck: { recipe, escrow: to, jobId, why: s.activateError || null } });
        await sleep(5000);
      }
      throw Object.assign(new Error('The swap has not run yet.'), { stuck: { recipe, escrow: to, jobId, slow: true } });
    }
  }

  // A swap out of the pool. `plan`: { asset, units, ticker, fee, path (the route to tETH; none when `asset` is tETH), minOut (its least tETH),
  // eth (tETH's pool id), out: { token (none: ETH), to, quote, min, wei, minFee }, label }. A note that has become tETH stays private if the exit stops.
  async function swapOut(plan, { say = () => {} } = {}) {
    await open();
    await relayOpen();
    if (!plan.path?.length) {
      const note = await exactNote({ asset: plan.eth, units: plan.units, ticker: 'cETH', say });
      return exitNote({ note, out: plan.out, label: plan.label, say });
    }
    await price(plan.asset, plan.units, plan.path, plan.fee, plan.minOut);
    const n = await exactNote({ asset: plan.asset, units: plan.units, ticker: plan.ticker, say });
    const before = new Set((held?.byAsset?.[lc(plan.eth)]?.notes || []).map((x) => lc(x.leaf)));
    const r = await route({ note: n, ...plan, say });
    say('note');
    const tNote = await newNote(plan.eth, before, plan.minOut);
    if (!tNote) throw kept('Swapped privately to tETH, but its note is not showing yet. Press again in a minute to send it on.');
    try { return { ...(await exitNote({ note: tNote, out: plan.out, label: plan.label, say })), routeTx: r.txHash }; }
    catch (e) {
      if (e.stuck || pending(e)) throw e;
      throw kept(`Swapped privately to tETH, but it did not leave the pool: ${e.moved ? 'the price moved past what was quoted.' : relayWords(e)}`, e);
    }
  }
  // What the page sends from a wallet for an exit whose swap did not run: the swap itself, until the recipe's deadline, or the escrow's ETH on to
  // the address after it.
  async function exitCalls(recipe) {
    const t = await getUx();
    return { router: t.cfg.router, activate: t.router.activateExitCalldata(recipe), reclaim: t.router.reclaimExitCalldata(recipe, []) };
  }

  // `plan`: { wallet: true for a swap paid from the wallet's ETH (`wei`), else the pool asset `asset` paid from a note; `units` the amount in
  // the pool's 8 decimals; `path` the route's hops (none: only make the ETH private); `fee` the route's relay fee in what is paid, `ticker`
  // its pool ticker; `minOut` the least it may give, in 8 decimals; `label` the activity journal's name }.
  // `say(step, hash)`: 'prepare' | 'confirm' | 'sent' | 'proving' (the deposit) | 'note' | 'route'.
  async function swap(plan, { wallet, from, say = () => {} }) {
    await open();
    await relayOpen();
    // a payment to the key's own address is refused before anything is sent: it would be a swap into the same balance, by a longer way
    if (plan.sendTo && lc(plan.sendTo.pubHex) === lc(key.key.pubHex)) throw new Error('That is your own address. Leave it empty to keep the swap in your private balance.');
    let note = null, before = new Set();
    if (plan.wallet) {
      // priced before the ETH leaves the wallet, so a price already past the quote stops here and not after the deposit
      if (plan.path?.length) await price(plan.asset, plan.units, plan.path, plan.fee, plan.minOut);
      const tq = await wrapQuote(plan.wei), t = await getUx();
      // wrapEth throws with `deposit` once the ETH has left the wallet: the page says where it is and how to finish it
      const { hash, built } = await wrapEth({ priv: () => key.priv(), wei: plan.wei, tip: tq.tip, to: tq.to, from, wallet, say, ux: t });
      held = null;
      if (!plan.path?.length && !plan.sendTo) return { made: plan.units, txHash: hash };
      say('note');
      for (let i = 0; i < 10 && !note; i++) {
        const h = await read(true).catch(() => null);
        note = h ? of(built.note.asset).notes.find((n) => lc(n.leaf) === lc(built.leaf)) || null : null;
        if (!note) await sleep(5000);
      }
      if (!note) throw kept('Your ETH is private now as tETH, but its note is not showing yet. Press again in a minute to swap it.');
      if (!plan.path?.length) return sendOn({ plan, made: { made: plan.units, txHash: hash }, before, say, direct: note });
    } else {
      await price(plan.asset, plan.units, plan.path, plan.fee, plan.minOut);
      note = await exactNote({ asset: plan.asset, units: plan.units, ticker: plan.ticker, say });
    }
    // the notes the swap's own asset has now, so the one the route makes is told from them
    const outAsset = plan.path?.length ? plan.path[plan.path.length - 1].assetNext : plan.asset;
    before = new Set((held?.byAsset?.[lc(outAsset)]?.notes || []).map((n) => lc(n.leaf)));
    let made;
    try { made = await route({ note, ...plan, say }); }
    catch (e) {
      if (pending(e)) throw Object.assign(new Error(`${relayWords(e)} Your swap may still go through: check your private balance in a few minutes before swapping again.`), { pending: true, cause: e });
      if (plan.wallet) throw kept(`Your ETH is private now as tETH, but the swap stopped: ${e.moved ? 'the price moved past what was quoted.' : relayWords(e)}`, e);
      throw e;
    }
    return plan.sendTo ? sendOn({ plan, made, before, say }) : made;
  }

  // What the swap made, sent on to another Tacit address: the note it paid into the balance, locked for the recipient (a stealth payment they claim
  // in their Tacit wallet, or the sender takes back after ninety days), the lock kept in this browser as the front page keeps it. A stop here leaves
  // the swap done: its note is in the balance.
  async function sendOn({ plan, made, before, say, direct = null }) {
    const outAsset = plan.path?.length ? plan.path[plan.path.length - 1].assetNext : plan.asset;
    say('note');
    const note = direct || await newNote(outAsset, before, plan.minOut);
    const stay = (why) => Object.assign(new Error(`Swapped, and it is in your private balance, but it was not sent on: ${why}`), { stayed: true, made });
    if (!note) throw stay('its note is not showing yet. Press again in a minute to send it.');
    const t = await getUx();
    try {
      say('send');
      let built = null;
      const r = await t.stealthSend({ walletPriv: key.priv(), recipientPubHex: plan.sendTo.pubHex, notes: [note], amount: BigInt(note.value), onBuilt: (b) => { built = b; },
        waitOpts: { ...run().wait(`${plan.label} to ${plan.sendTo.name || 'a Tacit address'}`, 15 * 60e3), intervalMs: 4000, viaRelay: true } });
      busy.set(lc(note.leaf), Date.now()); held = null;
      if (built) {
        try {
          const { makeStealthSendStore } = await import('/confidential-secret-store.js');
          await makeStealthSendStore({ sha256 }).add(key.priv(), { lockLeaf: built.lockLeaf, asset: built.asset, ticker: plan.outTicker || plan.ticker, dec: 8, amount: built.amount, deadline: built.deadline,
            lCx: built.lCx, lCy: built.lCy, ownerPub: built.ownerPub, lBlinding: built.lBlinding, refundPriv: built.refundPriv, refundPub: built.refundPub,
            recipientPubHex: built.recipientPubHex, txHash: r?.txHash, createdAt: Date.now(), recipientName: plan.sendTo.name || undefined });
        } catch { /* the take-back scan finds a lock from the key alone */ }
      }
      return { ...made, sent: { to: plan.sendTo.name || null, txHash: r?.txHash || null } };
    } catch (e) {
      if (pending(e)) { busy.set(lc(note.leaf), Date.now()); throw Object.assign(new Error(`${relayWords(e)} It may still go through: check your private balance in a few minutes before sending it again.`), { pending: true, made }); }
      throw stay(relayWords(e));
    }
  }

  // The most a swap from the private balance can spend: one note whole, or what is held less the fee to cut a note to size.
  async function most(asset, ticker) {
    const h = await read();
    if (!h) return null;
    const g = of(asset);
    if (g.notes.length <= 1) return g.value;
    const fee = BigInt(await (await getUx()).quoteOpFee(ticker, 'transfer'));
    return g.value > fee ? g.value - fee : 0n;
  }

  // The key as hex for the private ETH pool's wallet (swap/later.js), opened first if it is not: one key sheet for both kinds of private swap.
  const keyHex = async () => { await open(); return bytesToHex(key.priv()); };

  // A note of `units` of `asset` (cut to size if none is) sent on to a Tacit address, as a private swap's result is: for a swap made elsewhere on
  // the page whose TAC was just made private. → { sent: { to, txHash } }.
  async function sendPrivate({ asset, units, ticker, sendTo, label, say = () => {} }) {
    await open();
    const note = await exactNote({ asset, units: BigInt(units), ticker, say });
    return sendOn({ plan: { path: [], asset, minOut: BigInt(units), sendTo, label, outTicker: ticker }, made: { made: BigInt(units) }, before: null, say, direct: note });
  }

  return {
    open, lock, reset, read, swap, swapOut, exitCalls, of, most, keyHex, sendPrivate,
    // the checks a swap makes before anything leaves a wallet, for a page that first sells a token for the ETH it will make private
    relayOpen, priceOk: (asset, units, path, fee, minOut) => (path?.length ? price(asset, units, path, fee, minOut) : Promise.resolve(null)),
    get unlocked() { return key.unlocked; },
    get held() { return held; },
    get readFailed() { return readFailed; },
  };
}
