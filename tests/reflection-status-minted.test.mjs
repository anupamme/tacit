// GET /reflection/status also says how many of the recorded bridge burns the pool has minted on Ethereum, read from the pool's
// bridgeMinted mapping (declaration slot 76) and kept for what it cannot read. Offline: node tests/reflection-status-minted.test.mjs
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.env.MODE;
if (!mode) {
  let failed = 0;
  for (const m of ['ok', 'down', 'partial']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, MODE: m }, encoding: 'utf8' });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `\n${failed} mode(s) failed` : '\nall modes passed');
  process.exit(failed ? 1 : 0);
}

const { keccak_256 } = await import('../worker-relay/node_modules/@noble/hashes/sha3.js').catch(() => import('@noble/hashes/sha3'));
const hex = (b) => Buffer.from(b).toString('hex');
const word = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const slotOf = (burnId) => '0x' + hex(keccak_256(Buffer.from(word(burnId) + word((76).toString(16)), 'hex')));

// Burns 0x01 and 0x02 are recorded; the sentinel (key 0x00) is not a burn. 0x01 has minted.
const MINTED = new Set([slotOf('0x01')]);
const reads = [];
globalThis.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  if (!body || body.method !== 'eth_getStorageAt') throw new Error('offline');
  if (mode === 'down') throw new Error('rpc down');
  const [, slot] = body.params;
  reads.push(slot);
  if (mode === 'partial' && slot === slotOf('0x02')) return { ok: false, status: 503, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: MINTED.has(slot) ? '0x' + '00'.repeat(31) + '01' : '0x' + '00'.repeat(32) }) };
};
const record = JSON.stringify({ attestedHeight: 967810, tipHeight: 967836, snapshot: { foldedCrossoutCount: '2', consumedCount: 1, burnNodes: [['0x00', '0x01', '0x00', true], ['0x01', '0x02', '0xd1', true], ['0x02', '0x00', '0xd2', true]], liveTriples: [[1], [2], [3]], noteLeaves: new Array(50).fill('0x0'), pendingDepositRecords: [] } });
const env = { REGISTRY_KV: { get: async (k) => (k === 'reflection:scan:mainnet' ? record : null), put: async () => {}, delete: async () => {} } };
const worker = await import('../worker/src/index.js');
const b = await (await worker.default.fetch(new Request('https://api.test/reflection/status?network=mainnet'), env, { waitUntil() {} })).json();

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; console.log(`  PASS  [${mode}] ${n}`); };
ok('the recorded burns are still counted without the opening entry', b.bridgeBurns === 2);
if (mode === 'ok') {
  ok('the minted ones are counted from the pool\'s mapping: one of the two', b.bridgeMinted === 1);
  ok('each recorded burn is read once by its own slot, the opening entry never', reads.length === 2 && reads.includes(slotOf('0x01')) && reads.includes(slotOf('0x02')) && !reads.includes(slotOf('0x00')));
}
if (mode === 'down') ok('when the chain cannot be read the figure is absent, not zero', b.bridgeMinted === null);
if (mode === 'partial') ok('a burn that cannot be read leaves the count absent rather than short', b.bridgeMinted === null);
console.log(`  ${pass} passed [${mode}]`);
