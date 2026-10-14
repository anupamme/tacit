// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {MockPrecision} from "./MockPrecision.sol";
import {TestTac, LiveFeed} from "./TacVaultMocks.sol";

/// The confidential pool's `pools` and `assets` reads, as much as TacAmmOracle uses: its constructor checks and the
/// live reserves.
contract TacSystemMockV1 {
    bytes32 public constant ETH_ID = bytes32(uint256(1));
    bytes32 public constant TAC_ID = bytes32(uint256(2));
    bytes32 public constant POOL_ID = bytes32(uint256(0xabc));
    address public tac;
    uint256 public reserveA = 1.87e8; // 1.87 ETH in 1e10 units
    uint256 public reserveB = 2e12; // 20,000 TAC in 1e10 units

    constructor(address tac_) {
        tac = tac_;
    }

    function setReserves(uint256 a, uint256 b) external {
        (reserveA, reserveB) = (a, b);
    }

    function pools(bytes32 id) external view returns (bool, bytes32, bytes32, uint256, uint256, uint32, uint256) {
        return (id == POOL_ID, ETH_ID, TAC_ID, reserveA, reserveB, 30, 1e9);
    }

    function assets(bytes32 id) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        return (true, id == ETH_ID ? address(0) : tac, 1e10, bytes32(0), false, 18);
    }
}

