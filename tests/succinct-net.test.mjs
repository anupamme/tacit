// dapp/succinct-net.js: the protobuf messages and gRPC-web framing it speaks, the EIP-191 signatures it sends, the decode
// of a real proof artifact against the settle() that put the same proof on chain, and the request → proof flow against a
// stubbed network.
//
// Run: node --test tests/succinct-net.test.mjs
//   ONLINE=1  also re-reads the fixture's settle transaction and network request, and checks the fixture proof with the
//             SP1 verifier gateway (eth_call; read-only).
//   LIVE=1    requests ONE real private proof from the test requester's own account (spends about 0.39 PROVE of its
//             credit), through a local /prover proxy, and checks it with the gateway. Nothing is settled.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 } from '../node_modules/@noble/hashes/sha256.js';
import {
  SPN, MESSAGES, encodeMessage, decodeMessage, grpcFrame, grpcUnframe, personalHash, signPersonal, addressOf,
  decodeProofArtifact, makeSuccinctNetwork, timeoutForGas, toHex, fromHex,
} from '../dapp/succinct-net.js';
import { handleProverUpload, handleProverDownload } from '../worker/src/prover-proxy.js';
import { http2Fetch } from './lib/spn-http2.mjs';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const crypto = { secp, keccak256: keccak_256 };
const FIX = new URL('./fixtures/succinct/', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('settle-83d2a154.json', FIX)));
const artifact = new Uint8Array(readFileSync(new URL(fixture.artifact, FIX)));
const ETH_RPC = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com';
const GATEWAY = '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2';

// ── protobuf ──

// A value for every field of a message, none of them the proto3 default.
function sample(name, depth = 0) {
  const obj = {};
  for (const [tag, key, kind, flags = 0] of MESSAGES[name]) {
    let v;
    if (kind === 'u64') v = 2n ** 40n + BigInt(tag);
    else if (kind === 'enum' || kind === 'u32') v = tag % 7 + 1;
    else if (kind === 'bool') v = true;
    else if (kind === 'bytes') v = Uint8Array.from({ length: 20 + (tag % 13) }, (_, i) => (i * 31 + tag) & 0xff);
    else if (kind === 'string') v = `${key}-${tag}-ü`;
    else v = depth < 3 ? sample(kind, depth + 1) : undefined;
    obj[key] = flags & 2 ? [v, v, v].map((x, i) => (x instanceof Uint8Array ? x.map((y) => y ^ i) : x)) : v;
  }
  return obj;
}

test('every message round-trips through encode and decode', () => {
  assert.deepEqual(Object.keys(MESSAGES).sort(), ['CreateArtifactRequest', 'CreateArtifactResponse', 'GetBalanceRequest', 'GetBalanceResponse',
    'GetFilteredProofRequestsRequest', 'GetFilteredProofRequestsResponse', 'GetNonceRequest', 'GetNonceResponse', 'GetProgramRequest', 'GetProgramResponse', 'GetProofRequestDetailsRequest', 'GetProofRequestDetailsResponse',
    'GetProofRequestParamsRequest', 'GetProofRequestParamsResponse', 'GetProofRequestStatusRequest', 'GetProofRequestStatusResponse', 'Program',
    'ProofRequest', 'RequestProofRequest', 'RequestProofRequestBody', 'RequestProofResponse', 'RequestProofResponseBody']);
  for (const name of Object.keys(MESSAGES)) {
    const obj = sample(name);
    const back = decodeMessage(name, encodeMessage(name, obj));
    assert.deepEqual(back, obj, name);
  }
});

test('encoding follows prost: tag order, proto3 defaults left out, optional fields kept when set', () => {
  // GetProofRequestParamsRequest { mode: GROTH16 } is what the network answers to (seen on the wire).
  assert.equal(toHex(encodeMessage('GetProofRequestParamsRequest', { mode: 4 })), '0x0804');
  assert.equal(toHex(encodeMessage('GetProofRequestParamsRequest', { mode: 0 })), '0x');
  // nonce 0, empty bytes, '' and false are not written; a set `optional` field is, even when empty.
  const b = encodeMessage('RequestProofRequestBody', { nonce: 0n, vkHash: new Uint8Array(0), version: '', stdinPrivate: false, publicValuesHash: new Uint8Array(0), gasLimit: 300n });
  assert.equal(toHex(b), '0x48ac028201' + '00');
  // Fields come out in tag order whatever order the object lists them in.
  const x = encodeMessage('RequestProofRequestBody', { stdinPrivate: true, nonce: 1n, whitelist: [new Uint8Array([0xaa]), new Uint8Array([0xbb])] });
  assert.equal(toHex(x), '0x0801' + '5a01aa' + '5a01bb' + 'a80101');
  // A request id field set from hex or bytes encodes the same.
  const id = fixture.requestId;
  assert.deepEqual(encodeMessage('GetProofRequestStatusRequest', { requestId: fromHex(id) }), Uint8Array.of(0x0a, 0x20, ...fromHex(id)));
});

test('decode skips unknown fields and refuses a wire type that does not fit the field', () => {
  const known = encodeMessage('GetNonceResponse', { nonce: 7n });
  const withUnknown = Uint8Array.of(0x12, 0x02, 0x01, 0x02, 0x1d, 1, 2, 3, 4, ...known);   // field 2 (bytes), field 3 (fixed32)
  assert.equal(decodeMessage('GetNonceResponse', withUnknown).nonce, 7n);
  assert.throws(() => decodeMessage('GetNonceResponse', Uint8Array.of(0x0a, 0x01, 0x00)), /wire type 2/);
  assert.throws(() => decodeMessage('GetNonceResponse', Uint8Array.of(0x08)), /truncated/);
  const empty = decodeMessage('GetProofRequestStatusResponse', new Uint8Array(0));
  assert.equal(empty.fulfillmentStatus, 0);
  assert.equal(empty.proofUri, undefined);
});

