use alloc::string::String;
use core::marker::PhantomData;

use itertools::Itertools;
use p3_field::{reduce_31, Field, PrimeField, PrimeField31, PrimeField32};

use crate::hash::Hash;
use crate::hasher::CryptographicHasher;
use crate::permutation::CryptographicPermutation;

/// A padding-free, overwrite-mode sponge function.
///
/// `WIDTH` is the sponge's rate plus the sponge's capacity.
#[derive(Clone, Debug)]
pub struct PaddingFreeSponge<P, const WIDTH: usize, const RATE: usize, const OUT: usize> {
    permutation: P,
}

impl<P, const WIDTH: usize, const RATE: usize, const OUT: usize>
    PaddingFreeSponge<P, WIDTH, RATE, OUT>
{
    pub const fn new(permutation: P) -> Self {
        Self { permutation }
    }
}

impl<T, P, const WIDTH: usize, const RATE: usize, const OUT: usize> CryptographicHasher<T, [T; OUT]>
    for PaddingFreeSponge<P, WIDTH, RATE, OUT>
where
    T: Default + Copy,
    P: CryptographicPermutation<[T; WIDTH]>,
{
    fn hash_iter<I>(&self, input: I) -> [T; OUT]
    where
        I: IntoIterator<Item = T>,
    {
        // static_assert(RATE < WIDTH)
        let mut state = [T::default(); WIDTH];
        for input_chunk in &input.into_iter().chunks(RATE) {
            state.iter_mut().zip(input_chunk).for_each(|(s, i)| *s = i);
            state = self.permutation.permute(state);
        }
        state[..OUT].try_into().unwrap()
    }
}

const PACK_MAX: usize = 64;

/// The field element sum(vals[i] * 2^(31 i)), as `reduce_31` computes it: values below 2^31, two at a time as one u64
/// (four conversions and three multiplications for eight values, against sixteen of each one at a time).
fn pack_31<PF: PrimeField>(vals: &[u32]) -> PF {
    let po2 = PF::from_canonical_u64(1u64 << 62);
    let mut result = PF::zero();
    let mut i = vals.len().div_ceil(2);
    while i > 0 {
        i -= 1;
        let lo = vals[2 * i] as u64;
        let hi = vals.get(2 * i + 1).map_or(0, |&v| v as u64);
        result = result * po2 + PF::from_canonical_u64(lo | (hi << 31));
    }
    result
}

/// A padding-free, overwrite-mode sponge function that operates natively over PF but accepts elements
/// of F: PrimeField32.
///
/// `WIDTH` is the sponge's rate plus the sponge's capacity.
#[derive(Clone, Debug)]
pub struct MultiField32PaddingFreeSponge<
    F,
    PF,
    P,
    const WIDTH: usize,
    const RATE: usize,
    const OUT: usize,
> {
    permutation: P,
    num_f_elms: usize,
    _phantom: PhantomData<(F, PF)>,
}

impl<F, PF, P, const WIDTH: usize, const RATE: usize, const OUT: usize>
    MultiField32PaddingFreeSponge<F, PF, P, WIDTH, RATE, OUT>
where
    F: PrimeField32,
    PF: Field,
{
    pub fn new(permutation: P) -> Result<Self, String> {
        if F::order() >= PF::order() {
            return Err(String::from("F::order() must be less than PF::order()"));
        }

        let num_f_elms = PF::bits() / F::bits();
        Ok(Self {
            permutation,
            num_f_elms,
            _phantom: PhantomData,
        })
    }
}

impl<F, PF, P, const WIDTH: usize, const RATE: usize, const OUT: usize>
    CryptographicHasher<F, Hash<F, PF, OUT>>
    for MultiField32PaddingFreeSponge<F, PF, P, WIDTH, RATE, OUT>
where
    F: PrimeField31,
    PF: PrimeField + Default + Copy,
    P: CryptographicPermutation<[PF; WIDTH]>,
{
    fn hash_iter<I>(&self, input: I) -> Hash<F, PF, OUT>
    where
        I: IntoIterator<Item = F>,
    {
        let mut state = [PF::default(); WIDTH];
        if self.num_f_elms > PACK_MAX {
            for block_chunk in &input.into_iter().chunks(RATE) {
                for (chunk_id, chunk) in (&block_chunk.chunks(self.num_f_elms))
                    .into_iter()
                    .enumerate()
                {
                    state[chunk_id] = reduce_31(&chunk.collect_vec());
                }
                state = self.permutation.permute(state);
            }
        } else {
            // The same blocks of RATE values and groups of num_f_elms per state element as above, each group packed by
            // pack_31 without an allocation.
            let mut input = input.into_iter().peekable();
            let mut group = [0u32; PACK_MAX];
            while input.peek().is_some() {
                let (mut taken, mut chunk_id) = (0, 0);
                while taken < RATE && input.peek().is_some() {
                    let mut k = 0;
                    while k < self.num_f_elms && taken < RATE {
                        match input.next() {
                            Some(v) => {
                                group[k] = v.as_canonical_u32();
                                k += 1;
                                taken += 1;
                            }
                            None => break,
                        }
                    }
                    state[chunk_id] = pack_31(&group[..k]);
                    chunk_id += 1;
                }
                state = self.permutation.permute(state);
            }
        }

        let inner_arr: [PF; OUT] = state[..OUT].try_into().unwrap();
        inner_arr.into()
    }
}

impl<F, PF, P, const WIDTH: usize, const RATE: usize, const OUT: usize>
    CryptographicHasher<F, [PF; OUT]> for MultiField32PaddingFreeSponge<F, PF, P, WIDTH, RATE, OUT>
where
    F: PrimeField31,
    PF: PrimeField + Default + Copy,
    P: CryptographicPermutation<[PF; WIDTH]>,
{
    fn hash_iter<I>(&self, input: I) -> [PF; OUT]
    where
        I: IntoIterator<Item = F>,
    {
        let mut state = [PF::default(); WIDTH];
        for block_chunk in &input.into_iter().chunks(RATE) {
            for (chunk_id, chunk) in (&block_chunk.chunks(self.num_f_elms))
                .into_iter()
                .enumerate()
            {
                state[chunk_id] = reduce_31(&chunk.collect_vec());
            }
            state = self.permutation.permute(state);
        }

        state[..OUT].try_into().unwrap()
    }
}
