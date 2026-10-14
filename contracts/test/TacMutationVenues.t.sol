// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {MockPrecision} from "./MockPrecision.sol";
import {SynthOracle, SynthChain, SynthHistory} from "./TacSynthChain.sol";

/// A confidential-pool stand-in whose answers a test sets: pool assets, reserves, each asset's underlying and scale.
contract ConfigurableV1 {
    bytes32 public constant ETH_ASSET = bytes32(uint256(0xE7));
    bytes32 public constant TAC_ASSET = bytes32(uint256(0x7AC));
    bytes32 public constant POOL_ID = bytes32(uint256(0x9001));
    address public tac;
    address public ethUnderlying;
    uint256 public ethScale = 1e10;
    uint256 public tacScale = 1e10;
    uint256 public rA;
    uint256 public rB;
    bytes32 public poolAssetA = ETH_ASSET;
    bytes32 public poolAssetB = TAC_ASSET;

    constructor(address tac_, uint256 a, uint256 b) {
        (tac, rA, rB) = (tac_, a, b);
    }

    function configure(address ethUnderlying_, uint256 ethScale_, uint256 tacScale_, bytes32 assetB) external {
        (ethUnderlying, ethScale, tacScale, poolAssetB) = (ethUnderlying_, ethScale_, tacScale_, assetB);
    }

    function setReserves(uint256 a, uint256 b) external {
        (rA, rB) = (a, b);
    }

    function pools(bytes32 id) external view returns (bool, bytes32, bytes32, uint256, uint256, uint32, uint256) {
        return (id == POOL_ID, poolAssetA, poolAssetB, rA, rB, 30, 1);
    }

    function assets(bytes32 id) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        if (id == ETH_ASSET) return (true, ethUnderlying, ethScale, bytes32(0), false, 18);
        if (id == TAC_ASSET) return (true, tac, tacScale, bytes32(0), false, 18);
        return (false, address(0), 0, bytes32(0), false, 0);
    }
}

/// A Precision stand-in whose `tapePair` base is not the ETH marker.
contract WrongBasePool {
    address immutable TAC;

    constructor(address tac) {
        TAC = tac;
    }

    function tapePair() external view returns (address, address) {
        return (address(1), TAC);
    }

    function sqrtPLow() external pure returns (uint256) {
        return 3779257685557097674;
    }

    function sqrtPHigh() external pure returns (uint256) {
        return 3779257685557097674402;
    }
}

/// A history contract that fails for every block, reverting with the 32-byte word a test stored for that number
/// (what a "hash" read from failed-call output would be).
contract LyingHistory {
    fallback() external {
        assembly {
            mstore(0, calldataload(0))
            mstore(0x20, 0)
            mstore(0, sload(keccak256(0, 0x40)))
            revert(0, 32)
        }
    }
}

