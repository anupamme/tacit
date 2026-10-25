// Wraps proved ahead of time, kept in this browser until they are sent. A wrap's proof binds only the asset, the amount and the
// note commitment (no root, no deadline, no price), so one proved now deposits and settles in one router transaction whenever it
// is sent: a wrap whose amount the vouchers on hand make up goes out with no proving wait at all. A voucher holds nothing secret
// (its note is the key's, at an index the wrap index hint already moved past, and its memo opens it), so losing one loses only
// the proving time; sent by anyone, it can only fund the key's own note.
//
// A voucher: { ticker, amount (base units, decimal string), index, commit, depositId, assetId, at, status: 'proving' | 'ready',
// job? (the proving job, to pick up after a reload), publicValues?, proof?, memos? }.

const KEY = 'tacit-wrap-vouchers-v1:';

export function makeVouchers({ storage = globalThis.localStorage } = {}) {
  const read = (pub) => { try { return JSON.parse(storage.getItem(KEY + pub) || '[]') || []; } catch { return []; } };
  const write = (pub, list) => { try { storage.setItem(KEY + pub, JSON.stringify(list)); } catch { /* a convenience, not state */ } };
  const list = (pub, ticker = null, status = null) => read(pub).filter((v) => (!ticker || v.ticker === ticker) && (!status || v.status === status));

  // The ready vouchers that add up to exactly `amount`, fewest first; null when none do. A handful at most, so it is searched whole.
  function pick(pub, ticker, amount) {
    const want = BigInt(amount), ready = list(pub, ticker, 'ready').sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1)).slice(0, 16);
    let best = null;
    const walk = (i, left, taken) => {
      if (left === 0n) { if (!best || taken.length < best.length) best = taken.slice(); return; }
      if (i >= ready.length || left < 0n || (best && taken.length >= best.length - 1)) return;
      const v = BigInt(ready[i].amount);
      if (v <= left) { taken.push(ready[i]); walk(i + 1, left - v, taken); taken.pop(); }
      walk(i + 1, left, taken);
    };
    walk(0, want, []);
    return best;
  }

  return {
    list,
    pick,
    put(pub, v) { write(pub, [...read(pub).filter((x) => x.depositId !== v.depositId), v]); },
    // A wrap proved and then not sent, kept as a ready voucher: { built, proven } as the pool module's proveWrap returns them.
    keep(pub, ticker, { built, proven }) {
      this.put(pub, { ticker, amount: String(built.amount), index: built.index, commit: built.commit, depositId: built.depositId,
        assetId: built.wrapArgs.assetId, at: Date.now(), status: 'ready', publicValues: proven.publicValues, proof: proven.proof, memos: proven.memos });
    },
    drop(pub, depositId) { write(pub, read(pub).filter((x) => x.depositId !== depositId)); },
    // The proof a voucher carries, as the pool module's wrapSettleCall takes a built wrap and its proof.
    call(v) {
      return {
        built: { amount: v.amount, commit: v.commit, depositId: v.depositId, index: v.index, wrapArgs: { assetId: v.assetId } },
        proven: { publicValues: v.publicValues, proof: v.proof, memos: v.memos },
      };
    },
  };
}
