// The leaf hash of SP1's outer (wrap) Merkle commitments, one row per thread: a row of KoalaBear values through the
// multi-field sponge (eight values packed per BN254 element, rate 2, Poseidon2 t=3 with x^5, 8 external + 56 internal rounds,
// overwrite mode). BN254 Fr is in Montgomery form (R = 2^256) on eight 32-bit limbs, which Apple GPUs multiply natively; eight
// little-endian u32 limbs are byte-identical to p3-bn254-fr's four u64 limbs, so the digests are its Bn254Fr values.
#include <metal_stdlib>
using namespace metal;

struct F { uint l[8]; };

constant uint Q[8] = {0xf0000001u, 0x43e1f593u, 0x79b97091u, 0x2833e848u, 0x8181585du, 0xb85045b6u, 0xe131a029u, 0x30644e72u};
constant uint INV = 0xefffffffu; // -Q^-1 mod 2^32
constant uint R2[8] = {0xae216da7u, 0x1bb8e645u, 0xe35c59e3u, 0x53fe3ab1u, 0x53bb8085u, 0x8c49833du, 0x7f4e44a5u, 0x0216d0b1u};

inline F sub_q_if_ge(F t) {
    F r; uint borrow = 0;
    for (int i = 0; i < 8; i++) {
        ulong d = (ulong)t.l[i] - (ulong)Q[i] - (ulong)borrow;
        r.l[i] = (uint)d;
        borrow = (uint)(d >> 63);
    }
    return borrow ? t : r;
}

// KoalaBear stores x·2^32 mod p; this is p3-koala-bear's monty_reduce (MU = p^-1 mod 2^32).
inline uint kb_from_monty(uint x) {
    ulong xx = (ulong)x;
    ulong t = (xx * 0x81000001UL) & 0xffffffffUL;
    ulong u = t * 0x7f000001UL;
    ulong d = xx - u;
    uint corr = (xx < u) ? 0x7f000001u : 0u;
    return (uint)(d >> 32) + corr;
}

inline F fmul(F x, F y) {
    uint t[8] = {0, 0, 0, 0, 0, 0, 0, 0};
    for (int i = 0; i < 8; i++) {
        ulong s = (ulong)t[0] + (ulong)x.l[0] * y.l[i];
        uint t0 = (uint)s; uint a = (uint)(s >> 32);
        uint m = t0 * INV;
        ulong u = (ulong)t0 + (ulong)m * Q[0];
        uint c = (uint)(u >> 32);
        for (int j = 1; j < 8; j++) {
            ulong s2 = (ulong)t[j] + (ulong)x.l[j] * y.l[i] + a;
            a = (uint)(s2 >> 32);
            ulong u2 = (ulong)(uint)s2 + (ulong)m * Q[j] + c;
            c = (uint)(u2 >> 32);
            t[j - 1] = (uint)u2;
        }
        t[7] = c + a;
    }
    F o; for (int i = 0; i < 8; i++) o.l[i] = t[i];
    return sub_q_if_ge(o);
}

inline F fadd(F x, F y) {
    F o; uint carry = 0;
    for (int i = 0; i < 8; i++) {
        ulong s = (ulong)x.l[i] + (ulong)y.l[i] + carry;
        o.l[i] = (uint)s; carry = (uint)(s >> 32);
    }
    return sub_q_if_ge(o);
}

inline F pow5(F x) { F x2 = fmul(x, x); F x4 = fmul(x2, x2); return fmul(x4, x); }

inline void external_layer(thread F *s) {
    F sum = fadd(fadd(s[0], s[1]), s[2]);
    s[0] = fadd(s[0], sum); s[1] = fadd(s[1], sum); s[2] = fadd(s[2], sum);
}

inline void permute(thread F *s, constant F *ext, constant F *intc) {
    external_layer(s);
    for (int r = 0; r < 4; r++) {
        for (int i = 0; i < 3; i++) s[i] = pow5(fadd(s[i], ext[r * 3 + i]));
        external_layer(s);
    }
    for (int r = 0; r < 56; r++) {
        s[0] = pow5(fadd(s[0], intc[r]));
        F sum = fadd(fadd(s[0], s[1]), s[2]);
        s[0] = fadd(s[0], sum);
        s[1] = fadd(s[1], sum);
        s[2] = fadd(fadd(s[2], s[2]), sum);
    }
    for (int r = 4; r < 8; r++) {
        for (int i = 0; i < 3; i++) s[i] = pow5(fadd(s[i], ext[r * 3 + i]));
        external_layer(s);
    }
}

kernel void leaf_hash(device const uint *rows [[buffer(0)]],
                      device F *out [[buffer(1)]],
                      constant F *ext [[buffer(2)]],
                      constant F *intc [[buffer(3)]],
                      constant uint &width [[buffer(4)]],
                      constant uint &n [[buffer(5)]],
                      constant uint &monty [[buffer(6)]],
                      uint gid [[thread_position_in_grid]]) {
    if (gid >= n) return;
    device const uint *r = rows + (ulong)gid * width;
    F r2; for (int i = 0; i < 8; i++) r2.l[i] = R2[i];
    F st[3];
    for (int i = 0; i < 3; i++) for (int k = 0; k < 8; k++) st[i].l[k] = 0;
    for (uint b = 0; b < width; b += 16) {
        uint blen = min(16u, width - b);
        for (uint c = 0; c * 8 < blen; c++) {
            uint clen = min(8u, blen - c * 8);
            F acc; for (int k = 0; k < 8; k++) acc.l[k] = 0;
            for (uint k = 0; k < clen; k++) {
                uint x = r[b + c * 8 + k];
                if (monty) x = kb_from_monty(x);
                uint bit = 31 * k, w = bit / 32, o = bit % 32;
                acc.l[w] |= x << o;
                if (o > 1 && w + 1 < 8) acc.l[w + 1] |= x >> (32 - o);
            }
            st[c] = fmul(acc, r2);
        }
        permute(st, ext, intc);
    }
    out[gid] = st[0];
}
