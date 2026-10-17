// Spawn the prebuilt Rust prover binaries in NETWORK mode (Succinct), read back
// the hex artifacts. The binaries were built with the SP1 SDK's .network() path, so
// they need no local GPU — only SP1_PROVER=network + a funded NETWORK_PRIVATE_KEY.
//
// To prove locally instead, point BITCOIN_PROVE_BIN / EXEC_BIN at locally built GPU
// binaries and unset SP1_PROVER.

import { spawn, execFile } from 'node:child_process';
import { STALE_PROOF_SELECTORS } from './open-board.js';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { keccak256 } from 'viem';
import { CFG } from './config.js';
import { POOL, POOL_ABI, publicClient, settleWallet } from './chain.js';
import { reflectionEthProofPatient } from './worker-client.js';
import { privateProvePlan, retryPublic, privateRefused, rememberRefusal, privateOff } from './private-prove.js';
import { CREDIT_SHORT } from './prove-pause.js';
import { makeStdinProver, batchInput } from './stdin-prover.js';
import { makeBoardProver } from './board-prover.js';
import { boardPost, boardStatus, boardCancel, boardSummary } from './worker-client.js';
import { stdinFor, SELF_PROVE_TYPES, LIMITS } from './spn/sp1-stdin.js';
import { assertMemosMatchProof } from './memo-root.js';

function proverEnv(extra = {}) {
  // Env the spawned SP1 binary reads to route to the Succinct network prover.
  const env = {
    ...process.env,
    SP1_PROVER: CFG.sp1Prover, // 'network'
    NETWORK_RPC_URL: CFG.networkRpcUrl,
    PROVER_OUT: CFG.proverOut,
    ...extra,
  };
  if (CFG.networkPrivateKey) env.NETWORK_PRIVATE_KEY = CFG.networkPrivateKey;
  return env;
}

