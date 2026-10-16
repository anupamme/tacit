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
