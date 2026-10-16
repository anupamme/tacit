// Tacit's prover worker. It claims jobs from the prover board, proves each on this machine's GPU with the pinned guest and
// posts the proof back; the relay checks every proof against the pool before using it, and a job nobody proves in time goes
// to the prover network, so a worker that stops only stops helping.
//
//   POST {BOARD_URL}/prover/claim   { worker, classes }      → { job: { jobId, stdin (base64 bincode SP1Stdin), cycleLimit, deadline } } | {}
//   POST {BOARD_URL}/prover/result  { jobId, publicValues, proof } | { jobId, error }
//
// Env: BOARD_URL, WORKER_TOKEN (the bearer the API knows this worker by), WORKER_NAME (for the log), CLASSES
// ("private,public"; the API gives only what the token allows), POLL_MS (default 3000), EXPECT_VKEY (the pool's PROGRAM_VKEY;
// the worker refuses to start on another), WARM=0 to skip the warm-up proof at start.
// BENCH=<dir>: no board; every `*.bin` in the directory (a bincode SP1Stdin, as tests/fixtures/sp1-stdin holds them) is
// proved BENCH_RUNS times (default 3) and the times are printed, cold first. This is how a machine is measured.
// RELOAD_FLAG (default /workspace/worker.reload): when that file exists and no job is in hand, the worker removes it and
// exits 0, so the loop around it starts a fresh worker (and GPU server) with whatever binary and env are now in place,
// never in the middle of a proof.
//
// The prover client and the proving key are built once: the cost of a proof on a warm GPU is the proof, not the start-up.

use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Stdin,
};

const ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/cxfer-guest"));

#[derive(Deserialize)]
struct Claim {
    job: Option<Job>,
}
#[derive(Deserialize)]
struct Job {
    #[serde(rename = "jobId")]
    job_id: String,
    stdin: String,
    #[serde(rename = "cycleLimit")]
    cycle_limit: Option<f64>,
    deadline: Option<f64>,
    label: Option<String>,
}

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

