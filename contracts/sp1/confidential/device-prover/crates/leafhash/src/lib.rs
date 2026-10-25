//! Leaf hashing and node compression for SP1's outer (wrap) Merkle commitments on an Apple GPU.
//!
//! The wrap STARK commits its trace with `MultiField32PaddingFreeSponge<KoalaBear, Bn254Fr, Poseidon2<t=3>, 3, 16, 1>`:
//! a row of KoalaBear values is packed eight to a BN254 element, absorbed two elements at a time in overwrite mode, and
//! permuted. [`hash_rows`] computes the same digests on the GPU, one row per thread. Each digest is the four little-endian
//! u64 Montgomery limbs p3-bn254-fr stores for a `Bn254Fr`. [`compress_pairs`] computes the layer above a layer of such
//! digests, each node `TruncatedPermutation<_, 2, 1, 3>` of its two children, and [`grind`] searches the outer challenger's
//! proof-of-work nonces. Elsewhere than macOS, or with `TACIT_METAL=0`, the GPU is
//! reported unavailable and callers keep their CPU path.

mod rc;

use std::sync::OnceLock;

/// The device the kernel runs on, if any.
pub fn device() -> Option<&'static str> {
    gpu().map(|g| g.name.as_str())
}

/// Whether [`hash_rows`] can run here.
pub fn available() -> bool {
    gpu().is_some()
}

/// Hashes `out.len()` rows of `width` values each, taken row-major from `rows`. With `monty`, the values are KoalaBear
/// in Montgomery form (as the field stores them); otherwise canonical. Returns false when the GPU is unavailable or a
/// dispatch fails, leaving `out` unspecified.
pub fn hash_rows(rows: &[u32], width: usize, monty: bool, out: &mut [[u64; 4]]) -> bool {
    if gpu().is_none() {
        return false;
    }
    let n = out.len();
    if width == 0 || rows.len() != n * width || n == 0 {
        return n == 0;
    }
    // Keeps each dispatch's row buffer near 256 MB, each block starting on a page so it is read where it lies.
    let per = ((64usize << 20) / width / 4096).max(1) * 4096;
    let mut start = 0;
    while start < n {
        let end = (start + per).min(n);
        let rc = unsafe {
            tacit_leafhash_run(
                rows[start * width..end * width].as_ptr(),
                (end - start) as u32,
                width as u32,
                monty as u32,
                out[start..end].as_mut_ptr() as *mut u64,
            )
        };
        if rc != 0 {
            return false;
        }
        start = end;
    }
    true
}

/// Compresses each pair of `prev` (a layer of digests, two per node) into `out`, which holds `prev.len() / 2` nodes. Returns
/// false when the GPU is unavailable or a dispatch fails, leaving `out` unspecified.
pub fn compress_pairs(prev: &[[u64; 4]], out: &mut [[u64; 4]]) -> bool {
    if gpu().is_none() || prev.len() != 2 * out.len() {
        return false;
    }
    // Keeps each dispatch's input near 512 MB.
    let per = 1usize << 23;
    let mut start = 0;
    while start < out.len() {
        let end = (start + per).min(out.len());
        let rc = unsafe {
            tacit_compress_run(prev[2 * start..2 * end].as_ptr() as *const u64, (end - start) as u32, out[start..end].as_mut_ptr() as *mut u64)
        };
        if rc != 0 {
            return false;
        }
        start = end;
    }
    true
}

/// Proof-of-work for SP1's outer challenger: the least nonce under the KoalaBear prime that passes `bits` with the sponge in
/// `state` (Bn254Fr Montgomery limbs) and `prefix` (the canonical KoalaBear values already buffered, at most 15). None when
/// the GPU is unavailable or a dispatch fails; the caller checks the nonce with the challenger itself.
pub fn grind(state: &[[u64; 4]; 3], prefix: &[u32], bits: u32) -> Option<u32> {
    if gpu().is_none() || prefix.len() > 15 || bits == 0 || bits > 30 {
        return None;
    }
    const P: u32 = 0x7f000001;
    let per = 1u32 << 20;
    let mut start = 0u32;
    while start < P {
        let n = per.min(P - start);
        let mut found = u32::MAX;
        let rc = unsafe { tacit_grind_run(state.as_ptr() as *const u64, prefix.as_ptr(), prefix.len() as u32, bits, start, n, &mut found) };
        if rc != 0 {
            return None;
        }
        if found != u32::MAX {
            return Some(found);
        }
        start += n;
    }
    None
}

struct Gpu {
    name: String,
}

