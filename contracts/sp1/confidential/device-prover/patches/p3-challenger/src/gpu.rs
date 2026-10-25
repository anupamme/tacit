//! Proof-of-work for SP1's outer challenger (`MultiField32Challenger<KoalaBear, Bn254Fr, _, 3, 2>`, the wrap stage's 22
//! bits) searched on the GPU by `tacit-leafhash`, which runs the same sponge. Any nonce it returns is checked by the caller
//! with the challenger itself before it is used.

use alloc::vec::Vec;
use core::any::type_name;
use core::mem::size_of;
use core::sync::atomic::{AtomicBool, Ordering};

use p3_field::{PrimeField, PrimeField31};
use p3_symmetric::CryptographicPermutation;

use crate::MultiField32Challenger;

static OFF: AtomicBool = AtomicBool::new(false);

pub(crate) fn grind<F, PF, P, const WIDTH: usize, const RATE: usize>(c: &MultiField32Challenger<F, PF, P, WIDTH, RATE>, bits: usize) -> Option<F>
where
    F: PrimeField31,
    PF: PrimeField,
    P: CryptographicPermutation<[PF; WIDTH]>,
{
    if OFF.load(Ordering::Relaxed)
        || WIDTH != 3
        || RATE != 2
        || c.num_duplex_elms != 8
        || c.num_f_elms != 4
        || c.input_buffer.len() > 15
        || size_of::<PF>() != 32
        || !type_name::<PF>().ends_with("Bn254Fr")
        || !type_name::<F>().ends_with("KoalaBear")
        || !type_name::<P>().contains("Bn254")
    {
        return None;
    }
    let state: [[u64; 4]; 3] = unsafe { core::ptr::read(c.sponge_state.as_ptr() as *const [[u64; 4]; 3]) };
    let prefix: Vec<u32> = c.input_buffer.iter().map(|x| x.as_canonical_u32()).collect();
    tacit_leafhash::grind(&state, &prefix, bits as u32).map(F::from_canonical_u32)
}

// A nonce the challenger refused: the GPU search is not used again in this process.
pub(crate) fn refused() {
    OFF.store(true, Ordering::Relaxed);
}