test('a captured GetProofRequestParams answer unframes and decodes', () => {
  // The network's answer to GetProofRequestParams(GROTH16) on 2026-10-15, as sent (one message frame, then trailers).
  const wire = fromHex('00000000a90a2055ea66757c5b1aecda6619905f594b320092db1cf4c8b6f89025c092f0bb7b5b12149836d448ab5bae7932adcefb00f3e13a33d47e281a14142e9e0d83373349a90268c64a61e1214cecf1712214ce53206de26ac8d894ffa9c5760ecb711305dd3d2a0936323030303030303032123338393631303030303030303030303030303a145d49fbb1c79bcae9b8a60dd04fa00b26a14d57344080ade2044a09323130303030303030800000000f677270632d7374617475733a300d0a');
  const { messages, trailers } = grpcUnframe(wire);
  assert.equal(messages.length, 1);
  assert.deepEqual(trailers, { 'grpc-status': '0' });
  const p = decodeMessage('GetProofRequestParamsResponse', messages[0]);
  assert.equal(toHex(p.domain), '0x55ea66757c5b1aecda6619905f594b320092db1cf4c8b6f89025c092f0bb7b5b');
  assert.equal(toHex(p.auctioneer), '0x9836d448ab5bae7932adcefb00f3e13a33d47e28');
  assert.equal(toHex(p.executor), '0x142e9e0d83373349a90268c64a61e1214cecf171');
  assert.equal(toHex(p.verifier), '0xce53206de26ac8d894ffa9c5760ecb711305dd3d');
  assert.equal(toHex(p.treasury), '0x5d49fbb1c79bcae9b8a60dd04fa00b26a14d5734');
  assert.equal(p.baseFee, '389610000000000000');
  assert.equal(p.maxPricePerPgu, '620000000');
  assert.equal(p.tickSize, 10000000n);
  assert.equal(p.networkFloorPricePerPgu, '210000000');
  // And the frame writer makes the same 5-byte header.
  assert.deepEqual(grpcFrame(Uint8Array.of(8, 4)), Uint8Array.of(0, 0, 0, 0, 2, 8, 4));
});

// ── signatures ──

test('EIP-191 signatures match cast and recover to the account', () => {
  const KEY = '0x' + '42'.repeat(32);
  assert.equal(addressOf(crypto, KEY), '0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025');
  // cast wallet sign --private-key 0x42…42 create_artifact / 0x0801120a0b0c
  assert.equal(toHex(signPersonal(crypto, KEY, 'create_artifact')),
    '0x54d225cf34ccf25be0296242e751229812e2af841dc2651989b2f3acdc0c6957091e9f24622be81b4fa42f626c976130495c6e15c4331440c937d3df8cd2d9711c');
  assert.equal(toHex(signPersonal(crypto, KEY, fromHex('0x0801120a0b0c'))),
    '0xc025c26e13613379ff3af3c745f86dd262bd9b8c39587ade6107d815ef69195c0221c40a2f258c149e3a1f3073d96748476a96112a34a0f2c971b558c1461d561b');
  // The CreateArtifact form (sp1-sdk's sign_message): same r‖s, v carried 27 higher.
  const sdk = signPersonal(crypto, KEY, 'create_artifact', 54);
  assert.equal(sdk[64], 0x1c + 27);
  for (const key of [KEY, '0x' + '01'.repeat(32), toHex(secp.utils.randomPrivateKey())]) {
    for (const msg of ['create_artifact', encodeMessage('RequestProofRequestBody', sample('RequestProofRequestBody'))]) {
      const sig = signPersonal(crypto, key, msg);
      assert.ok(sig[64] === 27 || sig[64] === 28);
      const pub = secp.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(sig[64] - 27).recoverPublicKey(personalHash(keccak_256, msg)).toRawBytes(false);
      assert.equal(toHex(keccak_256(pub.subarray(1)).subarray(12)), addressOf(crypto, key));
    }
  }
});

// ── the proof artifact ──

// settle(bytes publicValues, bytes proof, bytes[] memos) calldata → its three arguments.
function decodeSettle(input) {
  const b = fromHex(input);
  assert.equal(toHex(b.subarray(0, 4)), '0x717fd7f2');
  const w = (o) => Number(BigInt(toHex(b.subarray(4 + o, 4 + o + 32))));
  const bytesAt = (o) => { const n = w(o); return toHex(b.subarray(4 + o + 32, 4 + o + 32 + n)); };
  const memosAt = (o) => { const n = w(o); return Array.from({ length: n }, (_, k) => bytesAt(o + 32 + w(o + 32 + 32 * k))); };
  return { publicValues: bytesAt(w(0)), proof: bytesAt(w(32)), memos: memosAt(w(64)) };
}

