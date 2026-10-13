// A sheet over the trade page: a title with a close button over a body, closed by its button, by Escape or by a press outside it. The
// Bitcoin market module's own confirmations are fixed layers at z-index 1005, so a wide sheet sits below them and the small dialogs
// (sign-in, wallet picker, pairing, confirm) above them.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function overlay({ title, wide = false, top = false, onClose = null }) {
  const root = document.createElement('div');
  root.className = `bsheet${wide ? ' wide' : ''}${top ? ' top' : ''}`;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', title);
  root.innerHTML = `<div class="bsheet-in"><div class="bsheet-head"><h2 tabindex="-1">${esc(title)}</h2><button class="x" type="button" aria-label="Close">×</button></div><div class="bsheet-body"></div></div>`;
  document.body.append(root);
  const prev = document.activeElement, body = root.querySelector('.bsheet-body');
  let closed = false;
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.bm-modal') && !root.nextElementSibling?.classList.contains('bsheet')) { e.stopPropagation(); close(); } };
  const close = () => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey, true); root.remove(); try { prev?.focus?.(); } catch { /* the opener may be gone */ } onClose?.(); };
  document.addEventListener('keydown', onKey, true);
  root.querySelector('.x').onclick = close;
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  setTimeout(() => root.querySelector('h2')?.focus(), 0);
  return { root, body, close, get closed() { return closed; } };
}
