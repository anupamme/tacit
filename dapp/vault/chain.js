// What the vault page reads from and sends to the chain: Ethereum's public nodes (the same four the trade page asks, one after another),
// the calls of a vault and its two tokens as Multicall3 batches, and the calldata of what a person does there. Nothing here is kept: every
// figure comes from the contracts, so a vault is the same from any browser.
import { _internal, MULTICALL3 } from '/evm-trade-venues.js?cb=a08631ce';

export const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://mainnet.gateway.tenderly.co'];
export const WAD = 10n ** 18n;

export function makeRpc(urls = RPCS) {
  return async function rpc(method, params) {
    let last;
    for (const [n, url] of urls.entries()) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(n === urls.length - 1 ? 30e3 : 12e3) });
        const j = await r.json();
        if (j.error) {
          if (j.error.code === 3 || /revert/i.test(j.error.message || '')) throw Object.assign(new Error(j.error.message), { revert: true, data: typeof j.error.data === 'string' ? j.error.data : null });
          last = new Error(j.error.message); continue;
        }
        return j.result;
      } catch (e) { if (e.revert) throw e; last = e; }
    }
    throw last || new Error('no RPC answered');
  };
}

// ── calldata ──
const strip = (h) => String(h).replace(/^0x/, '');
export const word = (v) => BigInt(v).toString(16).padStart(64, '0');
export const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
export const wordAt = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, (i + 1) * 64) || '0'));
const addrAt = (hex, i) => '0x' + strip(hex).slice(i * 64 + 24, (i + 1) * 64);

export const SEL = {
  TAC: '0x19f68523', SYNTH: '0xe1eddde3', MINT_RATIO_BPS: '0x347bbf43', LIQ_RATIO_BPS: '0x3473b38c', OWNER_WINDOW: '0x89c90a65', AUCTION_DURATION: '0xa271e525',
  MIN_DEBT: '0xa1034103', REDEMPTION_FEE_BPS: '0xcc1d2090', DEPTH_BPS: '0x418be017',
  totalDebt: '0xfc7b9c18', debtCeiling: '0xe1c84ea4', depthCeiling: '0x16275096', borrowFeeBps: '0xb76b0aa7', valueOf: '0x195168b6', liquidationPrice: '0xb6fc2d5f', offerPrice: '0x3bf19e29',
  vaults: '0xa622ee7c', recovered: '0x0015aa6c', onOffer: '0x6a76229f',
  deposit: '0xb6b55f25', withdraw: '0x2e1a7d4d', borrow: '0x0ecbcdab', repay: '0x22867d78', cancel: '0x4c33fe94', permitTac: '0x1de38e64', permitSynth: '0xba8c86f1', multicall: '0xac9650d8',
  balanceOf: '0x70a08231', allowance: '0xdd62ed3e', approve: '0x095ea7b3', nonces: '0x7ecebe00', name: '0x06fdde03', symbol: '0x95d89b41', timestamp: '0x0f28c97d',
};
export const encDeposit = (amount) => SEL.deposit + word(amount);
export const encWithdraw = (amount) => SEL.withdraw + word(amount);
export const encBorrow = (amount, maxFeeBps) => SEL.borrow + word(amount) + word(maxFeeBps);
export const encRepay = (owner, amount) => SEL.repay + addrWord(owner) + word(amount);
export const encCancel = (owner) => SEL.cancel + addrWord(owner);
export const encApprove = (spender, amount) => SEL.approve + addrWord(spender) + word(amount);
// The vault's own permit calls (TAC's for a deposit, the synth's for a repayment): the permit applies to the vault as spender.
export const encPermit = (which, { value, deadline, v, r, s }) => SEL[which] + word(value) + word(deadline) + word(v) + strip(r).padStart(64, '0') + strip(s).padStart(64, '0');
// Multicallable.multicall(bytes[]): each call runs as the sender, so a permit and what it unlocks are one transaction.
export function encMulticall(datas) {
  let head = '', tail = '', off = datas.length * 32;
  for (const d of datas) {
    const h = strip(d), body = word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
    head += word(off); tail += body; off += body.length / 2;
  }
  return SEL.multicall + word(32) + word(datas.length) + head + tail;
}

// ── reading ──
export function makeReader(rpc) {
  const ethCall = (to, data, o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}) }, 'latest']);
  // `calls` are [name, to, data] (the lists below) or { to, data }.
  const batch = async (calls) => {
    const list = calls.map((c) => (Array.isArray(c) ? { to: c[1], data: c[2] } : c));
    return list.length ? _internal.decAggregate3(await ethCall(MULTICALL3, _internal.encAggregate3(list)), list.length) : [];
  };
  return { ethCall, batch };
}

