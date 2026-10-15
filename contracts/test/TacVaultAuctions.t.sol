// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TestTac, MockFeed, VaultConfig} from "./TacVaultMocks.sol";
import {MockPrecision} from "./MockPrecision.sol";
import {TacVaultCampaignOracle} from "./TacVaultCampaign.t.sol";

// Auction behaviour of TacVault: the owner window, the offer price and its floor, partial bids and absorbs, the end of
// an auction, the debt cap, and the gas a bid needs. Two oracle setups: a mock oracle with selectable outages
// (TacVaultAuctionBase) and the real interval oracles over mock pools, paired (TacVaultRealOracleBase).

/// A deploy-shaped vault (200% liquidation, 25% bonus, 5,400 s auction, 1,200 s owner window) on the campaign oracle.
abstract contract TacVaultAuctionBase is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant OWNER_WINDOW = 1_200;
    TestTac tac;
    TacVaultCampaignOracle oracle;
    MockFeed feed;
    TacVault vault;
    TacSynth synth;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function _config(address orc, address fd) internal view returns (TacVault.Config memory c) {
        c = VaultConfig.defaults(address(tac), orc, fd, address(0x0123));
        c.mintRatioBps = 35_000;
        c.liqRatioBps = 20_000;
        c.liqBonusBps = 2_500;
        c.auctionDuration = 5_400;
        c.ownerWindow = OWNER_WINDOW;
        c.borrowFeeBps = 0;
        c.redemptionFeeBps = 50;
        c.feedMaxStaleness = 3_900;
        c.depthBps = 500;
        c.minDebt = 100e18;
        c.debtCeiling = 1_000_000e18;
    }

    function _setUp() internal {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        oracle = new TacVaultCampaignOracle();
        oracle.setDepth(2_000e18);
        feed = new MockFeed();
        feed.set(4000e8);
        vault = new TacVault(_config(address(oracle), address(feed)));
        synth = vault.SYNTH();
        _fund();
    }

    function _fund() internal {
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            tac.mint(users[i], 10_000_000e18);
            vm.startPrank(users[i]);
            tac.approve(address(vault), type(uint256).max);
            synth.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _open(address u, uint256 coll, uint256 debt) internal {
        vm.startPrank(u);
        vault.deposit(coll);
        vault.borrow(debt, 0);
        vm.stopPrank();
    }

    /// The ETH per TAC (1e18) at which `coll` TAC is worth `ratioBps` of `debt`, with the ETH/USD feed at 4,000.
    function _priceFor(uint256 coll, uint256 debt, uint256 ratioBps) internal pure returns (uint256 ethPerTac) {
        uint256 pSyn = debt * ratioBps / BPS * WAD / coll;
        ethPerTac = pSyn * 1e8 / 4000e8;
    }

    function _wait(uint256 s) internal {
        skip(s);
        feed.set(4000e8);
    }
}

/// The real oracle stack: two interval oracles over mock pools, their pair, and a vault on it.
abstract contract TacVaultRealOracleBase is TacVaultAuctionBase {
    uint256 constant STEP = 50;
    uint256 constant HEAD = 26_000_061;
    TacBlockOracle a;
    TacBlockOracle b;
    TacPairOracle pair;
    MockPrecision poolA;
    MockPrecision poolB;

    function _shortWindow() internal pure virtual returns (uint256) {
        return 7_200;
    }

    function _venue(MockPrecision pool, uint256 back, uint256 price, uint256 depth_) internal {
        TacBlockOracle o = pool == poolA ? a : b;
        uint256 index = (HEAD - 1 - o.GRACE()) / STEP - 1 - back;
        vm.store(address(o), bytes32(index % o.RING()), bytes32(index << 208 | price << 104 | depth_));
    }

    function _setUpReal() internal {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        feed = new MockFeed();
        feed.set(4000e8);
        poolA = new MockPrecision(address(0xAA), 3.78e18, 3.78e21, 3e20, 3e18, 3e22);
        poolB = new MockPrecision(address(0xAA), 3.78e18, 3.78e21, 3e20, 3e18, 3e22);
        a = new TacBlockOracle(address(poolA), address(0xAA), STEP, _shortWindow(), 10_800, 21_600, 6_600);
        b = new TacBlockOracle(address(poolB), address(0xAA), STEP, _shortWindow(), 10_800, 21_600, 6_600);
        pair = new TacPairOracle(address(a), address(b));
        vm.roll(HEAD);
        vault = new TacVault(_config(address(pair), address(feed)));
        synth = vault.SYNTH();
        _fund();
    }

    // Moves a pool's reserves so that its price is `p` ETH per TAC.
    function _setSpot(MockPrecision pool, uint256 p) internal {
        uint256 supply = pool.totalSupply();
        uint256 eth = supply * 1e18 / pool.sqrtPHigh() + pool.reserve0();
        uint256 tacTotal = eth * 1e18 / p;
        pool.setReserves(pool.reserve0(), uint128(tacTotal - supply * pool.sqrtPLow() / 1e18));
    }

    function _record(uint256 fromBack, uint256 count, uint256 price) internal {
        for (uint256 i; i < count; ++i) {
            _venue(poolA, fromBack + i, price, 2_000e18);
            _venue(poolB, fromBack + i, price, 2_000e18);
        }
    }

    function _forget(uint256 fromBack, uint256 count) internal {
        for (uint256 i; i < count; ++i) {
            uint256 index = (HEAD - 1 - a.GRACE()) / STEP - 1 - fromBack - i;
            vm.store(address(a), bytes32(index % a.RING()), bytes32(uint256(0)));
            vm.store(address(b), bytes32(index % b.RING()), bytes32(uint256(0)));
        }
    }
}