// Run a binary with a hard timeout; resolve with {code} or reject on timeout/spawn error. `memLimitKB`
// wraps the spawn in `sh -c 'ulimit -v ...; exec "$0"'` (sh, not bash — the runtime image is node:20-bookworm
// -slim, which may not carry bash; ulimit is a POSIX sh builtin too) so a runaway child hits its OWN
// allocator failure (a normal, catchable non-zero exit) well before the container's shared cgroup memory
// ceiling — otherwise the OOM killer can take out the whole container (parent Node process included), which
// no try/catch around this call can ever observe.
//
// `rssLimitKB` watches the child's resident memory instead of capping its address space: a network-proving binary
// reserves far more virtual memory than it touches, so a `ulimit -v` low enough to matter would fail it at start.
// Past the limit the child is killed and the call rejects, a failure the caller can act on, before the container's
// memory ceiling takes the service down with it. The peak is logged either way, so the limits can follow real use.
function run(bin, { env, cwd, timeoutMs, tag, memLimitKB, rssLimitKB }) {
  return new Promise((resolve, reject) => {
    const child = memLimitKB
      ? spawn('sh', ['-c', 'ulimit -v "$1"; exec "$0"', bin, String(memLimitKB)], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(bin, [], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', peak = 0, reading = false;
    const timer = timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${tag} timed out after ${timeoutMs}ms`)); }, timeoutMs)
      : null;
    const watch = rssLimitKB ? setInterval(async () => {
      if (reading) return;
      reading = true;
      const kb = await rssKB(child.pid);
      reading = false;
      if (kb == null) return;
      if (kb > peak) peak = kb;
      if (kb > rssLimitKB) {
        clearInterval(watch);
        child.kill('SIGKILL');
        if (timer) clearTimeout(timer);
        reject(new Error(`${tag} used ${Math.round(kb / 1024)}MB, over its ${Math.round(rssLimitKB / 1024)}MB memory cap, and was stopped`));
      }
    }, 250) : null;
    const done = () => {
      if (timer) clearTimeout(timer);
      if (watch) clearInterval(watch);
      if (peak) console.log(`[${tag}] peak memory ${Math.round(peak / 1024)}MB`);
    };
    child.stdout.on('data', (d) => { out += d; process.stdout.write(`[${tag}] ${d}`); });
    child.stderr.on('data', (d) => { err += d; process.stderr.write(`[${tag}] ${d}`); });
    child.on('error', (e) => { done(); reject(e); });
    child.on('close', (code) => { done(); resolve({ code, out, err }); });
  });
}

// A process's resident memory in KB: /proc where there is one (the Linux image), else `ps`; null if unreadable.
async function rssKB(pid) {
  if (!pid) return null;
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
    if (m) return Number(m[1]);
  } catch { /* no procfs: fall through to ps */ }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], (e, stdout) => {
      const kb = Number(String(stdout || '').trim());
      resolve(e || !Number.isFinite(kb) || kb <= 0 ? null : kb);
    });
  });
}

async function readHex(p) {
  const raw = (await readFile(p, 'utf8')).trim();
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}

// Fetch the raw compressed eth-proof bytes bitcoin_prove's Mode-B branch needs and write them to
// $PROVER_OUT/eth_compressed.bin (the path bitcoin_prove.rs derives from PROVER_OUT). contentHash is derived from the job's own ethPv so a pending candidate getting
// replaced mid-flight is detected as a miss (the worker refuses to serve the wrong one) rather than
// silently recursing a different eth-side witness set than the fixture actually committed to.
async function writeEthProofFor(ethPv) {
  const contentHash = keccak256(ethPv.startsWith('0x') ? ethPv : `0x${ethPv}`);
  const res = await reflectionEthProofPatient(contentHash);
  if (!res || !res.ethCompressedProofB64) {
    throw new Error(`no eth-state proof blob for contentHash=${contentHash} — the eth-state candidate this `
      + `Mode-B job was built from is gone (republish /reflection/eth-state, or wait for a fresh job)`);
  }
  await writeFile(path.join(CFG.proverOut, 'eth_compressed.bin'), Buffer.from(res.ethCompressedProofB64, 'base64'));
}

// ── Reflection: bitcoin_prove (eth-reflection prover-host) ──
// Writes the assembled reflection input to REFLECT_FIXTURE, spawns the binary. A forward (modeB=0) fixture
// proves without eth recursion (the always-on incremental attest); a Mode-B (modeB=1) fixture additionally
// needs the compressed eth-proof bytes on disk first (writeEthProofFor above). Returns { publicValues,
// proofBytes } either way — the recursion branch lives inside bitcoin_prove itself, keyed on the fixture's
// own modeB field.
export async function proveReflection(input) {
  await mkdir(CFG.fixtureDir, { recursive: true });
  await mkdir(CFG.proverOut, { recursive: true });
  const fixture = path.join(CFG.fixtureDir, 'reflection_input.json');
  await writeFile(fixture, JSON.stringify(input));
  await rm(path.join(CFG.proverOut, 'bitcoin_proof_bytes.hex'), { force: true });
  if (input.modeB) await writeEthProofFor(input.ethPv);

  const { code, out } = await run(CFG.bitcoinProveBin, {
    env: proverEnv({ PROOF_MODE: 'groth16', REFLECT_FIXTURE: fixture }),
    cwd: CFG.proverOut,
    timeoutMs: CFG.reflectionProveTimeoutSecs * 1000,
    rssLimitKB: CFG.reflectionProverRssKB,
    tag: 'bitcoin_prove',
  });
  // The GPU client can panic in a cleanup destructor AFTER writing artifacts; treat a
  // fresh proof file as success regardless of exit code.
  const pvPath = path.join(CFG.proverOut, 'bitcoin_pv.hex');
  const pbPath = path.join(CFG.proverOut, 'bitcoin_proof_bytes.hex');
  try {
    const publicValues = await readHex(pvPath);
    const proofBytes = await readHex(pbPath);
    return { publicValues, proofBytes };
  } catch (e) {
    throw new Error(`bitcoin_prove produced no proof (code=${code}): ${e.message}\n${out.slice(-2000)}`);
  }
}

// ── Mode-B: eth_prove (eth-reflection prover-host, the crossOut/consumed producer) ──
// Unlike bitcoin_prove/exec, eth_prove keeps its OWN cumulative resume state on disk (a committed
// eth_set_state.json + a not-yet-committed .pending.json — see the binary's header comment). This spawn
// wrapper never writes state_path() itself; committing pending -> state is the caller's job, done only
// once the caller has independently confirmed (via GET /reflection/eth-state) that a Bitcoin batch built
// from this exact candidate actually landed on-chain (see commitEthProveState below). Committing early
// would desync the NEXT eth_prove run's prior_set_root/prior_count from what's really on-chain — the
// "single-use proof" trap eth-state-sidecar.js's header comment covers in more depth.
function ethProveEnv(mode) {
  return proverEnv({
    SOURCE_CONSENSUS_RPC: CFG.sourceConsensusRpc,
    SOURCE_CHAIN_ID: CFG.sourceChainId,
    SOURCE_EXECUTION_RPC: CFG.sourceExecutionRpc,
    ...(CFG.sourceProofRpc ? { SOURCE_PROOF_RPC: CFG.sourceProofRpc } : {}),
    POOL,
    ...(CFG.ethCallOutbox ? { ETH_CALL_OUTBOX: CFG.ethCallOutbox } : {}),
    ...(CFG.ethProveDeployBlock ? { DEPLOY_BLOCK: CFG.ethProveDeployBlock } : {}),
    ...(CFG.ethProveGenesisSlot ? { GENESIS_SLOT: CFG.ethProveGenesisSlot } : {}),
    SCAN_CHUNK: CFG.ethProveScanChunk,
    SCAN_DELAY_MS: CFG.ethProveScanDelayMs,
    ETHPROVE_CYCLE_LIMIT: CFG.ethProveCycleLimit,
    ETHPROVE_GAS_LIMIT: CFG.ethProveGasLimit,
    ETH_PROVE_OUT_DIR: CFG.ethProveOutDir,
    ETH_PROVE_DEBUG_DIR: CFG.ethProveDebugDir,
    // eth_prove.rs reads its OWN SP1_PROVER var (backend selector: cpu|cuda|network|execute) — separate
    // from the bitcoin_prove/exec convention of always being 'network', because 'execute' (free local
    // dry-run, no STARK) is a real, distinct mode this binary supports and the sidecar uses deliberately.
    SP1_PROVER: mode === 'execute' ? 'execute' : CFG.sp1Prover,
  });
}

// mode 'execute': free local dry-run (no proof, no artifacts) — parses EXECUTE_OK/RAWPV off stdout so the
// caller can sanity-check cycle count and decode crossOutCount/etc. from RAWPV before spending a real
// network prove. mode 'network' (default): the real compressed proof + bundle, read back from ETH_PROVE_OUT_DIR.
export async function proveEthState({ mode = 'network', timeoutMs } = {}) {
  await mkdir(CFG.ethProveOutDir, { recursive: true });
  if (mode !== 'execute') {
    // Clear this run's output artifacts BEFORE spawning (mirrors proveReflection's own rm-before-run
    // guard above) — otherwise a run that panics without writing anything new leaves readFile below to
    // silently pick up a PREVIOUS successful run's leftover files and return them as if they were fresh.
    // That happened for real: a network proof rejected as "unexecutable" still left the prior candidate's
    // eth_set_state.pending.json on disk, and this function returned it as a "successful" result.
    await Promise.all([
      rm(path.join(CFG.ethProveOutDir, 'eth_compressed.bin'), { force: true }),
      rm(path.join(CFG.ethProveOutDir, 'eth_set.json'), { force: true }),
      rm(path.join(CFG.ethProveOutDir, 'eth_set_state.pending.json'), { force: true }),
    ]);
  }
  // execute mode runs the (heavy) eth-reflection guest through SP1's local CPU interpreter — observed to
  // spike to >1.2GB in well under a second on this host and take the whole container down with it (the
  // sidecar's own catch-and-skip-to-network fallback never gets a chance to run). Cap it well under the
  // container's ceiling so the child's own allocator fails cleanly instead. network mode never does local
  // execution (explicit cycle/gas limits route straight to the network prover), so it needs no cap.
  const memLimitKB = mode === 'execute' ? 900_000 : undefined; // ~900MB, comfortably under a 2GB container
  const { code, out, err } = await run(CFG.ethProveBin, { env: ethProveEnv(mode), cwd: CFG.ethProveOutDir, timeoutMs, tag: `eth_prove:${mode}`, memLimitKB });
  const tail = (out + err).slice(-4000);
  if (mode === 'execute') {
    const m = out.match(/EXECUTE_OK cycles=(\d+) pv_bytes=(\d+)/);
    if (!m) throw new Error(`eth_prove execute produced no EXECUTE_OK line (code=${code}): ${tail}`);
    const rawpv = out.match(/RAWPV ([0-9a-f]+)/i);
    return { cycles: Number(m[1]), pvBytes: Number(m[2]), rawPvHex: rawpv ? rawpv[1] : null };
  }
  try {
    const [ethCompressed, bundleRaw, pendingRaw] = await Promise.all([
      readFile(path.join(CFG.ethProveOutDir, 'eth_compressed.bin')),
      readFile(path.join(CFG.ethProveOutDir, 'eth_set.json'), 'utf8'),
      readFile(path.join(CFG.ethProveOutDir, 'eth_set_state.pending.json'), 'utf8'),
    ]);
    const bundle = JSON.parse(bundleRaw); // { ethPv, crossouts:[{claimId,destCommitment,asset}], consumeds:[{nu,consumedVal,spendRoot}] }
    const pending = JSON.parse(pendingRaw); // { last_block, crossouts, consumeds } — the CANDIDATE cumulative state
    return {
      ethPv: bundle.ethPv,
      crossouts: bundle.crossouts.map((c) => ({ claimId: c.claimId, destCommitment: c.destCommitment, asset: c.asset })),
      consumeds: bundle.consumeds.map((c) => ({ nu: c.nu, consumedVal: c.consumedVal, spendRoot: c.spendRoot })),
      ethCompressedProofB64: ethCompressed.toString('base64'),
      lastBlock: pending.last_block,
      execBlock: pending.last_block,
    };
  } catch (e) {
    throw new Error(`eth_prove network run produced no usable artifacts (code=${code}): ${e.message}\n${tail}`);
  }
}

// Advance the committed resume state to the just-published candidate — call ONLY after independently
// confirming (GET /reflection/eth-state) that a Bitcoin batch built from it actually landed. Copies rather
// than renames: a crash mid-copy should never leave neither file intact (rename is atomic per-filesystem
// but this stays defensive and cheap either way — these files are at most a few MB).
export async function commitEthProveState() {
  const pending = path.join(CFG.ethProveOutDir, 'eth_set_state.pending.json');
  const committed = path.join(CFG.ethProveOutDir, 'eth_set_state.json');
  await writeFile(committed, await readFile(pending));
}

// ── Settle: exec harness ──
// Writes the op JSON to OP_FILE, spawns the exec bin (MODE=groth16, network prove),
// returns { publicValues, proof }. A per-job timeout guards the FIFO.
// Each confidential op is a SINGLE-op SP1 binary (exec-<type>) that reads OP_FILE and proves that one op —
// there is no unified OP_TYPE-dispatching `exec` deployed. Map the relay type to its binary; if a type has
// no built binary yet, fail clearly rather than invoking the wrong prover.
// Relay op type → its single-op network prover binary (names per the canonical harness_for map).
const PEROP = {
  wrap: 'exec-wrap', transfer: 'exec-prove', batchtransfer: 'exec-batchtransfer', wraplp: 'exec-wraplp', wrapswap: 'exec-wrapswap', swap: 'exec-swap', unwrap: 'exec-unwrap', lp: 'exec-lp', lpremove: 'exec-lpremove',
  wraptransfer: 'exec-wraptransfer', sendunwrap: 'exec-sendunwrap', otc: 'exec-otc', route: 'exec-route', bid: 'exec-bid',
  bridgeburn: 'exec-bridgeburn', bridgemint: 'exec-bridgemint', cbtcmint: 'exec-cbtcmint',
  cdpmint: 'exec-cdpmint', cdpclose: 'exec-cdpclose',
  // Stealth lock/claim. This is the ONLY sound way to pay a third party: a native note's owner is
  // keccak(nk ‖ dom), so a sender who builds the recipient's note either picks nk (and keeps spend
  // authority over their money) or derives the owner from a pubkey (and mints a note nobody can spend).
  // The lock escrows to a one-time key instead, and the recipient claims it into a note under an nk only
  // they can derive.
  stealthlock: 'exec-stealthlock', stealthclaim: 'exec-stealthclaim', stealthrefund: 'exec-stealthrefund',
  stealthlockbatch: 'exec-stealthlockbatch', bridgestealthmint: 'exec-bridgestealthmint',
  farmbond: 'exec-farmbond', farmharvest: 'exec-farmharvest', farmunbond: 'exec-farmunbond',
  adaptorlock: 'exec-adaptorlock', adaptorclaim: 'exec-adaptorclaim', adaptorrefund: 'exec-adaptorrefund',
  cdpliquidate: 'exec-cdpliquidate', cdptopup: 'exec-cdptopup', lpbond: 'exec-lpbond', wrapcdpmint: 'exec-wrapcdpmint',
  // Bitcoin-homed (authenticated) OP_TRANSFER batches: `fastlane` is the dapp's fast-lane exit shape
  // ({ chainBinding, spendRoot, bitcoinSpentRoot, transfer }); `crosslane` is the flat fixture shape.
  fastlane: 'exec-fastlane', crosslane: 'exec-crosslane',
};

// This network account's prover credit, in PROVE wei (the exec-balance binary); null when it cannot be read.
export async function proverCredit({ timeoutMs = 30_000 } = {}) {
  try {
    await mkdir(CFG.proverOut, { recursive: true });
    const bin = path.join(path.dirname(CFG.execBin), 'exec-balance');
    const { code, out } = await run(bin, { env: proverEnv(), cwd: CFG.proverOut, timeoutMs, tag: 'exec:balance' });
    const m = /BALANCE=(\d+)/.exec(out);
    return code === 0 && m ? BigInt(m[1]) : null;
  } catch { return null; }
}

// Tacit's prover board, tried before the network when PROVER_BOARD=1 (lib/board-prover.js). A proof from it is taken only
// when the pool would settle it now with these memos: the same simulation the settle itself runs, from the settle wallet.
let board = null;
const boardLog = (m) => console.log(`[prover ${new Date().toISOString()}] ${m}`);
function boardLane() {
  if (!CFG.proverBoard) return null;
  board ||= makeBoardProver({ post: boardPost, status: boardStatus, cancel: boardCancel, verify: verifySettle, alive: boardAlive, waitMs: CFG.proverBoardWaitSecs * 1000, log: boardLog });
  return board;
}
// Whether a worker has polled the board in the last half minute (the worker polls every few seconds), read at most every
// ten seconds; an unreadable summary counts as alive, since the post itself then answers.
let aliveAt = 0, aliveWas = true;
export async function boardAlive() {
  if (Date.now() - aliveAt < 10_000) return aliveWas;
  const s = await boardSummary();
  aliveAt = Date.now();
  aliveWas = !s || s.workers.some((w) => Number(w.lastSeenSeconds) <= 30);
  return aliveWas;
}
// → true (the pool takes it), 'stale' (the proof is sound but its roots have moved on: the op's fault, not the worker's) or false.
async function verifySettle({ publicValues, proof, memos }) {
  try {
    assertMemosMatchProof(publicValues, memos);
    await publicClient.estimateContractGas({ address: POOL, abi: POOL_ABI, functionName: 'settle', args: [publicValues, proof, memos], account: settleWallet.account });
    return true;
  } catch (e) {
    const said = String(e && e.shortMessage || e && e.message || e);
    const stale = STALE_PROOF_SELECTORS.some((sel) => said.toLowerCase().includes(sel.toLowerCase()) || JSON.stringify(e && e.cause || '').toLowerCase().includes(sel.toLowerCase()));
    boardLog(`a board proof did not pass the settle check${stale ? ' (stale roots: the op is behind the pool, the proof itself is fine)' : ''}: ${said.slice(0, 200)}`);
    return stale ? 'stale' : false;
  }
}
// The board lane for `stdin`, or null when it missed; the time it took comes off `timeoutMs` for the lane after it.
async function viaBoard({ stdin, cycleLimit, gasLimit, label, memos, timeoutMs }) {
  const lane = boardLane();
  if (!lane) return { proof: null, spentMs: 0 };
  const t0 = Date.now();
  try {
    const r = await lane.prove({ stdin, cycleLimit, gasLimit, cls: 'private', label, memos, timeoutMs });
    boardLog(`${label}: proved on the board by ${r.worker} in ${Math.round((Date.now() - t0) / 1000)} s`);
    return { proof: { publicValues: r.publicValues, proof: r.proof, lane: 'board', worker: r.worker }, spentMs: Date.now() - t0 };
  } catch (e) {
    if (e.code !== 'board_miss') throw e;
    boardLog(`${label}: ${e.message}; going to the network`);
    return { proof: null, spentMs: Date.now() - t0 };
  }
}

// A job whose input the page sealed to one board worker (worker/src/confidential-settle.js `mode: 'sealed'`): the relay
// holds only the ciphertext, so this lane is the only one; a board that misses fails the job with a reason the page can
// show, and nothing is spent. → { publicValues, proof, lane: 'board', worker }
export async function proveSealed({ type, sealed, memos = [], timeoutMs }) {
  const lane = boardLane();
  const unavailable = (why) => Object.assign(new Error(`the sealed prover is not available right now (${why}); nothing was spent — send it again in a few minutes, or send it unsealed`), { code: 'sealed_unavailable' });
  if (!lane) throw unavailable('the board is off');
  const limits = LIMITS[type];
  if (!limits) throw Object.assign(new Error(`a ${type} cannot be proved sealed`), { code: 'sealed_unsupported' });
  try {
    const r = await lane.prove({ sealed, ...limits, cls: 'private', label: `sealed ${type}`, memos, timeoutMs });
    boardLog(`sealed ${type}: proved on the board by ${r.worker}`);
    return { publicValues: r.publicValues, proof: r.proof, lane: 'board', worker: r.worker };
  } catch (e) {
    if (e.code !== 'board_miss') throw e;
    throw unavailable(e.reason || e.message);
  }
}

// Several ops of different types in ONE proof, from one program input built here and requested from the network directly
// (lib/stdin-prover.js): the per-op binaries above prove one op each, and exec-batchtransfer transfers only. `items` are
// [{ type, op, memos }] in settle order. → { publicValues, proof, requestId, private, numOps }
let stdinProver = null;
export async function proveMixed({ items, timeoutMs }) {
  if (!CFG.networkPrivateKey) throw new Error('proveMixed: NETWORK_PRIVATE_KEY is not set');
  const built = batchInput(items);
  const first = await viaBoard({ ...built, label: `mixed(${items.length})`, memos: items.flatMap((i) => i.memos || []), timeoutMs });
  if (first.proof) return { ...first.proof, numOps: built.numOps };
  stdinProver ||= makeStdinProver({ key: CFG.networkPrivateKey, rpc: CFG.networkRpcUrl, env: process.env });
  const tag = `[prover ${new Date().toISOString()}] mixed(${items.length})`;
  const r = await stdinProver.proveBatch({ items, timeoutMs: Math.max(60_000, timeoutMs - first.spentMs), onUpdate: (u) => console.log(`${tag} ${u.requestId ? u.requestId.slice(0, 10) + ' ' : ''}${u.status}/${u.stage}${u.public ? ' (public input)' : ''}`) });
  return { ...r, lane: r.private === false ? 'network-public' : 'network-private' };
}
// Where a proof was made, carried on the settle's ack so a page can say so: 'board' (Tacit's own machine; the input never
// left Tacit), 'network-private' (the prover network, input readable only by the whitelisted prover) or 'network-public'
// (the prover network, input readable by anyone).
const laned = (p, lane) => ({ ...p, lane });

export async function proveSettle({ type, op, memos = [], timeoutMs }) {
  // Resolve `type` to its binary before anything touches the filesystem. `type` originates in the worker's
  // job queue and is used to build the fixture path (`${type}_op.json`), so the allowlist above is the only
  // thing that supplies a path component, independent of any upstream validation.
  const binName = PEROP[type];
  if (!binName) throw new Error(`exec:${type} — no prover binary deployed for this op (have: ${Object.keys(PEROP).join(', ')})`);
  const bin = path.join(path.dirname(CFG.execBin), binName);

  await mkdir(CFG.fixtureDir, { recursive: true });
  const opFile = path.join(CFG.fixtureDir, `${type}_op.json`);
  // The guest commits to keccak256(memo) per emitted leaf; settle() then passes the real memos and the
  // contract re-checks them (else MemoLeafMismatch). Compute the real memo hashes so the harness feeds THOSE
  // (not the placeholder empty hashes) — the on-chain memos then match what the proof committed to.
  // The guest reads (leaves + lock_leaves) memo hashes AFTER the last op, so for a batch they must be the
  // concatenation of every op's memos in the SAME order the ops are written — otherwise memoRoot is computed
  // over a different ordering than settle() supplies and the contract rejects it.
  const memoHashes = (memos || []).map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
  // The board first, for every op whose input is built here (the page modules build it byte for byte as the binary would).
  if (CFG.proverBoard && SELF_PROVE_TYPES.includes(type)) {
    let stdin = null;
    try { stdin = stdinFor(type, { ...op, memoHashes }); } catch (e) { console.log(`[prover] ${type}: no board input (${e.message}); the binary proves it`); }
    if (stdin) {
      const first = await viaBoard({ stdin, ...LIMITS[type], label: type, memos: memos || [], timeoutMs });
      if (first.proof) return first.proof;
      timeoutMs = Math.max(60_000, timeoutMs - first.spentMs);
    }
  }
  await writeFile(opFile, JSON.stringify({ ...op, memoHashes }));
  const cwd = CFG.proverOut;
  await mkdir(cwd, { recursive: true });

  const attempt = async (extra, ms) => {
    await rm(path.join(cwd, 'public_values.hex'), { force: true });
    await rm(path.join(cwd, 'proof_bytes.hex'), { force: true });
    const { code, out, err } = await run(bin, {
      // The per-op binary proves its own op from OP_FILE; OP_TYPE is passed for forward-compat with a future
      // unified dispatcher but ignored by the single-op binaries.
      env: proverEnv({ MODE: 'groth16', OP_TYPE: type, OP_FILE: opFile, ...extra }),
      cwd,
      timeoutMs: ms,
      tag: `exec:${type}`,
      // A batch that cannot prove in this container fails on its own, so its members settle one by one; every other
      // op keeps a last-resort cap under the container's ceiling.
      rssLimitKB: type === 'batchtransfer' ? CFG.batchProverRssKB : CFG.settleProverRssKB,
    });
    try {
      const publicValues = await readHex(path.join(cwd, 'public_values.hex'));
      const proof = await readHex(path.join(cwd, 'proof_bytes.hex'));
      return { publicValues, proof };
    } catch (e) {
      const fail = new Error(`exec:${type} produced no proof (code=${code}): ${e.message}\n${out.slice(-2000)}`);
      // The binary's own last words (a panic names the network's answer), for the retry rules: never copied into the message.
      fail.stderr = String(err || '').slice(-4000);
      // A request the prover account cannot pay for is refused by the network, and the binary panics with that refusal on
      // stderr. It is marked rather than copied into the message, which reaches the job's public status; the settle loop
      // pauses proving on it (lib/prove-pause.js).
      if (CREDIT_SHORT.test(err) || CREDIT_SHORT.test(out)) fail.creditShort = true;
      throw fail;
    }
  };
  // The witness file stays for every attempt below (a public retry reads it again) and goes once the last one is over.
  try { return await attempts(); } finally { await rm(opFile, { force: true }); }
  async function attempts() {
  const plan = privateProvePlan(process.env, timeoutMs);
  if (!plan.fallback) return laned(await attempt({}, timeoutMs), process.env.PRIVATE_STDIN === '1' ? 'network-private' : 'network-public');
  // The witness goes as a private input, which only provers that fetch it with the signed GetStdinUri call can read
  // (PROVER_WHITELIST names them). If none of them proves it in time, it is proved once more with a public input,
  // so a holder never waits on a prover that is not there; a witness the network could not execute is not sent again.
  const asPublic = { PRIVATE_STDIN: '0', PROVER_WHITELIST: '' };
  // While the network refuses private inputs, the attempt is not made: the refusal was answered minutes ago and costs a
  // binary start and a round trip each time.
  if (privateOff()) return laned(await attempt(asPublic, timeoutMs), 'network-public');
  const t0 = Date.now();
  try { return laned(await attempt({}, plan.privateMs), 'network-private'); }
  catch (e) {
    if (!retryPublic(e)) throw e;
    if (privateRefused(e)) {
      rememberRefusal();
      console.log(`[exec:${type}] the network refuses private inputs; the next ten minutes of requests go with public inputs at once`);
    } else {
      console.log(`[exec:${type}] the private request was not proved (${String(e.message).split('\n')[0].slice(0, 160)}); proving it with a public input`);
    }
    return laned(await attempt(asPublic, Math.max(60_000, timeoutMs - (Date.now() - t0))), 'network-public');
  }
  }
}