test('a real fulfilled groth16 artifact decodes to the arguments of the settle that carried it', () => {
  const out = decodeProofArtifact(artifact);
  const onChain = decodeSettle(fixture.settle.input);
  assert.equal(fixture.settle.to, '0x000000000ed1eabd231be41d93b719056f7febfc');
  assert.equal(out.mode, 'groth16');
  assert.equal(out.publicValues, onChain.publicValues);
  assert.equal(out.proof, onChain.proof);
  assert.equal(out.sp1Version, 'v6.1.0');
  assert.equal(out.proof.slice(0, 10), out.vkeyHash.slice(0, 10));                 // first four bytes of the groth16 vkey hash
  assert.equal(BigInt(out.publicInputs[0]), BigInt(SPN.programVKey));               // a proof of the pool's program
  assert.equal((out.proof.length - 2) / 2, 4 + 352);
  // Truncated or foreign artifacts are refused rather than misread.
  assert.throws(() => decodeProofArtifact(artifact.subarray(0, artifact.length - 10)), /truncated/);
  assert.throws(() => decodeProofArtifact(Uint8Array.of(1, 0, 0, 0)), /compressed proof/);
  assert.throws(() => decodeProofArtifact(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0)), /zstd/);
});

// ── the flow, against a stubbed network ──

const KEY = '0x' + '07'.repeat(32);
const S3 = 'https://spn-artifacts-mainnet.s3.us-east-2.amazonaws.com';
const PARAMS = { domain: fromHex('55ea66757c5b1aecda6619905f594b320092db1cf4c8b6f89025c092f0bb7b5b'), auctioneer: fromHex('9836d448ab5bae7932adcefb00f3e13a33d47e28'),
  executor: fromHex('142e9e0d83373349a90268c64a61e1214cecf171'), verifier: fromHex('ce53206de26ac8d894ffa9c5760ecb711305dd3d'),
  maxPricePerPgu: '620000000', baseFee: '389610000000000000', treasury: fromHex('5d49fbb1c79bcae9b8a60dd04fa00b26a14d5734'), tickSize: 10000000n };
const zstdLike = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0xa0, 1, 0, 0, 0, 1, 0, 0, 0x61);

