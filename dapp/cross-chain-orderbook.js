
import { makeAdaptorSwap } from './adaptor-swap.js';
import { signSchnorr, verifySchnorr } from './bulletproofs.js';
import { sha256, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';

const _big = (x) => (typeof x === 'bigint' ? x : BigInt(x));
const lc = (h) => String(h == null ? '' : h).toLowerCase().replace(/^0x/, '');
const hx = (b) => '0x' + bytesToHex(b);
const gcd = (a, b) => {
  let x = _big(a), y = _big(b);
  while (y !== 0n) { const t = x % y; x = y; y = t; }
  return x < 0n ? -x : x;
};
const enc = new TextEncoder();
const DOMAIN_OFFER = enc.encode('tacit-cross-chain-order-v1');
const DOMAIN_CANCEL = enc.encode('tacit-cross-chain-order-cancel-v1');
const ZERO32 = '0x' + '00'.repeat(32);
const MAX_U64 = (1n << 64n) - 1n;

function b32(x, name) {
  const h = String(x || '').replace(/^0x/, '');
  if (h.length !== 64) throw new Error(`orderbook: ${name} must be bytes32`);
  return hexToBytes(h);
}
function pub33(x) {
  const h = String(x || '').replace(/^0x/, '');
  if (h.length !== 66) throw new Error('orderbook: makerPubkey must be compressed secp pubkey');
  const b = hexToBytes(h);
  if (b[0] !== 2 && b[0] !== 3) throw new Error('orderbook: makerPubkey must be compressed secp pubkey');
  return b;
}
function sig64(x) {
  const h = String(x || '').replace(/^0x/, '');
  if (h.length !== 128) throw new Error('orderbook: signature must be 64 bytes');
  return hexToBytes(h);
}
function u64(n, name) {
  const v = _big(n);
  if (v < 0n || v > MAX_U64) throw new Error(`orderbook: ${name} out of u64 range`);
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 7; i >= 0; --i) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}
function laneByte(lane) {
  if (lane === 'bitcoin') return 0;
  if (lane === 'ethereum') return 1;
  throw new Error('orderbook: bad lane');
}

export function buildOrderOfferMsg({
  chainBinding = ZERO32, bookId = ZERO32, makerPubkey,
  giveAsset, giveAmount, giveLane, wantAsset, wantAmount, wantLane,
  expiry = 0, minFill = 1, nonce, makerInput = ZERO32,
}) {
  if (giveLane === wantLane) throw new Error('orderbook: signed offer needs distinct lanes');
  const give = _big(giveAmount), want = _big(wantAmount), min = _big(minFill);
  if (give <= 0n || want <= 0n || min <= 0n) throw new Error('orderbook: signed offer amounts must be positive');
  if (min > give) throw new Error('orderbook: minFill exceeds giveAmount');
  return sha256(concatBytes(
    DOMAIN_OFFER,
    b32(chainBinding, 'chainBinding'),
    b32(bookId, 'bookId'),
    pub33(makerPubkey),
    b32(giveAsset, 'giveAsset'),
    u64(give, 'giveAmount'),
    new Uint8Array([laneByte(giveLane)]),
    b32(wantAsset, 'wantAsset'),
    u64(want, 'wantAmount'),
    new Uint8Array([laneByte(wantLane)]),
    u64(expiry || 0, 'expiry'),
    u64(min, 'minFill'),
    b32(nonce, 'nonce'),
    b32(makerInput, 'makerInput'),
  ));
}

export const orderOfferId = (offer) => hx(buildOrderOfferMsg(offer));
export function signOrderOffer(offer, makerPrivkey32) {
  return hx(signSchnorr(buildOrderOfferMsg(offer), makerPrivkey32 instanceof Uint8Array ? makerPrivkey32 : hexToBytes(String(makerPrivkey32).replace(/^0x/, ''))));
}
export function verifyOrderOffer(offer) {
  try { return verifySchnorr(sig64(offer.signature), buildOrderOfferMsg(offer), pub33(offer.makerPubkey).subarray(1)); }
  catch { return false; }
}

export function buildOrderCancelMsg({ chainBinding = ZERO32, bookId = ZERO32, offerId }) {
  return sha256(concatBytes(DOMAIN_CANCEL, b32(chainBinding, 'chainBinding'), b32(bookId, 'bookId'), b32(offerId, 'offerId')));
}
export function signOrderCancel(cancel, makerPrivkey32) {
  return hx(signSchnorr(buildOrderCancelMsg(cancel), makerPrivkey32 instanceof Uint8Array ? makerPrivkey32 : hexToBytes(String(makerPrivkey32).replace(/^0x/, ''))));
}
export function verifyOrderCancel({ chainBinding = ZERO32, bookId = ZERO32, offerId, makerPubkey, signature }) {
  try { return verifySchnorr(sig64(signature), buildOrderCancelMsg({ chainBinding, bookId, offerId }), pub33(makerPubkey).subarray(1)); }
  catch { return false; }
}

