// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {MerkleTrie} from "../src/lib/trie/MerkleTrie.sol";

/// Shared pieces of the TacOracle* suites: the trie library behind an external call, a venue whose price and depth are
/// its two proven slot values, a venue with a relaxed `depthMin` rule, and the fixture reader.

contract TacOracleTrieHarness {
    function get(bytes memory key, bytes[] memory proof, bytes32 root) external pure returns (bytes memory) {
        return MerkleTrie.get(key, proof, root);
    }
}

/// A venue at the Precision pool's two slots whose "price" and "depth" are the proven values themselves (reduced to fit
/// the packing), with direct access to the ring.
contract TacOracleStub is TacIntervalOracle {
    constructor(address pool, uint256 step, uint256 short, uint256 window, uint256 max, uint256 coverageBps)
        TacIntervalOracle(pool, step, short, window, max, coverageBps)
    {}

    function spot() public pure override returns (uint256) {
        return 0;
    }

    function slots() public pure override returns (bytes32, bytes32) {
        return (bytes32(0), bytes32(uint256(0x05345cdf77eb68f44c)));
    }

    function _read(uint256 a, uint256 b) internal pure override returns (uint256, uint256) {
        return (a % (1 << 100) + 1, b % (1 << 100));
    }

    /// The number of fields of a header that passes the layout check and the hash check.
    function headerFields(bytes calldata h) external view returns (uint256) {
        return _header(h).length;
    }

    function put(uint256 interval, uint256 price, uint256 depth) external {
        _samples[interval % RING] = interval << 208 | price << 104 | depth;
    }

    function clearRing() external {
        for (uint256 i; i < RING; ++i) {
            _samples[i] = 0;
        }
    }
}

/// A venue whose `depthMinVariant(window)` applies one of several rules after the shared collection step:
/// 0 = every interval recorded (the contract's rule), 1 = none, 2 = one missing tolerated, 3 = half suffices,
/// 4 = never refuses, 5 = exactly one missing required, 6 = only an empty window refused, 7 = `n < points - 1`.
contract TacOracleDepthMinVariants is TacOracleStub {
    uint256 internal immutable VARIANT;

    constructor(address pool, uint256 variant) TacOracleStub(pool, 50, 3600, 10_800, 21_600, 6_600) {
        VARIANT = variant;
    }

    function depthMinVariant(uint256 window) external view returns (uint256) {
        (uint256[] memory found, uint256 n, uint256 points) = _collect(window, false);
        uint256 v = VARIANT;
        if (v == 0 && n != points) revert TooFewSamples();
        if (v == 2 && n + 1 < points) revert TooFewSamples();
        if (v == 3 && n * 2 < points) revert TooFewSamples();
        if (v == 5 && n != points - 1) revert TooFewSamples();
        if (v == 6 && n == 0) revert TooFewSamples();
        if (v == 7 && n < points - 1) revert TooFewSamples();
        _sort(found, n);
        return found[0];
    }
}

