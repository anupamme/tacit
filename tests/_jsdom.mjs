// The one place the tests get jsdom from:  `import { JSDOM } from './_jsdom.mjs'`  (or `const { JSDOM } = await import('./_jsdom.mjs')`)
// in place of `from 'jsdom'`.
//
// Why: the repo root declares jsdom 30, which needs Node 22+ (it require()s ES modules), while tests/package.json declares jsdom 24, which runs on
// Node 18+. A checkout where `cd tests && npm install` was never run (a fresh git worktree, which has no tests/node_modules) resolves the bare
// 'jsdom' to the root one and dies on Node 20 with ERR_REQUIRE_ESM. This loader takes the first jsdom that loads on the Node it is running under and
// can build a document:
//   1. $JSDOM_ROOT, a directory that has node_modules/jsdom (e.g. JSDOM_ROOT=/Users/z/zFi/ node tests/<name>.test.mjs)
//   2. the normal resolution from this directory: tests/node_modules, then the repo's node_modules
//   3. the main checkout's tests/ and root node_modules, when this is a git worktree of it
// If none works it says what was tried and how to fix it.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const firstLine = (e) => `${e?.code || e?.name || 'Error'}: ${String(e?.message || e).split('\n')[0]}`;
const asDir = (p) => (p.endsWith(sep) ? p : p + sep);
const mainCheckout = () => {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return dirname(resolve(HERE, common));
  } catch { return null; }
};

// A loaded jsdom is only accepted once it has built a page: the failure on an old Node is at load time, but a half-working install should not pass either.
const works = (m) => {
  if (typeof m?.JSDOM !== 'function') throw new Error('no JSDOM export');
  new m.JSDOM('<!doctype html><p>x').window.close();
  return m;
};

export async function loadJsdom() {
  const tried = [];
  const attempt = async (label, load) => {
    try { return works(await load()); } catch (e) { tried.push(`  ${label}: ${firstLine(e)}`); return null; }
  };
  const fromRoot = (root) => () => createRequire(asDir(resolve(root)))('jsdom');

  if (process.env.JSDOM_ROOT) {
    const m = await attempt(`JSDOM_ROOT=${process.env.JSDOM_ROOT}`, fromRoot(process.env.JSDOM_ROOT));
    if (m) return m;
  }
  let m = await attempt('jsdom resolved from tests/', async () => { const ns = await import('jsdom'); return ns.default?.JSDOM ? ns.default : ns; });
  if (m) return m;
  const main = mainCheckout();
  if (main && resolve(main) !== resolve(HERE, '..')) {
    for (const dir of [resolve(main, 'tests'), main]) {
      m = await attempt(`${dir}/node_modules`, fromRoot(dir));
      if (m) return m;
    }
  }
  throw new Error(`no jsdom that loads on Node ${process.versions.node} was found. Tried:\n${tried.join('\n')}\n` +
    '  Fix: run `npm install` in tests/ (jsdom 24, works on Node 18+; the root package.json jsdom 30 needs Node 22+),\n' +
    '  or point JSDOM_ROOT at a directory that has node_modules/jsdom (JSDOM_ROOT=/path/to/project/ node tests/<name>.test.mjs).');
}

const jsdom = await loadJsdom();
export const { JSDOM, VirtualConsole, CookieJar } = jsdom;
export default jsdom;
