use p3_field::{Field, PrimeField, PrimeField31, PrimeField64};
use p3_maybe_rayon::prelude::*;
use p3_symmetric::CryptographicPermutation;
use tracing::instrument;

use crate::{CanObserve, CanSampleBits, DuplexChallenger, MultiField32Challenger};

pub trait GrindingChallenger:
    CanObserve<Self::Witness> + CanSampleBits<usize> + Sync + Clone
{
    type Witness: Field;

    fn grind(&mut self, bits: usize) -> Self::Witness;

    #[must_use]
    fn check_witness(&mut self, bits: usize, witness: Self::Witness) -> bool {
        self.observe(witness);
        self.sample_bits(bits) == 0
    }
}

impl<F, P, const WIDTH: usize, const RATE: usize> GrindingChallenger
    for DuplexChallenger<F, P, WIDTH, RATE>
where
    F: PrimeField64,
    P: CryptographicPermutation<[F; WIDTH]>,
{
    type Witness = F;

    #[instrument(name = "grind for proof-of-work witness", skip_all)]
    fn grind(&mut self, bits: usize) -> Self::Witness {
        let witness = (0..F::ORDER_U64)
            .into_par_iter()
            .map(|i| F::from_canonical_u64(i))
            .find_any(|witness| self.clone().check_witness(bits, *witness))
            .expect("failed to find witness");
        assert!(self.check_witness(bits, witness));
        witness
    }
}

impl<F, PF, P, const WIDTH: usize, const RATE: usize> GrindingChallenger
    for MultiField32Challenger<F, PF, P, WIDTH, RATE>
where
    F: PrimeField31,
    PF: PrimeField,
    P: CryptographicPermutation<[PF; WIDTH]>,
{
    type Witness = F;

    #[instrument(name = "grind for proof-of-work witness", skip_all)]
    fn grind(&mut self, bits: usize) -> Self::Witness {
        // Any passing nonce serves (the search below takes whichever a thread finds first), so the GPU's is used once the
        // challenger itself accepts it.
        if let Some(witness) = crate::gpu::grind(self, bits) {
            if self.clone().check_witness(bits, witness) {
                assert!(self.check_witness(bits, witness));
                return witness;
            }
            crate::gpu::refused();
            tracing::warn!("the GPU's proof-of-work nonce does not pass here; searching on the CPU from now on");
        }
        let witness = (0..F::ORDER_U64)
            .into_par_iter()
            .map(F::from_canonical_u64)
            .find_any(|witness| self.clone().check_witness(bits, *witness))
            .expect("failed to find witness");
        assert!(self.check_witness(bits, witness));
        witness
    }
}
