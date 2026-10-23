// Bringing TAC from the holder's Bitcoin address to Ethereum: what the front page and the bridge page both do to start one. Listing the notes
// that can go, what a check of one says, the one Bitcoin transaction (or the move) that starts it, and the send to one's own address that an
// older note needs first. Every call takes the opened wallet library (`t`, tacit.js) and, where a key signs, the key itself, so neither page's
// state is read here. Pure apart from those calls, so it is tested without a page.

export const TAC_BTC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const noteId = (n) => `${n.txid}:${n.vout}`;

// ── what a check says ──────────────────────────────────────────────────────────────────────────────────────────────────────
const THROUGH = { pool: 'a pool or farm trade on Bitcoin', shielded: 'a move through Bitcoin’s shielded pool', arrived: 'TAC that came over from Ethereum' };
export const through = (s) => (THROUGH[s.through] ? `${THROUGH[s.through]}, which` : 'a transaction');
export const transfers = (n) => `${n.toLocaleString('en-US')} transfer${n === 1 ? '' : 's'}`;
export const longCount = (s) => (s.hops ? `${s.atLeast ? 'more than ' : ''}${transfers(s.hops)}` : `far more than ${transfers(s.max)}`);
export const longReason = (s) => (s.unprovable ? `Its history includes ${through(s)} the bridge does not follow.`
  : `${longCount(s).replace(/^./, (c) => c.toUpperCase())} in its history; the bridge proves up to ${s.max}.`);

// An error as the holder reads it. `errText` is the page's own way of putting any error into words; the ones a bridge raises that need more are said here.
export function bridgeError(e, errText = (x) => String(x?.message || x || '')) {
  const m = String(e?.message || e || '');
  if (/another tab/i.test(m)) return 'This bridge is being moved on in another tab. Wait for it there, or close that tab and try again.';
  if (/held for your other bridges/i.test(m)) return 'This key’s free bitcoin is held for your other bridges’ burns. This one can go once one of them is sent (its change comes back), or add a little bitcoin to go now: your TAC waits where it is.';
  if (/funding utxo too small|no safe funding utxo|insufficient funds for/i.test(m)) return 'This key’s Bitcoin address has no free bitcoin to pay this step’s fee. Add a little bitcoin to it, then try again: your TAC waits where it is.';
  const s = m.replace(/^burndep-ux:\s*/, '');
  return errText(s === m ? e : new Error(s.charAt(0).toUpperCase() + s.slice(1)));
}

// What one step of a note's check (preflight's `steps`) says when it is the one that failed.
export function checkText(s, errText) {
  const err = (x) => bridgeError(x, errText);
  if (s.name === 'not-tracked') return 'This TAC arrived recently: Bitcoin’s proof on Ethereum has not reached its block yet. Try again in a few hours.';
  if (s.name === 'reflected') return 'This TAC was received privately. One Bitcoin transaction sends it to your own address, and then it can be bridged.';
  if (s.name === 'old-leaf') return 'This TAC is held in an older note form that the bridge cannot burn directly. One Bitcoin transaction sends it to your own address in the current form, and then it can be bridged.';
  if (s.name === 'bound') return 'This TAC is held in a note bound to another deployment, which the bridge does not burn.';
  if (s.name === 'source-ownership') return 'This TAC is not at this key’s own Bitcoin address.';
  if (s.name === 'source-confirmed') return 'This TAC is waiting for its Bitcoin confirmation.';
  if (s.name === 'trace' && s.tooLong) return `This TAC has ${longCount(s)} in its history, and the bridge proves up to ${s.max}, so this note stays on Bitcoin, where it can be sent and traded as usual.`;
  if (s.name === 'trace' && s.unprovable) return `This TAC’s history includes ${through(s)} the bridge’s proof does not follow${!THROUGH[s.through] && s.at ? ` (${s.at.slice(0, 8)}…${s.at.slice(-6)})` : ''}, so this note stays on Bitcoin, where it can be sent and traded as usual.`;
  if (s.name === 'trace' && s.reading) return `Reading this TAC’s history from Bitcoin: ${transfers(Number(s.read) || 0)} so far. Pick it again in a few minutes and the reading goes on from there.`;
  if (s.name === 'trace') {
    const wait = /retry in ~(\d+)s/.exec(s.detail || '');
    return wait ? `Bitcoin’s history for this TAC is still being read. Pick it again in about ${wait[1]} seconds.`
      : `This TAC’s history could not be read from Bitcoin just now (${err(s.detail)}). Pick it again in a moment.`;
  }
  return `Could not check this TAC: ${err(s.detail || s.name)}`;
}

// ── the notes ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A note in an older form, or received privately, goes to the holder's own address once before it can be bridged.
export const needsSend = (n) => n.form === 'old' || n.form === 'private';
export const firstStep = (n) => (n.form === 'old' ? 'Older note form: pick it to send it to your own address once, then bridge it.'
  : n.form === 'private' ? 'Received privately: pick it to send it to your own address once, then bridge it.' : '');
