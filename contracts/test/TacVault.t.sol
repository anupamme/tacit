// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TestTac, MockOracle, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

contract TacVaultTest is Test {
    // 0.0001 ETH per TAC at 4000 USD per ETH is 0.40 USD per TAC: 15,000 TAC is 6,000 USD, enough for 2,000 at 300%.
    uint256 constant P = 1e14;
    uint256 constant COLL = 15_000e18;
    uint256 constant MAX_DEBT = 2_000e18;
    uint256 constant MIN_DEBT = 100e18;
    uint256 constant CEILING = 10_000e18;
    uint256 constant D = 2 hours;
    // 0.20 USD per TAC puts a floor vault at 150%, under the 175% line.
    uint256 constant CRASH = 5e13;
    address constant OWNER = address(0x0123);
    address constant SINK = address(0xdEaD);
    address constant FEE_TO = address(0xFEE);

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
        vault = new TacVault(VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER));
        dollar = vault.SYNTH();
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            tac.mint(users[i], 1_000_000e18);
            vm.startPrank(users[i]);
            tac.approve(address(vault), type(uint256).max);
            dollar.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _open(address u, uint256 coll, uint256 debt) internal {
        vm.startPrank(u);
        vault.deposit(coll);
        vault.borrow(debt, 500);
        vm.stopPrank();
    }

    function _v(address u) internal view returns (uint256 coll, uint256 debt, uint256 start) {
        (coll, debt, start) = vault.vaults(u);
    }

    function _wait(uint256 t) internal {
        skip(t);
        feed.set(4000e8);
    }

    function _crashAndLiquidate() internal {
        _open(alice, COLL, MAX_DEBT);
        oracle.set(CRASH);
        vault.liquidate(alice);
    }

    // ───────────── borrowing ─────────────

    function test_borrowUpToTheFloor() public {
        _open(alice, COLL, MAX_DEBT);
        assertEq(dollar.balanceOf(alice), MAX_DEBT);
        vm.prank(alice);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.borrow(1, 0);
    }

    /// When the averages lag a fall, borrowing still takes the current price.
    function test_borrowViewTakesTheCurrentPrice() public {
        oracle.setPrices(P, P, P / 5); // averages still at 0.40, the pool already at 0.08
        vm.startPrank(alice);
        vault.deposit(COLL);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.borrow(MAX_DEBT / 5 + 1, 0);
        vault.borrow(MAX_DEBT / 5, 0);
        vm.stopPrank();
    }

    /// A pushed price or short average cannot raise the borrow view: it takes the lowest of the three.
    function test_borrowViewTakesTheLowest() public {
        vm.prank(alice);
        vault.deposit(COLL);
        oracle.setPrices(P, 10 * P, 10 * P);
        vm.prank(alice);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.borrow(MAX_DEBT + 1, 0);
        oracle.setPrices(10 * P, P, 10 * P);
        vm.prank(alice);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.borrow(MAX_DEBT + 1, 0);
    }

    function test_feeIsDebtAndTheBorrowerBoundsIt() public {
        vm.prank(OWNER);
        vault.setBorrowFee(100);
        vm.startPrank(alice);
        vault.deposit(COLL);
        vm.expectRevert(TacVault.FeeTooHigh.selector);
        vault.borrow(1_000e18, 99);
        vault.borrow(1_000e18, 100);
        vm.stopPrank();
        (, uint256 debt,) = _v(alice);
        assertEq(debt, 1_010e18);
        assertEq(dollar.balanceOf(FEE_TO), 10e18, "the fee circulates, so every debt can be repaid");
        assertEq(dollar.totalSupply(), vault.totalDebt());
    }

    /// Total debt stays under DEPTH_BPS of the pool's ETH depth, in dollars.
    function test_debtIsCappedByThePoolsDepth() public {
        oracle.setDepth(1e18); // 1 ETH of depth is 4,000 dollars
        vm.startPrank(alice);
        vault.deposit(1_000_000e18);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(4_000e18 + 1, 0);
        vault.borrow(4_000e18, 0);
        vm.stopPrank();
        assertEq(vault.depthCeiling(), 4_000e18);
    }

    function test_withdrawMoreThanTheCollateralTakesAll() public {
        vm.startPrank(alice);
        vault.deposit(COLL);
        vault.withdraw(type(uint256).max);
        vm.stopPrank();
        (uint256 coll,,) = _v(alice);
        assertEq(coll, 0);
    }

    function test_minimumDebtAndCeiling() public {
        vm.startPrank(alice);
        vault.deposit(1_000_000e18);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.borrow(MIN_DEBT - 1, 0);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(CEILING + 1, 0);
        vault.borrow(CEILING, 0);
        vm.stopPrank();
    }

    function test_withdrawKeepsTheVaultAtTheFloor() public {
        _open(alice, COLL * 2, MAX_DEBT);
        vm.startPrank(alice);
        vault.withdraw(COLL);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.withdraw(1);
        vm.stopPrank();
    }

    /// A repay above the debt pays the debt, so a full repay still closes a vault someone else just repaid.
    function test_repayClampsToTheDebt() public {
        _open(alice, COLL, MAX_DEBT);
        vm.prank(alice);
        dollar.transfer(bob, 1e18);
        vm.prank(bob);
        vault.repay(alice, 1); // someone else repays 1 wei first
        vm.prank(alice);
        vm.expectRevert(TacVault.BadAmount.selector); // would leave less than MIN_DEBT
        vault.repay(alice, MAX_DEBT - 2);
        vm.prank(bob);
        dollar.transfer(alice, 1e18 - 1);
        vm.prank(alice);
        uint256 paid = vault.repay(alice, MAX_DEBT); // the amount read before still closes it
        assertEq(paid, MAX_DEBT - 1);
        (, uint256 debt,) = _v(alice);
        assertEq(debt, 0);
    }

    function test_repayAndWithdrawNeedNoPrice() public {
        _open(alice, COLL, MAX_DEBT);
        oracle.setBroken(true);
        feed.setUpdatedAt(1);
        vm.startPrank(alice);
        vault.repay(alice, MAX_DEBT);
        vault.withdraw(COLL);
        vm.stopPrank();
    }

    function test_onlyTheVaultMintsTheDollar() public {
        vm.expectRevert(TacSynth.NotMinter.selector);
        dollar.mint(address(this), 1);
    }

    // ───────────── owner ─────────────

    function test_ownerSettingsAreBoundedAndTransferable() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setBorrowFee(1);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setDebtCeiling(1);
        vm.startPrank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.setBorrowFee(501);
        vault.transferOwnership(alice);
        vm.stopPrank();
        vm.prank(bob);
        vault.requestOwnershipHandover();
        vm.prank(alice);
        vault.completeOwnershipHandover(bob);
        assertEq(vault.owner(), bob);
    }

    // ───────────── liquidation ─────────────

    function test_aHealthyVaultCannotBeLiquidated() public {
        _open(alice, COLL, MAX_DEBT);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(bob);
    }

    /// Liquidation reads the averages, never the current price, and waits for both to fall.
    function test_liquidationWaitsForBothAverages() public {
        _open(alice, COLL, MAX_DEBT);
        oracle.setPrices(P, P, CRASH); // a dump the averages have not seen
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
        oracle.setPrices(P, CRASH, CRASH); // the short average followed, the long one not yet
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
        oracle.setPrices(CRASH, CRASH, P); // both followed; a pushed current price does not matter
        vault.liquidate(alice);
    }

    /// The offer starts at the debt's worth of TAC and grows to the debt plus 10% over the auction.
    function test_theOfferGrowsFromTheDebtToTheBonus() public {
        _crashAndLiquidate();
        assertEq(vault.onOffer(alice), 10_000e18, "2,000 at 0.20 USD per TAC");
        _wait(D / 2);
        assertEq(vault.onOffer(alice), 10_500e18);
        _wait(D / 2);
        assertEq(vault.onOffer(alice), 11_000e18);
        _wait(10 * D);
        assertEq(vault.onOffer(alice), 11_000e18, "stays at the bonus");
        vm.expectRevert(TacVault.InAuction.selector);
        vault.liquidate(alice);
    }

    /// The offer follows the current liquidation view: a further fall offers more TAC.
    function test_theOfferFollowsThePrice() public {
        _crashAndLiquidate();
        _wait(D);
        oracle.set(CRASH * 3 / 4);
        assertApproxEqAbs(vault.onOffer(alice), 14_666_666_666_666_666_666_666, 1e3, "2,000 x 1.10 at 0.15 USD");
    }

    /// Recovery reads the higher of the two low medians; with both low the auction cannot be ended.
    function test_recoveryTakesTheHigherLowMedian() public {
        _crashAndLiquidate();
        oracle.setPrices(CRASH, CRASH, P);
        vm.expectRevert(TacVault.StillUnhealthy.selector);
        vault.cancel(alice);
        oracle.setPrices(CRASH, 2 * P, CRASH);
        vault.cancel(alice);
    }

    /// Without a price only the owner bids.
    function test_withoutAPriceOnlyTheOwnerBids() public {
        _crashAndLiquidate();
        _open(bob, 100_000e18, MAX_DEBT);
        _wait(D);
        oracle.setBroken(true);
        vm.prank(bob);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.bid(alice, type(uint256).max, 0);
        vm.prank(alice);
        vault.bid(alice, type(uint256).max, 0);
    }

    /// A bid may repay part of the debt for the same share of the offer; the auction runs on for the rest while the
    /// vault is still below the line, and ends once the bid has brought it back.
    function test_aPartialBidTakesItsShare() public {
        _crashAndLiquidate();
        _wait(D);
        _open(bob, 100_000e18, MAX_DEBT);
        vm.startPrank(bob);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.bid(alice, MAX_DEBT - MIN_DEBT + 1, 0); // would leave less than MIN_DEBT
        uint256 taken = vault.bid(alice, MAX_DEBT / 5, 0);
        vm.stopPrank();
        assertEq(taken, 2_200e18);
        (uint256 coll, uint256 debt, uint256 start) = _v(alice);
        assertEq(coll, COLL - 2_200e18);
        assertEq(debt, MAX_DEBT * 4 / 5);
        assertGt(start, 0, "12,800 TAC at 0.20 is 160% of 1,600: the auction runs on");
    }

    function test_aPartialBidThatRestoresHealthEndsTheAuction() public {
        _crashAndLiquidate();
        _wait(D);
        _open(bob, 100_000e18, MAX_DEBT);
        vm.prank(bob);
        vault.bid(alice, MAX_DEBT / 2, 0);
        (uint256 coll, uint256 debt, uint256 start) = _v(alice);
        assertEq(coll, COLL - 5_500e18);
        assertEq(debt, MAX_DEBT / 2);
        assertEq(start, 0, "9,500 TAC at 0.20 is 190% of 1,000: back over the line");
        assertTrue(vault.liqHealthyView(alice));
    }

    /// Others wait OWNER_WINDOW from the auction's start; the owner may bid at once.
    function test_othersWaitForTheOwnerWindow() public {
        _crashAndLiquidate();
        _open(bob, 100_000e18, MAX_DEBT);
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, type(uint256).max, 0);
        skip(20 minutes - 1);
        feed.set(4000e8);
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, type(uint256).max, 0);
        skip(1);
        feed.set(4000e8);
        vm.prank(bob);
        vault.bid(alice, type(uint256).max, 0);
    }

    function test_theOwnerBidsInsideTheOwnerWindow() public {
        _crashAndLiquidate();
        vm.prank(alice);
        uint256 taken = vault.bid(alice, type(uint256).max, 0);
        assertEq(taken, 10_000e18, "the offer starts at the debt's worth");
    }

    /// Only the owner bids on a vault that has recovered.
    function test_aRecoveredVaultTakesOnlyTheOwnersBid() public {
        _crashAndLiquidate();
        _wait(D);
        _open(bob, 100_000e18, MAX_DEBT);
        oracle.set(CRASH * 3 / 2); // 0.30 USD: 4,500 against 2,000, under 175% but up from the crash
        assertApproxEqAbs(vault.onOffer(alice), 7_333_333_333_333_333_333_333, 1e3, "2,200 at 0.30 USD");
        oracle.set(CRASH * 2); // healthy again
        vm.prank(bob);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.bid(alice, type(uint256).max, 0);
    }

    function test_aBidTakesTheOfferAndLeavesTheRest() public {
        _crashAndLiquidate();
        _wait(D);
        _open(bob, 100_000e18, MAX_DEBT);
        vm.prank(bob);
        uint256 taken = vault.bid(alice, type(uint256).max, 11_000e18);
        assertEq(taken, 11_000e18);
        (uint256 coll, uint256 debt, uint256 start) = _v(alice);
        assertEq(coll, COLL - taken, "4,000 TAC stay the owner's");
        assertEq(debt, 0);
        assertEq(start, 0);
    }

    function test_theOwnerCanAlwaysTakeItAllBack() public {
        _crashAndLiquidate();
        skip(1 minutes);
        oracle.setBroken(true);
        feed.setUpdatedAt(1);
        vm.prank(alice);
        uint256 taken = vault.bid(alice, type(uint256).max, 0);
        assertEq(taken, COLL, "without a price the owner's bid takes the whole collateral");
        assertEq(tac.balanceOf(alice), 1_000_000e18);
    }

    function test_noBorrowWithdrawOrRedeemDuringAnAuction() public {
        _crashAndLiquidate();
        vm.startPrank(alice);
        vm.expectRevert(TacVault.InAuction.selector);
        vault.borrow(1, 0);
        vm.expectRevert(TacVault.InAuction.selector);
        vault.withdraw(1);
        vm.expectRevert(TacVault.InAuction.selector);
        vault.redeem(alice, 100e18, 0);
        vm.stopPrank();
    }

    function test_depositOrRepayDuringAnAuctionEndsItOnceHealthy() public {
        _crashAndLiquidate();
        vm.startPrank(alice);
        vault.deposit(1e18); // not enough: the auction keeps running
        (,, uint256 start) = _v(alice);
        assertGt(start, 0);
        vault.deposit(COLL); // 30,000 TAC at 0.20 is 6,000 USD: 300%
        vm.stopPrank();
        (,, start) = _v(alice);
        assertEq(start, 0);
    }

    /// Without a price an owner can still deposit or repay.
    function test_rescueStillWorksDuringAnOutage() public {
        _crashAndLiquidate();
        oracle.setBroken(true);
        feed.setUpdatedAt(1);
        vm.startPrank(alice);
        vault.deposit(1_000e18);
        vault.repay(alice, MAX_DEBT / 2);
        vm.stopPrank();
        (, uint256 debt, uint256 start) = _v(alice);
        assertGt(start, 0, "without a price the auction keeps running");
        assertEq(debt, MAX_DEBT / 2);
    }

    function test_cancelOnceThePriceRecovers() public {
        _crashAndLiquidate();
        vm.expectRevert(TacVault.StillUnhealthy.selector);
        vault.cancel(alice);
        oracle.set(P);
        vault.cancel(alice);
        vm.expectRevert(TacVault.NoAuction.selector);
        vault.bid(alice, type(uint256).max, 0);
    }

    // ───────────── absorb ─────────────

    // Bob borrows and gives `reserve` dollars to the vault's reserve; Alice owes 210 against 15,000 TAC, which
    // then falls to 180 dollars: an underwater auction.
    function _underwater(uint256 reserve) internal {
        _open(bob, 1_000_000e18, 5_000e18);
        vm.prank(bob);
        dollar.transfer(address(vault), reserve);
        _open(alice, COLL, 210e18);
        oracle.set(5e12);
        vault.liquidate(alice);
        oracle.set(3e12);
    }

    /// The owner moves where the TAC of an absorb goes; the old sink gets none after that.
    function test_absorbSendsTheTacToTheSinkTheOwnerSet() public {
        address newSink = address(0x51);
        vm.prank(OWNER);
        vault.setTacSink(newSink);
        assertEq(vault.tacSink(), newSink);
        _underwater(250e18);
        _wait(D);
        uint256 oldSinkBefore = tac.balanceOf(SINK);
        vault.absorb(alice);
        assertEq(tac.balanceOf(newSink), COLL);
        assertEq(tac.balanceOf(SINK), oldSinkBefore);
    }

    /// The owner moves where the borrow fee is minted; the old address gets none after that.
    function test_theFeeGoesToTheAddressTheOwnerSet() public {
        address newFeeTo = address(0xFE2);
        vm.startPrank(OWNER);
        vault.setBorrowFee(100);
        vault.setFeeTo(newFeeTo);
        vm.stopPrank();
        assertEq(vault.feeTo(), newFeeTo);
        vm.startPrank(alice);
        vault.deposit(COLL);
        vault.borrow(1_000e18, 100);
        vm.stopPrank();
        assertEq(dollar.balanceOf(newFeeTo), 10e18);
        assertEq(dollar.balanceOf(FEE_TO), 0);
        assertEq(dollar.totalSupply(), vault.totalDebt());
    }

    /// Both setters are for the owner alone, refuse the zero address, and say what they set.
    function test_theFeeAndSinkSettersAreOwnerOnlyAndRefuseZero() public {
        vm.startPrank(alice);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setFeeTo(alice);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setTacSink(alice);
        vm.stopPrank();
        vm.startPrank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.setFeeTo(address(0));
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.setTacSink(address(0));
        vm.expectEmit(false, false, false, true);
        emit TacVault.FeeToSet(bob);
        vault.setFeeTo(bob);
        vm.expectEmit(false, false, false, true);
        emit TacVault.TacSinkSet(bob);
        vault.setTacSink(bob);
        vm.stopPrank();
        assertEq(vault.feeTo(), bob);
        assertEq(vault.tacSink(), bob);
    }

    function test_absorbSettlesAnUnderwaterAuctionFromTheReserve() public {
        _underwater(250e18);
        vm.expectRevert(TacVault.TooEarly.selector);
        vault.absorb(alice);
        _wait(D);
        uint256 sinkBefore = tac.balanceOf(SINK);
        vault.absorb(alice);
        (uint256 coll, uint256 debt, uint256 start) = _v(alice);
        assertEq(coll + debt + start, 0);
        assertEq(tac.balanceOf(SINK) - sinkBefore, COLL);
        assertEq(dollar.balanceOf(address(vault)), 40e18);
        assertEq(dollar.totalSupply(), vault.totalDebt());
    }

    /// A reserve short of the debt burns what it covers and takes the same share of the TAC.
    function test_absorbIsPartialWhenTheReserveIsShort() public {
        _underwater(105e18);
        _wait(D);
        vault.absorb(alice);
        (uint256 coll, uint256 debt, uint256 start) = _v(alice);
        assertEq(debt, 105e18);
        assertEq(coll, COLL / 2);
        assertGt(start, 0, "the rest stays in the auction");
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.absorb(alice);
        assertEq(dollar.totalSupply(), vault.totalDebt());
    }

    function test_absorbRefusesAVaultWorthItsDebt() public {
        _open(alice, COLL, MAX_DEBT);
        _open(bob, 1_000_000e18, 5_000e18);
        vm.prank(bob);
        dollar.transfer(address(vault), 5_000e18);
        oracle.set(CRASH);
        vault.liquidate(alice);
        _wait(2 * D);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.absorb(alice);
    }

    // ───────────── redemption ─────────────

    function test_redeemTakesTacAtParLessTheFee() public {
        _open(alice, COLL, MAX_DEBT);
        vm.prank(alice);
        dollar.transfer(bob, 1_000e18);
        vm.prank(bob);
        // At 300% against a 175% line the fee is 0.5% + 1.5% x 125/175 = 1.57%: 984.30 dollars at 0.40.
        assertEq(vault.redeem(alice, 1_000e18, 0), 2_460.75e18);
        assertEq(dollar.totalSupply(), vault.totalDebt());
    }

    /// When the averages lag a rise, redemption takes the newest recorded interval's price.
    function test_redeemPricesAtTheCurrentPriceDuringARally() public {
        _open(alice, COLL, MAX_DEBT);
        vm.prank(alice);
        dollar.transfer(bob, 1_000e18);
        oracle.setLatest(P * 13 / 10); // the newest interval up 30%, the averages not yet
        vm.prank(bob);
        uint256 got = vault.redeem(alice, 1_000e18, 0);
        assertEq(got, 984.3e18 * 1e18 / (P * 13 / 10 * 4000), "priced at the newest interval, not the lagging average");
    }

    /// The fee is lowest near the liquidation line, so the least collateralised vaults are redeemed first; a vault
    /// at twice the line or more is not redeemable.
    function test_redemptionFeeRisesWithTheRatio() public {
        _open(alice, COLL, MAX_DEBT); // 300%
        _open(bob, COLL * 2, MAX_DEBT); // 600%
        vm.prank(alice);
        dollar.transfer(address(this), 200e18);
        dollar.approve(address(vault), type(uint256).max);
        assertEq(vault.redeem(alice, 100e18, 0), 246.075e18);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.redeem(bob, 100e18, 0);
    }

    /// A rally the medians have not caught up with raises the offer's price, so TAC is not sold at the stale one;
    /// a price pushed within one transaction does not.
    function test_theOfferFloorsAtTheNewestIntervalNotTheCurrentPrice() public {
        _crashAndLiquidate();
        assertEq(vault.onOffer(alice), 10_000e18, "2,000 at 0.20");
        oracle.setPrices(CRASH, CRASH, 4 * CRASH); // one venue pushed within the block
        assertEq(vault.onOffer(alice), 10_000e18, "the current price does not move the offer");
        oracle.setLatest(2 * CRASH); // the newest interval doubled while the medians lag
        assertEq(vault.onOffer(alice), 5_000e18, "2,000 at 0.40");
    }

    // ───────────── signatures ─────────────

    uint256 constant KEY = 0xBEEF;

    function _sigBorrow(uint256 amount, uint256 maxFee, address to, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(vault.BORROW(), vm.addr(KEY), amount, maxFee, COLL, to, nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, vault.digest(sh));
        return abi.encodePacked(r, s, v);
    }

    function test_signedBorrowBindsFeeRecipientAndNonce() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, COLL);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sigBorrow(500e18, 0, bob, 0, dl);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 500e18, 0, COLL, alice, dl, sig);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 500e18, 100, COLL, bob, dl, sig);
        vault.borrowFor(owner, 500e18, 0, COLL, bob, dl, sig);
        assertEq(dollar.balanceOf(bob), 500e18);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 500e18, 0, COLL, bob, dl, sig);
    }

    /// An owner with code (an EIP-7702 delegated account) still authorises with its key's ECDSA signature.
    function test_aDelegatedAccountsKeySignatureIsAccepted() public {
        address owner = vm.addr(KEY);
        vm.etch(owner, hex"ef0100000000000000000000000000000000000000dead");
        vm.prank(alice);
        vault.depositFor(owner, COLL);
        uint256 dl = block.timestamp + 1 hours;
        vault.borrowFor(owner, 500e18, 0, COLL, bob, dl, _sigBorrow(500e18, 0, bob, 0, dl));
        assertEq(dollar.balanceOf(bob), 500e18);
    }

    /// A signature cannot be used before the collateral it names is in the vault.
    function test_signedBorrowRequiresThePlannedCollateral() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, COLL / 2);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sigBorrow(500e18, 0, bob, 0, dl);
        vm.expectRevert(TacVault.TooLittleCollateral.selector);
        vault.borrowFor(owner, 500e18, 0, COLL, bob, dl, sig);
    }

    function test_anOwnerCanCancelAnOutstandingSignature() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, COLL);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sigBorrow(500e18, 0, bob, 0, dl);
        vm.prank(owner);
        vault.useNonce();
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 500e18, 0, COLL, bob, dl, sig);
    }

    // ───────────── failing closed ─────────────

    function test_borrowingAndLiquidatingNeedAPrice() public {
        _open(alice, COLL, MAX_DEBT / 2);
        oracle.setBroken(true);
        vm.prank(alice);
        vm.expectRevert(bytes("oracle"));
        vault.borrow(MIN_DEBT, 0);
        vm.expectRevert(bytes("oracle"));
        vault.liquidate(alice);
        oracle.setBroken(false);
        feed.setUpdatedAt(block.timestamp - 2 hours);
        vm.prank(alice);
        vm.expectRevert(TacVault.StaleFeed.selector);
        vault.borrow(MIN_DEBT, 0);
    }

    function test_constructorRejectsBadConfig() public {
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
        c.owner = address(0);
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c = VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
        c.liqBonusBps = 7_500; // 1 + bonus must stay under the liquidation ratio
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c = VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
        c.liqWindow = 3 hours; // must equal the oracle's longest window
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c = VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
        c.ownerWindow = c.auctionDuration; // the owner's window must end before the auction does
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c = VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
        c.tacSink = address(0);
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c = VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
        c.feeTo = address(0);
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c = VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
        c.depthBps = 0;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
    }
}