// A fake network: answers each gRPC-web method from `script`, records requests, and serves /prover/* like tacit-api.
function fakeNetwork({ statuses = [], art = null, grpcError = null } = {}) {
  const seen = [], uploads = [];
  let polls = 0;
  const reply = (name, obj) => new Response(new Uint8Array([...grpcFrame(encodeMessage(name, obj)), ...fromHex('800000000f677270632d7374617475733a300d0a')]),
    { status: 200, headers: { 'content-type': 'application/grpc-web+proto' } });
  const transport = async (url, init) => {
    const method = url.split('/').pop();
    const msg = grpcUnframe(new Uint8Array(init.body)).messages[0] || new Uint8Array(0);
    seen.push({ method, msg, headers: init.headers });
    if (grpcError && grpcError.method === method) return new Response(null, { status: 200, headers: { 'grpc-status': String(grpcError.status), 'grpc-message': encodeURIComponent(grpcError.message) } });
    switch (method) {
      case 'CreateArtifact': return reply('CreateArtifactResponse', art || { artifactUri: 's3://spn-artifacts-mainnet/private-stdins/artifact_01abc', artifactPresignedUrl: `${S3}/private-stdins/artifact_01abc?X-Amz-Signature=00` });
      case 'GetProofRequestParams': return reply('GetProofRequestParamsResponse', PARAMS);
      case 'GetNonce': return reply('GetNonceResponse', { nonce: 5n });
      case 'GetBalance': return reply('GetBalanceResponse', { amount: '838796601250000000' });
      case 'RequestProof': return reply('RequestProofResponse', { txHash: new Uint8Array(32).fill(2), body: { requestId: fromHex(fixture.requestId) } });
      case 'GetProofRequestStatus': {
        const s = statuses[Math.min(polls++, statuses.length - 1)];
        return reply('GetProofRequestStatusResponse', { deadline: BigInt(Math.floor(Date.now() / 1000) + 300), ...s,
          ...(s.fulfillmentStatus === 3 ? { proofUri: `${S3}/proofs/artifact_${'ab'.repeat(32)}?X-Amz-Signature=11` } : {}) });
      }
      case 'GetProofRequestDetails': return reply('GetProofRequestDetailsResponse', { request: { fulfiller: fromHex(SPN.provers[0]), fulfillerName: 'Succinct Labs 1', executeFailCause: 9, error: 1 } });
      default: throw new Error('unexpected ' + method);
    }
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const req = new Request(url, { method: init.method || 'GET', headers: init.headers, body: init.body });
    if (u.pathname === '/prover/upload' || u.pathname === '/prover/download') {
      const store = async (target, o = {}) => {
        if (o.method === 'PUT') { uploads.push({ url: target, bytes: new Uint8Array(o.body) }); return new Response(null, { status: 200 }); }
        return new Response(artifact, { status: 200 });
      };
      return (u.pathname === '/prover/upload' ? handleProverUpload : handleProverDownload)(req, {}, {}, { fetchImpl: store });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { transport, fetchImpl, seen, uploads };
}

test('requestProof sends a private, whitelisted, signed groth16 request; waitProof returns the decoded proof', async () => {
  const fake = fakeNetwork({ statuses: [{ fulfillmentStatus: 1, executionStatus: 1 }, { fulfillmentStatus: 2, executionStatus: 2 }, { fulfillmentStatus: 3, executionStatus: 2 }] });
  const net = makeSuccinctNetwork({ ...fake, proxyBase: 'https://api.example/', ...crypto });
  const t0 = Math.floor(Date.now() / 1000);
  const r = await net.requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 256_000_000, gasLimit: 100_000_000 });
  assert.equal(r.requestId, fixture.requestId);
  assert.equal(r.address, addressOf(crypto, KEY));

  // CreateArtifact: PRIVATE_STDIN, signed by the account over "create_artifact" (v = 54 + recovery, as sp1-sdk sends it).
  const ca = decodeMessage('CreateArtifactRequest', fake.seen.find((s) => s.method === 'CreateArtifact').msg);
  assert.equal(ca.artifactType, 7);
  const caPub = secp.Signature.fromCompact(ca.signature.subarray(0, 64)).addRecoveryBit(ca.signature[64] - 54).recoverPublicKey(personalHash(keccak_256, 'create_artifact')).toRawBytes(false);
  assert.equal(toHex(keccak_256(caPub.subarray(1)).subarray(12)), r.address);
  // The input went, unchanged, to the private-stdins object the request names.
  assert.equal(fake.uploads.length, 1);
  assert.equal(new URL(fake.uploads[0].url).pathname, '/private-stdins/artifact_01abc');
  assert.deepEqual(fake.uploads[0].bytes, zstdLike);

  const rp = decodeMessage('RequestProofRequest', fake.seen.find((s) => s.method === 'RequestProof').msg);
  const b = rp.body;
  assert.equal(rp.format, 1);
  assert.equal(b.nonce, 5n);
  assert.equal(toHex(b.vkHash), SPN.vkHash);
  assert.equal(b.version, 'sp1-v6.1.0');
  assert.equal(b.mode, 4);
  assert.equal(b.strategy, 3);
  assert.equal(b.stdinUri, 's3://spn-artifacts-mainnet/private-stdins/artifact_01abc');
  assert.equal(b.stdinPrivate, true);
  assert.deepEqual(b.whitelist.map(toHex), SPN.provers);
  assert.equal(b.cycleLimit, 256_000_000n);
  assert.equal(b.gasLimit, 100_000_000n);
  assert.equal(b.baseFee, PARAMS.baseFee);
  assert.equal(b.maxPricePerPgu, PARAMS.maxPricePerPgu);
  assert.deepEqual([b.domain, b.auctioneer, b.executor, b.verifier, b.treasury], [PARAMS.domain, PARAMS.auctioneer, PARAMS.executor, PARAMS.verifier, PARAMS.treasury]);
  assert.equal(b.publicValuesHash, undefined);
  assert.ok(Number(b.deadline) >= t0 + timeoutForGas(100_000_000) && Number(b.deadline) <= t0 + timeoutForGas(100_000_000) + 5);
  // The signature covers the body exactly as encoded on the wire.
  const bodyBytes = encodeMessage('RequestProofRequestBody', b);
  const pub = secp.Signature.fromCompact(rp.signature.subarray(0, 64)).addRecoveryBit(rp.signature[64] - 27).recoverPublicKey(personalHash(keccak_256, bodyBytes)).toRawBytes(false);
  assert.equal(toHex(keccak_256(pub.subarray(1)).subarray(12)), r.address);
  // gRPC-web headers the RPC's CORS allows.
  assert.deepEqual(fake.seen[0].headers, { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' });

  const updates = [];
  const out = await net.waitProof(r.requestId, { intervalMs: 5, onUpdate: (u) => updates.push(u) });
  assert.deepEqual(updates.map((u) => u.status), ['requested', 'assigned', 'proved']);
  assert.equal(updates[1].prover, SPN.provers[0]);
  assert.equal(updates[1].fulfillmentStatus, 'ASSIGNED');
  assert.equal(updates[1].executionStatus, 'EXECUTED');
  const onChain = decodeSettle(fixture.settle.input);
  assert.equal(out.publicValues, onChain.publicValues);
  assert.equal(out.proof, onChain.proof);
});

test('waitProof throws not_proved with the network codes when a request fails or runs past its deadline', async () => {
  const net1 = makeSuccinctNetwork({ ...fakeNetwork({ statuses: [{ fulfillmentStatus: 1, executionStatus: 1 }, { fulfillmentStatus: 4, executionStatus: 3 }] }), ...crypto });
  const updates = [];
  await assert.rejects(net1.waitProof(fixture.requestId, { intervalMs: 5, onUpdate: (u) => updates.push(u.status) }), (e) => {
    assert.equal(e.code, 'not_proved');
    assert.match(e.reason, /^unexecutable: fulfillment UNFULFILLABLE \(4\), execution UNEXECUTABLE \(3\), cause EXCEEDED_GAS_LIMIT \(9\), error EXECUTION_FAILURE \(1\)$/);
    assert.equal(e.network.fulfillmentStatus, 4);
    return true;
  });
  assert.deepEqual(updates, ['requested', 'failed']);

  const past = BigInt(Math.floor(Date.now() / 1000) - 5);
  const net2 = makeSuccinctNetwork({ ...fakeNetwork({ statuses: [{ fulfillmentStatus: 2, executionStatus: 2, deadline: past }] }), ...crypto });
  await assert.rejects(net2.waitProof(fixture.requestId, { intervalMs: 5 }), (e) => e.code === 'not_proved' && /^past its deadline while assigned/.test(e.reason));

  const net3 = makeSuccinctNetwork({ ...fakeNetwork({ statuses: [{ fulfillmentStatus: 1, executionStatus: 1 }] }), ...crypto });
  await assert.rejects(net3.waitProof(fixture.requestId, { intervalMs: 5, timeoutMs: 30 }), (e) => e.code === 'wait_timeout');
});

test('requestProof sends nothing that is not a private, whitelisted request', async () => {
  const pub = fakeNetwork({ art: { artifactUri: 's3://spn-artifacts-mainnet/stdins/artifact_01abc', artifactPresignedUrl: `${S3}/stdins/artifact_01abc?X-Amz-Signature=00` } });
  await assert.rejects(makeSuccinctNetwork({ ...pub, proxyBase: 'https://api.example', ...crypto }).requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 1, gasLimit: 1 }), /private-stdins/);
  assert.equal(pub.uploads.length, 0);
  assert.ok(!pub.seen.some((s) => s.method === 'RequestProof'));

  const mismatch = fakeNetwork({ art: { artifactUri: 's3://spn-artifacts-mainnet/private-stdins/artifact_other', artifactPresignedUrl: `${S3}/private-stdins/artifact_01abc?X-Amz-Signature=00` } });
  await assert.rejects(makeSuccinctNetwork({ ...mismatch, proxyBase: 'https://api.example', ...crypto }).requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 1, gasLimit: 1 }), /private-stdins/);
  assert.equal(mismatch.uploads.length, 0);

  const ok = fakeNetwork();
  const net = makeSuccinctNetwork({ ...ok, proxyBase: 'https://api.example', ...crypto });
  await assert.rejects(net.requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 1, gasLimit: 1, whitelist: [] }), /whitelist/);
  await assert.rejects(net.requestProof({ priv: KEY, stdinZstd: Uint8Array.of(1, 2, 3, 4), cycleLimit: 1, gasLimit: 1 }), /zstd/);
  await assert.rejects(net.requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 0, gasLimit: 1 }), /cycleLimit/);
  assert.equal(ok.seen.length, 0);
});

