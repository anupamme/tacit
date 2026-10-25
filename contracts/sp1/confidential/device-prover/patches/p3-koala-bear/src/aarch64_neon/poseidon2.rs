use p3_poseidon2::DiffusionPermutation;
use p3_symmetric::Permutation;

use crate::{
    koala_bear::monty_reduce, DiffusionMatrixKoalaBear, KoalaBear, PackedKoalaBearNeon, MONTY_INVERSE,
    POSEIDON2_INTERNAL_MATRIX_DIAG_16_KOALABEAR_MONTY, POSEIDON2_INTERNAL_MATRIX_DIAG_24_KOALABEAR_MONTY,
};

// The internal layer reads (1 + D(v)) as the Montgomery form of the matrix, so each output is scaled by MONTY_INVERSE. The
// scale is folded into the diagonal (at compile time) and into the sum, which the field makes exact:
// (s·D + Σ)·inv = s·(D·inv) + Σ·inv. A round then takes WIDTH + 1 multiplications instead of 2·WIDTH, and no longer builds a
// broadcast constant per element (rustc lowered `*i *= MONTY_INVERSE` to a libc memset_pattern16 call for each one).
const fn scaled<const N: usize>(diag: [KoalaBear; N]) -> [PackedKoalaBearNeon; N] {
    let mut out = [PackedKoalaBearNeon([KoalaBear { value: 0 }; 4]); N];
    let mut i = 0;
    while i < N {
        // A Montgomery product with MONTY_INVERSE (raw value 1) is the reduction of the other factor alone.
        out[i] = PackedKoalaBearNeon([KoalaBear { value: monty_reduce(diag[i].value as u64) }; 4]);
        i += 1;
    }
    out
}

const DIAG_16: [PackedKoalaBearNeon; 16] = scaled(POSEIDON2_INTERNAL_MATRIX_DIAG_16_KOALABEAR_MONTY);
const DIAG_24: [PackedKoalaBearNeon; 24] = scaled(POSEIDON2_INTERNAL_MATRIX_DIAG_24_KOALABEAR_MONTY);
const INV: PackedKoalaBearNeon = PackedKoalaBearNeon([MONTY_INVERSE; 4]);

#[inline(always)]
fn internal_layer<const N: usize>(state: &mut [PackedKoalaBearNeon; N], diag: &[PackedKoalaBearNeon; N]) {
    let sum = state.iter().copied().sum::<PackedKoalaBearNeon>() * INV;
    for (s, d) in state.iter_mut().zip(diag) {
        *s = *s * *d + sum;
    }
}

impl Permutation<[PackedKoalaBearNeon; 16]> for DiffusionMatrixKoalaBear {
    fn permute_mut(&self, state: &mut [PackedKoalaBearNeon; 16]) {
        internal_layer(state, &DIAG_16);
    }
}

impl DiffusionPermutation<PackedKoalaBearNeon, 16> for DiffusionMatrixKoalaBear {}

impl Permutation<[PackedKoalaBearNeon; 24]> for DiffusionMatrixKoalaBear {
    fn permute_mut(&self, state: &mut [PackedKoalaBearNeon; 24]) {
        internal_layer(state, &DIAG_24);
    }
}

impl DiffusionPermutation<PackedKoalaBearNeon, 24> for DiffusionMatrixKoalaBear {}

#[cfg(test)]
mod tests {
    use p3_field::AbstractField;
    use p3_poseidon2::{Poseidon2, Poseidon2ExternalMatrixGeneral};
    use p3_symmetric::Permutation;
    use rand::Rng;

    use crate::{DiffusionMatrixKoalaBear, KoalaBear, PackedKoalaBearNeon};

    type F = KoalaBear;
    const D: u64 = 7;
    type Perm16 = Poseidon2<F, Poseidon2ExternalMatrixGeneral, DiffusionMatrixKoalaBear, 16, D>;
    type Perm24 = Poseidon2<F, Poseidon2ExternalMatrixGeneral, DiffusionMatrixKoalaBear, 24, D>;

    /// Test that the output is the same as the scalar version on a random input.
    #[test]
    fn test_neon_poseidon2_width_16() {
        let mut rng = rand::thread_rng();

        // Our Poseidon2 implementation.
        let poseidon2 = Perm16::new_from_rng_128(
            Poseidon2ExternalMatrixGeneral,
            DiffusionMatrixKoalaBear,
            &mut rng,
        );

        let input: [F; 16] = rng.gen();

        let mut expected = input;
        poseidon2.permute_mut(&mut expected);

        let mut neon_input = input.map(PackedKoalaBearNeon::from_f);
        poseidon2.permute_mut(&mut neon_input);

        let neon_output = neon_input.map(|x| x.0[0]);

        assert_eq!(neon_output, expected);
    }

    /// Test that the output is the same as the scalar version on a random input.
    #[test]
    fn test_neon_poseidon2_width_24() {
        let mut rng = rand::thread_rng();

        // Our Poseidon2 implementation.
        let poseidon2 = Perm24::new_from_rng_128(
            Poseidon2ExternalMatrixGeneral,
            DiffusionMatrixKoalaBear,
            &mut rng,
        );

        let input: [F; 24] = rng.gen();

        let mut expected = input;
        poseidon2.permute_mut(&mut expected);

        let mut neon_input = input.map(PackedKoalaBearNeon::from_f);
        poseidon2.permute_mut(&mut neon_input);

        let neon_output = neon_input.map(|x| x.0[0]);

        assert_eq!(neon_output, expected);
    }
}
