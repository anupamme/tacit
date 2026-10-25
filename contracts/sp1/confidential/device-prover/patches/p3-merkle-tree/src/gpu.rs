//! The first digest layer of a tree whose leaves are KoalaBear rows and whose digests are one BN254 element (SP1's outer
//! commitments), hashed on the GPU by `tacit-leafhash`. The CPU hasher stays the reference: every call recomputes three
//! rows with `h.hash_iter` and compares them, and any difference turns the GPU path off for the rest of the process.

use alloc::vec;
use alloc::vec::Vec;
use core::any::type_name;
use core::mem::size_of;
use core::sync::atomic::{AtomicU8, Ordering};

use p3_field::{PackedField, PackedValue};
use p3_matrix::Matrix;
use p3_maybe_rayon::prelude::*;
use p3_symmetric::CryptographicHasher;

// Trees smaller than this are cheaper on the CPU than a dispatch.
const MIN_ROWS: usize = 1 << 12;

const UNTRIED: u8 = 0;
const ON: u8 = 1;
const OFF: u8 = 2;
static STATE: AtomicU8 = AtomicU8::new(UNTRIED);

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

    // KoalaBear is one u32 in Montgomery form; the kernel converts. A single dense matrix is read in place.
    let words = |m: &M, r: usize| -> *const u32 { m.row_slice(r).as_ptr() as *const u32 };
    let gathered: Vec<u32>;
    let rows: &[u32] = match tallest_matrices {
        [m] if type_name::<M>().contains("DenseMatrix")
            && words(*m, 1) == unsafe { words(*m, 0).add(width) }
            && words(*m, max_height - 1) == unsafe { words(*m, 0).add((max_height - 1) * width) } =>
        unsafe { core::slice::from_raw_parts(words(*m, 0), max_height * width) },
        _ => {
            let mut buf = vec![0u32; max_height * width];
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

    let mut digests = vec![[PW::Value::default(); DIGEST_ELEMS]; max_height.next_power_of_two()];
    let out = unsafe { core::slice::from_raw_parts_mut(digests.as_mut_ptr() as *mut [u64; 4], max_height) };
    if !tacit_leafhash::hash_rows(rows, width, true, out) {
        STATE.store(OFF, Ordering::Relaxed);
        return None;
    }

    for r in [0, max_height / 2, max_height - 1] {
        let cpu: [PW::Value; DIGEST_ELEMS] = h.hash_iter(tallest_matrices.iter().flat_map(|m| m.row(r)));
        let same = unsafe {
            core::slice::from_raw_parts(cpu.as_ptr() as *const u8, 32)
                == core::slice::from_raw_parts(digests.as_ptr().add(r) as *const u8, 32)
        };
        if !same {
            STATE.store(OFF, Ordering::Relaxed);
            tracing::warn!("GPU leaf hash differs from the CPU hasher at row {r}; hashing on the CPU from now on");
            return None;
        }
    }
    if STATE.swap(ON, Ordering::Relaxed) == UNTRIED {
        tracing::info!(
            "leaf hashing on the GPU ({}): {max_height} rows x {width}",
            tacit_leafhash::device().unwrap_or("?")
        );
    }
    Some(digests)
}