test('balance, needWei (params cached) and gRPC errors', async () => {
  const fake = fakeNetwork();
  const net = makeSuccinctNetwork({ ...fake, ...crypto });
  assert.equal(await net.balance('0x415E7F17ddb4cdE6aD5FbAabB2e87e3A5f4bad4b'), 838796601250000000n);
  assert.equal(await net.needWei({ gasLimit: 100_000_000 }), 100_000_000n * 620000000n + 389610000000000000n);
  assert.equal(await net.needWei({ gasLimit: 300_000_000 }), 300_000_000n * 620000000n + 389610000000000000n);
  assert.equal(fake.seen.filter((s) => s.method === 'GetProofRequestParams').length, 1);

  const bad = makeSuccinctNetwork({ ...fakeNetwork({ grpcError: { method: 'GetBalance', status: 3, message: 'invalid address' } }), ...crypto });
  await assert.rejects(bad.balance('0x415E7F17ddb4cdE6aD5FbAabB2e87e3A5f4bad4b'), (e) => e.code === 'rpc' && e.grpcStatus === 3 && /INVALID_ARGUMENT - invalid address/.test(e.message));
  const missing = makeSuccinctNetwork({ ...fakeNetwork({ grpcError: { method: 'GetProgram', status: 5, message: 'not found' } }), ...crypto });
  assert.equal(await missing.program(), null);
});

// ── a program input for the wrap fixture (exec-wrap.rs's write order) and a raw-block zstd frame ──

const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const vecU8 = (h) => { const b = fromHex(h); return cat(u64le(b.length), b); };     // bincode Vec<u8>

// bincode(SP1Stdin { buffer: Vec<Vec<u8>>, ptr: usize, proofs: Vec<_> }), each item itself the bincode of one write().
function wrapStdin(f, memoHashes) {
  const zero = '0x' + '00'.repeat(32);
  const items = [vecU8(f.chainBinding), vecU8(zero), vecU8(zero), vecU8(zero), vecU8(zero), vecU8(zero), u32le(1), Uint8Array.of(0),
    vecU8(f.asset), u64le(BigInt(f.value)), vecU8(f.cx), vecU8(f.cy), vecU8(f.owner), vecU8(f.sigR), vecU8(f.sigZ), ...memoHashes.map(vecU8)];
  return cat(u64le(items.length), ...items.map((it) => cat(u64le(it.length), it)), u64le(0), u64le(0));
}
// A zstd frame of raw (stored) blocks: single segment, 4-byte content size, no checksum.
function zstdRaw(data) {
  const parts = [Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0xa0), u32le(data.length)];
  for (let o = 0; o === 0 || o < data.length; o += 131072) {
    const n = Math.min(131072, data.length - o), last = o + n >= data.length ? 1 : 0, h = (n << 3) | last;
    parts.push(Uint8Array.of(h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff), data.subarray(o, o + n));
    if (!n) break;
  }
  return cat(...parts);
}
const WRAP = JSON.parse(readFileSync(new URL('../contracts/sp1/confidential/fixtures/wrap_op.json', import.meta.url)));
const WRAP_MEMOS = ['0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'];

