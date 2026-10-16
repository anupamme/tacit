// worker/src/prover-proxy.js: /prover/upload and /prover/download only reach the Succinct artifact store's own hosts,
// under the prefixes each direction needs, over https, within their size caps; bytes pass through unchanged.
//
// Run: node --test tests/prover-proxy.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleProverUpload, handleProverDownload, checkArtifactUrl, PROVER_PROXY, PROVER_PROXY_PATHS } from '../worker/src/prover-proxy.js';

const S3 = 'https://spn-artifacts-mainnet.s3.us-east-2.amazonaws.com';
const CDN = 'https://artifacts.mainnet.succinct.xyz';
const PUT_URL = `${S3}/private-stdins/artifact_01m50r4fdkfmhscr1ys75k1dam?x-id=PutObject&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=ab`;
const GET_URL = `${S3}/proofs/artifact_${'6a'.repeat(32)}?x-id=GetObject&X-Amz-Signature=cd`;
const CORS = { 'Access-Control-Allow-Origin': 'https://tacit.finance' };
const UP = { hosts: PROVER_PROXY.uploadHosts, prefixes: PROVER_PROXY.uploadPrefixes };
const DOWN = { hosts: PROVER_PROXY.downloadHosts, prefixes: PROVER_PROXY.downloadPrefixes };

// A stand-in for the artifact store that records what reached it.
function store({ status = 200, body = null, headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, redirect: init.redirect, body: init.body ? new Uint8Array(init.body) : null });
    return new Response(body, { status, headers });
  };
  return { calls, fetchImpl };
}
const upload = (bytes, url = PUT_URL, extra = {}) => new Request('https://api.tacit.finance/prover/upload', {
  method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(url ? { 'x-artifact-url': url } : {}), ...extra }, body: bytes,
});
const download = (body) => new Request('https://api.tacit.finance/prover/download', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('artifact URLs: only the store\'s hosts, https, one object under an allowed prefix', () => {
  assert.equal(checkArtifactUrl(PUT_URL, UP).ok, true);
  assert.equal(checkArtifactUrl(`${S3}/stdins/artifact_01abc?X-Amz-Signature=1`, UP).ok, true);
  assert.equal(checkArtifactUrl(GET_URL, DOWN).ok, true);
  assert.equal(checkArtifactUrl(`${CDN}/proofs/artifact_${'00'.repeat(32)}`, DOWN).ok, true);
  assert.equal(checkArtifactUrl(`${S3}:443/proofs/artifact_x`, DOWN).ok, true);                 // the default port is no port
  const refused = [
    [PUT_URL.replace('https:', 'http:'), UP],                                                       // not https
    [PUT_URL.replace('spn-artifacts-mainnet.s3', 'spn-artifacts-mainnet.s3.evil.com'), UP],
    ['https://evil.com/private-stdins/artifact_1', UP],
    ['https://spn-artifacts-mainnet.s3.us-east-2.amazonaws.com.evil.com/private-stdins/artifact_1', UP],
    ['https://s3.us-east-2.amazonaws.com/spn-artifacts-mainnet/private-stdins/artifact_1', UP],    // path-style: not the store's host
    [`${CDN}/private-stdins/artifact_1`, UP],                                                       // the CDN takes no uploads
    [`${S3}/proofs/artifact_1`, UP],                                                                 // wrong prefix for an upload
    [`${S3}/programs/artifact_1`, DOWN],
    [`${S3}/private-stdins/artifact_1`, DOWN],                                                       // a download never reads an input
    [`${S3}/stdins/artifact_1`, DOWN],
    [`${S3}/proofs/`, DOWN],
    [`${S3}/proofs/a/b`, DOWN],
    [`${S3}/proofs/..%2fprivate-stdins%2fx`, DOWN],
    [`${S3}/proofs/artifact_1#x`, DOWN],
    [`${S3}:8443/proofs/artifact_1`, DOWN],
    ['https://user:pw@spn-artifacts-mainnet.s3.us-east-2.amazonaws.com/proofs/artifact_1', DOWN],
    ['/proofs/artifact_1', DOWN], ['', DOWN], [null, DOWN], [{ url: GET_URL }, DOWN], [`${S3}/proofs/${'a'.repeat(4100)}`, DOWN],
  ];
  for (const [url, rules] of refused) assert.equal(checkArtifactUrl(url, rules).ok, false, String(url).slice(0, 120));
  assert.ok(PROVER_PROXY_PATHS.has('/prover/upload') && PROVER_PROXY_PATHS.has('/prover/download'));
});

test('upload: PUTs the exact bytes to the presigned URL, refuses redirects, reports the store\'s status', async () => {
  const s = store();
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);
  const res = await handleProverUpload(upload(bytes), {}, CORS, s);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, status: 200 });
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://tacit.finance');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, PUT_URL);
  assert.equal(s.calls[0].method, 'PUT');
  assert.equal(s.calls[0].redirect, 'error');
  assert.deepEqual(s.calls[0].body, bytes);

  const denied = store({ status: 403 });
  const r403 = await handleProverUpload(upload(bytes), {}, CORS, denied);
  assert.equal(r403.status, 502);
  assert.deepEqual(await r403.json(), { ok: false, status: 403 });

  const down = { fetchImpl: async () => { throw new TypeError('fetch failed'); } };
  assert.equal((await handleProverUpload(upload(bytes), {}, CORS, down)).status, 502);
});