// ───────────────────────────── the offer price ─────────────────────────────

/// A bid needs an offer price unless the bidder is the owner, and the vault's windows must line up with the oracle's.
contract TacVaultOfferPrice is TacVaultAuctionBase {
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 1_700e18;

    function _liquidateAt190() internal {
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.setAll(_priceFor(COLL, DEBT, 19_000), 0);
        vault.liquidate(alice);
    }

    function test_theOwnerWindowMustBeShorterThanTheAuction() public {
        _setUp();
        TacVault.Config memory c = _config(address(oracle), address(feed));
        c.ownerWindow = c.auctionDuration;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.ownerWindow = c.auctionDuration - 1;
        new TacVault(c);
        c.ownerWindow = 10 minutes - 1; // the shortest window is ten minutes
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.ownerWindow = 10 minutes;
        new TacVault(c);
    }

    /// `recovered` reads no newest-interval price, the offer does: with that price missing the view says the whole
    /// collateral (owner only), an outsider's bid reverts, and the owner's bid takes the pro rata share.
    function test_aNonOwnerBidWithoutAnOfferPriceReverts() public {
        _setUp();
        _liquidateAt190();
        _wait(OWNER_WINDOW);
        oracle.setBreaks(64); // latest() reverts
        assertTrue(!vault.recovered(alice), "recovered() still answers: not recovered");
        vm.expectRevert(TacVaultCampaignOracle.Out.selector);
        vault.offerPrice();
        assertEq(vault.onOffer(alice), COLL, "the view says: the whole collateral (owner only)");
        vm.prank(bob);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.bid(alice, type(uint256).max, 0);
        vm.prank(bob);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.bid(alice, DEBT / 2, 0);
        vm.prank(alice);
        uint256 taken = vault.bid(alice, DEBT / 2, 0);
        assertEq(taken, COLL / 2);
    }

    function test_everyWindowOutageFailsClosedForAnOutsider() public {
        _setUp();
        _liquidateAt190();
        _wait(OWNER_WINDOW);
        uint256[3] memory bits = [uint256(1), 8, 64]; // SHORT, MAX (= the liquidation window), newest interval
        for (uint256 i; i < 3; ++i) {
            oracle.setBreaks(bits[i]);
            vm.prank(bob);
            vm.expectRevert(TacVault.NoPrice.selector);
            vault.bid(alice, DEBT / 2, 0);
        }
        oracle.setBreaks(0);
        vm.prank(bob);
        vault.bid(alice, DEBT / 2, 0);
    }

    /// The current price is read by the borrow view only: its outage stops borrowing and nothing else.
    function test_aSpotOutageStopsBorrowingAndNothingElse() public {
        _setUp();
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.setBreaks(32);
        vm.prank(alice);
        vm.expectRevert(TacVaultCampaignOracle.Out.selector);
        vault.borrow(1, 0);
        vault.offerPrice(); // answers
        oracle.setAll(_priceFor(COLL, DEBT, 19_000), 0);
        oracle.setBreaks(32);
        vault.liquidate(alice);
        _wait(OWNER_WINDOW);
        vm.prank(bob);
        vault.bid(alice, DEBT / 2, 0);
    }
}

