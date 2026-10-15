// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {MockPrecision} from "./MockPrecision.sol";
import {VaultConfig} from "./TacVaultMocks.sol";
import {R2Base, R2AcceptAll} from "./TacVaultLaunchReview.t.sol";

// The auction clock against a model of the time spent paused, and the synth's minter count against renouncing.

// ───────────────────────────── the auction clock, cases ─────────────────────────────

contract TacVaultClockCases is R2Base {
    function _t() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _expOffer(address u, uint256 clock, uint256 start) internal view returns (uint256) {
        (uint256 c, uint256 d,) = vault.vaults(u);
        uint256 dur = vault.AUCTION_DURATION();
        uint256 el = clock - start;
        if (el > dur) el = dur;
        uint256 bonus = vault.LIQ_BONUS_BPS() * el / dur;
        uint256 want = FixedPointMathLib.fullMulDiv(d * (10_000 + bonus) / 10_000, 1e18, vault.offerPrice());
        return want < c ? want : c;
    }

    /// A pause while no auction runs, an auction opened in the very second the pause ends (not a second sooner),
    /// then a second pause after the cooldown: the clock and the bonus are what the time without a pause says.
    function test_pauseWithNoAuctionThenAnAuctionAtTheEndThenASecondPause() public {
        _open(alice, 15_000e18, 2_000e18);
        _open(bob, 1_000_000e18, 5_000e18);
        uint256 t0 = _t();
        vm.prank(OWNER);
        vault.pauseAuctions(12 hours);
        assertEq(vault.auctionTime(), t0, "stopped at the start");
        oracle.set(P * 45 / 100); // alice at 135%
        _wait(12 hours - 1);
        assertTrue(vault.paused());
        vm.expectRevert(TacVault.Paused.selector);
        vault.liquidate(alice);
        _wait(1);
        assertFalse(vault.paused());
        assertEq(vault.auctionTime(), t0, "the pause took exactly its twelve hours");
        vault.liquidate(alice);
        (,, uint256 start) = vault.vaults(alice);
        assertEq(start, t0);
        assertEq(vault.onOffer(alice), _expOffer(alice, vault.auctionTime(), start), "no bonus at the start");

        // An hour in: 5% of the 10% bonus.
        _wait(1 hours);
        assertEq(vault.auctionTime(), t0 + 1 hours);
        assertEq(vault.onOffer(alice), _expOffer(alice, t0 + 1 hours, start));

        // The cooldown after a 12-hour pause is 12 hours from its end.
        _wait(10 hours + 59 minutes + 59);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.PauseCooldown.selector);
        vault.pauseAuctions(1);
        _wait(1);
        uint256 before = vault.auctionTime();
        uint256 offerBefore = vault.onOffer(alice);
        vm.prank(OWNER);
        vault.pauseAuctions(6 hours);
        assertEq(vault.auctionTime(), before, "continuous at the start of the second pause");
        assertEq(vault.onOffer(alice), offerBefore);
        _wait(6 hours);
        assertEq(vault.auctionTime(), before);
        assertEq(vault.onOffer(alice), offerBefore, "no bonus over the second pause");
        assertEq(before, t0 + 12 hours, "twelve paused hours are not counted");
        _wait(1);
        assertEq(vault.auctionTime(), before + 1);
    }

    /// Lengthening a running pause and ending it early: both leave the clock continuous and count only the time the
    /// pause was in force.
    function test_lengthenThenResumeEarlyCountsOnlyTheTimeInForce() public {
        uint256 t0 = _t();
        vm.prank(OWNER);
        vault.pauseAuctions(1 hours);
        _wait(30 minutes);
        vm.prank(OWNER);
        vault.pauseAuctions(2 hours); // runs to t0 + 2.5 h
        assertEq(vault.auctionTime(), t0);
        _wait(100 minutes); // t0 + 130 min
        vm.prank(OWNER);
        vault.resumeAuctions(); // ran 130 minutes
        assertEq(vault.auctionTime(), t0);
        _wait(10);
        assertEq(vault.auctionTime(), t0 + 10);
        // The cooldown is as long as it ran: 130 minutes from its end.
        _wait(130 minutes - 11);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.PauseCooldown.selector);
        vault.pauseAuctions(1);
        _wait(1);
        vm.prank(OWNER);
        vault.pauseAuctions(1);
        _wait(1);
        // 130 minutes unpaused since the early end, then a one-second pause: the clock is t0 plus those 130 minutes.
        assertEq(vault.auctionTime(), t0 + 130 minutes, "t0 plus the unpaused time");
    }

    /// A pause resumed in the block it began holds nothing, so it does not hold the next one back.
    function test_aPauseResumedInItsOwnBlockCostsNothing() public {
        uint256 t0 = _t();
        vm.startPrank(OWNER);
        vault.pauseAuctions(12 hours);
        vault.resumeAuctions();
        vault.pauseAuctions(12 hours); // no cooldown after a zero-length pause
        vm.stopPrank();
        assertEq(vault.auctionTime(), t0);
        _wait(12 hours);
        assertEq(vault.auctionTime(), t0);
        _wait(5);
        assertEq(vault.auctionTime(), t0 + 5);
    }

    /// The pauser can start and lengthen a pause but cannot end one, and cannot reach past MAX_PAUSE from its start.
    function test_pauserLengthensButCannotResumeOrOverrun() public {
        address pauser = address(0xBAD);
        vm.prank(OWNER);
        vault.setPauser(pauser);
        uint256 t0 = _t();
        vm.prank(pauser);
        vault.pauseAuctions(1 hours);
        vm.prank(pauser);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.resumeAuctions();
        _wait(30 minutes);
        vm.prank(pauser);
        vm.expectRevert(TacVault.BadConfig.selector); // t0 + 30 min + 12 h is past t0 + 12 h
        vault.pauseAuctions(12 hours);
        vm.prank(pauser);
        vm.expectRevert(TacVault.BadConfig.selector); // not longer than it runs
        vault.pauseAuctions(10 minutes);
        vm.prank(pauser);
        vault.pauseAuctions(11 hours + 30 minutes); // to exactly t0 + 12 h
        assertEq(vault.pausedUntil(), t0 + 12 hours);
        assertEq(vault.auctionTime(), t0);
        vm.prank(pauser);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.resumeAuctions();
    }

    /// Only a pause stops the auction clock. While the oracle has no price, outside bids are refused (NoPrice) but the
    /// owner window and the bonus keep running, so when the oracle answers again the first outside bidder meets the
    /// bonus reached. The borrower can act throughout (repay, deposit, bid on the vault), and a cured vault is refused
    /// to outside bidders (Healthy).
    function test_anOracleOutageRunsTheAuctionClock() public {
        _open(alice, 15_000e18, 2_000e18);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.set(P * 45 / 100);
        vault.liquidate(alice);
        (,, uint256 start) = vault.vaults(alice);
        _wait(20 minutes);
        uint256 atWindowEnd = vault.onOffer(alice); // 1.67% bonus
        oracle.setBroken(true);
        _wait(3 hours);
        vm.prank(bob);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.bid(alice, type(uint256).max, 0);
        oracle.setBroken(false);
        uint256 afterOutage = vault.onOffer(alice);
        assertEq(afterOutage, _expOffer(alice, vault.auctionTime(), start));
        assertGt(afterOutage, atWindowEnd, "the bonus ran on while no one could bid");
        vm.prank(bob);
        assertEq(vault.bid(alice, type(uint256).max, 0), afterOutage);
    }

    /// A pause begun in the last second of the owner's window leaves exactly that second of it afterwards.
    function test_aPauseInTheLastSecondOfTheOwnerWindow() public {
        _open(alice, 15_000e18, 2_000e18);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.set(P * 45 / 100);
        vault.liquidate(alice);
        _wait(20 minutes - 1);
        vm.prank(OWNER);
        vault.pauseAuctions(12 hours);
        _wait(12 hours);
        vm.prank(bob);
        vm.expectRevert(TacVault.OwnerWindow.selector);
        vault.bid(alice, type(uint256).max, 0);
        _wait(1);
        vm.prank(bob);
        assertGt(vault.bid(alice, type(uint256).max, 0), 0);
    }
}

