//! Mines CreateX CREATE2 salts whose contract address starts with zero bytes.
//!
//! CreateX.deployCreate2(salt, initCode) with a salt whose first 20 bytes are neither the sender nor zero is "random"
//! form: any caller, any chain, guarded only as keccak256(abi.encode(salt)). The address is then
//!   CREATE2(CreateX, keccak256(salt), keccak256(initCode))
//! so it commits to the exact init code (constructor arguments included): only that code can land there.
//!
//!   vanity-create2 mine --factory 0x.. --init-hash 0x.. --zeros 3 --tag NAME
//!   vanity-create2 address --factory 0x.. --init-hash 0x.. --salt 0x..
use rayon::prelude::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tiny_keccak::{Hasher, Keccak};

fn keccak(data: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(data);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

struct Ctx {
    factory: [u8; 20],
    init_hash: [u8; 32],
}

fn address_of(c: &Ctx, salt: &[u8; 32]) -> [u8; 20] {
    let guarded = keccak(salt);
    let mut p = [0u8; 85];
    p[0] = 0xff;
    p[1..21].copy_from_slice(&c.factory);
    p[21..53].copy_from_slice(&guarded);
    p[53..85].copy_from_slice(&c.init_hash);
    let h = keccak(&p);
    let mut out = [0u8; 20];
    out.copy_from_slice(&h[12..32]);
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn parse_hex<const N: usize>(s: &str) -> [u8; N] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    assert!(s.len() == N * 2, "expected {} hex bytes, got {}", N, s.len() / 2);
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("bad hex");
    }
    out
}

fn checksum(a: &[u8; 20]) -> String {
    let lower = hex(a);
    let h = hex(&keccak(lower.as_bytes()));
    let mut out = String::from("0x");
    for (i, ch) in lower.chars().enumerate() {
        let nib = u8::from_str_radix(&h[i..i + 1], 16).unwrap();
        out.push(if ch.is_ascii_alphabetic() && nib >= 8 { ch.to_ascii_uppercase() } else { ch });
    }
    out
}

// The first 20 bytes of every salt are derived from the tag, so they are never the sender's address (nobody holds a
// key for them) and never zero; the last 12 bytes count up from a random start, per worker.
fn mine(c: &Ctx, tag: &str, zeros: usize) -> ([u8; 32], [u8; 20], u64) {
    let found = AtomicBool::new(false);
    let tries = AtomicU64::new(0);
    let result: Mutex<Option<([u8; 32], [u8; 20])>> = Mutex::new(None);
    let workers = rayon::current_num_threads();
    let mut seed = [0u8; 8];
    getrandom::getrandom(&mut seed).expect("no randomness");
    let base = u64::from_be_bytes(seed);
    let head = keccak(format!("tac-vaults/{}", tag).as_bytes());
    (0..workers).into_par_iter().for_each(|w| {
        let mut salt = [0u8; 32];
        salt[..20].copy_from_slice(&head[..20]);
        salt[20] = (w >> 8) as u8;
        salt[21] = w as u8;
        let mut n = base;
        let mut local = 0u64;
        while !found.load(Ordering::Relaxed) {
            salt[24..32].copy_from_slice(&n.to_be_bytes());
            n = n.wrapping_add(1);
            local += 1;
            let a = address_of(c, &salt);
            if a[..zeros].iter().all(|b| *b == 0) {
                if !found.swap(true, Ordering::SeqCst) {
                    *result.lock().unwrap() = Some((salt, a));
                }
                break;
            }
            if local % 65536 == 0 {
                tries.fetch_add(65536, Ordering::Relaxed);
                local = 0;
            }
        }
        tries.fetch_add(local, Ordering::Relaxed);
    });
    let (salt, a) = result.into_inner().unwrap().expect("no result");
    (salt, a, tries.load(Ordering::Relaxed))
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).map(|i| args[i + 1].clone())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let c = Ctx {
        factory: parse_hex(&arg(&args, "--factory").expect("--factory")),
        init_hash: parse_hex(&arg(&args, "--init-hash").expect("--init-hash")),
    };
    match cmd {
        "address" => {
            let salt: [u8; 32] = parse_hex(&arg(&args, "--salt").expect("--salt"));
            println!("{}", checksum(&address_of(&c, &salt)));
        }
        "mine" => {
            let zeros: usize = arg(&args, "--zeros").unwrap_or("3".into()).parse().unwrap();
            let tag = arg(&args, "--tag").expect("--tag");
            let t = Instant::now();
            let (salt, a, tries) = mine(&c, &tag, zeros);
            let secs = t.elapsed().as_secs_f64();
            eprintln!("{:<22} {} after {} tries in {:.1}s ({:.1}M/s)", tag, checksum(&a), tries, secs, tries as f64 / secs / 1e6);
            println!("{{ \"salt\": \"0x{}\", \"address\": \"{}\" }}", hex(&salt), checksum(&a));
        }
        _ => {
            eprintln!("usage: vanity-create2 mine|address --factory 0x.. --init-hash 0x.. [--zeros N --tag NAME] [--salt 0x..]");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Ctx {
        Ctx {
            factory: parse_hex("0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed"),
            init_hash: parse_hex("0xabababababababababababababababababababababababababababababababab"),
        }
    }

    // From CreateX itself: computeCreate2Address(keccak256(salt), initCodeHash, CreateX) on a mainnet fork.
    #[test]
    fn matches_createx() {
        let salt: [u8; 32] = parse_hex("0x1111111111111111111111111111111111111111000000000000000000000042");
        assert_eq!(checksum(&address_of(&ctx(), &salt)), "0xc028a6eD096D89B7f959EBdd2C14DA1078B800Fd");
    }

    #[test]
    fn checksum_is_eip55() {
        let a: [u8; 20] = parse_hex("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
        assert_eq!(checksum(&a), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    }
}