/// The deployed shape on a local chain: a TacPairOracle over a TacBlockOracle and a TacAmmOracle (samples written into
/// their rings, live prices from two mock pools whose reserves feed the real spot formulas) behind a TacVault with the
/// deploy script's parameters. Alice, bob and carol hold TAC and have approved the vault.
abstract contract TacSystemBase is Test {
    uint256 constant STEP = 50;
    uint256 constant HEAD = 26_000_061; // the newest counted interval is 520,000
    uint256 constant P0 = 9.35e13; // ETH per TAC (wei) at the fork block
    uint256 constant DEPTH = 1e22; // ETH depth per sample, large enough not to bind unless a test sets it
    uint256 constant ETH_USD = 2500; // LiveFeed's answer

    TestTac tac;
    MockPrecision prec;
    TacSystemMockV1 v1;
    TacBlockOracle precision;
    TacAmmOracle amm;
    TacPairOracle pair;
    TacVault vault;
    TacSynth synth;
    LiveFeed feed;
    address constant OWNER = address(0x0123);
    address constant SINK = address(0xdEaD);
    address constant FEE_TO = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        feed = new LiveFeed();
        prec = new MockPrecision(address(tac), 3.78e18, 3.78e21, 3e20, 3e18, 3e22);
        v1 = new TacSystemMockV1(address(tac));
        // the deploy script's oracles: interval 50 blocks, windows 2h / 3h / 6h, two thirds coverage
        precision = new TacBlockOracle(address(prec), address(tac), STEP, 7_200, 10_800, 21_600, 6_600);
        amm = new TacAmmOracle(
            address(v1), v1.POOL_ID(), v1.ETH_ID(), v1.TAC_ID(), address(tac), 74, STEP, 7_200, 10_800, 21_600, 6_600
        );
        pair = new TacPairOracle(address(precision), address(amm));
        vault = _vault(21_600);
        synth = vault.SYNTH();
        vm.roll(HEAD);
        _setSpots(P0, P0);
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            tac.mint(users[i], 10_000_000e18);
            vm.startPrank(users[i]);
            tac.approve(address(vault), type(uint256).max);
            synth.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _vault(uint256 liqWindow) internal returns (TacVault) {
        return new TacVault(
            TacVault.Config({
                tac: address(tac),
                oracle: address(pair),
                ethUsd: address(feed),
                owner: OWNER,
                mintRatioBps: 35_000,
                liqRatioBps: 20_000,
                liqWindow: liqWindow,
                liqBonusBps: 2_500,
                auctionDuration: 5_400,
                ownerWindow: 1_200,
                minDebt: 100e18,
                feedMaxStaleness: 3_900,
                debtCeiling: type(uint256).max,
                depthBps: 500,
                redemptionFeeBps: 50,
                borrowFeeBps: 100,
                feeTo: FEE_TO,
                tacSink: SINK,
                name: "TAC Dollar",
                symbol: "TACD"
            })
        );
    }

    // The live price of each venue: the mock pools' reserves solve the real spot formulas for it.
    function _setSpots(uint256 precisionPrice, uint256 ammPrice) internal {
        uint256 virtEth = uint256(3e20) * 1e18 / 3.78e21;
        uint256 virtTac = uint256(3e20) * 3.78e18 / 1e18;
        uint256 r1 = 3e22;
        prec.setReserves(uint128(precisionPrice * (virtTac + r1) / 1e18 - virtEth), uint128(r1));
        v1.setReserves(ammPrice * 2e12 / 1e18, 2e12);
    }

    function _newest() internal view returns (uint256) {
        return (block.number - 1 - precision.GRACE()) / STEP - 1;
    }

    function _put(TacIntervalOracle o, uint256 interval, uint256 price, uint256 depth) internal {
        vm.store(address(o), bytes32(interval % 128), bytes32(interval << 208 | price << 104 | depth));
    }

    function _clear(TacIntervalOracle o, uint256 interval) internal {
        vm.store(address(o), bytes32(interval % 128), bytes32(0));
    }

    /// Positions `from`..`to` back from the newest counted interval.
    function _fill(TacIntervalOracle o, uint256 from, uint256 to, uint256 price) internal {
        uint256 newest = _newest();
        for (uint256 i = from; i <= to; ++i) {
            _put(o, newest - i, price, DEPTH);
        }
    }

    function _fillBoth(uint256 price) internal {
        _fill(precision, 0, 35, price);
        _fill(amm, 0, 35, price);
    }

    /// History and live price of both venues at `price`.
    function _market(uint256 price) internal {
        _fillBoth(price);
        _setSpots(price, price);
    }

    function _open(address u, uint256 coll, uint256 debt) internal {
        vm.startPrank(u);
        vault.deposit(coll);
        vault.borrow(debt, 100);
        vm.stopPrank();
    }

    function _v(address u) internal view returns (uint256 coll, uint256 debt, uint256 start) {
        (coll, debt, start) = vault.vaults(u);
    }

    /// Alice with 100,000 TAC and 6,060 USD of debt at P0 (a 385% vault); carol with 7,000 dollars to bid with.
    function _aliceAndCarol() internal {
        _market(P0);
        _open(alice, 100_000e18, 6_000e18);
        _open(carol, 2_000_000e18, 7_000e18);
    }

    /// The ETH price at which alice's vault (100,000 TAC, 6,060 USD) is worth `bps` percent of its debt.
    function _priceForRatio(uint256 bps) internal pure returns (uint256) {
        return 6_060e18 * bps / 100 / 100_000 / ETH_USD;
    }
}

