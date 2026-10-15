// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TacLaunchFixture} from "./TacLaunchFixture.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {FixedFeed} from "../src/FixedFeed.sol";

/// How long a venue's price has to differ from the market for each vault view to follow it, what an auction then
/// pays an outside bidder and what an owner who answers in time keeps, how two vaults over one oracle share its depth,
/// and when a late record pauses borrowing. Venue histories are written into the oracles' storage (TacLaunchFixture).
contract TacVaultHoldsTest is TacLaunchFixture {
    // Re-records the newest `count` intervals of both venues at `factorBps` of their prices.
    function _holdBoth(uint256 count, uint256 factorBps) internal {
        _holdVenue(true, count, factorBps);
        _holdVenue(false, count, factorBps);
    }

    function _holdVenue(bool venueA, uint256 count, uint256 factorBps) internal {
        uint256 newest = _newest();
        address o = venueA ? address(a) : address(b);
        uint256 base = venueA ? baseA : baseB;
        for (uint256 i; i < count; ++i) {
            uint256 idx = newest - i;
            vm.store(o, bytes32(idx % 128), bytes32(idx << 208 | (base * factorBps / 10_000) << 104 | uint256(1000e18)));
        }
    }

    // Alice (100,000 TAC, debt 5,050) and bob (a borrower with synth to bid with).
    function _openBoth() internal {
        _fill(10_000, 0);
        _open();
        vm.startPrank(bob);
        vault.deposit(1_000_000e18);
        vault.borrow(6_000e18, 100);
        vm.stopPrank();
    }

    /// Both venues at 40% of the market through the newest 19 of the longest window's 36 intervals (about three
    /// hours) put the liquidation view at that price; 18 intervals move nothing. After the owner window an outside
    /// bidder takes the TAC the debt buys at that price plus the bonus earned so far.
    function test_bothVenuesAwayThroughMoreThanHalfTheWindowSetTheAuctionPrice() public {
        _openBoth();
        uint256 market = vault.liquidationPrice();
        (, uint256 debt,) = vault.vaults(alice);

        _holdBoth(18, 4_000);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);

        _holdBoth(19, 4_000);
        vault.liquidate(alice);
        skip(vault.OWNER_WINDOW());
        uint256 price = vault.offerPrice();
        assertApproxEqRel(price, market * 4 / 10, 0.01e18, "the offer follows the held price");
        uint256 bonus = 2_500 * vault.OWNER_WINDOW() / vault.AUCTION_DURATION();
        uint256 expected = debt * (10_000 + bonus) / 10_000 * 1e18 / price;

        vm.prank(bob);
        uint256 taken = vault.bid(alice, type(uint256).max, 0);
        assertEq(taken, expected);
        // At the market that TAC is worth about 2.6 times the debt that bought it.
        assertGt(taken * market / 1e18, debt * 26 / 10);
    }

    /// An owner who repays during the owner window keeps all of the collateral at any held price: the auction ends
    /// with the debt and the whole deposit can be withdrawn.
    function test_anOwnerWhoRepaysInTheOwnerWindowKeepsAllTheCollateral() public {
        _openBoth();
        _holdBoth(19, 4_000);
        vault.liquidate(alice);
        (uint256 collateral, uint256 debt,) = vault.vaults(alice);

        // Alice holds what she borrowed; the fee went to the fee address and is sent back so she can close.
        uint256 fee = synth.balanceOf(address(0xFEE));
        vm.prank(address(0xFEE));
        synth.transfer(alice, fee);
        vm.startPrank(alice);
        synth.approve(address(vault), type(uint256).max);
        vault.repay(alice, type(uint256).max);
        (uint256 left, uint256 owed, uint256 start) = vault.vaults(alice);
        assertEq(owed, 0);
        assertEq(start, 0, "the auction ended with the debt");
        vault.withdraw(left);
        vm.stopPrank();
        assertEq(left, collateral);
        assertEq(tac.balanceOf(alice), 10_000_000e18 - 100_000e18 + collateral, "every TAC is back");
        assertEq(debt, 5_050e18);
    }

    /// The liquidation view is the higher venue's: one venue held at its old price through half of the shorter
    /// window (6 of 12 intervals) keeps an underwater vault from being auctioned while the market, and the other
    /// venue, are far below; with 5 of 12 held it is auctioned.
    function test_oneVenueHeldAboveTheMarketKeepsTheLiquidationViewUp() public {
        _fill(10_000, 0);
        _open();
        // The market falls 85%: alice's TAC is worth $3,750 against a debt of $5,050.
        _fillVenue(true, 1_500);
        _fillVenue(false, 1_500);
        _holdVenue(false, 6, 10_000);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
        _fillVenue(false, 1_500);
        _holdVenue(false, 5, 10_000);
        vault.liquidate(alice);
    }

    /// Two vaults over one oracle each lend their own DEPTH_BPS share of the same depth, so together they lend the
    /// sum of the two shares.
    function test_twoVaultsOverOneOracleLendTheSumOfTheirShares() public {
        _fill(10_000, 0);
        TacVault.Config memory c = TacVault.Config({
            tac: address(tac),
            oracle: address(pair),
            ethUsd: address(new FixedFeed()),
            owner: address(this),
            mintRatioBps: 35_000,
            liqRatioBps: 20_000,
            liqBonusBps: 2_500,
            auctionDuration: 5_400,
            ownerWindow: 1_200,
            minDebt: 0.04e18,
            feedMaxStaleness: 3_900,
            debtCeiling: type(uint256).max,
            depthBps: 500,
            redemptionFeeBps: 50,
            borrowFeeBps: 100,
            feeTo: address(0xFEE),
            tacSink: address(0xdEaD),
            name: "TAC Ether",
            symbol: "TACE"
        });
        TacVault ethVault = new TacVault(c);
        vault.setDebtCeiling(type(uint256).max);
        // Depth 1,000 ETH: each vault's cap is 5% of it, 50 ETH of its synth.
        assertEq(vault.depthCeiling(), 50 * 2_500e18);
        assertEq(ethVault.depthCeiling(), 50e18);
        vm.startPrank(bob);
        tac.approve(address(ethVault), type(uint256).max);
        vault.deposit(5_000_000e18);
        vault.borrow(vault.depthCeiling() * 99 / 101, 100);
        ethVault.deposit(5_000_000e18);
        ethVault.borrow(ethVault.depthCeiling() * 99 / 101, 100);
        vm.stopPrank();
        uint256 lentEth = vault.totalDebt() / 2_500 + ethVault.totalDebt();
        assertApproxEqRel(lentEth, 100e18, 0.02e18);
    }

    /// Borrowing needs every interval of the longest window recorded on both venues, each counted GRACE blocks after
    /// it ends: while the newest counted interval of one venue is not recorded, borrowing pauses (the price views
    /// still answer) and resumes once it is.
    function test_borrowingPausesUntilTheNewestIntervalOfEachVenueIsRecorded() public {
        _fill(10_000, 0);
        vm.prank(alice);
        vault.deposit(100_000e18);
        bytes32 slot = bytes32(_newest() % 128);
        bytes32 recorded = vm.load(address(b), slot);
        vm.store(address(b), slot, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(1_000e18, 100);
        assertGt(vault.valueOf(100_000e18, true), 0);
        vm.store(address(b), slot, recorded);
        vm.prank(alice);
        vault.borrow(1_000e18, 100);
    }
}
