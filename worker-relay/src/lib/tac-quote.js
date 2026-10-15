// What ETH buys in TAC at each public venue, read from the chain: Precision's TAC/ETH band (through its lens, skipping a pool its
// policy does not route) and Tacit's own public AMM (every fee tier it may have founded). The same two reads the trade page's
// venue module makes (dapp/evm-trade-venues.js, which this service's image does not hold), kept to what a price needs.
import { zeroAddress } from 'viem';

export const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
export const PRECISION_LENS = '0x000000Bad3a2fa57ed74fa06000573ccddF6B7fB';
export const PRECISION_POLICY = '0x00000045fc7b570Be4d71F67219508ebD295EC6D';
export const TACIT_AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119';
export const TAC_POOL_ASSET_ID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const CETH_POOL_ASSET_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const AMM_TIERS = [30, 5, 100, 1];
const AMM_UNIT = 10n ** 10n;                 // the AMM takes amounts in whole units of 1e10

const SEL = { quoteBest: '2adaa389', routable: '9662c498', quoteSwap: '3bc1414a' }; // as dapp/evm-trade-venues.js calls them
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const bytes32 = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const call = async (client, to, data) => (await client.call({ to, data: `0x${data}` })).data ?? '';
const wordAt = (hex, i) => BigInt(`0x${hex.replace(/^0x/, '').slice(i * 64, (i + 1) * 64) || '0'}`);

// → [{ venue, amountIn, amountOut }] for `amountIn` wei of ETH, each venue that answers (an empty list when none does).
export async function quoteTacForEth(client, amountIn) {
  const out = [];
  const precision = (async () => {
    const [c0, c1] = zeroAddress.toLowerCase() < TAC.toLowerCase() ? [zeroAddress, TAC] : [TAC, zeroAddress];
    const best = await call(client, PRECISION_LENS, SEL.quoteBest + addr(c0) + addr(c1) + addr(zeroAddress) + addr(zeroAddress) + word(amountIn) + word(0) + word(128));
    const pool = `0x${best.slice(2 + 24, 2 + 64)}`, amountOut = wordAt(best, 1);
    if (amountOut <= 0n || BigInt(pool) === 0n) return;
    const ok = await call(client, PRECISION_POLICY, SEL.routable + word(32) + word(1) + addr(pool));
    if (ok.length >= 2 + 192 && wordAt(ok, 2) === 1n) out.push({ venue: 'precision', amountIn, amountOut });
  })().catch(() => {});
  const amm = (async () => {
    const aligned = amountIn - (amountIn % AMM_UNIT);
    if (aligned <= 0n) return;
    const tiers = await Promise.all(AMM_TIERS.map((fee) => call(client, TACIT_AMM, SEL.quoteSwap + bytes32(CETH_POOL_ASSET_ID) + bytes32(TAC_POOL_ASSET_ID) + word(fee) + word(aligned)).then((r) => wordAt(r, 0)).catch(() => 0n)));
    const best = tiers.reduce((m, x) => (x > m ? x : m), 0n);
    if (best > 0n) out.push({ venue: 'tacit-amm', amountIn: aligned, amountOut: best });
  })().catch(() => {});
  await Promise.all([precision, amm]);
  return out;
}

// The venue that pays the most TAC for the same ETH is the deepest one at that size.
export const deepest = (quotes) => quotes.reduce((best, q) => (!best || q.amountOut > best.amountOut ? q : best), null);
