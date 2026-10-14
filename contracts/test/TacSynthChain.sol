// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";

/// Helpers that run `TacIntervalOracle.record` end to end with no network: a venue over the real base contract, an
/// EIP-2935 history stub and a builder of a synthetic chain (RLP headers, a one-account state trie and a two-slot
/// storage trie). Import `SynthChain` and call `_build`, `_register`, `_headerRlp` and `_headerShaped`.

/// A venue over the real TacIntervalOracle base: the two proven slots ARE the price and the depth, so a test controls
/// exactly what `record` stores. Everything else (header and block-hash checks, the account and storage proofs, the
/// ring, the medians) is the shipped base-class code.
contract SynthOracle is TacIntervalOracle {
    uint256 public spotValue;

    constructor(address pool, uint256 step, uint256 shortWindow, uint256 window, uint256 maxWindow, uint256 cov)
        TacIntervalOracle(pool, step, shortWindow, window, maxWindow, cov)
    {}

    function setSpot(uint256 s) external {
        spotValue = s;
    }

    function spot() public view override returns (uint256) {
        return spotValue;
    }

    // keccak256(abi.encode(1)) starts with nibble b, keccak256(abi.encode(2)) with nibble 4: a two-leaf trie is a branch.
    function slots() public pure override returns (bytes32, bytes32) {
        return (bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function _read(uint256 a, uint256 b) internal pure override returns (uint256, uint256) {
        return (a, b);
    }
}

contract SynthHistory {
    fallback() external {
        assembly {
            mstore(0, calldataload(0))
            mstore(0x20, 0)
            mstore(0, sload(keccak256(0, 0x40)))
            return(0, 0x20)
        }
    }
}

/// A chain that exists only in a test: real RLP headers (hashes registered for BLOCKHASH or the EIP-2935 contract),
/// a real one-account state trie and a real two-slot storage trie, so `record` runs end to end on prices the test picks.
abstract contract SynthChain is Test {
    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    address internal constant POOL = address(0x000000000000000000000000000000000000c0DE);
    uint256 internal constant STEP = 50;

    // ───── RLP ─────
    function _trim(uint256 v) internal pure returns (bytes memory out) {
        uint256 n;
        for (uint256 t = v; t != 0; t >>= 8) {
            ++n;
        }
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[n - 1 - i] = bytes1(uint8(v >> (8 * i)));
        }
    }

    function _prefix(uint256 len, uint8 off) internal pure returns (bytes memory) {
        if (len < 56) return abi.encodePacked(uint8(off + len));
        bytes memory l = _trim(len);
        return bytes.concat(bytes1(uint8(off + 55 + l.length)), l);
    }

    function _str(bytes memory b) internal pure returns (bytes memory) {
        if (b.length == 1 && uint8(b[0]) < 0x80) return b;
        return bytes.concat(_prefix(b.length, 0x80), b);
    }

    function _list(bytes memory payload) internal pure returns (bytes memory) {
        return bytes.concat(_prefix(payload.length, 0xc0), payload);
    }

    // ───── tries ─────
    function _leaf(bytes32 key, uint256 skipNibbles, bytes memory valueField) internal pure returns (bytes memory) {
        // path = nibbles of `key` after the first `skipNibbles`
        uint256 rest = 64 - skipNibbles;
        bytes memory path;
        if (rest % 2 == 0) {
            path = new bytes(1 + rest / 2);
            path[0] = 0x20;
            for (uint256 i; i < rest / 2; ++i) {
                path[1 + i] = bytes1(_byteAtNibble(key, skipNibbles + 2 * i));
            }
        } else {
            path = new bytes(1 + (rest - 1) / 2);
            path[0] = bytes1(uint8(0x30 | _nibble(key, skipNibbles)));
            for (uint256 i; i < (rest - 1) / 2; ++i) {
                path[1 + i] = bytes1(_byteAtNibble(key, skipNibbles + 1 + 2 * i));
            }
        }
        return _list(bytes.concat(_str(path), _str(valueField)));
    }

    function _nibble(bytes32 k, uint256 i) internal pure returns (uint8) {
        uint8 b = uint8(k[i / 2]);
        return i % 2 == 0 ? b >> 4 : b & 0x0f;
    }

    function _byteAtNibble(bytes32 k, uint256 i) internal pure returns (uint8) {
        return (_nibble(k, i) << 4) | _nibble(k, i + 1);
    }

    /// The header and proofs for the sample block of `interval`, where the proven slots hold `a` and `b`.
    struct Rec {
        bytes header;
        bytes next;
        bytes[] account;
        bytes[] proofA;
        bytes[] proofB;
        uint256 number;
    }

    function _build(uint256 interval, uint256 offset, uint256 a, uint256 b, bytes32 slotA, bytes32 slotB)
        internal
        pure
        returns (Rec memory r)
    {
        bytes32 keyA = keccak256(abi.encode(slotA));
        bytes32 keyB = keccak256(abi.encode(slotB));
        require(_nibble(keyA, 0) != _nibble(keyB, 0), "slots must split at the first nibble");
        bytes memory leafA = _leaf(keyA, 1, _str(_trim(a)));
        bytes memory leafB = _leaf(keyB, 1, _str(_trim(b)));
        bytes memory branch = _branch(_nibble(keyA, 0), leafA, _nibble(keyB, 0), leafB);
        bytes32 storageRoot = keccak256(branch);
        bytes memory account = _list(
            bytes.concat(
                _str(""), _str(""), _str(abi.encodePacked(storageRoot)), _str(abi.encodePacked(keccak256(hex"00")))
            )
        );
        bytes32 poolKey = keccak256(abi.encodePacked(POOL));
        bytes memory accountLeaf = _leaf(poolKey, 0, account);
        r.number = interval * STEP + offset;
        r.header = _headerRlp(r.number, keccak256(accountLeaf), bytes32(0));
        r.next = _headerRlp((interval + 1) * STEP, bytes32(0), bytes32(offset));
        r.account = new bytes[](1);
        r.account[0] = accountLeaf;
        r.proofA = new bytes[](2);
        r.proofA[0] = branch;
        r.proofA[1] = leafA;
        r.proofB = new bytes[](2);
        r.proofB[0] = branch;
        r.proofB[1] = leafB;
    }

    function _branch(uint8 n1, bytes memory c1, uint8 n2, bytes memory c2) internal pure returns (bytes memory) {
        bytes memory payload;
        for (uint8 i; i < 16; ++i) {
            if (i == n1) payload = bytes.concat(payload, _str(abi.encodePacked(keccak256(c1))));
            else if (i == n2) payload = bytes.concat(payload, _str(abi.encodePacked(keccak256(c2))));
            else payload = bytes.concat(payload, hex"80");
        }
        return _list(bytes.concat(payload, hex"80"));
    }

    function _headerRlp(uint256 number, bytes32 stateRoot, bytes32 mixHash) internal pure returns (bytes memory) {
        bytes memory head = bytes.concat(
            _str(abi.encodePacked(bytes32(uint256(1)))), // 0 parentHash
            _str(abi.encodePacked(bytes32(uint256(2)))), // 1 ommersHash
            _str(abi.encodePacked(address(0xC01B))), // 2 coinbase
            _str(abi.encodePacked(stateRoot)), // 3
            _str(abi.encodePacked(bytes32(uint256(4)))), // 4 txRoot
            _str(abi.encodePacked(bytes32(uint256(5)))), // 5 receiptsRoot
            _str(new bytes(256)), // 6 bloom
            _str("") // 7 difficulty
        );
        bytes memory tail = bytes.concat(
            _str(_trim(number)), // 8
            _str(_trim(30_000_000)), // 9 gasLimit
            _str(_trim(12_000_000)), // 10 gasUsed
            _str(_trim(1_800_000_000 + number)), // 11 timestamp
            _str(""), // 12 extraData
            _str(abi.encodePacked(mixHash)), // 13 mixHash
            _str(new bytes(8)), // 14 nonce
            _str(_trim(1 gwei)) // 15 baseFee
        );
        return _list(bytes.concat(head, tail));
    }

    /// The layout the oracle insists on: how many fields a header has and how long its stateRoot (3), mixHash (13) and
    /// nonce (14) are. `count` is the number of fields (14 leaves out the nonce, 15 ends with it, 16 adds the base fee).
    struct Shape {
        uint256 count;
        uint256 stateRootLen;
        uint256 mixLen;
        uint256 nonceLen;
    }

    function _today() internal pure returns (Shape memory) {
        return Shape(16, 32, 32, 8);
    }

    function _fit(bytes32 v, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len && i < 32; ++i) {
            out[i] = v[i];
        }
    }

    function _headerShaped(uint256 number, bytes32 stateRoot, bytes32 mixHash, Shape memory sh)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory items = bytes.concat(
            _str(abi.encodePacked(bytes32(uint256(1)))), // 0
            _str(abi.encodePacked(bytes32(uint256(2)))), // 1
            _str(abi.encodePacked(address(0xC01B))), // 2
            _str(_fit(stateRoot, sh.stateRootLen)), // 3
            _str(abi.encodePacked(bytes32(uint256(4)))), // 4
            _str(abi.encodePacked(bytes32(uint256(5)))), // 5
            _str(new bytes(256)), // 6
            _str("") // 7
        );
        items = bytes.concat(
            items,
            _str(_trim(number)), // 8
            _str(_trim(30_000_000)), // 9
            _str(_trim(12_000_000)), // 10
            _str(_trim(1_800_000_000 + number)), // 11
            _str("") // 12
        );
        if (sh.count > 13) items = bytes.concat(items, _str(_fit(mixHash, sh.mixLen))); // 13
        if (sh.count > 14) items = bytes.concat(items, _str(new bytes(sh.nonceLen))); // 14
        for (uint256 i = 15; i < sh.count; ++i) {
            items = bytes.concat(items, _str(_trim(1 gwei + i))); // 15 ...: base fee and later additions
        }
        return _list(items);
    }

    /// As `_headerRlp` with the number field's bytes given as they are (for malformed numbers).
    function _headerRlpRaw(bytes memory numberField, bytes32 stateRoot, bytes32 mixHash)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory head = bytes.concat(
            _str(abi.encodePacked(bytes32(uint256(1)))),
            _str(abi.encodePacked(bytes32(uint256(2)))),
            _str(abi.encodePacked(address(0xC01B))),
            _str(abi.encodePacked(stateRoot)),
            _str(abi.encodePacked(bytes32(uint256(4)))),
            _str(abi.encodePacked(bytes32(uint256(5)))),
            _str(new bytes(256)),
            _str("")
        );
        bytes memory tail = bytes.concat(
            _str(numberField),
            _str(_trim(30_000_000)),
            _str(_trim(12_000_000)),
            _str(_trim(1_800_000_000)),
            _str(""),
            _str(abi.encodePacked(mixHash)),
            _str(new bytes(8)),
            _str(_trim(1 gwei))
        );
        return _list(bytes.concat(head, tail));
    }

    // ───── registering hashes ─────
    function _register(bytes memory header, uint256 number) internal {
        bytes32 h = keccak256(header);
        if (block.number > number && block.number - number <= 256) {
            vm.setBlockhash(number, h);
        } else {
            vm.store(HISTORY, keccak256(abi.encode(number, uint256(0))), h);
        }
    }
}
