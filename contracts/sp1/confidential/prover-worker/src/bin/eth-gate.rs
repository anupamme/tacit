// The gate for proving the Ethereum-state guest on the prover board: a COMPRESSED proof of the eth-reflection guest made with
// this crate's SP1 stack (sp1-sdk 6.2.3 over sp1-prover / sp1-cuda 6.3.1, the stack the board worker runs), from a real eth_prove
// input, saved for the Bitcoin reflection guest's check (contracts/sp1/reflect-exec `modeb-execute`), which runs that guest in
// execute mode on a real Mode-B request with this proof as its deferred proof. The Bitcoin guest's verifying key is fixed on
// chain, so the board may prove eth_prove's input only if a proof made here passes that check.
//
//   ETH_ELF=../../eth-reflection/elf/eth_reflection   the guest (sha256 5fb193b5…, the program the network has as vk 0x6540b892…)
//   ETH_STDIN=<file>     a bincode SP1Stdin as eth_prove builds it (the network's public stdin artifact of an eth-state request,
//                        zstd -d, is one)
//   OUT=<file>           where the SP1ProofWithPublicValues goes
//   GATE_BACKEND=cuda    (default) or cpu. cuda starts its own sp1-gpu-server, which sizes its pools from the card's total memory
//                        and so cannot run beside a live worker's server on one 24 GB card: run it while the worker loop is
//                        stopped, or on another card. cpu needs well over 14 GB of RAM for this guest (measured 2026-10-26).
//   SETUP_ONLY=1         derive the verifying key and stop (checks it against ETH_REFLECTION_VKEY; seconds on the GPU)
//
// The process exits without dropping the prover (the CUDA client's destructors abort outside a runtime), as eth_prove does.

use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Stdin,
};
use std::time::Instant;

// reflect.rs ETH_REFLECTION_VKEY: the recursion digest the Bitcoin guest's verify_sp1_proof checks.
const ETH_REFLECTION_VKEY: [u32; 8] =
    [1698740370, 761725306, 1843717690, 1218893588, 786585592, 423901230, 1310805602, 795535986];

fn main() {
    sp1_sdk::utils::setup_logger();
    let elf: &'static [u8] =
        Box::leak(std::fs::read(std::env::var("ETH_ELF").expect("ETH_ELF")).expect("read ETH_ELF").into_boxed_slice());
    println!("ETH_ELF sha256 {}", hex::encode(Sha256::digest(elf)));
    let stdin: SP1Stdin = bincode::deserialize(&std::fs::read(std::env::var("ETH_STDIN").expect("ETH_STDIN")).expect("read ETH_STDIN"))
        .expect("ETH_STDIN is a bincode SP1Stdin");
    let out = std::env::var("OUT").expect("OUT");
    let backend = std::env::var("GATE_BACKEND").unwrap_or_else(|_| "cuda".into());
    let t0 = Instant::now();
    macro_rules! gate {
        ($client:expr) => {{
            let client = $client;
            let pk = client.setup(Elf::Static(elf)).expect("setup");
            let vk = pk.verifying_key();
            println!("[{backend}] setup {:.1} s bytes32={} hash_u32={:?}", t0.elapsed().as_secs_f64(), vk.bytes32(), vk.hash_u32());
            assert_eq!(vk.hash_u32(), ETH_REFLECTION_VKEY, "this guest's recursion digest is not the one the Bitcoin guest verifies");
            if std::env::var("SETUP_ONLY").is_ok() {
                std::process::exit(0);
            }
            let t = Instant::now();
            let proof = client.prove(&pk, stdin).compressed().run().expect("compressed proof");
            let pv = proof.public_values.as_slice().to_vec();
            println!("[{backend}] PROVED compressed in {:.1} s sp1_version={} pv_bytes={}", t.elapsed().as_secs_f64(), proof.sp1_version, pv.len());
            println!("PV {}", hex::encode(&pv));
            proof.save(&out).expect("save");
            println!("SAVED {out} sha256 {}", hex::encode(Sha256::digest(std::fs::read(&out).expect("read back"))));
            match client.verify(&proof, vk, None) {
                Ok(()) => println!("VERIFY (this stack) ok"),
                Err(e) => println!("VERIFY (this stack) FAILED: {e}"),
            }
            std::process::exit(0);
        }};
    }
    if backend == "cpu" {
        gate!(ProverClient::builder().cpu().build())
    } else {
        gate!(ProverClient::builder().cuda().build())
    }
}