/// A venue that has stopped tracking the market keeps the pair's highs and recovery price at its own level, as the
/// TacPairOracle and TacVault notes describe; the other venue alone cannot move them.
contract TacSystemStoppedVenueTest is TacSystemBase {
    function test_aVenueThatStoppedTrackingKeepsLiquidationOutOfReach() public {
        _aliceAndCarol();
        // TAC loses 70% on the Precision pool; the confidential pool's venue stays at the old price
        uint256 crashed = P0 * 3 / 10;
        _fill(precision, 0, 35, crashed);
        _setSpots(crashed, P0);
        uint256 trueValue = 100_000e18 * crashed / 1e18 * ETH_USD;
        assertLt(trueValue * 10_000 / 6_060e18, 20_000, "under the liquidation ratio at the lower venue's price");

        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
        assertTrue(vault.liqHealthyView(alice));

        // with both venues following, liquidation opens
        _fill(amm, 0, 35, crashed);
        _setSpots(crashed, crashed);
        assertFalse(vault.liqHealthyView(alice));
        vault.liquidate(alice);
    }

    function test_aVenueThatStoppedTrackingEndsAnAuctionAndBlocksOutsideBids() public {
        _aliceAndCarol();
        _market(P0 * 3 / 10);
        vault.liquidate(alice);
        skip(2_700);
        _fill(amm, 0, 35, P0); // one venue's whole window reads the old price
        assertTrue(vault.recovered(alice), "the recovery view is the higher of the venues' lows");
        vm.prank(carol);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.bid(alice, 1_000e18, 0);
        vault.cancel(alice);
        (,, uint256 start) = _v(alice);
        assertEq(start, 0);
    }

    /// The pair's `latest` is the lower venue's newest recorded price: one venue's high sample leaves the offer where
    /// it was, both venues' raise it until the next interval is recorded, and one new low sample releases it.
    function test_oneVenuesNewestSampleDoesNotMoveTheOffer() public {
        _aliceAndCarol();
        uint256 crashed = P0 * 36 / 100;
        _market(crashed);
        vault.liquidate(alice);
        skip(1_200);
        uint256 base = vault.onOffer(alice);
        _put(amm, _newest(), P0, DEPTH);
        assertEq(pair.latest(), crashed);
        assertEq(vault.onOffer(alice), base);
        _put(precision, _newest(), P0, DEPTH);
        uint256 raised = vault.onOffer(alice);
        assertLt(raised, base * 40 / 100, "both venues' samples at the old price cut the TAC a bid takes");
        uint256 liq = vault.liquidationPrice();
        vm.roll(block.number + 50);
        assertEq(vault.onOffer(alice), raised, "the newest interval is not recorded yet");
        _put(amm, _newest(), crashed, DEPTH);
        assertEq(vault.liquidationPrice(), liq, "the liquidation view is a median: one sample does not move it");
        assertEq(vault.onOffer(alice), base);
    }

    /// A venue without a recorded sample gives 0, so the offer has no floor from it rather than failing.
    function test_pairLatestIsTheLowerVenue() public {
        _fillBoth(P0);
        _put(precision, _newest(), P0 * 3, DEPTH);
        assertEq(pair.latest(), P0);
        _put(amm, _newest(), P0 * 5, DEPTH);
        assertEq(pair.latest(), P0 * 3);
        for (uint256 i; i < 36; ++i) {
            _clear(amm, _newest() - i);
        }
        assertEq(pair.latest(), 0);
    }

    function test_theDebtCapIsAShareOfTheSmallerVenuesDepth() public {
        for (uint256 i; i < 36; ++i) {
            _put(precision, _newest() - i, P0, 3.1e18);
            _put(amm, _newest() - i, P0, 2.2e18);
        }
        assertEq(vault.depthCeiling(), 2.2e18 * ETH_USD * 500 / 10_000, "5% of the smaller venue's ETH depth in USD");
    }
}

