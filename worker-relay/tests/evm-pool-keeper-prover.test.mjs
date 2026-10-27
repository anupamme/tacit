// The keeper's real proving path with the DEV zkey: a deposit completion built through the gateway, proven,
// verified, and laid out exactly as snarkjs's Solidity calldata export; plus revert-name decoding of a real
// viem revert error. Needs the evm-pool circuit build (see tests/evm-pool-zk.test.mjs); skips without it.
//   node worker-relay/tests/evm-pool-keeper-prover.test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, toFunctionSelector } from 'viem';
import { loadKeeperConfig } from '../src/lib/evm-pool-keeper-config.js';
import { makeKeeperProver, loadArtifact, capProverThreads, makeBreaker, artifactFile, cannedCompletion } from '../src/lib/evm-pool-keeper-prover.js';
import os from 'node:os';
import { chmodSync, existsSync as exists, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROUTER_ABI, revertName } from '../src/lib/evm-pool-keeper-chain.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

await test('revertName decodes a router/pool custom error from a viem revert', () => {
  const cause = new ContractFunctionRevertedError({ abi: ROUTER_ABI, data: toFunctionSelector('StaleRoot()'), functionName: 'completeDeposit' });
  const e = new ContractFunctionExecutionError(cause, { abi: ROUTER_ABI, functionName: 'completeDeposit', args: [] });
  assert.equal(revertName(e), 'StaleRoot');
  assert.equal(revertName(new Error('connection reset')), null);
});

await test('a proof is told of at most the CPUs it may use, once, whatever the host has', () => {
  const seen = os.cpus().length;
  assert.equal(capProverThreads(2), 2);
  assert.ok(os.cpus().length <= 2 && os.cpus().length >= 1, `${seen} CPUs listed before, ${os.cpus().length} after`);
  assert.equal(capProverThreads(8), 2, 'set once');
  assert.equal(capProverThreads(0), 2, 'a nonsense value changes nothing');
});

