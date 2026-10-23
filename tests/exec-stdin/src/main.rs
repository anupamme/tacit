// Runs the settle guest in SP1 execute mode (no proof) over a serialized SP1Stdin (what dapp/sp1-stdin.js stdinFor builds)
// and writes the public values it commits. STDIN=<file> OUT=<file> (hex of the public values); GUEST_ELF at build time.
// SP1_MODE=cpu uses the CPU prover's client (slow to start), anything else the mock client (same executor). VKEY=1 prints the guest's vkey.
use sp1_sdk::{blocking::{ProverClient, Prover}, SP1Stdin, Elf, ProvingKey, HashableKey};
const ELF: &[u8] = include_bytes!(env!("GUEST_ELF"));
macro_rules! go {
    ($client:expr, $stdin:expr, $t:expr) => {{
        let client = $client;
        if std::env::var("VKEY").is_ok() {
            let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
            println!("VKEY={}", pk.verifying_key().bytes32());
        }
        let (pv, report) = client.execute(Elf::Static(ELF), $stdin).run().expect("execute failed");
        println!("EXECUTE_OK cycles={} pv_bytes={} total {:?}", report.total_instruction_count(), pv.as_slice().len(), $t.elapsed());
        std::fs::write(std::env::var("OUT").expect("OUT"), hex::encode(pv.as_slice())).unwrap();
    }};
}
fn main() {
    let t = std::time::Instant::now();
    let raw = std::fs::read(std::env::var("STDIN").expect("STDIN")).expect("read stdin");
    let stdin: SP1Stdin = bincode::deserialize(&raw).expect("stdin is not a bincode SP1Stdin");
    if std::env::var("SP1_MODE").as_deref() == Ok("cpu") { go!(ProverClient::builder().cpu().build(), stdin, t) } else { go!(ProverClient::builder().mock().build(), stdin, t) }
}