const nameOf = (list, res) => Object.fromEntries(list.map(([k], i) => [k, res[i]]));
const U = (x) => (x == null ? null : wordAt(x, 0));
// An ABI string (a token's symbol).
export function decString(x) {
  if (x == null) return null;
  try { const n = Number(wordAt(x, 1)), h = strip(x).slice(128, 128 + n * 2); return new TextDecoder().decode(Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16))); } catch { return null; }
}

// What a vault never changes: its two tokens and its terms.
export const staticCalls = (vault) => [
  ['tac', vault, SEL.TAC], ['synth', vault, SEL.SYNTH], ['mint', vault, SEL.MINT_RATIO_BPS], ['liq', vault, SEL.LIQ_RATIO_BPS], ['ownerWindow', vault, SEL.OWNER_WINDOW],
  ['auctionDuration', vault, SEL.AUCTION_DURATION], ['minDebt', vault, SEL.MIN_DEBT], ['redemptionFee', vault, SEL.REDEMPTION_FEE_BPS], ['depthBps', vault, SEL.DEPTH_BPS],
];
export function parseStatic(res) {
  const r = nameOf(staticCalls('0x'), res);
  if (Object.values(r).some((x) => x == null)) return null;
  return { tac: addrAt(r.tac, 0), synth: addrAt(r.synth, 0), mint: wordAt(r.mint, 0), liq: wordAt(r.liq, 0), ownerWindow: Number(wordAt(r.ownerWindow, 0)), auctionDuration: Number(wordAt(r.auctionDuration, 0)), minDebt: wordAt(r.minDebt, 0), redemptionFee: wordAt(r.redemptionFee, 0), depthBps: wordAt(r.depthBps, 0) };
}

// What changes: the vault's totals, fees and prices (a view that has no price to give fails, and is null here), the synth's symbol and, for an
// account, its vault and what it holds and has approved.
export function dynamicCalls(V, who) {
  const v = V.addr;
  return [
    ['totalDebt', v, SEL.totalDebt], ['debtCeiling', v, SEL.debtCeiling], ['depthCeiling', v, SEL.depthCeiling], ['feeBps', v, SEL.borrowFeeBps],
    ['pB', v, SEL.valueOf + word(WAD) + word(1)], ['pL', v, SEL.liquidationPrice], ['pO', v, SEL.offerPrice], ['symbol', V.synth, SEL.symbol],
    ...(who ? [
      ['vault', v, SEL.vaults + addrWord(who)], ['recovered', v, SEL.recovered + addrWord(who)], ['onOffer', v, SEL.onOffer + addrWord(who)],
      ['tacBal', V.tac, SEL.balanceOf + addrWord(who)], ['tacAllow', V.tac, SEL.allowance + addrWord(who) + addrWord(v)],
      ['synBal', V.synth, SEL.balanceOf + addrWord(who)], ['synAllow', V.synth, SEL.allowance + addrWord(who) + addrWord(v)],
    ] : []),
  ];
}
export function parseDynamic(V, who, res) {
  const r = nameOf(dynamicCalls(V, who), res);
  const out = { totalDebt: U(r.totalDebt), debtCeiling: U(r.debtCeiling), depthCeiling: U(r.depthCeiling), feeBps: U(r.feeBps), pB: U(r.pB), pL: U(r.pL), pO: U(r.pO), symbol: decString(r.symbol) };
  if (who) {
    out.me = r.vault ? { collateral: wordAt(r.vault, 0), debt: wordAt(r.vault, 1), auctionStart: Number(wordAt(r.vault, 2)) } : null;
    out.recovered = r.recovered == null ? null : wordAt(r.recovered, 0) === 1n;
    out.onOffer = U(r.onOffer);
    out.tacBal = U(r.tacBal); out.tacAllow = U(r.tacAllow); out.synBal = U(r.synBal); out.synAllow = U(r.synAllow);
  }
  return out;
}
export const timestampCall = () => ['ts', MULTICALL3, SEL.timestamp];

// ── what a refused call says ──
// The first four bytes of a revert's data name the contract's error. Prices that are not recorded yet or a feed that is not fresh pause lending.
const ERRORS = {
  '0xfddafdf5': 'limit', '0x22a095d1': 'room', '0x266fe7fc': 'auction', '0x749b5939': 'amount', '0xcd4e6167': 'fee', '0xc149905d': 'paused', '0xa889a81f': 'paused', '0xa0cd3bb2': 'paused', '0xb0171a5d': 'paused',
  '0x71d00de2': 'noauction', '0x53da3010': 'unhealthy', '0xda1dae0c': 'healthy', '0x47db04b6': 'ownerwindow', '0x5419376a': 'paused',
  '0x13be252b': 'access', '0x7939f424': 'access', '0xf4d678b8': 'balance',
};
export const refusal = (e) => ERRORS[String(e?.data || '').slice(0, 10).toLowerCase()] || null;