/// Reads the JSON fixtures of test/fixtures/trie: synthetic chains built by an independent Merkle-Patricia builder
/// (a header, its following header, and the account and storage proofs of the Precision pool's two slots), and real
/// mainnet headers.
abstract contract TacOracleFixtures is Test {
    address constant POOL = 0x0155358241411dB868BA714aE7c83A27087e3D6E;
    string constant DIR = "test/fixtures/trie/";

    TacOracleStub oracle;
    TacOracleTrieHarness trie;

    struct Rec {
        string shape;
        uint256 interval;
        uint256 number;
        uint256 nextNumber;
        bytes header;
        bytes next;
        bytes[] account;
        bytes[] proofA;
        bytes[] proofB;
        bytes aVal;
        bytes bVal;
        bytes[] absentProof;
        bytes[] otherAccountProof;
    }

    function setUp() public virtual {
        vm.etch(POOL, hex"fe");
        oracle = new TacOracleStub(POOL, 50, 3600, 10_800, 21_600, 6_600);
        trie = new TacOracleTrieHarness();
    }

    function _rec(uint256 i) internal view returns (Rec memory r) {
        string memory json = vm.readFile(string.concat(DIR, "record-cases.json"));
        string memory p = string.concat(".cases[", vm.toString(i), "].");
        r.shape = vm.parseJsonString(json, string.concat(p, "shape"));
        r.interval = vm.parseJsonUint(json, string.concat(p, "interval"));
        r.number = vm.parseJsonUint(json, string.concat(p, "number"));
        r.nextNumber = vm.parseJsonUint(json, string.concat(p, "nextNumber"));
        r.header = vm.parseJsonBytes(json, string.concat(p, "header"));
        r.next = vm.parseJsonBytes(json, string.concat(p, "next"));
        r.account = vm.parseJsonBytesArray(json, string.concat(p, "account"));
        r.proofA = vm.parseJsonBytesArray(json, string.concat(p, "proofA"));
        r.proofB = vm.parseJsonBytesArray(json, string.concat(p, "proofB"));
        r.aVal = vm.parseJsonBytes(json, string.concat(p, "a"));
        r.bVal = vm.parseJsonBytes(json, string.concat(p, "b"));
        r.absentProof = vm.parseJsonBytesArray(json, string.concat(p, "absentProof"));
        r.otherAccountProof = vm.parseJsonBytesArray(json, string.concat(p, "otherAccountProof"));
    }

    function _recCount() internal view returns (uint256 n) {
        string memory json = vm.readFile(string.concat(DIR, "record-cases.json"));
        while (vm.keyExistsJson(json, string.concat(".cases[", vm.toString(n), "]"))) {
            ++n;
        }
    }

    function _u(bytes memory b) internal pure returns (uint256 v) {
        for (uint256 i; i < b.length; ++i) {
            v = v << 8 | uint8(b[i]);
        }
    }

    /// Rolls to the block after the following block's and sets the two headers' hashes as the chain's.
    function _prepare(Rec memory r) internal {
        vm.roll(r.nextNumber + 3);
        vm.setBlockhash(r.number, keccak256(r.header));
        vm.setBlockhash(r.nextNumber, keccak256(r.next));
    }

    function _tryRecord(bytes memory h, bytes memory n, bytes[] memory acct, bytes[] memory pa, bytes[] memory pb)
        internal
        returns (bool ok)
    {
        try oracle.record(h, n, acct, pa, pb) {
            return true;
        } catch {
            return false;
        }
    }

    function _flip(bytes memory b, uint256 seed) internal pure returns (bytes memory c) {
        c = b;
        uint256 i = seed % c.length;
        c[i] = bytes1(uint8(c[i]) ^ uint8(1 << (seed >> 8) % 8));
    }

    function _copy(bytes[] memory a) internal pure returns (bytes[] memory c) {
        c = new bytes[](a.length);
        for (uint256 i; i < a.length; ++i) {
            c[i] = a[i];
        }
    }

    /// One structural change of a proof, by kind: 0 flip a bit in a node, 1 drop a node, 2 duplicate a node, 3 swap two
    /// adjacent nodes, 4 append the last node again, 5 drop the last node, 6 reverse.
    function _mutate(bytes[] memory a, uint256 kind, uint256 seed) internal pure returns (bytes[] memory c) {
        uint256 n = a.length;
        uint256 i = seed % n;
        if (kind == 0) {
            c = _copy(a);
            c[i] = _flip(abi.encodePacked(a[i]), seed >> 16);
        } else if (kind == 1) {
            c = new bytes[](n - 1);
            for (uint256 j; j < n - 1; ++j) {
                c[j] = a[j < i ? j : j + 1];
            }
        } else if (kind == 2) {
            c = new bytes[](n + 1);
            for (uint256 j; j < n + 1; ++j) {
                c[j] = a[j <= i ? j : j - 1];
            }
        } else if (kind == 3 && n > 1) {
            c = _copy(a);
            uint256 k = i == n - 1 ? n - 2 : i;
            (c[k], c[k + 1]) = (c[k + 1], c[k]);
        } else if (kind == 4) {
            c = new bytes[](n + 1);
            for (uint256 j; j < n; ++j) {
                c[j] = a[j];
            }
            c[n] = a[n - 1];
        } else if (kind == 5) {
            c = new bytes[](n - 1);
            for (uint256 j; j < n - 1; ++j) {
                c[j] = a[j];
            }
        } else {
            c = new bytes[](n);
            for (uint256 j; j < n; ++j) {
                c[j] = a[n - 1 - j];
            }
        }
    }
}
