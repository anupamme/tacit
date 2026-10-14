// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {RLPReader} from "../src/lib/trie/RLPReader.sol";
import {MockPrecision} from "./MockPrecision.sol";
import {TacMockV1} from "./TacMockV1.sol";

/// Exposes the base oracle's header check.
contract TacHeaderGuardHarness is TacIntervalOracle {
    constructor(address pool) TacIntervalOracle(pool, 25, 1_800, 3_600, 3_600, 6_600) {}

    function spot() public pure override returns (uint256) {
        return 1;
    }

    function slots() public pure override returns (bytes32, bytes32) {
        return (bytes32(0), bytes32(0));
    }

    function _read(uint256 a, uint256 b) internal pure override returns (uint256, uint256) {
        return (a, b);
    }

    function check(bytes calldata header) external view returns (uint256 fields) {
        fields = _header(header).length;
    }
}

/// The header-shape check in TacIntervalOracle (stateRoot and mixHash 32 bytes, nonce 8 bytes, at least 15 fields) and
/// `record` with real data, all offline: the repo's real mainnet headers and `eth_getProof` output
/// (test/fixtures/tac-block-oracle and tac-amm-oracle) are made the chain's blocks with `vm.setBlockhash`, so no fork
/// is needed. A header whose fields sit elsewhere is refused even when its hash matches the chain's.
contract TacHeadersTest is Test {
    address constant V1 = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant PRECISION = 0x0155358241411dB868BA714aE7c83A27087e3D6E;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    bytes32 constant ETH_ASSET = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    bytes32 constant POOL_ID = 0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00;
    uint256 constant LATEST = 1047341;
    uint256 constant COUNT = 14;
    uint256 constant STEP = 25;

    TacBlockOracle prec;
    TacAmmOracle amm;
    TacHeaderGuardHarness harness;

    function setUp() public {
        // The Precision pool and the confidential pool as far as the oracles' constructors look at them.
        MockPrecision mock = new MockPrecision(TAC, 3_779_257_685_557_097_674, 3_779_257_685_557_097_674_402, 1, 1, 1);
        vm.etch(PRECISION, address(mock).code);
        TacMockV1 v1 = new TacMockV1();
        vm.etch(V1, address(v1).code);
        TacMockV1(V1).setAsset(ETH_ASSET, address(0), 1e10);
        TacMockV1(V1).setAsset(TAC_ASSET, TAC, 1e10);
        TacMockV1(V1).setPool(POOL_ID, ETH_ASSET, TAC_ASSET, 1, 1);
        vm.roll(26_183_554);
        prec = new TacBlockOracle(PRECISION, TAC, STEP, 1_800, 3_600, 3_600, 6_600);
        amm = new TacAmmOracle(V1, POOL_ID, ETH_ASSET, TAC_ASSET, TAC, 74, STEP, 1_800, 3_600, 3_600, 6_600);
        harness = new TacHeaderGuardHarness(PRECISION);
    }

    struct Fx {
        uint256 number;
        bytes header;
        bytes next;
        bytes[] account;
        bytes[] a;
        bytes[] b;
    }

    function _fx(string memory dir, uint256 interval) internal view returns (Fx memory f) {
        string memory json = vm.readFile(string.concat("test/fixtures/", dir, "/", vm.toString(interval), ".json"));
        f.number = vm.parseJsonUint(json, ".number");
        f.header = vm.parseJsonBytes(json, ".header");
        f.next = vm.parseJsonBytes(json, ".next");
        f.account = vm.parseJsonBytesArray(json, ".accountProof");
        if (vm.keyExistsJson(json, ".proofA")) {
            f.a = vm.parseJsonBytesArray(json, ".proofA");
            f.b = vm.parseJsonBytesArray(json, ".proofB");
        } else {
            f.a = vm.parseJsonBytesArray(json, ".reservesProof");
            f.b = vm.parseJsonBytesArray(json, ".supplyProof");
        }
    }

    // Makes `header` the chain's block `number`.
    function _chain(uint256 number, bytes memory header) internal {
        vm.setBlockhash(number, keccak256(header));
    }

    function _nextNumber(Fx memory f) internal pure returns (uint256) {
        return (f.number / 25 + 1) * 25;
    }

    // ───── real headers ─────

    /// All 14 real header pairs of each venue pass the shape check and record, within a gas bound.

    function test_realMainnetHeadersRecordOnBothVenues() public {
        for (uint256 i; i < COUNT; ++i) {
            Fx memory p = _fx("tac-block-oracle", LATEST - i);
            // BLOCKHASH reaches 256 blocks; the oldest fixtures are further back than that from the fork block.
            vm.roll(p.number + 100);
            _chain(p.number, p.header);
            _chain(_nextNumber(p), p.next);
            uint256 g = gasleft();
            prec.record(p.header, p.next, p.account, p.a, p.b);
            g -= gasleft();
            if (i == 0) console2.log("Precision record() gas, real proofs:", g);
            assertLt(g, 1_000_000);
            (uint256 price, uint256 depth) = prec.sampleOf(LATEST - i);
            assertGt(price, 0);
            assertGt(depth, 1e18);

            Fx memory q = _fx("tac-amm-oracle", LATEST - i);
            _chain(q.number, q.header);
            _chain(_nextNumber(q), q.next);
            g = gasleft();
            amm.record(q.header, q.next, q.account, q.a, q.b);
            g -= gasleft();
            if (i == 0) console2.log("AMM record() gas, real proofs:", g);
            assertLt(g, 1_000_000);
            (price, depth) = amm.sampleOf(LATEST - i);
            assertGt(price, 0);
            assertGt(depth, 1e18);
        }
    }

    // ───── shifted headers ─────

    function _items(bytes memory header) internal pure returns (bytes[] memory raw) {
        RLPReader.RLPItem[] memory it = RLPReader.readList(header);
        raw = new bytes[](it.length);
        for (uint256 i; i < it.length; ++i) {
            raw[i] = RLPReader.readRawBytes(it[i]);
        }
    }

    function _list(bytes[] memory raw, uint256 skipIndex, uint256 insertAt, bytes memory insert)
        internal
        pure
        returns (bytes memory out)
    {
        bytes memory payload;
        for (uint256 i; i < raw.length; ++i) {
            if (insert.length != 0 && i == insertAt) payload = bytes.concat(payload, insert);
            if (i != skipIndex) payload = bytes.concat(payload, raw[i]);
        }
        out = bytes.concat(bytes1(0xf9), bytes2(uint16(payload.length)), payload);
    }

    function _truncate(bytes[] memory raw, uint256 keep) internal pure returns (bytes memory out) {
        bytes memory payload;
        for (uint256 i; i < keep; ++i) {
            payload = bytes.concat(payload, raw[i]);
        }
        out = bytes.concat(bytes1(0xf9), bytes2(uint16(payload.length)), payload);
    }

    function _refused(bytes memory header, uint256 number) internal {
        _chain(number, header);
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        harness.check(header);
    }

    /// Fewer than 15 fields, or a stateRoot, mixHash or nonce of the wrong size or in the wrong place, is refused.
    function test_aHeaderWhoseFieldsAreShiftedIsRefused() public {
        Fx memory f = _fx("tac-block-oracle", LATEST);
        bytes[] memory raw = _items(f.header);
        assertGe(raw.length, 15, "a real header has at least 15 fields");
        assertEq(raw[3].length, 33, "stateRoot");
        assertEq(raw[13].length, 33, "mixHash");
        assertEq(raw[14].length, 9, "nonce");

        // The real header is accepted.
        _chain(f.number, f.header);
        harness.check(f.header);

        // 14 fields (nothing after mixHash).
        _refused(_truncate(raw, 14), f.number);
        // Fewer fields.
        _refused(_truncate(raw, 10), f.number);
        // extraData removed: mixHash moves to field 12, nonce to 13.
        _refused(_list(raw, 12, 0, ""), f.number);
        // An extra 32-byte field inserted before mixHash: field 13 is 32 bytes but field 14 is no longer the 8-byte
        // nonce, so the RANDAO value cannot be read from the wrong field.
        bytes memory builder = bytes.concat(bytes1(0xa0), bytes32(uint256(0xB011DE12)));
        _refused(_list(raw, type(uint256).max, 13, builder), f.number);
        // A 31-byte "stateRoot".
        bytes memory short = bytes.concat(bytes1(0x9f), new bytes(31));
        bytes[] memory r2 = _items(f.header);
        r2[3] = short;
        _refused(_list(r2, type(uint256).max, 0, ""), f.number);
        // A 32-byte "nonce".
        bytes[] memory r3 = _items(f.header);
        r3[14] = bytes.concat(bytes1(0xa0), bytes32(uint256(7)));
        _refused(_list(r3, type(uint256).max, 0, ""), f.number);
    }

    /// `record` refuses the shifted header before it reads anything from it.
    function test_recordRefusesAShiftedHeaderEvenWithAMatchingHash() public {
        Fx memory f = _fx("tac-block-oracle", LATEST);
        bytes[] memory raw = _items(f.header);
        bytes memory shifted = _list(raw, 12, 0, "");
        _chain(f.number, shifted);
        _chain(_nextNumber(f), f.next);
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        prec.record(shifted, f.next, f.account, f.a, f.b);
        // The same with the shifted header as the following block.
        bytes memory shiftedNext = _list(_items(f.next), 12, 0, "");
        _chain(f.number, f.header);
        _chain(_nextNumber(f), shiftedNext);
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        prec.record(f.header, shiftedNext, f.account, f.a, f.b);
    }

    /// The header of a local anvil chain on Prague (test/fixtures/headers/anvil-prague-header.json) has the same shape
    /// as mainnet's: 21 fields, an 8-byte zero nonce and a 32-byte mixHash.
    function test_aLocalPragueChainHeaderIsAccepted() public {
        string memory json = vm.readFile("test/fixtures/headers/anvil-prague-header.json");
        bytes memory header = vm.parseJsonBytes(json, ".header");
        uint256 number = vm.parseJsonUint(json, ".number");
        assertEq(keccak256(header), vm.parseJsonBytes32(json, ".hash"), "the fixture is the block's real header");
        vm.setBlockhash(number, keccak256(header));
        vm.roll(number + 10);
        assertGe(harness.check(header), 15);
    }
}