/// On the real stack with no outage injected: 20 of the 36 intervals of the longest window recorded leaves that
/// window, and with it the liquidation, recovery and offer views, without a price.
contract TacVaultOfferPriceRealOracle is TacVaultRealOracleBase {
    function test_aThinLongestWindowFailsClosedForAnOutsider() public {
        _setUpReal();
        uint256 coll = 15_000e18;
        uint256 debt = 1_600e18;
        _record(0, 36, 1e14);
        _open(alice, coll, debt);
        _open(bob, 1_000_000e18, 5_000e18);
        uint256 p = _priceFor(coll, debt, 19_000);
        _record(0, 36, p);
        _setSpot(poolA, p);
        _setSpot(poolB, p);
        vault.liquidate(alice);
        _wait(OWNER_WINDOW);
        _forget(20, 16);
        pair.prices(3 hours); // the shorter windows still price
        vm.expectRevert(abi.encodeWithSignature("TooFewSamples()"));
        pair.prices(6 hours);
        vm.expectRevert(abi.encodeWithSignature("TooFewSamples()"));
        vault.offerPrice();
        vm.prank(bob);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.bid(alice, type(uint256).max, 0);
        vm.prank(alice);
        vault.bid(alice, type(uint256).max, 0); // the owner needs no price
    }
}

// ───────────────────────────── the offer floor ─────────────────────────────

/// The offer is the higher of the liquidation view and the newest recorded interval's price, so a rally the medians
/// have not caught up with does not sell TAC at the stale price.
contract TacVaultOfferFloorRally is TacVaultAuctionBase {
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 1_700e18;

    function _spotValue(uint256 tacAmount) internal pure returns (uint256) {
        return tacAmount * (1e14 * 4000) / WAD; // 0.40 per TAC
    }

    function test_aRallyRecordedInTheNewestIntervalSellsAtThatPriceNotTheStaleMedian() public {
        _setUp();
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        uint256 p = _priceFor(COLL, DEBT, 19_000);
        oracle.setAll(p, 0);
        vault.liquidate(alice);
        oracle.setViews(p, p, 1e14, p, 0); // the medians still say 190%
        oracle.setLatest(1e14); // the newest recorded interval is at the new price
        assertTrue(!vault.recovered(alice), "not recovered: the medians still say 190%");
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, type(uint256).max, 0);
        _wait(OWNER_WINDOW);
        vm.prank(bob);
        uint256 taken = vault.bid(alice, type(uint256).max, 0);
        uint256 value = _spotValue(taken);
        uint256 bonus = 2_500 * OWNER_WINDOW / 5_400;
        assertLe(value, DEBT * (BPS + bonus) / BPS + 1e12, "at most the debt plus the bonus earned");
        assertGe(value, DEBT * (BPS + bonus) / BPS - 1e12, "and the owner is not shortchanged either");
    }

    /// A vault healthy at the newest price but under the line at the medians can be opened, but not filled in the
    /// same transaction, and a fill costs the owner at most the bonus.
    function test_aVaultHealthyAtTheNewestPriceCostsTheOwnerAtMostTheBonus() public {
        _setUp();
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        uint256 p = _priceFor(COLL, DEBT, 19_000);
        oracle.setViews(p, p, 1e14, p, 0);
        oracle.setLatest(1e14);
        uint256 netBefore = _spotValue(COLL) - DEBT;
        vm.startPrank(bob);
        vault.liquidate(alice);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, type(uint256).max, 0);
        vm.stopPrank();
        _wait(OWNER_WINDOW);
        vm.prank(bob);
        vault.bid(alice, type(uint256).max, 0);
        (uint256 c,,) = vault.vaults(alice);
        uint256 loss = netBefore - _spotValue(c);
        assertLe(loss, DEBT * (BPS + 2_500) / BPS - DEBT + 1e12, "the owner pays at most the full bonus");
    }

    /// The owner who holds the debt in SYNTH acts inside his window and keeps every TAC.
    function test_theOwnerInTheWindowKeepsEverything() public {
        _setUp();
        _open(alice, COLL, DEBT);
        uint256 p = _priceFor(COLL, DEBT, 19_000);
        oracle.setViews(p, p, 1e14, p, 0);
        vault.liquidate(alice);
        vm.prank(alice);
        vault.bid(alice, type(uint256).max, 0);
        (uint256 c, uint256 d, uint256 s) = vault.vaults(alice);
        assertEq(d, 0);
        assertEq(s, 0);
        assertEq(c + tac.balanceOf(alice), 10_000_000e18, "every TAC kept");
    }
}

