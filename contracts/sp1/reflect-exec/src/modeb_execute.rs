// Mode-B check of an Ethereum-state proof made somewhere other than the prover network. The Bitcoin reflection guest's
// verifying key is fixed on chain, so an eth-reflection proof from another prover (the board's GPU worker runs a newer SP1) is
// usable only if this guest, as built, accepts it. This runs the guest in EXECUTE mode (no proof, nothing spent) on a real
// reflection request's input with its deferred eth proof replaced by ETH_PROOF, under the SP1 the lane uses (sdk 6.2.3 over
// 6.2.4, as bitcoin_prove).
//
//   REFLECT_ELF=../confidential/elf/reflection-prover   the network's program 0x5d8ac5d0… (sha256 55b5ccff…)
//   REFLECT_STDIN=<file>  the bincode SP1Stdin of a Mode-B reflection request (the network's public stdin artifact, zstd -d):
//                         its eth_pv buffer and one deferred proof
//   ETH_PROOF=<file>      an SP1ProofWithPublicValues (compressed) of the eth-reflection guest for that same eth_pv;
//                         unset = run the request as the network proved it
//   ETH_ELF=../eth-reflection/elf/eth_reflection        the vk written beside ETH_PROOF comes from a setup of it, as in
//                         bitcoin_prove.rs; NO_SETUP=1 reuses the vk the stdin carries instead
//
// What passes means: execute runs verify_compressed on each deferred proof (the shard proof, vk_root, the compress vk in the
// recursion vk map, is_complete, the program vk digest); the binding of the proof to the guest's
// verify_sp1_proof(ETH_REFLECTION_VKEY, sha256(eth_pv)) is checked here, since execute does not: the vk's recursion digest is
// ETH_REFLECTION_VKEY, the proof's public values are the eth_pv bytes the guest reads, and the SDK's verify (the proof's
// committed-value digest against those public values). Checked 2026-10-26 on request 0x722a97ae… (stdin artifact
// 01m5srcghbf89sm8trn0q1960m) with its own network proof (passes, public values equal the network's Groth16 output) and with
// one bit of that proof flipped (fails: "deferred proof 0 failed verification").

use sp1_sdk::{
    blocking::{Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Proof, SP1ProofWithPublicValues, SP1Stdin, SP1VerifyingKey,
};
use std::time::Instant;

// reflect.rs ETH_REFLECTION_VKEY.
const ETH_REFLECTION_VKEY: [u32; 8] =
    [1698740370, 761725306, 1843717690, 1218893588, 786585592, 423901230, 1310805602, 795535986];

fn leak(path: &str) -> &'static [u8] {
    Box::leak(std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}")).into_boxed_slice())
}

fn main() {
    sp1_sdk::utils::setup_logger();
    let refl_elf = leak(&std::env::var("REFLECT_ELF").expect("REFLECT_ELF"));
    let mut stdin: SP1Stdin =
        bincode::deserialize(leak(&std::env::var("REFLECT_STDIN").expect("REFLECT_STDIN"))).expect("REFLECT_STDIN is a bincode SP1Stdin");
    println!("reflection stdin: buffers={} proofs={}", stdin.buffer.len(), stdin.proofs.len());
    assert_eq!(stdin.proofs.len(), 1, "a Mode-B reflection input carries exactly one deferred proof");
    let client = ProverClient::builder().cpu().build();
    let mut bound = true;
    if let Ok(path) = std::env::var("ETH_PROOF") {
        let eth_pk = if std::env::var("NO_SETUP").is_ok() {
            None
        } else {
            Some(client.setup(Elf::Static(leak(&std::env::var("ETH_ELF").expect("ETH_ELF")))).expect("setup eth"))
        };
        let vk = match &eth_pk {
            Some(pk) => pk.verifying_key().clone(),
            None => SP1VerifyingKey { vk: stdin.proofs[0].1.clone() },
        };
        let vk_ok = vk.hash_u32() == ETH_REFLECTION_VKEY;
        let same_vk = bincode::serialize(&vk.vk).unwrap() == bincode::serialize(&stdin.proofs[0].1).unwrap();
        println!("eth vk ({}): bytes32={} recursion digest == ETH_REFLECTION_VKEY: {vk_ok}; == the vk the stdin carried: {same_vk}",
            if eth_pk.is_some() { "6.2.4 setup" } else { "from the stdin" }, vk.bytes32());
        let eth = SP1ProofWithPublicValues::load(&path).expect("load ETH_PROOF");
        let pv = eth.public_values.as_slice().to_vec();
        let at = stdin.buffer.iter().position(|b| b.len() == pv.len() + 8 && b[8..] == pv[..]);
        println!("ETH_PROOF: sp1_version={} pv_bytes={}; its public values are the eth_pv the guest reads: {} (buffer {:?})",
            eth.sp1_version, pv.len(), at.is_some(), at);
        let verified = match client.verify(&eth, &vk, None) {
            Ok(()) => { println!("VERIFY (6.2.4) ok"); true }
            Err(e) => { println!("VERIFY (6.2.4) FAILED: {e}"); false }
        };
        bound = vk_ok && at.is_some() && verified;
        let SP1Proof::Compressed(reduce) = eth.proof else { panic!("ETH_PROOF is not a compressed proof") };
        stdin.proofs[0] = (*reduce, vk.vk.clone());
        std::mem::forget(eth_pk);
    }
    let t = Instant::now();
    match client.execute(Elf::Static(refl_elf), stdin).deferred_proof_verification(true).calculate_gas(false).run() {
        Ok((out, report)) => {
            println!("EXECUTED in {:.1} s exit_code={} pv={}", t.elapsed().as_secs_f64(), report.exit_code, hex::encode(out.as_slice()));
            if report.exit_code == 0 && bound {
                println!("MODE_B_GATE PASS");
                std::process::exit(0);
            }
            println!("MODE_B_GATE FAIL ({})", if bound { "non-zero exit" } else { "the proof is not bound to the guest's verify_sp1_proof call" });
        }
        Err(e) => println!("EXECUTE FAILED after {:.1} s: {e}\nMODE_B_GATE FAIL", t.elapsed().as_secs_f64()),
    }
    std::process::exit(1);
}
