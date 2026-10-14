// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TacVault} from "../src/TacVault.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacLaunchFixture} from "./TacLaunchFixture.sol";

/// How the vault behaves on the pair oracle when its two venues disagree or one of them has no recorded intervals,
/// under the deploy script's configuration (see TacLaunchFixture). A pair answers only while both venues do; its
/// liquidation view is the higher venue, its recovery view the higher venue's low, and its newest price the lower
/// venue's newest.
contract TacVenueLivenessTest is TacLaunchFixture {
    /// Liquidation needs both venues low: with one venue at its old price the vault stays above the line.
    function test_aVaultIsLiquidatableOnlyWhenBothVenuesAreLow() public {
        _fill(10_000, 0);
        _open();

        _fillVenue(true, 1_000);
        assertTrue(vault.liqHealthyView(alice));
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);

        _fillVenue(false, 1_000);
        assertFalse(vault.liqHealthyView(alice));
        vault.liquidate(alice);
        (,, uint256 start) = vault.vaults(alice);
        assertGt(start, 0);
    }

    /// An auction ends once either venue shows the vault back above the line: the vault counts as recovered, anyone
    /// may cancel, and a bid from another account is refused (first inside the owner window, then as healthy).
    function test_anAuctionEndsWhenEitherVenueHasRecovered() public {
        _fill(10_000, 0);
        _open();
        _fill(1_000, 0);
        vault.liquidate(alice);
        assertFalse(vault.recovered(alice));

        _fillVenue(false, 12_000);
        assertTrue(vault.recovered(alice));
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, 1_000e18, 0);
        skip(vault.OWNER_WINDOW() + 1);
        vm.prank(bob);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.bid(alice, 1_000e18, 0);
        vault.cancel(alice);
        (,, uint256 start) = vault.vaults(alice);
        assertEq(start, 0);
    }

    /// A venue with no recorded intervals leaves the pair without a price: lending, liquidation, withdrawing against
    /// debt and non-owner bids stop; repaying, depositing and withdrawing a debt-free vault do not.
    function test_aVenueWithoutRecordedIntervalsStopsLendingAndLiquidationButNotRepayment() public {
        _fill(10_000, 0);
        _open();
        uint256 newest = _newest();
        for (uint256 i; i < 40; ++i) {
            vm.store(address(b), bytes32((newest - i) % 128), bytes32(0));
        }
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        pair.prices(3_600 * 2);
        vm.prank(alice);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(1e18, 100);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.liquidate(alice);
        vm.prank(alice);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.withdraw(1e18);

        // Repaying (the borrow fee went to FEE_TO, so alice tops up from it) and then withdrawing needs no price.
        uint256 feeBal = synth.balanceOf(address(0xFEE));
        vm.prank(address(0xFEE));
        synth.transfer(alice, feeBal);
        vm.startPrank(alice);
        (, uint256 debt,) = vault.vaults(alice);
        vault.repay(alice, debt);
        vault.withdraw(type(uint256).max);
        vm.stopPrank();
        (uint256 coll, uint256 d,) = vault.vaults(alice);
        assertEq(coll + d, 0);
    }

    /// New borrowing needs every interval of the longest window recorded on both venues. One gap stops it and the
    /// debt cap view; the price views (which tolerate a third missing), existing positions and repayment carry on.
    function test_oneUnrecordedIntervalStopsNewBorrowingAndNothingElse() public {
        _fill(10_000, 0);
        pair.depthMin(21_600);
        _open();

        uint256 gap = _newest() - 20;
        uint256 saved = uint256(vm.load(address(a), bytes32(gap % 128)));
        vm.store(address(a), bytes32(gap % 128), bytes32(0));

        pair.prices(21_600);
        vault.liquidationPrice();
        assertTrue(vault.liqHealthyView(alice));
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        pair.depthMin(21_600);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.depthCeiling();
        vm.startPrank(alice);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(100e18, 100);
        vault.withdraw(1_000e18);
        vault.repay(alice, 100e18);
        vm.stopPrank();

        vm.store(address(a), bytes32(gap % 128), bytes32(saved));
        vm.prank(alice);
        vault.borrow(100e18, 100);
    }

    /// Two venues over one pool are refused; two different pools are accepted.
    function test_aPairOverTheSamePoolTwiceIsRefused() public {
        TacBlockOracle again = new TacBlockOracle(address(prec), address(tac), STEP, 7_200, 10_800, 21_600, 6_600);
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        new TacPairOracle(address(a), address(again));
        new TacPairOracle(address(a), address(b));
    }

    /// The offer view reads the pair's newest recorded interval, which is the lower of the venues' newest, and never
    /// the live price: one venue's high newest interval leaves the offer where it was, both venues' raise it to the
    /// lower of the two (three times that venue's price, in dollars at the feed's 2,500).
    function test_theOfferViewFollowsTheNewestRecordedIntervalOfBothVenues() public {
        _fill(10_000, 0);
        uint256 liq = vault.liquidationPrice();
        assertEq(vault.offerPrice(), liq);
        uint256 idx = _newest();
        vm.store(address(a), bytes32(idx % 128), bytes32(idx << 208 | (baseA * 3) << 104 | uint256(1000e18)));
        assertEq(pair.latest(), baseB);
        assertEq(vault.offerPrice(), liq);
        vm.store(address(b), bytes32(idx % 128), bytes32(idx << 208 | (baseB * 3) << 104 | uint256(1000e18)));
        assertEq(vault.liquidationPrice(), liq);
        uint256 raised = 3 * baseB * 2500;
        assertEq(vault.offerPrice(), raised);
        assertGt(raised, liq);
        prec.setReserves(1, 3e22);
        v1.setPool(POOL_ID, ETH_ASSET, TAC_ASSET, 1, 3.2e12);
        assertEq(vault.offerPrice(), raised);
    }
}
