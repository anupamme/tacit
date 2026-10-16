// The Bitcoin lane in one always-on process: the eth-state producer (Mode-B fuel), the reflection folder (Bitcoin state attested on
// Ethereum) and the header feeder (BitcoinLightRelay.advanceTip), run in turn by lib/lane-schedule.js. One process where there were a
// worker and two crons: no cold start every few minutes, the reflection runs the moment its fuel is there instead of at the next
// five-minute mark, and the three never prove or send at once (each proof is a child of over a gigabyte; headers and attests sign with
// the one relay key), so a 2 GB instance holds the lane's peak.
//
// Each stage is the unchanged cycle of its own file (eth-state-sidecar.js, reflection-folder.js, header-relay.js), which still run on
// their own as before. A stage can be left out (LANE_ETH_STATE / LANE_REFLECTION / LANE_HEADERS = 0) while its old service runs.
//
//   ETH_STATE_POLL_SECS (60)  how often the eth-state producer looks     REFLECTION_POLL_SECS (30)  the folder, when caught up
//   HEADER_EVERY_SECS (180)   the header feeder, as its cron ran          a stage that worked goes again at once

import { CFG } from './lib/config.js';
import { makeLaneSchedule } from './lib/lane-schedule.js';
import { heartbeat, heartbeatIdle } from './lib/worker-client.js';
import { safeErr } from './lib/safe-err.js';
import { ethStateCycle, ethStateReset } from './eth-state-sidecar.js';
import { reflectionCycle } from './reflection-folder.js';
import { headerCycle } from './header-relay.js';

const log = (...a) => console.log(`[lane ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const on = (k) => (process.env[k] ?? '1') !== '0';

async function main() {
  if (CFG.runMode === 'cron') throw new Error('bitcoin-lane.js is an always-on worker; RUN_MODE=cron is for the single-stage files');
  if (CFG.sp1Prover === 'network' && !CFG.networkPrivateKey) throw new Error('SP1_PROVER=network but NETWORK_PRIVATE_KEY unset — cannot prove');
  const stages = [];
  // A stage that found nothing beats its own idle note, as its single-service loop did, or /prover-health reads it as down after ten quiet minutes.
  if (on('LANE_ETH_STATE')) { await ethStateReset(); stages.push({ name: 'eth-state', everySecs: CFG.ethStatePollSecs, run: ethStateCycle, idle: () => heartbeatIdle('eth-state', 'idle — no candidate to produce yet') }); }
  if (on('LANE_REFLECTION')) stages.push({ name: 'reflection', everySecs: CFG.reflectionPollSecs, run: reflectionCycle, idle: () => heartbeatIdle('reflection', 'caught up') });
  if (on('LANE_HEADERS')) stages.push({ name: 'header', everySecs: Number(process.env.HEADER_EVERY_SECS || 180), run: headerCycle });
  if (!stages.length) throw new Error('every stage is off (LANE_ETH_STATE, LANE_REFLECTION, LANE_HEADERS)');
  log(`starting — stages ${stages.map((s) => `${s.name} every ${s.everySecs}s`).join(', ')}; worker=${CFG.workerBase} network=${CFG.network}`);
  const lane = makeLaneSchedule(stages, { idleSecs: Number(process.env.LANE_IDLE_SECS || Math.min(CFG.ethStatePollSecs, CFG.reflectionPollSecs)), log });
  // A deploy or restart sends SIGTERM: the stage in hand finishes (a proof paid for is not abandoned), then the loop ends.
  let stopping = false;
  process.on('SIGTERM', () => { if (!stopping) log('SIGTERM — finishing the stage in hand'); stopping = true; });
  for (;;) {
    if (stopping) { log('stopped cleanly'); process.exit(0); }
    let r;
    try { r = await lane.round(); }
    catch (e) { log('round error (continuing):', safeErr(e)); await heartbeat('reflection', `lane error ${safeErr(e)}`).catch(() => {}); r = { worked: false, sleepSecs: CFG.reflectionPollSecs }; }
    if (r.sleepSecs > 0) await sleep(r.sleepSecs);
  }
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
