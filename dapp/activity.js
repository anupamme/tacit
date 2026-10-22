// The Activity journal: what this browser has set going (relay jobs, Ethereum and Bitcoin transactions, pool ops), kept in localStorage
// so another tab, or another page of the site, reads the same list. The front page writes it and follows each entry to its end; this
// module is what any page needs to read it: the key, when an entry has ended, the names of the relay's jobs, and how many are still going.
// No DOM, no network.

export const ACT_KEY = 'tacit-lite-activity-v1', ACT_MAX = 20;

export const JOB_LABEL = {
  wrap: 'Make private', wraptransfer: 'Make private and send', wrapswap: 'Make private and swap', wraplp: 'Make private and add liquidity', wrapcdpmint: 'Make private and borrow',
  transfer: 'Private transfer', batchtransfer: 'Private transfers', unwrap: 'Withdraw', sendunwrap: 'Withdraw', swap: 'Private swap', route: 'Private swap',
  lp: 'Add liquidity', lpremove: 'Take out liquidity', lpbond: 'Bond liquidity', farmbond: 'Join a private farm', farmharvest: 'Harvest farm rewards',
  farmunbond: 'Unbond from a farm', otc: 'Private trade', bid: 'Private bid', cbtcmint: 'Mint cBTC', cdpmint: 'Borrow cUSD', cdpclose: 'Repay a loan',
  cdptopup: 'Top up a loan', cdpliquidate: 'Liquidate a loan', stealthlock: 'Send privately', stealthlockbatch: 'Send privately',
  stealthclaim: 'Claim a private payment', stealthrefund: 'Take back a private send', bridgemint: 'Bridge in', bridgestealthmint: 'Bridge in',
  bridgeburn: 'Bridge out', fastlane: 'Cross-chain move', adaptorlock: 'Atomic swap', adaptorclaim: 'Atomic swap claim', adaptorrefund: 'Atomic swap refund',
};

// the statuses each kind of entry ends in
export const ENDS = { job: ['settled', 'proven', 'failed', 'unknown'], tx: ['confirmed', 'failed', 'stale'], btc: ['confirmed', 'stale'], op: ['settled', 'failed', 'unknown'] };
export const ended = (it) => ENDS[it.kind]?.includes(it.status) ?? true;

export function readActivity() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(ACT_KEY)); } catch {}
  return { items: [].concat(v?.items || []).filter((x) => x?.id && ENDS[x.kind]), cleared: Number(v?.cleared) || 0 };
}
// the entries shown (a step nested in another is shown inside it)
export const listed = (items) => items.filter((x) => !x.in);

// A settled op that burned for a bridge to Bitcoin is not done until the Bitcoin step has landed: its row in the bridge journal says where it is.
const BR = new Map();
export function actBridge(it) {
  if (it.kind !== 'op' || it.status !== 'settled' || !it.hash || !it.pub) return null;
  try {
    const key = `tacit-crossout-bridge-v1:mainnet:${it.pub}`, raw = localStorage.getItem(key) || '';
    let list = BR.get(key);
    if (!list || list.raw !== raw) { let v = null; try { v = JSON.parse(raw || '[]'); } catch {} list = { raw, v: Array.isArray(v) ? v : [] }; BR.set(key, list); }
    const h = String(it.hash).replace(/^0x/, '').toLowerCase();
    return list.v.find((r) => String(r?.settle?.txHash || '').replace(/^0x/, '').toLowerCase() === h) || null;
  } catch { return null; }
}
export const actOpen = (it) => { const b = actBridge(it); return !!b && b.stage !== 'minted'; };
export const actDone = (it) => ended(it) && !actOpen(it);

// what the Activity chip shows: how many entries there are, and how many are still going
export function activityCount(items = readActivity().items) {
  const top = listed(items);
  return { total: top.length, live: top.filter((x) => !actDone(x)).length };
}

// another tab's write (the journal, or a bridge's): `fn` is called, and the returned function stops it
export function onActivity(fn) {
  const h = (e) => { if (!e.key || e.key === ACT_KEY || e.key.startsWith('tacit-crossout-bridge-v1:')) fn(); };
  addEventListener('storage', h);
  return () => removeEventListener('storage', h);
}
