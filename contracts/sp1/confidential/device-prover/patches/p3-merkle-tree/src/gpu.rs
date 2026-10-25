//! The first digest layer of a tree whose leaves are KoalaBear rows and whose digests are one BN254 element (SP1's outer
//! commitments), and each layer above it, hashed on the GPU by `tacit-leafhash` while the CPU hashes the rest of the same
//! layer. The CPU hasher and compressor stay the reference: every call recomputes three of the GPU's rows or nodes and
//! compares them, and any difference turns that GPU path off for the rest of the process.

extern crate std;

use alloc::vec;
use alloc::vec::Vec;
use core::any::type_name;
use core::mem::size_of;
use core::sync::atomic::{AtomicU32, AtomicU8, Ordering};
use std::time::Instant;

use p3_field::{PackedField, PackedValue};
use p3_matrix::Matrix;
use p3_maybe_rayon::prelude::*;
use p3_symmetric::{CryptographicHasher, PseudoCompressionFunction};

// Trees smaller than this are cheaper on the CPU than a dispatch.
const MIN_ROWS: usize = 1 << 12;

const UNTRIED: u8 = 0;
const ON: u8 = 1;
const OFF: u8 = 2;
static STATE: AtomicU8 = AtomicU8::new(UNTRIED);
static NODES: AtomicU8 = AtomicU8::new(UNTRIED);

// The GPU's share of a layer, in 1/1024ths: the GPU takes the front and the CPU's threads the rest, at once. Each call
// moves the share halfway toward what both rates just measured would have finished together.
static LEAF_SHARE: AtomicU32 = AtomicU32::new(768);
static NODE_SHARE: AtomicU32 = AtomicU32::new(768);

fn gpu_part(n: usize, share: &AtomicU32) -> usize {
    let k = (n as u64 * share.load(Ordering::Relaxed) as u64 / 1024) as usize / 64 * 64;
    k.clamp(MIN_ROWS.min(n), n)
}

fn retune(share: &AtomicU32, gpu: (usize, f64), cpu: (usize, f64)) {
    if gpu.0 == 0 || cpu.0 == 0 || gpu.1 <= 0.0 || cpu.1 <= 0.0 {
        return;
    }
    let (g, c) = (gpu.0 as f64 / gpu.1, cpu.0 as f64 / cpu.1);
    let best = 1024.0 * g / (g + c);
    let now = share.load(Ordering::Relaxed) as f64;
    share.store(((now + best) / 2.0).clamp(512.0, 1008.0) as u32, Ordering::Relaxed);
}

fn same32<T>(a: &T, b: &T) -> bool {
    unsafe { core::slice::from_raw_parts(a as *const T as *const u8, 32) == core::slice::from_raw_parts(b as *const T as *const u8, 32) }
}

pub(crate) fn first_digest_layer<P, PW, H, M, const DIGEST_ELEMS: usize>(
    h: &H,
    tallest_matrices: &[&M],
    max_height: usize,
) -> Option<Vec<[PW::Value; DIGEST_ELEMS]>>
where
    P: PackedField,
    PW: PackedValue,
    H: CryptographicHasher<P::Scalar, [PW::Value; DIGEST_ELEMS]>,
    H: Sync,
    M: Matrix<P::Scalar>,
{
    if STATE.load(Ordering::Relaxed) == OFF
        || DIGEST_ELEMS != 1
        || P::WIDTH != 1
        || PW::WIDTH != 1
        || max_height < MIN_ROWS
        || size_of::<P::Scalar>() != 4
        || size_of::<PW::Value>() != 32
        || !type_name::<P::Scalar>().ends_with("KoalaBear")
        || !type_name::<PW::Value>().ends_with("Bn254Fr")
        || !type_name::<H>().contains("MultiField32PaddingFreeSponge")
    {
        return None;
    }
    if !tacit_leafhash::available() {
        STATE.store(OFF, Ordering::Relaxed);
        return None;
    }
    let width: usize = tallest_matrices.iter().map(|m| m.width()).sum();
    if width == 0 {
        return None;
    }
    let n = max_height;
    let k = gpu_part(n, &LEAF_SHARE);

    // KoalaBear is one u32 in Montgomery form; the kernel converts. A single dense matrix is read in place; otherwise the
    // GPU's rows are gathered.
    let words = |m: &M, r: usize| -> *const u32 { m.row_slice(r).as_ptr() as *const u32 };
    let gathered: Vec<u32>;
    let rows: &[u32] = match tallest_matrices {
        [m] if type_name::<M>().contains("DenseMatrix")
            && words(*m, 1) == unsafe { words(*m, 0).add(width) }
            && words(*m, k - 1) == unsafe { words(*m, 0).add((k - 1) * width) } =>
        unsafe { core::slice::from_raw_parts(words(*m, 0), k * width) },
        _ => {
            let mut buf = vec![0u32; k * width];
            buf.par_chunks_mut(width).enumerate().for_each(|(r, dst)| {
                let mut off = 0;
                for m in tallest_matrices {
                    let w = m.width();
                    let src = m.row_slice(r);
                    let src = unsafe { core::slice::from_raw_parts(src.as_ptr() as *const u32, w) };
                    dst[off..off + w].copy_from_slice(src);
                    off += w;
                }
            });
            gathered = buf;
            &gathered
        }
    };

    let mut digests = vec![[PW::Value::default(); DIGEST_ELEMS]; n.next_power_of_two()];
    let (front, back) = digests[..n].split_at_mut(k);
    let out = unsafe { core::slice::from_raw_parts_mut(front.as_mut_ptr() as *mut [u64; 4], k) };
    let (ok, tg, tc) = std::thread::scope(|s| {
        let gpu = s.spawn(|| {
            let t = Instant::now();
            (tacit_leafhash::hash_rows(rows, width, true, out), t.elapsed().as_secs_f64())
        });
        let t = Instant::now();
        back.par_iter_mut().enumerate().for_each(|(i, d)| *d = h.hash_iter(tallest_matrices.iter().flat_map(|m| m.row(k + i))));
        let tc = t.elapsed().as_secs_f64();
        let (ok, tg) = gpu.join().unwrap_or((false, 0.0));
        (ok, tg, tc)
    });
    if !ok {
        STATE.store(OFF, Ordering::Relaxed);
        return None;
    }

    for r in [0, k / 2, k - 1] {
        let cpu: [PW::Value; DIGEST_ELEMS] = h.hash_iter(tallest_matrices.iter().flat_map(|m| m.row(r)));
        if !same32(&cpu, &digests[r]) {
            STATE.store(OFF, Ordering::Relaxed);
            tracing::warn!("GPU leaf hash differs from the CPU hasher at row {r}; hashing on the CPU from now on");
            return None;
        }
    }
    retune(&LEAF_SHARE, (k, tg), (n - k, tc));
    if STATE.swap(ON, Ordering::Relaxed) == UNTRIED {
        tracing::info!(
            "leaf hashing on the GPU ({}) beside the CPU: {n} rows x {width}, {k} on the GPU",
            tacit_leafhash::device().unwrap_or("?")
        );
    }
    Some(digests)
}

