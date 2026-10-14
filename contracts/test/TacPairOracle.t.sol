// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {MockOracle} from "./TacVaultMocks.sol";

/// The pair of venues: each value is the one that takes moving both venues to move.
contract TacPairOracleTest is Test {
    uint256 constant P = 9e13;
    MockOracle a;
    MockOracle b;
    TacPairOracle pair;

    function setUp() public {
        a = new MockOracle();
        b = new MockOracle();
        a.set(P);
        b.set(P);
        pair = new TacPairOracle(address(a), address(b));
    }

    /// Raising one venue does not raise `low`, the borrow price; raising both does.
    function test_aHeldUpVenueDoesNotRaiseTheBorrowPrice() public {
        a.setPrices(5 * P, 5 * P, 5 * P);
        (uint256 low,) = pair.prices(1 hours);
        assertEq(low, P);
        assertEq(pair.spot(), P);
        b.setPrices(5 * P, 5 * P, 5 * P);
        (low,) = pair.prices(1 hours);
        assertEq(low, 5 * P);
        assertEq(pair.spot(), 5 * P);
    }

    /// Lowering one venue does not lower `high`, the liquidation price; lowering both does.
    function test_aHeldDownVenueDoesNotLowerTheLiquidationPrice() public {
        a.setPrices(P / 5, P / 5, P / 5);
        (, uint256 high) = pair.prices(1 hours);
        assertEq(high, P);
        b.setPrices(P / 5, P / 5, P / 5);
        (, high) = pair.prices(1 hours);
        assertEq(high, P / 5);
    }

    /// Holding one venue down does not block a recovery; holding both does.
    function test_aHeldDownVenueDoesNotBlockARecovery() public {
        a.setPrices(P / 5, P / 5, P / 5);
        assertEq(pair.recovery(1 hours), P);
        b.setPrices(P / 5, P / 5, P / 5);
        assertEq(pair.recovery(1 hours), P / 5);
    }

    /// The offer's floor takes the lower venue's newest interval, so one venue held up does not raise it.
    function test_latestAndSpotTakeTheLowerVenue() public {
        a.setPrices(P, P, 2 * P);
        b.setPrices(3 * P, 3 * P, 3 * P);
        a.setLatest(P);
        b.setLatest(3 * P);
        assertEq(pair.latest(), P);
        assertEq(pair.spot(), 2 * P);
        a.setLatest(4 * P);
        assertEq(pair.latest(), 3 * P);
    }

    function test_depthIsTheSmallerVenue() public {
        a.setDepth(5e18);
        b.setDepth(2e18);
        assertEq(pair.depth(3 hours), 2e18);
    }

    /// A venue without a price leaves the pair without one.
    function test_aVenueWithoutAPriceLeavesNone() public {
        b.setBroken(true);
        vm.expectRevert(bytes("oracle"));
        pair.prices(1 hours);
        vm.expectRevert(bytes("oracle"));
        pair.spot();
    }

    function test_venuesMustShareTheirWindows() public {
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        new TacPairOracle(address(a), address(a));
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        new TacPairOracle(address(a), address(0x1234));
    }
}
