// The real points service (src/points-indexer.js) on a temporary database seeded with a day's activity, with a schedule of reserved budgets configured,
// and what its HTTP endpoints say: the board and the groups on it, an address's TAC so far, the program's terms, and the preview of a schedule that
// has not started. Not part of the automatic tests (it starts the service); run it after changing how a day is shared:
//   node worker-relay/tests/points-budgets-service.mjs [active|upcoming|off|topup]
// "active": the schedule is in force today; "upcoming": it starts in two days (today is paid as before, and /leaderboard?day=today carries a preview);
// "off": none (everything is the old split); "topup": the loops are a capped group and the stayers have a top-up ceiling, paid from the part of the day nobody else could use. Every chain RPC points at a dead local port, so nothing reaches the network.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openStore } from '../src/lib/points-store.js';

const mode = process.argv[2] || 'active', PORT = 18080 + Math.floor(Math.random() * 500);
const today = Math.floor(Date.now() / 86400e3), DAY = 86400, TAC = 10n ** 18n;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
let n = 0;
const dep = (depositor, day, activity, points) => ({ txHash: '0x' + (++n).toString(16).padStart(64, '0'), blockNumber: n, blockTime: day * DAY + 100 + n, depositor, amountWei: '1000000000000000000', priorDepositCount: 0, points, activity });
const dir = mkdtempSync(join(tmpdir(), 'points-service-'));
const db = join(dir, 'p.db');
const store = openStore(db);
for (const d of [today - 1, today]) {
  store.recordDeposit(dep(A, d, 'wrap', 900_000)); store.recordDeposit(dep(A, d, 'evmpooldeposit', 1_800_000));   // an address repeating one action all day
  store.recordDeposit(dep(B, d, 'holding', 2_000));                                                                 // one who keeps ETH in the pools
  store.recordDeposit(dep(C, d, 'zswapeth', 1_000));                                                                // one who buys TAC
}
store.db?.close?.(); store.close?.();
const spec = mode === 'topup' ? 'stay=holding+cbtchold@0.25/0.02+0.04,use=zswapeth+cusdmint@0.15/0.01,loop=wrap+evmpooldeposit@0.6!/0.03' : 'stay=holding+cbtchold@0.25/0.02,use=zswapeth+cusdmint@0.15/0.01';
const from = mode === 'upcoming' ? today + 2 : today;
const env = {
  ...process.env, PORT: String(PORT), POINTS_DB_PATH: db, RPC_URL: 'http://127.0.0.1:9', RPC_URLS_FALLBACK: 'http://127.0.0.1:9', POINTS_START_BLOCK: '99999999', POINTS_POLL_SECS: '3600',
  POINTS_PROGRAM_START_SEC: String((today - 24) * DAY), POINTS_RATE_CAP_SCHEDULE: mode === 'topup' ? `${today - 5}:0.03,${today}:0.04` : `${today - 5}:0.03`, POINTS_BUDGETS: mode === 'off' ? '' : `${from}:${spec}`,
};
const child = spawn('node', ['src/points-indexer.js'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tac = (w) => Number(BigInt(w) / 10n ** 14n) / 1e4;
try {
  let up = false;
  for (let i = 0; i < 80 && !up && child.exitCode === null; i++) { await sleep(500); up = /http listening/.test(out); }
  assert.ok(up, `the service did not start:\n${out.slice(-1200)}`);
  const lb = await get('/leaderboard?day=today&limit=5');
  const pts = async (a) => (await get(`/points/${a}`)).today;
  const [ta, tb, tc] = [await pts(A), await pts(B), await pts(C)];
  console.log(`mode ${mode}: board pot ${tac(lb.dayBudgetWei)} TAC over ${lb.totalPoints} points; looper ${tac(ta.tacWei)} TAC, stayer ${tac(tb.tacWei)} TAC, user ${tac(tc.tacWei)} TAC`);
  if (mode === 'active') {
    assert.deepEqual(lb.groups.map((g) => g.name), ['stay', 'use', 'open']);
    assert.equal(BigInt(tb.tacWei), 2_000n * 2n * TAC / 100n, 'the stayer is paid at its group\'s 0.02 a point');
    assert.equal(BigInt(tc.tacWei), 1_000n * TAC / 100n, 'the user at 0.01');
    assert.equal(lb.preview, undefined);
    assert.equal(lb.program.budgets[0].fromDay, today);
    const tot = BigInt(ta.tacWei) + BigInt(tb.tacWei) + BigInt(tc.tacWei);
    assert.ok(tot <= BigInt(lb.dayBudgetWei) && BigInt(lb.dayBudgetWei) - tot < 10n, 'the whole pot is paid');
    for (const r of lb.rows) assert.equal(r.tacWei, { [A]: ta, [B]: tb, [C]: tc }[r.address].tacWei, 'a row on the board carries what /points says the address is paid');
  } else if (mode === 'topup') {
    assert.deepEqual(lb.groups.map((g) => g.name), ['stay', 'use', 'loop', 'open']);
    assert.equal(BigInt(tb.tacWei), 2_000n * 4n * TAC / 100n, 'the stayer is paid up to its top-up of 0.04 a point (0.02 from its group, the rest from what was left)');
    assert.equal(BigInt(tc.tacWei), 1_000n * TAC / 100n, 'the user is paid as before');
    assert.equal(BigInt(ta.tacWei), (100_000n * TAC / 90n) * 6n / 10n, 'and the capped loops their 60% of the day\'s pot');
    assert.equal(lb.groups[0].topWeiPerPoint, String(4n * TAC / 100n), 'the board says the group has a top-up');
    assert.equal(lb.program.budgets[0].groups[0].topWeiPerPoint, String(4n * TAC / 100n), 'and so do the program\'s terms');
    const rw = await get('/rewards');
    assert.equal(rw.budgets[0].groups[0].topWeiPerPoint, String(4n * TAC / 100n), 'and /rewards');
  } else if (mode === 'upcoming') {
    assert.equal(lb.groups, undefined, 'today is still the one split');
    assert.equal(lb.preview.fromDay, from);
    assert.deepEqual(lb.preview.groups.map((g) => g.name), ['stay', 'use', 'open']);
    assert.ok(BigInt(tb.tacWei) < TAC, 'the stayer is paid pennies today');
    assert.equal(BigInt(lb.preview.groups[0].paidWei), 2_000n * 2n * TAC / 100n, 'and the preview shows what the coming rules would pay it');
  } else {
    assert.deepEqual(lb.program.budgets, []);
    assert.equal(lb.groups, undefined);
    assert.equal(lb.preview, undefined);
  }
  console.log('ok');
} finally { child.kill('SIGTERM'); await sleep(300); rmSync(dir, { recursive: true, force: true }); }