/// What the owner can change: the debt ceiling and the borrow fee, and nothing else.
contract TacSystemOwnerTest is TacSystemBase {
    function test_theOwnerOnlySetsTheCeilingAndTheFee() public {
        _market(P0);
        _open(alice, 100_000e18, 3_000e18);
        (uint256 collBefore, uint256 debtBefore,) = _v(alice);
        uint256 supplyBefore = synth.totalSupply();

        vm.startPrank(OWNER);
        vault.setDebtCeiling(type(uint256).max);
        vault.setBorrowFee(500);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.setBorrowFee(501);
        vault.transferOwnership(address(0xBAD));
        vm.stopPrank();

        vm.startPrank(address(0xBAD));
        vault.setDebtCeiling(0);
        vault.setDebtCeiling(type(uint256).max);
        vm.stopPrank();

        (uint256 collAfter, uint256 debtAfter,) = _v(alice);
        assertEq(collAfter, collBefore);
        assertEq(debtAfter, debtBefore);
        assertEq(synth.totalSupply(), supplyBefore);
        assertEq(tac.balanceOf(address(vault)), 100_000e18);

        // the highest fee only reaches a borrower who accepts it
        vm.prank(bob);
        vault.deposit(100_000e18);
        vm.prank(bob);
        vm.expectRevert(TacVault.FeeTooHigh.selector);
        vault.borrow(1_000e18, 100);
        vm.prank(bob);
        vault.borrow(1_000e18, 500);

        // an unbounded ceiling still meets the depth cap: depth 3 ETH allows 375 USD
        for (uint256 i; i < 36; ++i) {
            _put(precision, _newest() - i, P0, 3e18);
            _put(amm, _newest() - i, P0, 3e18);
        }
        vm.prank(bob);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(1_000e18, 500);
    }

    /// The constructor refuses an owner window that is not shorter than the auction and a liquidation window that is
    /// not the oracle's longest.
    function test_theConstructorBoundsTheAuctionAndTheWindows() public {
        TacVault.Config memory c = TacVault.Config({
            tac: address(tac),
            oracle: address(pair),
            ethUsd: address(feed),
            owner: OWNER,
            mintRatioBps: 35_000,
            liqRatioBps: 20_000,
            liqWindow: 21_600,
            liqBonusBps: 2_500,
            auctionDuration: 5_400,
            ownerWindow: 5_400,
            minDebt: 100e18,
            feedMaxStaleness: 3_900,
            debtCeiling: 0,
            depthBps: 500,
            redemptionFeeBps: 50,
            borrowFeeBps: 100,
            feeTo: FEE_TO,
            tacSink: SINK,
            name: "x",
            symbol: "x"
        });
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.ownerWindow = 5_399;
        new TacVault(c);
        c.liqWindow = 14_400;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.liqWindow = 21_600 + 600;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
    }
}

/// An outside bid needs an offer price, and the offer price and the recovery view fail together: they read the same
/// windows and the same feed. No live price takes part in the offer.
contract TacSystemBidGuardTest is TacSystemBase {
    /// A venue whose live price cannot be read (its pool empty) stops the borrow view, which takes a minimum with
    /// `spot()`, and nothing else; an outside bid still works.
    function test_anUnreadableLivePriceStopsBorrowingNotBids() public {
        _aliceAndCarol();
        _market(_priceForRatio(139));
        vault.liquidate(alice);
        skip(1_300);
        (uint256 collateral, uint256 debt,) = _v(alice);

        v1.setReserves(0, 2e12); // spot() of the AMM venue reverts; its recorded history is untouched
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        vault.valueOf(1e18, true);
        assertFalse(vault.recovered(alice));
        assertGt(vault.offerPrice(), 0);
        assertLt(vault.onOffer(alice), collateral);
        vm.prank(carol);
        uint256 taken = vault.bid(alice, debt, 0);
        assertGt(taken, 0);
        assertLt(taken, collateral);
    }

    /// Without a price only the owner may bid, and she takes her own share of the collateral for the debt she repays.
    function test_anOwnerBidWithoutAPriceIsProRata() public {
        _aliceAndCarol();
        _market(_priceForRatio(139));
        vault.liquidate(alice);
        skip(1_300);
        (uint256 collateral, uint256 debt,) = _v(alice);
        for (uint256 i = 20; i < 36; ++i) {
            _clear(precision, _newest() - i);
            _clear(amm, _newest() - i);
        }
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.offerPrice();
        assertEq(vault.onOffer(alice), collateral);
        vm.prank(carol);
        synth.transfer(alice, 6_060e18);
        vm.prank(alice);
        uint256 taken = vault.bid(alice, debt / 2, 0);
        assertEq(taken, collateral / 2);
    }

    function test_aNonOwnerBidWithoutAPriceReverts() public {
        _aliceAndCarol();
        _market(_priceForRatio(139));
        vault.liquidate(alice);
        skip(1_300);
        (, uint256 debt,) = _v(alice);
        for (uint256 i = 23; i < 36; ++i) {
            _clear(precision, _newest() - i);
            _clear(amm, _newest() - i);
        }
        // 23 of 36 intervals recorded: under two thirds
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.recovered(alice);
        vm.prank(carol);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.bid(alice, debt, 0);
    }
}

