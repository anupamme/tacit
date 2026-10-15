// Poseidon over BN254 (circomlib parameters) for the shielded pools: Merkle nodes (2), nullifiers (3), note keys
// and leaves (4), EdDSA challenges (5), and the EVM pool's spend message (7); the mixer pool's nullifier hash (1).
// Its round constants are ~110 KB for these six widths (the package's index would add ~500 KB for the widths nothing uses),
// so they live in this bundle, loaded only by the code that hashes, and the main vendor bundle every page loads first stays small.
// One width at a time, since the package's index loads the constants of every width.
export { poseidon1 } from 'poseidon-lite/poseidon1';
export { poseidon2 } from 'poseidon-lite/poseidon2';
export { poseidon3 } from 'poseidon-lite/poseidon3';
export { poseidon4 } from 'poseidon-lite/poseidon4';
export { poseidon5 } from 'poseidon-lite/poseidon5';
export { poseidon7 } from 'poseidon-lite/poseidon7';
