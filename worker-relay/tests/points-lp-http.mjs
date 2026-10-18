// The real points service (src/points-indexer.js) on a temporary database with the liquidity campaign configured, and what its /lp endpoint says; and with it left
// unconfigured. Not part of the automatic tests (it starts the service); run it after changing how the campaign is wired:
//   node worker-relay/tests/points-lp-http.mjs [on|off]
// Every chain RPC points at a dead local port, so nothing reaches the network: the scan and the samples fail and are logged, and the view is what it says before any.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openStore } from '../src/lib/points-store.js';

const mode = process.argv[2] || 'on', PORT = 18600 + Math.floor(Math.random() * 300);
const today = Math.floor(Date.now() / 86400e3), DAY = 86400, TAC = 10n ** 18n;
const POOL = '0x' + 'ab'.repeat(20), A = '0x' + 'a'.repeat(40);
const dir = mkdtempSync(join(tmpdir(), 'points-lp-'));
const db = join(dir, 'p.db');
openStore(db);
const env = {
  ...process.env, PORT: String(PORT), POINTS_DB_PATH: db, RPC_URL: 'http://127.0.0.1:9', RPC_URLS_FALLBACK: 'http://127.0.0.1:9', POINTS_START_BLOCK: '99999999', POINTS_POLL_SECS: '3600',
  POINTS_PROGRAM_START_SEC: String((today - 24) * DAY),
  ...(mode === 'on' ? {
    POINTS_LP_SCHEDULE: `${today}:daily=25,create=150,cap=0.05;${today + 30}:off`, POINTS_LP_POOLS: `${POOL}=1`, POINTS_LP_POCKET_WEI: String(1500n * TAC),
    POINTS_LP_END_SEC: String((today + 35) * DAY), POINTS_LP_FROM_BLOCK: '1000',
  } : {}),
};
const child = spawn('node', ['src/points-indexer.js'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let up = false;
  for (let i = 0; i < 80 && !up && child.exitCode === null; i++) { await sleep(500); up = /http listening/.test(out); }
  assert.ok(up, `the service did not start:\n${out.slice(-1200)}`);
  const v = await get(`/lp?address=${A}`);
  if (mode === 'on') {
    assert.equal(v.enabled, true, JSON.stringify(v));
    assert.equal(v.pocket.totalWei, String(1500n * TAC)); assert.equal(v.pocket.creditedWei, '0'); assert.equal(v.pocket.remainingWei, String(1500n * TAC));
    assert.equal(v.terms.dailyWei, String(25n * TAC)); assert.equal(v.terms.createWei, String(150n * TAC)); assert.equal(v.terms.capWeiPerUsdDay, String(TAC / 20n));
    assert.equal(v.next.fromDay, today + 30); assert.equal(v.endSec, (today + 35) * DAY);
    assert.deepEqual(v.pools.map((p) => [p.pool, p.opened, p.openPaid, p.weightBps, p.mineUsdWei]), [[POOL, false, false, '10000', '0']]);
    assert.equal(v.mine.address, A); assert.equal(v.mine.creditedWei, '0');
    assert.match(out, /liquidity campaign on: 1 pool\(s\), pocket 1500/, 'it says it started');
    const bad = await get('/lp?address=nope'); assert.equal(bad.enabled, true); assert.equal(bad.mine, undefined, 'a bad address asks for no account');
    console.log('ok - /lp with the campaign on:', JSON.stringify({ pocket: v.pocket, terms: v.terms, pools: v.pools.length }));
  } else {
    assert.deepEqual(v, { enabled: false });
    assert.doesNotMatch(out, /liquidity campaign on/);
    console.log('ok - /lp with the campaign off:', JSON.stringify(v));
  }
  const lb = await get('/leaderboard?day=today&limit=1');
  assert.ok(lb.program, 'the rest of the service is unaffected');
} finally {
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
