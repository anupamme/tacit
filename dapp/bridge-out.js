// Starting a bridge to Bitcoin, the same on every page that starts one: the assets it takes, what the relay charges, the limits a bridge keeps
// to, the fee ladder for a relay whose floor moved, and the words for a proof that is behind. The page brings the pool module and the chains;
// nothing here draws or sends.
const TAC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', TETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
// `pool` is the ticker the pool module quotes it under; `floor`: the relay publishes a floor for it that can sit above its own quote; `min`: the
// least one bridge takes when the engine names none.
export const OUT_ASSETS = {
  tac: { key: 'tac', ticker: 'TAC', pool: 'cTAC', id: '0x' + TAC_ID, dp: 4, floor: true, min: 2_000_000_000n },
  teth: { key: 'teth', ticker: 'tETH', pool: 'cETH', id: '0x' + TETH_ID, dp: 6, floor: false, min: 0n },
};

// A fee rounded up to its first two digits: the next rung when the relay's floor has moved.
export const ladder = (v) => { const x = BigInt(v), d = x.toString().length; if (d <= 2) return x; const s = 10n ** BigInt(d - 2); return ((x + s - 1n) / s) * s; };
// the relay turned the fee down for being under its floor
export const feeShort = (e) => /fee below the current floor|feeGate|below the marginal cost/i.test(String(e?.message || e || ''));

// The relay's fee for burning `a`: its own quote, or the floor it publishes when that is higher (kept for five minutes).
export function makeOutFee({ api, fetchImpl = (...a) => fetch(...a) }) {
  const floors = {};
  return async function outFee(t, a) {
    const own = BigInt(await t.quoteOpFee(a.pool, 'bridgeburn'));
    if (!a.floor) return own;
    if (!floors[a.key] || Date.now() - floors[a.key].at > 300e3) {
      const entry = floors[a.key] = { at: Date.now(), v: fetchImpl(`${api}/confidential/quote?asset=${a.pool}`, { signal: AbortSignal.timeout(10e3) }).then((r) => (r.ok ? r.json() : null))
        .then((j) => (/^\d+$/.test(String(j?.staticFloorUnits)) ? BigInt(j.staticFloorUnits) : 0n), () => 0n) };
      entry.v.then((v) => { if (!v && floors[a.key] === entry) delete floors[a.key]; });
    }
    const published = await floors[a.key].v;
    return published > own ? published : own;
  };
}

// What stops an amount from being bridged, in words, or null: under the least, over what one bridge takes, or no more than the fee.
// `fmt(v)` writes an amount of the asset.
export function limitText({ units, fee, min, cap, ticker, fmt }) {
  if (units < min) return `Bridge at least ${fmt(min)} ${ticker}: below that the fees take too much of it.`;
  if (units > cap) return `One bridge takes at most ${fmt(cap)} ${ticker} while this is new. Bridge less, then again.`;
  if (units <= fee) return `Bridge more than ${fmt(fee, 6)} ${ticker}: the relay fee comes out of it.`;
  return null;
}

// a proof that is behind makes the bridge slower, not unsafe
export const proofWarn = (w, lag) => (w.name === 'reflection-behind' ? `Bitcoin’s proof on Ethereum is ${w.detail} behind (about ${Math.max(1, Math.round(lag / 6))} hours), so this will take longer than usual. Nothing is lost by waiting.`
  : w.name === 'coverage-behind' ? 'The proof’s view of Ethereum is further behind than usual, so this will take longer than usual. Nothing is lost by waiting.' : '');
export const proofProblem = 'Bitcoin’s proof on Ethereum could not be read, so nothing was started. Try again in a minute.';

// The Bitcoin step is paid from the key's own Bitcoin address, hours after the burn: what that address holds against it, in words.
// `fmtBtc(sats)` writes an amount of bitcoin.
export function fundingText(pf, fmtBtc) {
  const k = pf.pending || 0, coin = pf.haveSats ? `${fmtBtc(pf.haveSats)} BTC` : null, need = `${pf.needSats.toLocaleString('en-US')} sats`;
  if (!k) return coin ? `The largest free coin on this key’s Bitcoin address holds ${coin}; the Bitcoin step, a few hours from now, needs one coin of ${need}, kept there until the bridge arrives.`
    : `This key’s Bitcoin address has no free coin yet; the Bitcoin step, a few hours from now, needs one coin of ${need}, kept there until the bridge arrives.`;
  return `${k === 1 ? 'A bridge under way takes a coin' : `${k} bridges under way take a coin each`} from this key’s Bitcoin address for ${k === 1 ? 'its' : 'their'} Bitcoin step. `
    + (coin ? `The next free coin holds ${coin}; this one needs a coin of ${need}, kept there until it arrives.` : `No other coin is free; this one needs a coin of ${need}, kept there until it arrives.`);
}