/// The floor on the real stack: only recorded intervals move it; the current price of a venue does not.
contract TacVaultOfferFloor is TacVaultRealOracleBase {
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 1_600e18;
    uint256 p;

    function _auction() internal {
        _setUpReal();
        _record(0, 36, 1e14);
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        p = _priceFor(COLL, DEBT, 19_000);
        _record(0, 36, p);
        _setSpot(poolA, p);
        _setSpot(poolB, p);
        vault.liquidate(alice);
        _wait(OWNER_WINDOW);
    }

    /// A pump of one venue's current price (and of both) moves neither the offer nor a bid's take.
    function test_aCurrentPricePumpDoesNotMoveTheOffer() public {
        _auction();
        uint256 fairTac = vault.onOffer(alice);
        uint256 fairPrice = vault.offerPrice();
        _setSpot(poolA, 3 * p);
        assertApproxEqRel(pair.spot(), p, 1e12, "the lower venue is where it was");
        assertEq(vault.offerPrice(), fairPrice, "the offer does not read the current price");
        assertEq(vault.onOffer(alice), fairTac);
        vm.prank(bob);
        uint256 taken = vault.bid(alice, type(uint256).max, fairTac); // even a tight minTac passes
        assertEq(taken, fairTac);
    }

    function test_aCurrentPricePumpDoesNotMoveRedemption() public {
        _setUpReal();
        _record(0, 36, 1e14);
        _setSpot(poolA, 1e14);
        _setSpot(poolB, 1e14);
        _open(alice, COLL, 1_700e18); // 353%: inside the redeemable band
        _open(bob, 1_000_000e18, 5_000e18);
        uint256 honest = vault.offerPrice();
        vm.prank(bob);
        uint256 fairGot = vault.redeem(alice, 100e18, 0);
        _setSpot(poolA, 3e14);
        _setSpot(poolB, 3e14);
        assertEq(vault.offerPrice(), honest);
        vm.prank(bob);
        uint256 got = vault.redeem(alice, 100e18, 0);
        assertApproxEqRel(got, fairGot, 2e16, "the same TAC (the fee rises a little with the ratio)");
    }

    /// Redemption is priced at the offer view: the TAC per SYNTH of a redemption is that price, less the fee.
    function test_redemptionIsPricedAtTheOfferView() public {
        _setUpReal();
        _record(0, 36, 1e14);
        _record(0, 5, 2e14); // the newest five intervals recorded higher
        _setSpot(poolA, 1e14);
        _setSpot(poolB, 1e14);
        _open(alice, COLL, 1_700e18);
        _open(bob, 1_000_000e18, 5_000e18);
        uint256 price = vault.offerPrice();
        assertApproxEqRel(price, 2e14 * 4000, 1e12, "the floor is the newest recorded interval");
        vm.prank(bob);
        uint256 got = vault.redeem(alice, 100e18, 0);
        // fee = 0.5% + 1.5% x (ratio - 200%) / 200% with the ratio at the liquidation view (the medians: 1e14)
        uint256 ratio = vault.valueOf(COLL, false) * 10_000 / 1_700e18;
        uint256 fee = 50 + 50 * 3 * (ratio - 20_000) / 20_000;
        assertEq(got, (100e18 * (10_000 - fee) / 10_000) * 1e18 / price);
    }

    /// The pair's newest interval is the lower venue's: both venues must record higher to raise the floor, and it
    /// never lowers the offer below the liquidation view.
    function test_theFloorFollowsTheNewestRecordedIntervalOfBothVenues() public {
        _auction();
        uint256 liq = vault.liquidationPrice();
        assertEq(vault.offerPrice(), liq);
        _venue(poolA, 0, 3 * p, 2_000e18);
        assertEq(vault.offerPrice(), liq, "one venue cannot raise the floor");
        _venue(poolB, 0, 2 * p, 2_000e18);
        assertApproxEqRel(vault.offerPrice(), 2 * liq, 1e12, "both recorded high: the lower of the two");
        _venue(poolB, 0, p / 4, 2_000e18);
        assertEq(vault.offerPrice(), liq, "never below the liquidation view");
        _venue(poolA, 0, p / 4, 2_000e18);
        assertEq(vault.offerPrice(), liq);
    }

    /// With the newest interval unrecorded the floor is the newest one that is; with none recorded the liquidation
    /// view has no price either.
    function test_anUnrecordedNewestIntervalLeavesTheFloorOneIntervalBack() public {
        _auction();
        _venue(poolA, 1, 2 * p, 2_000e18);
        _venue(poolB, 1, 2 * p, 2_000e18);
        _forget(0, 1);
        uint256 liq = vault.liquidationPrice();
        assertApproxEqRel(vault.offerPrice(), 2 * liq, 1e12, "latest() walks back to the newest recorded");
        _forget(1, 35);
        assertEq(pair.latest(), 0);
        vm.expectRevert(abi.encodeWithSignature("TooFewSamples()"));
        vault.offerPrice();
    }
}

