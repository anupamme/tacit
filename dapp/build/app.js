// tacit.finance/build: a copy button on every code block, and the contents column marks the section in view.
// The page reads in full without this script.

for (const box of document.querySelectorAll('.code')) {
  const pre = box.querySelector('pre');
  if (!pre) continue;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cp';
  btn.textContent = 'Copy';
  btn.addEventListener('click', async () => {
    const text = pre.innerText.replace(/\n$/, '');
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = 'Selected';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
  });
  box.appendChild(btn);
}

const links = new Map([...document.querySelectorAll('.toc a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));
const parts = [...document.querySelectorAll('.part[id]')].filter((s) => links.has(s.id));
if ('IntersectionObserver' in window && parts.length) {
  const seen = new Set();
  const mark = () => {
    const first = parts.find((s) => seen.has(s.id));
    for (const [id, a] of links) a.classList.toggle('on', !!first && id === first.id);
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) (e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id));
    mark();
  }, { rootMargin: '-10% 0px -70% 0px' });
  for (const s of parts) io.observe(s);
}
