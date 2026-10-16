// A browser (and Node) client for the Succinct prover network (mainnet), for proving a confidential-pool op with the
// holder's own network account.
//
// The account is an ordinary EOA key: its credit on the network pays for each proof, and it signs every request. What
// this file does mirrors sp1-sdk 6.2.3's NetworkProver for
//   prove(pk, stdin).groth16().cycle_limit(c).gas_limit(g).private_stdin(true).whitelist(Some(w)).request()
// with FulfillmentStrategy::Auction on Mainnet (sp1-sdk src/network/{client,prover}.rs):
//   1. CreateArtifact(PRIVATE_STDIN), signed with EIP-191 over "create_artifact"; PUT zstd(bincode(SP1Stdin)) to the
//      presigned URL it returns (always a private-stdins/ object, checked here).
//   2. GetProofRequestParams(GROTH16) for the domain, auctioneer, executor, verifier, treasury, base fee and price cap;
//      GetNonce for the account.
//   3. RequestProof with stdin_private = true and the prover whitelist, signed with EIP-191 over the encoded body.
//   4. Poll GetProofRequestStatus until FULFILLED, UNFULFILLABLE or past the deadline; download the proof artifact and
//      decode it into the (publicValues, proof) pair settle() takes.
// There is no public-input path: an input sent here is only ever a private artifact, read by the network's executor and
// the whitelisted prover through the signed GetStdinUri call.
//
// Transport. The RPC speaks gRPC-web (application/grpc-web+proto) and answers browsers over HTTP/2 with CORS for the
// page's origin. It refuses HTTP/1.1, so Node callers pass `transport` (a fetch-shaped HTTP/2 client; see
// tests/lib/spn-http2.mjs). The artifact store (S3 presigned URLs) sends no CORS headers, so a page passes `proxyBase`
// and the upload and download go through tacit-api's /prover/upload and /prover/download (worker/src/prover-proxy.js);
// without `proxyBase` they go straight to the URL (Node).
//
// Protobuf. Hand-written and minimal: each message is a list of [tag, name, kind] taken from succinctlabs/network
// proto/artifact.proto and proto/types.proto (as vendored in sp1-sdk 6.2.3 src/network/proto/{artifact,auction/types}.rs).
// Encoding follows prost: fields in tag order, proto3 defaults (0, '', empty bytes, false) left out, `optional` fields
// written when set. The request signature covers these bytes, so the encoding must be byte-for-byte prost's.

export const SPN = Object.freeze({
  rpc: 'https://rpc.mainnet.succinct.xyz',
  // The confidential-pool guest as registered on the network (GetProgram), and the same program's verifying key as
  // the on-chain SP1 verifier names it (the first public input of each groth16 proof).
  vkHash: '0x366a3fe90e4de9b448ed2d954e28c22d16354140111f9ab10b46ae3b6232d6e3',
  programVKey: '0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3',
  version: 'sp1-v6.1.0',
  mode: 4,                                                         // ProofMode.GROTH16
  strategy: 3,                                                     // FulfillmentStrategy.AUCTION
  // Provers that fetch a private input (GetStdinUri) and deliver. On 2026-10-15 only Succinct Labs 1 did; an auction
  // winner that cannot read the input lets the request expire, and an expired request still pays the base fee.
  provers: Object.freeze(['0xd4fcfce0dee91a9895c3ad71a6248d57c287a4f5']),
});

// The artifact store: presigned S3 URLs from CreateArtifact (uploads) and GetProofRequestStatus (downloads); the CDN
// serves the same objects for reading.
export const ARTIFACT_S3_HOST = 'spn-artifacts-mainnet.s3.us-east-2.amazonaws.com';
export const ARTIFACT_HOSTS = Object.freeze([ARTIFACT_S3_HOST, 'artifacts.mainnet.succinct.xyz']);
const PRIVATE_STDIN_PATH = /^\/private-stdins\/[A-Za-z0-9_-]{1,200}$/;

export const ARTIFACT_TYPE = Object.freeze({ PROGRAM: 1, STDIN: 2, PROOF: 3, PRIVATE_STDIN: 7 });
export const FULFILLMENT_STATUS = Object.freeze(['UNSPECIFIED', 'REQUESTED', 'ASSIGNED', 'FULFILLED', 'UNFULFILLABLE', 'REVERTED', 'EXPIRED']);
export const EXECUTION_STATUS = Object.freeze(['UNSPECIFIED', 'UNEXECUTED', 'EXECUTED', 'UNEXECUTABLE', 'VALIDATION_FAILED']);
export const EXECUTE_FAILURE_CAUSE = Object.freeze(['UNSPECIFIED', 'HALT_WITH_NON_ZERO_EXIT_CODE', 'INVALID_MEMORY_ACCESS', 'UNSUPPORTED_SYSCALL',
  'BREAKPOINT', 'EXCEEDED_CYCLE_LIMIT', 'INVALID_SYSCALL_USAGE', 'UNIMPLEMENTED', 'END_IN_UNCONSTRAINED', 'EXCEEDED_GAS_LIMIT']);
