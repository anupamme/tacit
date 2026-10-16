// A CreateX CREATE3 salt bound to one deployer, for an address with leading zero bytes.
//
// The salt starts with the deployer's address and has 0x00 as its 21st byte, so CreateX guards it as
// keccak256(pad32(deployer) ‖ salt): only that deployer can use it, and the address is the same on every chain. The
// address is then CreateX's CREATE3: a proxy at CREATE2(CreateX, guardedSalt, proxyInitHash), which creates the
// contract at its nonce 1.
//
// usage: vanity <deployer 0x…> <createx 0x…> <zero bytes>   →   salt <0x…> guarded <0x…> address <0x…>
use rayon::prelude::*;
use sha3::{Digest, Keccak256};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn keccak(data: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(data);
    h.finalize().into()
}

fn addr(s: &str) -> [u8; 20] {
    let s = s.trim_start_matches("0x");
    assert_eq!(s.len(), 40, "an address is 20 bytes");
    let mut out = [0u8; 20];
    for i in 0..20 { out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex"); }
    out
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }

// A CreateX CREATE2 salt anyone may use, for an address with leading zero bytes.
//
// The salt starts with 20 zero bytes and has 0x00 as its 21st, so CreateX guards it as keccak256(salt): no deployer and no
// chain id is mixed in, so the address is the same on every chain and any account can deploy to it. The address is CREATE2's:
// CreateX, the guarded salt and the init code's hash, so nothing but that init code can ever be there.
//
// usage: vanity create2 <createx 0x…> <init code hash 0x…> <zero bytes>   →   salt <0x…> guarded <0x…> address <0x…>
fn hash32(s: &str) -> [u8; 32] {
    let s = s.trim_start_matches("0x");
    assert_eq!(s.len(), 64, "a hash is 32 bytes");
    let mut out = [0u8; 32];
    for i in 0..32 { out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex"); }
    out
}

fn create2(args: &[String]) {
    assert!(args.len() == 5, "usage: vanity create2 <createx> <init code hash> <zero bytes>");
    let (createx, init_hash, zeros) = (addr(&args[2]), hash32(&args[3]), args[4].parse::<usize>().expect("zero bytes"));
    assert!(zeros <= 8, "at most 8 zero bytes");
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64;
    let t0 = Instant::now();
    let hit = (0u64..u64::MAX).into_par_iter().map(|i| {
        let mut salt = [0u8; 32];
        salt[21..24].copy_from_slice(&seed.to_be_bytes()[5..8]);
        salt[24..32].copy_from_slice(&i.to_be_bytes());
        let guarded = keccak(&salt);
        let mut p = [0u8; 85];
        p[0] = 0xff;
        p[1..21].copy_from_slice(&createx);
        p[21..53].copy_from_slice(&guarded);
        p[53..85].copy_from_slice(&init_hash);
        (i, salt, guarded, keccak(&p))
    }).find_any(|(_, _, _, a)| a[12..12 + zeros].iter().all(|&x| x == 0)).expect("a hit");
    let (_, salt, guarded, a) = hit;
    eprintln!("found in {:.2} s", t0.elapsed().as_secs_f64());
    println!("salt 0x{} guarded 0x{} address 0x{}", hex(&salt), hex(&guarded), hex(&a[12..32]));
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("create2") { return create2(&args); }
    assert!(args.len() == 4, "usage: vanity <deployer> <createx> <zero bytes>");
    let (deployer, createx, zeros) = (addr(&args[1]), addr(&args[2]), args[3].parse::<usize>().expect("zero bytes"));
    assert!(zeros <= 8, "at most 8 zero bytes");
    // keccak256 of the CREATE3 proxy's init code, 0x67363d3d37363d34f03d5260086018f3
    let proxy_hash = keccak(&[0x67, 0x36, 0x3d, 0x3d, 0x37, 0x36, 0x3d, 0x34, 0xf0, 0x3d, 0x52, 0x60, 0x08, 0x60, 0x18, 0xf3]);
    // A different starting point each run, so two runs do not hand out the same salt.
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64;
    let t0 = Instant::now();
    let hit = (0u64..u64::MAX).into_par_iter().map(|i| {
        let mut salt = [0u8; 32];
        salt[..20].copy_from_slice(&deployer);
        // salt[20] = 0x00: guarded by the deployer, with no chain id mixed in
        salt[21..24].copy_from_slice(&seed.to_be_bytes()[5..8]);
        salt[24..32].copy_from_slice(&i.to_be_bytes());
        let mut g = [0u8; 64];
        g[12..32].copy_from_slice(&deployer);
        g[32..64].copy_from_slice(&salt);
        let guarded = keccak(&g);
        let mut p = [0u8; 85];
        p[0] = 0xff;
        p[1..21].copy_from_slice(&createx);
        p[21..53].copy_from_slice(&guarded);
        p[53..85].copy_from_slice(&proxy_hash);
        let proxy = keccak(&p);
        let mut c = [0u8; 23];
        c[0] = 0xd6;
        c[1] = 0x94;
        c[2..22].copy_from_slice(&proxy[12..32]);
        c[22] = 0x01;
        let a = keccak(&c);
        (i, salt, guarded, a)
    }).find_any(|(_, _, _, a)| a[12..12 + zeros].iter().all(|&x| x == 0)).expect("a hit");
    let (_, salt, guarded, a) = hit;
    eprintln!("found in {:.2} s", t0.elapsed().as_secs_f64());
    println!("salt 0x{} guarded 0x{} address 0x{}", hex(&salt), hex(&guarded), hex(&a[12..32]));
}
