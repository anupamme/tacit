// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {MockPrecision} from "./MockPrecision.sol";

contract OfflineHistory {
    fallback() external {
        assembly {
            mstore(0, calldataload(0))
            mstore(0x20, 0)
            mstore(0, sload(keccak256(0, 0x40)))
            return(0, 0x20)
        }
    }
}

/// Stands in for the confidential pool's `pools` / `assets` reads at the real pool id and asset ids.
contract OfflineV1 {
    bytes32 constant ETH_ASSET = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    bytes32 constant POOL_ID = 0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00;
    address immutable TAC;
    uint256 immutable RA;
    uint256 immutable RB;

    constructor(address tac, uint256 a, uint256 b) {
        (TAC, RA, RB) = (tac, a, b);
    }

    function pools(bytes32 id) external view returns (bool, bytes32, bytes32, uint256, uint256, uint32, uint256) {
        return (id == POOL_ID, ETH_ASSET, TAC_ASSET, RA, RB, 30, 1);
    }

    function assets(bytes32 id) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        if (id == ETH_ASSET) return (true, address(0), 1e10, bytes32(0), false, 18);
        if (id == TAC_ASSET) return (true, TAC, 1e10, bytes32(0), false, 18);
        return (false, address(0), 0, bytes32(0), false, 0);
    }
}