contract TacSystemAuctionTest is TacSystemBase {
    function _auction(uint256 ratioBps) internal returns (uint256 debt, uint256 collateral) {
        _aliceAndCarol();
        _market(_priceForRatio(ratioBps));
        vault.liquidate(alice);
        (collateral, debt,) = _v(alice);
    }

    /// Outsiders wait OWNER_WINDOW from the start of the auction; the owner never does.
    function test_anOutsiderBidWaitsForTheOwnerWindow() public {
        (uint256 debt,) = _auction(190);
        vm.prank(carol);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, 700e18, 0);
        skip(1_199);
        vm.prank(carol);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, 700e18, 0);
        skip(1);
        vm.prank(carol);
        uint256 taken = vault.bid(alice, 700e18, 0);
        assertGt(taken, 0);
        (, uint256 d,) = _v(alice);
        assertEq(d, debt - 700e18);
    }

    function test_theOwnerBidsAtZeroBonusFromTheFirstSecond() public {
        (, uint256 collateral) = _auction(190);
        vm.prank(alice);
        uint256 taken = vault.bid(alice, 700e18, 0);
        // no bonus yet: the TAC worth 700 USD at the offer price
        uint256 offer = vault.offerPrice();
        assertApproxEqAbs(taken, 700e18 * 1e18 / offer, 1e6);
        assertLt(taken, collateral);
        (,, uint256 start) = _v(alice);
        assertEq(start, 0, "700 of 6,060 (11.5%) brings a 190% vault back over the line: the auction ends");
    }

    /// A bid that brings the vault back above the line ends the auction; a smaller one leaves it running.
    function test_aBidThatRestoresTheVaultEndsTheAuction() public {
        _auction(190);
        skip(1_200); // bonus 555 bps: (1.9 - f * 1.0555) / (1 - f) >= 2 needs f >= 10.6% of the debt
        uint256 snap = vm.snapshotState();

        vm.prank(carol);
        vault.bid(alice, 300e18, 0); // 4.95% of the debt
        (,, uint256 s1) = _v(alice);
        assertGt(s1, 0, "300 of 6,060 does not bring it back");
        assertFalse(vault.recovered(alice));
        vm.prank(carol);
        vault.bid(alice, 500e18, 0);
        (,, uint256 s2) = _v(alice);
        assertEq(s2, 0, "after 800 (13.2%) it is at 200% at the recovery view");

        vm.revertToState(snap);
        vm.prank(carol);
        vault.bid(alice, 700e18, 0); // 11.5% in one bid
        (,, uint256 s3) = _v(alice);
        assertEq(s3, 0);
        // the recovery view never exceeds the liquidation view, so it cannot be liquidated again at once
        assertTrue(vault.liqHealthyView(alice));
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
    }

    function test_aFullBidEndsTheAuctionAndReturnsTheRest() public {
        (uint256 debt, uint256 collateral) = _auction(190);
        skip(1_200);
        uint256 expected = vault.onOffer(alice);
        vm.prank(carol);
        uint256 taken = vault.bid(alice, debt, 0);
        assertEq(taken, expected);
        (uint256 c, uint256 d, uint256 s) = _v(alice);
        assertEq(d, 0);
        assertEq(s, 0);
        assertEq(c, collateral - taken);
        assertEq(synth.totalSupply(), vault.totalDebt());
    }

    /// The offer is at least the lower venue's newest recorded price, so a rally the medians have not caught up with
    /// does not sell TAC at the stale price; one venue's sample alone does nothing.
    function test_theOfferFloorsAtTheNewestRecordedPrice() public {
        _auction(150);
        skip(1_200);
        uint256 base = vault.onOffer(alice);
        uint256 liq = vault.liquidationPrice();
        uint256 crashed = _priceForRatio(150);
        _put(precision, _newest(), crashed * 2, DEPTH);
        assertEq(vault.offerPrice(), liq);
        assertEq(vault.onOffer(alice), base);
        _put(amm, _newest(), crashed * 2, DEPTH);
        assertEq(vault.offerPrice(), liq * 2);
        assertEq(vault.liquidationPrice(), liq);
        assertApproxEqRel(vault.onOffer(alice), base / 2, 0.001e18);
        // a lower newest sample on either venue lowers it back
        _put(amm, _newest(), crashed, DEPTH);
        assertEq(vault.onOffer(alice), base);
        _put(amm, _newest(), crashed / 2, DEPTH);
        _put(precision, _newest(), crashed / 2, DEPTH);
        assertEq(vault.onOffer(alice), base);
    }

    /// The live price of a block takes no part in the offer or in what a bid takes.
    function test_theLivePriceDoesNotMoveABid() public {
        _auction(150);
        skip(1_200);
        uint256 expected = vault.onOffer(alice) * 3_000e18 / 6_060e18;
        uint256 crashed = _priceForRatio(150);
        _setSpots(crashed * 13 / 10, crashed * 3);
        assertEq(vault.onOffer(alice) * 3_000e18 / 6_060e18, expected);
        vm.prank(carol);
        uint256 taken = vault.bid(alice, 3_000e18, expected);
        assertEq(taken, expected);
    }

    /// The bonus grows from zero at the start of the auction, so the first outside bid carries the bonus earned by
    /// OWNER_WINDOW: 2,500 bps * 1,200 / 5,400 = 555 bps.
    function test_theFirstOutsideBidCarriesTheBonusEarnedByTheOwnerWindow() public {
        _auction(150);
        skip(1_200);
        vm.prank(carol);
        uint256 taken = vault.bid(alice, 1_000e18, 0);
        uint256 worth = taken * vault.offerPrice() / 1e18;
        assertApproxEqRel(worth, 1_000e18 * 10_555 / 10_000, 0.0005e18);
    }

    /// Redemption prices at the offer view; the live price takes no part, one venue's newest sample does nothing, and
    /// both venues' halve the TAC a redeemer receives.
    function test_redemptionPricesAtTheOfferView() public {
        _aliceAndCarol();
        _market(P0);
        vm.prank(carol);
        uint256 tacOut = vault.redeem(alice, 50e18, 0);
        uint256 fee = 50 + 50 * 3 * (uint256(38_500) - 20_000) / 20_000;
        assertApproxEqRel(tacOut, 50e18 * (10_000 - fee) / 10_000 * 1e18 / (P0 * ETH_USD), 0.01e18);
        _setSpots(P0 * 2, P0 * 2);
        vm.prank(carol);
        uint256 tacLive = vault.redeem(alice, 50e18, 0);
        assertApproxEqRel(tacLive, tacOut, 0.01e18);
        _put(precision, _newest(), P0 * 2, DEPTH);
        vm.prank(carol);
        uint256 tacOne = vault.redeem(alice, 50e18, 0);
        assertApproxEqRel(tacOne, tacOut, 0.02e18);
        _put(amm, _newest(), P0 * 2, DEPTH);
        vm.prank(carol);
        uint256 tacBoth = vault.redeem(alice, 50e18, 0);
        assertLt(tacBoth, tacOut * 55 / 100);
    }
}

