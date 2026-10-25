//go:build !icicle

package sp1

// Lean loading for the on-device prover: the proving key's point arrays are mapped from groth16_pk.bin, and the R1CS is
// read from a copy without its debug info and with its call data mapped from a raw file. The prover reads neither the
// debug info (~2.4 GB on the heap) nor writes the keys, so the proof is the same; the heap shrinks from ~19 GB to ~5 GB.
// The lean copy lives in <circuits>/lean-<version>/ (lean.r1cs + lean.calldata) and is written on first use.

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"syscall"
	"unsafe"

	"github.com/consensys/gnark-crypto/ecc"
	curve "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr/pedersen"
	"github.com/consensys/gnark/backend/groth16"
	groth16_bn254 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/constraint"
	cs "github.com/consensys/gnark/constraint/bn254"
)

func leanEnabled() bool { return os.Getenv("SP1_GNARK_LEAN") != "0" }

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	k, err := c.r.Read(p)
	c.n += int64(k)
	return k, err
}

func mmapFile(path string, writable bool) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	prot, flags := syscall.PROT_READ, syscall.MAP_SHARED
	if writable {
		prot, flags = syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_PRIVATE
	}
	return syscall.Mmap(int(f.Fd()), 0, int(st.Size()), prot, flags)
}

func mmapSlice[E any](m []byte, off *int64) []E {
	n := binary.LittleEndian.Uint64(m[*off : *off+8])
	*off += 8
	if n == 0 {
		return []E{}
	}
	var e E
	s := unsafe.Slice((*E)(unsafe.Pointer(&m[*off])), n)
	*off += int64(n) * int64(unsafe.Sizeof(e))
	return s
}

// loadPkMmap reads groth16_pk.bin's header as ProvingKey.ReadDump does and maps its point slices.
func loadPkMmap(path string) (*groth16_bn254.ProvingKey, error) {
	m, err := mmapFile(path, true)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	pk := &groth16_bn254.ProvingKey{}
	cr := &countingReader{r: bufio.NewReaderSize(f, 1<<16)}
	var marker [8]byte
	if _, err := io.ReadFull(cr, marker[:]); err != nil {
		return nil, err
	}
	if _, err := pk.Domain.ReadFrom(cr); err != nil {
		return nil, fmt.Errorf("domain: %w", err)
	}
	dec := curve.NewDecoder(cr, curve.NoSubgroupChecks())
	var nbWires uint64
	var nbCommitments uint32
	for i, v := range []interface{}{&pk.G1.Alpha, &pk.G1.Beta, &pk.G1.Delta, &pk.G2.Beta, &pk.G2.Delta, &nbWires, &pk.NbInfinityA, &pk.NbInfinityB} {
		if err := dec.Decode(v); err != nil {
			return nil, fmt.Errorf("field %d: %w", i, err)
		}
	}
	pk.InfinityA = make([]bool, nbWires)
	pk.InfinityB = make([]bool, nbWires)
	if err := dec.Decode(&pk.InfinityA); err != nil {
		return nil, err
	}
	if err := dec.Decode(&pk.InfinityB); err != nil {
		return nil, err
	}
	if err := dec.Decode(&nbCommitments); err != nil {
		return nil, err
	}
	off := cr.n
	pk.G1.A = mmapSlice[curve.G1Affine](m, &off)
	pk.G1.B = mmapSlice[curve.G1Affine](m, &off)
	pk.G1.Z = mmapSlice[curve.G1Affine](m, &off)
	pk.G1.K = mmapSlice[curve.G1Affine](m, &off)
	pk.G2.B = mmapSlice[curve.G2Affine](m, &off)
	for i := 0; i < int(nbCommitments); i++ {
		var ck pedersen.ProvingKey
		ck.Basis = mmapSlice[curve.G1Affine](m, &off)
		ck.BasisExpSigma = mmapSlice[curve.G1Affine](m, &off)
		pk.CommitmentKeys = append(pk.CommitmentKeys, ck)
	}
	if off != int64(len(m)) {
		return nil, fmt.Errorf("mapped %d of %d bytes: layout mismatch", off, len(m))
	}
	return pk, nil
}

// loadLeanR1CS returns the circuit with its call data mapped, writing the lean copy from groth16_circuit.bin first if needed.
func loadLeanR1CS(dataDir string) (constraint.ConstraintSystem, error) {
	dir := filepath.Join(filepath.Dir(dataDir), "lean-"+filepath.Base(dataDir))
	body, raw := filepath.Join(dir, "lean.r1cs"), filepath.Join(dir, "lean.calldata")
	if _, err := os.Stat(body); err != nil {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		full := groth16.NewCS(ecc.BN254)
		rf, err := os.Open(filepath.Join(dataDir, groth16CircuitPath))
		if err != nil {
			return nil, err
		}
		if _, err := full.ReadFrom(bufio.NewReaderSize(rf, 1<<20)); err != nil {
			return nil, err
		}
		rf.Close()
		c := full.(*cs.R1CS)
		c.DebugInfo, c.MDebug = nil, map[int]int{}
		cd := c.CallData
		if err := os.WriteFile(raw+".tmp", unsafe.Slice((*byte)(unsafe.Pointer(&cd[0])), len(cd)*4), 0o644); err != nil {
			return nil, err
		}
		c.CallData = []uint32{}
		bf, err := os.Create(body + ".tmp")
		if err != nil {
			return nil, err
		}
		w := bufio.NewWriterSize(bf, 1<<20)
		if _, err := c.WriteTo(w); err != nil {
			return nil, err
		}
		w.Flush()
		bf.Close()
		os.Rename(raw+".tmp", raw)
		os.Rename(body+".tmp", body)
		full, c, cd = nil, nil, nil
		runtime.GC()
		debug.FreeOSMemory()
	}
	r := groth16.NewCS(ecc.BN254)
	bf, err := os.Open(body)
	if err != nil {
		return nil, err
	}
	defer bf.Close()
	if _, err := r.ReadFrom(bufio.NewReaderSize(bf, 1<<20)); err != nil {
		return nil, err
	}
	m, err := mmapFile(raw, false)
	if err != nil {
		return nil, err
	}
	r.(*cs.R1CS).CallData = unsafe.Slice((*uint32)(unsafe.Pointer(&m[0])), len(m)/4)
	return r, nil
}
