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

use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
use base64::Engine;
use k256::{ecdh::diffie_hellman, elliptic_curve::sec1::ToEncodedPoint, PublicKey, SecretKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
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
    stdin: Option<String>,
    sealed: Option<Sealed>,
    #[serde(rename = "cycleLimit")]
    cycle_limit: Option<f64>,
    deadline: Option<f64>,
    label: Option<String>,
}

// An input the page encrypted to this worker alone (dapp/sealed-input.js): `epk` the page's one-time secp256k1 public key
// (33 bytes, hex), `iv` 12 bytes and `ct` the AES-256-GCM ciphertext with its tag (base64). The key is
// SHA-256("tacit-sealed-input-v1" ‖ ECDH x-coordinate ‖ this worker's public key ‖ epk); the plaintext is the bincode
// SP1Stdin. Nothing but this worker's key opens it: the API and the relay only ever hold the ciphertext.
#[derive(Deserialize)]
struct Sealed {
    epk: String,
    iv: String,
    ct: String,
}
const SEALED_DOMAIN: &[u8] = b"tacit-sealed-input-v1";

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

// This worker's long-lived key, kept at WORKER_KEY_FILE (default /workspace/worker.key, 32 bytes hex) and made on first use.
fn worker_key() -> SecretKey {
    let path = env_or("WORKER_KEY_FILE", "/workspace/worker.key");
    if let Ok(h) = std::fs::read_to_string(&path) {
        let b = hex::decode(h.trim().trim_start_matches("0x")).expect("WORKER_KEY_FILE holds hex");
        return SecretKey::from_slice(&b).expect("WORKER_KEY_FILE holds a secp256k1 key");
    }
    let sk = SecretKey::random(&mut rand::thread_rng());
    std::fs::write(&path, hex::encode(sk.to_bytes())).expect("write WORKER_KEY_FILE");
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)); }
    sk
}

fn unseal(sk: &SecretKey, my_pub: &[u8], s: &Sealed) -> Result<Vec<u8>, String> {
    let epk_bytes = hex::decode(s.epk.trim_start_matches("0x")).map_err(|e| format!("sealed.epk is not hex: {e}"))?;
    let epk = PublicKey::from_sec1_bytes(&epk_bytes).map_err(|e| format!("sealed.epk is not a secp256k1 point: {e}"))?;
    let shared = diffie_hellman(sk.to_nonzero_scalar(), epk.as_affine());
    let mut h = Sha256::new();
    h.update(SEALED_DOMAIN);
    h.update(shared.raw_secret_bytes());
    h.update(my_pub);
    h.update(&epk_bytes);
    let key = h.finalize();
    let iv = base64::engine::general_purpose::STANDARD.decode(&s.iv).map_err(|e| format!("sealed.iv is not base64: {e}"))?;
    let ct = base64::engine::general_purpose::STANDARD.decode(&s.ct).map_err(|e| format!("sealed.ct is not base64: {e}"))?;
    if iv.len() != 12 { return Err("sealed.iv must be 12 bytes".into()); }
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    cipher.decrypt(Nonce::from_slice(&iv), Payload { msg: &ct, aad: SEALED_DOMAIN }).map_err(|_| "the sealed input does not open with this worker's key".to_string())
}

