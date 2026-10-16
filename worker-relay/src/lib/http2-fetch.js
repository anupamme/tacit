// A fetch-shaped HTTP/2 client. Succinct's RPC (rpc.mainnet.succinct.xyz) answers gRPC-web only over HTTP/2: Node's
// built-in fetch speaks HTTP/1.1 and gets HTTP 464 from its load balancer. One session per origin is kept open and
// unref'd, so an idle process can exit; `close()` ends them all. (Browsers negotiate HTTP/2 on their own.)

import http2 from 'node:http2';

export function http2Fetch({ timeoutMs = 60_000 } = {}) {
  const sessions = new Map();
  const session = (origin) => {
    let s = sessions.get(origin);
    if (s && !s.closed && !s.destroyed) return s;
    s = http2.connect(origin);
    s.on('error', () => sessions.delete(origin));
    s.on('close', () => sessions.delete(origin));
    s.unref();
    sessions.set(origin, s);
    return s;
  };
  async function fetch2(input, init = {}) {
    const url = new URL(String(input));
    const headers = { ':method': init.method || 'GET', ':path': url.pathname + url.search };
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    const body = init.body == null ? null : Buffer.from(init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : init.body);
    return new Promise((resolve, reject) => {
      const s = session(url.origin);
      s.ref();
      const req = s.request(headers, { endStream: !body });
      const chunks = [];
      let status = 0, head = {};
      const timer = setTimeout(() => req.close(http2.constants.NGHTTP2_CANCEL), timeoutMs);
      req.on('response', (h) => { status = Number(h[':status']); head = h; });
      req.on('trailers', (t) => { head = { ...head, ...t }; });
      req.on('data', (c) => chunks.push(c));
      req.on('error', (e) => { clearTimeout(timer); s.unref(); reject(e); });
      req.on('close', () => {
        clearTimeout(timer);
        s.unref();
        if (!status) { reject(new Error(`http2: no response from ${url.origin}`)); return; }
        const h = new Headers();
        for (const [k, v] of Object.entries(head)) if (!k.startsWith(':')) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: h }));
      });
      if (body) req.end(body);
    });
  }
  fetch2.close = () => { for (const s of sessions.values()) s.close(); sessions.clear(); };
  return fetch2;
}
