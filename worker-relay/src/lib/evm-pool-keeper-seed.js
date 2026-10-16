// A fresh keeper store seeded from another keeper's public event feed (GET <feed>/events?from=), instead of from the chain's logs: a
// new instance (or a replaced disk) is up in seconds where a log replay from the start block takes hours on public nodes and fails on
// nodes that keep only recent history. Nothing is taken on trust: the leaves the feed gives are hashed into the tree and the root and
// count are checked against the pool's own state at the feed's last block, read from this keeper's nodes; a feed that does not match
// seeds nothing. Only an empty store is seeded.

const lc = (s) => String(s || '').toLowerCase();

export async function seedFromFeed({ store, chain, zk, feedUrl, startBlock = 0n, reset = false, fetchImpl = fetch, log = () => {}, maxPages = 10_000 }) {
  // `reset`: a store part-way through a log replay is emptied first (its intents are kept), a one-time choice named in the service's env.
  if (store.leafCount() > 0 || store.syncedBlock() !== null) {
    if (!reset) return { seeded: false, reason: 'the store is not empty' };
    log(`store had ${store.leafCount()} leaves through block ${store.syncedBlock()}; emptied to seed from the feed (EVM_POOL_SEED_RESET)`);
    store.resetLeaves();
  }
  const base = String(feedUrl).replace(/\/$/, '');
  const events = [];
  let from = Number(startBlock) || 0, through = null;
  for (let page = 0; page < maxPages; page++) {
    const r = await fetchImpl(`${base}/events?from=${from}`);
    if (!r.ok) throw new Error(`feed ${base}: ${r.status}`);
    const j = await r.json();
    if (Number(j.chainId) !== Number(chain.chainId) || lc(j.pool) !== lc(chain.pool)) throw new Error(`feed ${base} is for chain ${j.chainId} pool ${j.pool}, not this keeper's`);
    if (!Array.isArray(j.events) || !Number.isInteger(j.through)) throw new Error(`feed ${base}: malformed page`);
    through = j.through;
    if (!j.events.length) break;
    events.push(...j.events);
    from = j.through + 1;
  }
  if (through === null || !events.length) return { seeded: false, reason: 'the feed has no events yet' };
  // Leaves, in the pool's order, contiguous from the first.
  const tx = events.filter((e) => e && e.kind === 'transact' && (BigInt(e.outLeaf0) !== 0n || BigInt(e.outLeaf1) !== 0n)).sort((a, b) => Number(a.firstIndex) - Number(b.firstIndex));
  const items = [];
  for (const e of tx) {
    if (Number(e.firstIndex) !== items.length) throw new Error(`feed ${base}: Transact at index ${e.firstIndex}, expected ${items.length}`);
    items.push({ leaf: BigInt(e.outLeaf0), block: BigInt(e.block) }, { leaf: BigInt(e.outLeaf1), block: BigInt(e.block) });
  }
  // The pool's own word at the feed's last block: the same root over the same count, or nothing is kept.
  const { root, nextIndex } = await chain.poolState(BigInt(through));
  const tree = zk.incTree();
  tree.append(items.map((x) => x.leaf));
  if (BigInt(tree.size) !== BigInt(nextIndex) || BigInt(tree.root) !== BigInt(root)) {
    throw new Error(`feed ${base}: ${tree.size} leaves with root ${tree.root} at block ${through}, the pool holds ${nextIndex} under ${root}`);
  }
  // Events keep their feed order inside a block (the feed does not carry log indexes).
  const byBlock = new Map();
  const rows = events.map((ev) => { const n = (byBlock.get(ev.block) || 0); byBlock.set(ev.block, n + 1); return { block: ev.block, logIndex: n, ev }; });
  store.appendLeaves(items, through, rows);
  log(`seeded ${items.length} leaves and ${rows.length} events through block ${through} from ${base}, root checked against the pool`);
  return { seeded: true, leaves: items.length, events: rows.length, through };
}
