// tacit-api: the two byte-forwarding routes a page needs to prove with the holder's own Succinct prover-network account
// (dapp/succinct-net.js). The network's artifact store is S3 behind presigned URLs and sends no CORS headers, so a
// browser can neither PUT its program input there nor read the finished proof back. These routes do only that, for
// URLs on the store's own hosts and under the prefixes each direction needs:
//   POST /prover/upload    body: the artifact bytes (application/octet-stream), at most 2 MiB
//                          header X-Artifact-Url: the presigned PUT URL from CreateArtifact (stdins/ or private-stdins/)
//                          → { ok, status } (status is the store's HTTP status)
//   POST /prover/download  body: { "url": presigned GET or CDN URL of a proof artifact (proofs/) }
//                          → the artifact bytes, at most 8 MiB
// Nothing is logged or kept; redirects are refused so a request cannot be steered to another host. The input a page
// uploads is the op's witness, readable here in transit like any request body, which is why it is never written down.

export const PROVER_PROXY = Object.freeze({
  uploadMaxBytes: 2 * 1024 * 1024,
  downloadMaxBytes: 8 * 1024 * 1024,
  uploadHosts: Object.freeze(['spn-artifacts-mainnet.s3.us-east-2.amazonaws.com']),
  downloadHosts: Object.freeze(['spn-artifacts-mainnet.s3.us-east-2.amazonaws.com', 'artifacts.mainnet.succinct.xyz']),
  uploadPrefixes: Object.freeze(['stdins', 'private-stdins']),
  downloadPrefixes: Object.freeze(['proofs']),
  timeoutMs: 30_000,
});
export const PROVER_PROXY_PATHS = new Set(['/prover/upload', '/prover/download']);

const UPLOAD_RULES = { hosts: PROVER_PROXY.uploadHosts, prefixes: PROVER_PROXY.uploadPrefixes };
const DOWNLOAD_RULES = { hosts: PROVER_PROXY.downloadHosts, prefixes: PROVER_PROXY.downloadPrefixes };

// An artifact URL this proxy will touch: https on the default port, no credentials or fragment, a host on the list, and a
// path that is exactly one object name under one of the prefixes. Query strings (the presigned signature) pass as sent.
export function checkArtifactUrl(raw, { hosts, prefixes }) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) return { ok: false, error: 'artifact url required' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'artifact url is not a url' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'artifact url must be https' };
  if (u.username || u.password || u.port || u.hash) return { ok: false, error: 'artifact url has credentials, a port or a fragment' };
  if (!hosts.includes(u.hostname)) return { ok: false, error: 'artifact url is not on the artifact store' };
  const m = /^\/([a-z-]+)\/[A-Za-z0-9_-]{1,200}$/.exec(u.pathname);
  if (!m || !prefixes.includes(m[1])) return { ok: false, error: `artifact url must name one object under ${prefixes.map((p) => p + '/').join(' or ')}` };
  return { ok: true, url: u.toString() };
}

const json = (obj, status, cors) => new Response(JSON.stringify(obj), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const preflight = (cors) => new Response(null, {
  status: 204,
  headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Artifact-Url' },
});

// Read a body stream into memory, stopping as soon as it passes `max` bytes.
class TooLarge extends Error {}
async function readCapped(stream, max) {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch { /* already closed */ } throw new TooLarge(); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
const declaredOver = (headers, max) => {
  const n = Number(headers.get('content-length'));
  return headers.has('content-length') && Number.isFinite(n) && n > max;
};

export async function handleProverUpload(req, env, cors, { fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  if (env && env.PROVER_PROXY === 'off') return json({ ok: false, error: 'not available' }, 404, cors);
  if (req.method === 'OPTIONS') return preflight(cors);
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);
  const target = checkArtifactUrl(req.headers.get('x-artifact-url'), UPLOAD_RULES);
  if (!target.ok) return json({ ok: false, error: target.error }, 400, cors);
  const max = PROVER_PROXY.uploadMaxBytes;
  if (declaredOver(req.headers, max)) return json({ ok: false, error: `body over ${max} bytes` }, 413, cors);
  let body;
  try { body = await readCapped(req.body, max); } catch (e) {
    return e instanceof TooLarge ? json({ ok: false, error: `body over ${max} bytes` }, 413, cors) : json({ ok: false, error: 'could not read the body' }, 400, cors);
  }
  if (!body.length) return json({ ok: false, error: 'empty body' }, 400, cors);
  let res;
  try {
    res = await fetchImpl(target.url, { method: 'PUT', body, redirect: 'error', signal: AbortSignal.timeout(PROVER_PROXY.timeoutMs) });
  } catch {
    return json({ ok: false, error: 'the artifact store did not answer' }, 502, cors);
  }
  try { await res.body?.cancel(); } catch { /* nothing to drain */ }
  return json({ ok: res.ok, status: res.status }, res.ok ? 200 : 502, cors);
}

export async function handleProverDownload(req, env, cors, { fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  if (env && env.PROVER_PROXY === 'off') return json({ ok: false, error: 'not available' }, 404, cors);
  if (req.method === 'OPTIONS') return preflight(cors);
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);
  let url;
  try { url = JSON.parse(new TextDecoder().decode(await readCapped(req.body, 8192)))?.url; } catch {
    return json({ ok: false, error: 'body must be { "url": … }' }, 400, cors);
  }
  const target = checkArtifactUrl(url, DOWNLOAD_RULES);
  if (!target.ok) return json({ ok: false, error: target.error }, 400, cors);
  const max = PROVER_PROXY.downloadMaxBytes;
  let res;
  try {
    res = await fetchImpl(target.url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(PROVER_PROXY.timeoutMs) });
  } catch {
    return json({ ok: false, error: 'the artifact store did not answer' }, 502, cors);
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* nothing to drain */ }
    return json({ ok: false, status: res.status }, 502, cors);
  }
  if (declaredOver(res.headers, max)) {
    try { await res.body?.cancel(); } catch { /* nothing to drain */ }
    return json({ ok: false, error: `artifact over ${max} bytes` }, 502, cors);
  }
  let bytes;
  try { bytes = await readCapped(res.body, max); } catch (e) {
    return json({ ok: false, error: e instanceof TooLarge ? `artifact over ${max} bytes` : 'the artifact store broke off' }, 502, cors);
  }
  return new Response(bytes, {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