export const overCap = (n) => !n.eligible && /beta limit/.test(n.reason || '');
// A note whose check said its history is too long for the bridge to prove (`deep`: note id → the step that said so), or that holds no TAC, is not offered.
export const marked = (n, deep = new Map()) => (n.eligible && deep.has(noteId(n)) ? { ...n, eligible: false, reason: longReason(deep.get(noteId(n))) }
  : n.eligible && BigInt(n.amount) === 0n ? { ...n, eligible: false, reason: 'Holds no TAC' } : n);

// The TAC at the holder's Bitcoin address, each with whether it can be bridged and why not: the notes that can go first, the larger first among them.
// `esplora(path)` reads Bitcoin's explorer; a note whose confirmation it cannot read is listed as unconfirmed.
export async function listNotes(t, { force = false, esplora, assetId = TAC_BTC_ID } = {}) {
  const h = await t.scanHoldings(force);
  const tac = h instanceof Map ? [...h.entries()].find(([id, x]) => String(x.assetIdHex || id).toLowerCase() === assetId)?.[1] : null;
  const notes = await Promise.all((tac?.utxos || []).map(async (u) => {
    const st = u.utxo.status?.confirmed ? u.utxo.status : await esplora(`/tx/${u.utxo.txid}/status`).catch(() => null);
    return { txid: u.utxo.txid, vout: u.utxo.vout, sats: u.utxo.value, assetId, amount: u.amount, blinding: u.blinding,
      confirmed: !!st?.confirmed, height: st?.block_height,
      stealth: !!u.stealthTweakedSk, stealthTweakedSk: u.stealthTweakedSk || null };
  }));
  const ux = t.bridgeUx();
  const forms = await ux.noteForms(notes).catch(() => null);
  if (forms) for (const n of notes) n.form = forms.get(noteId(n)) ?? null;
  const tracks = await ux.noteTracking(notes).catch(() => null);
  if (tracks) for (const n of notes) n.tracking = tracks.get(noteId(n)) ?? null;
  return ux.eligibleNotes(notes).sort((a, b) => (b.eligible - a.eligible) || (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0));
}

// ── what it costs ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// The check of a note (preflight) and the cost of its path against the coins the key has free for fees. `short`: coins were read and fall short.
export async function review(t, { note, walletPub, onProgress = null, coins: known }) {
  const ux = t.bridgeUx(), pf = await ux.preflight({ note, walletPub, onProgress });
  if (!pf.ok) return { note, pf, ok: false };
  const coins = known !== undefined ? known : await freeCoins(t);
  const one = pf.path === 'reflected', rate = one ? pf.burnFeeRate : pf.migrateFeeRate;
  const cost = ux.bridgeCost({ path: pf.path, feeRate: rate, coins: coins || [], noteSats: note.sats, burnRate: pf.burnRate });
  return { note, pf, cost, one, ok: true, short: !!coins && !cost.ok };
}
export const freeCoins = (t) => Promise.resolve().then(async () => t.pickSafeCommitSats(await t.getUtxos(t.wallet.address()))).catch(() => null);

// ── starting it ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Signs and sends the burn (one Bitcoin transaction, when the note is tracked) or the move to the burn address (when it is not), and goes on with it a step.
// `recipient`: pay the minted TAC to someone else's address. Returns the bridge's record.
export async function begin(t, { review: r, priv, recipient = null }) {
  const ux = t.bridgeUx();
  let made;
  if (r.pf.path === 'reflected') made = await ux.startReflected({ note: r.note, walletPriv: priv, feeRate: r.pf.burnFeeRate, ...(recipient ? { recipient } : {}) });
  else {
    const safe = await t.pickSafeCommitSats(await t.getUtxos(t.wallet.address())), u = ux.pickFunding(safe, Math.ceil(r.cost.need * 1.1));
    if (!u) throw new Error('This key’s Bitcoin address has no sats free to pay the fee. Add some, then try again.');
    made = await ux.start({ note: r.note, walletPriv: priv, fundingUtxo: { txid: u.txid, vout: u.vout, value: u.value }, feeRate: r.pf.migrateFeeRate });
  }
  let after;
  try { after = await ux.advance(made.walletPub, made.id); } catch { after = ux.list(made.walletPub).find((x) => x.id === made.id) || made; }
  if (r.pf.path === 'reflected') ux.armMint(made.walletPub, made.id, { walletPriv: priv }).catch(() => {});
  return after;
}

// Notes sent whole (or `amount` of one, the rest coming back) to this key's own address in one Bitcoin transaction: several make one note (a merge),
// and the new note is what gets bridged. `label` names the kind of note in what is said when one is gone.
export async function toSelf(t, assetId, ns, amount = null, label = 'note') {
  const h = await t.scanHoldings(true), have = h.get(assetId)?.utxos || [];
  const us = ns.map((n) => have.find((x) => x.utxo.txid === n.txid && x.utxo.vout === n.vout));
  if (us.some((u) => !u)) throw new Error(`That ${label} is no longer at this address. Refresh, then try again.`);
  const v = amount ?? us.reduce((x, u) => x + BigInt(u.amount), 0n);
  const r = await t.buildAndBroadcastCXfer({ assetIdHex: assetId, amount: v, recipientPubHex: [...t.wallet.pub].map((b) => b.toString(16).padStart(2, '0')).join(''), forceUtxos: us });
  try { t.invalidateHoldingsCache?.(); } catch { /* the next read is fresh enough */ }
  return { txid: r.revealTxid, amount: v };
}