export function makeCrossChainOrderbook({ swap = makeAdaptorSwap(), resolver = null, chainBinding = ZERO32, bookId = ZERO32, requireSigned = false } = {}) {
  const offers = new Map();
  let seq = 0;

  function post(o) {
    const give = _big(o.giveAmount), want = _big(o.wantAmount);
    if (give <= 0n || want <= 0n) throw new Error('orderbook: amounts must be positive');
    if (o.giveLane === o.wantLane) throw new Error('orderbook: cross-chain offer needs distinct lanes');
    if (resolver) {
      for (const [asset, lane] of [[o.giveAsset, o.giveLane], [o.wantAsset, o.wantLane]]) {
        const d = resolver.resolve(asset);
        if (!d || !d.lanes.includes(lane)) throw new Error(`orderbook: ${lc(asset)} not recognized on lane ${lane}`);
      }
    }
    const id = `xo-${++seq}`;
    offers.set(id, {
      id, maker: o.maker,
      giveAsset: lc(o.giveAsset), giveAmount: give, giveLane: o.giveLane,
      wantAsset: lc(o.wantAsset), wantAmount: want, wantLane: o.wantLane,
      expiry: o.expiry ?? null, remaining: give, status: 'open',
    });
    return id;
  }

  function postSigned(o) {
    const offer = { ...o, chainBinding: o.chainBinding || chainBinding, bookId: o.bookId || bookId };
    if (lc(offer.chainBinding) !== lc(chainBinding) || lc(offer.bookId) !== lc(bookId)) {
      throw new Error('orderbook: offer replay scope mismatch');
    }
    if (!verifyOrderOffer(offer)) throw new Error('orderbook: invalid offer signature');
    const id = orderOfferId(offer);
    if (offers.has(lc(id))) throw new Error('orderbook: duplicate offer');
    const give = _big(offer.giveAmount), want = _big(offer.wantAmount);
    if (resolver) {
      for (const [asset, lane] of [[offer.giveAsset, offer.giveLane], [offer.wantAsset, offer.wantLane]]) {
        const d = resolver.resolve(asset);
        if (!d || !d.lanes.includes(lane)) throw new Error(`orderbook: ${lc(asset)} not recognized on lane ${lane}`);
      }
    }
    const rec = {
      id: lc(id),
      maker: lc(offer.makerPubkey),
      makerPubkey: lc(offer.makerPubkey),
      giveAsset: lc(offer.giveAsset), giveAmount: give, giveLane: offer.giveLane,
      wantAsset: lc(offer.wantAsset), wantAmount: want, wantLane: offer.wantLane,
      expiry: Number(offer.expiry || 0) || null,
      minFill: _big(offer.minFill || 1),
      nonce: lc(offer.nonce),
      makerInput: lc(offer.makerInput || ZERO32),
      signature: lc(offer.signature),
      chainBinding: lc(offer.chainBinding),
      bookId: lc(offer.bookId),
      remaining: give,
      status: 'open',
      signed: true,
    };
    offers.set(rec.id, rec);
    return rec.id;
  }

  const _live = (o, nowTs) => o.status === 'open' && o.remaining > 0n && (o.expiry == null || nowTs < o.expiry);
  function book(nowTs = Infinity) { return [...offers.values()].filter((o) => _live(o, nowTs)); }
  function get(id) { return offers.get(lc(id)) || null; }

  function quote({ giveAsset, wantAsset, nowTs = Infinity }) {
    const g = lc(giveAsset), w = lc(wantAsset);
    return book(nowTs)
      .filter((o) => o.giveAsset === w && o.wantAsset === g)
      .map((o) => ({ offer: o, takerReceivesPerPaid: { num: o.giveAmount, den: o.wantAmount }, fillableReceive: o.remaining }))
      .sort((a, b) => {
        const l = a.takerReceivesPerPaid, r = b.takerReceivesPerPaid;
        const d = r.num * l.den - l.num * r.den;
        return d > 0n ? 1 : d < 0n ? -1 : 0;
      });
  }

  function quoteExactIn({ giveAsset, wantAsset, amountIn, giveLane = null, wantLane = null, nowTs = Infinity, requireFullFill = true }) {
    let remainingIn = _big(amountIn);
    if (remainingIn <= 0n) throw new Error('orderbook: amountIn must be positive');
    const fills = [];
    let totalOut = 0n;
    const candidates = quote({ giveAsset, wantAsset, nowTs })
      .filter((q) => (giveLane == null || q.offer.wantLane === giveLane) && (wantLane == null || q.offer.giveLane === wantLane));

    for (const q of candidates) {
      if (remainingIn === 0n) break;
      const o = q.offer;
      const maxPay = (o.remaining * o.wantAmount) / o.giveAmount;
      if (maxPay <= 0n) continue;
      const pay = remainingIn < maxPay ? remainingIn : maxPay;
      const maxReceive = (pay * o.giveAmount) / o.wantAmount;
      const receiveStep = o.giveAmount / gcd(o.giveAmount, o.wantAmount);
      const receive = (maxReceive / receiveStep) * receiveStep;
      if (receive <= 0n) continue;
      if (o.minFill != null && receive < o.minFill && receive !== o.remaining) continue;
      const exactPay = (receive * o.wantAmount) / o.giveAmount;
      if (receive <= 0n || exactPay <= 0n || exactPay > remainingIn) continue;
      fills.push({
        offerId: o.id,
        maker: o.maker,
        payAmount: exactPay,
        receiveAmount: receive,
        giveAsset: o.wantAsset,
        giveLane: o.wantLane,
        wantAsset: o.giveAsset,
        wantLane: o.giveLane,
        price: { num: o.wantAmount, den: o.giveAmount },
      });
      remainingIn -= exactPay;
      totalOut += receive;
    }
    const usedIn = _big(amountIn) - remainingIn;
    if (requireFullFill && remainingIn !== 0n) return null;
    if (fills.length === 0) return null;
    return { fills, amountIn: _big(amountIn), usedIn, unusedIn: remainingIn, amountOut: totalOut };
  }

  function fill(offerId, { taker, takeGive, t, nearDeadline, farDeadline, minDeadlineGap = 0, nowTs = Infinity }) {
    const o = offers.get(lc(offerId));
    if (!o || !_live(o, nowTs)) throw new Error('orderbook: offer not fillable');
    if (requireSigned && !o.signed) throw new Error('orderbook: offer is not signed');
    const take = _big(takeGive);
    if (take <= 0n || take > o.remaining) throw new Error('orderbook: takeGive out of range');
    if (o.minFill != null && take < o.minFill && take !== o.remaining) throw new Error('orderbook: takeGive below minFill');
    if ((take * o.wantAmount) % o.giveAmount !== 0n) throw new Error('orderbook: fill must be an exact price multiple');
    if (o.expiry != null && !(farDeadline <= o.expiry)) throw new Error('orderbook: fill deadlines must not exceed offer expiry');
    const payWant = (take * o.wantAmount) / o.giveAmount;
    const ctx = swap.open({ t, nearDeadline, farDeadline, minGap: minDeadlineGap });
    o.remaining -= take;
    if (o.remaining === 0n) o.status = 'filled';
    return {
      swap: ctx,
      legs: {
        initiator: { party: taker, asset: o.wantAsset, amount: payWant, lane: o.wantLane },
        responder: { party: o.maker, asset: o.giveAsset, amount: take, lane: o.giveLane },
      },
      offer: o,
    };
  }

  function cancel(offerId, maker) {
    const o = offers.get(lc(offerId));
    if (!o) return false;
    if (o.maker !== maker) throw new Error('orderbook: only the maker can cancel');
    o.status = 'cancelled';
    return true;
  }
  function cancelSigned({ offerId, makerPubkey, signature, chainBinding: cb = chainBinding, bookId: bid = bookId }) {
    const id = lc(offerId);
    const o = offers.get(id);
    if (!o) return false;
    if (o.makerPubkey !== lc(makerPubkey)) throw new Error('orderbook: cancel maker mismatch');
    if (!verifyOrderCancel({ chainBinding: cb, bookId: bid, offerId, makerPubkey, signature })) {
      throw new Error('orderbook: invalid cancel signature');
    }
    o.status = 'cancelled';
    return true;
  }
  function expireSweep(nowTs) {
    let n = 0;
    for (const o of offers.values()) if (o.status === 'open' && o.expiry != null && nowTs >= o.expiry) { o.status = 'expired'; n++; }
    return n;
  }
  function prune(nowTs, maxAgeMs) {
    let n = 0;
    for (const [id, o] of offers) {
      if (o.status !== 'open' && (o.expiry == null || nowTs - o.expiry >= maxAgeMs)) { offers.delete(id); n++; }
    }
    return n;
  }

  return { post, postSigned, book, get, quote, quoteExactIn, fill, cancel, cancelSigned, expireSweep, prune };
}