// ───────────────────────────── the auction clock, a random walk ─────────────────────────────

/// Liquidate, bid (outside and the owner), absorb, cancel, pause (start, lengthen, end early), jumps in time that
/// land on the edges of a pause, governed changes and price moves, against an independent model of the time paused.
/// After every step: the clock never decreases and equals the wall time less the modelled paused time; every auction's
/// start is the clock when it opened; `onOffer` is the formula of the clock alone; each action succeeds exactly when
/// the model says it may and otherwise reverts with the reason the model gives.
contract TacVaultClockWalk is R2Base {
    address constant PAUSER = address(0xBAD);
    address dave = address(0xDA7E);
    address[2] users;

    uint256[] mF; // the model's pauses: start,
    uint256[] mU; // and end (as lengthened or ended early)
    mapping(address => uint256) mStart;
    uint256 lastClock;
    uint256 curPrice;

    uint256 public nPause;
    uint256 public nLengthen;
    uint256 public nResume;
    uint256 public nLiq;
    uint256 public nBid;
    uint256 public nBidPaused;
    uint256 public nBidWindow;
    uint256 public nOwnerBid;
    uint256 public nAbsorb;
    uint256 public nAbsorbEarly;
    uint256 public nCancel;
    uint256 public nGov;
    uint256 public nCooldown;

    function setUp() public override {
        super.setUp();
        _fund(dave);
        users = [alice, dave];
        vm.startPrank(OWNER);
        vault.setDebtCeiling(type(uint256).max);
        vault.setPauser(PAUSER);
        vm.stopPrank();
        _open(bob, 1_000_000e18, 5_000e18);
        _open(carol, 90_000_000e18, 60_000e18);
        _open(alice, 15_000e18, 2_000e18);
        _open(dave, 15_000e18, 2_000e18);
        curPrice = P;
        lastClock = vault.auctionTime();
    }

    // ── the model ──

    function _t() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _modelPaused(uint256 t) internal view returns (uint256 s) {
        for (uint256 i; i < mF.length; ++i) {
            uint256 e = t < mU[i] ? t : mU[i];
            if (e > mF[i]) s += e - mF[i];
        }
    }

    function _running(uint256 t) internal view returns (bool) {
        return mF.length != 0 && t < mU[mF.length - 1];
    }

    function _expOffer(address u, uint256 clock) internal view returns (uint256) {
        (uint256 c, uint256 d,) = vault.vaults(u);
        uint256 dur = vault.AUCTION_DURATION();
        uint256 el = clock - mStart[u];
        if (el > dur) el = dur;
        uint256 bonus = vault.LIQ_BONUS_BPS() * el / dur;
        uint256 want = FixedPointMathLib.fullMulDiv(d * (10_000 + bonus) / 10_000, 1e18, vault.offerPrice());
        return want < c ? want : c;
    }

    function _dollars(address who, uint256 amt) internal {
        if (dollar.balanceOf(who) >= amt) return;
        vm.prank(carol);
        dollar.transfer(who, amt - dollar.balanceOf(who));
    }

    function _topUpCarol() internal {
        if (dollar.balanceOf(carol) < 30_000e18) {
            vm.prank(carol);
            vault.borrow(30_000e18, 500);
        }
    }

    // ── the steps ──

    function _pause(uint256 x) internal {
        uint256 t = _t();
        uint256 dur = 1 + x % 13 hours;
        address who = (x >> 40) % 2 == 0 ? OWNER : PAUSER;
        bool running = _running(t);
        uint256 last = mF.length == 0 ? 0 : mF.length - 1;
        bool ok;
        bool cooldownBlock;
        if (dur > 12 hours) {
            ok = false;
        } else if (running) {
            ok = t + dur > mU[last] && t + dur <= mF[last] + 12 hours;
        } else {
            ok = mF.length == 0 || t >= mU[last] + (mU[last] - mF[last]);
            cooldownBlock = !ok;
        }
        vm.prank(who);
        try vault.pauseAuctions(dur) {
            assertTrue(ok, "a pause the model refuses went through");
            if (running) {
                mU[last] = t + dur;
                ++nLengthen;
            } else {
                mF.push(t);
                mU.push(t + dur);
                ++nPause;
            }
        } catch (bytes memory err) {
            assertFalse(ok, "a pause the model allows was refused");
            if (cooldownBlock) {
                assertEq(bytes4(err), TacVault.PauseCooldown.selector);
                ++nCooldown;
            } else {
                assertEq(bytes4(err), TacVault.BadConfig.selector);
            }
        }
    }

    function _resume(uint256 x) internal {
        uint256 t = _t();
        bool running = _running(t);
        if (x % 4 == 0) {
            vm.prank(PAUSER);
            vm.expectRevert(Ownable.Unauthorized.selector);
            vault.resumeAuctions();
        }
        vm.prank(OWNER);
        try vault.resumeAuctions() {
            assertTrue(running, "resumed a pause that was not running");
            mU[mF.length - 1] = t;
            ++nResume;
        } catch (bytes memory err) {
            assertFalse(running, "could not resume a running pause");
            assertEq(bytes4(err), TacVault.BadConfig.selector);
        }
    }

    function _liquidate(address u) internal {
        uint256 t = _t();
        (, uint256 d, uint256 s) = vault.vaults(u);
        bool paused = _running(t);
        bool ok = s == 0 && d > 0 && !vault.liqHealthyView(u) && !paused;
        try vault.liquidate(u) {
            assertTrue(ok, "liquidated when it should not have");
            mStart[u] = t - _modelPaused(t);
            (,, uint256 s2) = vault.vaults(u);
            assertEq(s2, mStart[u], "the auction starts at the clock");
            ++nLiq;
        } catch (bytes memory err) {
            assertFalse(ok, "refused a liquidation the model allows");
            if (paused) assertEq(bytes4(err), TacVault.Paused.selector);
        }
    }

    function _bid(address u, uint256 x) internal {
        uint256 t = _t();
        uint256 clock = t - _modelPaused(t);
        (, uint256 d, uint256 s) = vault.vaults(u);
        if (s == 0) return;
        _topUpCarol();
        bool paused = _running(t);
        bool inWindow = clock >= s + vault.OWNER_WINDOW();
        bool recovered = vault.recovered(u);
        bool ok = !paused && inWindow && !recovered;
        uint256 exp = ok ? _expOffer(u, clock) : 0;
        uint256 before = tac.balanceOf(carol);
        vm.prank(carol);
        try vault.bid(u, x % 2 == 0 ? type(uint256).max : d, 0) returns (uint256 taken) {
            assertTrue(ok, "an outside bid went through that the model refuses");
            assertEq(taken, exp, "taken is not the formula of the clock");
            assertEq(tac.balanceOf(carol) - before, exp);
            ++nBid;
        } catch (bytes memory err) {
            assertFalse(ok, "an outside bid the model allows was refused");
            if (paused) {
                assertEq(bytes4(err), TacVault.Paused.selector);
                ++nBidPaused;
            } else if (!inWindow) {
                assertEq(bytes4(err), TacVault.OwnerWindow.selector);
                ++nBidWindow;
            } else {
                assertEq(bytes4(err), TacVault.Healthy.selector);
            }
        }
    }

    function _ownerBid(address u, uint256 x) internal {
        uint256 t = _t();
        uint256 clock = t - _modelPaused(t);
        (, uint256 d, uint256 s) = vault.vaults(u);
        if (s == 0) return;
        uint256 amt = x % 2 == 0 ? type(uint256).max : d / 2 + 1;
        uint256 a = amt < d ? amt : d;
        bool ok = a > 0 && (d - a == 0 || d - a >= vault.MIN_DEBT());
        uint256 exp = _expOffer(u, clock) * a / d;
        _topUpCarol();
        _dollars(u, a);
        uint256 before = tac.balanceOf(u);
        vm.prank(u);
        try vault.bid(u, amt, 0) returns (uint256 taken) {
            assertTrue(ok);
            assertEq(taken, exp, "the owner's take is not the formula of the clock");
            assertEq(tac.balanceOf(u) - before, exp);
            ++nOwnerBid;
        } catch (bytes memory err) {
            assertFalse(ok, "the owner's bid was refused");
            assertEq(bytes4(err), TacVault.BadAmount.selector);
        }
    }

    function _absorb(address u, uint256 x) internal {
        uint256 t = _t();
        uint256 clock = t - _modelPaused(t);
        (uint256 c, uint256 d, uint256 s) = vault.vaults(u);
        if (x % 2 == 0 && d > 0) {
            _topUpCarol();
            uint256 give = x % 3 == 0 ? d : (x >> 8) % (d + 1);
            if (give != 0) {
                vm.prank(carol);
                dollar.transfer(address(vault), give);
            }
        }
        uint256 reserve = dollar.balanceOf(address(vault));
        bool paused = _running(t);
        bool waited = s != 0 && clock - s >= vault.AUCTION_DURATION();
        bool under = vault.valueOf(c, false) < d;
        uint256 amt;
        if (reserve < d) {
            amt = d <= vault.MIN_DEBT() ? 0 : (reserve < d - vault.MIN_DEBT() ? reserve : d - vault.MIN_DEBT());
        } else {
            amt = d;
        }
        bool ok = !paused && s != 0 && waited && under && amt > 0;
        try vault.absorb(u) {
            assertTrue(ok, "absorbed when it should not have");
            ++nAbsorb;
        } catch (bytes memory err) {
            assertFalse(ok, "refused an absorb the model allows");
            if (paused) {
                assertEq(bytes4(err), TacVault.Paused.selector);
            } else if (s == 0) {
                assertEq(bytes4(err), TacVault.NoAuction.selector);
            } else if (!waited) {
                assertEq(bytes4(err), TacVault.TooEarly.selector);
                ++nAbsorbEarly;
            } else if (!under) {
                assertEq(bytes4(err), TacVault.Healthy.selector);
            } else {
                assertEq(bytes4(err), TacVault.BadAmount.selector);
            }
        }
    }

    function _cancel(address u) internal {
        (,, uint256 s) = vault.vaults(u);
        bool ok = s != 0 && vault.recovered(u);
        try vault.cancel(u) {
            assertTrue(ok);
            ++nCancel;
        } catch {
            assertFalse(ok);
        }
    }

    function _gov(uint256 x) internal {
        TacVault.Param id = x % 3 == 0
            ? TacVault.Param.OwnerWindow
            : (x % 3 == 1 ? TacVault.Param.AuctionDuration : TacVault.Param.LiqBonusBps);
        uint256 v;
        if (id == TacVault.Param.OwnerWindow) v = 10 minutes + (x >> 8) % 50 minutes;
        else if (id == TacVault.Param.AuctionDuration) v = 30 minutes + (x >> 8) % 5 hours;
        else v = 1 + (x >> 8) % 3_000;
        vm.prank(OWNER);
        try vault.queueParam(id, v) {
            _wait(2 days);
            vm.prank(OWNER);
            try vault.executeParam(id) {
                ++nGov;
            } catch {}
        } catch {}
    }

    function _reopen(address u) internal {
        (, uint256 d,) = vault.vaults(u);
        if (d != 0) return;
        oracle.set(P);
        vm.startPrank(u);
        vault.deposit(15_000e18);
        vault.borrow(2_000e18, 500);
        vm.stopPrank();
        oracle.set(curPrice);
    }

    function _time(uint256 x) internal {
        uint256 t = _t();
        uint256 d;
        if (_running(t) && x % 3 == 0) {
            uint256 left = mU[mF.length - 1] - t; // land on the pause's last second, or on its end
            uint256 back = (x >> 4) % 2;
            d = left > back ? left - back : 0;
        } else {
            d = x % (x % 7 == 0 ? 5 hours : 45 minutes);
        }
        if (d != 0) _wait(d);
    }

    function _step(uint256 r) internal {
        uint256 op = r % 24;
        uint256 x = r >> 8;
        address u = users[x % 2];
        if (op <= 2) {
            _time(x);
        } else if (op == 3) {
            _pause(x);
        } else if (op == 4) {
            _resume(x);
        } else if (op <= 7) {
            curPrice = P * (15 + x % 60) / 100;
            oracle.set(curPrice);
        } else if (op <= 11) {
            _liquidate(u);
        } else if (op <= 14) {
            _bid(u, x >> 4);
        } else if (op == 15) {
            _ownerBid(u, x >> 4);
        } else if (op <= 18) {
            _absorb(u, x >> 4);
        } else if (op == 19) {
            if (x % 6 == 0) _gov(x >> 4);
            else _time(x);
        } else if (op == 20) {
            _cancel(u);
        } else if (op <= 22) {
            _reopen(u);
        } else {
            _wait(x % 20 minutes);
        }
        _check();
    }

    function _check() internal {
        uint256 t = _t();
        uint256 clock = vault.auctionTime();
        assertGe(clock, lastClock, "the clock went back");
        lastClock = clock;
        assertEq(clock, t - _modelPaused(t), "the clock is not the time less the time paused");
        assertEq(vault.paused(), _running(t), "paused() disagrees with the model");
        if (mF.length != 0) {
            assertEq(vault.pausedFrom(), mF[mF.length - 1]);
            assertEq(vault.pausedUntil(), mU[mF.length - 1]);
        }
        for (uint256 i; i < 2; ++i) {
            address u = users[i];
            (, uint256 d, uint256 s) = vault.vaults(u);
            if (s != 0) {
                assertGt(d, 0, "an auction on a vault without debt");
                assertEq(s, mStart[u], "an auction's start moved");
                assertGe(clock, s);
                assertEq(vault.onOffer(u), _expOffer(u, clock), "onOffer is not the formula of the clock");
            }
        }
        assertEq(dollar.totalSupply(), vault.totalDebt(), "supply is not the total debt");
        (, uint256 d0,) = vault.vaults(alice);
        (, uint256 d1,) = vault.vaults(dave);
        (, uint256 d2,) = vault.vaults(bob);
        (, uint256 d3,) = vault.vaults(carol);
        assertEq(d0 + d1 + d2 + d3, vault.totalDebt(), "debts do not sum to the total");
    }

    function _run(uint256 seed, uint256 steps) internal {
        for (uint256 i; i < steps; ++i) {
            _step(uint256(keccak256(abi.encode(seed, i))));
        }
    }

    function test_walkCoverage() public {
        for (uint256 j = 1; j <= 14; ++j) {
            _run(j * 7_919, 120);
        }
        emit log_named_uint("pauses started", nPause);
        emit log_named_uint("pauses lengthened", nLengthen);
        emit log_named_uint("pauses ended early", nResume);
        emit log_named_uint("pauses refused by the cooldown", nCooldown);
        emit log_named_uint("liquidations", nLiq);
        emit log_named_uint("outside bids", nBid);
        emit log_named_uint("outside bids refused: paused", nBidPaused);
        emit log_named_uint("outside bids refused: owner window", nBidWindow);
        emit log_named_uint("owner bids", nOwnerBid);
        emit log_named_uint("absorbs", nAbsorb);
        emit log_named_uint("absorbs refused: too early", nAbsorbEarly);
        emit log_named_uint("cancels", nCancel);
        emit log_named_uint("governed changes", nGov);
        assertGt(nPause, 20);
        assertGt(nLengthen, 5);
        assertGt(nResume, 5);
        assertGt(nCooldown, 5);
        assertGt(nLiq, 20);
        assertGt(nBid, 5);
        assertGt(nBidPaused, 0);
        assertGt(nBidWindow, 0);
        assertGt(nOwnerBid, 0);
        assertGt(nAbsorb, 0);
        assertGt(nAbsorbEarly, 0);
        assertGt(nGov, 3);
    }

    /// forge-config: default.fuzz.runs = 96
    function testFuzz_walk(uint256 seed) public {
        _run(seed, 100);
    }
}

