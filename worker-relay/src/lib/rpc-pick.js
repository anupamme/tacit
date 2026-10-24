// The first endpoint of a list that answers what a run is about to ask of it.
//
// A binary that takes one RPC URL fails its whole run when that one provider rate-limits. Asking each
// candidate the run's own questions first, in order, and handing the binary the first that answers them all
// turns a throttled provider into a slower pick instead of a failed cycle. When none answers, the first URL
// is returned, so the run fails the way it did before there was a list.
//
// `probe(rpc)` throws unless the endpoint will do; `rpc(method, params)` is one JSON-RPC call to it. A URL can
// carry an access key, so only its host is ever reported.

export const hostOf = (url) => { try { return new URL(url).host; } catch { return '?'; } };

export async function pickRpc(urls, probe, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const list = [...new Set((urls || []).filter(Boolean))];
  const failures = [];
  for (const url of list) {
    const rpc = async (method, params) => {
      const r = await fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.error || !('result' in j)) throw new Error(`${method}: ${j?.error?.message || `HTTP ${r.status}`}`);
      return j.result;
    };
    try {
      await probe(rpc);
      return { url, failures };
    } catch (e) {
      failures.push(`${hostOf(url)} (${String(e?.message || e).slice(0, 80)})`);
    }
  }
  return { url: list[0], failures };
}
