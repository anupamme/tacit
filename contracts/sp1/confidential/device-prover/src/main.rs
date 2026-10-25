// tacit-prover: proves Tacit V1 settle ops on this machine for the dapp, so they need no outside prover. One CPU prover
// stays warm (the recursion programs and the Groth16 key are loaded once), takes a program input the page built with
// dapp/sp1-stdin.js, and returns the Groth16 proof the pool verifies. Listens on 127.0.0.1 only.
//
//   tacit-prover [serve]          GET /health, POST /prove {stdin}, GET /job?id=
//   tacit-prover prove <stdin>    one proof to <stdin>.proof.json
//   tacit-prover check            the GPU leaf hash against the CPU hasher, then exit
//
// Env: TACIT_PROVER_PORT (47815), TACIT_PROVER_ORIGINS (comma list, default tacit.finance + localhost:8080),
// TACIT_PROVER_DIR (~/.tacit-prover: finished proofs), TACIT_METAL=0 (CPU leaf hashing), and the SDK's
// SP1_WORKER_NUM_*_WORKERS (one per stage by default below 16 GB of RAM).
use sha2::{Digest, Sha256};
use sp1_sdk::{blocking::{ProveRequest, Prover, ProverClient}, Elf, HashableKey, ProvingKey, SP1Stdin};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

const ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/cxfer-guest"));
// The live pool's PROGRAM_VKEY: a guest that derives anything else is refused at start.
const POOL_VKEY: &str = "0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3";
const MAX_INPUT: usize = 1 << 20;

#[derive(Clone, Default)]
struct Job {
    status: &'static str,
    started: Option<Instant>,
    secs: f64,
    cycles: u64,
    public_values: String,
    proof: String,
    error: String,
}

struct State {
    jobs: HashMap<String, Job>,
    queue: VecDeque<(String, SP1Stdin)>,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("serve");
    if cmd == "check" {
        std::process::exit(if check() { 0 } else { 1 });
    }
    lean_workers();
    sp1_sdk::utils::setup_logger();
    let t = Instant::now();
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vkey = pk.verifying_key().bytes32();
    assert_eq!(vkey.to_lowercase(), POOL_VKEY, "this guest's vkey is not the pool's");
    eprintln!("tacit-prover: ready in {:.0} s, vkey {vkey}, leaf hashing on {}", t.elapsed().as_secs_f64(), tacit_leafhash::device().unwrap_or("the CPU"));

    match cmd {
        "prove" => {
            let path = args.get(2).expect("usage: tacit-prover prove <stdin.bin>");
            let stdin = read_stdin(&std::fs::read(path).expect("read input")).expect("not a bincode SP1Stdin");
            let mut job = Job::default();
            run(&client, &pk, stdin, &mut job);
            let out = format!("{path}.proof.json");
            std::fs::write(&out, job_json(&job).to_string()).expect("write proof");
            eprintln!("tacit-prover: {} in {:.0} s -> {out}", job.status, job.secs);
            std::process::exit(if job.status == "done" { 0 } else { 1 });
        }
        "serve" => serve(client, pk, vkey),
        other => {
            eprintln!("unknown command {other}; use serve, prove <stdin> or check");
            std::process::exit(2);
        }
    }
}

// Below 16 GB the SDK's default concurrency (several shards and recursion proofs at once) pages; one per stage is faster.
fn lean_workers() {
    if ram_bytes().map_or(true, |b| b >= 16 << 30) {
        return;
    }
    for k in ["CORE", "RECURSION_PROVER", "RECURSION_EXECUTOR", "DEFERRED", "SETUP", "PREPARE_REDUCE", "SPLICING"] {
        let var = format!("SP1_WORKER_NUM_{k}_WORKERS");
        if std::env::var_os(&var).is_none() {
            std::env::set_var(var, "1");
        }
    }
}

fn ram_bytes() -> Option<u64> {
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        String::from_utf8(out.stdout).ok()?.trim().parse().ok()
    } else {
        let info = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: u64 = info.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb * 1024)
    }
}

fn read_stdin(raw: &[u8]) -> Option<SP1Stdin> {
    bincode::deserialize(raw).ok()
}

fn run(client: &sp1_sdk::blocking::CpuProver, pk: &sp1_sdk::SP1ProvingKey, stdin: SP1Stdin, job: &mut Job) {
    let t = Instant::now();
    // Execute first: an input the guest rejects fails in a second, not after the whole proof.
    match client.execute(Elf::Static(ELF), stdin.clone()).run() {
        Err(e) => {
            job.status = "failed";
            job.error = format!("the guest rejects this input: {e}");
            return;
        }
        Ok((_, report)) => job.cycles = report.total_instruction_count(),
    }
    let res = client.prove(pk, stdin).groth16().run().map_err(|e| e.to_string()).and_then(|proof| {
        client.verify(&proof, pk.verifying_key(), None).map_err(|e| format!("the proof made here does not verify: {e}"))?;
        Ok(proof)
    });
    job.secs = t.elapsed().as_secs_f64();
    match res {
        Ok(p) => {
            job.status = "done";
            job.public_values = format!("0x{}", hex::encode(p.public_values.as_slice()));
            job.proof = format!("0x{}", hex::encode(p.bytes()));
        }
        Err(e) => {
            job.status = "failed";
            job.error = e;
        }
    }
}

