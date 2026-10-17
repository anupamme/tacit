#!/usr/bin/env node
// GET /ipfs/<cid> serves gateway bytes as data: every response is unsniffed and carries a sandboxed policy, whatever
// content type the gateway reports, on both the hash-verified raw-block path and the streamed path.
//   node tests/ipfs-proxy-headers.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import worker from '../worker/src/index.js';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function rawCid(bytes) {
  const raw = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), createHash('sha256').update(bytes).digest()]);
  let bits = 0, acc = 0, out = '';
  for (const b of raw) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return 'b' + out;
}

const realFetch = globalThis.fetch;
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };

async function get(path, body, type) {
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'content-type': type } });
  try { return await worker.fetch(new Request(`https://api.test${path}`), {}, { waitUntil() {} }); }
  finally { globalThis.fetch = realFetch; }
}
const check = (res, label) => {
  ok(res.status === 200, `${label}: served`);
  ok(res.headers.get('x-content-type-options') === 'nosniff', `${label}: nosniff`);
  ok(res.headers.get('content-security-policy') === "default-src 'none'; sandbox", `${label}: sandboxed policy`);
};

// A raw block whose gateway reports an SVG type (the verified path).
{
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  const res = await get(`/ipfs/${rawCid(svg)}`, svg, 'image/svg+xml');
  ok(res.headers.get('content-type') === 'image/svg+xml', 'raw svg: the gateway type passes through');
  check(res, 'raw svg');
}
// A raw block carrying JSON.
{
  const json = Buffer.from('{"name":"asset"}');
  const res = await get(`/ipfs/${rawCid(json)}`, json, 'application/json');
  check(res, 'raw json');
}
// A CIDv0 path (streamed, not hash-verified here).
{
  const res = await get('/ipfs/QmWZ3X8yBzZHrN5f5a5rnx4BZASpckck77khCBGKNXLRAb', '{"a":1}', 'application/json');
  check(res, 'streamed');
}
// An HTML answer is still refused rather than relayed.
{
  const html = Buffer.from('<!doctype html><title>x</title>');
  const res = await get(`/ipfs/${rawCid(html)}`, html, 'text/html');
  ok(res.status === 502, 'html from every gateway is refused');
}
// POST /pin takes an SVG only as an image: plain artwork is pinned, markup that scripts or embeds is refused.
{
  const kv = { m: new Map(), async get(k) { return this.m.get(k) ?? null; }, async put(k, v) { this.m.set(k, v); } };
  const pin = async (svg) => {
    const bytes = Buffer.from(svg);
    globalThis.fetch = async () => new Response(JSON.stringify({ IpfsHash: rawCid(bytes), PinSize: bytes.length }), { status: 200, headers: { 'content-type': 'application/json' } });
    const fd = new FormData();
    fd.append('file', new File([bytes], 'a.svg', { type: 'image/svg+xml' }));
    try { return await worker.fetch(new Request('https://api.test/pin', { method: 'POST', body: fd }), { PINATA_JWT: 'test', UPLOAD_KV: kv }, { waitUntil() {} }); }
    finally { globalThis.fetch = realFetch; }
  };
  const plain = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="#123"/></svg>';
  ok((await pin(plain)).status === 200, 'plain artwork is pinned');
  ok((await pin('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style><rect class="a" width="2" height="2"/></svg>')).status === 200, 'an svg with a style block is pinned');
  for (const [label, svg] of [
    ['a script element', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'],
    ['a script element, spaced and cased', '<svg xmlns="http://www.w3.org/2000/svg">< SCRIPT type="x">1</ScRiPt></svg>'],
    ['an event attribute', '<svg xmlns="http://www.w3.org/2000/svg" onload="1"></svg>'],
    ['a scripted url', '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:1"><rect width="1" height="1"/></a></svg>'],
    ['foreign content', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>'],
  ]) ok((await pin(svg)).status === 415, `${label} is refused`);
}
console.log(`${n} checks`);
