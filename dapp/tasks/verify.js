// What the tasks page checks about a step before it asks a wallet to send it: that the call data it is about to send is the plan's, so a
// job's file and its payload cannot disagree and the address a step creates is the address the job names. Pure; nothing here reads
// the chain.
import { keccak_256, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';

export const CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
const DEPLOY_CREATE2 = '0x26307668';                    // CreateX.deployCreate2(bytes32 salt, bytes initCode)
const strip = (h) => String(h).replace(/^0x/, '');
const keccak = (hex) => `0x${bytesToHex(keccak_256(hexToBytes(strip(hex) || '')))}`;
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// The salt CreateX hashes with the chain id when a salt begins with 20 zero bytes and the flag 0x01.
export const guardedSalt = (chainId, salt) => keccak(word(chainId) + strip(salt));
export const create2 = (factory, guarded, initCodeHash) => `0x${strip(keccak(`ff${strip(factory)}${strip(guarded)}${strip(initCodeHash)}`)).slice(24)}`;

// → { salt, initCode } from deployCreate2 call data, or null when it is anything else.
export function decodeDeployCreate2(data) {
  const h = strip(data);
  if (`0x${h.slice(0, 8)}` !== DEPLOY_CREATE2) return null;
  const body = h.slice(8);
  const at = Number(BigInt(`0x${body.slice(64, 128)}`)) * 2, len = Number(BigInt(`0x${body.slice(at, at + 64)}`)) * 2;
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(len) || body.length < at + 64 + len) return null;
  return { salt: `0x${body.slice(0, 64)}`, initCode: `0x${body.slice(at + 64, at + 64 + len)}` };
}

// → [] when `tx` ({ to, data, value }) is exactly what `step` says it is, else what is wrong.
export function checkStep(job, step, tx) {
  const bad = [];
  if (!same(tx.to, step.to)) bad.push(`sends to ${tx.to}, not ${step.to}`);
  if (BigInt(tx.value || 0) !== 0n) bad.push('carries ETH');
  if (step.kind === 'createx') {
    const d = decodeDeployCreate2(tx.data);
    if (!d) return [...bad, 'is not a CreateX deployment'];
    if (!same(d.salt, step.salt)) bad.push('uses another salt');
    const hash = keccak(d.initCode);
    if (!same(hash, step.initCodeHash)) bad.push('deploys other code than the plan');
    if (!same(create2(CREATEX, guardedSalt(job.chainId, d.salt), hash), step.expected)) bad.push('would not land at the planned address');
  } else if (!same(keccak(tx.data), step.dataHash)) bad.push('calls with other data than the plan');
  return bad;
}

// Every step of a payload against its job: { ok, problems: [{ step, bad }] }. A payload with a different list of steps fails as a whole.
export function checkPayload(job, payload) {
  const problems = [];
  if (payload.chainId !== job.chainId || !same(payload.factory, CREATEX)) problems.push({ step: '*', bad: ['is for another chain or factory'] });
  if (payload.steps.length !== job.steps.length) problems.push({ step: '*', bad: ['has another number of steps'] });
  for (const [i, step] of job.steps.entries()) {
    const tx = payload.steps[i];
    if (!tx || tx.id !== step.id) { problems.push({ step: step.id, bad: ['is not at its place in the payload'] }); continue; }
    const bad = checkStep(job, step, tx);
    if (bad.length) problems.push({ step: step.id, bad });
  }
  return { ok: problems.length === 0, problems };
}
