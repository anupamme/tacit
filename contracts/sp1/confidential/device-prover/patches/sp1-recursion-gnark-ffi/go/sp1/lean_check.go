//go:build !icicle

package sp1

// CheckLean is the lean prover's self-test for `tacit-prover check`: a small circuit with a BSB22 commitment (as SP1's
// has) proved by proveLean with its multi-exponentiations in blocks of 0 (one), 1, 7 and 64 bases on a key whose domain
// has no tables (as the lean loader leaves it), each proof verified by gnark's verifier and a changed proof refused; and
// blocked multi-exponentiations on G1 and G2, and on a Mac the GPU's G1 one, equal to gnark's whole ones.

import (
	"fmt"
	"os"

	"github.com/consensys/gnark-crypto/ecc"
	curve "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr/fft"
	"github.com/consensys/gnark/backend/groth16"
	groth16_bn254 "github.com/consensys/gnark/backend/groth16/bn254"
	cs "github.com/consensys/gnark/constraint/bn254"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

type leanCheckCircuit struct {
	X, Y, W frontend.Variable
	Z       frontend.Variable `gnark:",public"`
}

func (c *leanCheckCircuit) Define(api frontend.API) error {
	api.AssertIsEqual(api.Mul(c.X, c.Y), c.Z)
	cm, err := api.(frontend.Committer).Commit(c.X, c.Y, c.W)
	if err != nil {
		return err
	}
	w := c.W
	for i := 0; i < 300; i++ {
		w = api.Add(api.Mul(w, w), cm)
	}
	api.AssertIsDifferent(w, 0)
	return nil
}

func CheckLean() error {
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &leanCheckCircuit{})
	if err != nil {
		return err
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		return err
	}
	full, err := frontend.NewWitness(&leanCheckCircuit{X: 3, Y: 5, W: 7, Z: 15}, ecc.BN254.ScalarField())
	if err != nil {
		return err
	}
	pub, err := full.Public()
	if err != nil {
		return err
	}
	bpk := pk.(*groth16_bn254.ProvingKey)
	bpk.Domain = *fft.NewDomain(bpk.Domain.Cardinality, fft.WithoutPrecompute())
	defer os.Unsetenv("SP1_GNARK_MSM_BLOCK")
	for _, block := range []string{"0", "1", "7", "64"} {
		os.Setenv("SP1_GNARK_MSM_BLOCK", block)
		proof, err := proveLean(ccs.(*cs.R1CS), bpk, full, func(p *groth16_bn254.Proof) error { return groth16.Verify(p, vk, pub) })
		if err != nil {
			return fmt.Errorf("blocks of %s: %w", block, err)
		}
		if err := groth16.Verify(proof, vk, pub); err != nil {
			return fmt.Errorf("blocks of %s: the proof does not verify: %w", block, err)
		}
		bad := *proof
		bad.Krs.Add(&bad.Krs, &bad.Ar)
		if groth16.Verify(&bad, vk, pub) == nil {
			return fmt.Errorf("blocks of %s: a changed proof verified", block)
		}
	}
	sc := make([]fr.Element, 1000)
	for i := range sc {
		sc[i].SetRandom()
	}
	_, _, g1, g2 := curve.Generators()
	b1 := curve.BatchScalarMultiplicationG1(&g1, sc)
	b2 := curve.BatchScalarMultiplicationG2(&g2, sc)
	var w1 curve.G1Jac
	var w2 curve.G2Jac
	w1.MultiExp(b1, sc, ecc.MultiExpConfig{})
	w2.MultiExp(b2, sc, ecc.MultiExpConfig{})
	if gpuMsmReady() {
		var g curve.G1Jac
		err := gpuMsmG1(&g, b1, sc)
		gpuMsmRelease()
		if err != nil || !g.Equal(&w1) {
			return fmt.Errorf("the GPU's G1 multi-exponentiation is not gnark's (%v)", err)
		}
	}
	for _, block := range []int{1, 3, 64, 999, 1000} {
		var g curve.G1Jac
		var h curve.G2Jac
		if err := msmG1(&g, b1, sc, block); err != nil || !g.Equal(&w1) {
			return fmt.Errorf("G1 multi-exponentiation in blocks of %d is not the whole one (%v)", block, err)
		}
		if err := msmG2(&h, b2, sc, block); err != nil || !h.Equal(&w2) {
			return fmt.Errorf("G2 multi-exponentiation in blocks of %d is not the whole one (%v)", block, err)
		}
	}
	return nil
}