/// The real mainnet proofs of test/fixtures (14 intervals of 25 blocks before block 26,183,554), replayed with no
/// network: BLOCKHASH and the EIP-2935 contract are supplied by the test, the two pools' calls by mocks at their
/// addresses. The expected prices and depths are decoded from the proofs' leaves with the pool formulas re-derived
/// outside Solidity, not computed by the contracts under test.
contract TacOracleOfflineTest is Test {
    address constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    address constant V1 = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant PRECISION = 0x0155358241411dB868BA714aE7c83A27087e3D6E;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    bytes32 constant ETH_ASSET = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    bytes32 constant POOL_ID = 0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00;
    uint256 constant FORK_BLOCK = 26183554;
    uint256 constant LATEST = 1047341;
    uint256 constant STEP = 25;
    uint256 constant COUNT = 14;

    // Independent reference: intervals LATEST-13 .. LATEST-9 (index 0..4) are the first level, the rest the second.
    uint256 constant P_HI = 99947136150757;
    uint256 constant P_LO = 93465104501401;
    uint256 constant D_HI = 3200475165815720081;
    uint256 constant D_LO = 3095347402398597125;
    uint256 constant A_HI = 100701386204657;
    uint256 constant A_LO = 93033596321583;
    uint256 constant AD_HI = 2230360170000000000;
    uint256 constant AD_LO = 2143890070000000000;

    TacBlockOracle precision;
    TacAmmOracle amm;

    struct Fixture {
        uint256 number;
        bytes header;
        bytes next;
        bytes[] account;
        bytes[] a;
        bytes[] b;
    }

    function setUp() public {
        vm.roll(FORK_BLOCK);
        vm.etch(HISTORY, address(new OfflineHistory()).code);
        deployCodeTo(
            "MockPrecision.sol:MockPrecision",
            abi.encode(
                TAC,
                3779257685557097674,
                3779257685557097674402,
                311597728428336321792,
                3012897949528752945,
                31940071679845627500747
            ),
            PRECISION
        );
        deployCodeTo("TacOracleOffline.t.sol:OfflineV1", abi.encode(TAC, 0xcc7510f, 0x2188a791ef0), V1);
        precision = new TacBlockOracle(PRECISION, TAC, STEP, 30 minutes, 1 hours, 1 hours, 6_600);
        amm = new TacAmmOracle(V1, POOL_ID, ETH_ASSET, TAC_ASSET, TAC, 74, STEP, 30 minutes, 1 hours, 1 hours, 6_600);
        for (uint256 i; i < COUNT; ++i) {
            Fixture memory f = _fixture("tac-block-oracle", LATEST - i);
            _seed(f.number, keccak256(f.header));
            _seed((LATEST - i + 1) * STEP, keccak256(f.next));
            f = _fixture("tac-amm-oracle", LATEST - i);
            _seed(f.number, keccak256(f.header));
            _seed((LATEST - i + 1) * STEP, keccak256(f.next));
        }
    }

    // In BLOCKHASH's range: BLOCKHASH; older: the EIP-2935 contract (never both).
    function _seed(uint256 number, bytes32 hash) internal {
        if (block.number - number <= 256) vm.setBlockhash(number, hash);
        else vm.store(HISTORY, keccak256(abi.encode(number, uint256(0))), hash);
    }

    function _fixture(string memory dir, uint256 interval) internal view returns (Fixture memory f) {
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

    function _recordP(uint256 interval) internal {
        Fixture memory f = _fixture("tac-block-oracle", interval);
        precision.record(f.header, f.next, f.account, f.a, f.b);
    }

    function _recordA(uint256 interval) internal {
        Fixture memory f = _fixture("tac-amm-oracle", interval);
        amm.record(f.header, f.next, f.account, f.a, f.b);
    }

    function _recordAll() internal {
        for (uint256 i; i < COUNT; ++i) {
            _recordP(LATEST - i);
            _recordA(LATEST - i);
        }
    }

    /// Every real interval proves and stores exactly the price and depth an independent decode of the leaves gives.
    function test_everyRealIntervalStoresTheIndependentlyDerivedValues() public {
        _recordAll();
        for (uint256 i; i < COUNT; ++i) {
            uint256 k = LATEST - COUNT + 1 + i; // oldest first
            (uint256 p, uint256 d) = precision.sampleOf(k);
            (uint256 ap, uint256 ad) = amm.sampleOf(k);
            if (i < 5) {
                assertEq(p, P_HI, "precision price");
                assertEq(d, D_HI, "precision depth");
                assertEq(ap, A_HI, "amm price");
                assertEq(ad, AD_HI, "amm depth");
            } else {
                assertEq(p, P_LO, "precision price");
                assertEq(d, D_LO, "precision depth");
                assertEq(ap, A_LO, "amm price");
                assertEq(ad, AD_LO, "amm depth");
            }
        }
    }

    function test_spotsAreThePoolFormulas() public view {
        // Precision: (L*1e18/hi + r0) / (L*lo/1e18 + r1) with the mock's reserves; AMM: reserveA / reserveB at 1e10 scale
        uint256 eth = uint256(311597728428336321792) * 1e18 / 3779257685557097674402 + 3012897949528752945;
        uint256 tacSide = uint256(311597728428336321792) * 3779257685557097674 / 1e18 + 31940071679845627500747;
        assertEq(precision.spot(), eth * 1e18 / tacSide);
        assertEq(amm.spot(), uint256(0xcc7510f) * 1e10 * 1e18 / (uint256(0x2188a791ef0) * 1e10));
    }

    function test_theSlotsAreTheRealOnes() public view {
        (bytes32 a, bytes32 b) = precision.slots();
        assertEq(a, bytes32(0));
        assertEq(b, bytes32(uint256(0x05345cdf77eb68f44c)));
        (a, b) = amm.slots();
        uint256 base = uint256(keccak256(abi.encode(POOL_ID, uint256(74))));
        assertEq(a, bytes32(base + 3));
        assertEq(b, bytes32(base + 4));
    }

    /// With all fourteen recorded the window of 12 (1h) holds eight low intervals and four high ones.
    function test_realWindowMedians() public {
        _recordAll();
        // newest counted: (26183554 - 1 - 10) / 25 - 1 = 1047340; a 12-interval window is 1047340 .. 1047329
        (uint256 low, uint256 high) = precision.prices(1 hours);
        assertEq(low, P_LO);
        assertEq(high, P_LO);
        (low, high) = amm.prices(1 hours);
        assertEq(low, A_LO);
        assertEq(high, A_LO);
        // the smallest recorded depth over the window: the low level (the window holds both levels)
        assertEq(precision.depthMin(1 hours), D_LO);
        assertEq(amm.depthMin(1 hours), AD_LO);
        TacPairOracle pair = new TacPairOracle(address(precision), address(amm));
        (low, high) = pair.prices(1 hours);
        assertEq(low, A_LO, "the smaller of the two lows");
        assertEq(high, P_LO, "the larger of the two highs");
        assertEq(pair.depthMin(1 hours), AD_LO, "the smaller of the smallest depths");
        assertEq(pair.STEP(), STEP);
        assertEq(pair.recovery(1 hours), P_LO, "the larger low");
        assertEq(pair.latest(), A_LO, "the lower of the venues' newest recorded prices");
    }

    /// A window that holds only high-level depths and one low one: depthMin finds the low one, the median does not.
    function test_depthMinOnRealDepths() public {
        // intervals 1047329 .. 1047332 are the high level (3.20 ETH), 1047333 .. are the low level (3.095 ETH)
        for (uint256 k = LATEST - 12; k <= LATEST - 8; ++k) {
            _recordP(k); // 1047329 .. 1047333: four high, one low (1047333)
        }
        for (uint256 k = LATEST - 7; k <= LATEST - 1; ++k) {
            _recordP(k); // 1047334 .. 1047340: all low
        }
        assertEq(precision.depthMin(1 hours), D_LO);
    }

    /// Two venue oracles over the same pool cannot be paired (the real contracts), nor can a venue with itself.
    function test_aPairNeedsTwoDifferentPools() public {
        TacBlockOracle again = new TacBlockOracle(PRECISION, TAC, STEP, 30 minutes, 1 hours, 1 hours, 6_600);
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        new TacPairOracle(address(precision), address(again));
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        new TacPairOracle(address(precision), address(precision));
        new TacPairOracle(address(precision), address(amm));
    }

    /// Records only some intervals: the lower and upper medians differ, and the unrecorded ones lean the right way.
    function test_aHoleyRealWindow() public {
        // window of 12 = 1047340 .. 1047329. Record 1047340..1047335 (six low) and 1047332..1047329 (four high);
        // 1047334 and 1047333 (low values in reality) are not recorded: 10 of 12.
        for (uint256 k = LATEST - 1; k >= LATEST - 6; --k) {
            _recordP(k);
        }
        for (uint256 k = LATEST - 12; k <= LATEST - 9; ++k) {
            _recordP(k);
        }
        // sorted recorded: lo x6, hi x4; points 12, n 10, u 2: low index (11/2) - 2 = 3 -> lo; high index 12/2 = 6 -> hi
        (uint256 low, uint256 high) = precision.prices(1 hours);
        assertEq(low, P_LO);
        assertEq(high, P_HI);
        assertEq(precision.recovery(1 hours), P_LO);
        // the medians answer with 10 of 12; the smallest depth needs all 12
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        precision.depthMin(1 hours);
        // with one more high one missing (9 of 12) the upper middle (index 6) is still recorded, the lower (5 - 3 = 2) too
        // ... and with four missing it is not
    }

    // ───── the checks the fork suite makes, offline ─────

    function test_theWrongSampleOrNextBlockIsRefused() public {
        Fixture memory f = _fixture("tac-block-oracle", LATEST);
        Fixture memory g = _fixture("tac-block-oracle", LATEST - 1);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        precision.record(f.header, g.next, f.account, f.a, f.b);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        precision.record(f.next, f.next, f.account, f.a, f.b);
    }

    /// A real header paired with the following block of another interval is refused; its own pair is accepted.
    function test_aHeaderPairedWithAnotherIntervalsNextBlockIsRefused() public {
        Fixture memory f = _fixture("tac-block-oracle", LATEST);
        Fixture memory prev = _fixture("tac-block-oracle", LATEST - 1);
        // `prev.header` is the sample of the previous interval, and `f.next` follows the newest interval: pairing them
        // fails the next-block check; pairing `prev.header` with `prev.next` is valid
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        precision.record(prev.header, f.next, prev.account, prev.a, prev.b);
        precision.record(prev.header, prev.next, prev.account, prev.a, prev.b);
    }

    function test_aTamperedHeaderIsRefused() public {
        Fixture memory f = _fixture("tac-block-oracle", LATEST);
        f.header[100] = f.header[100] ^ 0x01;
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        precision.record(f.header, f.next, f.account, f.a, f.b);
        f = _fixture("tac-block-oracle", LATEST);
        f.next[100] = f.next[100] ^ 0x01;
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        precision.record(f.header, f.next, f.account, f.a, f.b);
    }

    function test_swappedStorageProofsAreRefused() public {
        Fixture memory f = _fixture("tac-block-oracle", LATEST);
        vm.expectRevert();
        precision.record(f.header, f.next, f.account, f.b, f.a);
        f = _fixture("tac-amm-oracle", LATEST);
        vm.expectRevert();
        amm.record(f.header, f.next, f.account, f.b, f.a);
    }

    function test_theWrongPoolsAccountIsRefused() public {
        // the AMM fixture's account proof is the confidential pool's: the Precision oracle must not accept it
        Fixture memory f = _fixture("tac-block-oracle", LATEST);
        Fixture memory g = _fixture("tac-amm-oracle", LATEST);
        vm.expectRevert();
        precision.record(f.header, f.next, g.account, f.a, f.b);
    }

    function test_anIntervalIsRecordedOnce() public {
        _recordP(LATEST);
        Fixture memory f = _fixture("tac-block-oracle", LATEST);
        vm.expectRevert(TacIntervalOracle.AlreadyRecorded.selector);
        precision.record(f.header, f.next, f.account, f.a, f.b);
    }

    function test_tooFewIntervalsHaveNoPriceThenEnough() public {
        for (uint256 i = 1; i <= 7; ++i) {
            _recordP(LATEST - i); // 7 of 12 counted (the newest, LATEST, is still within the grace): 58% < 66%
        }
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        precision.prices(1 hours);
        _recordP(LATEST - 8); // 8 of 12: 66.7%
        precision.prices(1 hours);
    }

    /// An interval cannot be recorded once the newest is a full ring ahead of it.
    function test_theRingBoundaryOnARealInterval() public {
        Fixture memory f = _fixture("tac-block-oracle", LATEST - 13);
        // newest (no grace) = (block.number - 1) / 25 - 1; refused when interval + 128 <= newest
        uint256 interval = LATEST - 13;
        vm.store(HISTORY, keccak256(abi.encode(f.number, uint256(0))), keccak256(f.header));
        vm.store(HISTORY, keccak256(abi.encode((interval + 1) * STEP, uint256(0))), keccak256(f.next));
        vm.roll((interval + 129) * STEP + 1);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        precision.record(f.header, f.next, f.account, f.a, f.b);
        vm.roll((interval + 129) * STEP);
        precision.record(f.header, f.next, f.account, f.a, f.b);
    }

    /// Exactly 256 blocks behind is read from BLOCKHASH, 257 from the history contract.
    function test_the256Boundary() public {
        uint256 interval = LATEST - 12;
        Fixture memory f = _fixture("tac-block-oracle", interval);
        uint256 nextNumber = (interval + 1) * STEP;
        vm.store(HISTORY, keccak256(abi.encode(f.number, uint256(0))), keccak256(f.header)); // the header: far, history
        vm.store(HISTORY, keccak256(abi.encode(nextNumber, uint256(0))), bytes32(0)); // not in the history
        vm.roll(nextNumber + 256);
        vm.setBlockhash(nextNumber, keccak256(f.next));
        precision.record(f.header, f.next, f.account, f.a, f.b);

        interval = LATEST - 11;
        f = _fixture("tac-block-oracle", interval);
        nextNumber = (interval + 1) * STEP;
        vm.store(HISTORY, keccak256(abi.encode(f.number, uint256(0))), keccak256(f.header));
        vm.store(HISTORY, keccak256(abi.encode(nextNumber, uint256(0))), keccak256(f.next));
        vm.roll(nextNumber + 257);
        precision.record(f.header, f.next, f.account, f.a, f.b);
    }

    function test_theConstructorsCheckTheirPools() public {
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new TacAmmOracle(V1, POOL_ID, TAC_ASSET, ETH_ASSET, TAC, 74, STEP, 30 minutes, 1 hours, 1 hours, 6_600);
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new TacAmmOracle(
            V1, POOL_ID, ETH_ASSET, TAC_ASSET, address(0xBEEF), 74, STEP, 30 minutes, 1 hours, 1 hours, 6_600
        );
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new TacAmmOracle(
            V1, bytes32(uint256(1)), ETH_ASSET, TAC_ASSET, TAC, 74, STEP, 30 minutes, 1 hours, 1 hours, 6_600
        );
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new TacBlockOracle(PRECISION, address(0xBEEF), STEP, 30 minutes, 1 hours, 1 hours, 6_600);
    }
}
