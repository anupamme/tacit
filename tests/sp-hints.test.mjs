// Silent-payment hints end to end: the sender seals a txid to the recipient's scan key, the hint service stores it
// and serves every hint, and only the recipient's scan key opens it.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Database from '../worker-relay/node_modules/better-sqlite3/lib/index.js';
import { secp, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { sealHint, openHint, postHint, readHints } from '../dapp/sp-hints.js';
import { makeSpHints } from '../worker-relay/src/lib/sp-hints.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const key = () => { const priv = secp.utils.randomPrivateKey(); return { priv, pub: secp.getPublicKey(priv, true) }; };
const TX = 'ab'.repeat(32);

await test('a hint opens under the recipient’s scan key, and under no other', () => {
  const bob = key(), eve = key(), h = sealHint(bob.pub, TX);
  assert.equal(openHint([eve.priv, bob.priv], h.e, h.c), TX);
  assert.equal(openHint([eve.priv], h.e, h.c), null);
  const bad = h.c.slice(0, 10) + (h.c[10] === '0' ? '1' : '0') + h.c.slice(11);
  assert.equal(openHint([bob.priv], h.e, bad), null, 'a changed hint does not open');
  assert.notEqual(sealHint(bob.pub, TX).e, h.e, 'each hint has its own key');
});

await test('the service stores hints, serves them in pages, and refuses malformed ones', async () => {
  const db = new Database(':memory:');
  const hints = makeSpHints({ db, rateLimit: { perMin: 600, burst: 600 } });
  const server = createServer(hints.wrap((req, res) => { res.writeHead(404); res.end(); }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bob = key(), others = Array.from({ length: 5 }, key);
    for (const o of others) await postHint(base, o.pub, bytesToHex(secp.utils.randomPrivateKey()));
    const id = await postHint(base, bob.pub, TX);
    const found = [];
    const last = await readHints(base, 0, (i, e, c) => { const t = openHint([bob.priv], e, c); if (t) found.push([i, t]); });
    assert.deepEqual(found, [[id, TX]]);
    assert.equal(last, id);
    assert.deepEqual((await (await fetch(`${base}/sp/hints?after=${id}`)).json()).hints, [], 'nothing after the last');
    const paged = await (await fetch(`${base}/sp/hints?after=0&limit=2`)).json();
    assert.equal(paged.hints.length, 2); assert.equal(paged.next, paged.hints[1][0]);
    const post = (body) => fetch(`${base}/sp/hints`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await post(JSON.stringify({ e: '04' + 'aa'.repeat(32), c: 'bb'.repeat(48) }))).status, 400);
    assert.equal((await post(JSON.stringify({ e: '02' + 'aa'.repeat(32), c: 'bb'.repeat(47) }))).status, 400);
    assert.equal((await post('x'.repeat(2000))).status, 413);
    assert.equal((await fetch(`${base}/other`)).status, 404, 'other paths pass through');
  } finally { server.close(); }
});

await test('posting is rate limited per client', async () => {
  const db = new Database(':memory:');
  const server = createServer(makeSpHints({ db, rateLimit: { perMin: 1, burst: 2 } }).wrap((q, s) => s.end()));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`, k = key();
  try {
    await postHint(base, k.pub, TX); await postHint(base, k.pub, TX);
    await assert.rejects(postHint(base, k.pub, TX), /429/);
  } finally { server.close(); }
});

await test('a page that cannot be read ends the read at the last page read, and the next read carries on from there', async () => {
  const ids = [3, 5, 8, 13, 21];
  // Two hints a page; the page after `down` fails as `fail` says: an HTTP error, a dropped connection or a body that is no page.
  const serve = (down, fail) => async (url) => {
    const after = Number(new URL(url).searchParams.get('after'));
    if (after === down) {
      if (fail === 'drop') throw new TypeError('Failed to fetch');
      return fail === 'body' ? { ok: true, json: async () => ({}) } : { ok: false, status: 503 };
    }
    const page = ids.filter((i) => i > after).slice(0, 2);
    return { ok: true, json: async () => ({ hints: page.map((i) => [i, 'e', 'c']), next: page.length && ids.at(-1) > page.at(-1) ? page.at(-1) : null }) };
  };
  for (const fail of ['http', 'drop', 'body']) {
    const read = [];
    const at = await readHints('http://x', 0, (id) => { read.push(id); }, serve(5, fail));
    assert.deepEqual(read, [3, 5], fail);
    assert.equal(at, 5, `${fail}: the id of the last page read`);
    assert.equal(await readHints('http://x', at, (id) => { read.push(id); }, serve(null)), 21);
    assert.deepEqual(read, [3, 5, 8, 13, 21], `${fail}: each hint is read once`);
    await assert.rejects(readHints('http://x', 0, () => {}, serve(0, fail)), undefined, `${fail}: a first page that cannot be read throws`);
  }
});

console.log(`\n${passed} passed`);
