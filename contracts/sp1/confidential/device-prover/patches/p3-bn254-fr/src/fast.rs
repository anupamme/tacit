//! Montgomery arithmetic for BN254's scalar field on raw limbs, bit-identical to ff_derive's (same modulus, R = 2^256,
//! canonical outputs) and faster: CIOS multiplication in its no-carry form (the modulus's top limb is below 2^63 - 1, so the
//! running sum never needs a fifth word) and branch-light add/sub. Checked against ff_derive in the bench before use.

pub(crate) type L = [u64; 4];

pub(crate) const Q: L = [0x43e1f593f0000001, 0x2833e84879b97091, 0xb85045b68181585d, 0x30644e72e131a029];
const INV: u64 = 0xc2e1f593efffffff; // -Q^-1 mod 2^64
const R2: L = [0x1bb8e645ae216da7, 0x53fe3ab1e35c59e3, 0x8c49833d53bb8085, 0x0216d0b17f4e44a5]; // 2^512 mod Q

#[inline(always)]
fn mac(a: u64, b: u64, c: u64, carry: u64) -> (u64, u64) {
    let t = (a as u128) + (b as u128) * (c as u128) + (carry as u128);
    (t as u64, (t >> 64) as u64)
}

#[inline(always)]
fn adc(a: u64, b: u64, carry: bool) -> (u64, bool) {
    let (s, c1) = a.overflowing_add(b);
    let (s, c2) = s.overflowing_add(carry as u64);
    (s, c1 | c2)
}

#[inline(always)]
fn sbb(a: u64, b: u64, borrow: bool) -> (u64, bool) {
    let (d, b1) = a.overflowing_sub(b);
    let (d, b2) = d.overflowing_sub(borrow as u64);
    (d, b1 | b2)
}

#[inline(always)]
fn sub_q_if_ge(t: L) -> L {
    let (r0, b) = sbb(t[0], Q[0], false);
    let (r1, b) = sbb(t[1], Q[1], b);
    let (r2, b) = sbb(t[2], Q[2], b);
    let (r3, b) = sbb(t[3], Q[3], b);
    if b { t } else { [r0, r1, r2, r3] }
}

#[inline(always)]
pub(crate) fn mul(x: &L, y: &L) -> L {
    let mut t = [0u64; 4];
    for i in 0..4 {
        let (t0, mut a) = mac(t[0], x[0], y[i], 0);
        let m = t0.wrapping_mul(INV);
        let (_, mut c) = mac(t0, m, Q[0], 0);
        for j in 1..4 {
            let (tj, a2) = mac(t[j], x[j], y[i], a);
            a = a2;
            let (tj1, c2) = mac(tj, m, Q[j], c);
            c = c2;
            t[j - 1] = tj1;
        }
        t[3] = c.wrapping_add(a);
    }
    sub_q_if_ge(t)
}

#[inline(always)]
pub(crate) fn add(x: &L, y: &L) -> L {
    let (r0, c) = adc(x[0], y[0], false);
    let (r1, c) = adc(x[1], y[1], c);
    let (r2, c) = adc(x[2], y[2], c);
    let (r3, _) = adc(x[3], y[3], c);
    sub_q_if_ge([r0, r1, r2, r3])
}

#[inline(always)]
pub(crate) fn sub(x: &L, y: &L) -> L {
    let (r0, b) = sbb(x[0], y[0], false);
    let (r1, b) = sbb(x[1], y[1], b);
    let (r2, b) = sbb(x[2], y[2], b);
    let (r3, b) = sbb(x[3], y[3], b);
    if !b {
        return [r0, r1, r2, r3];
    }
    let (s0, c) = adc(r0, Q[0], false);
    let (s1, c) = adc(r1, Q[1], c);
    let (s2, c) = adc(r2, Q[2], c);
    let (s3, _) = adc(r3, Q[3], c);
    [s0, s1, s2, s3]
}

/// Montgomery form of a canonical u64.
#[inline(always)]
pub(crate) fn from_u64(n: u64) -> L {
    mul(&[n, 0, 0, 0], &R2)
}
