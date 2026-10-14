// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TestTac, MockOracle, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

/// Random sequences of every vault action across three users and a moving price. Calls that revert are skipped;
/// the invariants must hold after every step. Counters show which paths a run reached.
contract VaultHandler is Test {
    TacVault public vault;
    TacSynth public dollar;
    TestTac public tac;
    MockOracle public oracle;
    MockFeed public feed;
    address[3] public users = [address(0x1001), address(0x1002), address(0x1003)];
    uint256 public borrows;
    uint256 public auctions;
    uint256 public bids;
    uint256 public redeems;
    uint256 public partialBids;
    uint256 public absorbs;

    constructor(TacVault v, TestTac t, MockOracle o, MockFeed f) {
        vault = v;
        dollar = v.SYNTH();
        tac = t;
        oracle = o;
        feed = f;
        for (uint256 i; i < 3; ++i) {
            t.mint(users[i], 10_000_000e18);
            vm.startPrank(users[i]);
            t.approve(address(v), type(uint256).max);
            dollar.approve(address(v), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _u(uint256 s) internal view returns (address) {
        return users[s % 3];
    }

    function _richest() internal view returns (address best) {
        best = users[0];
        for (uint256 i = 1; i < 3; ++i) {
            if (dollar.balanceOf(users[i]) > dollar.balanceOf(best)) best = users[i];
        }
    }

    function deposit(uint256 who, uint256 amt) external {
        vm.prank(_u(who));
        try vault.deposit(bound(amt, 1, 1_000_000e18)) {} catch {}
    }

    function depositFor(uint256 who, uint256 forWho, uint256 amt) external {
        vm.prank(_u(who));
        try vault.depositFor(_u(forWho), bound(amt, 1, 100_000e18)) {} catch {}
    }

    function borrow(uint256 who, uint256 frac) external {
        address u = _u(who);
        (uint256 coll, uint256 debt, uint256 start) = vault.vaults(u);
        if (start != 0) return;
        uint256 room;
        try vault.valueOf(coll, true) returns (uint256 value) {
            uint256 cap = value * 10_000 / vault.MINT_RATIO_BPS();
            room = cap > debt ? cap - debt : 0;
        } catch {
            return;
        }
        uint256 amt = room * bound(frac, 5_000, 9_500) / 10_000;
        if (amt < 100e18) amt = 100e18;
        vm.prank(u);
        try vault.borrow(amt, 500) {
            ++borrows;
        } catch {}
    }

    function repay(uint256 who, uint256 forWho, uint256 amt) external {
        vm.prank(_u(who));
        try vault.repay(_u(forWho), bound(amt, 1, 50_000e18)) {} catch {}
    }

    function withdraw(uint256 who, uint256 amt) external {
        vm.prank(_u(who));
        try vault.withdraw(bound(amt, 1, 1_000_000e18)) {} catch {}
    }

    function movePrice(uint256 p) external {
        oracle.set(bound(p, 2e13, 1.5e14));
    }

    function liquidate(uint256 who) external {
        try vault.liquidate(_u(who)) {
            ++auctions;
        } catch {}
    }

    function cancel(uint256 who) external {
        try vault.cancel(_u(who)) {} catch {}
    }

    function bid(uint256 wait_, uint256 who) external {
        skip(bound(wait_, 0, 4 hours));
        feed.set(4000e8);
        vm.prank(_richest());
        try vault.bid(_u(who), type(uint256).max, 0) {
            ++bids;
        } catch {}
    }

    function redeem(uint256 who, uint256 forWho, uint256 amt) external {
        vm.prank(_u(who));
        try vault.redeem(_u(forWho), bound(amt, 1, 20_000e18), 0) {
            ++redeems;
        } catch {}
    }

    function partialBid(uint256 who, uint256 frac) external {
        address u = _u(who);
        (, uint256 debt,) = vault.vaults(u);
        vm.prank(_richest());
        try vault.bid(u, debt * bound(frac, 1, 9_999) / 10_000, 0) {
            ++partialBids;
        } catch {}
    }

    function crashAndBid(uint256 who, uint256 drop, uint256 wait_) external {
        address u = _u(who);
        (, uint256 debt,) = vault.vaults(u);
        if (debt == 0) return;
        oracle.set(bound(drop, 5e12, 5e13));
        try vault.liquidate(u) {
            ++auctions;
        } catch {}
        skip(bound(wait_, 0, 5 hours));
        feed.set(4000e8);
        vm.prank(_richest());
        try vault.bid(u, type(uint256).max, 0) {
            ++bids;
        } catch {}
        try vault.absorb(u) {
            ++absorbs;
        } catch {}
        oracle.set(1e14);
    }

    function donate(uint256 who, uint256 amt) external {
        address u = _u(who);
        amt = bound(amt, 0, dollar.balanceOf(u));
        if (amt == 0) return;
        vm.prank(u);
        dollar.transfer(address(vault), amt);
    }

    function crashAndAbsorb(uint256 who, uint256 drop) external {
        address u = _u(who);
        (, uint256 debt,) = vault.vaults(u);
        if (debt == 0) return;
        oracle.set(bound(drop, 1e6, 1e9));
        try vault.liquidate(u) {
            ++auctions;
        } catch {}
        skip(4 hours + 1);
        feed.set(4000e8);
        (, debt,) = vault.vaults(u);
        uint256 held = dollar.balanceOf(address(vault));
        address rich = _richest();
        if (held < debt && rich != u) {
            uint256 give = debt - held;
            if (give > dollar.balanceOf(rich)) give = dollar.balanceOf(rich);
            vm.prank(rich);
            dollar.transfer(address(vault), give);
        }
        try vault.absorb(u) {
            ++absorbs;
        } catch {}
        oracle.set(1e14);
    }

    function wait(uint256 s) external {
        skip(bound(s, 1, 3 hours));
        feed.set(4000e8);
    }
}

contract TacVaultInvariantTest is Test {
    VaultHandler handler;
    TacVault vault;
    TestTac tac;

    function setUp() public {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        MockOracle oracle = new MockOracle();
        oracle.set(1e14);
        MockFeed feed = new MockFeed();
        feed.set(4000e8);
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(oracle), address(feed), address(0x0123));
        c.debtCeiling = 10_000_000e18;
        c.feedMaxStaleness = 1 days;
        vault = new TacVault(c);
        vm.startPrank(address(0x0123));
        vault.setBorrowFee(50);
        vm.stopPrank();
        handler = new VaultHandler(vault, tac, oracle, feed);
        bytes4[] memory sels = new bytes4[](15);
        sels[0] = VaultHandler.deposit.selector;
        sels[1] = VaultHandler.depositFor.selector;
        sels[2] = VaultHandler.borrow.selector;
        sels[3] = VaultHandler.repay.selector;
        sels[4] = VaultHandler.withdraw.selector;
        sels[5] = VaultHandler.movePrice.selector;
        sels[6] = VaultHandler.liquidate.selector;
        sels[7] = VaultHandler.cancel.selector;
        sels[8] = VaultHandler.bid.selector;
        sels[9] = VaultHandler.redeem.selector;
        sels[10] = VaultHandler.partialBid.selector;
        sels[11] = VaultHandler.crashAndBid.selector;
        sels[12] = VaultHandler.wait.selector;
        sels[13] = VaultHandler.donate.selector;
        sels[14] = VaultHandler.crashAndAbsorb.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    function _sums() internal view returns (uint256 coll, uint256 debt) {
        for (uint256 i; i < 3; ++i) {
            (uint256 c, uint256 d,) = vault.vaults(handler.users(i));
            coll += c;
            debt += d;
        }
    }

    function invariant_dollarSupplyEqualsTotalDebt() public view {
        assertEq(vault.SYNTH().totalSupply(), vault.totalDebt());
    }

    function invariant_totalDebtIsTheSumOfVaults() public view {
        (, uint256 debt) = _sums();
        assertEq(vault.totalDebt(), debt);
    }

    function invariant_heldTacIsTheSumOfCollateral() public view {
        (uint256 coll,) = _sums();
        assertEq(tac.balanceOf(address(vault)), coll);
    }

    function invariant_debtIsZeroOrAtLeastTheMinimum() public view {
        for (uint256 i; i < 3; ++i) {
            (, uint256 d,) = vault.vaults(handler.users(i));
            assertTrue(d == 0 || d >= vault.MIN_DEBT());
        }
    }

    function invariant_auctionsHaveDebtAndOfferAtMostTheCollateral() public view {
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            (uint256 c, uint256 d, uint256 start) = vault.vaults(u);
            if (start != 0) assertTrue(d != 0);
            assertLe(vault.onOffer(u), c);
        }
    }

    function invariant_callSummary() public view {
        console2.log("borrows / auctions / bids:", handler.borrows(), handler.auctions(), handler.bids());
        console2.log("redeems / partial bids / absorbs:", handler.redeems(), handler.partialBids(), handler.absorbs());
    }
}

contract TacVaultCycleFuzz is Test {
    /// Open, crash, auction, bid at a random time by the owner or, once the owner window has passed, an outsider:
    /// the basket is only ever split, supply equals debt, and an owner who bids keeps every TAC.
    function testFuzz_liquidationCycleConserves(uint256 coll, uint256 frac, uint256 drop, uint256 wait_, bool ownerBids)
        public
    {
        vm.warp(1_800_000_000);
        TestTac tac = new TestTac();
        MockOracle oracle = new MockOracle();
        oracle.set(1e14);
        MockFeed feed = new MockFeed();
        feed.set(4000e8);
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(oracle), address(feed), address(0x0123));
        c.debtCeiling = type(uint128).max;
        c.feedMaxStaleness = 1 days;
        TacVault vault = new TacVault(c);
        TacSynth dollar = vault.SYNTH();
        address owner = address(0xA0);
        address other = address(0xB0);
        coll = bound(coll, 1_000e18, 10_000_000e18);
        tac.mint(owner, coll);
        tac.mint(other, 100_000_000e18);
        vm.startPrank(owner);
        tac.approve(address(vault), type(uint256).max);
        dollar.approve(address(vault), type(uint256).max);
        vault.deposit(coll);
        uint256 debt = vault.valueOf(coll, true) * 10_000 / 30_000 * bound(frac, 5_000, 10_000) / 10_000;
        if (debt < 100e18) debt = 100e18;
        vault.borrow(debt, 0);
        vm.stopPrank();
        vm.startPrank(other);
        tac.approve(address(vault), type(uint256).max);
        dollar.approve(address(vault), type(uint256).max);
        vault.deposit(100_000_000e18);
        vault.borrow(debt, 0);
        vm.stopPrank();

        // A price low enough to put this vault under 175%: value(p) = value0 · p / p0 < 1.75 · debt.
        uint256 pMax = 1e14 * 17_500 / 10_000 * debt / vault.valueOf(coll, false) - 1;
        uint256 p = bound(drop, 1e12, pMax);
        oracle.set(p);
        vault.liquidate(owner);
        uint256 wait = bound(wait_, 0, 5 hours);
        if (!ownerBids && wait < vault.OWNER_WINDOW()) wait = vault.OWNER_WINDOW();
        skip(wait);
        address bidder = ownerBids ? owner : other;
        vm.prank(bidder);
        uint256 taken = vault.bid(owner, type(uint256).max, 0);
        (uint256 left, uint256 d,) = vault.vaults(owner);
        assertEq(d, 0);
        assertEq(taken + left, coll, "the basket is split, never created or lost");
        assertEq(dollar.totalSupply(), vault.totalDebt());
        if (ownerBids) {
            vm.prank(owner);
            if (left != 0) vault.withdraw(left);
            assertEq(tac.balanceOf(owner), coll, "an owner who bids keeps every TAC");
        }
    }
}

contract TacVaultHandlerPaths is Test {
    /// The handler's absorb path, run on purpose: the same invariants hold after a reserve-funded absorb.
    function test_handlerReachesAbsorbAndBalances() public {
        vm.warp(1_800_000_000);
        TestTac tac = new TestTac();
        MockOracle oracle = new MockOracle();
        oracle.set(1e14);
        MockFeed feed = new MockFeed();
        feed.set(4000e8);
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(oracle), address(feed), address(0x0123));
        c.debtCeiling = 10_000_000e18;
        c.feedMaxStaleness = 1 days;
        TacVault vault = new TacVault(c);
        VaultHandler h = new VaultHandler(vault, tac, oracle, feed);
        h.deposit(0, 100_000e18);
        h.borrow(0, 9_000);
        h.deposit(1, 1_000_000e18);
        h.borrow(1, 9_000);
        h.crashAndAbsorb(0, 0);
        assertEq(h.absorbs(), 1);
        uint256 coll;
        uint256 debt;
        for (uint256 i; i < 3; ++i) {
            (uint256 cc, uint256 d,) = vault.vaults(h.users(i));
            coll += cc;
            debt += d;
        }
        assertEq(vault.SYNTH().totalSupply(), vault.totalDebt());
        assertEq(vault.totalDebt(), debt);
        assertEq(tac.balanceOf(address(vault)), coll);
    }
}