test('the test\'s wrap input is a valid zstd frame of the expected SP1Stdin', { skip: !hasZstd() && 'zstd CLI not installed' }, () => {
  const stdin = wrapStdin(WRAP, WRAP_MEMOS);
  assert.equal(stdin.length, 8 + 16 * 8 + (40 * 6 + 4 + 1 + 40 + 8 + 40 * 3 + 41 + 40 + 40) + 16);
  const back = execFileSync('zstd', ['-d', '-c', '-q'], { input: zstdRaw(stdin) });
  assert.deepEqual(new Uint8Array(back), stdin);
});
function hasZstd() { try { execFileSync('zstd', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }

// ── online checks ──

async function ethRpc(method, params) {
  const r = await fetch(ETH_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data });
  return j.result;
}
// SP1VerifierGateway.verifyProof(bytes32 programVKey, bytes publicValues, bytes proofBytes): reverts unless the proof holds.
function verifyProofCall(pv, proof) {
  const b = (h) => { const x = String(h).slice(2); const n = x.length / 2; return BigInt(n).toString(16).padStart(64, '0') + x.padEnd(Math.ceil(n / 32) * 64, '0'); };
  const pvEnc = b(pv), offProof = 96 + pvEnc.length / 2;
  return '0x41493c60' + SPN.programVKey.slice(2) + (96).toString(16).padStart(64, '0') + offProof.toString(16).padStart(64, '0') + pvEnc + b(proof);
}

test('online: the fixture matches the chain and the network, and the gateway accepts its proof', { skip: !process.env.ONLINE && 'set ONLINE=1' }, async () => {
  const tx = await ethRpc('eth_getTransactionByHash', [fixture.settle.txHash]);
  assert.equal(tx.input, fixture.settle.input);
  assert.equal(tx.to.toLowerCase(), fixture.settle.to);
  const out = decodeProofArtifact(artifact);
  assert.equal(await ethRpc('eth_call', [{ to: GATEWAY, data: verifyProofCall(out.publicValues, out.proof) }, 'latest']), '0x');
  // A flipped byte in the proof does not verify.
  const bad = out.proof.slice(0, 80) + (out.proof[80] === '0' ? '1' : '0') + out.proof.slice(81);
  await assert.rejects(ethRpc('eth_call', [{ to: GATEWAY, data: verifyProofCall(out.publicValues, bad) }, 'latest']));
  const transport = http2Fetch();
  try {
    const net = makeSuccinctNetwork({ transport, ...crypto });
    const d = await net.details(fixture.requestId);
    assert.equal(toHex(d.requester), fixture.requester);
    assert.equal(toHex(d.fulfiller), fixture.fulfiller);
    assert.equal(toHex(d.vkHash), SPN.vkHash);
    assert.equal(d.mode, 4);
    assert.equal(d.fulfillmentStatus, 3);
    assert.equal(d.stdinPrivate, true);
    const p = await net.program();
    assert.equal(p.vkHash, SPN.vkHash);
  } finally { transport.close(); }
});

// ── LIVE: one real private proof from the test requester's own account ──

test('LIVE: a private proof requested from the account\'s own credit verifies on chain', { skip: !process.env.LIVE && 'set LIVE=1 (spends about 0.39 PROVE)', timeout: 15 * 60e3 }, async () => {
  const keyFile = `${os.homedir()}/.tacit-validation/spn-private-test-2026-10-15.json`;
  assert.ok(existsSync(keyFile), 'test requester key file');
  const entry = Object.values(JSON.parse(readFileSync(keyFile, 'utf8')))[0];
  const priv = entry.private_key;
  assert.equal(addressOf(crypto, priv), entry.address.toLowerCase());
  const address = entry.address;

  // A local tacit-api stand-in serving only the two proxy routes.
  const server = http.createServer(async (nreq, nres) => {
    const chunks = [];
    for await (const c of nreq) chunks.push(c);
    const headers = {};
    for (const h of ['content-type', 'x-artifact-url']) if (nreq.headers[h]) headers[h] = nreq.headers[h];
    const req = new Request(`http://127.0.0.1${nreq.url}`, { method: nreq.method, headers, body: nreq.method === 'POST' ? Buffer.concat(chunks) : undefined });
    const res = await (nreq.url === '/prover/upload' ? handleProverUpload : handleProverDownload)(req, {}, { 'Access-Control-Allow-Origin': '*' });
    nres.writeHead(res.status, Object.fromEntries(res.headers));
    nres.end(Buffer.from(await res.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const proxyBase = `http://127.0.0.1:${server.address().port}`;
  const transport = http2Fetch();
  try {
    const net = makeSuccinctNetwork({ transport, proxyBase, ...crypto });
    const gasLimit = 50_000_000, cycleLimit = 256_000_000;
    const before = await net.balance(address);
    const need = await net.needWei({ gasLimit });
    console.log(`credit before ${Number(before) / 1e18} PROVE; a request at ${gasLimit} gas needs ${Number(need) / 1e18} on hand`);
    assert.ok(before >= need, 'test account credit');

    const stdinZstd = zstdRaw(wrapStdin(WRAP, WRAP_MEMOS));
    const t0 = Date.now();
    const r = await net.requestProof({ priv, stdinZstd, cycleLimit, gasLimit });
    console.log(`request ${r.requestId} (tx ${r.txHash}), deadline ${new Date(r.deadline * 1000).toISOString()}`);
    let out;
    try {
      out = await net.waitProof(r.requestId, {
        intervalMs: 3000,
        onUpdate: (u) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} s  ${u.status}  ${u.fulfillmentStatus}/${u.executionStatus}${u.prover ? '  by ' + (u.proverName || u.prover) : ''}`),
      });
    } catch (e) {
      const after = await net.balance(address).catch(() => null);
      console.log(`not proved: ${e.code} ${e.reason || e.message}; credit after ${after == null ? '?' : Number(after) / 1e18} PROVE`);
      throw e;
    }
    const secs = (Date.now() - t0) / 1000;
    console.log(`proved in ${secs.toFixed(1)} s by ${out.proverName || out.prover}; public values ${(out.publicValues.length - 2) / 2} bytes, proof ${(out.proof.length - 2) / 2} bytes`);

    const d = await net.details(r.requestId);
    assert.equal(d.stdinPrivate, true);
    assert.equal(toHex(d.requester), address.toLowerCase());
    assert.deepEqual(d.whitelist.map(toHex), SPN.provers);
    assert.equal(await ethRpc('eth_call', [{ to: GATEWAY, data: verifyProofCall(out.publicValues, out.proof) }, 'latest']), '0x');
    console.log('SP1 verifier gateway: verifyProof accepted the proof');
    const after = await net.balance(address);
    console.log(`credit after ${Number(after) / 1e18} PROVE (spent ${Number(before - after) / 1e18}); gas used ${d.gasUsed ?? '-'}, cycles ${d.cycles ?? '-'}`);
  } finally {
    transport.close();
    server.close();
  }
});

// ── a paid request is not lost to a blip ──

const replyOf = (name, obj) => new Response(new Uint8Array([...grpcFrame(encodeMessage(name, obj)), ...fromHex('800000000f677270632d7374617475733a300d0a')]),
  { status: 200, headers: { 'content-type': 'application/grpc-web+proto' } });
const INPUT_URI = 's3://spn-artifacts-mainnet/private-stdins/artifact_01abc';

test('a RequestProof answer lost on the way back is found again by its input, and never asked for twice', async () => {
  const fake = fakeNetwork();
  let lost = 1;
  const transport = async (url, init) => {
    const method = url.split('/').pop();
    if (method === 'RequestProof' && lost-- > 0) { fake.seen.push({ method }); throw new TypeError('the network connection was lost'); }
    if (method === 'GetFilteredProofRequests') {
      fake.seen.push({ method });
      return replyOf('GetFilteredProofRequestsResponse', { requests: [
        { requestId: fromHex('11'.repeat(32)), stdinUri: 's3://spn-artifacts-mainnet/private-stdins/artifact_other' },
        { requestId: fromHex(fixture.requestId), stdinUri: INPUT_URI }] });
    }
    return fake.transport(url, init);
  };
  const net = makeSuccinctNetwork({ transport, fetchImpl: fake.fetchImpl, proxyBase: 'https://api.example', ...crypto });
  const r = await net.requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 1, gasLimit: 100_000_000 });
  assert.equal(r.requestId, fixture.requestId);
  assert.equal(fake.seen.filter((s) => s.method === 'RequestProof').length, 1);

  // A refusal the network answered is final: nothing is looked up, and the error is the network's.
  const refused = fakeNetwork({ grpcError: { method: 'RequestProof', status: 9, message: 'insufficient balance' } });
  await assert.rejects(makeSuccinctNetwork({ ...refused, proxyBase: 'https://api.example', ...crypto }).requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 1, gasLimit: 1 }),
    (e) => e.grpcStatus === 9 && /insufficient balance/.test(e.message));
  assert.ok(!refused.seen.some((s) => s.method === 'GetFilteredProofRequests'));
});

test('waitProof waits out dropped polls and a rate-limited download, and its errors carry the request id', async () => {
  const fake = fakeNetwork({ statuses: [{ fulfillmentStatus: 2, executionStatus: 2 }, { fulfillmentStatus: 3, executionStatus: 2 }] });
  let drops = 3, limited = 2;
  const transport = async (url, init) => {
    if (url.endsWith('/GetProofRequestStatus') && drops-- > 0) throw new TypeError('Failed to fetch');
    return fake.transport(url, init);
  };
  const fetchImpl = async (url, init) => (new URL(url).pathname === '/prover/download' && limited-- > 0
    ? new Response('{"ok":false}', { status: 429, headers: { 'retry-after': '0' } }) : fake.fetchImpl(url, init));
  const net = makeSuccinctNetwork({ transport, fetchImpl, proxyBase: 'https://api.example', ...crypto });
  const out = await net.waitProof(fixture.requestId, { intervalMs: 5 });
  assert.equal(out.proof, decodeSettle(fixture.settle.input).proof);
  assert.equal(limited, -1);

  // A download refused for good (not rate-limited, not a server failure) ends the wait at once, with the id to resume by.
  const gone = makeSuccinctNetwork({ ...fakeNetwork({ statuses: [{ fulfillmentStatus: 3, executionStatus: 2 }] }),
    fetchImpl: async () => new Response('{"ok":false}', { status: 400 }), proxyBase: 'https://api.example', ...crypto });
  await assert.rejects(gone.waitProof(fixture.requestId, { intervalMs: 5 }), (e) => e.code === 'download' && e.requestId === fixture.requestId);
});

test('self-prover: one request at a time per account, the request id on every later error, and resume picks up a paid proof', async () => {
  const { makeSelfProver } = await import('../dapp/self-prover.js');
  const op = JSON.parse(readFileSync(new URL('./fixtures/sp1-stdin/wrap.op.json', import.meta.url)));
  const fake = fakeNetwork({ statuses: [{ fulfillmentStatus: 3, executionStatus: 2 }] });
  let inFlight = 0, most = 0;
  const transport = async (url, init) => {
    const method = url.split('/').pop();
    if (method === 'CreateArtifact') { inFlight++; most = Math.max(most, inFlight); await new Promise((r) => setTimeout(r, 20)); }
    if (method === 'RequestProof') inFlight--;
    return fake.transport(url, init);
  };
  const sp = makeSelfProver({ priv: () => KEY, address: addressOf(crypto, KEY), ...crypto, transport, fetchImpl: fake.fetchImpl, proxyBase: 'https://api.example' });
  const stages = [];
  const [a, b] = await Promise.all([0, 1].map((i) => sp.prove({ type: 'wrap', op, memos: ['0x0' + i], onUpdate: (u) => i === 0 && stages.push(u.stage) })));
  assert.equal(most, 1);
  assert.equal(a.requestId, fixture.requestId);
  assert.equal(b.proof, a.proof);
  assert.deepEqual(stages, ['uploading', 'requested', 'proved']);

  const r = await sp.resume(fixture.requestId);
  assert.equal(r.proof, a.proof);

  // A download that fails for good after the request was made: the error names the request, so the page can resume it.
  const sp2 = makeSelfProver({ priv: () => KEY, address: addressOf(crypto, KEY), ...crypto, transport: fake.transport,
    fetchImpl: async (url, init) => (new URL(url).pathname === '/prover/download' ? new Response('{}', { status: 400 }) : fake.fetchImpl(url, init)), proxyBase: 'https://api.example' });
  await assert.rejects(sp2.prove({ type: 'wrap', op, memos: ['0x01'] }), (e) => e.requestId === fixture.requestId);
});

// ── while the network refuses private inputs ──

// The fake network refusing every private input as mainnet did from 2026-10-15 22:11 UTC, and handing out stdins/ artifacts for public ones.
function privateOffNetwork(statuses = [{ fulfillmentStatus: 3, executionStatus: 2 }]) {
  const fake = fakeNetwork({ statuses });
  const asked = [];
  const transport = async (url, init) => {
    const method = url.split('/').pop();
    const msg = grpcUnframe(new Uint8Array(init.body)).messages[0] || new Uint8Array(0);
    if (method === 'CreateArtifact' && decodeMessage('CreateArtifactRequest', msg).artifactType === 2) {
      fake.seen.push({ method, msg });
      return replyOf('CreateArtifactResponse', { artifactUri: 's3://spn-artifacts-mainnet/stdins/artifact_01pub', artifactPresignedUrl: `${S3}/stdins/artifact_01pub?X-Amz-Signature=00` });
    }
    if (method === 'RequestProof') {
      const b = decodeMessage('RequestProofRequest', msg).body;
      asked.push(b);
      if (b.stdinPrivate) return new Response(null, { status: 200, headers: { 'grpc-status': '7', 'grpc-message': encodeURIComponent('private stdin is not enabled on this network') } });
    }
    return fake.transport(url, init);
  };
  return { ...fake, transport, asked };
}

test('a refused private input goes public (auto): nothing was created for the refusal, and the next request goes public at once', async () => {
  const off = privateOffNetwork();
  const net = makeSuccinctNetwork({ transport: off.transport, fetchImpl: off.fetchImpl, proxyBase: 'https://api.example', ...crypto });
  let told = 0;
  const r = await net.requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 1, gasLimit: 100_000_000, input: 'auto', onPublic: () => { told++; } });
  assert.equal(r.private, false);
  assert.equal(r.requestId, fixture.requestId);
  assert.equal(told, 1);
  assert.deepEqual(off.asked.map((b) => b.stdinPrivate), [true, false]);
  assert.equal(off.asked[1].stdinUri, 's3://spn-artifacts-mainnet/stdins/artifact_01pub');
  assert.deepEqual(off.asked[1].whitelist, []);                                        // public: any prover may take it
  assert.deepEqual(off.uploads.map((u) => new URL(u.url).pathname), ['/private-stdins/artifact_01abc', '/stdins/artifact_01pub']);
  assert.equal(net.privateOff(), true);

  const again = await net.requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 1, gasLimit: 100_000_000, input: 'auto' });
  assert.equal(again.private, false);
  assert.deepEqual(off.asked.map((b) => b.stdinPrivate), [true, false, false]);           // no second refused attempt
});

test('private only: a network refusing private inputs throws private_off and sends no public request', async () => {
  const off = privateOffNetwork();
  const net = makeSuccinctNetwork({ transport: off.transport, fetchImpl: off.fetchImpl, proxyBase: 'https://api.example', ...crypto });
  await assert.rejects(net.requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'private_off' && e.grpcStatus === 7);
  assert.deepEqual(off.asked.map((b) => b.stdinPrivate), [true]);
  assert.equal(off.uploads.length, 1);
  await assert.rejects(net.requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 1, gasLimit: 1, input: 'public' }), /input must be/);
});

test('a credit too low for the request is final: no lookup for a request that was never made', async () => {
  const short = fakeNetwork({ grpcError: { method: 'RequestProof', status: 8, message: 'insufficient balance 0.0573 PROVE for request cost 0.3941 PROVE' } });
  const net = makeSuccinctNetwork({ ...short, proxyBase: 'https://api.example', ...crypto });
  const t0 = Date.now();
  await assert.rejects(net.requestProof({ priv: KEY, stdinZstd: zstdLike, cycleLimit: 1, gasLimit: 1 }), /insufficient balance/);
  assert.ok(!short.seen.some((s) => s.method === 'GetFilteredProofRequests'));
  assert.ok(Date.now() - t0 < 1500);
});

test('self-prover: with private inputs refused, the proof goes public, every step after says so, and the result says private: false', async () => {
  const { makeSelfProver } = await import('../dapp/self-prover.js');
  const op = JSON.parse(readFileSync(new URL('./fixtures/sp1-stdin/wrap.op.json', import.meta.url)));
  const off = privateOffNetwork();
  const sp = makeSelfProver({ priv: () => KEY, address: addressOf(crypto, KEY), ...crypto, transport: off.transport, fetchImpl: off.fetchImpl, proxyBase: 'https://api.example' });
  const steps = [];
  const r = await sp.prove({ type: 'wrap', op, memos: ['0x01'], onUpdate: (u) => steps.push(`${u.stage}${u.public ? ':public' : ''}`) });
  assert.equal(r.private, false);
  assert.deepEqual(steps, ['uploading', 'uploading:public', 'requested:public', 'proved:public']);
  assert.equal(sp.privateOff(), true);
  const strict = makeSelfProver({ priv: () => KEY, address: addressOf(crypto, KEY), ...crypto, transport: privateOffNetwork().transport, fetchImpl: off.fetchImpl, proxyBase: 'https://api.example', input: 'private' });
  await assert.rejects(strict.prove({ type: 'wrap', op, memos: ['0x01'] }), (e) => e.code === 'private_off');
});