fn job_json(j: &Job) -> serde_json::Value {
    let secs = match (j.status, j.started) {
        ("done" | "failed", _) | (_, None) => j.secs,
        (_, Some(t)) => t.elapsed().as_secs_f64(),
    };
    let mut o = serde_json::json!({"status": j.status, "secs": secs.round(), "cycles": j.cycles});
    if j.status == "done" {
        o["publicValues"] = j.public_values.clone().into();
        o["proof"] = j.proof.clone().into();
    }
    if j.status == "failed" {
        o["error"] = j.error.clone().into();
    }
    o
}

fn store_dir() -> PathBuf {
    std::env::var_os("TACIT_PROVER_DIR").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".tacit-prover")
    })
}

fn serve(client: sp1_sdk::blocking::CpuProver, pk: sp1_sdk::SP1ProvingKey, vkey: String) {
    let port: u16 = std::env::var("TACIT_PROVER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47815);
    let origins: Vec<String> = std::env::var("TACIT_PROVER_ORIGINS")
        .unwrap_or_else(|_| "https://tacit.finance,https://www.tacit.finance,http://localhost:8080,http://127.0.0.1:8080".into())
        .split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let dir = store_dir().join("proofs");
    let _ = std::fs::create_dir_all(&dir);

    // Proofs finished before a restart are still answered; a job's id is the hash of its input.
    let mut jobs = HashMap::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".json") else { continue };
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&std::fs::read(e.path()).unwrap_or_default()) else { continue };
            jobs.insert(id.to_string(), Job {
                status: "done",
                secs: v["secs"].as_f64().unwrap_or(0.0),
                cycles: v["cycles"].as_u64().unwrap_or(0),
                public_values: v["publicValues"].as_str().unwrap_or_default().to_string(),
                proof: v["proof"].as_str().unwrap_or_default().to_string(),
                ..Default::default()
            });
        }
    }
    let state = Arc::new((Mutex::new(State { jobs, queue: VecDeque::new() }), Condvar::new()));

    // One proof at a time: a second would double the memory and halve each one's speed.
    {
        let state = state.clone();
        std::thread::spawn(move || loop {
            let (id, stdin) = {
                let (m, cv) = &*state;
                let mut s = m.lock().unwrap();
                while s.queue.is_empty() {
                    s = cv.wait(s).unwrap();
                }
                let (id, stdin) = s.queue.pop_front().unwrap();
                if let Some(j) = s.jobs.get_mut(&id) {
                    j.status = "proving";
                    j.started = Some(Instant::now());
                }
                (id, stdin)
            };
            let mut job = Job { status: "proving", started: Some(Instant::now()), ..Default::default() };
            run(&client, &pk, stdin, &mut job);
            if job.status == "done" {
                let _ = std::fs::write(dir.join(format!("{id}.json")), job_json(&job).to_string());
            }
            eprintln!("tacit-prover: job {id} {} in {:.0} s", job.status, job.secs);
            state.0.lock().unwrap().jobs.insert(id, job);
        });
    }

    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    eprintln!("tacit-prover: listening on 127.0.0.1:{port}");
    for conn in listener.incoming().flatten() {
        let state = state.clone();
        let origins = origins.clone();
        let vkey = vkey.clone();
        std::thread::spawn(move || {
            let _ = handle(conn, &state, &origins, &vkey);
        });
    }
}

