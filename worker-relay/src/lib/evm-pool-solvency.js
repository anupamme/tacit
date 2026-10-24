// What a device pool's own history says against the ETH (or, for a token pool, the token) it holds. The pool pays out only what a proof lets it, and every deposit,
// withdrawal and relayer fee is in its Transact events, so at any block: the balance is deposits less withdrawals less fees (more if
// someone sent it ETH directly, never less), and the leaves its events inserted are the leaves it reports. Outflows above inflows, or
// a balance under the net, is what a flaw in its proof system would look like: the monitor pages on either.
//
// totals: { deposits, withdrawals, fees, leaves, events, through } as the keeper's /totals gives them (decimal wei strings).
// chain:  { balance (wei at block `through`), nextIndex (the pool's leaf count at that block) }.
// unit:   what the amounts are named in the verdict ('ETH', or a token pool's symbol; 18 decimals either way).
// → { level: 'ok' | 'warning' | 'critical', why, net (wei), surplus (wei) }

export function solvencyVerdict(totals, chain, unit = 'ETH') {
  const eth = (w) => `${w < 0n ? '-' : ''}${(Number(w < 0n ? -w : w) / 1e18).toFixed(6)} ${unit}`;
  const dep = BigInt(totals.deposits), wd = BigInt(totals.withdrawals), fee = BigInt(totals.fees);
  const balance = BigInt(chain.balance), net = dep - wd - fee;
  if (net < 0n) return { level: 'critical', why: `withdrawals and fees exceed deposits by ${eth(-net)} through block ${totals.through} (${eth(dep)} in, ${eth(wd)} out, ${eth(fee)} in fees)`, net, surplus: 0n };
  if (balance < net) return { level: 'critical', why: `the pool holds ${eth(balance)} at block ${totals.through}, ${eth(net - balance)} under the ${eth(net)} its events net (${eth(dep)} in, ${eth(wd)} out, ${eth(fee)} in fees)`, net, surplus: 0n };
  if (BigInt(totals.leaves) !== BigInt(chain.nextIndex)) return { level: 'warning', why: `the keeper's history has ${totals.leaves} leaves through block ${totals.through}, the pool held ${chain.nextIndex}`, net, surplus: balance - net };
  return { level: 'ok', why: `${eth(balance)} held, the ${eth(net)} its ${totals.events} events net${balance > net ? ` and ${eth(balance - net)} sent to it directly` : ''}`, net, surplus: balance - net };
}

// The whole read: the keeper's totals, then the pool's balance and leaf count at the totals' own block, judged. A critical verdict
// is read again once (fresh totals, a fresh balance) before it stands, so one odd answer cannot page. → { level: 'ok' | 'warning' |
// 'critical' | 'unknown', why, totals?, chain? }; 'unknown' when the keeper has no totals yet or a node cannot give the block's state.
// rpc(method, params) → the node's result (tried over the chain's nodes by the caller).
const NEXT_INDEX = '0xfc7e9c6f';      // nextIndex()
// `token`: a token pool's asset, whose balance the pool's books are held against (the ETH balance otherwise), named `unit`.
export async function poolBooks({ keeper, pool, rpc, token = null, unit = 'ETH', fetchImpl = fetch, timeoutMs = 20_000 }) {
  const once = async () => {
    const r = await fetchImpl(`${keeper}/totals`, { signal: AbortSignal.timeout?.(timeoutMs) });
    if (r.status === 404) return { level: 'unknown', why: 'the keeper has no /totals yet' };
    if (!r.ok) return { level: 'unknown', why: `the keeper's /totals answered ${r.status}` };
    const totals = await r.json();
    const at = '0x' + Number(totals.through).toString(16);
    let balance, nextIndex;
    const held = token ? rpc('eth_call', [{ to: token, data: '0x70a08231' + pool.toLowerCase().replace(/^0x/, '').padStart(64, '0') }, at]) : rpc('eth_getBalance', [pool, at]);
    try { [balance, nextIndex] = (await Promise.all([held, rpc('eth_call', [{ to: pool, data: NEXT_INDEX }, at])])).map((x) => BigInt(x)); }
    catch (e) { return { level: 'unknown', why: `no node gave the pool's state at block ${totals.through}: ${String(e?.message || e).slice(0, 120)}`, totals }; }
    const chain = { balance: balance.toString(), nextIndex: nextIndex.toString() };
    return { ...solvencyVerdict(totals, chain, unit), totals, chain };
  };
  const first = await once();
  if (first.level !== 'critical') return first;
  const second = await once();
  return second.level === 'critical' ? second : { ...second, why: `${second.why} (read again after a first reading said: ${first.why})` };
}
