#!/usr/bin/env node
// Writes dapp/swap/uni-tokens.js and dapp/swap/logos/: the Ethereum tokens of the Uniswap Labs default list (tokens.uniswap.org), for the
// swap card's picker beside the token list registry's own rows (dapp/swap/tokens.js), which win where both name a token. Each logo is
// fetched here once, cut to 64px and kept as WebP under dapp/swap/logos/<address>.webp, so the page draws it from its own origin: no
// image host is asked, or told which tokens a visitor looks at. Rows are { a address, s symbol, n name, d decimals, l 1 when a logo is
// kept }. Run it again to take a newer list, then `npm run build`. Needs cwebp (brew install webp).
//
//   node tools/uniswap-list.mjs [--list <url>]
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const LIST = arg('list', 'https://tokens.uniswap.org');
const SKIP = new Set(['0xae7ab96520de3a18e5e111b5eaab095312d7fe84']);   // stETH: its balance moves by itself, so a swap's amounts drift
const DAPP = new URL('../dapp/swap/', import.meta.url).pathname, LOGOS = join(DAPP, 'logos');

// the registry's rows draw their own logos (data: URIs in tokens.js): none is fetched for them
const reg = readFileSync(join(DAPP, 'tokens.js'), 'utf8'), drawn = new Set([...reg.matchAll(/"a":"(0x[0-9a-f]{40})"[^}]*"l":"data:/g)].map((m) => m[1]));

const list = await (await fetch(LIST)).json();
const rows = [], seen = new Set();
for (const t of list.tokens || []) {
  const a = String(t?.address || '').toLowerCase();
  if (t?.chainId !== 1 || !/^0x[0-9a-f]{40}$/.test(a) || seen.has(a) || SKIP.has(a) || !Number.isInteger(t.decimals) || t.decimals > 36) continue;
  seen.add(a);
  rows.push({ a, s: String(t.symbol || '?').slice(0, 12), n: String(t.name || '').slice(0, 40), d: t.decimals, uri: t.logoURI });
}

// a logo, cut to 64px WebP; one that cannot be read is left to the card's lettered mark
mkdirSync(LOGOS, { recursive: true });
const tmp = join(tmpdir(), 'tacit-uni-logo');
async function keepLogo(r) {
  const out = join(LOGOS, `${r.a}.webp`);
  if (drawn.has(r.a)) return false;
  if (existsSync(out)) return true;
  if (!/^https:\/\//.test(r.uri || '') || /\.svg(\?|$)/i.test(r.uri)) return false;
  try {
    const res = await fetch(r.uri, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return false;
    const src = `${tmp}-${r.a}`;
    writeFileSync(src, Buffer.from(await res.arrayBuffer()));
    try { execFileSync('cwebp', ['-quiet', '-q', '82', '-resize', '64', '64', src, '-o', out]); } finally { unlinkSync(src); }
    return existsSync(out);
  } catch { return false; }
}
for (let i = 0; i < rows.length; i += 8) {
  const part = rows.slice(i, i + 8), got = await Promise.all(part.map(keepLogo));
  part.forEach((r, j) => { if (got[j]) r.l = 1; });
}
// a logo kept from an earlier list whose token is no longer on it goes
const keep = new Set(rows.filter((r) => r.l).map((r) => `${r.a}.webp`));
for (const f of readdirSync(LOGOS)) if (!keep.has(f)) unlinkSync(join(LOGOS, f));

const out = rows.map(({ uri, ...r }) => r);
writeFileSync(join(DAPP, 'uni-tokens.js'), `// The Ethereum tokens of the Uniswap Labs default list (${LIST}, v${list.version?.major}.${list.version?.minor}.${list.version?.patch}), written by
// tools/uniswap-list.mjs: what the swap card's picker lists beside the token list registry's rows, with each kept logo at /swap/logos/<a>.webp.
// Do not edit by hand; run the tool again.
export const UNI = ${JSON.stringify(out)};
`);
console.log(`wrote ${out.length} tokens, ${out.filter((r) => r.l).length} logos (${drawn.size} drawn by the registry)`);
