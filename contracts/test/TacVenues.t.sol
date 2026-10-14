// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {MockPrecision} from "./MockPrecision.sol";
import {TestTac, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

/// How a TacVault behaves on a TacPairOracle over two TacBlockOracle venues, with the deploy parameters: an interval of
/// 50 blocks, windows SHORT 2h (12 intervals), WINDOW 3h (18) and MAX = the liquidation window 6h (36), two thirds
/// coverage, mint 350%, liquidation 200%, bonus 25%, auction 5400s, owner window 1200s, debt cap 5% of depth.
/// Samples are written straight into each venue's ring (`_samples[i]` is storage slot i), as test/TacBlockOracle.t.sol
/// does. More fuzz runs: `forge test --match-path test/TacVenues.t.sol --fuzz-runs 2000`.
contract TacVenuesTest is Test {
    uint256 constant STEP = 50;
    uint256 constant HEAD = 26_000_061;
    uint256 constant P0 = 9e13; // 0.00009 ETH per TAC; at 4000 USD per ETH that is 0.36 USD per TAC
    uint256 constant DEPTH = 3e18;
    uint256 constant SHORT = 2 hours; // 12 intervals
    address constant OWNER = address(0x0123);

    TestTac tac;
    MockPrecision poolA;
    MockPrecision poolB;
    TacBlockOracle vA;
    TacBlockOracle vB;
    TacPairOracle pair;
    MockFeed feed;
    TacVault vault;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        poolA = new MockPrecision(address(tac), 3.78e18, 3.78e21, 3e20, 3e18, 3e22);
        poolB = new MockPrecision(address(tac), 3.78e18, 3.78e21, 3e20, 3e18, 3e22);
        vA = new TacBlockOracle(address(poolA), address(tac), STEP, SHORT, 3 hours, 6 hours, 6_600);
        vB = new TacBlockOracle(address(poolB), address(tac), STEP, SHORT, 3 hours, 6 hours, 6_600);
        pair = new TacPairOracle(address(vA), address(vB));
        feed = new MockFeed();
        feed.set(4000e8);
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(pair), address(feed), OWNER);
        c.mintRatioBps = 35_000;
        c.liqRatioBps = 20_000;
        c.liqWindow = 6 hours;
        c.liqBonusBps = 2_500;
        c.auctionDuration = 5_400;
        c.ownerWindow = 1_200;
        c.depthBps = 500;
        c.debtCeiling = 10_000e18;
        c.feedMaxStaleness = 3_900;
        vault = new TacVault(c);
        vm.roll(HEAD);
        _setSpot(poolA, P0);
        _setSpot(poolB, P0);
        _fillAll(P0);
        tac.mint(alice, 1_000_000e18);
        tac.mint(bob, 1_000_000e18);
        vm.prank(alice);
        tac.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        tac.approve(address(vault), type(uint256).max);
    }

    // ───────────────────────── helpers ─────────────────────────

    function _newest() internal pure returns (uint256) {
        return (HEAD - 1 - 10) / STEP - 1;
    }

    // Writes (or, with price 0, clears) the sample of the interval `back` before the newest that counts.
    function _putD(TacBlockOracle v, uint256 back, uint256 price, uint256 depth_) internal {
        uint256 index = _newest() - back;
        bytes32 word = price == 0 ? bytes32(0) : bytes32(index << 208 | price << 104 | depth_);
        vm.store(address(v), bytes32(index % 128), word);
    }

    function _put(TacBlockOracle v, uint256 back, uint256 price) internal {
        _putD(v, back, price, DEPTH);
    }

    function _putAt(TacBlockOracle v, uint256 interval, uint256 price) internal {
        vm.store(address(v), bytes32(interval % 128), bytes32(interval << 208 | price << 104 | DEPTH));
    }

    function _fill(TacBlockOracle v, uint256 from, uint256 to, uint256 price) internal {
        for (uint256 i = from; i < to; ++i) {
            _put(v, i, price);
        }
    }

    function _fillAll(uint256 price) internal {
        _fill(vA, 0, 36, price);
        _fill(vB, 0, 36, price);
    }

    // Sets a MockPrecision pool's reserves so that its spot price is (about) `price`.
    function _setSpot(MockPrecision p, uint256 price) internal {
        uint256 v0 = uint256(3e20) * 1e18 / 3.78e21;
        uint256 v1 = uint256(3e20) * 3.78e18 / 1e18;
        uint256 r0 = 3e18;
        uint256 r1 = (v0 + r0) * 1e18 / price - v1;
        p.setReserves(uint128(r0), uint128(r1));
    }

    function _open(address u, uint256 coll, uint256 debt) internal {
        feed.set(4000e8);
        vm.startPrank(u);
        vault.deposit(coll);
        vault.borrow(debt, 0);
        vm.stopPrank();
    }

    function _tick() internal {
        feed.set(4000e8);
    }

    // The market falls to `pct` percent of P0 on both venues, in every sample and in the current price.
    function _crash(uint256 pct) internal {
        _fillAll(P0 * pct / 100);
        _setSpot(poolA, P0 * pct / 100);
        _setSpot(poolB, P0 * pct / 100);
        _tick();
    }

    // ───────────────────────── a venue that no longer follows the market ─────────────────────────

    /// A venue whose samples keep recording one price (a retired pool) holds the pair's `high`, so the liquidation view
    /// stays at that price while the other venue shows the market falling; with both venues at the market the same
    /// vault is liquidated.
    function test_aVenueThatStoppedMovingHoldsTheLiquidationView() public {
        _open(alice, 6_000e18, 590e18); // 2,160 USD of TAC against 590: 366%
        _fill(vA, 0, 36, P0 * 4 / 10);
        _setSpot(poolA, P0 * 4 / 10);
        (uint256 lowP, uint256 highP) = pair.prices(6 hours);
        assertEq(lowP, P0 * 4 / 10, "low follows the live venue");
        assertEq(highP, P0, "high stays at the venue that stopped");
        assertEq(pair.latest(), P0 * 4 / 10, "latest is the lower venue's newest interval");
        _tick();
        assertEq(vault.offerPrice(), P0 * 4000, "the offer follows the liquidation view");
        uint256 usdAtMarket = vault.valueOf(6_000e18, true); // borrow view = the market's low
        assertLt(usdAtMarket * 10_000, 590e18 * 20_000, "underwater at the market price");
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
        assertTrue(vault.liqHealthyView(alice));

        _fill(vB, 0, 36, P0 * 4 / 10);
        _tick();
        vault.liquidate(alice);
        (,, uint256 start) = vault.vaults(alice);
        assertGt(start, 0, "auction opened once both venues show the market");
    }

    /// A venue above the market holds the borrow view's `low` and `spot` down at the other venue's price.
    function test_aVenueAboveTheMarketDoesNotRaiseTheBorrowView() public {
        _fill(vA, 0, 36, P0 * 2);
        _setSpot(poolA, P0 * 2);
        (uint256 lowP, uint256 highP) = pair.prices(3 hours);
        assertEq(lowP, P0);
        assertEq(highP, P0 * 2);
        assertEq(pair.spot() / 1e12, P0 / 1e12);
    }

    // ───────────────────────── directions of the pair's views ─────────────────────────

    /// `low` and the borrow view rise only when both venues rise; `high` and the liquidation and offer views fall only
    /// when both venues fall.
    function test_borrowAndLiquidationViewsMoveOnlyWhenBothVenuesDo() public {
        _fill(vA, 0, 36, P0 * 3);
        _setSpot(poolA, P0 * 3);
        (uint256 low,) = pair.prices(3 hours);
        assertEq(low, P0, "low is the lower of the lows");
        assertEq(vault.valueOf(1e18, true), P0 * 4000, "borrow view at the other venue");
        _fill(vA, 0, 36, P0 / 3);
        _setSpot(poolA, P0 / 3);
        (, uint256 high) = pair.prices(6 hours);
        assertEq(high, P0, "high is the higher of the highs");
        _tick();
        assertEq(vault.liquidationPrice(), P0 * 4000);
        assertEq(vault.offerPrice(), P0 * 4000);
    }

    /// The recovery price is the higher venue's lower median, taken over each window: seven of the twelve newest
    /// intervals of one venue at the old price end an auction (six do not), and then the liquidation view reads the
    /// vault healthy too.
    function test_theRecoveryPriceFollowsTheHigherVenue() public {
        _open(alice, 6_000e18, 590e18);
        _crash(40);
        vault.liquidate(alice);

        _fill(vA, 0, 6, P0);
        _tick();
        assertEq(pair.recovery(SHORT), P0 * 4 / 10);
        assertFalse(vault.recovered(alice));

        _put(vA, 6, P0);
        _tick();
        assertEq(pair.recovery(SHORT), P0);
        assertTrue(vault.recovered(alice));
        skip(1_200);
        _tick();
        vm.prank(bob);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.bid(alice, 100e18, 0);
        vault.cancel(alice);
        (,, uint256 start) = vault.vaults(alice);
        assertEq(start, 0);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
    }

    /// At the 2h window's coverage floor (8 of 12 recorded) a venue's `high` is its second largest recorded value: one
    /// raised sample does not move it, two do.
    function test_atTheCoverageFloorTwoSamplesSetTheUpperMedian() public {
        _fillAll(P0 * 4 / 10);
        for (uint256 i = 8; i < 12; ++i) {
            _put(vA, i, 0);
        }
        _put(vA, 0, P0);
        (uint256 lowA, uint256 highA) = vA.prices(SHORT);
        assertEq(lowA, P0 * 4 / 10);
        assertEq(highA, P0 * 4 / 10);
        _put(vA, 1, P0);
        (, highA) = vA.prices(SHORT);
        assertEq(highA, P0);
    }

    /// `spot()` is read only inside the borrow view's min: a higher one changes nothing, a lower one lowers it, and the
    /// liquidation and offer views ignore it.
    function test_spotOnlyLowersTheBorrowView() public {
        uint256 base = vault.valueOf(1e18, true);
        assertEq(base, P0 * 4000);
        _setSpot(poolA, P0 * 3);
        assertEq(vault.valueOf(1e18, true), base);
        _setSpot(poolA, P0 / 2);
        assertApproxEqRel(vault.valueOf(1e18, true), base / 2, 1e-6 * 1e18);
        assertEq(vault.liquidationPrice(), base);
        assertEq(vault.offerPrice(), base);
    }

    /// `liquidate`, `recovered` and `absorb` read medians only, so the current price of a venue does not slow them.
    function test_liquidateAndAbsorbIgnoreTheCurrentPrice() public {
        _open(alice, 3_000e18, 290e18);
        _open(bob, 6_000e18, 290e18);
        _crash(20);
        _setSpot(poolA, P0 * 3);
        _tick();
        vault.liquidate(alice);
        assertFalse(vault.recovered(alice));
        TacSynth s = vault.SYNTH();
        vm.prank(bob);
        s.transfer(address(vault), 100e18);
        skip(5_400);
        _tick();
        vault.absorb(alice);
        (, uint256 debt,) = vault.vaults(alice);
        assertEq(debt, 190e18);
    }

    // ───────────────────────── no price ─────────────────────────

    /// Borrowing needs the whole 6h window to have a price (the debt cap reads `depthMin(MAX_WINDOW)`), so the vault
    /// does not lend where `liquidate` has none.
    function test_borrowingNeedsThePriceOfTheWholeLongWindow() public {
        _open(alice, 6_000e18, 300e18);
        _fill(vB, 20, 36, 0); // venue B has 20 of 36 six-hour intervals recorded
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        pair.prices(6 hours);
        pair.prices(3 hours); // the shorter windows still have a price
        pair.prices(SHORT);
        _tick();
        vm.prank(bob);
        vault.deposit(6_000e18);
        vm.prank(bob);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(100e18, 0);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.liquidate(alice);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.redeem(alice, 1e18, 0);
        TacSynth s = vault.SYNTH();
        vm.startPrank(alice);
        s.approve(address(vault), type(uint256).max);
        vault.repay(alice, 100e18);
        vault.deposit(1e18);
        vm.stopPrank();
    }

    /// With too few recorded intervals the pair has no price: borrowing, withdrawing from a vault with debt, cancelling
    /// and a non-owner bid are refused; the owner of an auction may still bid and takes its collateral share.
    function test_withoutAPriceTheVaultFailsClosedAndTheOwnerMayStillBid() public {
        _open(alice, 3_000e18, 290e18);
        _open(bob, 6_000e18, 290e18);
        _crash(40);
        vault.liquidate(alice);
        skip(1_200);
        _tick();
        _fill(vB, 0, 6, 0); // only 6 of the 12 intervals of the 2h window remain at venue B
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        pair.prices(SHORT);
        vm.prank(bob);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.withdraw(1e18);
        vm.prank(bob);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(1e18, 0);
        address carol = address(0xCA201);
        vm.prank(carol);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.bid(alice, 100e18, 0);
        vm.expectRevert();
        vault.cancel(alice);
        TacSynth s = vault.SYNTH();
        assertEq(vault.onOffer(alice), 3_000e18);
        vm.startPrank(alice);
        s.approve(address(vault), type(uint256).max);
        vault.bid(alice, 290e18, 0);
        vm.stopPrank();
    }

    // ───────────────────────── the offer and redemption price ─────────────────────────

    /// The offer view is max(liquidation view, `latest()`), `latest()` the LOWER venue's newest recorded interval. The
    /// current price of a venue does not move it, nor does the newest interval of one venue; the newest interval of both
    /// does, and a bid with `minTac` above the offer reverts.
    function test_theOfferFloorsAtTheLowerVenuesNewestInterval() public {
        _open(alice, 3_000e18, 290e18);
        _open(bob, 6_000e18, 290e18);
        _crash(40);
        vault.liquidate(alice);
        skip(1_200);
        _tick();
        uint256 fair = vault.onOffer(alice);
        assertGt(fair, 2_000e18, "at the medians: 290 USD plus 5.5% bonus is 2,125 TAC at 0.144 USD");

        _setSpot(poolA, P0 * 3);
        assertEq(vault.offerPrice(), P0 * 4 / 10 * 4000, "the current price does not move the offer");
        _setSpot(poolA, P0 * 4 / 10);

        _put(vA, 0, P0 * 3);
        assertEq(pair.latest(), P0 * 4 / 10);
        assertEq(vault.offerPrice(), P0 * 4 / 10 * 4000, "one venue's newest interval does not move the offer");
        assertEq(vault.onOffer(alice), fair);

        _put(vB, 0, P0 * 3);
        assertEq(vault.liquidationPrice(), P0 * 4 / 10 * 4000, "one sample does not move the medians");
        assertEq(pair.latest(), P0 * 3);
        assertEq(vault.offerPrice(), P0 * 3 * 4000);
        uint256 raised = vault.onOffer(alice);
        assertApproxEqRel(raised * 3 * 10 / 4, fair, 0.01e18, "7.5x the market gives 7.5x fewer TAC");

        TacSynth s = vault.SYNTH();
        vm.startPrank(bob);
        s.approve(address(vault), type(uint256).max);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.bid(alice, 290e18, fair * 99 / 100);
        uint256 before = tac.balanceOf(bob);
        vault.bid(alice, 290e18, 0);
        vm.stopPrank();
        assertEq(tac.balanceOf(bob) - before, raised);
    }

    /// A venue that has not yet recorded the newest interval keeps its older sample as its newest, which lowers the pair's
    /// `latest` and the offer view toward the liquidation view until it is recorded.
    function test_aVenueMissingTheNewestIntervalLowersTheOfferFloor() public {
        _open(alice, 3_000e18, 290e18);
        _crash(40);
        vm.roll(HEAD + STEP);
        uint256 newest = _newest() + 1;
        _putAt(vB, newest, P0 * 3);
        _tick();
        assertEq(pair.latest(), P0 * 4 / 10);
        assertEq(vault.offerPrice(), P0 * 4 / 10 * 4000);
        _putAt(vA, newest, P0 * 3);
        assertEq(pair.latest(), P0 * 3);
        assertEq(vault.offerPrice(), P0 * 3 * 4000);
    }

    /// One venue's newest interval at the market price takes the floor back to the medians.
    function test_oneVenueAtTheMarketLeavesTheOfferAtTheLiquidationView() public {
        _crash(40);
        _put(vA, 0, P0 * 3);
        _put(vB, 0, P0 * 3);
        assertEq(vault.offerPrice(), P0 * 3 * 4000);
        _put(vB, 0, P0 * 4 / 10);
        assertEq(vault.offerPrice(), P0 * 4 / 10 * 4000);
    }

    /// The offer view falls only when the highs of both venues fall; the newest interval adds no lever of its own.
    function test_theOfferFallsOnlyWhenBothVenuesFall() public {
        _fill(vA, 0, 36, P0 / 5);
        _tick();
        assertEq(vault.offerPrice(), P0 * 4000);
        _fill(vB, 1, 36, P0 / 5);
        _tick();
        assertEq(vault.offerPrice(), P0 / 5 * 4000);
        _put(vB, 0, P0 / 5);
        assertEq(vault.offerPrice(), P0 / 5 * 4000);
    }

    function _redeemExpect(uint256 amount) internal view returns (uint256) {
        uint256 ratio = vault.valueOf(3_000e18, false) * 10_000 / 290e18;
        uint256 fee = 50 + 50 * 3 * (ratio - 20_000) / 20_000;
        return amount * (10_000 - fee) / 10_000 * 1e18 / vault.offerPrice();
    }

    /// The redemption price is the offer view: `redeem` pays amount * (1 - fee) at `offerPrice()`.
    function test_redemptionPaysAtTheOfferPrice() public {
        _open(alice, 3_000e18, 290e18);
        _open(bob, 6_000e18, 290e18);
        TacSynth s = vault.SYNTH();
        vm.prank(bob);
        s.approve(address(vault), type(uint256).max);
        uint256 ratio = vault.valueOf(3_000e18, false) * 10_000 / 290e18;
        assertGt(ratio, 20_000);
        assertLt(ratio, 40_000);
        uint256 expect = _redeemExpect(100e18);
        uint256 before = tac.balanceOf(bob);
        vm.prank(bob);
        uint256 got = vault.redeem(alice, 100e18, 0);
        assertEq(got, expect);
        assertEq(tac.balanceOf(bob) - before, expect);
    }

    /// With the newest interval of both venues at 1.5x the redemption price is 1.5x and the redeemer gets two thirds of
    /// the TAC; with one venue's alone nothing changes.
    function test_redemptionFollowsTheNewestIntervalOfBothVenues() public {
        _open(alice, 3_000e18, 290e18);
        _open(bob, 6_000e18, 290e18);
        TacSynth s = vault.SYNTH();
        vm.prank(bob);
        s.approve(address(vault), type(uint256).max);
        uint256 plain = _redeemExpect(100e18);
        _put(vA, 0, P0 * 3 / 2);
        _tick();
        assertEq(vault.offerPrice(), P0 * 4000);
        _put(vB, 0, P0 * 3 / 2);
        assertEq(vault.offerPrice(), P0 * 3 / 2 * 4000);
        uint256 expect = _redeemExpect(100e18);
        assertApproxEqRel(expect * 3, plain * 2, 1e-9 * 1e18);
        vm.prank(bob);
        assertEq(vault.redeem(alice, 100e18, 0), expect);
    }

    // ───────────────────────── the debt cap ─────────────────────────

    /// The cap is DEPTH_BPS of the smallest depth recorded over the 6h window, on both venues: one smaller interval
    /// lowers it while it is in the window, and an interval older than the window does not count.
    function test_theCapFollowsTheSmallestDepthOfTheWindow() public {
        assertEq(vault.depthCeiling(), DEPTH * 4000 * 500 / 10_000);
        _putD(vA, 20, P0, 0.3e18);
        assertEq(pair.depth(6 hours), DEPTH, "the median does not see it");
        assertEq(pair.depthMin(6 hours), 0.3e18);
        _tick();
        assertEq(vault.depthCeiling(), uint256(0.3e18) * 4000 * 500 / 10_000);
        vm.prank(alice);
        vault.deposit(6_000e18);
        vm.prank(alice);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(100e18, 0);
        _putD(vA, 20, P0, DEPTH);
        _putD(vA, 36, P0, 0.3e18);
        _tick();
        assertEq(vault.depthCeiling(), DEPTH * 4000 * 500 / 10_000);
    }

    /// A depth raised on both venues for 20 of the 36 intervals raises the 3h median but not the cap.
    function test_aDepthRaisedForPartOfTheWindowDoesNotRaiseTheCap() public {
        for (uint256 i; i < 20; ++i) {
            _putD(vA, i, P0, 30e18);
            _putD(vB, i, P0, 30e18);
        }
        assertEq(pair.depth(3 hours), 30e18);
        assertEq(pair.depthMin(6 hours), DEPTH);
        _tick();
        assertEq(vault.depthCeiling(), DEPTH * 4000 * 500 / 10_000);
    }

    /// `depthMin` needs every interval of the 6h window recorded on both venues: one unrecorded interval stops new
    /// borrowing and nothing else (`prices(6h)` keeps its two-thirds coverage and `liquidate` works); recording it
    /// resumes borrowing.
    function test_oneUnrecordedIntervalStopsNewBorrowingAndNothingElse() public {
        _open(alice, 3_000e18, 290e18);
        _put(vB, 10, 0);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        pair.depthMin(6 hours);
        _tick();
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.depthCeiling();
        vm.prank(bob);
        vault.deposit(6_000e18);
        vm.prank(bob);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(100e18, 0);
        pair.prices(6 hours);
        vault.liquidationPrice();
        _put(vB, 10, P0);
        assertEq(pair.depthMin(6 hours), DEPTH);
        _tick();
        vm.prank(bob);
        vault.borrow(100e18, 0);
    }

    // ───────────────────────── the pair's constructor ─────────────────────────

    /// Two venues with different intervals sample different blocks: refused.
    function test_pairRefusesDifferentSteps() public {
        TacBlockOracle v25 = new TacBlockOracle(address(poolB), address(tac), 25, SHORT, 3 hours, 6 hours, 6_600);
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        new TacPairOracle(address(vA), address(v25));
        assertEq(pair.STEP(), STEP);
    }

    /// Two venue oracles over the same pool are one venue, not two: refused.
    function test_pairRefusesTwoOraclesOverOnePool() public {
        TacBlockOracle twin = new TacBlockOracle(address(poolA), address(tac), STEP, SHORT, 3 hours, 6 hours, 6_600);
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        new TacPairOracle(address(vA), address(twin));
    }

    // ───────────────────────── orderings, fuzzed ─────────────────────────

    function _scramble(TacBlockOracle v, uint256 seed, uint256 salt) internal {
        for (uint256 i; i < 36; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, salt, i)));
            if (r % 100 < 12) {
                _put(v, i, 0); // unrecorded
            } else {
                _putD(v, i, P0 * (20 + (r >> 8) % 480) / 100, DEPTH * (10 + (r >> 20) % 190) / 100); // 0.2x..5x, depth 0.1x..2x
            }
        }
    }

    /// Most random scrambles leave every window with a price, so the fuzz below is not vacuous.
    function test_mostScramblesKeepAPrice() public {
        uint256 ok;
        for (uint256 seed; seed < 40; ++seed) {
            _scramble(vA, seed, 1);
            _scramble(vB, seed, 2);
            try pair.prices(6 hours) returns (uint256, uint256) {
                try pair.prices(SHORT) returns (uint256, uint256) {
                    ++ok;
                } catch {}
            } catch {}
        }
        assertGt(ok, 25);
    }

    /// For random samples and current prices on both venues: low <= high and recovery between them in every window,
    /// depthMin <= the median depth, borrow view <= liquidation view <= offer view, the offer at least the lower venue's
    /// newest interval, and a recovered vault is not liquidatable.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_viewsStayOrdered(uint256 seed, uint256 spotA, uint256 spotB) public {
        _open(alice, 6_000e18, 590e18);
        _scramble(vA, seed, 1);
        _scramble(vB, seed, 2);
        _setSpot(poolA, P0 * bound(spotA, 20, 500) / 100);
        _setSpot(poolB, P0 * bound(spotB, 20, 500) / 100);
        _tick();
        uint256[3] memory ws = [SHORT, 3 hours, 6 hours];
        for (uint256 k; k < 3; ++k) {
            try pair.prices(ws[k]) returns (uint256 low, uint256 high) {
                assertLe(low, high, "pair low <= high");
                uint256 rec = pair.recovery(ws[k]);
                assertLe(rec, high, "recovery <= high");
                assertGe(rec, low, "recovery >= low");
                try pair.depthMin(ws[k]) returns (uint256 dmin) {
                    assertLe(dmin, pair.depth(ws[k]), "depthMin <= median depth");
                } catch {} // reverts unless every interval is recorded
            } catch {}
        }
        try vault.liquidationPrice() returns (uint256 liq) {
            try vault.valueOf(1e18, true) returns (uint256 borrowP) {
                assertLe(borrowP, liq, "borrow view <= liquidation view");
            } catch {}
            uint256 offer = vault.offerPrice();
            assertGe(offer, liq, "offer >= liquidation");
            assertGe(offer, pair.latest() * 4000, "offer >= the lower venue's newest interval");
            assertEq(pair.latest(), vA.latest() < vB.latest() ? vA.latest() : vB.latest());
            if (vault.recovered(alice)) assertTrue(vault.liqHealthyView(alice), "recovered => not liquidatable");
        } catch {}
    }

    // ───────────────────────── gas of the views the vault calls ─────────────────────────

    /// The views a bid, a liquidation or a borrow reads stay well inside a block's gas.
    function test_gasOfTheViews() public {
        _open(alice, 6_000e18, 590e18);
        _tick();
        uint256 g = gasleft();
        vault.valueOf(1e18, true);
        uint256 borrowView = g - gasleft();
        g = gasleft();
        vault.liquidationPrice();
        uint256 liqView = g - gasleft();
        g = gasleft();
        vault.offerPrice();
        uint256 offerView = g - gasleft();
        g = gasleft();
        vault.recovered(alice);
        uint256 recView = g - gasleft();
        g = gasleft();
        vault.depthCeiling();
        uint256 depthView = g - gasleft();
        assertLt(borrowView, 200_000);
        assertLt(liqView, 250_000);
        assertLt(offerView, 250_000);
        assertLt(recView, 250_000);
        assertLt(depthView, 200_000);
    }
}
