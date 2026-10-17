#!/usr/bin/env node
// The bridge recoverer's explorer reads (worker-relay/src/bridge-recover.js makeChain) take the first answer that is the one asked for:
// a transaction's hex must hash to its id, its JSON must carry that id, and each input's prevout script must be the one its parent's output
// holds. An explorer that answers otherwise is skipped like one that is down, and the next is asked.
//   node tests/bridge-recover-chain.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { makeChain, txidOfHex } from '../worker-relay/src/bridge-recover.js';

const dsha = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
const le = (n, len) => Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex').reverse();
// A transaction as its non-witness bytes: version, inputs, outputs, locktime; `witness` makes the segwit serialization of the same one.
function build(ins, outs, witness = false) {
  const body = [Buffer.from([ins.length])];
  for (const i of ins) body.push(Buffer.from(i.txid, 'hex').reverse(), le(i.vout, 4), Buffer.from([0]), Buffer.from('fdffffff', 'hex'));
  body.push(Buffer.from([outs.length]));
  for (const o of outs) { const s = Buffer.from(o.script, 'hex'); body.push(le(o.value, 8), Buffer.from([s.length]), s); }
  const stripped = Buffer.concat([le(2, 4), ...body, le(0, 4)]);
  const full = witness ? Buffer.concat([le(2, 4), Buffer.from([0, 1]), ...body, ...ins.map(() => Buffer.from([1, 2, 0xaa, 0xbb])), le(0, 4)]) : stripped;
  return { hex: full.toString('hex'), txid: dsha(stripped).reverse().toString('hex') };
}

const PARENT_SCRIPT = '0014' + '11'.repeat(20);
const parent = build([{ txid: 'cd'.repeat(32), vout: 1 }], [{ value: 1000, script: PARENT_SCRIPT }], true);
const child = build([{ txid: parent.txid, vout: 0 }], [{ value: 900, script: '0014' + '22'.repeat(20) }], true);
const other = build([{ txid: 'ef'.repeat(32), vout: 0 }], [{ value: 5, script: '0014' + '33'.repeat(20) }], false);
const childJson = (over = {}) => ({ txid: child.txid, status: { confirmed: true, block_height: 900000 }, vin: [{ txid: parent.txid, vout: 0, prevout: { scriptpubkey: PARENT_SCRIPT, scriptpubkey_address: 'bc1x' } }], ...over });

let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
ok(txidOfHex(parent.hex) === parent.txid && txidOfHex(child.hex) === child.txid && txidOfHex(other.hex) === other.txid, 'the id of a segwit and of a legacy transaction is read from its hex');
ok(txidOfHex('00') === null && txidOfHex('zz') === null, 'something that is not a transaction has no id');

// `wrong` says how an explorer answers wrongly; the others serve the right bytes and JSON.
function explorer(wrong = null) {
  return async (url) => {
    const p = new URL(url).pathname.replace(/^\/api/, '');
    const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    const txt = (t) => new Response(t, { status: 200 });
    if (p === `/tx/${child.txid}/hex`) return txt(wrong === 'hex' ? other.hex : child.hex);
    if (p === `/tx/${parent.txid}/hex`) return txt(wrong === 'parent-hex' ? other.hex : parent.hex);
    if (p === `/tx/${child.txid}`) {
      if (wrong === 'txid') return json(childJson({ txid: other.txid }));
      if (wrong === 'prevout') return json(childJson({ vin: [{ txid: parent.txid, vout: 0, prevout: { scriptpubkey: '0014' + 'ff'.repeat(20) } }] }));
      return json(childJson());
    }
    return new Response('not found', { status: 404 });
  };
}
const chainOf = (...wrongs) => makeChain(async (url) => explorer(wrongs[url.includes('//a.') ? 0 : 1])(url), ['https://a.test/api', 'https://b.test/api']);

// Explorers that answer rightly: the answers come back as served.
{
  const c = chainOf(null, null);
  ok((await c.getTxHex(child.txid)) === child.hex, 'the hex of a transaction is returned when it hashes to its id');
  const j = await c.getTx(child.txid);
  ok(j && j.txid === child.txid && j.vin[0].prevout.scriptpubkey === PARENT_SCRIPT, 'the JSON of a transaction is returned when its id and prevouts hold');
  ok((await c.getTx('99'.repeat(32))) === null, 'an unknown transaction is null');
}
// The first explorer answers wrongly, the second does not: the right answer is the one returned.
for (const wrong of ['hex', 'txid', 'prevout', 'parent-hex']) {
  const c = chainOf(wrong, null);
  const want = wrong === 'hex' ? () => c.getTxHex(child.txid).then((h) => h === child.hex) : () => c.getTx(child.txid).then((j) => j && j.txid === child.txid && j.vin[0].prevout.scriptpubkey === PARENT_SCRIPT);
  ok(await want(), `a first explorer answering with a wrong ${wrong} is skipped`);
}
// Both answer wrongly: nothing is returned as chain data.
for (const wrong of ['hex', 'txid', 'prevout']) {
  const c = chainOf(wrong, wrong);
  await assert.rejects(wrong === 'hex' ? c.getTxHex(child.txid) : c.getTx(child.txid), /explorers unavailable/);
  ok(true, `two explorers answering with a wrong ${wrong} give no answer`);
}
console.log(`${n} checks`);
