#!/usr/bin/env node
// Removes the comments from JavaScript files, in place, and proves that nothing else changed.
//
//   node build/strip-comments.mjs dapp/tacit.js dapp/confidential-pool.js
//
// The site is served as these files, byte for byte, and its host compresses them with a quick setting: the comments of tacit.js were 45% of what a visitor
// downloaded for it. A file is rewritten only when esbuild minifies the original and the stripped text to the same output (minifying drops every comment and
// prints a program the same way every time), so the program is the same one; otherwise the file is left alone and the command fails. Comments the code depends on
// (`/*! … */`, @license, @preserve, source maps, bundler hints) stay, and so does a first line `#!`. A file that has been stripped has nothing left to strip.
//
// The scanner follows strings, template literals (with their `${}` holes), regular expressions and comments; a regular expression is told from a division by
// the token before it. A mistake there cannot get past the check above.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const KEEP = /^\/\*!|@license|@preserve|sourceMappingURL|@vite-ignore|webpackIgnore|webpackChunkName|#__PURE__|@__PURE__|@ts-/;
const WORD_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'instanceof', 'yield', 'await', 'extends']);
const isIdChar = (c) => /[\w$\u0080-￿]/.test(c);

// The comments of `src` as [start, end] ranges, in order, with the comments that must stay left out.
export function commentRanges(src) {
  const out = [], n = src.length, braces = [];   // braces: for each open template `${`, the depth of plain braces inside it
  let i = 0, last = '', lastWord = '';           // the last significant character and, when it ends a word, that word
  const regexAllowed = () => {
    if (!last) return true;
    if (last === ')' || last === ']' || last === '}') return false;
    if (isIdChar(last)) return WORD_BEFORE_REGEX.has(lastWord);
    if (last === '"' || last === "'" || last === '`') return false;
    return true;                                  // an operator or an opening bracket
  };
  if (src.startsWith('#!')) i = src.indexOf('\n') < 0 ? n : src.indexOf('\n');
  let tdepth = 0;                                 // open template literals
  const stack = [];                               // 'tpl' frames: depth of braces inside a `${`
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      let e = src.indexOf('\n', i); if (e < 0) e = n;
      if (!KEEP.test(src.slice(i, e))) out.push([i, e]);
      i = e; continue;
    }
    if (c === '/' && d === '*') {
      let e = src.indexOf('*/', i + 2); e = e < 0 ? n : e + 2;
      if (!KEEP.test(src.slice(i, e))) out.push([i, e]);
      i = e; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      i = j + 1; last = c; lastWord = ''; continue;
    }
    if (c === '`') {                              // a template: its text, up to a `${` or the closing backtick
      let j = i + 1;
      for (;;) {
        if (j >= n) break;
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') { j++; last = '`'; lastWord = ''; break; }
        if (src[j] === '$' && src[j + 1] === '{') { stack.push(braces.length); braces.push(0); tdepth++; j += 2; last = '{'; lastWord = ''; break; }
        j++;
      }
      i = j; continue;
    }
    if (c === '{') { if (braces.length) braces[braces.length - 1]++; last = '{'; lastWord = ''; i++; continue; }
    if (c === '}') {
      if (braces.length && braces[braces.length - 1] === 0) {   // the end of a `${…}` hole: back into the template's text
        braces.pop(); stack.pop(); tdepth--;
        let j = i + 1;
        for (;;) {
          if (j >= n) break;
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '`') { j++; last = '`'; lastWord = ''; break; }
          if (src[j] === '$' && src[j + 1] === '{') { stack.push(braces.length); braces.push(0); tdepth++; j += 2; last = '{'; lastWord = ''; break; }
          j++;
        }
        i = j; continue;
      }
      if (braces.length) braces[braces.length - 1]--;
      last = '}'; lastWord = ''; i++; continue;
    }
    if (c === '/') {
      if (regexAllowed()) {                        // a regular expression literal: up to the closing slash outside a class, then its flags
        let j = i + 1, cls = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
          j++;
        }
        j++;
        while (j < n && isIdChar(src[j])) j++;
        i = j; last = ')'; lastWord = ''; continue;
      }
      last = '/'; lastWord = ''; i++; continue;
    }
    if (isIdChar(c)) {
      let j = i; while (j < n && isIdChar(src[j])) j++;
      lastWord = src.slice(i, j); last = src[j - 1]; i = j; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    last = c; lastWord = ''; i++;
  }
  return out;
}

// `src` without its comments, a line that held only a comment going with it and a blank line that two such removals would leave doubled going too.
export function stripComments(src) {
  const ranges = commentRanges(src);
  if (!ranges.length) return src;
  const lines = src.split('\n'), starts = [];
  let pos = 0;
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }
  const lineOf = (p) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= p) lo = m; else hi = m - 1; } return lo; };
  const edits = new Array(lines.length).fill(null).map(() => []);   // per line: [from, to] offsets within the line to cut
  const drop = new Set(), prefix = new Map();                      // lines removed whole; the indentation a line takes over from a comment that stood before it
  for (const [s, e] of ranges) {
    const a = lineOf(s), b = lineOf(e - 1 < s ? s : e - 1);
    const before = src.slice(starts[a], s), after = src.slice(e, starts[b] + lines[b].length);
    if (!before.trim() && !after.trim()) { for (let k = a; k <= b; k++) drop.add(k); continue; }
    if (a === b) {
      let from = s - starts[a], to = e - starts[a];
      if (!after.trim()) from -= before.length - before.trimEnd().length;                  // a trailing comment takes the space before it
      else if (/\s$/.test(before) && /^\s/.test(after)) to += 1;                           // a comment between two spaces leaves one
      edits[a].push([from, to]);
    } else if (!before.trim()) {                                                          // a block comment over several lines, then code on its last line: that code takes the comment's place
      for (let k = a; k < b; k++) drop.add(k);
      edits[b].push([0, e - starts[b] + (/^\s/.test(after) ? 1 : 0)]);
      prefix.set(b, before);
    } else {                                                                              // code before it on its first line (and maybe after it on its last): the line break stays
      edits[a].push([s - starts[a] - (before.length - before.trimEnd().length), lines[a].length]);
      for (let k = a + 1; k < b; k++) drop.add(k);
      edits[b].push([0, e - starts[b]]);
    }
  }
  const kept = [];
  for (let k = 0; k < lines.length; k++) {
    if (drop.has(k)) { kept.push(null); continue; }
    let l = lines[k];
    for (const [from, to] of edits[k].slice().sort((x, y) => y[0] - x[0])) l = l.slice(0, from) + l.slice(to);
    kept.push((prefix.get(k) || '') + l);
  }
  const out = [];
  let cut = false;
  for (const l of kept) {
    if (l === null) { cut = true; continue; }
    if (cut && l.trim() === '' && out.length && out[out.length - 1].trim() === '') { cut = false; continue; }   // a blank line on each side of a cut: one stays
    cut = false; out.push(l);
  }
  return out.join('\n');
}

// Minifying prints no comment at all (the plain printer keeps some, such as the one before a method), and the same program always minifies to the same text.
export function sameProgram(esbuild, a, b) {
  const opts = { loader: 'js', format: 'esm', target: 'esnext', legalComments: 'none', minify: true };
  return esbuild.transformSync(a, opts).code === esbuild.transformSync(b, opts).code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const esbuild = require('esbuild');
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node build/strip-comments.mjs <file.js> …'); process.exit(2); }
  let failed = 0, saved = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8'), out = stripComments(src);
    if (out === src) { console.log(`${f}: no comments to strip`); continue; }
    if (!sameProgram(esbuild, src, out)) { console.error(`${f}: the stripped text is not the same program: left as it was`); failed++; continue; }
    writeFileSync(f, out);
    saved += src.length - out.length;
    console.log(`${f}: ${src.length} → ${out.length} bytes`);
  }
  console.log(`${saved} bytes of comments removed`);
  process.exit(failed ? 1 : 0);
}
