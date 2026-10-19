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
