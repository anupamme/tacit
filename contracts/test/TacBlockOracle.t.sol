// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {MockPrecision} from "./MockPrecision.sol";

/// The medians, with samples written straight into the oracle's ring (`_samples[i]` is storage slot i), using the
/// deploy settings: an interval of 50 blocks, windows of 1h (6 intervals), 3h (18) and 4h (24), two thirds coverage.
contract TacBlockOracleTest is Test {
    uint256 constant STEP = 50;
    uint256 constant P = 9e13;
    uint256 constant HEAD = 26_000_061; // the newest interval that counts ends at block 26,000,050
    TacBlockOracle oracle;

    function setUp() public {
        MockPrecision pool = new MockPrecision(address(0xAA), 3.78e18, 3.78e21, 3e20, 3e18, 3e22);
        oracle = new TacBlockOracle(address(pool), address(0xAA), STEP, 1 hours, 3 hours, 4 hours, 6_600);
        vm.roll(HEAD);
    }

    // Writes `price` (and a depth of 3 ETH) for the interval `back` before the newest that counts.
    function _put(uint256 back, uint256 price) internal {
        uint256 index = (HEAD - 1 - oracle.GRACE()) / STEP - 1 - back;
        vm.store(address(oracle), bytes32(index % oracle.RING()), bytes32(index << 208 | price << 104 | 3e18));
    }

    function _fill(uint256 points, uint256 price) internal {
        for (uint256 i; i < points; ++i) {
            _put(i, price);
        }
    }

    function test_allPointsAgree() public {
        _fill(24, P);
        (uint256 low, uint256 high) = oracle.prices(3 hours);
        assertEq(low, P);
        assertEq(high, P);
    }

    /// Half the points held up do not raise `low`; one more does.
    function test_halfThePointsDoNotRaiseLow() public {
        _fill(18, P);
        for (uint256 i; i < 9; ++i) {
            _put(i * 2, 7 * P);
        }
        (uint256 low,) = oracle.prices(3 hours);
        assertEq(low, P);
        _put(1, 7 * P);
        (low,) = oracle.prices(3 hours);
        assertEq(low, 7 * P);
    }

    /// Half the points held down do not lower `high`; one more does.
    function test_halfThePointsDoNotLowerHigh() public {
        _fill(18, P);
        for (uint256 i; i < 9; ++i) {
            _put(i * 2, P / 7);
        }
        (, uint256 high) = oracle.prices(3 hours);
        assertEq(high, P);
        _put(1, P / 7);
        (, high) = oracle.prices(3 hours);
        assertEq(high, P / 7);
    }

    /// Recording only some points does not help: with six of eighteen unrecorded, nine held up still leave `low`
    /// where it was, and nine held down leave `high`.
    function test_choosingWhichPointsExistDoesNotHelp() public {
        for (uint256 i; i < 9; ++i) {
            _put(i, 7 * P);
        }
        for (uint256 i = 9; i < 12; ++i) {
            _put(i, P);
        }
        (uint256 low,) = oracle.prices(3 hours);
        assertEq(low, P);

        for (uint256 i; i < 9; ++i) {
            _put(i, P / 7);
        }
        (, uint256 high) = oracle.prices(3 hours);
        assertEq(high, P);
    }

    /// Fewer than two thirds of a window's points recorded: no price.
    function test_tooFewPointsHaveNoPrice() public {
        _fill(11, P);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        oracle.prices(3 hours);
        _put(11, P);
        oracle.prices(3 hours);
    }

    function test_windowsOutsideTheRangeAreRefused() public {
        _fill(24, P);
        vm.expectRevert(TacIntervalOracle.BadWindow.selector);
        oracle.prices(5 hours);
        vm.expectRevert(TacIntervalOracle.BadWindow.selector);
        oracle.prices(5 minutes);
    }

    /// An interval that ended less than GRACE blocks ago does not count yet.
    function test_aFreshIntervalWaitsForTheGrace() public {
        _fill(24, P);
        uint256 fresh = (HEAD - 1 - oracle.GRACE()) / STEP;
        vm.store(address(oracle), bytes32(fresh % oracle.RING()), bytes32(fresh << 208 | 7 * P << 104 | 3e18));
        (uint256 low, uint256 high) = oracle.prices(1 hours);
        assertEq(low, P);
        assertEq(high, P);
    }

    /// The live price is the pool's own formula.
    function test_spotIsThePoolsPrice() public view {
        // (3e20 * 1e18 / 3.78e21 + 3e18) / (3e20 * 3.78e18 / 1e18 + 3e22), in wad
        uint256 eth = uint256(3e20) * 1e18 / 3.78e21 + 3e18;
        uint256 tac = uint256(3e20) * 3.78e18 / 1e18 + 3e22;
        assertEq(oracle.spot(), eth * 1e18 / tac);
    }
}