// ───────────────────────────── the owner window ─────────────────────────────

/// Outsiders bid only from OWNER_WINDOW after the auction's start; the owner at any time; absorb waits for the
/// auction's full duration.
contract TacVaultOwnerWindow is TacVaultAuctionBase {
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 1_700e18;

    function _liquidateAt(uint256 ratioBps) internal {
        _setUp();
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.setAll(_priceFor(COLL, DEBT, ratioBps), 0);
        vault.liquidate(alice);
    }

    function test_theWindowIsExactAndTheOwnerNeverWaits() public {
        _liquidateAt(19_000);
        (,, uint256 start) = vault.vaults(alice);
        vm.warp(start + OWNER_WINDOW - 1);
        feed.set(4000e8);
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, DEBT / 4, 0);
        uint256 offerAtEdge = vault.onOffer(alice);
        vm.warp(start + OWNER_WINDOW);
        feed.set(4000e8);
        vm.prank(bob);
        uint256 taken = vault.bid(alice, DEBT / 4, 0);
        assertGe(
            taken, offerAtEdge / 4 - 1, "a quarter of the debt takes at least a quarter of the offer a second earlier"
        );
    }

    /// Absorb is not gated by the window; it waits for AUCTION_DURATION, which the constructor keeps above it.
    function test_absorbWaitsForTheAuctionNotTheWindow() public {
        _setUp();
        _open(alice, 15_000e18, 150e18);
        _open(bob, 1_000_000e18, 5_000e18);
        vm.prank(bob);
        synth.transfer(address(vault), 150e18);
        oracle.setAll(_priceFor(15_000e18, 150e18, 5_000), 0); // underwater
        vault.liquidate(alice);
        _wait(OWNER_WINDOW);
        vm.expectRevert(TacVault.TooEarly.selector);
        vault.absorb(alice);
        _wait(5_400 - OWNER_WINDOW);
        vault.absorb(alice);
        (uint256 c, uint256 d, uint256 s) = vault.vaults(alice);
        assertEq(c + d + s, 0);
    }

    /// The auction opens at once and the bonus clock runs from its start; the window delays outsiders' fills.
    function test_theBonusRunsFromTheStartOfTheAuction() public {
        _liquidateAt(19_000);
        (,, uint256 start) = vault.vaults(alice);
        assertEq(start, block.timestamp);
        uint256 atStart = vault.onOffer(alice);
        _wait(OWNER_WINDOW);
        uint256 atWindowEnd = vault.onOffer(alice);
        uint256 bonusBps = 2_500 * OWNER_WINDOW / 5_400;
        assertApproxEqRel(atWindowEnd, atStart * (BPS + bonusBps) / BPS, 1e12);
    }

    /// The owner can bid inside the window; a partial bid that restores health ends the auction.
    function test_theOwnerRescuesInsideTheWindow() public {
        _liquidateAt(19_000);
        vm.prank(alice);
        vault.bid(alice, DEBT / 2, 0);
        (uint256 c, uint256 d, uint256 s) = vault.vaults(alice);
        assertEq(d, DEBT / 2);
        assertEq(s, 0);
        assertGt(c, 0);
    }

    function test_theShortestOwnerWindowIsTenMinutes() public {
        _setUp();
        TacVault.Config memory c = _config(address(oracle), address(feed));
        c.ownerWindow = 10 minutes;
        vault = new TacVault(c);
        synth = vault.SYNTH();
        _fund();
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.setAll(_priceFor(COLL, DEBT, 19_000), 0);
        vault.liquidate(alice);
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, DEBT / 2, 0);
        skip(10 minutes);
        feed.set(4000e8);
        vm.prank(bob);
        vault.bid(alice, DEBT / 2, 0);
    }

    /// An auction that ends and starts again is a new auction: a fresh window and the bonus back at zero.
    function test_aNewAuctionAfterARecoveryStartsWithAFreshWindowAndNoBonus() public {
        _liquidateAt(19_000);
        _wait(5_400);
        uint256 maxOffer = vault.onOffer(alice);
        oracle.setAll(1e14, 0);
        vault.cancel(alice);
        oracle.setAll(_priceFor(COLL, DEBT, 19_000), 0);
        vault.liquidate(alice);
        uint256 restartOffer = vault.onOffer(alice);
        assertLt(restartOffer, maxOffer * 100 / 120, "the 25% bonus is gone");
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, DEBT / 2, 0);
    }
}

