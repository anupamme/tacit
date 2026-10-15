#!/usr/bin/env bash
# Convert every confidential host harness from box-only local proving (.cpu() + hardcoded /root/work ELF path)
# to the Succinct hosted-network prover (.network()) + the committed portable ELF. Host-only change — the
# guest ELF (elf/cxfer-guest, vkey 0x003a21ba) is unchanged, so the deployed pool needs NO redeploy.
# Idempotent. Run from contracts/sp1/confidential/. Only touches harnesses/exec-*.rs.
set -euo pipefail
cd "$(dirname "$0")"

for f in harnesses/exec-*.rs; do
  [ -f "$f" ] || continue
  python3 - "$f" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
orig = s
# 1) portable ELF path (committed elf/cxfer-guest via CARGO_MANIFEST_DIR) — drop the /root/work box path
import re
s = re.sub(
    r'include_bytes!\(\s*"/root/work/cxfer/guest/[^"]*cxfer-guest"\s*\)',
    'include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/cxfer-guest"))',
    s)
# 2) hosted (Reserved-capacity) Succinct network prover instead of forced-local CPU. .hosted() sets
#    NetworkMode::Reserved to match the rpc.production.succinct.xyz endpoint (default would be Mainnet/auction).
s = s.replace('ProverClient::builder().cpu().build()', 'ProverClient::builder().network().build()')
# 3) feed the REAL memo hashes (OP_FILE memoHashes) instead of 64 placeholder empty hashes, so the guest
#    commits to the real memos and settle() matches them (else the contract reverts MemoLeafMismatch).
s = s.replace(
    'for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }',
    '{ let empty = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"; let mh: Vec<String> = f.get("memoHashes").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default(); for i in 0..64usize { stdin.write(&hexv(mh.get(i).map(|s| s.as_str()).unwrap_or(empty))); } }')
# 4) declare the request limits so the SDK submits directly instead of running its local pre-flight. That
#    pre-flight re-executes the guest in-process with gas accounting, and sp1-sdk maps ANY failure there to a
#    contentless `Program simulation failed` (network/prover.rs `map_err(|_| Error::SimulationFailed)`) — which
#    is what the heaviest op (transfer, ~8.4M cycles) hits on the relay host while lighter ops pass. Supplying
#    both limits takes the early return in `get_limits`, skipping that execution entirely.
s = re.sub(
    r'(\.groth16\(\)|\.compressed\(\))(\s*)\.run\(\)',
    r'\1\2.cycle_limit(256_000_000)\2.gas_limit(1_000_000_000)\2.run()',
    s)
# 5) the witness can be kept private. A network request's stdin is otherwise uploaded as a public artifact that anyone can
#    list by requester and download, and an op's stdin names the leaf it spends, its amounts and its owners.
#    private_stdin stores it where only the network's executor and the winning prover can read it, but a prover has to
#    ask for it with a signed call, and on 2026-10-15 the provers the auction assigned never delivered on such requests
#    (public ones were fulfilled in under a minute). So it is a switch, PRIVATE_STDIN=1, off unless set.
s = re.sub(
    r'(\.gas_limit\([^)]*\))(\s*)\.run\(\)',
    r'\1\2.private_stdin(std::env::var("PRIVATE_STDIN").as_deref() == Ok("1"))\2.run()',
    s)
# 6) PROVER_WHITELIST (comma-separated prover addresses) limits who may take a request. Private stdin is only fetched by
#    provers that make the signed GetStdinUri call: on 2026-10-15 Succinct's own prover (0xd4fcfce0…a4f5) proved a
#    private request in 35 s while the provers that win the open auction took them and never delivered.
s = re.sub(
    r'(\.private_stdin\(std::env::var\("PRIVATE_STDIN"\)\.as_deref\(\) == Ok\("1"\)\))(\s*)\.run\(\)',
    r'\1\2.whitelist(std::env::var("PROVER_WHITELIST").ok().filter(|s| !s.trim().is_empty()).map(|s| s.split(\',\').map(|a| a.trim().parse().expect("PROVER_WHITELIST holds 0x addresses")).collect()))\2.run()',
    s)
if s != orig:
    open(p, 'w').write(s)
    print("patched", p)
else:
    print("unchanged", p)
PY
done
echo "done — features must be network in harnesses/Cargo.toml (network, not native-gnark)"