/// What the venues and the base class accept at construction, and what they refuse to read.
contract TacMutationVenuesTest is SynthChain {
    address constant TAC = address(0x7Ac0000000000000000000000000000000000001);
    uint256 constant RING = 128;

    function setUp() public {
        vm.etch(HISTORY, address(new SynthHistory()).code);
        vm.etch(POOL, hex"00");
    }

    // ───────────── the base class's constructor ─────────────

    function test_baseConfigurationBoundaries() public {
        // step must exceed GRACE (10)
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new SynthOracle(POOL, 10, 120, 120, 120, 6_600);
        new SynthOracle(POOL, 11, 132, 132, 132, 6_600);
        // MAX_WINDOW must span fewer than RING (128) intervals: 128 refused, 127 allowed
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new SynthOracle(POOL, 11, 132, 132, 128 * 132, 6_600);
        new SynthOracle(POOL, 11, 132, 132, 127 * 132, 6_600);
        // coverage in 1 .. 10,000
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new SynthOracle(POOL, 11, 132, 132, 132, 0);
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new SynthOracle(POOL, 11, 132, 132, 132, 10_001);
        new SynthOracle(POOL, 11, 132, 132, 132, 1);
        new SynthOracle(POOL, 11, 132, 132, 132, 10_000);
        // windows ordered, the short one at least one interval, a pool with code
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new SynthOracle(POOL, 11, 131, 132, 132, 6_600);
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new SynthOracle(POOL, 11, 264, 132, 264, 6_600);
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new SynthOracle(POOL, 11, 132, 264, 132, 6_600);
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new SynthOracle(address(0xDEAD0001), 11, 132, 132, 132, 6_600);
    }

    // ───────────── the two median conditions are one condition ─────────────

    /// `(points - 1) / 2 < points - n` and `points / 2 >= n` (src/TacIntervalOracle.sol line 182) are the same
    /// condition for every window of 1 .. 127 intervals: either alone does the work of both.
    function test_theTwoMedianGuardsAreTheSameCondition() public pure {
        for (uint256 points = 1; points <= 127; ++points) {
            for (uint256 n; n <= points; ++n) {
                bool low = (points - 1) / 2 < points - n;
                bool high = points / 2 >= n;
                assertEq(low, high);
            }
        }
    }

    // ───────────── latest() looks back exactly MAX_WINDOW ─────────────

    function test_latestLooksBackExactlyMaxWindowAndNoFurther() public {
        SynthOracle o = new SynthOracle(POOL, 50, 3_600, 10_800, 21_600, 6_600); // 36 intervals
        uint256 height = 26_000_061;
        vm.roll(height);
        uint256 newest = (height - 1) / 50 - 1; // no grace
        // only the interval 36 behind the newest (one beyond MAX_WINDOW): not seen
        vm.store(address(o), bytes32((newest - 36) % RING), bytes32((newest - 36) << 208 | uint256(777) << 104 | 1));
        assertEq(o.latest(), 0);
        // 35 behind (the oldest inside): seen
        vm.store(address(o), bytes32((newest - 35) % RING), bytes32((newest - 35) << 208 | uint256(555) << 104 | 1));
        assertEq(o.latest(), 555);
        // a stale ring entry (an older tag) in the newest slot is not a price
        vm.store(address(o), bytes32(newest % RING), bytes32((newest - RING) << 208 | uint256(999) << 104 | 1));
        assertEq(o.latest(), 555);
    }

    // ───────────── hash sources ─────────────

    /// A history call that fails is not a hash, whatever 32 bytes it reverts with: the lying history here "answers" with
    /// the true hashes of both headers, and the record is still refused.
    function test_aRevertingHistoryIsNotAHashSource() public {
        uint256 k = 600_100;
        SynthOracle o = new SynthOracle(POOL, STEP, 3_600, 10_800, 21_600, 6_600);
        (bytes32 sa, bytes32 sb) = o.slots();
        Rec memory r = _build(k, 4, 7e13, 3e18, sa, sb);
        vm.roll((k + 20) * STEP);
        vm.etch(HISTORY, address(new LyingHistory()).code);
        vm.store(HISTORY, keccak256(abi.encode(r.number, uint256(0))), keccak256(r.header));
        vm.store(HISTORY, keccak256(abi.encode((k + 1) * STEP, uint256(0))), keccak256(r.next));
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        o.record(r.header, r.next, r.account, r.proofA, r.proofB);
        // the same chain through the honest history is accepted
        vm.etch(HISTORY, address(new SynthHistory()).code);
        vm.store(HISTORY, keccak256(abi.encode(r.number, uint256(0))), keccak256(r.header));
        vm.store(HISTORY, keccak256(abi.encode((k + 1) * STEP, uint256(0))), keccak256(r.next));
        o.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    /// A block number field longer than 32 bytes is refused even when its value would fit and both hashes are registered
    /// (the same record with a 32-byte field would be accepted).
    function test_aNumberFieldLongerThan32BytesIsRefused() public {
        uint256 k = 600_200;
        SynthOracle o = new SynthOracle(POOL, STEP, 3_600, 10_800, 21_600, 6_600);
        (bytes32 sa, bytes32 sb) = o.slots();
        Rec memory r = _build(k, 4, 7e13, 3e18, sa, sb);
        bytes32 stateRoot = keccak256(r.account[0]);
        bytes memory longNumber = abi.encodePacked(bytes1(0), bytes32(r.number)); // 33 bytes, the same value
        bytes memory header = _headerRlpRaw(longNumber, stateRoot, bytes32(0));
        vm.roll((k + 20) * STEP);
        vm.store(HISTORY, keccak256(abi.encode(r.number, uint256(0))), keccak256(header));
        vm.store(HISTORY, keccak256(abi.encode((k + 1) * STEP, uint256(0))), keccak256(r.next));
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        o.record(header, r.next, r.account, r.proofA, r.proofB);
        // with the number in 32 bytes the same header is accepted
        bytes memory fine = _headerRlpRaw(abi.encodePacked(bytes32(r.number)), stateRoot, bytes32(0));
        vm.store(HISTORY, keccak256(abi.encode(r.number, uint256(0))), keccak256(fine));
        o.record(fine, r.next, r.account, r.proofA, r.proofB);
    }

    // ───────────── TacBlockOracle ─────────────

    function test_blockOracleRefusesAPoolWhoseBaseIsNotEth() public {
        address tac = address(new MockPrecision(address(0xAA), 1, 2, 1, 1, 1)); // any code
        address wrong = address(new WrongBasePool(tac));
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new TacBlockOracle(wrong, tac, 50, 3_600, 10_800, 21_600, 6_600);
        // and the right base is accepted
        MockPrecision good = new MockPrecision(tac, 3779257685557097674, 3779257685557097674402, 1e18, 1e18, 1e21);
        new TacBlockOracle(address(good), tac, 50, 3_600, 10_800, 21_600, 6_600);
    }

    function test_blockOracleSpotIsExactOnATinyPoolAndRefusesAnEmptyOne() public {
        // supply 1 wei: virtual ETH = 1e18 / 3.78e21 = 0, virtual TAC = 3 (3.779e18 / 1e18); reserves 5e17 ETH and 7 TAC
        MockPrecision tiny = new MockPrecision(TAC, 3779257685557097674, 3779257685557097674402, 1, 5e17, 7);
        TacBlockOracle o = new TacBlockOracle(address(tiny), TAC, 50, 3_600, 10_800, 21_600, 6_600);
        // ETH 5e17 over TAC 10: exactly 5e34 per TAC (wad)
        assertEq(o.spot(), 5e17 * 1e18 / 10);
        // no LP supply: no price, even with reserves (the virtual parts are the pool's range)
        MockPrecision empty = new MockPrecision(TAC, 3779257685557097674, 3779257685557097674402, 0, 5e17, 7);
        TacBlockOracle e = new TacBlockOracle(address(empty), TAC, 50, 3_600, 10_800, 21_600, 6_600);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        e.spot();
        // no TAC side at all
        MockPrecision noTac = new MockPrecision(TAC, 0, 3779257685557097674402, 1, 5e17, 0);
        TacBlockOracle n = new TacBlockOracle(address(noTac), TAC, 50, 3_600, 10_800, 21_600, 6_600);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        n.spot();
    }

    // ───────────── TacAmmOracle ─────────────

    bytes32 constant POOL_ID = bytes32(uint256(0x9001));
    bytes32 constant ETH_ASSET = bytes32(uint256(0xE7));
    bytes32 constant TAC_ASSET = bytes32(uint256(0x7AC));

    function _amm(ConfigurableV1 v) internal returns (TacAmmOracle) {
        return new TacAmmOracle(address(v), POOL_ID, ETH_ASSET, TAC_ASSET, TAC, 74, 50, 3_600, 10_800, 21_600, 6_600);
    }

    function test_ammOracleConstructorChecksEveryAssetField() public {
        ConfigurableV1 v = new ConfigurableV1(TAC, 3e8, 3e12);
        _amm(v); // the good one
        // the pool's second asset is not the TAC asset
        v.configure(address(0), 1e10, 1e10, bytes32(uint256(0xBAD)));
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        _amm(v);
        // the ETH asset has an underlying token
        v.configure(address(0xE7E7), 1e10, 1e10, TAC_ASSET);
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        _amm(v);
        // a zero unit scale
        v.configure(address(0), 0, 1e10, TAC_ASSET);
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        _amm(v);
        v.configure(address(0), 1e10, 0, TAC_ASSET);
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        _amm(v);
    }

    /// Each reserve is scaled by its own asset's unit scale; a zero reserve is no price.
    function test_ammOraclePriceUsesEachAssetsOwnScaleAndRefusesZero() public {
        ConfigurableV1 v = new ConfigurableV1(TAC, 3e8, 3e12);
        v.configure(address(0), 1e10, 1e8, TAC_ASSET); // TAC counted in units of 1e8
        TacAmmOracle o = _amm(v);
        // ETH: 3e8 units x 1e10 = 3e18 wei; TAC: 3e12 units x 1e8 = 3e20 wei: 0.01 ETH per TAC
        assertEq(o.spot(), 1e16);
        v.configure(address(0), 1e12, 1e8, TAC_ASSET); // ETH counted in units of 1e12
        assertEq(o.spot(), 1e16, "the scales are fixed at construction");
        TacAmmOracle o2 = _amm(v);
        assertEq(o2.spot(), 3e8 * 1e12 * 1e18 / (3e12 * 1e8));
        v.setReserves(0, 3e12);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        o2.spot();
        v.setReserves(3e8, 0);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        o2.spot();
    }
}