// ───────────────────────────── the end of an auction ─────────────────────────────

/// A bid or an absorb that leaves no debt, or a vault over the line, ends the auction; MIN_DEBT rules for partials.
contract TacVaultAuctionEnd is TacVaultAuctionBase {
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 1_700e18;

    function setUp() public {
        _setUp();
    }

    /// A partial bid at the offer sells less collateral than the share of debt it repays, so it can lift the vault over
    /// the line: the auction ends, the owner is free, and a second bid has no auction to hit.
    function test_aPartialBidThatRestoresHealthEndsTheAuction() public {
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.setAll(_priceFor(COLL, DEBT, 19_000), 0);
        vault.liquidate(alice);
        _wait(OWNER_WINDOW);
        vm.prank(bob);
        vault.bid(alice, DEBT / 2, 0);
        (, uint256 d, uint256 s) = vault.vaults(alice);
        assertEq(s, 0, "the auction is over");
        assertTrue(vault.recovered(alice));
        vm.prank(bob);
        vm.expectRevert(TacVault.NoAuction.selector);
        vault.bid(alice, d, 0);
        vm.prank(alice);
        vm.expectRevert(TacVault.Undercollateralized.selector); // the ordinary 350% rule, not InAuction
        vault.withdraw(1);
        vm.expectRevert(TacVault.NoAuction.selector);
        vault.cancel(alice);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice); // and the healthy vault cannot be opened again at once
    }

    /// A bid that leaves the ratio under the line leaves the auction running.
    function test_aSmallBidLeavesTheAuctionRunning() public {
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.setAll(_priceFor(COLL, DEBT, 6_000), 0); // deep under water: partial bids keep the ratio
        vault.liquidate(alice);
        _wait(OWNER_WINDOW);
        vm.prank(bob);
        vault.bid(alice, DEBT / 2, 0);
        (,, uint256 s) = vault.vaults(alice);
        assertGt(s, 0);
    }

    /// After a bid ended the auction a fall opens a new one, with a fresh window and no bonus.
    function test_aBidThatEndsTheAuctionThenARelapseOpensANewOne() public {
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.setAll(_priceFor(COLL, DEBT, 19_000), 0);
        vault.liquidate(alice);
        _wait(OWNER_WINDOW);
        vm.prank(bob);
        vault.bid(alice, DEBT / 2, 0);
        (uint256 c, uint256 d, uint256 s) = vault.vaults(alice);
        assertEq(s, 0);
        oracle.setAll(_priceFor(c, d, 15_000), 0);
        vault.liquidate(alice);
        (,, s) = vault.vaults(alice);
        assertEq(s, block.timestamp);
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, d, 0);
    }

    /// Inside `bid` the auction is over before the TAC leaves: AuctionEnded is emitted before Liquidated.
    function test_theAuctionIsOverBeforeTheTacLeaves() public {
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.setAll(_priceFor(COLL, DEBT, 19_000), 0);
        vault.liquidate(alice);
        _wait(OWNER_WINDOW);
        vm.recordLogs();
        vm.prank(bob);
        vault.bid(alice, DEBT / 2, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 ended;
        uint256 liquidated;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("AuctionEnded(address)")) ended = i + 1;
            if (logs[i].topics[0] == keccak256("Liquidated(address,address,uint256,uint256)")) liquidated = i + 1;
        }
        assertTrue(ended != 0 && liquidated != 0);
        assertLt(ended, liquidated, "AuctionEnded precedes Liquidated");
    }

    /// A partial absorb leaves at least MIN_DEBT and the auction running; a full one ends it; a vault at exactly
    /// MIN_DEBT is absorbed whole, once the reserve holds MIN_DEBT.
    function test_absorbRespectsMinDebtAndEndsOnlyWhenDone() public {
        _open(alice, 15_000e18, 150e18);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.setAll(_priceFor(15_000e18, 150e18, 5_000), 0);
        vault.liquidate(alice);
        _wait(5_400);
        vm.prank(bob);
        synth.transfer(address(vault), 60e18);
        vault.absorb(alice); // 60 > 150 - 100: burns 50, leaves 100
        (, uint256 d, uint256 s) = vault.vaults(alice);
        assertEq(d, 100e18);
        assertGt(s, 0, "still in the auction");
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.absorb(alice); // 10 left in the reserve, and nothing may be burned below MIN_DEBT
        vm.prank(bob);
        synth.transfer(address(vault), 90e18); // reserve 100
        vault.absorb(alice);
        (uint256 c, uint256 d2, uint256 s2) = vault.vaults(alice);
        assertEq(c + d2 + s2, 0, "a reserve of MIN_DEBT absorbs the dust vault whole");
    }

    /// A partial bid that leaves exactly MIN_DEBT: the next bid can only be the whole remainder.
    function test_aPartialBidLeavesTheMinimumAndTheRestMustBeWhole() public {
        _open(alice, 15_000e18, 400e18);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.setAll(_priceFor(15_000e18, 400e18, 5_000), 0); // underwater: the auction continues after a partial
        vault.liquidate(alice);
        _wait(OWNER_WINDOW);
        vm.startPrank(bob);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.bid(alice, 301e18, 0);
        vault.bid(alice, 300e18, 0);
        (, uint256 d, uint256 s) = vault.vaults(alice);
        assertEq(d, 100e18);
        assertGt(s, 0);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.bid(alice, 1, 0);
        vault.bid(alice, 100e18, 0);
        vm.stopPrank();
    }

    /// SYNTH sent to the vault is only spent by `absorb`: it stays out of circulation, so the last borrowers cannot
    /// repay in full until an absorb burns it.
    function test_synthSentToTheVaultIsOnlySpentByAbsorb() public {
        _open(alice, 100_000e18, 5_000e18);
        _open(bob, 100_000e18, 5_000e18);
        vm.prank(alice);
        synth.transfer(address(vault), 1_000e18);
        vm.prank(bob);
        vault.repay(bob, type(uint256).max);
        assertEq(synth.totalSupply(), 5_000e18);
        assertEq(synth.balanceOf(address(vault)), 1_000e18);
        vm.prank(alice);
        vault.repay(alice, 4_000e18);
        (, uint256 d,) = vault.vaults(alice);
        assertEq(d, 1_000e18, "1,000 of debt remains that no circulating SYNTH can repay");
        vm.prank(alice);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.withdraw(type(uint256).max);
        vm.prank(alice);
        vault.withdraw(100_000e18 - 1_000e18 * 35 / 10 * 1e18 / (1e14 * 4000) - 1e18); // all but 350% of the rest
    }
}