// A layer above the first, when it is a plain layer (no smaller matrix injected) of BN254 digests compressed by Poseidon2.
pub(crate) fn compress<P, C, const DIGEST_ELEMS: usize>(prev_layer: &[[P::Value; DIGEST_ELEMS]], c: &C) -> Option<Vec<[P::Value; DIGEST_ELEMS]>>
where
    P: PackedValue,
    C: PseudoCompressionFunction<[P::Value; DIGEST_ELEMS], 2>,
    C: Sync,
{
    let next_len = prev_layer.len() / 2;
    if NODES.load(Ordering::Relaxed) == OFF
        || DIGEST_ELEMS != 1
        || next_len < MIN_ROWS
        || size_of::<P::Value>() != 32
        || !type_name::<P::Value>().ends_with("Bn254Fr")
        || !type_name::<C>().contains("TruncatedPermutation")
        || !type_name::<C>().contains("Bn254")
    {
        return None;
    }
    if !tacit_leafhash::available() {
        NODES.store(OFF, Ordering::Relaxed);
        return None;
    }
    let k = gpu_part(next_len, &NODE_SHARE);
    let mut next = vec![[P::Value::default(); DIGEST_ELEMS]; next_len];
    let (front, back) = next.split_at_mut(k);
    let (ok, tg, tc) = std::thread::scope(|s| {
        let gpu = s.spawn(|| {
            let t = Instant::now();
            let ok = unsafe {
                tacit_leafhash::compress_pairs(
                    core::slice::from_raw_parts(prev_layer.as_ptr() as *const [u64; 4], 2 * k),
                    core::slice::from_raw_parts_mut(front.as_mut_ptr() as *mut [u64; 4], k),
                )
            };
            (ok, t.elapsed().as_secs_f64())
        });
        let t = Instant::now();
        back.par_iter_mut().enumerate().for_each(|(i, d)| *d = c.compress([prev_layer[2 * (k + i)], prev_layer[2 * (k + i) + 1]]));
        let tc = t.elapsed().as_secs_f64();
        let (ok, tg) = gpu.join().unwrap_or((false, 0.0));
        (ok, tg, tc)
    });
    if !ok {
        NODES.store(OFF, Ordering::Relaxed);
        return None;
    }
    for i in [0, k / 2, k - 1] {
        let cpu = c.compress([prev_layer[2 * i], prev_layer[2 * i + 1]]);
        if !same32(&cpu, &next[i]) {
            NODES.store(OFF, Ordering::Relaxed);
            tracing::warn!("GPU node compression differs from the CPU at node {i}; compressing on the CPU from now on");
            return None;
        }
    }
    retune(&NODE_SHARE, (k, tg), (next_len - k, tc));
    if NODES.swap(ON, Ordering::Relaxed) == UNTRIED {
        tracing::info!("tree layers compressed on the GPU ({}) beside the CPU, from {next_len} nodes", tacit_leafhash::device().unwrap_or("?"));
    }
    Some(next)
}
