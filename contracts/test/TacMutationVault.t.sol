// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TestTac, MockOracle, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

/// An oracle whose every value is set per window: a low, a high and a recovery value, a depth median and a smallest
/// depth, so that tests can make the borrow, liquidation, recovery and offer views differ from one another. Windows
/// nobody set read the default. `STEP` and the windows are settable (the pair and the vault read them at construction).
contract SplitOracle {
    uint256 public STEP = 50;
    uint256 public SHORT_WINDOW = 10 minutes;
    uint256 public WINDOW = 1 hours;
    uint256 public MAX_WINDOW = 4 hours;

    struct W {
        bool set;
        uint256 low;
        uint256 high;
        uint256 rec;
        uint256 depth;
        uint256 dmin;
    }
    mapping(uint256 => W) internal w;
    W internal dflt;
    uint256 internal _latest;
    uint256 public spot;
    bool public latestBroken;
    address internal _pool = address(this);

    function setStep(uint256 s) external {
        STEP = s;
    }

    function setWindows(uint256 s, uint256 l, uint256 m) external {
        (SHORT_WINDOW, WINDOW, MAX_WINDOW) = (s, l, m);
    }

    function setAll(uint256 low, uint256 high) external {
        dflt = W(true, low, high, low, 1e30, 1e30);
        (_latest, spot) = (low, low);
    }

    /// Sets a window's values; its depth median and smallest depth are both `depth_`.
    function setFor(uint256 window, uint256 low, uint256 high, uint256 rec, uint256 depth_) external {
        w[window] = W(true, low, high, rec, depth_, depth_);
    }

    /// Sets the smallest recorded depth of a window apart from its median (the window must have been set).
    function setDepthMin(uint256 window, uint256 dmin) external {
        if (!w[window].set) w[window] = dflt;
        w[window].dmin = dmin;
    }

    function setDepthMedian(uint256 window, uint256 depth_) external {
        if (!w[window].set) w[window] = dflt;
        w[window].depth = depth_;
    }

    function setLive(uint256 latest_, uint256 spot_) external {
        (_latest, spot) = (latest_, spot_);
    }

    function breakLatest(bool b) external {
        latestBroken = b;
    }

    function latest() external view returns (uint256) {
        if (latestBroken) revert("latest");
        return _latest;
    }

    function setPool(address p) external {
        _pool = p;
    }

    function POOL() external view returns (address) {
        return _pool;
    }

    function _w(uint256 window) internal view returns (W memory x) {
        x = w[window].set ? w[window] : dflt;
    }

    function prices(uint256 window) external view returns (uint256, uint256) {
        W memory x = _w(window);
        return (x.low, x.high);
    }

    function recovery(uint256 window) external view returns (uint256) {
        return _w(window).rec;
    }

    function depth(uint256 window) external view returns (uint256) {
        return _w(window).depth;
    }

    function depthMin(uint256 window) external view returns (uint256) {
        return _w(window).dmin;
    }
}

contract DecimalsFeed {
    uint8 public d;

    constructor(uint8 d_) {
        d = d_;
    }

    function decimals() external view returns (uint8) {
        return d;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 4000e8, block.timestamp, block.timestamp, 1);
    }
}

