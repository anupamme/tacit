#!/usr/bin/env node
// Writes dapp/swap/tokens.js: the Ethereum rows of the token list registry (token.list.wei, 0x0000006013dF75A31678B786061C2B54bf531524),
// read from the chain here, so the swap card lists them from a module the build versions, with no read when the picker opens. Rows keep the
// registry's own shape (a address, s symbol, n name, d decimals, l logo, c chain, p standard, v verified) for the card's checks; only the
// ERC-20s it lists and the logos it shows are kept. Run it again when the registry gains a token, then `npm run build`.
//
//   node tools/token-list.mjs [--rpc <url>]
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RPC = arg('rpc', 'https://mainnet.gateway.tenderly.co'), REG = '0x0000006013dF75A31678B786061C2B54bf531524';
const SKIP = new Set(['0xae7ab96520de3a18e5e111b5eaab095312d7fe84']);   // stETH: its balance moves by itself, so a swap's amounts drift
const call = async (data) => {
  const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: REG, data }, 'latest'] }) })).json();
  if (j.error) throw new Error(j.error.message);
  return j.result.slice(2);
};
const wordAt = (h, i) => BigInt('0x' + (h.slice(i * 64, i * 64 + 64) || '0'));
const logo = (l) => (typeof l === 'string' && /^data:image\/(svg\+xml|png);base64,[A-Za-z0-9+/=]+$/.test(l) && l.length < 40000 ? l : undefined);

const ids = await call('0xdf7ca268'), n = Number(wordAt(ids, 1));          // the registry's ids
const rows = [];
for (let i = 0; i < n; i++) {
  const h = await call('0x74e18e96' + wordAt(ids, 2 + i).toString(16).padStart(64, '0')), len = Number(wordAt(h, 1));   // one entry, its JSON
  let o = null;
  try { o = JSON.parse(Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8')); } catch { continue; }
  const a = String(o?.a || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a) || (o.c !== 1 && o.c !== 0)) continue;
  const token = o.c === 1 && o.p === 'ERC-20' && o.v && Number.isInteger(o.d) && o.d <= 36 && !SKIP.has(a);
  if (!token && !logo(o.l)) continue;                                          // what is neither listed nor drawn is left out
  rows.push(Object.fromEntries(Object.entries({ a, c: o.c, p: o.p, v: !!o.v, s: String(o.s || '?').slice(0, 12), n: String(o.n || '').slice(0, 40), d: o.d, l: logo(o.l) }).filter(([, v]) => v !== undefined)));
}
const file = new URL('../dapp/swap/tokens.js', import.meta.url);
writeFileSync(file, `// The token list registry's Ethereum rows (token.list.wei, ${REG}), written by tools/token-list.mjs from the chain: what the swap\n// card's picker lists and the logos it draws, with no read when it opens. Do not edit by hand; run the tool again.\nexport const LIST = ${JSON.stringify(rows)};\n`);
console.log(`wrote ${file.pathname}: ${rows.filter((o) => o.c === 1 && o.p === 'ERC-20').length} tokens of ${n} entries (${rows.map((o) => o.s).join(' ')})`);
