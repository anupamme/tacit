// tools/evm-pool-solvency.mjs: how a Transact log is read, and what each check passes and fails.
//   node tests/evm-pool-solvency.test.mjs
import assert from 'node:assert/strict';
import { decodeTransact, evaluate, emptyState, TOPIC } from '../tools/evm-pool-solvency.mjs';

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };
const ETH = 10n ** 18n, Z = '0x' + '0'.repeat(64);
const w = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const log = ({ block = 1, i = 0, first = 0, leaf0 = 0n, leaf1 = 0n, root = 0n, ext = 0n, fee = 0n }) => ({
  blockNumber: '0x' + block.toString(16), logIndex: '0x' + i.toString(16), topics: [TOPIC, '0x' + w(7), Z],
  data: '0x' + [leaf0, leaf1, first, root, 0xabn, ext, 0xcdn, fee, 0x140n, 0x180n].map(w).join('') + w(0) + w(0),
});
const ev = (o) => decodeTransact(log(o));
const ctx = (o) => ({ balance: 0n, nextIndex: 0n, root: Z, ...o });
const status = (rows, name) => rows.find((r) => r.name === name)?.status;

check('the topic is the Transact event the pool emits', () => {
  assert.equal(TOPIC, '0xdf0ed29e998ac2f2ff0f0516cb9c1b95af189e00d55af3764b95bdd2a835e53a');
});

check('a log decodes to its block, leaves, root and signed amount', () => {
  const e = ev({ block: 300, i: 4, first: 6, leaf0: 11n, leaf1: 12n, root: 99n, ext: -5n * ETH, fee: 7n });
  assert.deepEqual([e.block, e.index, e.first, e.ext, e.fee], [300, 4, 6, -5n * ETH, 7n]);
  assert.equal(BigInt(e.leaf0), 11n); assert.equal(BigInt(e.root), 99n);
  assert.equal(ev({ ext: 3n * ETH }).ext, 3n * ETH);
});

// Two deposits, a withdrawal that inserts nothing, a transfer: 5 ETH in, 2 out, 0.01 in fees.
const history = () => [
  ev({ block: 10, first: 0, leaf0: 1n, leaf1: 2n, root: 100n, ext: 3n * ETH }),
  ev({ block: 11, first: 2, leaf0: 3n, leaf1: 0n, root: 101n, ext: 2n * ETH }),
  ev({ block: 12, first: 4, root: 101n, ext: -2n * ETH, fee: ETH / 100n }),
  ev({ block: 13, first: 4, leaf0: 4n, leaf1: 5n, root: 102n }),
];
const good = ctx({ balance: 3n * ETH - ETH / 100n, nextIndex: 6n, root: '0x' + w(102n) });

check('a pool whose balance is the net of its events, with its leaves and root, passes everything', () => {
  const { rows, state } = evaluate({ ...emptyState(), to: 13 }, history(), good);
  assert.deepEqual(rows.filter((r) => r.status !== 'ok'), []);
  assert.equal(state.next, 6); assert.equal(state.events, 4);
});

check('ETH sent to the pool directly is a note, not a failure', () => {
  const { rows } = evaluate({ ...emptyState(), to: 13 }, history(), { ...good, balance: good.balance + 5n });
  assert.equal(status(rows, 'surplus'), 'note');
  assert.equal(rows.some((r) => r.status === 'FAIL'), false);
});

check('a balance below the net fails', () => {
  const { rows } = evaluate({ ...emptyState(), to: 13 }, history(), { ...good, balance: good.balance - 1n });
  assert.equal(status(rows, 'balance'), 'FAIL');
});

check('withdrawals and fees above deposits fail, the shape an unbacked note would leave', () => {
  const evs = [ev({ first: 0, leaf0: 1n, leaf1: 2n, root: 100n, ext: ETH }), ev({ block: 2, first: 2, ext: -2n * ETH })];
  const { rows } = evaluate({ ...emptyState(), to: 2 }, evs, ctx({ nextIndex: 2n, root: '0x' + w(100n) }));
  assert.equal(status(rows, 'outflows'), 'FAIL');
});

check('a leaf that does not start where the tree stood fails, and so does an end the pool does not share', () => {
  const evs = history(); evs[1] = { ...evs[1], first: 4 };
  assert.equal(status(evaluate({ ...emptyState(), to: 13 }, evs, good).rows, 'leaves'), 'FAIL');
  assert.equal(status(evaluate({ ...emptyState(), to: 13 }, history(), { ...good, nextIndex: 8n }).rows, 'leaves'), 'FAIL');
});

check('a last root that is not the pool\'s fails', () => {
  assert.equal(status(evaluate({ ...emptyState(), to: 13 }, history(), { ...good, root: '0x' + w(5n) }).rows, 'root'), 'FAIL');
});

check('a run that continues from saved sums gives the same answer as one that reads it all', () => {
  const all = history();
  const first = evaluate({ ...emptyState(), to: 11 }, all.slice(0, 2), ctx({ balance: 5n * ETH, nextIndex: 4n, root: '0x' + w(101n) }));
  assert.deepEqual(first.rows.filter((r) => r.status === 'FAIL'), []);
  const rest = evaluate({ ...first.state, to: 13 }, all.slice(2), good);
  assert.deepEqual(rest.state, evaluate({ ...emptyState(), to: 13 }, all, good).state);
  assert.deepEqual(rest.rows.filter((r) => r.status !== 'ok'), []);
});

console.log(`\n${n} checks passed`);