// ───────────────────────────── the debt cap ─────────────────────────────

/// The debt cap is DEPTH_BPS of the smallest ETH depth recorded over the longest window, with every interval of the
/// window recorded; it limits new borrowing only.
contract TacVaultDepthCap is TacVaultRealOracleBase {
    function test_theCapIsTheSmallestDepthOfTheWindow() public {
        _setUpReal();
        _record(0, 36, 1e14);
        _setSpot(poolA, 1e14);
        _setSpot(poolB, 1e14);
        _open(alice, 15_000e18, 1_000e18);
        assertEq(vault.depthCeiling(), 2_000e18 * 4000 * 500 / 10_000, "5% of 2,000 ETH in dollars");
        _venue(poolA, 10, 1e14, 1e18);
        assertEq(pair.depthMin(6 hours), 1e18, "the minimum follows the one interval");
        assertEq(vault.depthCeiling(), 1e18 * 4000 * 500 / 10_000);
        vm.startPrank(bob);
        vault.deposit(1_000_000e18);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(100e18, 0);
        vm.stopPrank();
        vm.prank(alice);
        vault.repay(alice, type(uint256).max); // open debt is untouched by the cap
    }

    function test_aDepthLiftedForHalfTheWindowDoesNotRaiseTheCap() public {
        _setUpReal();
        _record(0, 36, 1e14);
        uint256 before = pair.depthMin(6 hours);
        for (uint256 i; i < 20; ++i) {
            _venue(poolA, i, 1e14, 1e30);
            _venue(poolB, i, 1e14, 1e30);
        }
        assertEq(pair.depthMin(6 hours), before);
    }

    /// One unrecorded interval stops new borrowing (TooFewSamples) while prices, liquidation, bids, repay and
    /// withdraw keep working on the 35 recorded.
    function test_oneUnrecordedIntervalStopsNewBorrowingAndNothingElse() public {
        _setUpReal();
        _record(0, 36, 1e14);
        _setSpot(poolA, 1e14);
        _setSpot(poolB, 1e14);
        _open(alice, 15_000e18, 1_000e18);
        _venue(poolA, 7, 1e14, 1e18);
        _forget(7, 1);
        vm.expectRevert(abi.encodeWithSignature("TooFewSamples()"));
        pair.depthMin(6 hours);
        pair.prices(6 hours);
        vm.startPrank(bob);
        vault.deposit(1_000_000e18);
        vm.expectRevert(abi.encodeWithSignature("TooFewSamples()"));
        vault.borrow(100e18, 0);
        vm.stopPrank();
        vm.startPrank(alice);
        vault.withdraw(1e18);
        vault.repay(alice, 500e18);
        vm.stopPrank();
        vault.liqHealthyView(alice);
    }

    function test_twoVenuesOverOnePoolAreRefused() public {
        _setUpReal();
        TacBlockOracle same =
            new TacBlockOracle(address(poolA), address(0xAA), STEP, _shortWindow(), 10_800, 21_600, 6_600);
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        new TacPairOracle(address(a), address(same));
    }
}