/// The debt cap is DEPTH_BPS of the smallest depth recorded over the longest window, and needs every interval of that
/// window recorded on both venues.
contract TacSystemDepthCapTest is TacSystemBase {
    function _depths(uint256 base) internal {
        for (uint256 i; i < 36; ++i) {
            _put(precision, _newest() - i, P0, base);
            _put(amm, _newest() - i, P0, base);
        }
    }

    function test_theCapFollowsTheThinnestInterval() public {
        _market(P0);
        _depths(3e18);
        _put(amm, _newest() - 11, P0, 0.3e18);
        assertEq(vault.depthCeiling(), 0.3e18 * ETH_USD * 500 / 10_000);
        assertEq(pair.depth(21_600), 3e18, "the median ignores the one thin interval");
        vm.startPrank(alice);
        vault.deposit(1_000_000e18);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(100e18, 100);
        vm.stopPrank();
    }

    function test_aDepthLiftedForPartOfTheWindowDoesNotRaiseTheCap() public {
        _market(P0);
        _depths(3e18);
        for (uint256 i; i < 30; ++i) {
            _put(precision, _newest() - i, P0, 100e18);
            _put(amm, _newest() - i, P0, 100e18);
        }
        assertEq(vault.depthCeiling(), 3e18 * ETH_USD * 500 / 10_000);
        assertEq(pair.depth(10_800), 100e18, "the median of the 3h window follows the lift");
    }

    /// The cap limits new borrowing only: open debt stays when depth falls, and repay and withdraw keep working.
    function test_aFallingDepthLeavesOpenDebtAlone() public {
        _aliceAndCarol();
        _depths(0.1e18);
        assertLt(vault.depthCeiling(), vault.totalDebt());
        vm.prank(alice);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(100e18, 100);
        vm.prank(alice);
        vault.withdraw(1e18);
        vm.prank(carol);
        synth.transfer(alice, 100e18); // the fee SYNTH went to FEE_TO: alice needs a little to close
        vm.prank(alice);
        vault.repay(alice, type(uint256).max);
        (, uint256 debt,) = _v(alice);
        assertEq(debt, 0);
    }

    function test_anUnrecordedIntervalStopsBorrowingUntilItIsRecorded() public {
        _market(P0);
        _depths(3e18);
        _put(amm, _newest() - 11, P0, 0.3e18);
        uint256 thin = vault.depthCeiling();
        _clear(amm, _newest() - 11);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.depthCeiling();
        vm.startPrank(alice);
        vault.deposit(1_000_000e18);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(100e18, 100);
        vm.stopPrank();
        _put(amm, _newest() - 11, P0, 0.3e18);
        assertEq(vault.depthCeiling(), thin);
    }

    /// With one interval missing on one venue the prices (two thirds coverage) still work, so everything but new
    /// borrowing does: withdraw with debt, redemption, liquidation and outside bids.
    function test_oneMissingIntervalStopsOnlyNewBorrowing() public {
        _aliceAndCarol();
        _clear(precision, _newest() - 7);
        vm.prank(alice);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(100e18, 100);
        assertGt(vault.liquidationPrice(), 0);
        vm.prank(alice);
        vault.withdraw(1e18);
        vm.prank(carol);
        vault.redeem(alice, 150e18, 0);
        _market(_priceForRatio(139));
        _clear(amm, _newest() - 3);
        vault.liquidate(alice);
        skip(1_300);
        vm.prank(carol);
        vault.bid(alice, 1_000e18, 0);
    }
}