export const PROOF_REQUEST_ERROR = Object.freeze(['UNSPECIFIED', 'EXECUTION_FAILURE', 'VERIFICATION_KEY_MISMATCH', 'UNKNOWN_FAILURE',
  'PUBLIC_VALUES_MISMATCH', 'VERIFICATION_FAILURE']);
const GRPC_CODES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];

// ── bytes ──
const te = new TextEncoder(), td = new TextDecoder();
export const toHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h, len) {
  const s = String(h).replace(/^0x/i, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('succinct-net: not hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  if (len != null && out.length !== len) throw new Error(`succinct-net: expected ${len} bytes, got ${out.length}`);
  return out;
}
function asBytes(v, len) {
  const b = v instanceof Uint8Array ? v : fromHex(v);
  if (len != null && b.length !== len) throw new Error(`succinct-net: expected ${len} bytes, got ${b.length}`);
  return b;
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ── protobuf ──
// Kinds: 'u64' (BigInt), 'enum' and 'u32' (Number), 'bool', 'bytes' (Uint8Array), 'string', or a message name.
// Flags: OPT = proto3 `optional` (presence tracked; written when not null), REP = repeated.
const OPT = 1, REP = 2;
export const MESSAGES = Object.freeze({
  // proto/artifact.proto
  CreateArtifactRequest: [[1, 'signature', 'bytes'], [2, 'artifactType', 'enum']],
  CreateArtifactResponse: [[1, 'artifactUri', 'string'], [2, 'artifactPresignedUrl', 'string']],
  // proto/types.proto: accounts and programs
  GetNonceRequest: [[1, 'address', 'bytes']],
  GetNonceResponse: [[1, 'nonce', 'u64']],
  GetBalanceRequest: [[1, 'address', 'bytes']],
  GetBalanceResponse: [[1, 'amount', 'string']],
  GetProgramRequest: [[1, 'vkHash', 'bytes']],
  GetProgramResponse: [[1, 'program', 'Program', OPT]],
  Program: [[1, 'vkHash', 'bytes'], [2, 'vk', 'bytes'], [3, 'programUri', 'string'], [4, 'name', 'string', OPT], [5, 'owner', 'bytes'], [6, 'createdAt', 'u64']],
  // proto/types.proto: requesting a proof
  GetProofRequestParamsRequest: [[1, 'mode', 'enum']],
  GetProofRequestParamsResponse: [[1, 'domain', 'bytes'], [2, 'auctioneer', 'bytes'], [3, 'executor', 'bytes'], [4, 'verifier', 'bytes'],
    [5, 'maxPricePerPgu', 'string'], [6, 'baseFee', 'string'], [7, 'treasury', 'bytes'], [8, 'tickSize', 'u64'], [9, 'networkFloorPricePerPgu', 'string']],
  RequestProofRequest: [[1, 'format', 'enum'], [2, 'signature', 'bytes'], [3, 'body', 'RequestProofRequestBody', OPT]],
  RequestProofRequestBody: [[1, 'nonce', 'u64'], [2, 'vkHash', 'bytes'], [3, 'version', 'string'], [4, 'mode', 'enum'], [5, 'strategy', 'enum'],
    [6, 'stdinUri', 'string'], [7, 'deadline', 'u64'], [8, 'cycleLimit', 'u64'], [9, 'gasLimit', 'u64'], [10, 'minAuctionPeriod', 'u64'],
    [11, 'whitelist', 'bytes', REP], [12, 'domain', 'bytes'], [13, 'auctioneer', 'bytes'], [14, 'executor', 'bytes'], [15, 'verifier', 'bytes'],
    [16, 'publicValuesHash', 'bytes', OPT], [17, 'baseFee', 'string'], [18, 'maxPricePerPgu', 'string'], [19, 'variant', 'enum'],
    [20, 'treasury', 'bytes'], [21, 'stdinPrivate', 'bool']],
  RequestProofResponse: [[1, 'txHash', 'bytes'], [2, 'body', 'RequestProofResponseBody', OPT]],
  RequestProofResponseBody: [[1, 'requestId', 'bytes']],
  // proto/types.proto: following a request
  GetProofRequestStatusRequest: [[1, 'requestId', 'bytes']],
  GetProofRequestStatusResponse: [[1, 'fulfillmentStatus', 'enum'], [2, 'executionStatus', 'enum'], [3, 'requestTxHash', 'bytes'], [4, 'deadline', 'u64'],
    [5, 'fulfillTxHash', 'bytes', OPT], [6, 'proofUri', 'string', OPT], [7, 'publicValuesHash', 'bytes', OPT], [8, 'proofPublicUri', 'string', OPT]],
  GetProofRequestDetailsRequest: [[1, 'requestId', 'bytes']],
  GetProofRequestDetailsResponse: [[1, 'request', 'ProofRequest', OPT]],
  // An account's newest requests: how a request whose answer was lost on the way back is found again.
  GetFilteredProofRequestsRequest: [[6, 'requester', 'bytes', OPT], [10, 'limit', 'u32', OPT]],
  GetFilteredProofRequestsResponse: [[1, 'requests', 'ProofRequest', REP]],
  // The fields of ProofRequest this client reads (others are skipped on decode).
  ProofRequest: [[1, 'requestId', 'bytes'], [2, 'vkHash', 'bytes'], [3, 'version', 'string'], [4, 'mode', 'enum'], [5, 'strategy', 'enum'],
    [7, 'stdinUri', 'string', OPT], [8, 'deadline', 'u64'], [9, 'cycleLimit', 'u64'], [11, 'fulfillmentStatus', 'enum'], [12, 'executionStatus', 'enum'], [13, 'requester', 'bytes'],
    [14, 'fulfiller', 'bytes', OPT], [17, 'fulfillerName', 'string', OPT], [18, 'createdAt', 'u64'], [19, 'updatedAt', 'u64'], [20, 'fulfilledAt', 'u64', OPT],
    [21, 'txHash', 'bytes'], [22, 'cycles', 'u64', OPT], [26, 'gasLimit', 'u64'], [27, 'gasUsed', 'u64', OPT], [28, 'executeFailCause', 'enum'],
    [29, 'settlementStatus', 'enum'], [33, 'whitelist', 'bytes', REP], [34, 'baseFee', 'string', OPT], [35, 'maxPricePerPgu', 'string', OPT],
    [36, 'error', 'enum'], [37, 'isCanceled', 'bool'], [38, 'stdinPrivate', 'bool']],
});

function varint(n) {
  let v = BigInt(n);
  if (v < 0n) v &= (1n << 64n) - 1n;                              // negative enums: two's complement, 10 bytes
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Uint8Array.from(out);
}
const isScalar = (kind) => ['u64', 'u32', 'enum', 'bool', 'bytes', 'string'].includes(kind);
const isDefault = (kind, v) => (kind === 'bytes' ? v.length === 0 : kind === 'string' ? v === '' : kind === 'bool' ? v === false : BigInt(v) === 0n);

export function encodeMessage(name, obj = {}) {
  const fields = MESSAGES[name];
  if (!fields) throw new Error(`succinct-net: unknown message ${name}`);
  const parts = [];
  const one = (tag, kind, v) => {
    if (kind === 'bytes' || kind === 'string' || !isScalar(kind)) {
      const b = kind === 'bytes' ? asBytes(v) : kind === 'string' ? te.encode(String(v)) : encodeMessage(kind, v);
      parts.push(varint((tag << 3) | 2), varint(b.length), b);
    } else {
      parts.push(varint(tag << 3), varint(kind === 'bool' ? (v ? 1 : 0) : v));
    }
  };
  for (const [tag, key, kind, flags = 0] of [...fields].sort((a, b) => a[0] - b[0])) {
    const v = obj[key];
    if (v == null) continue;
    if (flags & REP) { for (const x of v) one(tag, kind, x); continue; }
    if (!(flags & OPT) && isScalar(kind) && isDefault(kind, kind === 'bytes' ? asBytes(v) : v)) continue;
    one(tag, kind, v);
  }
  return concat(...parts);
}

export function decodeMessage(name, buf) {
  const fields = MESSAGES[name];
  if (!fields) throw new Error(`succinct-net: unknown message ${name}`);
  const byTag = new Map(fields.map((f) => [f[0], f]));
  const out = {};
  for (const [, key, kind, flags = 0] of fields) {
    if (flags & REP) out[key] = [];
    else if (flags & OPT || !isScalar(kind)) out[key] = undefined;
    else out[key] = kind === 'u64' ? 0n : kind === 'bool' ? false : kind === 'bytes' ? new Uint8Array(0) : kind === 'string' ? '' : 0;
  }
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let i = 0;
  const rv = () => {
    let r = 0n, s = 0n;
    for (;;) {
      if (i >= b.length) throw new Error(`succinct-net: truncated ${name}`);
      const x = b[i++];
      r |= BigInt(x & 0x7f) << s; s += 7n;
      if (x < 0x80) return r;
      if (s > 63n) throw new Error(`succinct-net: bad varint in ${name}`);
    }
  };
  while (i < b.length) {
    const key = Number(rv()), tag = key >>> 3, wire = key & 7;
    let raw;
    if (wire === 0) raw = rv();
    else if (wire === 2) { const n = Number(rv()); if (i + n > b.length) throw new Error(`succinct-net: truncated ${name}`); raw = b.subarray(i, i + n); i += n; }
    else if (wire === 1) { i += 8; continue; }
    else if (wire === 5) { i += 4; continue; }
    else throw new Error(`succinct-net: unsupported wire type ${wire} in ${name}`);
    const f = byTag.get(tag);
    if (!f) continue;
    const [, k, kind, flags = 0] = f;
    if ((wire === 0) !== ['u64', 'enum', 'u32', 'bool'].includes(kind)) throw new Error(`succinct-net: wire type ${wire} for ${name}.${k}`);
    let v;
    if (kind === 'u64') v = BigInt.asUintN(64, raw);
    else if (kind === 'enum' || kind === 'u32') v = Number(BigInt.asIntN(32, raw));
    else if (kind === 'bool') v = raw !== 0n;
    else if (kind === 'bytes') v = Uint8Array.from(raw);
    else if (kind === 'string') v = td.decode(raw);
    else v = decodeMessage(kind, raw);
    if (flags & REP) out[k].push(v); else out[k] = v;
  }
  return out;
}

// ── gRPC-web framing ── each message is [flag 0x00][u32 BE length][bytes]; the trailers ride in a final frame flagged 0x80
// as "name:value\r\n" lines. A server that fails before any message may put grpc-status in the HTTP headers instead.
export function grpcFrame(msg) {
  const out = new Uint8Array(5 + msg.length);
  new DataView(out.buffer).setUint32(1, msg.length);
  out.set(msg, 5);
  return out;
}
export function grpcUnframe(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const messages = [], trailers = {};
  let i = 0;
  while (i + 5 <= b.length) {
    const flag = b[i], n = new DataView(b.buffer, b.byteOffset + i + 1, 4).getUint32(0);
    if (i + 5 + n > b.length) throw new Error('succinct-net: truncated gRPC-web frame');
    const body = b.subarray(i + 5, i + 5 + n);
    i += 5 + n;
    if (flag & 0x80) {
      for (const line of td.decode(body).split('\r\n')) {
        const c = line.indexOf(':');
        if (c > 0) trailers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
    } else if (flag & 0x01) {
      throw new Error('succinct-net: compressed gRPC-web frame');
    } else messages.push(body);
  }
  return { messages, trailers };
}

// ── EIP-191 ── keccak256("\x19Ethereum Signed Message:\n" + len + message), signed r‖s‖v.
export function personalHash(keccak256, msg) {
  const m = typeof msg === 'string' ? te.encode(msg) : msg;
  return keccak256(concat(te.encode(`\x19Ethereum Signed Message:\n${m.length}`), m));
}
const word32 = (n) => fromHex(BigInt(n).toString(16).padStart(64, '0'));
// `vBase` 27 is the usual v (27 + recovery id): what sp1-sdk sends for a signed request body (alloy's Signature::as_bytes).
// sp1-sdk signs "create_artifact" through utils::sign_message, which adds 27 to that byte once more (v = 54 + recovery id),
// and the network accepts it; CreateArtifact here sends the same bytes.
export function signPersonal({ secp, keccak256 }, priv, msg, vBase = 27) {
  const sig = secp.sign(personalHash(keccak256, msg), asBytes(priv, 32));
  return concat(word32(sig.r), word32(sig.s), Uint8Array.of(vBase + Number(sig.recovery)));
}
export function addressOf({ secp, keccak256 }, priv) {
  const pub = secp.getPublicKey(asBytes(priv, 32), false);
  return toHex(keccak256(pub.subarray(1)).subarray(12));
}

// ── the proof artifact ── bincode (1.x, fixed-width little-endian, u64 lengths) of sp1-verifier's ProofFromNetwork, as
// the prover uploads it and sp1-sdk's download_artifact reads it (raw, not compressed):
//   proof: SP1Proof          u32 variant (0 core, 1 compressed, 2 plonk, 3 groth16), then for plonk/groth16:
//                              public_inputs [String; 5], encoded_proof String (hex), raw_proof String (hex),
//                              vkey_hash [u8; 32]
//   public_values: Buffer    Vec<u8> (its read pointer is not serialized)
//   sp1_version: String
// Strings and vectors are a u64 length then the bytes. settle() takes SP1ProofWithPublicValues::bytes(): the first four
// bytes of the groth16 (or plonk) vkey hash, then the decoded encoded_proof.
export function decodeProofArtifact(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) throw new Error('succinct-net: the proof artifact is zstd-compressed; expected raw bincode');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const need = (n) => { if (n > b.length - i) throw new Error('succinct-net: truncated proof artifact'); };
  const u32 = () => { need(4); const v = dv.getUint32(i, true); i += 4; return v; };
  const len = () => { need(8); const v = dv.getBigUint64(i, true); i += 8; if (v > BigInt(b.length - i)) throw new Error('succinct-net: truncated proof artifact'); return Number(v); };
  const vec = () => { const n = len(); const v = b.subarray(i, i + n); i += n; return v; };
  const str = () => td.decode(vec());
  const variant = u32();
  if (variant !== 2 && variant !== 3) throw new Error(`succinct-net: the artifact holds a ${['core', 'compressed'][variant] || 'unknown'} proof; only groth16 and plonk settle on chain`);
  const publicInputs = [str(), str(), str(), str(), str()];
  const encodedProof = str(), rawProof = str();
  need(32);
  const vkeyHash = b.slice(i, i + 32); i += 32;
  const publicValues = vec(), sp1Version = str();
  if (!encodedProof) throw new Error('succinct-net: the artifact holds a mock proof');
  if (!/^[0-9a-fA-F]+$/.test(encodedProof) || encodedProof.length % 2 || !/^[0-9a-fA-F]*$/.test(rawProof)) throw new Error('succinct-net: malformed proof encoding');
  return {
    mode: variant === 3 ? 'groth16' : 'plonk',
    publicValues: toHex(publicValues),
    proof: toHex(vkeyHash.subarray(0, 4)) + encodedProof.toLowerCase(),
    publicInputs, vkeyHash: toHex(vkeyHash), sp1Version,
  };
}

// The network's own timeout rule (sp1-sdk utils::calculate_timeout_from_gas_limit): 5 minutes, or 1 s per 2M prover
// gas, at most 4 hours.
export const timeoutForGas = (gasLimit) => Math.min(Math.max(300, Math.floor(Number(gasLimit) / 2_000_000)), 14_400);

function checkPrivateStdinUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('succinct-net: the network returned a malformed upload URL'); }
  if (u.protocol !== 'https:' || u.hostname !== ARTIFACT_S3_HOST || u.port || u.username || u.password || !PRIVATE_STDIN_PATH.test(u.pathname)) {
    throw new Error('succinct-net: the network did not return a private-stdins upload URL; nothing was sent');
  }
  return u.toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARTIFACT_TIMEOUT_MS = 60_000;                               // an input upload or a proof download, through the proxy or not
const posInt = (v, what) => {
  const n = BigInt(v);
  if (n <= 0n || n >= 1n << 64n) throw new Error(`succinct-net: ${what} must be a positive 64-bit integer`);
  return n;
};
const nameOf = (list, code) => `${list[code] || 'UNKNOWN'} (${code})`;

export function makeSuccinctNetwork({ transport, fetchImpl, rpc = SPN.rpc, proxyBase, secp, keccak256 } = {}) {
  const f = fetchImpl || ((...a) => globalThis.fetch(...a));
  const t = transport || f;
  const root = String(rpc).replace(/\/+$/, '');
  const proxy = proxyBase ? String(proxyBase).replace(/\/+$/, '') : null;
  const need = () => { if (!secp || !keccak256) throw new Error('succinct-net: secp and keccak256 are needed to sign'); };

  // One unary call, given `timeoutMs` to answer. Reads retry on transport failures and on UNAVAILABLE / RESOURCE_EXHAUSTED /
  // DEADLINE_EXCEEDED; RequestProof does not (a lost answer could otherwise become a second, separately charged request).
  async function call(service, method, reqName, resName, obj, { retries = 2, timeoutMs = 20_000 } = {}) {
    const body = grpcFrame(encodeMessage(reqName, obj));
    for (let attempt = 0; ; attempt++) {
      let err;
      try {
        const res = await t(`${root}/${service}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const buf = new Uint8Array(await res.arrayBuffer());
        const headStatus = res.headers.get('grpc-status');
        const { messages, trailers } = res.ok ? grpcUnframe(buf) : { messages: [], trailers: {} };
        const status = Number(headStatus ?? trailers['grpc-status'] ?? (res.ok ? 0 : 2));
        if (!res.ok || status !== 0) {
          let msg = res.headers.get('grpc-message') ?? trailers['grpc-message'] ?? '';
          try { msg = decodeURIComponent(msg); } catch { /* keep as sent */ }
          err = new Error(`succinct ${method}: ${res.ok ? GRPC_CODES[status] || status : 'HTTP ' + res.status}${msg ? ' - ' + msg : ''}`);
          err.code = 'rpc'; err.method = method; err.grpcStatus = res.ok ? status : null; err.grpcMessage = msg; err.httpStatus = res.status;
          err.retryable = res.ok ? [4, 8, 14].includes(status) : res.status === 429 || res.status >= 500;
        } else {
          return decodeMessage(resName, messages[0] || new Uint8Array(0));
        }
      } catch (e) {
        if (e && e.code === 'rpc') throw e;
        err = Object.assign(new Error(`succinct ${method}: ${e && e.message || e}`), { code: 'rpc', method, retryable: true, cause: e });
      }
      if (!err.retryable || attempt >= retries) throw err;
      await sleep(500 * 3 ** attempt);
    }
  }
  const network = (method, req, res, obj, o) => call('network.ProverNetwork', method, req, res, obj, o);

  // The presigned PUT is idempotent, so a failed upload is tried again (three tries in all).
  async function putArtifact(url, bytes) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(700 * 2 ** (attempt - 1));
      let res;
      try {
        res = proxy
          ? await f(`${proxy}/prover/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-artifact-url': url }, body: bytes, signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS) })
          : await f(url, { method: 'PUT', body: bytes, signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS) });
      } catch (e) {
        lastErr = Object.assign(new Error(`succinct-net: the input upload failed: ${e && e.message || e}`), { code: 'upload', cause: e });
        continue;
      }
      const out = proxy ? await res.json().catch(() => null) : { ok: res.ok, status: res.status };
      if (res.ok && out && out.ok === true) return;
      lastErr = Object.assign(new Error(`succinct-net: the input upload failed (HTTP ${(out && out.status) || res.status})`), { code: 'upload', httpStatus: res.status });
      if (res.status < 500 && res.status !== 429) break;
    }
    throw lastErr;
  }
  // `retryable` marks a failure worth trying again (no answer, a busy or failing server); `retryAfterMs` is how long a
  // rate-limited answer asked to be left.
  async function getArtifact(url) {
    let res;
    try {
      res = proxy
        ? await f(`${proxy}/prover/download`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS) })
        : await f(url, { signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS) });
    } catch (e) {
      throw Object.assign(new Error(`succinct-net: the proof download failed: ${e && e.message || e}`), { code: 'download', retryable: true, cause: e });
    }
    if (!res.ok) {
      const wait = Number(res.headers.get('retry-after'));
      throw Object.assign(new Error(`succinct-net: the proof download failed (HTTP ${res.status})`), {
        code: 'download', httpStatus: res.status, retryable: res.status === 429 || res.status >= 500, retryAfterMs: Number.isFinite(wait) && wait > 0 ? Math.min(wait, 60) * 1000 : 0,
      });
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  let paramsCache = null;
  async function params({ fresh = false } = {}) {
    if (!fresh && paramsCache && Date.now() - paramsCache.at < 60_000) return paramsCache.p;
    const p = await network('GetProofRequestParams', 'GetProofRequestParamsRequest', 'GetProofRequestParamsResponse', { mode: SPN.mode });
    if (!/^\d+$/.test(p.baseFee) || !/^\d+$/.test(p.maxPricePerPgu) || p.domain.length !== 32 || p.auctioneer.length !== 20
      || p.executor.length !== 20 || p.verifier.length !== 20 || p.treasury.length !== 20) {
      throw Object.assign(new Error('succinct-net: unexpected proof request parameters from the network'), { code: 'rpc' });
    }
    paramsCache = { at: Date.now(), p };
    return p;
  }

  // Network credit of `address`, in PROVE wei.
  async function balance(address) {
    const r = await network('GetBalance', 'GetBalanceRequest', 'GetBalanceResponse', { address: asBytes(address, 20) });
    return BigInt(r.amount || '0');
  }

  // The credit a request needs on hand: its gas limit at the network's price cap, plus the base fee.
  async function needWei({ gasLimit }) {
    const p = await params();
    return posInt(gasLimit, 'gasLimit') * BigInt(p.maxPricePerPgu) + BigInt(p.baseFee);
  }

  async function program(vkHash = SPN.vkHash) {
    try {
      const r = await network('GetProgram', 'GetProgramRequest', 'GetProgramResponse', { vkHash: asBytes(vkHash, 32) });
      const p = r.program;
      return p ? { vkHash: toHex(p.vkHash), owner: toHex(p.owner), programUri: p.programUri, name: p.name ?? null, createdAt: Number(p.createdAt) } : null;
    } catch (e) {
      if (e.grpcStatus === 5) return null;
      throw e;
    }
  }

  // Ask for a groth16 proof of the guest over a private input. `priv` is the requesting account's key (hex or bytes); it
  // signs here and is not kept. `stdinZstd` is zstd(bincode(SP1Stdin)). Only provers on `whitelist` may take it.
  async function requestProof({ priv, stdinZstd, cycleLimit, gasLimit, whitelist = SPN.provers, timeoutSecs } = {}) {
    need();
    const key = asBytes(priv, 32);
    const input = stdinZstd instanceof Uint8Array ? stdinZstd : null;
    if (!input || input.length < 4 || input[0] !== 0x28 || input[1] !== 0xb5 || input[2] !== 0x2f || input[3] !== 0xfd) {
      throw new Error('succinct-net: stdinZstd must be a zstd frame');
    }
    const cycles = posInt(cycleLimit, 'cycleLimit'), gas = posInt(gasLimit, 'gasLimit');
    const provers = Array.isArray(whitelist) ? whitelist.map((a) => asBytes(a, 20)) : [];
    // An empty list opens the auction to every prover, and those that win a private request without reading it let it
    // expire at the requester's cost: refuse it rather than send one.
    if (!provers.length) throw new Error('succinct-net: a private request needs a prover whitelist');
    const address = addressOf({ secp, keccak256 }, key);

    const art = await call('artifact.ArtifactStore', 'CreateArtifact', 'CreateArtifactRequest', 'CreateArtifactResponse', {
      signature: signPersonal({ secp, keccak256 }, key, 'create_artifact', 54),
      artifactType: ARTIFACT_TYPE.PRIVATE_STDIN,
    });
    // The request names the artifact by its s3:// URI; the upload goes to the presigned URL. Both must be the same
    // private-stdins/ object, or the input is not sent at all.
    const putUrl = checkPrivateStdinUrl(art.artifactPresignedUrl);
    const named = /^s3:\/\/spn-artifacts-mainnet(\/private-stdins\/[A-Za-z0-9_-]{1,200})$/.exec(art.artifactUri);
    if (!named || named[1] !== new URL(putUrl).pathname) throw new Error('succinct-net: the network did not name a private-stdins artifact; nothing was sent');
    await putArtifact(putUrl, input);

    const [p, n] = await Promise.all([
      params({ fresh: true }),
      network('GetNonce', 'GetNonceRequest', 'GetNonceResponse', { address: fromHex(address, 20) }),
    ]);
    const deadline = Math.floor(Date.now() / 1000) + (timeoutSecs != null ? Number(timeoutSecs) : timeoutForGas(gas));
    const body = {
      nonce: n.nonce,
      vkHash: fromHex(SPN.vkHash, 32),
      version: SPN.version,
      mode: SPN.mode,
      strategy: SPN.strategy,
      stdinUri: art.artifactUri,
      deadline: BigInt(deadline),
      cycleLimit: cycles,
      gasLimit: gas,
      minAuctionPeriod: 0n,
      whitelist: provers,
      domain: p.domain,
      auctioneer: p.auctioneer,
      executor: p.executor,
      verifier: p.verifier,
      baseFee: p.baseFee,
      maxPricePerPgu: p.maxPricePerPgu,
      variant: 0,                                                  // TransactionVariant.REQUEST_VARIANT
      treasury: p.treasury,
      stdinPrivate: true,
    };
    const signature = signPersonal({ secp, keccak256 }, key, encodeMessage('RequestProofRequestBody', body));
    let r;
    try {
      r = await network('RequestProof', 'RequestProofRequest', 'RequestProofResponse', { format: 1, signature, body }, { retries: 0, timeoutMs: 45_000 });
    } catch (e) {
      // A refusal the network answered is final. A lost answer (the connection dropped, a gateway failed, the wait ran out)
      // may hide a request the network took and will charge for, so it is looked for by its input before it counts as not sent.
      if (e.grpcStatus != null && !e.retryable) throw e;
      const found = await findByInput(address, art.artifactUri);
      if (found) return { requestId: found, txHash: null, deadline, address };
      throw e;
    }
    if (!r.body || r.body.requestId.length !== 32) throw Object.assign(new Error('succinct-net: the network returned no request id'), { code: 'rpc' });
    return { requestId: toHex(r.body.requestId), txHash: toHex(r.txHash), deadline, address };
  }

  // The request this account made over `stdinUri` (each input is a fresh artifact, named by one request at most), read from
  // its newest requests a few times over some seconds while the network catches up. Null when none names it.
  async function findByInput(address, stdinUri) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(attempt ? 3000 : 1500);
      try {
        const r = await network('GetFilteredProofRequests', 'GetFilteredProofRequestsRequest', 'GetFilteredProofRequestsResponse', { requester: fromHex(address, 20), limit: 10 });
        const hit = r.requests.find((q) => q.stdinUri === stdinUri && q.requestId.length === 32);
        if (hit) return toHex(hit.requestId);
      } catch { /* asked again below */ }
    }
    return null;
  }

  async function status(requestId) {
    return network('GetProofRequestStatus', 'GetProofRequestStatusRequest', 'GetProofRequestStatusResponse', { requestId: asBytes(requestId, 32) });
  }
  async function details(requestId) {
    const r = await network('GetProofRequestDetails', 'GetProofRequestDetailsRequest', 'GetProofRequestDetailsResponse', { requestId: asBytes(requestId, 32) });
    return r.request || null;
  }

  // Follow a request to its proof. Throws code 'not_proved' when the network will not deliver it (unfulfillable,
  // unexecutable, reverted, expired, or past its deadline), and 'wait_timeout' when `timeoutMs` passes first (the request
  // may still be fulfilled; waitProof can be called again). The request is paid for once made, so a dropped connection or a
  // busy network is waited out until `timeoutMs` rather than ending the wait. Every error carries `requestId`.
  async function waitProof(requestId, { onUpdate, timeoutMs = 10 * 60e3, intervalMs = 3000, programVKey = SPN.programVKey } = {}) {
    const id = asBytes(requestId, 32);
    const t0 = Date.now();
    const within = () => Date.now() - t0 < timeoutMs;
    let last = null, prover = null, proverName = null;
    const notProved = (reason, st, d) => Object.assign(new Error(`succinct-net: the network did not prove ${toHex(id)}: ${reason}`), {
      code: 'not_proved', reason, requestId: toHex(id),
      network: { fulfillmentStatus: st.fulfillmentStatus, executionStatus: st.executionStatus, deadline: Number(st.deadline),
        executeFailCause: d ? d.executeFailCause : null, error: d ? d.error : null, prover },
    });
    for (;;) {
      let st;
      try { st = await status(id); } catch (e) {
        // A request the network has only just taken can read NOT_FOUND for a moment.
        if (((e.grpcStatus === 5 && Date.now() - t0 < 30_000) || e.retryable) && within()) { await sleep(intervalMs); continue; }
        throw Object.assign(e, { requestId: toHex(id) });
      }
      const fs = st.fulfillmentStatus, xs = st.executionStatus;
      const failed = fs >= 4 || xs === 3;
      const phase = fs === 3 ? 'proved' : failed ? 'failed' : fs === 2 ? 'assigned' : 'requested';
      let d = null;
      if (`${fs}:${xs}` !== last) {
        last = `${fs}:${xs}`;
        if (fs >= 2 || failed) {
          d = await details(id).catch(() => null);
          if (d && d.fulfiller && d.fulfiller.length === 20) { prover = toHex(d.fulfiller); proverName = d.fulfillerName ?? null; }
        }
        if (onUpdate) {
          try { onUpdate({ status: phase, fulfillmentStatus: FULFILLMENT_STATUS[fs] || String(fs), executionStatus: EXECUTION_STATUS[xs] || String(xs), prover, proverName }); }
          catch { /* the caller's display only */ }
        }
      }
      if (fs === 3) {
        // The proof URI is presigned for an hour; a failed download asks for the status (and a fresh URI) again, backing off
        // (as long as a rate limit asks) until the wait runs out. A refusal that will not change ends it at once.
        let bytes = null, lastErr = null;
        for (let attempt = 0; !bytes; attempt++) {
          if (attempt) {
            if (!within() || (lastErr && lastErr.retryable === false)) break;
            await sleep(Math.max(lastErr && lastErr.retryAfterMs || 0, Math.min(1000 * 2 ** (attempt - 1), 15_000)));
          }
          let s = st;
          if (attempt) { try { s = await status(id); } catch (e) { lastErr = e; continue; } }
          const url = s.proofUri || s.proofPublicUri;
          if (!url) { lastErr = Object.assign(new Error('succinct-net: fulfilled without a proof URI'), { code: 'download', retryable: true }); continue; }
          try { bytes = await getArtifact(url); } catch (e) { lastErr = e; }
        }
        if (!bytes) throw Object.assign(lastErr, { requestId: toHex(id) });
        const out = decodeProofArtifact(bytes);
        if (out.mode !== 'groth16') throw Object.assign(new Error(`succinct-net: expected a groth16 proof, got ${out.mode}`), { code: 'proof_mismatch', requestId: toHex(id) });
        if (programVKey && BigInt(out.publicInputs[0]) !== BigInt(programVKey)) {
          throw Object.assign(new Error('succinct-net: the proof is for another program'), { code: 'proof_mismatch', requestId: toHex(id) });
        }
        return { requestId: toHex(id), publicValues: out.publicValues, proof: out.proof, prover, proverName, fulfillTxHash: st.fulfillTxHash ? toHex(st.fulfillTxHash) : null };
      }
      if (failed) {
        d = d || await details(id).catch(() => null);
        const what = xs === 3 ? 'unexecutable' : (FULFILLMENT_STATUS[fs] || 'failed').toLowerCase();
        const codes = [`fulfillment ${nameOf(FULFILLMENT_STATUS, fs)}`, `execution ${nameOf(EXECUTION_STATUS, xs)}`];
        if (d && d.executeFailCause) codes.push(`cause ${nameOf(EXECUTE_FAILURE_CAUSE, d.executeFailCause)}`);
        if (d && d.error) codes.push(`error ${nameOf(PROOF_REQUEST_ERROR, d.error)}`);
        throw notProved(`${what}: ${codes.join(', ')}`, st, d);
      }
      const now = Math.floor(Date.now() / 1000);
      if (st.deadline && now > Number(st.deadline)) {
        d = await details(id).catch(() => null);
        throw notProved(`past its deadline while ${(FULFILLMENT_STATUS[fs] || 'unknown').toLowerCase()}: fulfillment ${nameOf(FULFILLMENT_STATUS, fs)}, execution ${nameOf(EXECUTION_STATUS, xs)}`, st, d);
      }
      if (Date.now() - t0 > timeoutMs) {
        throw Object.assign(new Error(`succinct-net: stopped waiting for ${toHex(id)} (${FULFILLMENT_STATUS[fs] || fs})`), { code: 'wait_timeout', requestId: toHex(id) });
      }
      await sleep(intervalMs);
    }
  }

  return { balance, needWei, params, program, requestProof, status, details, waitProof, findByInput };
}
