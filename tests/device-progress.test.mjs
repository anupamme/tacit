// A proof made on the holder's own machine (tacit-prover) says where it is: the relay client hands the page each update with the
// prover's stage (core, shrink, wrap, groth16), how long it has run and its estimate of the rest, so the forms and Activity can say
// "step 3 of 4, about 5 minutes left" and draw how far along it is.
//
// Run: node --test tests/device-progress.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfidentialRelay } from '../dapp/confidential-relay.js';

test('a prover on this machine passes its stage, run time and estimate through to the page', async () => {
  const relay = makeConfidentialRelay({ base: 'http://relay.invalid', fetchImpl: async () => { throw new Error('no relay here'); } });
  const own = async ({ onUpdate }) => {
    onUpdate({ requestId: 'device-w1', status: 'proving', stage: 'queued' });
    onUpdate({ requestId: 'device-w1', status: 'proving', stage: 'device', secs: 423, phase: 'wrap', eta: 280 });
    return { requestId: 'device-w1', publicValues: '0x' + '01'.repeat(32), proof: '0x07', private: true };
  };
  own.supports = () => true;
  relay.useProver(own);
  const seen = [];
  const r = await relay.prove({ type: 'wrap', op: {}, memos: [] }, { onUpdate: (st) => seen.push(st) });
  assert.equal(r.status, 'proven');
  const at = seen.find((x) => x.stage === 'device');
  assert.ok(at, 'an update while it proves');
  assert.deepEqual([at.jobId, at.phase, at.secs, at.eta], ['spn:device-w1', 'wrap', 423, 280]);
  assert.ok(!('phase' in seen[0]), 'the queued update has no stage of its own');
});