fn main() {
    // UNSEAL_TEST=<file>: open a sealed input ({ epk, iv, ct } as JSON) with this worker's key, print the SHA-256 of what is
    // inside, and exit: how the page's sealing (dapp/sealed-input.js) is checked against this side without a GPU.
    if let Ok(path) = std::env::var("UNSEAL_TEST") {
        let sk = worker_key();
        let my_pub = sk.public_key().to_encoded_point(true).as_bytes().to_vec();
        let s: Sealed = serde_json::from_str(&std::fs::read_to_string(&path).expect("read UNSEAL_TEST")).expect("UNSEAL_TEST is { epk, iv, ct }");
        match unseal(&sk, &my_pub, &s) {
            Ok(pt) => { println!("UNSEAL_OK bytes={} sha256={}", pt.len(), hex::encode(Sha256::digest(&pt))); return; }
            Err(e) => { println!("UNSEAL_FAILED {e}"); std::process::exit(1); }
        }
    }
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
    let sk = worker_key();
    let my_pub = sk.public_key().to_encoded_point(true).as_bytes().to_vec();
    let my_pub_hex = format!("0x{}", hex::encode(&my_pub));
    println!("[{name}] sealed inputs may be encrypted to {my_pub_hex}");
    let mut quiet = 0u32;
    // A GPU server that died (the client then reports a lost connection) or a run of failed jobs is not something this
    // process can mend: it exits, and the loop around it starts a fresh worker and server. Three in a row, so one bad
    // input does not restart a healthy worker.
    let mut failed_in_a_row = 0u32;
    // A GPU server is not kept for ever. Measured 2026-10-17: a fresh server makes the Groth16 proof in 6-8 s; after a while it falls into
    // a regime where every proof takes 100 s (the GPU's part done on the CPU, by the look of the constant time) and stays there until it is
    // restarted, and once it hung there. So the worker exits, and the loop starts a fresh server, when two proofs in a row took longer than
    // SLOW_PROOF_SECS, and in any case after JOBS_PER_SERVER jobs.
    let jobs_per_server = env_or("JOBS_PER_SERVER", "40").parse::<u32>().unwrap_or(40);
    let slow_secs = env_or("SLOW_PROOF_SECS", "90").parse::<f64>().unwrap_or(90.0);
    let mut jobs_done = 0u32;
    let mut slow_in_a_row = 0u32;
    // A proof that never ends (a GPU kernel that hangs leaves the server alive and silent, and the client waiting on it for ever) is
    // ended from outside: a watchdog thread sees a job in hand for longer than JOB_TIMEOUT_SECS (15 minutes by default, three times a
    // long op) and exits the process, so the loop around it starts a fresh worker and GPU server and the job goes back to the board.
    let job_since = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    {
        let job_since = job_since.clone();
        let limit = env_or("JOB_TIMEOUT_SECS", "900").parse::<u64>().unwrap_or(900);
        let name = name.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(15));
            let since = job_since.load(std::sync::atomic::Ordering::Relaxed);
            if since == 0 { continue; }
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            if now.saturating_sub(since) > limit {
                println!("[{name}] a job has been in hand for {} s (limit {limit}); exiting so the loop starts a fresh worker and GPU server", now - since);
                std::process::exit(3);
            }
        });
    }
    loop {
        if reload_due() {
            let _ = std::fs::remove_file(&reload_flag);
            println!("[{name}] reload asked for; exiting between jobs");
            return;
        }
        let claimed: Result<Claim, String> = agent
            .post(&claim_url)
            .set("Authorization", &auth)
            .send_json(serde_json::json!({ "worker": name, "classes": classes, "pubkey": my_pub_hex }))
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
        job_since.store(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(1).max(1), std::sync::atomic::Ordering::Relaxed);
        // The job: its input decoded, proved as groth16 within its cycle limit → (public values, proof bytes as settle() takes them).
        let outcome: Result<(Vec<u8>, Vec<u8>), String> = (|| {
            let bytes = match (&job.sealed, &job.stdin) {
                (Some(s), _) => unseal(&sk, &my_pub, s)?,
                (None, Some(b)) => base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| format!("stdin is not base64: {e}"))?,
                (None, None) => return Err("the job carries neither stdin nor a sealed input".to_string()),
            };
            let stdin: SP1Stdin = bincode::deserialize(&bytes).map_err(|e| format!("stdin is not a bincode SP1Stdin: {e}"))?;
            if let Some(dl) = job.deadline {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
                if now > dl { return Err("the job's deadline has passed".to_string()); }
            }
            let cycles = job.cycle_limit.map(|c| c as u64).filter(|c| *c > 0).unwrap_or(512_000_000);
            let proof = client.prove(&pk, stdin).groth16().cycle_limit(cycles).run().map_err(|e| format!("groth16 proof failed: {e}"))?;
            Ok((proof.public_values.as_slice().to_vec(), proof.bytes()))
        })();
        job_since.store(0, std::sync::atomic::Ordering::Relaxed);
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
        jobs_done += 1;
        slow_in_a_row = if outcome.is_ok() && t.elapsed().as_secs_f64() > slow_secs { slow_in_a_row + 1 } else { 0 };
        if jobs_done >= jobs_per_server || slow_in_a_row >= 2 {
            println!("[{name}] {}; exiting so the loop starts a fresh worker and GPU server", if slow_in_a_row >= 2 { format!("two proofs in a row took over {slow_secs} s") } else { format!("{jobs_done} jobs on this GPU server") });
            std::process::exit(4);
        }
    }
}
