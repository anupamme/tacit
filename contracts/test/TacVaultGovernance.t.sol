// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TestTac, MockOracle, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

/// An oracle with windows of its own, for a vault whose oracle is replaced.
contract WindowedOracle {
    uint256 public immutable SHORT_WINDOW;
    uint256 public immutable WINDOW;
    uint256 public immutable MAX_WINDOW;
    uint256 public price;
    uint256 public ethDepth = 1e30;
    bool public cold;

    constructor(uint256 s, uint256 w, uint256 m, uint256 p) {
        (SHORT_WINDOW, WINDOW, MAX_WINDOW, price) = (s, w, m, p);
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function setCold(bool c) external {
        cold = c;
    }

    function setDepth(uint256 d) external {
        ethDepth = d;
    }

    function _ready() internal view {
        if (cold) revert("cold");
    }

    function prices(uint256) external view returns (uint256, uint256) {
        _ready();
        return (price, price);
    }

    function recovery(uint256) external view returns (uint256) {
        _ready();
        return price;
    }

    function depthMin(uint256) external view returns (uint256) {
        _ready();
        return ethDepth;
    }

    function latest() external view returns (uint256) {
        _ready();
        return price;
    }

    function spot() external view returns (uint256) {
        _ready();
        return price;
    }
}

/// A second kind of collateral lending the same synth.
contract SynthMinter {
    function mint(TacSynth s, address to, uint256 amount) external {
        s.mint(to, amount);
    }

    function burn(TacSynth s, address from, uint256 amount) external {
        s.burnFrom(from, amount);
    }
}

/// The terms the owner can change after deployment: how, how slowly, inside which rails, and what the locks end.
contract TacVaultGovernanceTest is Test {
    uint256 constant P = 1e14;
    address constant OWNER = address(0x0123);

    TestTac tac;
    MockOracle oracle;
    MockFeed feed;
    TacVault vault;
    TacSynth dollar;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        oracle = new MockOracle();
        oracle.set(P);
        feed = new MockFeed();
        feed.set(4000e8);
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
        c.depthBps = 100;
        vault = new TacVault(c);
        dollar = vault.SYNTH();
        tac.mint(alice, 10_000_000e18);
        tac.mint(bob, 10_000_000e18);
        vm.startPrank(alice);
        tac.approve(address(vault), type(uint256).max);
        dollar.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(bob);
        tac.approve(address(vault), type(uint256).max);
        dollar.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _wait(uint256 t) internal {
        skip(t);
        feed.set(4000e8);
    }

    function _queue(TacVault.Param id, uint256 v) internal {
        vm.prank(OWNER);
        vault.queueParam(id, v);
    }

    function _apply(TacVault.Param id, uint256 v) internal {
        _queue(id, v);
        _wait(vault.PARAM_DELAY());
        vm.prank(OWNER);
        vault.executeParam(id);
    }

    // ───────────── the slow lane ─────────────

    /// A change waits its delay, then applies, and is gone from the queue.
    function test_aQueuedChangeWaitsItsDelayAndThenApplies() public {
        assertEq(vault.DEPTH_BPS(), 100);
        uint256 eta = block.timestamp + vault.PARAM_DELAY();
        vm.expectEmit(true, false, false, true);
        emit TacVault.ParamQueued(TacVault.Param.DepthBps, 200, eta);
        _queue(TacVault.Param.DepthBps, 200);
        (uint192 value, uint64 at) = vault.queuedParam(TacVault.Param.DepthBps);
        assertEq(value, 200);
        assertEq(at, eta);
        assertEq(vault.DEPTH_BPS(), 100, "nothing changes while it waits");

        vm.prank(OWNER);
        vm.expectRevert(TacVault.TooEarly.selector);
        vault.executeParam(TacVault.Param.DepthBps);
        _wait(vault.PARAM_DELAY() - 1);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.TooEarly.selector);
        vault.executeParam(TacVault.Param.DepthBps);
        _wait(1);
        vm.expectEmit(true, false, false, true);
        emit TacVault.ParamSet(TacVault.Param.DepthBps, 200);
        vm.prank(OWNER);
        vault.executeParam(TacVault.Param.DepthBps);
        assertEq(vault.DEPTH_BPS(), 200);
        (value, at) = vault.queuedParam(TacVault.Param.DepthBps);
        assertEq(value, 0);
        assertEq(at, 0);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.NothingQueued.selector);
        vault.executeParam(TacVault.Param.DepthBps);
    }

    function test_aChangeNotExecutedInTimeLapses() public {
        _queue(TacVault.Param.DepthBps, 200);
        _wait(vault.PARAM_DELAY() + vault.QUEUE_EXPIRY());
        vm.prank(OWNER);
        vault.executeParam(TacVault.Param.DepthBps);
        assertEq(vault.DEPTH_BPS(), 200);
        _queue(TacVault.Param.DepthBps, 400);
        _wait(vault.PARAM_DELAY() + vault.QUEUE_EXPIRY() + 1);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.Expired.selector);
        vault.executeParam(TacVault.Param.DepthBps);
        assertEq(vault.DEPTH_BPS(), 200);
    }

    function test_queueingAgainRestartsTheWaitAndCancelClearsIt() public {
        _queue(TacVault.Param.DepthBps, 150);
        _wait(vault.PARAM_DELAY() - 1);
        _queue(TacVault.Param.DepthBps, 180);
        _wait(1);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.TooEarly.selector);
        vault.executeParam(TacVault.Param.DepthBps);
        vm.expectEmit(true, false, false, false);
        emit TacVault.ParamCancelled(TacVault.Param.DepthBps);
        vm.prank(OWNER);
        vault.cancelParam(TacVault.Param.DepthBps);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.NothingQueued.selector);
        vault.cancelParam(TacVault.Param.DepthBps);
        _wait(vault.PARAM_DELAY());
        vm.prank(OWNER);
        vm.expectRevert(TacVault.NothingQueued.selector);
        vault.executeParam(TacVault.Param.DepthBps);
    }

    function test_onlyTheOwnerGoverns() public {
        vm.startPrank(alice);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.queueParam(TacVault.Param.DepthBps, 150);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.executeParam(TacVault.Param.DepthBps);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.cancelParam(TacVault.Param.DepthBps);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.lowerDepthBps(1);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setRedemptionFee(1);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.lockParams();
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.queueOracle(address(0x1234));
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.executeOracle();
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.cancelOracle();
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.lockOracle();
        vm.stopPrank();
    }

    // ───────────── the rails ─────────────

    /// The share of depth the vault lends can double (and rise a little from nothing), never pass its hard share,
    /// and falls without limit.
    function test_theDepthShareRisesByAtMostDoubleAndNeverPastTheHardShare() public {
        uint256 hard = vault.MAX_DEPTH_BPS();
        vm.startPrank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.DepthBps, 226); // 2 x 100 + 25 = 225
        vault.queueParam(TacVault.Param.DepthBps, 225);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.DepthBps, hard + 1);
        vault.queueParam(TacVault.Param.DepthBps, 0);
        vm.stopPrank();
        // Steps: 100 -> 225 -> 475 -> 975 -> 1000 (the hard share), a wait before each.
        _apply(TacVault.Param.DepthBps, 225);
        _apply(TacVault.Param.DepthBps, 475);
        _apply(TacVault.Param.DepthBps, 975);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.DepthBps, 1_001);
        _apply(TacVault.Param.DepthBps, 1_000);
        // A rise is checked against the share at execution: queue, lower at once, and the old rise is too big.
        vm.startPrank(OWNER);
        vault.lowerDepthBps(100);
        vault.queueParam(TacVault.Param.DepthBps, 225);
        vault.lowerDepthBps(50);
        vm.stopPrank();
        _wait(vault.PARAM_DELAY());
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector); // 225 > 2 x 50 + 25
        vault.executeParam(TacVault.Param.DepthBps);
    }

    function test_loweringTheDepthShareIsAtOnceAndOnlyDownward() public {
        vm.startPrank(OWNER);
        vm.expectEmit(true, false, false, true);
        emit TacVault.ParamSet(TacVault.Param.DepthBps, 10);
        vault.lowerDepthBps(10);
        assertEq(vault.DEPTH_BPS(), 10);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.lowerDepthBps(10);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.lowerDepthBps(11);
        vault.lowerDepthBps(0);
        vm.stopPrank();
        assertEq(vault.depthCeiling(), 0);
    }

    function test_theRatiosKeepTheirMargins() public {
        vm.startPrank(OWNER);
        // Liquidation ratio: between 120% and 300%, a margin under the mint ratio, over 100% + bonus.
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.LiqRatioBps, 11_999);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.LiqRatioBps, 30_001);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.LiqRatioBps, 28_001); // the mint ratio is 300%: 20% margin
        vault.queueParam(TacVault.Param.LiqRatioBps, 28_000);
        // Mint ratio: a margin over the liquidation ratio, at most 1000%.
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.MintRatioBps, 17_500 + 1_999);
        vault.queueParam(TacVault.Param.MintRatioBps, 17_500 + 2_000);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.MintRatioBps, 100_001);
        vault.queueParam(TacVault.Param.MintRatioBps, 100_000);
        // Bonus: at most 50%, and 100% plus it stays under the liquidation ratio.
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.LiqBonusBps, 0);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.LiqBonusBps, 5_001);
        vault.queueParam(TacVault.Param.LiqBonusBps, 5_000);
        vm.stopPrank();
    }

    function test_theTimesKeepTheirBounds() public {
        vm.startPrank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.OwnerWindow, 10 minutes - 1);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.OwnerWindow, 1 days + 1);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.OwnerWindow, 2 hours); // not under the auction's 2 hours
        vault.queueParam(TacVault.Param.OwnerWindow, 2 hours - 1);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.AuctionDuration, 30 minutes - 1);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.AuctionDuration, 3 days + 1);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.AuctionDuration, 20 minutes); // not over the owner window
        vault.queueParam(TacVault.Param.AuctionDuration, 3 days);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.MinDebt, 0);
        // Within a tenth to a hundred times the 100 the vault was deployed with.
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.MinDebt, 10e18 - 1);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.MinDebt, 10_000e18 + 1);
        vault.queueParam(TacVault.Param.MinDebt, 10_000e18);
        vault.queueParam(TacVault.Param.MinDebt, 10e18);
        vm.stopPrank();
    }

    /// Two changes that are fine alone can be wrong together: the rails are checked again against the terms as
    /// they are when a change is executed.
    function test_aQueuedChangeIsCheckedAgainWhenExecuted() public {
        // The auction cannot shrink under the owner window, and the owner window cannot grow past the auction:
        // queue both so that either one alone passes, then execute one and the other no longer does.
        vm.startPrank(OWNER);
        vault.queueParam(TacVault.Param.OwnerWindow, 90 minutes); // under 2 hours: fine now
        vault.queueParam(TacVault.Param.AuctionDuration, 1 hours); // over 20 minutes: fine now
        vm.stopPrank();
        _wait(vault.PARAM_DELAY());
        vm.startPrank(OWNER);
        vault.executeParam(TacVault.Param.AuctionDuration);
        vm.expectRevert(TacVault.BadConfig.selector); // 90 minutes is not under the auction's 1 hour any more
        vault.executeParam(TacVault.Param.OwnerWindow);
        vm.stopPrank();
        assertEq(vault.AUCTION_DURATION(), 1 hours);
        assertEq(vault.OWNER_WINDOW(), 20 minutes);
    }

    function test_redemptionFeeIsAtOnceAndBounded() public {
        vm.startPrank(OWNER);
        vm.expectEmit(false, false, false, true);
        emit TacVault.RedemptionFeeSet(250);
        vault.setRedemptionFee(250);
        assertEq(vault.REDEMPTION_FEE_BPS(), 250);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.setRedemptionFee(251);
        vault.setRedemptionFee(0);
        vm.stopPrank();
        assertEq(vault.REDEMPTION_FEE_BPS(), 0);
    }

    // ───────────── what a change does ─────────────

    function _open(address who, uint256 coll, uint256 debt) internal {
        vm.startPrank(who);
        vault.deposit(coll);
        vault.borrow(debt, 0);
        vm.stopPrank();
    }

    /// The depth share is the lending capacity: a rise lets more be borrowed, a fall at once stops it.
    function test_theDepthShareSetsTheCapacity() public {
        oracle.setDepth(1_000e18); // 1,000 ETH at $4,000
        uint256 cap = vault.depthCeiling();
        assertEq(cap, 1_000e18 * 4_000 * 100 / 10_000);
        _apply(TacVault.Param.DepthBps, 200);
        assertEq(vault.depthCeiling(), 2 * cap);
        vm.prank(OWNER);
        vault.lowerDepthBps(50);
        assertEq(vault.depthCeiling(), cap / 2);
        vm.prank(OWNER);
        vault.setDebtCeiling(type(uint256).max);
        tac.mint(alice, 10_000_000e18);
        vm.prank(alice);
        vault.deposit(10_000_000e18);
        vm.prank(alice);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(cap / 2 + 1, 0);
        vm.prank(alice);
        vault.borrow(cap / 2, 0);
    }

    function test_theMintRatioMovesTheBorrowingLine() public {
        _open(alice, 15_000e18, 2_000e18); // 15,000 TAC at $0.40 = $6,000: 300%
        vm.prank(alice);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.borrow(1, 0);
        _apply(TacVault.Param.MintRatioBps, 25_000); // 250%: $2,400 may be borrowed
        vm.prank(alice);
        vault.borrow(400e18, 0);
        (, uint256 debt,) = vault.vaults(alice);
        assertEq(debt, 2_400e18);
        assertEq(vault.MINT_RATIO_BPS(), 25_000);
    }

    function test_theLiquidationRatioMovesTheLiquidationLine() public {
        _open(alice, 15_000e18, 2_000e18); // 300% at the start
        oracle.set(P * 55 / 100); // 165%: under the 175% line
        assertFalse(vault.liqHealthyView(alice));
        _apply(TacVault.Param.LiqRatioBps, 15_000); // 150%
        assertEq(vault.LIQ_RATIO_BPS(), 15_000);
        assertTrue(vault.liqHealthyView(alice));
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
        oracle.set(P * 45 / 100); // 135%: under the new line
        assertFalse(vault.liqHealthyView(alice));
        vault.liquidate(alice);
        (,, uint256 start) = vault.vaults(alice);
        assertGt(start, 0);
    }

    /// The owner window and the auction's length apply to the bids that follow a change.
    function test_theOwnerWindowAndAuctionLengthApplyToAuctions() public {
        _open(alice, 15_000e18, 2_000e18);
        _open(bob, 1_000_000e18, 5_000e18);
        _apply(TacVault.Param.OwnerWindow, 1 hours);
        _apply(TacVault.Param.AuctionDuration, 4 hours);
        oracle.set(5e13);
        vault.liquidate(alice);
        _wait(30 minutes);
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, type(uint256).max, 0);
        _wait(31 minutes);
        // The bonus has grown by 61 minutes of 4 hours of the 10%.
        uint256 elapsed = 61 minutes;
        uint256 bonus = 1_000 * elapsed / (4 hours);
        uint256 price = vault.offerPrice();
        (, uint256 debt,) = vault.vaults(alice);
        assertEq(vault.onOffer(alice), debt * (10_000 + bonus) / 10_000 * 1e18 / price);
        vm.prank(bob);
        vault.bid(alice, type(uint256).max, 0);
    }

    function test_theMinimumDebtMoves() public {
        _apply(TacVault.Param.MinDebt, 300e18);
        vm.startPrank(alice);
        vault.deposit(100_000e18);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.borrow(299e18, 0);
        vault.borrow(300e18, 0);
        vm.stopPrank();
    }

    // ───────────── the locks ─────────────

    function test_lockParamsEndsTheDelayedChangesAndTheLoweringForGood() public {
        uint256 depth = vault.DEPTH_BPS();
        _queue(TacVault.Param.DepthBps, 150);
        vm.startPrank(OWNER);
        vm.expectEmit(false, false, false, false);
        emit TacVault.ParamsLocked();
        vault.lockParams();
        assertTrue(vault.paramsLocked());
        vm.expectRevert(TacVault.Locked.selector);
        vault.queueParam(TacVault.Param.DepthBps, 120);
        vm.stopPrank();
        _wait(vault.PARAM_DELAY());
        vm.startPrank(OWNER);
        vm.expectRevert(TacVault.Locked.selector);
        vault.executeParam(TacVault.Param.DepthBps); // what was announced no longer applies
        vm.expectRevert(TacVault.Locked.selector);
        vault.lowerDepthBps(40);
        // The fees, the ceiling and the pause are not locked.
        vault.setRedemptionFee(10);
        vault.setDebtCeiling(0);
        vault.pauseAuctions(1 hours);
        vm.stopPrank();
        assertEq(vault.DEPTH_BPS(), depth);
    }

    // ───────────── replacing the oracle ─────────────

    function _next(uint256 s, uint256 w, uint256 m, uint256 p) internal returns (WindowedOracle) {
        return new WindowedOracle(s, w, m, p);
    }

    function test_aQueuedOracleTakesOverAfterItsDelayAndTheVaultPricesFromIt() public {
        _open(alice, 15_000e18, 2_000e18);
        assertEq(address(vault.ORACLE()), address(oracle));
        assertEq(vault.LIQ_WINDOW(), 4 hours);
        WindowedOracle next = _next(30 minutes, 2 hours, 8 hours, P * 12 / 10);
        uint256 eta = block.timestamp + vault.ORACLE_DELAY();
        vm.expectEmit(true, false, false, true);
        emit TacVault.OracleQueued(address(next), eta);
        vm.prank(OWNER);
        vault.queueOracle(address(next));
        assertEq(vault.pendingOracle(), address(next));
        assertEq(vault.pendingOracleEta(), eta);
        assertEq(address(vault.ORACLE()), address(oracle));

        vm.prank(OWNER);
        vm.expectRevert(TacVault.TooEarly.selector);
        vault.executeOracle();
        _wait(vault.ORACLE_DELAY());
        vm.expectEmit(true, false, false, false);
        emit TacVault.OracleSet(address(next));
        vm.prank(OWNER);
        vault.executeOracle();
        assertEq(address(vault.ORACLE()), address(next));
        assertEq(vault.LIQ_WINDOW(), 8 hours);
        assertEq(vault.pendingOracle(), address(0));
        // The vault now prices from the new oracle: 20% more TAC value.
        assertEq(vault.valueOf(15_000e18, true), 15_000e18 * (P * 12 / 10) * 4000 / 1e18);
        // And the old one has no say.
        oracle.set(1);
        assertEq(vault.valueOf(15_000e18, false), 15_000e18 * (P * 12 / 10) * 4000 / 1e18);
    }

    function test_anOracleIsRefusedIfItIsTheWrongKindOrAnswersNothing() public {
        WindowedOracle outOfOrder = _next(2 hours, 1 hours, 4 hours, P);
        WindowedOracle noShort = _next(0, 1 hours, 4 hours, P);
        vm.startPrank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueOracle(address(0x1234)); // no code
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueOracle(address(oracle)); // the one in place
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueOracle(address(outOfOrder)); // windows out of order
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueOracle(address(noShort));
        vm.stopPrank();

        // One with no price yet (its intervals are not recorded) cannot take over; once it can, it does.
        WindowedOracle cold = _next(30 minutes, 2 hours, 8 hours, P);
        cold.setCold(true);
        vm.prank(OWNER);
        vault.queueOracle(address(cold));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vm.expectRevert(bytes("cold"));
        vault.executeOracle();
        cold.setCold(false);
        vm.prank(OWNER);
        vault.executeOracle();
        assertEq(address(vault.ORACLE()), address(cold));
    }

    /// A price far from the one in place (more than three times, either way) is not accepted: a slip, not a
    /// market, until the vault's own oracle agrees.
    function test_aNewOraclePriceFarFromTheOldOneIsRefused() public {
        WindowedOracle high = _next(30 minutes, 2 hours, 8 hours, P * 3 + 1);
        vm.prank(OWNER);
        vault.queueOracle(address(high));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.executeOracle();
        high.setPrice(P * 3);
        vm.prank(OWNER);
        vault.executeOracle();

        WindowedOracle low = _next(30 minutes, 2 hours, 8 hours, P * 3 / 10);
        vm.prank(OWNER);
        vault.queueOracle(address(low));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector); // 0.3 x P against 3 x P: ten times
        vault.executeOracle();
    }

    function test_anOracleThatPricesNothingIsRefused() public {
        WindowedOracle empty = _next(30 minutes, 2 hours, 8 hours, 0);
        vm.prank(OWNER);
        vault.queueOracle(address(empty));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.executeOracle();
        empty.setPrice(P);
        empty.setDepth(0);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.executeOracle();
    }

    function test_aQueuedOracleLapsesAndCanBeCancelled() public {
        WindowedOracle next = _next(30 minutes, 2 hours, 8 hours, P);
        vm.prank(OWNER);
        vault.queueOracle(address(next));
        _wait(vault.ORACLE_DELAY() + vault.QUEUE_EXPIRY() + 1);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.Expired.selector);
        vault.executeOracle();
        vm.prank(OWNER);
        vm.expectEmit(true, false, false, false);
        emit TacVault.OracleCancelled(address(next));
        vault.cancelOracle();
        assertEq(vault.pendingOracle(), address(0));
        vm.prank(OWNER);
        vm.expectRevert(TacVault.NothingQueued.selector);
        vault.cancelOracle();
        vm.prank(OWNER);
        vm.expectRevert(TacVault.NothingQueued.selector);
        vault.executeOracle();
        assertEq(address(vault.ORACLE()), address(oracle));
    }

    function test_lockOracleEndsReplacementForGood() public {
        WindowedOracle next = _next(30 minutes, 2 hours, 8 hours, P);
        vm.startPrank(OWNER);
        vault.queueOracle(address(next));
        vm.expectEmit(false, false, false, false);
        emit TacVault.OracleLocked();
        vault.lockOracle();
        vm.stopPrank();
        assertTrue(vault.oracleLocked());
        assertEq(vault.pendingOracle(), address(0));
        vm.startPrank(OWNER);
        vm.expectRevert(TacVault.Locked.selector);
        vault.queueOracle(address(next));
        vm.expectRevert(TacVault.Locked.selector);
        vault.executeOracle();
        // The terms are a separate lock.
        vault.queueParam(TacVault.Param.DepthBps, 150);
        vm.stopPrank();
    }

    /// While a replacement waits, the vault keeps pricing from the oracle it has, borrowers can leave, and the
    /// owner's other powers go on.
    function test_aWaitingOracleChangesNothingUntilItIsExecuted() public {
        _open(alice, 15_000e18, 2_000e18);
        WindowedOracle next = _next(30 minutes, 2 hours, 8 hours, P * 2);
        vm.prank(OWNER);
        vault.queueOracle(address(next));
        _wait(vault.ORACLE_DELAY() - 1);
        assertEq(vault.valueOf(15_000e18, true), 15_000e18 * P * 4000 / 1e18);
        vm.startPrank(alice);
        vault.repay(alice, type(uint256).max);
        vault.withdraw(type(uint256).max);
        vm.stopPrank();
        assertEq(tac.balanceOf(alice), 10_000_000e18);
    }

    // ───────────── further minters of the synth ─────────────

    function test_aFurtherMinterIsAnnouncedWaitsAndThenMintsAndBurns() public {
        SynthMinter m = new SynthMinter();
        vm.prank(alice);
        vm.expectRevert(TacSynth.NotOwner.selector);
        dollar.queueMinter(address(m));

        uint256 eta = block.timestamp + dollar.MINTER_DELAY();
        vm.expectEmit(true, false, false, true);
        emit TacSynth.MinterQueued(address(m), eta);
        vm.prank(OWNER);
        dollar.queueMinter(address(m));
        assertEq(dollar.pendingMinter(), address(m));
        vm.expectRevert(TacSynth.NotMinter.selector);
        m.mint(dollar, bob, 1);
        vm.prank(OWNER);
        vm.expectRevert(TacSynth.TooEarly.selector);
        dollar.executeMinter();
        _wait(dollar.MINTER_DELAY());
        vm.prank(OWNER);
        dollar.executeMinter();
        assertTrue(dollar.isMinter(address(m)));
        assertEq(dollar.pendingMinter(), address(0));

        m.mint(dollar, bob, 5e18);
        assertEq(dollar.balanceOf(bob), 5e18);
        vm.prank(bob);
        dollar.approve(address(m), 5e18);
        m.burn(dollar, bob, 5e18);
        assertEq(dollar.balanceOf(bob), 0);

        vm.prank(OWNER);
        dollar.removeMinter(address(m));
        vm.expectRevert(TacSynth.NotMinter.selector);
        m.mint(dollar, bob, 1);
    }

    function test_theVaultThatDeployedTheSynthAlwaysKeepsItsOwnRights() public {
        vm.prank(OWNER);
        vm.expectRevert(TacSynth.BadMinter.selector);
        dollar.removeMinter(address(vault)); // it is not one of the further minters
        vm.prank(OWNER);
        vm.expectRevert(TacSynth.BadMinter.selector);
        dollar.queueMinter(address(vault));
        _open(alice, 15_000e18, 2_000e18);
        assertEq(dollar.balanceOf(alice), 2_000e18);
    }

    function test_aFurtherMinterMustBeAContractNewAndItsAnnouncementLapsesOrIsCancelled() public {
        SynthMinter m = new SynthMinter();
        vm.startPrank(OWNER);
        vm.expectRevert(TacSynth.BadMinter.selector);
        dollar.queueMinter(address(0x1234)); // no code
        vm.expectRevert(TacSynth.NothingQueued.selector);
        dollar.executeMinter();
        vm.expectRevert(TacSynth.NothingQueued.selector);
        dollar.cancelMinter();
        dollar.queueMinter(address(m));
        vm.expectEmit(true, false, false, false);
        emit TacSynth.MinterCancelled(address(m));
        dollar.cancelMinter();
        dollar.queueMinter(address(m));
        vm.stopPrank();
        _wait(dollar.MINTER_DELAY() + dollar.QUEUE_EXPIRY() + 1);
        vm.prank(OWNER);
        vm.expectRevert(TacSynth.Expired.selector);
        dollar.executeMinter();
    }

    /// The synth's owner is the vault's owner now: handing the vault over hands over the minters too.
    function test_theMintersAreGovernedByWhoOwnsTheVaultNow() public {
        SynthMinter m = new SynthMinter();
        address next = address(0x9999);
        vm.prank(OWNER);
        vault.transferOwnership(next);
        vm.prank(OWNER);
        vm.expectRevert(TacSynth.NotOwner.selector);
        dollar.queueMinter(address(m));
        vm.prank(next);
        dollar.queueMinter(address(m));
        assertEq(dollar.pendingMinter(), address(m));
    }

    function test_lockMintersEndsTheAdditionOfMintersForGood() public {
        SynthMinter m = new SynthMinter();
        SynthMinter m2 = new SynthMinter();
        vm.startPrank(OWNER);
        dollar.queueMinter(address(m));
        vm.expectEmit(false, false, false, false);
        emit TacSynth.MintersLocked();
        dollar.lockMinters();
        assertTrue(dollar.mintersLocked());
        assertEq(dollar.pendingMinter(), address(0));
        vm.expectRevert(TacSynth.Locked.selector);
        dollar.queueMinter(address(m2));
        vm.expectRevert(TacSynth.Locked.selector);
        dollar.executeMinter();
        vm.stopPrank();
    }
}
