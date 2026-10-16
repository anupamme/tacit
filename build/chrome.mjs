// The header's links and the footer, made once and stamped into every page that wears them (build.mjs calls this and
// `--verify-only` fails when a page differs). The styles are dapp/chrome.css and the one script dapp/chrome.js, which
// only closes the menu; without it the menu still opens and shuts, as a <details>.
//
// A page marks where they go:
//   <!-- chrome:nav:begin -->…<!-- chrome:nav:end -->     the page links, inside the header's .top-r, before the page's own chips
//   <!-- chrome:foot:begin -->…<!-- chrome:foot:end -->   the footer; `label="…"` and `id="…"` on the begin marker name the left-hand text
//   <!-- chrome:head:begin -->…<!-- chrome:head:end -->   the stylesheet and script, last in the head, tokens taken from the files
// What belongs to one page alone (the Secret Sats papers, the pool's addresses on each chain) is the page's own, in a
// `<nav class="sf-x">` above the footer.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// page → which link is the page it is ('' for none); a page not listed here does not wear the chrome
export const CHROME_PAGES = {
  'index.html': '', 'swap/index.html': 'swap', 'trade/index.html': 'trade', 'trade/teth/index.html': 'trade', 'trade/cbtc/index.html': 'trade',
  'vault/index.html': 'borrow', 'pay/index.html': 'pay', 'pay/eth/index.html': 'pay', 'tac/index.html': 'tac', 'tasks/index.html': 'tasks',
  'build/index.html': 'build', 'weld/stats/index.html': 'stats', 'weld/keeper/index.html': 'community', 'relay/index.html': '',
  'splitter/index.html': '', 'sats/index.html': '',
};

// 24×24 line drawings, the lander's tabs' hand; drawn by chrome.css (stroke, round caps) unless a glyph is .fill
const G = {
  swap: '<path d="M4 8h15l-4-4"/><path d="M20 16H5l4 4"/>',
  trade: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  pay: '<path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/>',
  borrow: '<path d="M3 9.5L12 4l9 5.5"/><path d="M5.5 10v8M10 10v8M14 10v8M18.5 10v8"/><path d="M3 20.5h18"/>',
  more: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.7"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.7"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.7"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.7"/>',
  tac: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  tasks: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  build: '<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/><path d="M14 4l-4 16"/>',
  stats: '<path d="M5 20v-6"/><path d="M12 20V5"/><path d="M19 20v-10"/>',
  community: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16.5 5.3a3 3 0 0 1 0 5.6"/><path d="M18 14.2c1.8.7 3 2.6 3 5.8"/>',
  classic: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18"/>',
  paper: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  contract: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>',
  llama: '<path d="M21.2 15.9A10 10 0 1 1 8 2.8"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  github: '<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
  x: '<path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/>',
};
const FILLED = new Set(['github', 'x']);
const svg = (k) => `<svg viewBox="0 0 24 24"${FILLED.has(k) ? ' class="fill"' : ''} aria-hidden="true">${G[k]}</svg>`;

// the four places most people come for, always in the header (icons below ~880px, a menu entry on a phone); the rest are in the menu
const MAIN = [['swap', '/swap/', 'Swap'], ['trade', '/trade/tac/', 'Trade'], ['pay', '/pay/', 'Pay'], ['borrow', '/vault/', 'Borrow']];
const MORE = [['tac', '/tac/', 'Shielded TAC'], ['tasks', '/tasks/', 'Tasks'], ['build', '/build/', 'Build'], ['stats', '/weld/stats/', 'Stats'], ['community', '/weld/keeper/', 'Community ops'], ['classic', '/classic.html', 'Classic app']];

const here = (key, k) => (key === k ? ' aria-current="page"' : '');

export function navHtml(key) {
  const main = MAIN.map(([k, href, name]) => `<a href="${href}" title="${name}"${here(key, k)}>${svg(k)}<span>${name}</span></a>`).join('\n    ');
  const phone = MAIN.map(([k, href, name]) => `<a class="pr" href="${href}"${here(key, k)}>${svg(k)}${name}</a>`).join('\n      ');
  const more = MORE.map(([k, href, name]) => `<a href="${href}"${here(key, k)}>${svg(k)}${name}</a>`).join('\n      ');
  const inMenu = MORE.some(([k]) => k === key);
  return `<nav class="sn" aria-label="Pages">
    ${main}
    <details class="sm">
      <summary aria-label="More pages" title="More"${inMenu ? ' class="here"' : ''}>${svg('more')}</summary>
      <div class="sm-p">
      ${phone}
      <hr class="pr">
      ${more}
      </div>
    </details>
  </nav>`;
}

// outward links: what it is, where it is kept, who is watching it. Icons, each named for a screen reader and a hover.
const OUT = [
  ['paper', 'Whitepaper', '/tacit-v1.pdf'],
  ['lock', 'Security', 'https://github.com/src-company/tacit/blob/main/SECURITY.md'],
  ['github', 'Source', 'https://github.com/src-company/tacit'],
  ['contract', 'Pool contract', 'https://etherscan.io/address/0x000000000Ed1eabD231Be41d93b719056F7febFC'],
  ['llama', 'DefiLlama', 'https://defillama.com/protocol/tacit'],
  ['x', '@tacitfi on X', 'https://x.com/tacitfi'],
];
export function footHtml(label = 'tacit.finance · mainnet', id = '') {
  const links = OUT.map(([k, name, href]) => `<a href="${href}" title="${name}" aria-label="${name}"${href.startsWith('/') ? '' : ' target="_blank" rel="noopener noreferrer"'}>${svg(k)}</a>`).join('\n    ');
  return `<footer class="sf">
  <span${id ? ` id="${id}"` : ''}>${label}</span>
  <nav aria-label="Elsewhere">
    ${links}
  </nav>
</footer>`;
}

const token = (dapp, file) => createHash('sha256').update(readFileSync(join(dapp, file))).digest('hex').slice(0, 8);
export const headHtml = (dapp) => `<link rel="stylesheet" href="/chrome.css?cb=${token(dapp, 'chrome.css')}">\n<script src="/chrome.js?cb=${token(dapp, 'chrome.js')}" defer></script>`;

// a block is the begin marker's line, what is stamped (indented as the marker is) and the end marker's line
const BLOCK = (name) => new RegExp(`^([ \\t]*)(<!-- chrome:${name}:begin([^>]*?)-->)[\\s\\S]*?<!-- chrome:${name}:end -->`, 'm');
const attr = (s, k) => (new RegExp(`${k}="([^"]*)"`).exec(s) || [])[1];
const block = (name, ind, begin, html) => `${ind}${begin}\n${html.replace(/^/gm, ind)}\n${ind}<!-- chrome:${name}:end -->`;

// the page as it should be; throws when a page lacks a marker, so a page cannot quietly go without
export function chromePage(text, rel, dapp) {
  const key = CHROME_PAGES[rel];
  let out = text;
  for (const name of ['nav', 'foot', 'head']) if (!BLOCK(name).test(out)) throw new Error(`${rel} has no chrome:${name} markers`);
  out = out.replace(BLOCK('nav'), (m, ind, begin) => block('nav', ind, begin, navHtml(key)));
  out = out.replace(BLOCK('foot'), (m, ind, begin, params) => block('foot', ind, begin, footHtml(attr(params, 'label'), attr(params, 'id'))));
  out = out.replace(BLOCK('head'), (m, ind, begin) => block('head', ind, begin, headHtml(dapp)));
  return out;
}
