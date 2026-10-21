// One Tacit key's account in the first-generation association-set pool, as a workflow the page drives: load what the
// chain and the approval service say, deposit, take an approved deposit into a Tacit receive address through a relayer,
// and exit a deposit publicly. No DOM; the page supplies how to send a transaction and where the proofs are made.
//
//   prover  { withdraw(args), exit(args) }                 assoc-pool-prove-worker.js behind a promise
//   sender  { key(tx), wallet?(tx), walletAddress?() }     tx = { to, data, value? } → the mined receipt; throws on a revert
//   net     makeAssocNet(...)                              the lists, events and relayer
//
// Everything a note needs is derived from the key, so a session on a new device finds the same deposits.

import { ETH_POOL, TOPIC } from './assoc-pool.js';
import { MAX_RELAY_BPS } from './assoc-pool-net.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MIN_DEPOSIT = 10n ** 16n;          // the entrypoint's minimum for ETH
export const RELAY_GAS = 650_000n;              // what the relayer prices a relay at

export function makeAssocSession({ pool, net, rpc, tacitPriv, prover, sender, target = ETH_POOL, keccak256 }) {
  const key = pool.poolKey(tacitPriv);
  let keysP = null;
  const keys = () => (keysP ||= pool.phraseOf(key.priv).then((p) => pool.masterKeys(p)));
  const phrase = () => pool.phraseOf(key.priv);
  let state = { deposits: [], withdrawals: [], ragequits: [], found: [], reviews: new Map(), at: 0 };

  const statusOf = (a, review) => {
    if (a.ragequit) return 'exited';
    if (a.foreign) return 'foreign';
    if (a.last.value === 0n) return 'emptied';
    if (a.stale) return 'unreadable';
    if (review === 'approved') return 'approved';
    if (review === 'declined' || review === 'rejected') return 'declined';
    return 'reviewing';
  };
  const present = () => state.found.map((a) => ({
    index: a.index, label: a.label, acct: a, deposited: a.deposit.value, balance: a.last.value, children: a.children.length,
    block: a.deposit.block, tx: a.deposit.tx, depositor: a.deposit.depositor, ragequit: a.ragequit,
    status: statusOf(a, state.reviews.get(a.label)), review: state.reviews.get(a.label) || null,
  }));

  async function rescan() {
    const k = await keys();
    state.found = pool.scan({ keys: k, scope: target.scope, deposits: state.deposits, withdrawals: state.withdrawals, ragequits: state.ragequits });
  }

  // Read the account's events and the review status of every deposit that still holds value. `full` searches every
  // deposit of the pool (for deposits made from other wallets with this account's phrase) and must find all of them.
  async function load({ full = false } = {}) {
    const k = await keys();
    let deposits, withdrawals, ragequits;
    if (full) {
      const all = await net.allDeposits();
      if (!all.complete) throw new Error(`the explorer returned ${all.events.length} of the pool's ${all.expected} deposits: try again`);
      const mine = pool.scan({ keys: k, scope: target.scope, deposits: all.events });
      deposits = all.events.filter((d) => mine.some((m) => m.label === BigInt(d.label)));
      const from = deposits.length ? Math.min(...deposits.map((d) => d.block)) : null;
      withdrawals = from == null ? [] : await net.withdrawals({ from });
      ragequits = deposits.length ? await net.ragequits({ ragequitter: undefined, from: Math.min(...deposits.map((d) => d.block)) }) : [];
    } else {
      ({ deposits, withdrawals, ragequits } = await net.historyOf(key.address));
    }
    state = { ...state, deposits, withdrawals, ragequits };
    await rescan();
    // A note the pool has marked spent, though no event we read spends it, means an event was missed: say so instead of
    // offering it, and read the withdrawals since its deposit again from the first block.
    for (const a of state.found.filter((x) => !x.ragequit && !x.foreign && x.last.value > 0n)) {
      if (!(await net.spent(pool.nullifierHashOf(a.last.nullifier)))) continue;
      const all = await net.allWithdrawals({ from: a.deposit.block }).catch(() => null);
      if (all) { state.withdrawals = [...new Map([...state.withdrawals, ...all.events].map((w) => [`${w.tx}:${w.logIndex}`, w])).values()]; await rescan(); }
    }
    for (const a of state.found) a.stale = !a.ragequit && !a.foreign && a.last.value > 0n && await net.spent(pool.nullifierHashOf(a.last.nullifier));
    const labels = state.found.filter((a) => !a.ragequit && !a.foreign && a.last.value > 0n).map((a) => a.label);
    state.reviews = labels.length ? await net.reviews(labels).catch(() => new Map()) : new Map();
    state.at = Date.now();
    return present();
  }

  const receiptOf = async (hash) => { for (let i = 0; i < 240; i++) { const r = await rpc('eth_getTransactionReceipt', [hash]); if (r) return r; await sleep(2500); } throw new Error('the transaction is not mined yet: check the explorer'); };
  const poolLogs = (rc) => (rc.logs || []).filter((l) => l.address.toLowerCase() === target.pool.toLowerCase());
  const words = (data) => { const h = data.replace(/^0x/, ''); return Array.from({ length: h.length / 64 }, (_, i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64))); };
  const dupSelector = () => '0x' + Array.from(keccak256(new TextEncoder().encode('PrecommitmentAlreadyUsed()')).slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');

  // Deposit `amount` wei from the pool key (`from: 'key'`) or the connected wallet. The next unused index is taken, and a
  // precommitment the entrypoint already holds (a deposit made elsewhere with this account) moves it on.
  async function deposit({ amount, from = 'key' }) {
    const wei = BigInt(amount);
    if (wei < MIN_DEPOSIT) throw new Error('The pool takes at least 0.01 ETH.');
    const k = await keys();
    if (!state.at) await load();
    let index = pool.nextIndex(state.found);
    for (let attempt = 0; ; attempt++) {
      const s = pool.depositSecrets(k, target.scope, index), pre = pool.precommitmentOf(s.nullifier, s.secret);
      const tx = { to: target.entrypoint, data: pool.depositCalldata(pre), value: wei };
      // A refused deposit costs nothing to learn about first.
      try { await rpc('eth_call', [{ from: from === 'key' ? key.address : await sender.walletAddress(), to: tx.to, data: tx.data, value: '0x' + wei.toString(16) }, 'latest']); }
      catch (e) { if (String(e?.message || e).toLowerCase().includes(dupSelector()) || /PrecommitmentAlreadyUsed/i.test(String(e?.message || e))) { if (attempt < 5) { index += 1n; continue; } } throw e; }
      const rc = await (from === 'wallet' ? sender.wallet(tx) : sender.key(tx));
      if (rc.status !== '0x1' && rc.status !== 1) throw new Error('the deposit was refused');
      const log = poolLogs(rc).find((l) => l.topics[0] === TOPIC.deposited);
      if (!log) throw new Error('the deposit did not emit its event');
      const w = words(log.data);
      const ev = { depositor: '0x' + log.topics[1].slice(26), commitment: w[0], label: w[1], value: w[2], precommitment: w[3], block: Number(BigInt(log.blockNumber)), logIndex: Number(BigInt(log.logIndex || 0)), tx: rc.transactionHash };
      if (ev.precommitment !== pre || ev.commitment !== pool.commitmentOf(ev.value, ev.label, pre)) throw new Error('the pool recorded a different deposit than the one made');
      state.deposits = [...state.deposits, ev];
      await rescan();
      return { index, tx: rc.transactionHash, value: ev.value, label: ev.label };
    }
  }

  // What taking `amount` out through a relayer costs now, or why it cannot be relayed.
  async function quote(amount) {
    const wei = BigInt(amount);
    const r = await net.pickRelayer(wei);
    const fee = r.bps == null ? null : (wei * r.bps) / 10000n;
    return { ...r, feeWei: fee, receive: fee == null ? null : wei - fee, relayable: r.bps != null, minWei: minRelayable(r) };
  }
  // The least amount whose relay fee stays within the cap: gas × price over (cap − base − margin).
  function minRelayable(r) {
    const gas = r.gasPrice * RELAY_GAS, room = BigInt(MAX_RELAY_BPS) - 12n;
    return room > 0n ? (gas * 10000n) / room : null;
  }

  // Take `amount` of an approved note to `recipient` (a Tacit receive address) through a relayer. onStep(name) reports
  // 'lists' → 'proving' → 'sending' → 'waiting'.
  async function withdraw({ note, amount, recipient, onStep = () => {} }) {
    const wei = BigInt(amount), k = await keys(), acct = state.found.find((a) => a.label === note.label);
    if (!acct) throw new Error('that deposit is not in this account');
    if (acct.ragequit) throw new Error('that deposit was exited publicly');
    for (let round = 0; ; round++) {
      onStep('lists');
      const [lists, r] = await Promise.all([net.leaves(), net.pickRelayer(wei)]);
      if (r.bps == null) throw new Error('That amount is too small to relay at today’s gas.');
      if (!lists.aspLeaves.includes(acct.label)) throw new Error('This deposit is approved but not on the posted list yet. Try again in a few minutes.');
      onStep('proving');
      const out = await prover.withdraw({ keys: k, acct, amount: wei, recipient, feeRecipient: r.feeReceiver, feeBps: Number(r.bps), stateLeaves: lists.stateLeaves, aspLeaves: lists.aspLeaves, scope: target.scope, entrypoint: target.entrypoint });
      const head = await net.head();
      const [, , , stateRoot, , aspRoot] = out.plan.expect;
      if (aspRoot !== head.aspRoot || !(await net.stateRootKnown(stateRoot))) {
        if (round >= 2) throw new Error('The pool keeps moving. Try again.');
        continue;
      }
      onStep('sending');
      const sent = await r.relayer.request({ withdrawal: out.plan.withdrawal, proof: { ...out.proof, protocol: 'groth16', curve: 'bn128' }, publicSignals: out.publicSignals, scope: target.scope });
      const hash = sent.txHash || sent.hash;
      if (!hash) throw new Error('the relayer did not return a transaction');
      onStep('waiting');
      const rc = await receiptOf(hash);
      if (rc.status !== '0x1' && rc.status !== 1) throw new Error('the withdrawal was refused on chain');
      const ev = { processooor: target.entrypoint, value: wei, spentNullifier: out.plan.expect[1], newCommitment: out.plan.expect[0], block: Number(BigInt(rc.blockNumber)), logIndex: 0, tx: hash };
      state.withdrawals = [...state.withdrawals, ev];
      await rescan();
      const fee = (wei * r.bps) / 10000n;
      return { tx: hash, received: wei - fee, fee, remaining: out.plan.remaining };
    }
  }

  // Exit a deposit publicly, back to the address that made it (the one thing the pool always allows). The pool key
  // signs it when it made the deposit; a deposit made from the connected wallet needs that wallet.
  async function exit({ note, onStep = () => {} }) {
    const acct = state.found.find((a) => a.label === note.label);
    if (!acct) throw new Error('that deposit is not in this account');
    if (acct.ragequit || acct.last.value === 0n) throw new Error('nothing to exit');
    const byKey = acct.deposit.depositor.toLowerCase() === key.address.toLowerCase();
    if (!byKey && !(sender.walletAddress && (await sender.walletAddress())?.toLowerCase() === acct.deposit.depositor.toLowerCase())) throw new Error('Only the address that made this deposit can exit it. Connect that wallet.');
    onStep('proving');
    const out = await prover.exit({ acct });
    onStep('sending');
    const tx = { to: target.pool, data: pool.ragequitCalldata(pool.proofArgs(out.proof, out.publicSignals)) };
    const rc = await (byKey ? sender.key(tx) : sender.wallet(tx));
    if (rc.status !== '0x1' && rc.status !== 1) throw new Error('the exit was refused on chain');
    const log = poolLogs(rc).find((l) => l.topics[0] === TOPIC.ragequit);
    const w = log ? words(log.data) : [acct.last.commitment, acct.label, acct.last.value];
    state.ragequits = [...state.ragequits, { ragequitter: acct.deposit.depositor, commitment: w[0], label: w[1], value: w[2], block: Number(BigInt(rc.blockNumber)), tx: rc.transactionHash }];
    await rescan();
    return { tx: rc.transactionHash, value: acct.last.value };
  }

  return { key, phrase, load, deposit, quote, withdraw, exit, notes: present, minRelayable };
}
