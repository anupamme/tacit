// The real points service (src/points-indexer.js) on a temporary database with the token pools' campaign configured, and what its /tokpool
// endpoint and the /rewards funding report say; and with it left unconfigured. Not part of the automatic tests (it starts the service); run
// it after changing how the campaign is wired:
//   node worker-relay/tests/points-tokpool-http.mjs [on|off]
// Every chain RPC points at a dead local port, so nothing reaches the network: the scan fails and is logged, and the view is what it says before any.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openStore } from '../src/lib/points-store.js';

const mode = process.argv[2] || 'on', PORT = 18900 + Math.floor(Math.random() * 300);
const today = Math.floor(Date.now() / 86400e3), DAY = 86400, TAC = 10n ** 18n;
const PU = '0x' + 'ab'.repeat(20), RU = '0x' + 'ac'.repeat(20), PT = '0x' + 'cd'.repeat(20), RT = '0x' + 'ce'.repeat(20), A = '0x' + 'a'.repeat(40);
const dir = mkdtempSync(join(tmpdir(), 'points-tokpool-'));
const db = join(dir, 'p.db');
openStore(db);
const env = {
  ...process.env, PORT: String(PORT), POINTS_DB_PATH: db, RPC_URL: 'http://127.0.0.1:9', RPC_URLS_FALLBACK: 'http://127.0.0.1:9', POINTS_START_BLOCK: '99999999', POINTS_POLL_SECS: '3600',
  POINTS_PROGRAM_START_SEC: String((today - 24) * DAY),
  ...(mode === 'on' ? {
    POINTS_TOKPOOL_SCHEDULE: `${today}:daily=60,cap=0.006;${today + 50}:off`, POINTS_TOKPOOL_POOLS: `${PU}/${RU}=usd,${PT}/${RT}=tac,${PT}=tac`,
    POINTS_TOKPOOL_POCKET_WEI: String(3500n * TAC), POINTS_TOKPOOL_END_SEC: String((today + 53) * DAY), POINTS_TOKPOOL_FROM_BLOCK: '1000', POINTS_TOKPOOL_ADDRESS_USD: '2,500',
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
  const v = await get(`/tokpool?address=${A}`);
  if (mode === 'on') {
    assert.equal(v.enabled, true, JSON.stringify(v));
    assert.deepEqual(v.pocket, { totalWei: String(3500n * TAC), creditedWei: '0', remainingWei: String(3500n * TAC) });
    assert.deepEqual(v.terms, { fromDay: today, dailyWei: String(60n * TAC), capWeiPerUsd: String(6n * TAC / 1000n) });
    assert.deepEqual(v.next, { fromDay: today + 50, off: true }, 'it says when it ends');
    assert.equal(v.endSec, (today + 53) * DAY);
    assert.deepEqual(v.pools.map((p) => [p.pool, p.kind]), [[PU, 'usd'], [PT, 'tac']], 'the pool with no router is refused');
    assert.equal(v.addressUsdWei, String(2500n * TAC), 'a malformed POINTS_TOKPOOL_ADDRESS_USD falls back to $2,500');
    assert.equal(v.minUsdWei, String(10n * TAC));
    assert.equal(v.mine.address, A); assert.equal(v.mine.creditedWei, '0');
    assert.match(out, /token pools' campaign on: 2 pool\(s\), pocket 3500/, 'it says it started');
    assert.match(out, /ignoring POINTS_TOKPOOL_POOLS entry/); assert.match(out, /ignoring POINTS_TOKPOOL_ADDRESS_USD/);
    const r = await get('/tokpool/day/1'); assert.equal(r.error, 'no record for that day');
    console.log('ok - /tokpool with the campaign on:', JSON.stringify({ pocket: v.pocket, terms: v.terms, pools: v.pools.length }));
    // The funding report counts the pocket as owed.
    const rw = await get('/rewards');
    const pk = (rw.pockets || []).find((p) => p.name === 'tokpool');
    assert.ok(pk && pk.remainingWei === String(3500n * TAC), `the funding report lists the pocket: ${JSON.stringify(rw.pockets)}`);
    console.log('ok - /rewards lists the token pools\' pocket:', JSON.stringify(pk));
  } else {
    assert.deepEqual(v, { enabled: false });
    assert.ok(!(await get('/rewards')).pockets?.some((p) => p.name === 'tokpool'));
    assert.doesNotMatch(out, /token pools' campaign/);
    console.log('ok - /tokpool with the campaign off');
  }
} finally {
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