fn handle(mut conn: TcpStream, state: &Arc<(Mutex<State>, Condvar)>, origins: &[String], vkey: &str) -> std::io::Result<()> {
    let mut r = BufReader::new(conn.try_clone()?);
    let mut line = String::new();
    r.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let (mut origin, mut len) = (String::new(), 0usize);
    loop {
        let mut h = String::new();
        if r.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "origin" => origin = v.trim().to_string(),
                "content-length" => len = v.trim().parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    // A page may use the prover only from an allowed origin; programs on this machine can reach 127.0.0.1 anyway.
    let allowed = origin.is_empty() || origins.iter().any(|o| o == &origin);
    let cors = if allowed && !origin.is_empty() {
        format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Private-Network: true\r\n")
    } else {
        String::new()
    };
    let reply = |conn: &mut TcpStream, code: &str, body: String| -> std::io::Result<()> {
        write!(conn, "HTTP/1.1 {code}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{cors}Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len())
    };
    if !allowed {
        return reply(&mut conn, "403 Forbidden", r#"{"error":"origin not allowed"}"#.into());
    }
    if method == "OPTIONS" {
        let pre = format!("HTTP/1.1 204 No Content\r\n{cors}Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return conn.write_all(pre.as_bytes());
    }
    if len > 2 * MAX_INPUT + 1024 {
        return reply(&mut conn, "413 Payload Too Large", r#"{"error":"input over 1 MiB"}"#.into());
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    match (method.as_str(), path) {
        ("GET", "/health") => {
            let s = state.0.lock().unwrap();
            let busy = s.jobs.values().any(|j| j.status == "proving");
            let gpu = tacit_leafhash::device();
            reply(&mut conn, "200 OK", serde_json::json!({"ok": true, "vkey": vkey, "busy": busy, "queued": s.queue.len(), "gpu": gpu}).to_string())
        }
        ("POST", "/prove") => {
            let raw: Option<Vec<u8>> = serde_json::from_slice::<serde_json::Value>(&body).ok()
                .and_then(|v| v.get("stdin").and_then(|s| s.as_str()).map(|s| s.trim_start_matches("0x").to_string()))
                .and_then(|h| hex::decode(h).ok())
                .filter(|b| b.len() <= MAX_INPUT);
            let Some(raw) = raw else {
                return reply(&mut conn, "400 Bad Request", r#"{"error":"stdin must be the 0x-hex of a bincode SP1Stdin"}"#.into());
            };
            let Some(stdin) = read_stdin(&raw) else {
                return reply(&mut conn, "400 Bad Request", r#"{"error":"stdin must be the 0x-hex of a bincode SP1Stdin"}"#.into());
            };
            let id = hex::encode(&Sha256::digest(&raw)[..16]);
            let (m, cv) = &**state;
            let mut s = m.lock().unwrap();
            // The same input asked for again (a page reloaded mid-proof) is the same job.
            let again = s.jobs.get(&id).is_some_and(|j| j.status != "failed");
            if !again {
                s.jobs.insert(id.clone(), Job { status: "queued", ..Default::default() });
                s.queue.push_back((id.clone(), stdin));
                cv.notify_one();
            }
            reply(&mut conn, "200 OK", serde_json::json!({"id": id}).to_string())
        }
        ("GET", "/job") => {
            let id = query.split('&').find_map(|kv| kv.strip_prefix("id=")).unwrap_or("");
            let s = state.0.lock().unwrap();
            match s.jobs.get(id) {
                None => reply(&mut conn, "404 Not Found", r#"{"error":"no such job"}"#.into()),
                Some(j) => {
                    let mut o = job_json(j);
                    o["id"] = id.into();
                    reply(&mut conn, "200 OK", o.to_string())
                }
            }
        }
        _ => reply(&mut conn, "404 Not Found", r#"{"error":"not found"}"#.into()),
    }
}

// The GPU leaf hash against SP1's own outer hasher on random rows of several widths, with timings.
fn check() -> bool {
    use rand::Rng;
    use slop_algebra::{AbstractField, PrimeField32};
    use slop_bn254::{outer_perm, Bn254Fr, OuterPerm};
    use slop_koala_bear::KoalaBear;
    use slop_symmetric::{CryptographicHasher, Hash, MultiField32PaddingFreeSponge};
    type H = MultiField32PaddingFreeSponge<KoalaBear, Bn254Fr, OuterPerm, 3, 16, 1>;
    let Some(dev) = tacit_leafhash::device() else {
        println!("no GPU leaf hashing here (macOS with Metal only, and TACIT_METAL unset); proofs hash on the CPU");
        return true;
    };
    let h = H::new(outer_perm()).unwrap();
    let mut rng = rand::thread_rng();
    let mut ok = true;
    for (n, width) in [(4096usize, 1usize), (8192, 7), (16384, 16), (16384, 17), (8192, 136)] {
        let rows: Vec<KoalaBear> = (0..n * width).map(|_| KoalaBear::from_canonical_u32(rng.gen_range(0..0x7f000001))).collect();
        let t = Instant::now();
        let cpu: Vec<[u64; 4]> = rows.chunks(width).map(|r| {
            let d: Hash<KoalaBear, Bn254Fr, 1> = h.hash_iter(r.iter().copied());
            let d: [Bn254Fr; 1] = d.into();
            unsafe { std::mem::transmute::<Bn254Fr, [u64; 4]>(d[0]) }
        }).collect();
        let tc = t.elapsed();
        let monty: Vec<u32> = rows.iter().map(|v| unsafe { std::mem::transmute::<KoalaBear, u32>(*v) }).collect();
        let canonical: Vec<u32> = rows.iter().map(|v| v.as_canonical_u32()).collect();
        let mut g1 = vec![[0u64; 4]; n];
        let mut g2 = vec![[0u64; 4]; n];
        let t = Instant::now();
        let ran = tacit_leafhash::hash_rows(&monty, width, true, &mut g1) && tacit_leafhash::hash_rows(&canonical, width, false, &mut g2);
        let tg = t.elapsed() / 2;
        let same = ran && g1 == cpu && g2 == cpu;
        ok &= same;
        println!("{n:6} rows x {width:3}: {}  CPU (one thread) {:.1} us/row, GPU ({dev}) {:.2} us/row",
            if same { "equal" } else { "DIFFERENT" }, tc.as_secs_f64() * 1e6 / n as f64, tg.as_secs_f64() * 1e6 / n as f64);
    }
    ok
}
