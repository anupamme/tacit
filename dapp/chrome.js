// The header's menu closes on Escape, on a click or a tab outside it, and when a page is chosen. It is a <details>, so it opens and shuts without this.
(() => {
  const m = document.querySelector('.sm');
  if (!m) return;
  const shut = () => { m.open = false; };
  document.addEventListener('click', (e) => { if (m.open && !m.contains(e.target)) shut(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && m.open) { shut(); m.querySelector('summary').focus(); } });
  m.addEventListener('focusout', (e) => { if (e.relatedTarget && !m.contains(e.relatedTarget)) shut(); });
  m.addEventListener('click', (e) => { if (e.target.closest('.sm-p a')) shut(); });
})();

// The pages share one service worker (dapp/sw.js). It keeps a versioned file (a ?cb= URL whose token matches its bytes) and answers for it from disk, so a
// repeat visit asks the network for the page and little else. It is registered once the page has loaded, and a page works the same without it.
(() => {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  // Under browser automation it is left out unless a test asks for it (window.__tacitSw): a page the worker controls is out of reach of a harness's own request mocks.
  if (navigator.webdriver && !window.__tacitSw) return;
  const register = () => setTimeout(() => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}), 1500);
  if (document.readyState === 'complete') register(); else addEventListener('load', register, { once: true });
})();

// A tab left open across a deploy keeps running the code it loaded. When the page is shown again (and every ten minutes while it
// is, no oftener) it asks for its own address with HEAD; another ETag means the page has changed since, and one line offers a reload.
(() => {
  if (!/^https?:$/.test(location.protocol) || typeof fetch !== 'function') return;
  if (navigator.webdriver && !window.__tacitUpd) return;
  const EVERY = 10 * 60e3;
  let mine = null, at = 0, said = false;
  // the same bytes carry a weak tag uncompressed and a strong one compressed, so the W/ is not part of the comparison
  const tag = () => fetch(location.pathname, { method: 'HEAD', cache: 'no-store' }).then((r) => (r.ok ? (r.headers.get('etag') || '').replace(/^W\//, '') || null : null), () => null);
  const say = () => {
    said = true;
    const bar = document.createElement('div'), go = document.createElement('button');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:60;display:flex;gap:12px;align-items:center;'
      + 'max-width:calc(100% - 32px);box-sizing:border-box;padding:10px 14px;border:1px solid var(--hair,#ddd);border-radius:12px;'
      + 'background:var(--card,#fff);color:var(--ink,#111);font:500 12.5px/1.3 var(--mono,monospace);box-shadow:0 6px 24px rgba(0,0,0,.14)';
    bar.textContent = 'This page has been updated.';
    go.type = 'button';
    go.textContent = 'Reload';
    go.style.cssText = 'flex:none;border:0;background:none;padding:0;color:var(--orange,#c2410c);font:inherit;cursor:pointer';
    go.addEventListener('click', () => location.reload());
    bar.append(go);
    document.body.append(bar);
  };
  const check = async () => {
    if (said || document.hidden || !mine || Date.now() - at < EVERY) return;
    at = Date.now();
    const now = await tag();
    if (now && now !== mine) say();
  };
  const start = () => tag().then((t) => { mine = t; at = Date.now(); });
  if (document.readyState === 'complete') start(); else addEventListener('load', start, { once: true });
  document.addEventListener('visibilitychange', check);
  setInterval(check, 60e3);
})();