test('upload: refuses other hosts, http, a missing URL, empty and oversized bodies before touching the store', async () => {
  const s = store();
  const max = PROVER_PROXY.uploadMaxBytes;
  const cases = [
    [upload(Uint8Array.of(1), PUT_URL.replace('https:', 'http:')), 400],
    [upload(Uint8Array.of(1), 'https://evil.com/private-stdins/artifact_1'), 400],
    [upload(Uint8Array.of(1), `${S3}/proofs/artifact_1`), 400],
    [upload(Uint8Array.of(1), null), 400],
    [upload(new Uint8Array(0)), 400],
    [upload(new Uint8Array(max + 1)), 413],
  ];
  for (const [req, status] of cases) {
    const res = await handleProverUpload(req, {}, CORS, s);
    assert.equal(res.status, status);
    assert.equal((await res.json()).ok, false);
  }
  // A body that runs past the cap without declaring its length is cut off while it streams.
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(max / 2 + 1)); c.close(); } });
  const chunked = new Request('https://api.tacit.finance/prover/upload', { method: 'POST', headers: { 'x-artifact-url': PUT_URL }, body: stream, duplex: 'half' });
  assert.equal((await handleProverUpload(chunked, {}, CORS, s)).status, 413);
  // Exactly at the cap is fine.
  assert.equal((await handleProverUpload(upload(new Uint8Array(max)), {}, CORS, s)).status, 200);
  assert.equal(s.calls.length, 1);
});

test('download: returns the artifact bytes from an allowed proof URL', async () => {
  const bytes = Uint8Array.from({ length: 3516 }, (_, i) => (i * 13) & 0xff);
  const s = store({ body: bytes, headers: { 'content-length': String(bytes.length) } });
  const res = await handleProverDownload(download({ url: GET_URL }), {}, CORS, s);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://tacit.finance');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  assert.deepEqual(s.calls.map((c) => [c.url, c.method, c.redirect]), [[GET_URL, 'GET', 'error']]);

  const cdn = store({ body: bytes });
  assert.equal((await handleProverDownload(download({ url: `${CDN}/proofs/artifact_${'00'.repeat(32)}` }), {}, CORS, cdn)).status, 200);
});

test('download: refuses other hosts and prefixes, bad JSON and oversized artifacts', async () => {
  const s = store({ body: Uint8Array.of(1) });
  for (const body of [{ url: 'https://evil.com/proofs/artifact_1' }, { url: GET_URL.replace('https:', 'http:') }, { url: `${S3}/private-stdins/artifact_1` },
    { url: `${S3}/stdins/artifact_1` }, {}, 'not json', JSON.stringify({ url: GET_URL }).padEnd(9000, ' ')]) {
    const res = await handleProverDownload(download(body), {}, CORS, s);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(s.calls.length, 0);

  const max = PROVER_PROXY.downloadMaxBytes;
  const declared = store({ body: Uint8Array.of(1), headers: { 'content-length': String(max + 1) } });
  assert.equal((await handleProverDownload(download({ url: GET_URL }), {}, CORS, declared)).status, 502);
  const big = new ReadableStream({ start(c) { for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); } });
  const streamed = store({ body: big });
  const r = await handleProverDownload(download({ url: GET_URL }), {}, CORS, streamed);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /over/);

  const missing = store({ status: 404 });
  const r404 = await handleProverDownload(download({ url: GET_URL }), {}, CORS, missing);
  assert.equal(r404.status, 502);
  assert.deepEqual(await r404.json(), { ok: false, status: 404 });
});

test('preflight, methods and the off switch', async () => {
  for (const handler of [handleProverUpload, handleProverDownload]) {
    const pre = await handler(new Request('https://api.tacit.finance/prover/x', { method: 'OPTIONS' }), {}, CORS);
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Artifact-Url/);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://tacit.finance');
    assert.equal((await handler(new Request('https://api.tacit.finance/prover/x'), {}, CORS)).status, 405);
    assert.equal((await handler(new Request('https://api.tacit.finance/prover/x', { method: 'OPTIONS' }), { PROVER_PROXY: 'off' }, CORS)).status, 404);
  }
});

test('the API server lets a program input through at the proxy cap, not the anonymous 1 MiB', async () => {
  const { maxRequestBytes, PROVER_UPLOAD_MAX_BYTES, DEFAULT_MAX_ANON_REQUEST_BYTES } = await import('../server/harness.mjs');
  const req = (url) => ({ url, headers: {} });
  assert.equal(PROVER_UPLOAD_MAX_BYTES, PROVER_PROXY.uploadMaxBytes);
  assert.equal(maxRequestBytes({}, req('/prover/upload')), PROVER_PROXY.uploadMaxBytes);
  assert.equal(maxRequestBytes({}, req('/prover/download')), DEFAULT_MAX_ANON_REQUEST_BYTES);
  assert.equal(maxRequestBytes({}, req('/confidential/submit')), DEFAULT_MAX_ANON_REQUEST_BYTES);
});