/// Right after deployment, after a keeper outage and after restoration.
contract TacSystemLifecycleTest is TacSystemBase {
    /// Before any interval is recorded nothing that needs a price happens, and nothing that does not is blocked.
    function test_nothingNeedingAPriceHappensBeforeTheFirstSamples() public {
        vm.startPrank(alice);
        vault.deposit(100_000e18);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(1_000e18, 100);
        vm.stopPrank();
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.liquidationPrice();
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.depthCeiling();
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.offerPrice();
        assertEq(vault.onOffer(alice), 0);
        assertEq(pair.latest(), 0);
        assertGt(pair.spot(), 0, "the live price needs no history");
        vm.prank(alice);
        vault.withdraw(type(uint256).max);
        assertEq(tac.balanceOf(alice), 10_000_000e18);
    }

    /// After five hours without a record the prices are gone; repay and deposit still work. Recording the newest 24
    /// intervals brings the prices back (two thirds of every window), and new debt needs the other six too.
    function test_aLongOutageThenRestoration() public {
        _aliceAndCarol();
        vm.roll(block.number + 1_500);
        vm.warp(block.timestamp + 5 hours);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.liquidationPrice();
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.valueOf(1e18, true);
        vm.prank(alice);
        vault.deposit(1_000e18);
        vm.prank(carol);
        synth.transfer(alice, 100e18);
        vm.prank(alice);
        vault.repay(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.withdraw(1e18);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.liquidate(alice);
        vm.prank(alice);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(100e18, 100);
        // the six oldest intervals of the window were recorded before the outage
        for (uint256 i; i < 24; ++i) {
            _put(precision, _newest() - i, P0, DEPTH);
            _put(amm, _newest() - i, P0, DEPTH);
        }
        assertGt(vault.liquidationPrice(), 0);
        vm.prank(alice);
        vault.withdraw(1e18);
        vm.prank(alice);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        vault.borrow(100e18, 100);
        for (uint256 i = 24; i < 30; ++i) {
            _put(precision, _newest() - i, P0, DEPTH);
            _put(amm, _newest() - i, P0, DEPTH);
        }
        vm.prank(alice);
        vault.borrow(100e18, 100);
    }
}

/// The relations between the vault's views that its state machine relies on, over arbitrary ring contents of the pair
/// (any recorded subset, any prices, independent per venue, any live prices): the recovery view never exceeds the
/// liquidation view, which never exceeds the offer view. So a liquidatable vault is never already recovered, and every
/// price-dependent view has a price or none does.
contract TacSystemViewsTest is TacSystemBase {
    function _random(uint256 mask, uint256 seedA, uint256 seedB) internal {
        uint256 newest = _newest();
        for (uint256 i; i < 36; ++i) {
            _clear(precision, newest - i);
            _clear(amm, newest - i);
            // the precision venue is recorded where the low 36 bits say, the AMM venue where the next 36 do
            if (mask >> i & 1 == 1) {
                _put(precision, newest - i, 1e12 + uint256(keccak256(abi.encode(seedA, i))) % 1e15, DEPTH);
            }
            if (mask >> (36 + i) & 1 == 1) {
                _put(amm, newest - i, 1e12 + uint256(keccak256(abi.encode(seedB, i))) % 1e15, DEPTH);
            }
        }
        // live prices from 3e12 up: the mock Precision reserves cannot express less than their virtual reserves give
        _setSpots(
            3e12 + uint256(keccak256(abi.encode(seedA, "spot"))) % 1e15,
            3e12 + uint256(keccak256(abi.encode(seedB, "spot"))) % 1e15
        );
    }

    function _plant(address who, uint256 coll, uint256 debt) internal {
        bytes32 base = keccak256(abi.encode(who, uint256(0))); // `vaults` is storage slot 0
        vm.store(address(vault), base, bytes32(coll));
        vm.store(address(vault), bytes32(uint256(base) + 1), bytes32(debt));
    }

    function testFuzz_theViewsAreOrdered(uint256 mask, uint256 seedA, uint256 seedB, uint256 coll, uint256 debt)
        public
    {
        _random(mask, seedA, seedB);
        _plant(alice, bound(coll, 1_000e18, 5_000_000e18), bound(debt, 100e18, 100_000e18));

        bool hasPrice = true;
        uint256 liq;
        try vault.liquidationPrice() returns (uint256 p) {
            liq = p;
        } catch {
            hasPrice = false;
        }
        if (hasPrice) {
            assertGe(vault.offerPrice(), liq, "offer >= liquidation");
            bool healthy = vault.liqHealthyView(alice);
            bool rec = vault.recovered(alice);
            if (!healthy) assertFalse(rec, "a liquidatable vault is not recovered");
            if (rec) assertTrue(healthy, "a recovered vault is not liquidatable");
        } else {
            vm.expectRevert();
            vault.recovered(alice);
            vm.expectRevert();
            vault.offerPrice();
        }
    }
}