/// Boundaries, rounding and ordering of the vault's checks: constructor bounds, signatures, repay, withdraw, borrow,
/// bid, absorb and redeem edges, and the price feed's freshness rules.
contract TacMutationVaultTest is Test {
    uint256 constant P = 1e14; // 0.40 USD per TAC at 4,000 USD per ETH
    uint256 constant COLL = 15_000e18;
    uint256 constant MAX_DEBT = 2_000e18;
    uint256 constant MIN_DEBT = 100e18;
    uint256 constant D = 2 hours;
    uint256 constant CRASH = 5e13; // 0.20 USD
    address constant OWNER = address(0x0123);
    address constant SINK = address(0xdEaD);

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
        _fund();
    }

    function _fund() internal {
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            tac.mint(users[i], 10_000_000e18);
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

    function _v(address u) internal view returns (uint256 c, uint256 d, uint256 s) {
        (c, d, s) = vault.vaults(u);
    }

    function _cfg() internal view returns (TacVault.Config memory) {
        return VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
    }

    // ───────────── constructor bounds ─────────────

    /// The mint ratio is at least 20 points over the liquidation ratio and at most 1,000%.
    function test_ctorMintRatioBounds() public {
        TacVault.Config memory c = _cfg();
        c.mintRatioBps = c.liqRatioBps + 1_999;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.mintRatioBps = c.liqRatioBps + 2_000;
        new TacVault(c);
        c.mintRatioBps = 100_001;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.mintRatioBps = 100_000;
        new TacVault(c);
    }

    /// OWNER_WINDOW is at least ten minutes and ends before the auction does.
    function test_ctorOwnerWindowBounds() public {
        TacVault.Config memory c = _cfg();
        c.ownerWindow = c.auctionDuration - 1;
        TacVault v = new TacVault(c);
        assertEq(v.OWNER_WINDOW(), c.auctionDuration - 1);
        c.ownerWindow = 10 minutes;
        v = new TacVault(c);
        assertEq(v.OWNER_WINDOW(), 10 minutes);
        c.ownerWindow = 10 minutes - 1;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.ownerWindow = c.auctionDuration;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.ownerWindow = c.auctionDuration + 1;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c = _cfg();
        c.auctionDuration = 0;
        c.ownerWindow = 0;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
    }

    function test_ctorFeedDecimalsAndFeeCaps() public {
        TacVault.Config memory c = _cfg();
        c.ethUsd = address(new DecimalsFeed(19));
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.ethUsd = address(new DecimalsFeed(18));
        new TacVault(c);
        c = _cfg();
        c.redemptionFeeBps = 251;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.redemptionFeeBps = 250;
        new TacVault(c);
        c = _cfg();
        c.borrowFeeBps = 501;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.borrowFeeBps = 500;
        new TacVault(c);
        c = _cfg();
        c.liqRatioBps = 11_999;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.liqRatioBps = 12_000;
        new TacVault(c);
        // The bonus is at most 50% and keeps 100% plus it under the liquidation ratio.
        c = _cfg();
        c.liqRatioBps = 14_000;
        c.liqBonusBps = 4_000; // BPS + bonus == liq ratio: refused
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.liqBonusBps = 3_999;
        new TacVault(c);
        c = _cfg();
        c.liqBonusBps = 5_001;
        vm.expectRevert(TacVault.BadConfig.selector);
        new TacVault(c);
        c.liqBonusBps = 5_000;
        new TacVault(c);
    }

    function test_setBorrowFeeAtTheMaximum() public {
        vm.prank(OWNER);
        vault.setBorrowFee(500);
        assertEq(vault.borrowFeeBps(), 500);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.setBorrowFee(501);
    }

    // ───────────── borrow / repay / withdraw edges ─────────────

    function test_borrowExactlyTheMinimumDebtAndTheFeeRoundsDown() public {
        vm.startPrank(alice);
        vault.deposit(COLL);
        vault.borrow(MIN_DEBT, 0); // exactly the minimum: allowed
        vm.stopPrank();
        vm.prank(OWNER);
        vault.setBorrowFee(100);
        vm.prank(alice);
        vault.borrow(1_000e18 + 1, 100);
        (, uint256 debt,) = _v(alice);
        // fee = (1000e18 + 1) * 100 / 10000 rounds down to 10e18
        assertEq(debt, MIN_DEBT + 1_000e18 + 1 + 10e18);
        assertEq(dollar.balanceOf(address(0xFEE)), 10e18);
        assertEq(dollar.totalSupply(), vault.totalDebt());
    }

    function test_borrowCeilingAndDepthCapBoundariesAreInclusive() public {
        vm.prank(OWNER);
        vault.setDebtCeiling(500e18);
        vm.startPrank(alice);
        vault.deposit(1_000_000e18);
        vault.borrow(500e18, 0); // total == ceiling: allowed
        vm.stopPrank();
        vm.prank(OWNER);
        vault.setDebtCeiling(type(uint128).max);
        oracle.setDepth(10e18); // 40,000 USD of ETH depth at depthBps 1,000: a cap of 4,000
        vm.prank(alice);
        vault.borrow(3_500e18, 0); // total 4,000 == the cap: allowed
        vm.prank(alice);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(1, 0);
    }

    function test_repayLeavingExactlyTheMinimumAndKeepingTotalDebt() public {
        _open(alice, COLL, MAX_DEBT);
        vm.prank(alice);
        vault.repay(alice, MAX_DEBT - MIN_DEBT); // leaves exactly MIN_DEBT: allowed
        (, uint256 debt,) = _v(alice);
        assertEq(debt, MIN_DEBT);
        assertEq(vault.totalDebt(), MIN_DEBT, "totalDebt follows the repay");
        assertEq(dollar.totalSupply(), vault.totalDebt());
        vm.prank(alice);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.repay(alice, 0);
        vm.prank(alice);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.repay(bob, 5e18); // bob owes nothing
    }

    function test_repayDuringAnAuctionEndsItOnceRecovered() public {
        _open(alice, COLL, MAX_DEBT);
        oracle.set(CRASH);
        vault.liquidate(alice);
        vm.prank(alice);
        vault.repay(alice, 1_000e18); // 3,000 USD of TAC against 1,000: 300% >= 175%
        (,, uint256 start) = _v(alice);
        assertEq(start, 0, "repay ended the auction");
    }

    function test_repayingEverythingEndsTheAuctionEvenWithoutAPrice() public {
        _open(alice, COLL, MAX_DEBT);
        oracle.set(CRASH);
        vault.liquidate(alice);
        oracle.setBroken(true);
        feed.setUpdatedAt(1);
        vm.prank(alice);
        vault.repay(alice, MAX_DEBT);
        (, uint256 debt, uint256 start) = _v(alice);
        assertEq(debt, 0);
        assertEq(start, 0, "no debt, no auction, price or not");
    }

    function test_zeroDepositWithdrawAndZeroOwnerAreRefused() public {
        vm.startPrank(alice);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.deposit(0);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.depositFor(address(0), 1e18);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.withdraw(0);
        vault.deposit(1e18);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.withdraw(0);
        vm.stopPrank();
    }

    function test_withdrawDuringAnAuctionIsRefusedEvenWithoutDebtCheckFailing() public {
        _open(alice, COLL * 100, MAX_DEBT);
        oracle.set(CRASH / 1000);
        vault.liquidate(alice);
        oracle.set(P * 100); // hugely healthy
        vm.prank(alice);
        vm.expectRevert(TacVault.InAuction.selector);
        vault.withdraw(1e18);
    }

    function test_withdrawNeedsAHealthyVaultOnlyWhileThereIsDebt() public {
        _open(alice, COLL, MAX_DEBT);
        oracle.set(CRASH); // below the mint line at the borrow view
        vm.prank(alice);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.withdraw(1e18);
        vm.prank(alice);
        vault.repay(alice, MAX_DEBT);
        vm.prank(alice);
        vault.withdraw(COLL);
    }

    function test_borrowDuringAnAuctionIsRefused() public {
        _open(alice, COLL, MAX_DEBT / 2);
        oracle.set(CRASH / 3);
        vault.liquidate(alice);
        oracle.set(P * 10);
        vm.prank(alice);
        vm.expectRevert(TacVault.InAuction.selector);
        vault.borrow(MIN_DEBT, 0);
    }

    function test_borrowWithoutTheHealthCheckWouldBeCaught() public {
        vm.startPrank(alice);
        vault.deposit(COLL);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.borrow(MAX_DEBT + 1e18, 0);
        vm.stopPrank();
    }

    function test_theFeeIsMintedToTheFeeRecipient() public {
        vm.prank(OWNER);
        vault.setBorrowFee(50);
        vm.startPrank(alice);
        vault.deposit(COLL);
        vault.borrow(1_000e18, 50);
        vm.stopPrank();
        assertEq(dollar.balanceOf(address(0xFEE)), 5e18);
        assertEq(dollar.balanceOf(alice), 1_000e18);
        // the borrower can repay everything: borrowed + fee minted
        vm.prank(address(0xFEE));
        dollar.transfer(alice, 5e18);
        vm.prank(alice);
        vault.repay(alice, 1_005e18);
        assertEq(vault.totalDebt(), 0);
        assertEq(dollar.totalSupply(), 0);
    }

    // ───────────── signatures ─────────────

    uint256 constant KEY = 0xBEEF;

    function _sigBorrow(address owner, uint256 amount, address to, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(vault.BORROW(), owner, amount, uint256(0), COLL, to, nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, vault.digest(sh));
        return abi.encodePacked(r, s, v);
    }

    function test_theDeadlineIsInclusiveAndTheNonceAdvances() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, COLL);
        uint256 dl = vm.getBlockTimestamp(); // the deadline is this very second
        vault.borrowFor(owner, 200e18, 0, COLL, bob, dl, _sigBorrow(owner, 200e18, bob, 0, dl));
        assertEq(vault.nonces(owner), 1, "the nonce is spent");
        bytes memory replay = _sigBorrow(owner, 200e18, bob, 0, dl);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 200e18, 0, COLL, bob, dl, replay);
        // an expired one
        bytes memory expired = _sigBorrow(owner, 200e18, bob, 1, dl);
        skip(1);
        vm.expectRevert(TacVault.Expired.selector);
        vault.borrowFor(owner, 200e18, 0, COLL, bob, dl, expired);
    }

    function test_signedCallsRefuseZeroRecipientAndZeroOwner() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, COLL);
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        // a recipient of zero, even with a valid signature
        bytes memory zeroTo = _sigBorrow(owner, 200e18, address(0), 0, dl);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.borrowFor(owner, 200e18, 0, COLL, address(0), dl, zeroTo);
        // an owner of zero: an invalid signature recovers to the zero address, which must not pass as the owner
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.borrowFor(address(0), 200e18, 0, 0, bob, dl, hex"00");
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.withdrawFor(address(0), 1e18, bob, dl, hex"00");
    }

    function test_withdrawForBindsRecipientAndNonce() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, COLL);
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        bytes32 sh = keccak256(abi.encode(vault.WITHDRAW(), owner, 1_000e18, bob, uint256(0), dl));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, vault.digest(sh));
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.withdrawFor(owner, 1_000e18, alice, dl, sig); // a different recipient
        vault.withdrawFor(owner, 1_000e18, bob, dl, sig);
        assertEq(tac.balanceOf(bob), 10_000_000e18 + 1_000e18);
        assertEq(vault.nonces(owner), 1);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.withdrawFor(owner, 1_000e18, bob, dl, sig);
    }

    // ───────────── the synth ─────────────

    function test_onlyTheVaultBurnsAndOnlyWithAnAllowance() public {
        _open(alice, COLL, MAX_DEBT);
        vm.prank(alice);
        vm.expectRevert(TacSynth.NotMinter.selector);
        dollar.burnFrom(alice, 1e18);
        vm.prank(alice);
        dollar.approve(address(vault), 0);
        vm.prank(alice);
        vm.expectRevert(); // allowance
        vault.repay(alice, 500e18);
    }

    // ───────────── auction boundaries ─────────────

    // 17,500 TAC at 0.20 USD is 3,500: exactly 175% of a 2,000 debt.
    function test_exactlyAtTheLiquidationLineIsHealthy() public {
        _open(alice, 17_500e18, MAX_DEBT);
        oracle.set(CRASH);
        assertTrue(vault.liqHealthyView(alice), "equal counts as healthy");
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
        oracle.set(CRASH - 1);
        assertFalse(vault.liqHealthyView(alice));
        vault.liquidate(alice);
    }

    function test_exactlyAtTheLineAnAuctionCancelsAndCountsAsRecovered() public {
        _open(alice, 17_500e18, MAX_DEBT);
        oracle.set(CRASH - 1);
        vault.liquidate(alice);
        oracle.set(CRASH);
        assertTrue(vault.recovered(alice));
        vault.cancel(alice);
        (,, uint256 start) = _v(alice);
        assertEq(start, 0);
    }

    function test_redeemAtExactlyTheLiquidationRatioAndNotAtTwiceIt() public {
        // ratio exactly 175%
        _open(alice, 17_500e18, MAX_DEBT);
        vm.prank(alice);
        dollar.transfer(bob, 500e18);
        oracle.set(CRASH);
        vm.prank(bob);
        vault.redeem(alice, 100e18, 0); // allowed at the line itself
        // ratio exactly 350%: 35,000 TAC at 0.20 against 2,000 is refused (not below twice the line)
        _open(bob, 35_000e18, MAX_DEBT);
        vm.prank(alice);
        dollar.transfer(address(this), 100e18);
        dollar.approve(address(vault), type(uint256).max);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.redeem(bob, 100e18, 0);
        oracle.set(CRASH - 1); // just below 350%
        vault.redeem(bob, 100e18, 0);
    }

    function test_redeemAllDebtTakesTheCollateralShareAndLowersIt() public {
        _open(alice, COLL, MAX_DEBT);
        vm.prank(alice);
        dollar.transfer(bob, 100e18);
        // bob needs the 2,000: alice holds them
        vm.prank(alice);
        dollar.transfer(bob, MAX_DEBT - 100e18);
        uint256 before = tac.balanceOf(bob);
        vm.prank(bob);
        uint256 got = vault.redeem(alice, MAX_DEBT, 0); // all of it: allowed
        assertEq(tac.balanceOf(bob) - before, got);
        (uint256 coll, uint256 debt,) = _v(alice);
        assertEq(debt, 0);
        assertEq(coll, COLL - got, "the redeemed TAC left the vault's books");
        assertEq(dollar.totalSupply(), vault.totalDebt());
        assertEq(tac.balanceOf(address(vault)), coll);
    }

    function test_partialBidLeavingExactlyTheMinimumAndTheShareRoundsDown() public {
        _open(alice, COLL, MAX_DEBT);
        oracle.set(CRASH);
        vault.liquidate(alice);
        skip(D);
        feed.set(4000e8);
        _open(bob, 100_000e18, MAX_DEBT);
        uint256 offer = vault.onOffer(alice); // 11,000 TAC
        uint256 amount = 100e18 + 13;
        vm.prank(bob);
        uint256 taken = vault.bid(alice, amount, 0);
        assertEq(taken, offer * amount / MAX_DEBT, "the share rounds down");
        assertEq(vault.totalDebt(), 2 * MAX_DEBT - amount, "totalDebt follows the bid");
        assertEq(dollar.totalSupply(), vault.totalDebt());
        (uint256 coll, uint256 debt,) = _v(alice);
        assertEq(coll, COLL - taken);
        assertEq(debt, MAX_DEBT - amount);
        // the rest down to exactly MIN_DEBT (the vault is still under its line: 14,450 TAC at 0.20 against 1,887)
        vm.prank(bob);
        vault.bid(alice, debt - MIN_DEBT, 0);
        (, debt,) = _v(alice);
        assertEq(debt, MIN_DEBT);
    }

    function test_aBidIsRefusedAtMinTacExactly() public {
        _open(alice, COLL, MAX_DEBT);
        oracle.set(CRASH);
        vault.liquidate(alice);
        skip(D);
        feed.set(4000e8);
        _open(bob, 100_000e18, MAX_DEBT);
        vm.prank(bob);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.bid(alice, type(uint256).max, 11_000e18 + 1);
        vm.prank(bob);
        vault.bid(alice, type(uint256).max, 11_000e18); // exactly the offer: allowed
    }

    function test_onOfferWithoutAnAuctionIsZero() public {
        _open(alice, COLL, MAX_DEBT);
        assertEq(vault.onOffer(alice), 0);
        assertEq(vault.onOffer(bob), 0);
    }

    function test_theOfferBonusGrowsLinearlyAndStopsAtTheDuration() public {
        _open(alice, COLL, MAX_DEBT);
        oracle.set(CRASH);
        vault.liquidate(alice);
        skip(D / 4);
        feed.set(4000e8);
        assertEq(vault.onOffer(alice), 10_250e18, "2,000 x 1.025 at 0.20");
        skip(D);
        feed.set(4000e8);
        assertEq(vault.onOffer(alice), 11_000e18);
        skip(100 * D);
        feed.set(4000e8);
        assertEq(vault.onOffer(alice), 11_000e18, "capped at the bonus, never beyond");
    }

    // ───────────── absorb boundaries ─────────────

    // Alice owes 210 against 15,000 TAC; the reserve is `reserve` dollars (Bob lends it).
    function _auction(uint256 reserve) internal {
        _open(bob, 1_000_000e18, 5_000e18);
        vm.prank(bob);
        dollar.transfer(address(vault), reserve);
        _open(alice, COLL, 210e18);
        oracle.set(5e12);
        vault.liquidate(alice);
        skip(D);
        feed.set(4000e8);
    }

    function test_absorbRefusesAVaultWorthExactlyItsDebt() public {
        _auction(500e18);
        oracle.set(35e11); // 15,000 TAC at 0.014 USD is exactly 210
        assertEq(vault.valueOf(COLL, false), 210e18);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.absorb(alice);
        oracle.set(35e11 - 1);
        vault.absorb(alice);
    }

    function test_absorbLeavesTheMinimumWhenTheReserveIsInTheDustBand() public {
        _auction(150e18); // reserve 150 against 210: burning all 150 would leave 60 < 100
        oracle.set(3e12);
        vault.absorb(alice);
        (uint256 coll, uint256 debt,) = _v(alice);
        assertEq(debt, MIN_DEBT, "burns 110, leaving exactly the minimum");
        assertEq(COLL - coll, COLL * 110e18 / 210e18);
        assertEq(tac.balanceOf(SINK), COLL * 110e18 / 210e18);
        assertEq(dollar.balanceOf(address(vault)), 40e18);
        assertEq(dollar.totalSupply(), vault.totalDebt());
    }

    function test_absorbWithAReserveEqualToTheDebtTakesItAll() public {
        _auction(210e18);
        oracle.set(3e12);
        vault.absorb(alice);
        (uint256 coll, uint256 debt, uint256 start) = _v(alice);
        assertEq(coll + debt + start, 0, "the whole vault, the auction closed");
        assertEq(tac.balanceOf(SINK), COLL);
        assertEq(dollar.balanceOf(address(vault)), 0);
        assertEq(vault.totalDebt(), 5_000e18);
        assertEq(dollar.totalSupply(), vault.totalDebt());
    }

    function test_absorbTakesTheTacShareRoundedDown() public {
        _open(bob, 1_000_000e18, 5_000e18);
        vm.prank(bob);
        dollar.transfer(address(vault), 110e18);
        _open(alice, COLL + 1, 210e18);
        oracle.set(5e12);
        vault.liquidate(alice);
        oracle.set(3e12);
        skip(D);
        feed.set(4000e8);
        vault.absorb(alice);
        assertEq(tac.balanceOf(SINK), (COLL + 1) * 110e18 / 210e18, "floor, never a wei more");
    }

    function test_absorbPaysTheSinkAndNeverTheCaller() public {
        _auction(500e18);
        oracle.set(3e12);
        uint256 before = tac.balanceOf(address(this));
        vault.absorb(alice);
        assertEq(tac.balanceOf(address(this)), before);
        assertEq(tac.balanceOf(SINK), COLL);
    }

    function test_absorbWaitsTheWholeDuration() public {
        _open(bob, 1_000_000e18, 5_000e18);
        vm.prank(bob);
        dollar.transfer(address(vault), 500e18);
        _open(alice, COLL, 210e18);
        oracle.set(5e12);
        vault.liquidate(alice);
        oracle.set(3e12);
        skip(D);
        feed.set(4000e8);
        vault.absorb(alice); // exactly at the duration: allowed
        vm.expectRevert(TacVault.NoAuction.selector);
        vault.absorb(alice);
        // one second short
        oracle.set(P);
        feed.set(4000e8);
        _open(alice, COLL, 210e18);
        oracle.set(5e12);
        vault.liquidate(alice);
        oracle.set(3e12);
        skip(D - 1);
        feed.set(4000e8);
        vm.expectRevert(TacVault.TooEarly.selector);
        vault.absorb(alice);
    }

    // ───────────── the price feed ─────────────

    function test_aBadOrStaleFeedIsRefusedAtItsEdges() public {
        vm.prank(alice);
        vault.deposit(COLL);
        feed.set(0);
        vm.prank(alice);
        vm.expectRevert(TacVault.BadFeed.selector);
        vault.borrow(MIN_DEBT, 0);
        feed.set(-1);
        vm.prank(alice);
        vm.expectRevert(TacVault.BadFeed.selector);
        vault.borrow(MIN_DEBT, 0);
        feed.set(4000e8);
        feed.setUpdatedAt(vm.getBlockTimestamp() + 1); // from the future
        vm.prank(alice);
        vm.expectRevert(TacVault.StaleFeed.selector);
        vault.borrow(MIN_DEBT, 0);
        feed.setUpdatedAt(0);
        vm.prank(alice);
        vm.expectRevert(TacVault.StaleFeed.selector);
        vault.borrow(MIN_DEBT, 0);
        feed.set(4000e8);
        feed.setRound(10, 9); // the answer is from an earlier round
        vm.prank(alice);
        vm.expectRevert(TacVault.StaleFeed.selector);
        vault.borrow(MIN_DEBT, 0);
        feed.setRound(10, 10);
        feed.setUpdatedAt(vm.getBlockTimestamp() - 1 hours); // exactly the staleness limit: allowed
        vm.prank(alice);
        vault.borrow(MIN_DEBT, 0);
        feed.setUpdatedAt(vm.getBlockTimestamp() - 1 hours - 1);
        vm.prank(alice);
        vm.expectRevert(TacVault.StaleFeed.selector);
        vault.borrow(MIN_DEBT, 0);
    }

    function test_theFeedScaleIsExact() public {
        // 1 TAC at P ETH per TAC and 4,000 USD per ETH
        assertEq(vault.valueOf(1e18, false), P * 4000);
    }
}