// ───────────────────────────── the synth's minter count, renounce ─────────────────────────────

contract TacVaultMinterCount is R2Base {
    address[4] m;
    bool[4] present;
    bool locked;
    int256 pending = -1; // index of the announced minter, or -1
    uint256 pendingEta;
    uint256 nRenounceRefused;
    uint256 nRenounceOk;

    function setUp() public override {
        super.setUp();
        for (uint256 i; i < 4; ++i) {
            m[i] = address(new R2AcceptAll());
        }
    }

    function _fresh() internal {
        vault = new TacVault(VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER));
        dollar = vault.SYNTH();
        for (uint256 i; i < 4; ++i) {
            present[i] = false;
        }
        locked = false;
        pending = -1;
    }

    function _count() internal view returns (uint256 n) {
        for (uint256 i; i < 4; ++i) {
            if (present[i]) ++n;
        }
    }

    function _check() internal {
        assertEq(dollar.minterCount(), _count(), "minterCount");
        for (uint256 i; i < 4; ++i) {
            assertEq(dollar.isMinter(m[i]), present[i], "isMinter");
        }
        assertEq(dollar.mintersLocked(), locked);
        // `renounceOwnership` goes through exactly when no further minter is in place. (The snapshot also rolls back
        // this contract's own storage, so the outcome is read out first and counted after.)
        bool renounced;
        bytes4 sel;
        address ownerAfter;
        uint256 snap = vm.snapshotState();
        vm.prank(OWNER);
        try vault.renounceOwnership() {
            renounced = true;
            ownerAfter = vault.owner();
        } catch (bytes memory err) {
            sel = bytes4(err);
        }
        vm.revertToState(snap);
        if (renounced) {
            assertEq(_count(), 0, "renounced with a further minter in place");
            assertEq(ownerAfter, address(0));
            ++nRenounceOk;
        } else {
            assertGt(_count(), 0, "refused to renounce with no further minter");
            assertEq(sel, TacVault.MintersRemain.selector);
            ++nRenounceRefused;
        }
    }

    function _step(uint256 r) internal {
        uint256 op = r % 7;
        uint256 i = (r >> 8) % 4;
        uint256 now_ = vm.getBlockTimestamp();
        if (op == 0) {
            bool ok = !locked && !present[i];
            vm.prank(OWNER);
            try dollar.queueMinter(m[i]) {
                assertTrue(ok);
                pending = int256(i);
                pendingEta = now_ + 3 days;
            } catch {
                assertFalse(ok);
            }
        } else if (op == 1) {
            bool ok = !locked && pending >= 0 && now_ >= pendingEta && now_ <= pendingEta + 14 days;
            vm.prank(OWNER);
            try dollar.executeMinter() {
                assertTrue(ok);
                present[uint256(pending)] = true;
                pending = -1;
            } catch {
                assertFalse(ok);
            }
        } else if (op == 2) {
            bool ok = pending >= 0;
            vm.prank(OWNER);
            try dollar.cancelMinter() {
                assertTrue(ok);
                pending = -1;
            } catch {
                assertFalse(ok);
            }
        } else if (op == 3) {
            bool ok = present[i];
            vm.prank(OWNER);
            try dollar.removeMinter(m[i]) {
                assertTrue(ok);
                present[i] = false;
            } catch {
                assertFalse(ok);
            }
        } else if (op == 4) {
            if ((r >> 16) % 25 == 0) {
                vm.prank(OWNER);
                dollar.lockMinters();
                locked = true;
                pending = -1;
            }
        } else if (op == 5) {
            _wait((r >> 8) % 8 days);
        } else {
            // a stranger can do none of it
            vm.prank(alice);
            vm.expectRevert(TacSynth.NotOwner.selector);
            dollar.removeMinter(m[i]);
        }
        _check();
    }

    function test_minterCountStaysExact() public {
        for (uint256 j = 1; j <= 60; ++j) {
            _fresh();
            for (uint256 i; i < 80; ++i) {
                _step(uint256(keccak256(abi.encode(j * 31, i))));
            }
        }
        emit log_named_uint("renounce refused", nRenounceRefused);
        emit log_named_uint("renounce allowed", nRenounceOk);
        assertGt(nRenounceRefused, 300);
        assertGt(nRenounceOk, 300);
    }

    /// Every other way ownership could reach zero (or a hand-over to nobody) is shut, so the minter guard cannot be
    /// walked around, and a minter left standing after a lock can still be removed.
    function test_noWayToZeroOwnershipAroundTheGuard() public {
        vm.startPrank(OWNER);
        dollar.queueMinter(m[0]);
        vm.stopPrank();
        _wait(3 days);
        vm.startPrank(OWNER);
        dollar.executeMinter();
        dollar.lockMinters(); // adding ends; removing stays
        vm.expectRevert(Ownable.NewOwnerIsZeroAddress.selector);
        vault.transferOwnership(address(0));
        vm.expectRevert(Ownable.NoHandoverRequest.selector);
        vault.completeOwnershipHandover(address(0));
        vm.expectRevert(TacVault.MintersRemain.selector);
        vault.renounceOwnership();
        // and not through multicall either
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(vault.renounceOwnership, ());
        vm.expectRevert(TacVault.MintersRemain.selector);
        vault.multicall(calls);
        assertEq(vault.owner(), OWNER);
        dollar.removeMinter(m[0]);
        vault.renounceOwnership();
        vm.stopPrank();
        assertEq(vault.owner(), address(0));
        // Nothing of the owner's is left: not the synth's, not the vault's.
        vm.expectRevert(TacSynth.NotOwner.selector);
        dollar.lockMinters();
        vm.prank(OWNER);
        vm.expectRevert(TacSynth.NotOwner.selector);
        dollar.queueMinter(m[1]);
    }

    /// Renouncing with an announced minter strands it: it can never be executed.
    function test_anAnnouncedMinterDiesWithTheOwner() public {
        vm.prank(OWNER);
        dollar.queueMinter(m[1]);
        vm.prank(OWNER);
        vault.renounceOwnership();
        _wait(5 days);
        vm.expectRevert(TacSynth.NotOwner.selector);
        dollar.executeMinter();
        vm.prank(OWNER);
        vm.expectRevert(TacSynth.NotOwner.selector);
        dollar.executeMinter();
        assertFalse(dollar.isMinter(m[1]));
        assertEq(dollar.minterCount(), 0);
    }
}
