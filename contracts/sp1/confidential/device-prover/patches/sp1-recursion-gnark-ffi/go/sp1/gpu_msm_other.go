//go:build !darwin && !icicle

package sp1

// No GPU path off macOS: the Groth16 step's multi-exponentiations stay on the CPU (gpu_msm_darwin.go).

import (
	"fmt"

	curve "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
)

func gpuMsmReady() bool                  { return false }
func gpuMsmOff(string)                   {}
func gpuMsmCanary([]curve.G1Affine) bool { return false }
func gpuMsmG1(*curve.G1Jac, []curve.G1Affine, []fr.Element) error {
	return fmt.Errorf("no GPU path on this platform")
}