// ───────────────────────────── gas ─────────────────────────────

/// A bid on the real stack costs about half a million gas, and no gas limit makes an outsider's bid take more than its
/// share (or skip ending the auction): the price calls either fit or the bid reverts.
contract TacVaultBidGas is TacVaultRealOracleBase {
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 1_600e18;
    uint256 fair;

    function _prepare() internal {
        _setUpReal();
        _record(0, 36, 1e14);
        _open(alice, COLL, DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        uint256 p = _priceFor(COLL, DEBT, 19_000);
        _record(0, 36, p);
        _setSpot(poolA, p);
        _setSpot(poolB, p);
        vault.liquidate(alice);
        _wait(OWNER_WINDOW);
        fair = vault.onOffer(alice);
    }

    function _cool() internal {
        vm.cool(address(vault));
        vm.cool(address(pair));
        vm.cool(address(a));
        vm.cool(address(b));
        vm.cool(address(feed));
        vm.cool(address(synth));
        vm.cool(address(tac));
        vm.cool(address(poolA));
        vm.cool(address(poolB));
    }

    function test_theViewsAndABidFitInTheirGasBounds() public {
        _prepare();
        _cool();
        uint256 g = gasleft();
        vault.offerPrice();
        uint256 offerGas = g - gasleft();
        _cool();
        vm.prank(bob);
        g = gasleft();
        vault.bid(alice, DEBT / 2, 0);
        uint256 bidGas = g - gasleft();
        console2.log("offerPrice / whole bid gas:", offerGas, bidGas);
        assertLt(offerGas, 400_000);
        assertLt(bidGas, 700_000);
    }

    /// Every gas limit from 150k to 10M for an outsider's partial bid: it fails or takes the fair share and ends the
    /// auction when the vault recovered.
    function test_noGasLimitMakesAnOutsidersBidTakeMoreThanItsShareOrLeaveARecoveredAuction() public {
        _prepare();
        uint256 wins;
        for (uint256 g = 150_000; g <= 10_000_000; g += 50_000) {
            uint256 snap = vm.snapshotState();
            _cool();
            vm.prank(bob);
            (bool ok, bytes memory ret) = address(vault).call{gas: g}(abi.encodeCall(vault.bid, (alice, DEBT / 2, 0)));
            if (ok) {
                ++wins;
                assertLe(abi.decode(ret, (uint256)), fair / 2 + 1, "never more than the fair share");
                (,, uint256 s) = vault.vaults(alice);
                assertTrue(s == 0 || !vault.recovered(alice), "a recovered vault leaves its auction");
            }
            vm.revertToState(snap);
        }
        assertGt(wins, 0);
    }
}