fn gpu() -> Option<&'static Gpu> {
    static G: OnceLock<Option<Gpu>> = OnceLock::new();
    G.get_or_init(init).as_ref()
}

#[cfg(target_os = "macos")]
extern "C" {
    fn tacit_leafhash_init(msl: *const u8, ext: *const u64, intc: *const u64, name: *mut u8, name_len: usize) -> i32;
    fn tacit_leafhash_run(rows: *const u32, n: u32, width: u32, monty: u32, out: *mut u64) -> i32;
    fn tacit_compress_run(prev: *const u64, n: u32, out: *mut u64) -> i32;
    fn tacit_grind_run(state: *const u64, prefix: *const u32, plen: u32, bits: u32, start: u32, n: u32, found: *mut u32) -> i32;
}

#[cfg(not(target_os = "macos"))]
unsafe fn tacit_leafhash_run(_: *const u32, _: u32, _: u32, _: u32, _: *mut u64) -> i32 {
    -1
}

#[cfg(not(target_os = "macos"))]
unsafe fn tacit_compress_run(_: *const u64, _: u32, _: *mut u64) -> i32 {
    -1
}

#[cfg(not(target_os = "macos"))]
unsafe fn tacit_grind_run(_: *const u64, _: *const u32, _: u32, _: u32, _: u32, _: u32, _: *mut u32) -> i32 {
    -1
}

#[cfg(target_os = "macos")]
fn init() -> Option<Gpu> {
    if std::env::var("TACIT_METAL").as_deref() == Ok("0") {
        return None;
    }
    let mut ext = [[0u64; 4]; 24];
    let mut int = [[0u64; 4]; 56];
    for (r, row) in rc::RC3_HEX.iter().enumerate() {
        if (4..60).contains(&r) {
            int[r - 4] = to_monty(parse_be_hex(row[0]));
        } else {
            let e = if r < 4 { r } else { r - 56 };
            for i in 0..3 {
                ext[e * 3 + i] = to_monty(parse_be_hex(row[i]));
            }
        }
    }
    let msl = concat!(include_str!("leafhash.metal"), "\0");
    let mut name = [0u8; 128];
    let rc = unsafe {
        tacit_leafhash_init(msl.as_ptr(), ext.as_ptr() as *const u64, int.as_ptr() as *const u64, name.as_mut_ptr(), name.len())
    };
    if rc != 0 {
        return None;
    }
    let len = name.iter().position(|&b| b == 0).unwrap_or(name.len());
    Some(Gpu { name: String::from_utf8_lossy(&name[..len]).into_owned() })
}

#[cfg(not(target_os = "macos"))]
fn init() -> Option<Gpu> {
    None
}

// BN254 scalar field arithmetic for converting the constants to Montgomery form (R = 2^256).
const Q: [u64; 4] = [0x43e1f593f0000001, 0x2833e84879b97091, 0xb85045b68181585d, 0x30644e72e131a029];
const INV: u64 = 0xc2e1f593efffffff;
const R2: [u64; 4] = [0x1bb8e645ae216da7, 0x53fe3ab1e35c59e3, 0x8c49833d53bb8085, 0x0216d0b17f4e44a5];

fn parse_be_hex(h: &str) -> [u64; 4] {
    let h = h.trim_start_matches("0x");
    let mut l = [0u64; 4];
    for i in 0..4 {
        let hi = h.len() - 16 * i;
        l[i] = u64::from_str_radix(&h[hi - 16..hi], 16).expect("round constant hex");
    }
    l
}

fn to_monty(x: [u64; 4]) -> [u64; 4] {
    let mac = |a: u64, b: u64, c: u64, carry: u64| {
        let t = (a as u128) + (b as u128) * (c as u128) + (carry as u128);
        (t as u64, (t >> 64) as u64)
    };
    let mut t = [0u64; 4];
    for i in 0..4 {
        let (t0, mut a) = mac(t[0], x[0], R2[i], 0);
        let m = t0.wrapping_mul(INV);
        let (_, mut c) = mac(t0, m, Q[0], 0);
        for j in 1..4 {
            let (tj, a2) = mac(t[j], x[j], R2[i], a);
            a = a2;
            let (tj1, c2) = mac(tj, m, Q[j], c);
            c = c2;
            t[j - 1] = tj1;
        }
        t[3] = c.wrapping_add(a);
    }
    let mut r = [0u64; 4];
    let mut borrow = false;
    for i in 0..4 {
        let (d, b1) = t[i].overflowing_sub(Q[i]);
        let (d, b2) = d.overflowing_sub(borrow as u64);
        r[i] = d;
        borrow = b1 | b2;
    }
    if borrow { t } else { r }
}