fn main() {
    let bench = std::env::var("BENCH").ok();
    let base = env_or("BOARD_URL", "https://api.tacit.finance").trim_end_matches('/').to_string();
    let token = if bench.is_some() { String::new() } else { std::env::var("WORKER_TOKEN").expect("WORKER_TOKEN is the bearer the API knows this worker by") };
    let name = env_or("WORKER_NAME", "worker");
    let classes: Vec<String> = env_or("CLASSES", "private,public").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let poll = Duration::from_millis(env_or("POLL_MS", "3000").parse().expect("POLL_MS"));
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();

    println!("[{name}] building the CUDA prover and the proving key (once)...");
    let t0 = Instant::now();
    let client = ProverClient::builder().cuda().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("[{name}] VKEY={vk} ({:.1} s)", t0.elapsed().as_secs_f64());
    if let Ok(expect) = std::env::var("EXPECT_VKEY") {
        assert_eq!(
            vk.trim().trim_start_matches("0x").to_lowercase(),
            expect.trim().trim_start_matches("0x").to_lowercase(),
            "EXPECT_VKEY mismatch: this guest is not the pool's program"
        );
    }
    if let Some(dir) = bench {
        let runs: usize = env_or("BENCH_RUNS", "3").parse().expect("BENCH_RUNS");
        let mut files: Vec<_> = std::fs::read_dir(&dir).expect("BENCH dir").filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().map(|x| x == "bin").unwrap_or(false)).collect();
        files.sort();
        for f in files {
            let bytes = std::fs::read(&f).expect("read");
            let stdin: SP1Stdin = match bincode::deserialize(&bytes) { Ok(s) => s, Err(e) => { println!("BENCH {} skipped: {e}", f.display()); continue; } };
            for i in 0..runs {
                let t = Instant::now();
                match client.prove(&pk, stdin.clone()).groth16().cycle_limit(512_000_000).run() {
                    Ok(p) => println!("BENCH {} run {} {:.1} s pv={} proof={}", f.file_name().unwrap().to_string_lossy(), i + 1, t.elapsed().as_secs_f64(), p.public_values.as_slice().len(), p.bytes().len()),
                    Err(e) => println!("BENCH {} run {} FAILED after {:.1} s: {e}", f.file_name().unwrap().to_string_lossy(), i + 1, t.elapsed().as_secs_f64()),
                }
            }
        }
        return;
    }
    if env_or("WARM", "1") == "1" {
        // A first proof builds the recursion and wrap provers and loads the Groth16 artifacts; done now, not on a user's job.
        // The guest is run on an input it stops on at once, so the warm-up proves nothing about the pool; stopping is
        // enough for the stages that need warming.
        let t = Instant::now();
        let mut s = SP1Stdin::new();
        for _ in 0..6 { s.write(&vec![0u8; 32]); }
        s.write(&0u32); // num_ops = 0: no ops, no memo hashes
        match client.prove(&pk, s).groth16().run() {
            Ok(_) => println!("[{name}] warm ({:.1} s)", t.elapsed().as_secs_f64()),
            Err(e) => println!("[{name}] warm-up did not prove ({e}); the first job pays the start-up"),
        }
    }

    let reload_flag = env_or("RELOAD_FLAG", "/workspace/worker.reload");
    let reload_due = || std::path::Path::new(&reload_flag).exists();
    let claim_url = format!("{base}/prover/claim");
    let result_url = format!("{base}/prover/result");
    let auth = format!("Bearer {token}");
    let mut quiet = 0u32;
    // A GPU server that died (the client then reports a lost connection) or a run of failed jobs is not something this
    // process can mend: it exits, and the loop around it starts a fresh worker and server. Three in a row, so one bad
    // input does not restart a healthy worker.
    let mut failed_in_a_row = 0u32;
    loop {
        if reload_due() {
            let _ = std::fs::remove_file(&reload_flag);
            println!("[{name}] reload asked for; exiting between jobs");
            return;
        }
        let claimed: Result<Claim, String> = agent
            .post(&claim_url)
            .set("Authorization", &auth)
            .send_json(serde_json::json!({ "worker": name, "classes": classes }))
            .map_err(|e| e.to_string())
            .and_then(|r| r.into_json::<Claim>().map_err(|e| e.to_string()));
        let job = match claimed {
            Ok(Claim { job: Some(j) }) => j,
            Ok(Claim { job: None }) => {
                quiet += 1;
                if quiet % 100 == 1 { println!("[{name}] waiting for work"); }
                std::thread::sleep(poll);
                continue;
            }
            Err(e) => {
                println!("[{name}] claim failed: {e}");
                std::thread::sleep(poll.max(Duration::from_secs(10)));
                continue;
            }
        };
        quiet = 0;
        let label = job.label.clone().unwrap_or_default();
        println!("[{name}] job {} {label}: proving", &job.job_id[..job.job_id.len().min(12)]);
        let t = Instant::now();
        // The job: its input decoded, proved as groth16 within its cycle limit → (public values, proof bytes as settle() takes them).
        let outcome: Result<(Vec<u8>, Vec<u8>), String> = (|| {
            let bytes = base64::engine::general_purpose::STANDARD.decode(&job.stdin).map_err(|e| format!("stdin is not base64: {e}"))?;
            let stdin: SP1Stdin = bincode::deserialize(&bytes).map_err(|e| format!("stdin is not a bincode SP1Stdin: {e}"))?;
            if let Some(dl) = job.deadline {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
                if now > dl { return Err("the job's deadline has passed".to_string()); }
            }
            let cycles = job.cycle_limit.map(|c| c as u64).filter(|c| *c > 0).unwrap_or(512_000_000);
            let proof = client.prove(&pk, stdin).groth16().cycle_limit(cycles).run().map_err(|e| format!("groth16 proof failed: {e}"))?;
            Ok((proof.public_values.as_slice().to_vec(), proof.bytes()))
        })();
        let body = match &outcome {
            Ok((pv, proof)) => {
                println!("[{name}] job {} {label}: proved in {:.1} s", &job.job_id[..job.job_id.len().min(12)], t.elapsed().as_secs_f64());
                serde_json::json!({ "jobId": job.job_id, "publicValues": format!("0x{}", hex::encode(pv)), "proof": format!("0x{}", hex::encode(proof)) })
            }
            Err(e) => {
                println!("[{name}] job {} {label}: failed after {:.1} s: {e}", &job.job_id[..job.job_id.len().min(12)], t.elapsed().as_secs_f64());
                serde_json::json!({ "jobId": job.job_id, "error": e.chars().take(300).collect::<String>() })
            }
        };
        let transport_dead = matches!(&outcome, Err(e) if e.contains("early eof") || e.contains("Could not connect") || e.contains("Connection reset") || e.contains("Broken pipe"));
        failed_in_a_row = if outcome.is_ok() { 0 } else { failed_in_a_row + 1 };
        // The answer is worth a few tries: the proof is made, and a lost answer would send the relay to the network for nothing.
        for attempt in 0..5 {
            match agent.post(&result_url).set("Authorization", &auth).send_json(body.clone()) {
                Ok(_) => break,
                Err(e) => {
                    println!("[{name}] result not delivered (try {}): {e}", attempt + 1);
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        }
        if transport_dead || failed_in_a_row >= 3 {
            println!("[{name}] {}; exiting so the loop starts a fresh worker and GPU server", if transport_dead { "the GPU server is gone".to_string() } else { format!("{failed_in_a_row} jobs failed in a row") });
            std::process::exit(2);
        }
    }
}