await test('artifacts from a URL must be pinned, are checked, and are cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-artifacts-'));
  try {
    const body = Buffer.from('zkey bytes');
    const sha = createHash('sha256').update(body).digest('hex');
    let fetches = 0;
    const fetchImpl = async () => { fetches++; return { ok: true, status: 200, arrayBuffer: async () => body }; };
    await assert.rejects(loadArtifact('https://x.test/z', { dir, name: 'zkey', fetchImpl }), /must be pinned/);
    await assert.rejects(loadArtifact('https://x.test/z', { sha256: '00'.repeat(32), dir, name: 'zkey', fetchImpl }), /does not match/);
    assert.deepEqual(await loadArtifact('https://x.test/z', { sha256: sha, dir, name: 'zkey', fetchImpl }), body);
    assert.deepEqual(await loadArtifact('https://x.test/z', { sha256: sha, dir, name: 'zkey', fetchImpl }), body);
    assert.equal(fetches, 2, 'an unpinned URL is never fetched; the second good load comes from the cache');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('artifactFile is the path itself, or where a pinned URL was cached', () => {
  assert.equal(artifactFile('/a/b.zkey', { dir: '/d', name: 'zkey' }), '/a/b.zkey');
  assert.equal(artifactFile('https://x.test/z', { sha256: '0xABCD', dir: '/d', name: 'zkey' }), '/d/zkey-abcd');
});

await test('the breaker opens after N failures in a row, lets one try through after the cool-down, and closes on a success', () => {
  let t = 0;
  const b = makeBreaker({ after: 3, coolMs: 1000, now: () => t });
  b.fail(); b.fail(); assert.equal(b.open, false);
  b.ok(); b.fail(); b.fail(); assert.equal(b.open, false, 'a success starts the count again');
  b.fail(); assert.equal(b.open, true);
  t = 999; assert.equal(b.open, true);
  t = 1000; assert.equal(b.open, false, 'one attempt after the cool-down');
  b.fail(); assert.equal(b.open, true, 'and it opens again if that fails');
  t = 2000; assert.equal(b.open, false);
  b.ok(); b.fail(); assert.equal(b.open, false);
});

const cfg = loadKeeperConfig({ EVM_POOL_ADDR: '0x1111111111111111111111111111111111111111', EVM_POOL_ROUTER_ADDR: '0x2222222222222222222222222222222222222222', EVM_POOL_RPC_URL: 'http://127.0.0.1:1' });
if (![cfg.wasm, cfg.zkey, cfg.vk].every(existsSync)) {
  console.log('skip - real prover: dev circuit artifacts not built');
} else {
  const snarkjs = await import('snarkjs');
  const w = await cannedCompletion();
  const { intent } = w;
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(w.input, cfg.wasm, cfg.zkey);

  await test('a deposit completion proves, verifies, and matches the Solidity calldata layout', async () => {
    const prover = await makeKeeperProver(cfg);
    const p = await prover.prove(w.input);
    assert.equal(p.via, 'snarkjs');
    assert.deepEqual(p.publicInputs.map(String), w.publicSignals);
    assert.equal(p.publicInputs[3], 4n);
    assert.equal(p.publicInputs[9], intent.outLeaf0);
    const cd = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
    const { toSolidityProof } = await import('../src/lib/evm-pool-keeper-prover.js');
    const mine = toSolidityProof(proof, publicSignals);
    const big = (x) => (Array.isArray(x) ? x.map(big) : BigInt(x));
    assert.deepEqual([mine.pA, mine.pB, mine.pC, mine.publicInputs], big(cd));
    assert.equal(await prover.verify(p), true, 'a calldata-shaped proof verifies');
    assert.equal(await prover.verify({ ...p, publicInputs: p.publicInputs.map((x, i) => (i === 5 ? x ^ 1n : x)) }), false, 'a changed public input does not');
    assert.equal(await prover.verify({ ...p, pA: [p.pA[0], p.pA[1] ^ 1n] }), false, 'a changed proof does not');
  });

  // The native path, against a stand-in for rapidsnark's `prover <zkey> <witness> <proof.json> <public.json>` that is a shell script (it runs
  // with a bare environment, so what it does is written into it) and a snarkjs whose proving is the one proof above, counted.
  const work = mkdtempSync(join(tmpdir(), 'keeper-native-test-'));
  const fixtures = { proof: join(work, 'fix-proof.json'), pub: join(work, 'fix-public.json'), badPub: join(work, 'fix-public-bad.json') };
  writeFileSync(fixtures.proof, JSON.stringify(proof));
  writeFileSync(fixtures.pub, JSON.stringify(publicSignals));
  writeFileSync(fixtures.badPub, JSON.stringify(publicSignals.map((x, i) => (i === 4 ? String(BigInt(x) + 1n) : x))));
  const USAGE = 'echo "Usage: prover <circuit.zkey> <witness.wtns> <proof.json> <public.json>" >&2; exit 255';
  let stubs = 0;
  const stub = (body) => {
    const f = join(work, `stub${stubs++}.sh`);
    writeFileSync(f, `#!/bin/sh\n[ $# -eq 0 ] && { ${USAGE}; }\necho "$@" >> "${f}.calls"\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  const calls = (f) => (exists(`${f}.calls`) ? readFileSync(`${f}.calls`, 'utf8').trim().split('\n').length : 0);
  const good = `cp "${fixtures.proof}" "$3"; cp "${fixtures.pub}" "$4"`;
  let fullProves = 0;
  const counted = { ...snarkjs, groth16: { ...snarkjs.groth16, fullProve: async () => { fullProves++; return { proof, publicSignals }; } } };
  const make = async (bin, extra = {}) => {
    const logs = [], tmp = mkdtempSync(join(work, 'tmp-'));
    const prover = await makeKeeperProver({ ...cfg, nativeProver: bin, nativeTmp: tmp, snarkjs: counted, nativeSelfTest: false, log: (m) => logs.push(m), ...extra });
    return { prover, logs, tmp, left: () => readdirSync(tmp) };
  };

  try {
    await test('a native proof is used when the binary gives a good one, tagged, checked, and its directory removed', async () => {
      const bin = stub(good);
      const before = fullProves;
      const { prover, logs, left } = await make(bin);
      assert.match(logs[0], /starts; its proofs are checked/);
      const p = await prover.prove(w.input);
      assert.equal(p.via, 'native');
      assert.equal(fullProves, before, 'snarkjs did not prove it');
      assert.deepEqual(p.publicInputs.map(String), w.publicSignals);
      assert.equal(await prover.verify(p), true);
      assert.equal(calls(bin), 1);
      assert.deepEqual(left(), [], 'the witness and proof files are gone');
      const args = readFileSync(`${bin}.calls`, 'utf8').trim().split(' ');
      assert.equal(args[0], cfg.zkey, 'it is given the zkey file');
      assert.match(args[1], /\/keeper-prove-[^/]+\/w\.wtns$/);
    });

    await test('whatever the binary does wrong, the proof is snarkjs\'s: a bad exit, a signal, garbage, a proof that does not verify, a hang', async () => {
      const cases = {
        exit: ['echo "bad zkey" >&2; exit 3', /native prover \(prove\): exit 3: bad zkey; this proof comes from snarkjs/],
        signal: ['kill -s ILL $$', /signal SIGILL/],
        garbage: ['echo not json > "$3"; echo "[]" > "$4"', /native prover \(prove\)/],
        short: [`cp "${fixtures.proof}" "$3"; echo "[]" > "$4"`, /native prover \(check\): 0 public signals, not 11/],
        wrong: [`cp "${fixtures.proof}" "$3"; cp "${fixtures.badPub}" "$4"`, /native prover \(check\): the proof does not verify/],
        hang: ['exec sleep 30', /timed out/],
      };
      for (const [name, [body, expect]] of Object.entries(cases)) {
        const bin = stub(body);
        const { prover, logs, left } = await make(bin, { nativeTimeoutMs: name === 'hang' ? 500 : 60_000 });
        const before = fullProves;
        const p = await prover.prove(w.input);
        assert.equal(p.via, 'snarkjs', name);
        assert.equal(fullProves, before + 1, `${name}: snarkjs made it`);
        assert.deepEqual(p.publicInputs.map(String), w.publicSignals, name);
        assert.match(logs.join('\n'), expect, name);
        assert.deepEqual(left(), [], `${name}: nothing left behind`);
      }
    });

    await test('three failures in a row switch the binary off until the cool-down passes, then one try, which a success closes', async () => {
      let t = 1_000_000;
      const bin = stub(`if [ -f "${work}/heal" ]; then ${good}; else exit 1; fi`);
      const { prover, logs } = await make(bin, { nativeBreakAfter: 3, nativeBreakSecs: 100, now: () => t });
      for (let i = 0; i < 5; i++) assert.equal((await prover.prove(w.input)).via, 'snarkjs');
      assert.equal(calls(bin), 3, 'tried three times, then not at all');
      assert.match(logs.join('\n'), /native proving is off for 100 s/);
      t += 100_000;
      assert.equal((await prover.prove(w.input)).via, 'snarkjs');
      assert.equal(calls(bin), 4, 'one try after the cool-down, which failed, so it is off again');
      assert.equal((await prover.prove(w.input)).via, 'snarkjs');
      assert.equal(calls(bin), 4);
      writeFileSync(join(work, 'heal'), '');
      t += 100_000;
      assert.equal((await prover.prove(w.input)).via, 'native', 'it works again and is used');
      assert.equal((await prover.prove(w.input)).via, 'native');
      assert.equal(calls(bin), 6);
      rmSync(join(work, 'heal'));
    });

    await test('the binary runs without this process\'s environment', async () => {
      process.env.EVM_POOL_KEEPER_PRIV_1 = '0xdeadbeefkeeperkey';
      process.env.SOME_API_TOKEN = 'secret-token-value';
      try {
        const bin = stub(`env > "${work}/env.txt"; ${good}`);
        const { prover } = await make(bin);
        assert.equal((await prover.prove(w.input)).via, 'native');
        const seen = readFileSync(join(work, 'env.txt'), 'utf8');
        assert.doesNotMatch(seen, /deadbeefkeeperkey|secret-token-value|EVM_POOL_KEEPER_PRIV/);
        assert.match(seen, /PATH=/);
      } finally { delete process.env.EVM_POOL_KEEPER_PRIV_1; delete process.env.SOME_API_TOKEN; }
    });

    await test('a binary that is missing or does not start is said so once and never used; proofs are snarkjs\'s', async () => {
      const notUsage = join(work, 'not-usage.sh');
      writeFileSync(notUsage, '#!/bin/sh\necho hello\n');
      chmodSync(notUsage, 0o755);
      for (const bin of [join(work, 'nope'), notUsage]) {
        const { prover, logs } = await make(bin);
        assert.equal(logs.length, 1);
        assert.match(logs[0], /does not start/);
        assert.equal((await prover.prove(w.input)).via, 'snarkjs');
        assert.equal(logs.length, 1, 'no further noise');
      }
    });

    await test('an input the circuit refuses fails at the witness: it is not the binary\'s failure and does not count toward the breaker', async () => {
      const bin = stub(good);
      const { prover, logs } = await make(bin, { nativeBreakAfter: 2 });
      const bad = { ...w.input, [Object.keys(w.input)[0]]: undefined };
      for (let i = 0; i < 4; i++) await prover.prove(bad).catch(() => {});
      assert.match(logs.join('\n'), /native prover \(witness\)/);
      assert.equal(calls(bin), 0, 'the binary was never asked');
      assert.equal((await prover.prove(w.input)).via, 'native', 'and a good input still goes to it');
    });

    await test('a working directory that cannot be made counts against the binary: three proofs later it is off, and the proofs are snarkjs\'s', async () => {
      const bin = stub(good);
      const { prover, logs } = await make(bin, { nativeTmp: join(work, 'no', 'such', 'dir'), nativeBreakAfter: 3 });
      for (let i = 0; i < 4; i++) assert.equal((await prover.prove(w.input)).via, 'snarkjs');
      assert.equal(calls(bin), 0);
      assert.equal(logs.filter((m) => /native prover \(setup\)/.test(m)).length, 3, 'said three times, then not tried');
    });

    await test('a snarkjs that cannot write a witness leaves the binary unused, said once', async () => {
      const bin = stub(good);
      const { prover, logs } = await make(bin, { snarkjs: { ...counted, wtns: undefined } });
      assert.equal(logs.length, 1);
      assert.match(logs[0], /cannot write a witness/);
      assert.equal((await prover.prove(w.input)).via, 'snarkjs');
    });

    await test('with the self-test on, a proof of the canned completion is tried at start in the background and timed in the log', async () => {
      const bin = stub(good);
      const { prover, logs } = await make(bin, { nativeSelfTest: true });
      for (let i = 0; i < 100 && !logs.some((m) => /self-test/.test(m)); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(logs.join('\n'), /native prover self-test: witness, proof and check in [\d.]+ s/);
      assert.equal(calls(bin), 1);
      assert.equal((await prover.prove(w.input)).via, 'native');
    });

    await test('a self-test the binary fails is said, counted once, and leaves the later proofs to try it', async () => {
      const bin = stub('exit 7');
      const { prover, logs } = await make(bin, { nativeSelfTest: true, nativeBreakAfter: 3 });
      for (let i = 0; i < 100 && !logs.some((m) => /native prover \(prove\)/.test(m)); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(logs.join('\n'), /native prover \(prove\): exit 7/);
      assert.doesNotMatch(logs.join('\n'), /self-test: witness/);
      assert.equal((await prover.prove(w.input)).via, 'snarkjs');
      assert.equal(calls(bin), 2, 'the self-test, then the first proof: one failure short of the breaker\'s three');
    });

    const real = process.env.RAPIDSNARK_PROVER;
    if (!real) console.log('skip - real rapidsnark: RAPIDSNARK_PROVER is not set');
    else {
      await test('the real rapidsnark binary proves the same statement: its proof verifies against the ceremony key and carries the witness\'s public signals', async () => {
        const { prover, logs } = await make(real);
        assert.match(logs[0], /starts/);
        const t0 = Date.now();
        const p = await prover.prove(w.input);
        console.log(`  (real binary: witness + proof + check in ${((Date.now() - t0) / 1000).toFixed(2)} s)`);
        assert.equal(p.via, 'native', logs.join('\n'));
        assert.deepEqual(p.publicInputs.map(String), w.publicSignals);
        assert.equal(await prover.verify(p), true);
        assert.equal(await prover.verify({ ...p, publicInputs: p.publicInputs.map((x, i) => (i === 3 ? x + 1n : x)) }), false);
      });
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
}

console.log(`\n${n} passed`);
process.exit(0);