/// The views (borrow, liquidation, recovery, offer, redemption) taken apart with an oracle whose low, high and
/// recovery values differ, and the pair's constructor and its zero case.
contract TacMutationViewsTest is Test {
    uint256 constant P = 1e14;
    uint256 constant CRASH = 5e13; // 0.20 USD
    uint256 constant COLL = 15_000e18;
    uint256 constant MAX_DEBT = 2_000e18;
    uint256 constant D = 2 hours;
    address constant OWNER = address(0x0123);

    TestTac tac;
    SplitOracle oracle;
    MockFeed feed;
    TacVault vault;
    TacSynth dollar;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        oracle = new SplitOracle();
        oracle.setAll(P, P);
        feed = new MockFeed();
        feed.set(4000e8);
        vault = new TacVault(VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER));
        dollar = vault.SYNTH();
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            tac.mint(users[i], 10_000_000e18);
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

    function _v(address u) internal view returns (uint256 c, uint256 d, uint256 s) {
        (c, d, s) = vault.vaults(u);
    }

    /// The borrow view takes the LOW medians: a high median does not help a borrower.
    function test_theBorrowViewIsBuiltOnTheLowMedians() public {
        oracle.setAll(P, 10 * P);
        vm.startPrank(alice);
        vault.deposit(COLL);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.borrow(MAX_DEBT + 1e18, 0); // at the high median this would pass
        vault.borrow(MAX_DEBT, 0);
        vm.stopPrank();
        assertEq(vault.valueOf(COLL, true), COLL * P * 4000 / 1e18);
    }

    /// The liquidation view takes the HIGH medians: a low median does not liquidate anyone.
    function test_theLiquidationViewIsBuiltOnTheHighMedians() public {
        _open(alice, COLL, MAX_DEBT);
        oracle.setAll(P / 10, P); // lows crashed, highs intact
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
        assertEq(vault.valueOf(COLL, false), COLL * P * 4000 / 1e18);
        assertEq(vault.valueOf(COLL, true), COLL * (P / 10) * 4000 / 1e18, "the borrow view saw the lows");
    }

    /// Each term of the borrow view counts: the WINDOW median alone can be the lowest of the three.
    function test_theBorrowViewTakesTheWindowMedianWhenItIsTheLowest() public {
        oracle.setFor(1 hours, P / 2, 10 * P, P / 2, 1e30); // WINDOW: low half, high ten times
        // SHORT and spot stay at P
        vm.startPrank(alice);
        vault.deposit(COLL);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.borrow(MAX_DEBT / 2 + 1e18, 0); // at P this would pass
        vault.borrow(MAX_DEBT / 2, 0);
        vm.stopPrank();
    }

    /// Each term of the liquidation view counts: the LIQ_WINDOW high median alone can be the highest of the two.
    function test_theLiquidationViewTakesTheLongHighMedianWhenItIsTheHighest() public {
        _open(alice, COLL, MAX_DEBT);
        uint256 crash = P / 5;
        oracle.setAll(crash, crash);
        oracle.setFor(4 hours, crash, P, crash, 1e30); // the long window: low crashed, high intact
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice); // max(high(4h) = P, high(short) = crash) = P: healthy
        oracle.setFor(4 hours, crash, crash, crash, 1e30);
        vault.liquidate(alice);
    }

    /// The liquidation view reads LIQ_WINDOW (4h), not WINDOW (1h).
    function test_theLiquidationViewReadsTheLiquidationWindow() public {
        _open(alice, COLL, MAX_DEBT);
        uint256 crash = P / 5;
        oracle.setFor(4 hours, P, P, P, 1e30); // the long window still high
        oracle.setFor(1 hours, crash, crash, crash, 1e30);
        oracle.setFor(10 minutes, crash, crash, crash, 1e30);
        vm.expectRevert(TacVault.Healthy.selector);
        vault.liquidate(alice);
        oracle.setFor(4 hours, crash, crash, crash, 1e30);
        vault.liquidate(alice);
    }

    /// An auction ends on the RECOVERY view, which is not the liquidation view.
    function test_cancelUsesTheRecoveryViewNotTheLiquidationView() public {
        _open(alice, COLL, MAX_DEBT);
        uint256 crash = P / 5;
        oracle.setAll(crash, crash);
        vault.liquidate(alice);
        // the highs stay down (the liquidation view says unhealthy) but the recovery values have come back
        oracle.setFor(4 hours, crash, crash, P, 1e30);
        oracle.setFor(10 minutes, crash, crash, P, 1e30);
        assertFalse(vault.liqHealthyView(alice));
        assertTrue(vault.recovered(alice));
        vault.cancel(alice);
        (,, uint256 start) = _v(alice);
        assertEq(start, 0);
    }

    /// The recovery view is the higher of the two recovery prices.
    function test_theRecoveryViewTakesTheHigherOfLongAndShort() public {
        _open(alice, COLL, MAX_DEBT);
        uint256 crash = P / 5;
        oracle.setAll(crash, crash);
        vault.liquidate(alice);
        oracle.setFor(4 hours, crash, crash, crash, 1e30);
        oracle.setFor(10 minutes, crash, crash, P, 1e30); // only the short recovery is back
        assertTrue(vault.recovered(alice), "the higher of the two decides");
        oracle.setFor(10 minutes, crash, crash, crash, 1e30);
        oracle.setFor(4 hours, crash, crash, P, 1e30); // only the long one
        assertTrue(vault.recovered(alice));
        oracle.setFor(4 hours, crash, crash, crash, 1e30);
        assertFalse(vault.recovered(alice));
    }

    /// The redemption price is the offer view: the higher of the liquidation view and the newest recorded interval. The
    /// current price never enters it.
    function test_redemptionPricesAtTheOfferView() public {
        address carol = address(0xCA801);
        tac.mint(carol, 1_000_000e18);
        vm.startPrank(carol);
        tac.approve(address(vault), type(uint256).max);
        dollar.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        _open(alice, COLL, MAX_DEBT);
        _open(carol, COLL, MAX_DEBT);
        vm.prank(alice);
        dollar.transfer(bob, 1_000e18);
        vm.prank(carol);
        dollar.transfer(bob, 1_000e18);
        uint256 line = 17_500;
        uint256 fee = 50 + 50 * 3 * (30_000 - line) / line; // 300% against a 175% line: 157 bps
        oracle.setLive(2 * P, P); // the newest interval twice the liquidation view; the current price at P
        vm.prank(bob);
        uint256 got = vault.redeem(alice, 1_000e18, 0);
        assertEq(got, 1_000e18 * (10_000 - fee) / 10_000 * 1e18 / (2 * P * 4000));
        // a newest interval below the liquidation view does not lower the price, and a high current price does not raise it
        oracle.setLive(P / 2, 3 * P);
        vm.prank(bob);
        got = vault.redeem(carol, 1_000e18, 0);
        assertEq(got, 1_000e18 * (10_000 - fee) / 10_000 * 1e18 / (P * 4000));
    }

    /// The offer view floors at the newest recorded interval's price: a rally the medians have not caught up with
    /// cannot sell TAC at the stale median. The current price (`spot()`) never enters it.
    function test_theOfferFloorsAtTheNewestIntervalsPrice() public {
        _open(alice, COLL, MAX_DEBT);
        uint256 crash = P / 2;
        oracle.setAll(crash, crash);
        vault.liquidate(alice);
        assertEq(vault.onOffer(alice), 10_000e18, "2,000 dollars at the liquidation view (0.20 USD)");
        oracle.setLive(P, crash); // the newest interval is at P (0.40 USD), the medians and the current price at crash
        assertEq(vault.offerPrice(), P * 4000);
        assertEq(vault.onOffer(alice), 5_000e18, "2,000 dollars at 0.40");
        assertEq(vault.liquidationPrice(), crash * 4000, "the liquidation view itself does not follow latest()");
        oracle.setLive(crash / 2, 10 * P); // a lower newest interval never lowers the offer below the liquidation view
        assertEq(vault.offerPrice(), crash * 4000, "and a high current price does not raise it");
        // a high median over the longest window does not lift the offer (it is the liquidation window)
        oracle.setFor(4 hours, crash, crash, crash, 1e30);
        assertEq(vault.offerPrice(), crash * 4000);
    }

    /// The debt cap reads depthMin over the longest window: not the median, not another window.
    function test_theDepthCapReadsTheSmallestDepthOverTheLongestWindow() public {
        // the median depth over WINDOW and the smallest depth over WINDOW are tiny: neither is read
        oracle.setFor(1 hours, P, P, P, 1e18);
        oracle.setFor(10 minutes, P, P, P, 1e18);
        // the smallest depth over the longest window: 10 ETH, 40,000 dollars, lent at 10%; its median is huge (ignored)
        oracle.setFor(4 hours, P, P, P, 1e30);
        oracle.setDepthMin(4 hours, 10e18);
        vm.startPrank(alice);
        vault.deposit(10_000_000e18);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(4_000e18 + 1, 0);
        vault.borrow(4_000e18, 0);
        vm.stopPrank();
        assertEq(vault.depthCeiling(), 4_000e18);
        // and a huge smallest depth over the longest window lifts the cap whatever the shorter windows say
        oracle.setDepthMin(4 hours, 1e30);
        vm.prank(alice);
        vault.borrow(6_000e18, 0); // total 10,000: the owner's ceiling, far above the depth cap the shorter windows would give
        assertGt(vault.depthCeiling(), 1e30);
    }

    /// A non-owner waits OWNER_WINDOW from the auction's start (the owner does not), needs an offer price, and needs
    /// the vault unrecovered.
    function test_aBidderNeedsTheOwnerWindowAPriceAndAnUnrecoveredVault() public {
        _open(alice, COLL, MAX_DEBT);
        _open(bob, 1_000_000e18, MAX_DEBT);
        oracle.setAll(P / 5, P / 5);
        vault.liquidate(alice);
        uint256 ow = vault.OWNER_WINDOW();
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, type(uint256).max, 0);
        skip(ow - 1);
        feed.set(4000e8);
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, type(uint256).max, 0);
        skip(1); // exactly auctionStart + OWNER_WINDOW: the window is over
        feed.set(4000e8);
        feed.setUpdatedAt(1); // the feed goes stale: no price
        vm.prank(bob);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.bid(alice, type(uint256).max, 0);
        feed.set(4000e8);
        vm.prank(bob);
        vault.bid(alice, type(uint256).max, 0);
    }

    /// The owner bids inside the window and without any price, taking the whole collateral for its debt.
    function test_theOwnerBidsInsideTheWindowAndWithoutAPrice() public {
        _open(alice, COLL, MAX_DEBT);
        oracle.setAll(P / 5, P / 5);
        vault.liquidate(alice);
        feed.setUpdatedAt(1);
        vm.prank(alice);
        uint256 taken = vault.bid(alice, type(uint256).max, 0);
        assertEq(taken, COLL);
    }

    /// An offer price that cannot be read (`latest()` reverts) while the recovery view still works: only
    /// the owner may bid, and the offer is the whole collateral. A non-owner is refused even though `recovered()` answers.
    function test_withoutAnOfferPriceOnlyTheOwnerBidsEvenIfTheRecoveryViewWorks() public {
        _open(alice, COLL, MAX_DEBT);
        _open(bob, 1_000_000e18, MAX_DEBT);
        oracle.setAll(P / 5, P / 5);
        vault.liquidate(alice);
        skip(vault.OWNER_WINDOW());
        feed.set(4000e8);
        oracle.breakLatest(true); // offerPrice() reverts; recovered() does not read latest()
        assertFalse(vault.recovered(alice));
        assertEq(vault.onOffer(alice), COLL, "without a price the offer is the whole collateral");
        vm.prank(bob);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.bid(alice, type(uint256).max, 0);
        vm.prank(alice);
        assertEq(vault.bid(alice, type(uint256).max, 0), COLL);
    }

    /// A bid that brings the vault back over the line ends the auction in the same call (a partial bid, and a full one).
    function test_aBidThatRecoversTheVaultEndsTheAuction() public {
        _open(alice, COLL, MAX_DEBT);
        _open(bob, 1_000_000e18, MAX_DEBT);
        oracle.setAll(CRASH, CRASH);
        vault.liquidate(alice);
        skip(vault.OWNER_WINDOW());
        feed.set(4000e8);
        // half the debt: the offer is 2,000 x 1.0167 / 0.20 = 10,167 TAC for all, 5,083 TAC for half; what is left, 9,917 TAC
        // (1,983 USD) against 1,000, is 198% >= 175%
        vm.prank(bob);
        vault.bid(alice, MAX_DEBT / 2, 0);
        (uint256 coll, uint256 debt, uint256 start) = _v(alice);
        assertEq(debt, MAX_DEBT / 2);
        assertGt(coll, 0);
        assertEq(start, 0, "the vault is back over the line: the auction ended with the bid");
    }

    function test_aBidThatDoesNotRecoverTheVaultLeavesTheAuctionRunning() public {
        _open(alice, COLL, MAX_DEBT);
        _open(bob, 1_000_000e18, MAX_DEBT);
        oracle.setAll(CRASH, CRASH);
        vault.liquidate(alice);
        skip(vault.OWNER_WINDOW());
        feed.set(4000e8);
        // a bid for 10% of the debt: the rest is still under 175%
        vm.prank(bob);
        vault.bid(alice, MAX_DEBT / 10, 0);
        (, uint256 debt, uint256 start) = _v(alice);
        assertEq(debt, MAX_DEBT - MAX_DEBT / 10);
        assertGt(start, 0, "still under the line: the auction runs on");
    }

    // ───────────── the pair ─────────────

    function _pairWith(SplitOracle a, SplitOracle b) internal returns (TacPairOracle) {
        return new TacPairOracle(address(a), address(b));
    }

    /// One venue's newest interval being high does not raise the pair's `latest()`, so it does not move a vault's offer
    /// or redemption price; it takes both venues. (A vault over the real pair of two venues.)
    function test_theOfferNeedsBothVenuesNewestIntervals() public {
        SplitOracle a = new SplitOracle();
        SplitOracle b = new SplitOracle();
        a.setAll(P, P);
        b.setAll(P, P);
        TacPairOracle pair = _pairWith(a, b);
        TacVault v = new TacVault(VaultConfig.defaults(address(tac), address(pair), address(feed), OWNER));
        TacSynth d = v.SYNTH();
        tac.mint(alice, 100_000e18);
        vm.startPrank(alice);
        tac.approve(address(v), type(uint256).max);
        d.approve(address(v), type(uint256).max);
        v.deposit(COLL);
        v.borrow(MAX_DEBT, 0);
        vm.stopPrank();
        uint256 crash = P / 2;
        a.setAll(crash, crash);
        b.setAll(crash, crash);
        v.liquidate(alice);
        assertEq(v.offerPrice(), crash * 4000, "the liquidation view");
        a.setLive(P, crash); // only one venue's newest interval is at P (0.40 USD)
        assertEq(pair.latest(), crash, "the lower of the two");
        assertEq(v.offerPrice(), crash * 4000, "one venue cannot lift the offer");
        assertEq(v.onOffer(alice), 10_000e18);
        b.setLive(P, crash); // both
        assertEq(pair.latest(), P);
        assertEq(v.offerPrice(), P * 4000);
        assertEq(v.onOffer(alice), 5_000e18);
        // either venue lower again: back to the lower
        a.setLive(P / 4, crash);
        assertEq(pair.latest(), P / 4);
        assertEq(v.offerPrice(), crash * 4000);
    }

    function test_pairRefusesVenuesWithDifferentWindows() public {
        SplitOracle a = new SplitOracle();
        SplitOracle b = new SplitOracle();
        a.setAll(P, P);
        b.setAll(P, P);
        _pairWith(a, b);
        b.setWindows(a.SHORT_WINDOW() + 1, a.WINDOW(), a.MAX_WINDOW());
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        _pairWith(a, b);
        b.setWindows(a.SHORT_WINDOW(), a.WINDOW() + 1, a.MAX_WINDOW());
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        _pairWith(a, b);
        b.setWindows(a.SHORT_WINDOW(), a.WINDOW(), a.MAX_WINDOW() + 1);
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        _pairWith(a, b);
    }

    /// The offer view's base is the liquidation view (the high medians): not the recovery view and not the borrow view.
    function test_theOfferViewIsTheLiquidationViewRaisedToTheNewestInterval() public {
        // the long and short windows: low P/4 (borrow view), high P (liquidation view), recovery P/8
        oracle.setFor(4 hours, P / 4, P, P / 8, 1e30);
        oracle.setFor(10 minutes, P / 4, P, P / 8, 1e30);
        oracle.setLive(P / 2, P / 2); // the newest interval and the current price at P/2
        assertEq(vault.liquidationPrice(), P * 4000);
        assertEq(vault.offerPrice(), P * 4000, "the liquidation view, which the newest interval is below");
        oracle.setLive(2 * P, P / 2);
        assertEq(vault.offerPrice(), 2 * P * 4000, "the newest interval, once above it");
    }

    /// The debt cap is DEPTH_BPS of the depth: the view and the borrow limit both apply it.
    function test_theDepthCapAppliesDepthBps() public {
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
        c.depthBps = 500; // 5%
        TacVault v = new TacVault(c);
        oracle.setFor(4 hours, P, P, P, 1e18); // 1 ETH of depth: 4,000 dollars
        assertEq(v.depthCeiling(), 200e18, "5% of 4,000");
        TacSynth d = v.SYNTH();
        tac.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        tac.approve(address(v), type(uint256).max);
        d.approve(address(v), type(uint256).max);
        v.deposit(1_000_000e18);
        vm.expectRevert(TacVault.OverCeiling.selector);
        v.borrow(200e18 + 1, 0);
        v.borrow(200e18, 0);
        vm.stopPrank();
    }

    function test_pairRefusesTwoVenuesOverTheSamePool() public {
        SplitOracle a = new SplitOracle();
        SplitOracle b = new SplitOracle();
        a.setAll(P, P);
        b.setAll(P, P);
        _pairWith(a, b); // two venues, two pools
        b.setPool(a.POOL());
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        _pairWith(a, b);
        a.setPool(address(0xFEED));
        b.setPool(address(0xFEED));
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        _pairWith(a, b);
    }

    function test_pairRefusesVenuesWithDifferentIntervals() public {
        SplitOracle a = new SplitOracle();
        SplitOracle b = new SplitOracle();
        a.setAll(P, P);
        b.setAll(P, P);
        TacPairOracle pair = _pairWith(a, b);
        assertEq(pair.STEP(), 50);
        b.setStep(25);
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        _pairWith(a, b);
        b.setStep(51);
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        _pairWith(a, b);
    }

    function test_pairDepthMinIsTheSmallerVenuesAndNeverHidesAZero() public {
        SplitOracle a = new SplitOracle();
        SplitOracle b = new SplitOracle();
        a.setAll(P, P);
        b.setAll(P, P);
        TacPairOracle pair = _pairWith(a, b);
        a.setFor(1 hours, P, P, P, 9e18);
        b.setFor(1 hours, P, P, P, 9e18);
        a.setDepthMin(1 hours, 2e18);
        b.setDepthMin(1 hours, 5e18);
        assertEq(pair.depthMin(1 hours), 2e18);
        a.setDepthMin(1 hours, 7e18);
        assertEq(pair.depthMin(1 hours), 5e18);
        b.setDepthMin(1 hours, 0);
        assertEq(pair.depthMin(1 hours), 0);
    }

    /// A venue that says zero is not replaced by the other's value.
    function test_pairNeverHidesAZero() public {
        SplitOracle a = new SplitOracle();
        SplitOracle b = new SplitOracle();
        a.setAll(P, P);
        b.setAll(P, P);
        TacPairOracle pair = _pairWith(a, b);
        a.setFor(1 hours, P, P, P, 2e18);
        b.setFor(1 hours, 0, 0, 0, 0);
        (uint256 low, uint256 high) = pair.prices(1 hours);
        assertEq(low, 0);
        assertEq(high, P);
    }
}
