// "Swap privately" on the swap card: the wallet's ETH is deposited now into the private ETH pool (TacitEvmPool, proved on this device, the pool
// /pay/eth and anon.wei use), with an extra amount on top so the deposit is not the swap; later, after other deposits have landed, a withdrawal
// pays exactly the swap's ETH into a call intent's escrow (router.withdrawAndCall) whose one call swaps it on zRouter and pays the token to the
// address given, so nothing on chain ties the deposit to where the token goes. The pool's keeper sends the withdrawal (no wallet is seen); the
// signer can send it instead. What is left of the deposit stays a private note in the pool. Each swap's plan is kept in this browser until done.
import { hexToBytes } from '/vendor/tacit-deps.min.js';
import { checkZRouterCall } from '/zrouter-guard.js';
import { bestRoute } from '/swap/aggregate.js?cb=9d477e38';

export const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
export const CHAIN = { chainId: 1, rpc: ['https://ethereum-rpc.publicnode.com', 'https://mainnet.gateway.tenderly.co', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
  keeper: 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper', deployBlock: 26069245, confirmations: 3 };
const ZERO = '0x0000000000000000000000000000000000000000', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
const PLANS_KEY = 'tacit-swap-later-v1', ARTIFACT_CACHE = 'tacit-evm-pool-artifacts-v1';
const lc = (s) => String(s || '').toLowerCase();
const word = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');
const hexOf = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
// How long the swap's route may take to run once quoted, and the gas the relay is asked to price beyond the route's own: the withdrawal and its escrow.
const DEADLINE_S = 1200, BASE_GAS = 520_000n;

// The plans kept in this browser: amounts, the token, the address it goes to, the deposit and swap transactions, and (while one waits) the wallet
// that deposited, so a swap out is never sent from it; that is dropped once the swap is done.
export const readPlans = (store = globalThis.localStorage) => { try { return (JSON.parse(store.getItem(PLANS_KEY) || '[]') || []).filter((p) => p && p.id).slice(0, 20); } catch { return []; } };
const keepPlans = (ps, store = globalThis.localStorage) => { try { store.setItem(PLANS_KEY, JSON.stringify(ps.slice(0, 20))); } catch { } };

// The route for `amount` wei of ETH into `token`, paid to `to`, asked of the nodes with a random stand-in in place of `to` (so no node sees where
// the tokens go), then written with `to` and held to the guard again: exactly the ETH it is sent, the token to `to`, at least its floor.
export async function routeOut({ ethCall, token, amount, to, slippageBps, deadline, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  const stand = '0x' + hexOf(random(20)), q = await bestRoute({ ethCall, to: stand, refundTo: stand, tokenIn: ZERO, tokenOut: token, amountIn: amount, slippageBps, deadline });
  if (!q) return null;
  const data = q.callData.split(word(stand)).join(word(to));
  if (data === q.callData) return null;
  if (checkZRouterCall(data, { to, tokenIn: ZERO, tokenOut: token, exactOut: false, amount, maxIn: amount, minOut: q.min, deadline }) !== null) return null;
  // `standData`: the route as the nodes saw it, for any later read (a gas estimate) that should not name `to` either
  return { ...q, callData: data, standData: q.callData, to };
}
// The route for `amount` wei of ETH into TAC, paid to `to`: the Precision pool or the Tacit pool, as the swap page's own ticket picks between
// them (`venues`, evm-trade-venues.js), built here as zRouter's own calls with `to` as the recipient, the escrow's ETH as the value and the floor
// asked. zQuoter does not route TAC, and the guard reads only zRouter's swaps, so this is checked another way: the same calls built for a random
// stand-in must differ from the real ones in nothing but that address, and the stand-in's copy is what any later read (a gas estimate) sees.
export async function routeOutTac({ venues, amount, to, slippageBps, deadline, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  if (!venues) throw new Error('TAC swaps need the page\'s venues.');
  const rt = await venues.route({ dir: 'ETH_TO_TAC', amountIn: BigInt(amount) });
  const q = rt?.single;
  if (!q || (q.venue !== 'precision' && q.venue !== 'tacit-amm') || BigInt(q.amountIn) !== BigInt(amount)) return null;      // the Tacit pool trims an amount to its unit: dust would stay with zRouter
  const min = (BigInt(q.amountOut) * BigInt(10000 - slippageBps)) / 10000n;
  if (min <= 0n) return null;
  const mk = (rcpt) => venues.build({ quote: q, dir: 'ETH_TO_TAC', account: rcpt, to: rcpt, minOut: min, deadline: BigInt(deadline) });
  const stand = '0x' + hexOf(random(20)), real = mk(to), copy = mk(stand);
  if (lc(real.to) !== lc(ZROUTER) || BigInt(real.value || 0) !== BigInt(amount) || real.approval) return null;
  if (copy.data === real.data || copy.data.split(word(stand)).join(word(to)) !== real.data) return null;
  return { kind: 'tac', callData: real.data, standData: copy.data, min, out: BigInt(q.amountOut), amountIn: BigInt(q.amountIn), name: q.venue === 'precision' ? 'Precision pool' : 'Tacit pool', to, deadline: BigInt(deadline) };
}
// A deposit that is not an amount of its own: the swap, the relay's fee twice and an extra (the slider's share of the swap, drawn at random
// between three quarters and one and a quarter of it, never under a twentieth), rounded up to two significant figures.
// `gasWei`: for a swap into a private balance, the gas the key's own account is handed with the TAC, to make it private from there.
export function depositFor({ swapWei, feeWei, pct, rand = Math.random, gasWei = 0n }) {
  const swap = BigInt(swapWei), share = Math.max(5, Math.round(pct * (0.75 + rand() * 0.5))), fixed = 2n * BigInt(feeWei) + BigInt(gasWei);
  const total = swap + fixed + (swap * BigInt(share)) / 100n;
  const unit = 10n ** BigInt(Math.max(0, total.toString().length - 2)), dep = ((total + unit - 1n) / unit) * unit;
  return { depositWei: dep, extraWei: dep - swap - fixed };
}
const randomNonce = () => BigInt('0x' + hexOf(crypto.getRandomValues(new Uint8Array(16))));
// What the relay's answer leaves open: the swap out may have been sent (no answer, or no receipt in time), so it is checked before another.
const unsure = (e) => /may still have sent|did not answer|already on its way|waiting for it to be mined|timed out/i.test(String(e?.message || e));
// A refusal by the relay itself (nothing sent): the one case a swap out may be sent from a wallet instead.
const refused = (e) => /relay(er)? returned|relay could not|cannot front|too low|fee went up|is full|refus/i.test(String(e?.message || e));

// The keeper's fee for a withdrawal into a swap, read without a key (the card quotes the deposit before the key is open). → wei.
export async function relayFee(gas = Number(BASE_GAS + 400_000n), get = globalThis.fetch) {
  const r = await get(`${CHAIN.keeper}/quote?gas=${gas}`, { signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !/^\d+$/.test(String(j.fee ?? ''))) throw new Error('The relay could not quote its fee right now. Try again in a moment.');
  return BigInt(j.fee);
}

// `keyHex()` opens the Tacit key and gives its private key (hex); `signer` sends from the connected wallet ({ address, ready, send, rpc });
// `ethCall(to, data, block, { gas })` is the page's (zQuoter's scans need a node that allows a large call).
// `chain` and `prove` are for tests (another chain's nodes and keeper, a prover that needs no worker).
// `venues` is the swap page's evm-trade-venues instance, for a swap into TAC; `ux()` gives the pool module (confidential-pool-ux.js) and
// `sendPrivate` the page's send of a private note to a Tacit address (swap/private.js), both for a swap that ends in a private balance.
export function makeLater({ keyHex, signer, ethCall, venues = null, ux = null, sendPrivate = null, store = globalThis.localStorage, chain = CHAIN, prove: proveWith = null }) {
  let modsP = null, W = null, Wfor = null, proverP = null, rpc = null;
  // A plan's destination: { kind: 'address' } pays `to`; { kind: 'me' } pays the key's own Tacit account and makes the TAC private there;
  // { kind: 'tacit', pubHex, name } does that and sends the note on to that Tacit address. Only TAC is a pool asset this flow makes private.
  const poolDest = (plan) => !!plan?.dest && plan.dest.kind !== 'address';
  // The key's own Tacit account: the Ethereum account the pool module derives from the key alone (nothing but the key knows it), from which it
  // deposits into the private pool. The TAC lands there first, with the gas to make it private.
  async function tacitAccount() {
    if (!ux) throw new Error('A private destination needs the pool module.');
    const t = await ux(), priv = hexToBytes(await keyHex());
    const tk = t.assetByTicker.TAC ? 'TAC' : 'cTAC', meta = t.assetByTicker[tk];
    if (!meta?.assetId) throw new Error('TAC is not a pool asset on this network.');
    return { t, priv, acct: t.account(priv), tk, meta };
  }
  const prover = { ms: null, ready: false };
  const mods = () => (modsP ||= (async () => {
    const [zkm, wm, gw, pm, pos] = await Promise.all([import('/evm-pool-zk.js'), import('/evm-pool-wallet.js?cb=cc1570cb'), import('/evm-pool-gateway.js'), import('/evm-pool-zk-prover.js?cb=00ff69c2'), import('/vendor/tacit-poseidon.min.js')]);
    const PO = { 2: pos.poseidon2, 3: pos.poseidon3, 4: pos.poseidon4, 5: pos.poseidon5, 7: pos.poseidon7 };
    return { zk: zkm.makeEvmPoolZk({ poseidon: (xs) => PO[xs.length](xs) }), wm, gw, vkHash: pm.vkHash };
  })().catch((e) => { modsP = null; throw e; }));

  // The ceremony's proving key and circuit, fetched once (kept in the cache /pay/eth keeps them in, so either page's download serves the other)
  // and checked against their pinned hashes, then loaded into a worker that stays warm: what makes the proof start the moment the swap is sent.
  async function artifact(name, sha) {
    const url = '/evm-pool/' + name, key = `${url}?sha256=${sha}`;
    let cache = null; try { cache = await caches.open(ARTIFACT_CACHE); } catch { }
    const hit = cache ? await cache.match(key).catch(() => null) : null;
    const bytes = new Uint8Array(await (hit || await fetch(url).then((r) => { if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r; })).arrayBuffer());
    if (hexOf(await crypto.subtle.digest('SHA-256', bytes)) !== lc(sha).replace(/^0x/, '')) { if (hit) await cache.delete(key).catch(() => {}); throw new Error(`${name} does not match the ceremony’s pinned hash`); }
    if (!hit && cache) await cache.put(key, new Response(bytes)).catch(() => {});
    return bytes;
  }
  function warm() {
    if (proveWith) return Promise.resolve(proveWith);
    return (proverP ||= (async () => {
      const { vkHash } = await mods(), p = await (await fetch('/evm-pool/pin.json', { cache: 'no-store' })).json();
      const [vkB, wasm, zkey] = await Promise.all([artifact(p.vk, p.vk_sha256), artifact(p.wasm, p.wasm_sha256), artifact(p.zkey, p.zkey_sha256)]);
      const vk = JSON.parse(new TextDecoder().decode(vkB));
      if (vkHash(vk) !== lc(p.vk_hash).replace(/^0x/, '')) throw new Error('The verification key does not match the ceremony pin.');
      const worker = new Worker('/evm-pool-prove-worker.js?cb=7f41e5e0', { type: 'module' });
      let id = 0; const waiting = new Map();
      worker.onmessage = ({ data }) => { const w = waiting.get(data.id); if (!w) return; waiting.delete(data.id); data.ok ? w.resolve(data) : w.reject(new Error(data.error)); };
      worker.onerror = (ev) => { ev.preventDefault?.(); for (const w of waiting.values()) w.reject(new Error('Proving stopped on this device, likely short of memory. Close other tabs and try again.')); waiting.clear(); proverP = null; };
      const call = (msg, transfer = []) => new Promise((resolve, reject) => { const i = ++id; waiting.set(i, { resolve, reject }); worker.postMessage({ ...msg, id: i }, transfer); });
      await call({ op: 'init', wasm, zkey, vk }, [wasm.buffer, zkey.buffer]);
      prover.ready = true;
      return async (input) => { const t = performance.now(), r = await call({ op: 'prove', input }); prover.ms = performance.now() - t; return { proof: r.proof, publicSignals: r.publicSignals }; };
    })().catch((e) => { proverP = null; throw e; }));
  }
  const prove = async (input) => (await warm())(input);

  // The key's pool wallet, its state kept where /pay/eth keeps it, so either page sees the same notes.
  async function wallet() {
    const priv = await keyHex(), m = await mods(), keys = m.wm.evmPoolKeys(m.zk, hexToBytes(priv));
    if (W && Wfor === keys.address) return W;
    const kv = { open: true, get: (k) => { try { return store.getItem(k); } catch { return null; } }, set: (k, v) => { try { store.setItem(k, v); } catch { } } };
    rpc ||= m.wm.jsonRpc(chain.rpc);
    W = m.wm.makeEvmPoolWallet({ zk: m.zk, keys, keeper: chain.keeper, store: kv, feed: true, prove,
      chain: { chainId: chain.chainId, pool: POOL, router: ROUTER, rpc, deployBlock: chain.deployBlock, confirmations: chain.confirmations, logChunk: chain.logChunk } });
    W.connect(signer);
    Wfor = keys.address;
    return W;
  }


  // The deposit: a plan is kept before anything is sent, so a closed tab finds it again; the prover starts loading at once.
  async function start({ swapWei, extraWei = 0n, token, sym, dec, to, depositWei, dest = { kind: 'address' }, gasWei = 0n, onStep = () => {} }) {
    if (!signer.address) throw new Error('Connect a wallet to deposit from.');
    if (dest.kind !== 'address') {
      if (lc(token) !== TAC) throw new Error(`Only TAC can go to a private balance from here: ${sym} is not a pool asset.`);
      to = (await tacitAccount()).acct.address;
    }
    if (lc(to) === lc(signer.address)) throw new Error('Send it to another address: the wallet that deposits would tie the two together.');
    const w = await wallet();
    warm().catch(() => {});
    const s0 = await w.sync();
    const plan = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), from: lc(signer.address), swapWei: String(swapWei), extraWei: String(extraWei),
      depositWei: String(depositWei), token: lc(token), sym, dec, to: lc(to), dest, gasWei: String(gasWei), state: 'depositing', leaves0: s0.leaves };
    keepPlans([plan, ...readPlans(store)], store);
    try {
      plan.depositTx = await w.deposit({ amount: BigInt(depositWei), onStep });
      plan.state = 'waiting'; plan.depositedAt = Date.now(); plan.leaves0 = (await w.sync()).leaves; plan.err = null;
    } catch (e) {
      // declined or refused before it was sent: nothing went; anything else may have landed, and is checked against the pool
      plan.state = /cancel|rejected|denied|nothing was sent/i.test(String(e?.message || e)) ? 'stopped' : 'unsure';
      plan.err = String(e?.message || e).slice(0, 200); throw e;
    } finally { save(plan); }
    return plan;
  }
  function save(plan) { keepPlans([plan, ...readPlans(store).filter((p) => p.id !== plan.id)], store); }
  const forget = (id) => keepPlans(readPlans(store).filter((p) => p.id !== id), store);
  // A plan left in doubt (a closed tab, an unclear answer) read against the pool: its deposit is a new note of exactly its amount; its swap out
  // spent the swap's ETH, so the balance is at least that much under what it was before.
  async function check(plan) {
    if (poolDest(plan) && (plan.state === 'shielding' || plan.state === 'held')) return plan;        // its swap is done: what is left is the making private, pressed again
    const w = await wallet(), s = await w.sync(), notes = w.notes();
    if (!plan.depositedAt) {
      // a note of exactly its amount that the pool made after the plan began: an older note of the same size is some other money
      if (notes.some((n) => BigInt(n.v) === BigInt(plan.depositWei) && Number(n.index) >= Number(plan.leaves0 || 0))) { plan.state = 'waiting'; plan.depositedAt = plan.at; plan.err = null; }
      else { plan.state = 'stopped'; plan.err = 'The deposit is not in the pool. If it was sent, it did not land.'; }
    } else if (plan.balBefore != null && s.balance + BigInt(plan.swapWei) <= BigInt(plan.balBefore)) {
      plan.state = 'done'; plan.doneAt = Date.now(); plan.err = null; delete plan.from;
    } else { plan.state = 'waiting'; plan.err = null; }
    save(plan);
    return plan;
  }

  // How the wait goes: the notes the pool has made since the deposit (each deposit, payment, change and withdrawal makes one or two) and the time since.
  async function blend(plan) {
    const s = await (await wallet()).sync();
    return { since: Math.max(0, s.leaves - Number(plan.leaves0 || 0)), mins: Math.floor((Date.now() - (plan.depositedAt || plan.at)) / 60000), balance: s.balance };
  }

  // The swap out in two presses: the route quoted now (with the stand-in) and shown, then sent only while it still pays at least what was shown.
  async function offer(plan, { slippageBps = 50 } = {}) {
    if (plan.token === ZERO) return { min: BigInt(plan.swapWei), out: BigInt(plan.swapWei), name: 'ETH itself', at: Date.now() };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_S);
    const r = lc(plan.token) === TAC
      ? await routeOutTac({ venues, amount: BigInt(plan.swapWei), to: plan.to, slippageBps, deadline })
      : await routeOut({ ethCall, token: plan.token, amount: BigInt(plan.swapWei), to: plan.to, slippageBps, deadline });
    if (!r) throw new Error(`No onchain route sells ETH for ${plan.sym} right now. Nothing was sent; try again in a while.`);
    return { ...r, at: Date.now() };
  }
  // `via: 'self'` sends it from the connected wallet, refused when that is the wallet that deposited (it would tie the two together).
  async function swapOut(plan, { shown, slippageBps = 50, via = 'relay', onStep = () => {} } = {}) {
    if (!shown) throw new Error('Read the price first.');
    if (via === 'self' && plan.from && lc(signer.address) === plan.from) throw new Error('Not from the wallet that deposited: that would tie the deposit to the swap. Connect another wallet, or let the relay send it.');
    const w = await wallet(), amount = BigInt(plan.swapWei), gas = BigInt(plan.gasWei || 0);
    const s = await w.sync();
    if (s.balance < amount + gas) throw new Error('The deposit is not in the pool yet, or was spent. Check it on the private ETH page.');
    let r = shown;
    if (plan.token !== ZERO && (Date.now() - shown.at > 60e3 || !shown.callData)) {
      onStep('reading the price again');
      r = await offer(plan, { slippageBps });
      if (r.min < shown.min) throw Object.assign(new Error(`The price moved: it now pays at least ${r.min} where ${shown.min} was shown. Nothing was sent; read it again.`), { moved: true });
    }
    plan.state = 'swapping'; plan.balBefore = String(s.balance); plan.swapAt = Date.now(); plan.err = null; save(plan);
    try {
      warm().catch(() => {});
      let h;
      if (plan.token === ZERO) h = await w.withdraw({ to: plan.to, amount, via: via === 'self' ? 'self' : null, onStep });
      else {
        const m = await mods(), refund = await w.refundBox();
        // a swap into a private balance pays the key's own account, and hands it the gas to make the TAC private from there, in the same withdrawal
        const calls = [{ target: ZROUTER, value: amount, data: r.callData }, ...(gas > 0n ? [{ target: plan.to, value: gas }] : [])];
        if (poolDest(plan)) { const { t, acct } = await tacitAccount(); plan.tacBefore = String(BigInt(await t.ethCall(TAC, '0x70a08231' + word(acct.address)) || '0x0')); }
        const intent = m.gw.callIntent({ calls, refund, deadline: r.deadline, nonce: randomNonce() });
        // the relay is paid for the gas it buys: the withdrawal and its escrow, and the route as sent from the pool (which holds the ETH), estimated
        // with the stand-in still in it, so the node never sees where the tokens go
        const multi = r.standData.startsWith('0xac9650d8');
        const routeGas = BigInt(await rpc('eth_estimateGas', [{ from: POOL, to: ZROUTER, value: '0x' + amount.toString(16), data: r.standData }]).catch(() => (multi ? '0xaae60' : '0x61a80')));
        plan.min = String(r.min); plan.route = r.name;
        h = await w.withdrawAndCall({ intent, amount: amount + gas, gas: Number(BASE_GAS + (routeGas * 3n) / 2n + (gas > 0n ? 40_000n : 0n)), via, onStep });
      }
      plan.swapTx = h; plan.proveMs = prover.ms; delete plan.from;
      if (poolDest(plan)) { plan.state = 'shielding'; plan.swapDoneAt = Date.now(); }
      else { plan.state = 'done'; plan.doneAt = Date.now(); }
      return plan;
    } catch (e) {
      plan.state = unsure(e) ? 'unsure' : 'waiting'; plan.refused = refused(e); plan.err = String(e?.message || e).slice(0, 200);
      throw e;
    } finally { save(plan); }
  }

  // After the swap: the TAC it paid the key's own account is made private from there (the pool's wrap, signed by that account with the gas the
  // swap handed it; no wallet is asked), and for a Tacit address the new note is then sent on with a stealth send. Only what this swap paid is
  // taken (what the account held before stays), rounded down to the pool's unit.
  async function shield(plan, { onStep = () => {}, waitOpts } = {}) {
    if (!poolDest(plan)) throw new Error('This swap pays an address.');
    if (!plan.swapTx) throw new Error('The swap out has not been made yet.');
    const { t, priv, acct, tk, meta } = await tacitAccount();
    if (lc(acct.address) !== lc(plan.to)) throw new Error('Another Tacit key is open than the one this swap pays. Open that one and press again.');
    const held = async () => BigInt(await t.ethCall(TAC, '0x70a08231' + word(acct.address)) || '0x0');
    const before = BigInt(plan.tacBefore || 0), least = BigInt(plan.min || 1);
    onStep('waiting for the TAC');
    let got = (await held()) - before;
    for (let i = 0; i < 30 && got < least; i++) { await sleep(4000); got = (await held()) - before; }
    if (got <= 0n) throw new Error('The TAC has not reached your Tacit account yet. Press again in a minute.');
    const scale = BigInt(meta.unitScale || 10n ** 10n), amount = got - (got % scale);
    if (amount <= 0n) throw new Error('Too little TAC to make private.');
    plan.state = 'shielding'; plan.err = null; save(plan);
    try {
      onStep('making it private');
      const w = await t.routerWrap({ walletPriv: priv, amountWei: amount.toString(), ticker: tk });
      onStep('waiting for it to be mined');
      if (w?.txHash) await t.waitReceipt(w.txHash);
      plan.shieldTx = w?.txHash || null; plan.shielded = String(amount); save(plan);
      if (plan.dest.kind === 'tacit') {
        if (!sendPrivate) throw new Error('Private now, in your balance; sending it on needs the page.');
        onStep('sending it on');
        const r = await sendPrivate({ asset: String(meta.assetId).toLowerCase(), units: amount / scale, ticker: tk, sendTo: { pubHex: plan.dest.pubHex, name: plan.dest.name || null }, label: `Send ${plan.sym} privately`, say: (k) => onStep(k === 'send' ? 'the relay is sending it on' : k === 'note' ? 'finding the note' : k), waitOpts });
        plan.sendTx = r?.sent?.txHash || null;
      }
      plan.state = 'done'; plan.doneAt = Date.now();
      return plan;
    } catch (e) {
      // wrapped already: a stop in the send-on leaves the TAC private, in the balance
      plan.state = 'held'; plan.err = String(e?.message || e).slice(0, 220); throw e;
    } finally { save(plan); }
  }

  return { start, blend, offer, swapOut, shield, check, forget, warm, plans: () => readPlans(store), get proveMs() { return prover.ms; }, get proverReady() { return prover.ready; } };
}
