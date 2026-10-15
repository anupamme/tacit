// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Stateful campaigns for TacVault: random sequences of every vault action (deposit, borrow, signed borrow and withdraw,
// repay, liquidate, cancel, partial and full bids, absorb with a donated reserve, redeem, multicall) against a moving
// price, per-window oracle outages, a stale feed, a changing ceiling and depth cap, direct donations and time warps
// inside and outside the owner window. After every call the accounting invariants must hold, and the handler checks
// each action's own postconditions (a revert inside a handler would be dropped by the fuzzer, so a failed expectation
// is recorded in `violation` and an invariant reports it).
//
// Committed defaults are modest. A long run (2000 runs of depth 100 for each of the 9 invariants):
//   set `runs = 2000` in the forge-config lines of TacVaultCampaignUsd and TacVaultCampaignEth, then
//   forge test --match-path test/TacVaultCampaign.t.sol -vv
// (an inline forge-config line takes precedence over FOUNDRY_INVARIANT_RUNS). Path counters (how often each action
// succeeded or failed with which error) are kept per campaign; to see them for one campaign run
//   TAC_VAULT_COVERAGE=64 forge test --match-path test/TacVaultCampaign.t.sol --match-contract TacVaultCampaignUsd \
//     --match-test invariant_noHandlerViolation -vv
// where 64 is the campaign's `runs`: the counters appear as the message of that run's `afterInvariant`.

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {FixedFeed} from "../src/FixedFeed.sol";
import {TestTac, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

/// An oracle with the surface the vault reads: every outage selectable per window, a spread between each window's low
/// and high median, a current price and a newest-interval price that can lag the medians.
contract TacVaultCampaignOracle {
    uint256 internal constant BPS = 10_000;
    uint256 public constant STEP = 50;
    uint256 public constant SHORT_WINDOW = 10 minutes;
    uint256 public constant WINDOW = 1 hours;
    uint256 public constant MAX_WINDOW = 6 hours;
    uint256 public base = 1e14; // every window but SHORT and MAX
    uint256 public shortP = 1e14;
    uint256 public maxP = 1e14;
    uint256 public cur = 1e14;
    uint256 public lastSample = 1e14; // the newest recorded interval's price (`latest()`)
    uint256 public spreadBps;
    uint256 public ethDepth = 1e30;
    // bit 0 SHORT, 1 WINDOW (1h), 2 any other window (the vault's liquidation window), 3 MAX, 4 depth, 5 spot, 6 latest
    uint256 public breaks;

    error Out();

    function setAll(uint256 p, uint256 s) external {
        (base, shortP, maxP, cur, spreadBps) = (p, p, p, p, s);
        lastSample = p;
    }

    function setLatest(uint256 p) external {
        lastSample = p;
    }

    function setViews(uint256 a, uint256 b, uint256 c, uint256 m, uint256 s) external {
        (base, shortP, cur, maxP, spreadBps) = (a, b, c, m, s);
    }

    function setBreaks(uint256 b) external {
        breaks = b;
    }

    /// The state of `o`, for an oracle that takes over from it.
    function copyFrom(TacVaultCampaignOracle o) external {
        (base, shortP, maxP, cur, lastSample) = (o.base(), o.shortP(), o.maxP(), o.cur(), o.lastSample());
        (spreadBps, ethDepth, breaks) = (o.spreadBps(), o.ethDepth(), o.breaks());
    }

    function setDepth(uint256 d) external {
        ethDepth = d;
    }

    function prices(uint256 window) public view returns (uint256 low, uint256 high) {
        uint256 bit = window == SHORT_WINDOW ? 1 : window == WINDOW ? 2 : window == MAX_WINDOW ? 8 : 4;
        if (breaks & bit != 0) revert Out();
        uint256 mid = window == SHORT_WINDOW ? shortP : window == MAX_WINDOW ? maxP : base;
        low = mid * (BPS - spreadBps) / BPS;
        high = mid * (BPS + spreadBps) / BPS;
    }

    function recovery(uint256 window) external view returns (uint256 low) {
        (low,) = prices(window);
    }

    function depth(uint256) external view returns (uint256) {
        if (breaks & 16 != 0) revert Out();
        return ethDepth;
    }

    function depthMin(uint256) external view returns (uint256) {
        if (breaks & 16 != 0) revert Out();
        return ethDepth;
    }

    function spot() external view returns (uint256) {
        if (breaks & 32 != 0) revert Out();
        return cur * (BPS - spreadBps) / BPS;
    }

    function latest() external view returns (uint256) {
        if (breaks & 64 != 0) revert Out();
        return lastSample;
    }
}

/// Random sequences of every vault action with a moving price, outages, a stale feed, a changing ceiling and depth,
/// donations and signatures. Every handler call is wrapped, so a failed expectation is recorded in `violation`
/// (a revert inside a handler would be discarded by the fuzzer) and an invariant reports it.
contract TacVaultCampaignHandler is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    address internal constant OWNER = address(0x0123);
    address internal constant FEE_TO = address(0xFEE);
    address internal constant SINK = address(0xdEaD);

    TacVault public vault;
    TacSynth public synth;
    TestTac public tac;
    TacVaultCampaignOracle public oracle;
    MockFeed public feed;
    bool public fixedFeed;
    string public tag;
    uint256[3] internal keys = [uint256(0xA1), uint256(0xB2), uint256(0xC3)];
    address[3] public users;
    address public outsider = address(0xB1D);

    uint256 public violation;
    uint256 public violationData;
    uint256 public violationData2;
    uint256 public donatedTac;
    uint256 public ghostReserve;
    bool public consistent = true; // the last price move set every view to one value

    constructor(TacVault v, TestTac t, TacVaultCampaignOracle o, address f, bool isFixed, string memory tag_) {
        tag = tag_;
        vault = v;
        synth = v.SYNTH();
        tac = t;
        oracle = o;
        feed = MockFeed(f);
        fixedFeed = isFixed;
        for (uint256 i; i < 3; ++i) {
            users[i] = vm.addr(keys[i]);
            t.mint(users[i], 5_000_000e18);
            _approveAll(users[i]);
        }
        t.mint(outsider, 5_000_000e18);
        _approveAll(outsider);
    }

    function _approveAll(address a) internal {
        vm.startPrank(a);
        tac.approve(address(vault), type(uint256).max);
        synth.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    /// Opens the three vaults the fuzzer starts from and gives the outsider some of the first one's SYNTH.
    function seed() external {
        uint256[3] memory coll = [uint256(100_000e18), 40_000e18, 12_000e18];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(users[i]);
            vault.deposit(coll[i]);
            uint256 val = vault.valueOf(coll[i], true);
            vault.borrow(val * BPS / vault.MINT_RATIO_BPS() * (i == 0 ? 6_000 : 9_000) / BPS, 500);
            vm.stopPrank();
        }
        uint256 half = synth.balanceOf(users[0]) / 2;
        vm.prank(users[0]);
        synth.transfer(outsider, half);
    }

    // ───────────── bookkeeping ─────────────

    function _fail(uint256 code, uint256 data, uint256 data2) internal {
        if (violation == 0) {
            violation = code;
            violationData = data;
            violationData2 = data2;
        }
    }

    function _hit(string memory k) internal {
        string memory key = string.concat("TVC_", tag, "_", k);
        uint256 n = vm.envOr(key, uint256(0));
        string memory listName = string.concat("TVC_KEYS_", tag);
        if (n == 0) vm.setEnv(listName, string.concat(vm.envOr(listName, string("")), ",", key));
        vm.setEnv(key, vm.toString(n + 1));
    }

    function _why(string memory fn, bytes memory err) internal {
        bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
        _hit(string.concat(fn, "_x_", vm.toString(abi.encodePacked(sel))));
    }

    function _vault(address u) internal view returns (uint256 c, uint256 d, uint256 s) {
        (c, d, s) = vault.vaults(u);
    }

    function _u(uint256 s) internal view returns (address) {
        return users[s % 3];
    }

    function _answer() internal view returns (uint256) {
        return fixedFeed ? 1e8 : uint256(feed.answer());
    }

    function _feedOk() internal view returns (bool) {
        if (fixedFeed) return true;
        uint256 up = feed.updatedAt();
        return up != 0 && up <= block.timestamp && block.timestamp - up <= vault.FEED_MAX_STALENESS();
    }

    /// The vault's collateral valued at the one honest price (the oracle's current price, before any spread).
    function _honest(uint256 coll) internal view returns (uint256) {
        return FixedPointMathLib.fullMulDiv(coll, oracle.cur() * _answer() / 1e8, WAD);
    }

    function _liqOk() internal view returns (bool ok, uint256 p) {
        try vault.liquidationPrice() returns (uint256 x) {
            return (true, x);
        } catch {
            return (false, 0);
        }
    }

    function _offerOk() internal view returns (bool ok, uint256 p) {
        try vault.offerPrice() returns (uint256 x) {
            return (true, x);
        } catch {
            return (false, 0);
        }
    }

    function _recOk(address u) internal view returns (bool ok, bool rec) {
        try vault.recovered(u) returns (bool r) {
            return (true, r);
        } catch {
            return (false, false);
        }
    }

    function _borrowRoom(address u) internal view returns (uint256 room) {
        (uint256 c, uint256 d,) = _vault(u);
        try vault.valueOf(c, true) returns (uint256 val) {
            uint256 cap = val * BPS / vault.MINT_RATIO_BPS();
            room = cap > d ? cap - d : 0;
        } catch {}
    }

    function _snap() internal view returns (uint256[9] memory s) {
        for (uint256 i; i < 3; ++i) {
            (s[3 * i], s[3 * i + 1], s[3 * i + 2]) = _vault(users[i]);
        }
    }

    /// A vault at twice the liquidation ratio or more at the honest price, with one price in every view, is never
    /// touched by anyone else: its collateral does not fall and its debt does not rise.
    function _noHarm(uint256[9] memory pre, address exempt, uint256 code) internal {
        if (!consistent || oracle.spreadBps() != 0) return;
        for (uint256 i; i < 3; ++i) {
            if (users[i] == exempt) continue;
            uint256 c0 = pre[3 * i];
            uint256 d0 = pre[3 * i + 1];
            if (d0 != 0 && _honest(c0) * BPS < 2 * vault.LIQ_RATIO_BPS() * d0) continue;
            (uint256 c1, uint256 d1,) = _vault(users[i]);
            if (c1 < c0 || d1 > d0) _fail(code, i, c0);
        }
    }

    // ───────────── environment ─────────────

    function movePrice(uint256 p, uint256 spreadSel) external {
        uint256[5] memory spreads = [uint256(0), 0, 0, 300, 1000];
        oracle.setAll(bound(p, 2e13, 1.5e14), spreads[spreadSel % 5]);
        consistent = true;
        _hit("movePrice");
    }

    function crashPrice(uint256 p) external {
        oracle.setAll(bound(p, 1e11, 5e13), 0);
        consistent = true;
        _hit("crashPrice");
    }

    function lagPrice(uint256 a, uint256 b, uint256 c, uint256 m, uint256 l, uint256 spreadSel) external {
        uint256[3] memory spreads = [uint256(0), 300, 1500];
        oracle.setViews(
            bound(a, 5e12, 3e14),
            bound(b, 5e12, 3e14),
            bound(c, 5e12, 3e14),
            bound(m, 5e12, 3e14),
            spreads[spreadSel % 3]
        );
        oracle.setLatest(bound(l, 5e12, 3e14));
        consistent = false;
        _hit("lagPrice");
    }

    function setDepth(uint256 d, uint256 kind) external {
        oracle.setDepth(kind % 4 == 0 ? 1e30 : bound(d, 1e17, 5e21));
        _hit("setDepth");
    }

    function setBreaks(uint256 mask, uint256 kind) external {
        // mostly clear; sometimes one outage, sometimes any mix
        uint256 m = kind % 5 < 3 ? 0 : kind % 5 == 3 ? 1 << (mask % 7) : mask % 128;
        oracle.setBreaks(m);
        _hit(m == 0 ? "setBreaks_clear" : "setBreaks_on");
    }

    function warp(uint256 s, uint256 refresh) external {
        skip(bound(s, 1, 3 hours));
        if (!fixedFeed && refresh % 5 != 0) feed.set(feed.answer());
        _hit("warp");
    }

    /// Small steps, so bids land inside, at the edge of, and after the owner's window.
    function warpWindow(uint256 s, uint256 refresh) external {
        skip(bound(s, 1, vault.OWNER_WINDOW() + 120));
        if (!fixedFeed && refresh % 5 != 0) feed.set(feed.answer());
        _hit("warpWindow");
    }

    function warpToAuctionEnd(uint256 extra) external {
        skip(vault.AUCTION_DURATION() + bound(extra, 0, 600));
        if (!fixedFeed) feed.set(feed.answer());
        _hit("warpToAuctionEnd");
    }

    function feedStale() external {
        if (fixedFeed) return;
        feed.setUpdatedAt(block.timestamp > 2 hours ? block.timestamp - 2 hours : 1);
        _hit("feedStale");
    }

    function feedPrice(uint256 a) external {
        if (fixedFeed) return;
        feed.set(int256(bound(a, 1500e8, 8000e8)));
        _hit("feedPrice");
    }

    function setCeiling(uint256 c, uint256 kind) external {
        uint256 v = kind % 4 == 0 ? 0 : kind % 4 == 1 ? type(uint128).max : bound(c, 0, 3_000e18);
        vm.prank(OWNER);
        vault.setDebtCeiling(v);
        _hit("setCeiling");
    }

    function setFee(uint256 bps) external {
        bps = bound(bps, 0, 600);
        vm.prank(OWNER);
        try vault.setBorrowFee(bps) {
            if (bps > vault.MAX_BORROW_FEE_BPS()) _fail(1, bps, 0);
            _hit("setFee_ok");
        } catch {
            if (bps <= vault.MAX_BORROW_FEE_BPS()) _fail(2, bps, 0);
            _hit("setFee_revert");
        }
    }

    /// Nobody but the owner changes a setting or the owner.
    function ownerAbuse(uint256 who) external {
        address a = who % 4 == 3 ? outsider : _u(who);
        vm.prank(a);
        try vault.setDebtCeiling(type(uint256).max) {
            _fail(3, 0, 0);
        } catch {}
        vm.prank(a);
        try vault.setBorrowFee(0) {
            _fail(4, 0, 0);
        } catch {}
        vm.prank(a);
        try vault.transferOwnership(a) {
            _fail(5, 0, 0);
        } catch {}
        vm.prank(a);
        try synth.mint(a, 1e18) {
            _fail(6, 0, 0);
        } catch {}
        vm.prank(a);
        try synth.burnFrom(users[0], 1) {
            _fail(7, 0, 0);
        } catch {}
        _hit("ownerAbuse");
    }

    // ───────────── the owner changes the vault's terms and oracle ─────────────

    uint256 internal constant GOV_RAIL_MIN_LIQ = 12_000;
    uint256 internal constant GOV_RAIL_MAX_LIQ = 30_000;
    mapping(address => uint256) public exemptDebt; // a debt left under a minimum debt that was raised

    function _termNow(TacVault.Param id) internal view returns (uint256) {
        if (id == TacVault.Param.DepthBps) return vault.DEPTH_BPS();
        if (id == TacVault.Param.MintRatioBps) return vault.MINT_RATIO_BPS();
        if (id == TacVault.Param.LiqRatioBps) return vault.LIQ_RATIO_BPS();
        if (id == TacVault.Param.LiqBonusBps) return vault.LIQ_BONUS_BPS();
        if (id == TacVault.Param.OwnerWindow) return vault.OWNER_WINDOW();
        if (id == TacVault.Param.AuctionDuration) return vault.AUCTION_DURATION();
        return vault.MIN_DEBT();
    }

    function _govValue(TacVault.Param id, uint256 raw) internal view returns (uint256) {
        // A third of the picks stay near the term as it is, so that changes that pass the rails are common.
        if (raw % 3 == 0) return _termNow(id) * (70 + (raw >> 16) % 71) / 100;
        if (id == TacVault.Param.DepthBps) return (raw >> 8) % 1_101;
        if (id == TacVault.Param.MintRatioBps) return 10_000 + (raw >> 8) % 95_000;
        if (id == TacVault.Param.LiqRatioBps) return 11_000 + (raw >> 8) % 20_000;
        if (id == TacVault.Param.LiqBonusBps) return (raw >> 8) % 5_200;
        if (id == TacVault.Param.OwnerWindow) return (raw >> 8) % 90_000;
        if (id == TacVault.Param.AuctionDuration) return (raw >> 8) % 270_000;
        uint256 base = vault.MIN_DEBT_BASE();
        return base / 20 + (raw >> 8) % (base * 110);
    }

    // The rails the new value of `id` must be inside, with the other terms as they are and the old depth share `pre`.
    function _railsOk(TacVault.Param id, uint256 v, uint256 pre) internal view returns (bool) {
        uint256 liq = vault.LIQ_RATIO_BPS();
        uint256 mint = vault.MINT_RATIO_BPS();
        uint256 bonus = vault.LIQ_BONUS_BPS();
        uint256 ow = vault.OWNER_WINDOW();
        uint256 ad = vault.AUCTION_DURATION();
        if (id == TacVault.Param.DepthBps) return v <= vault.MAX_DEPTH_BPS() && v <= 2 * pre + 25;
        if (id == TacVault.Param.MintRatioBps) return v <= 100_000 && v >= liq + 2_000;
        if (id == TacVault.Param.LiqRatioBps) {
            return v >= GOV_RAIL_MIN_LIQ && v <= GOV_RAIL_MAX_LIQ && mint >= v + 2_000 && 10_000 + bonus < v;
        }
        if (id == TacVault.Param.LiqBonusBps) return v != 0 && v <= 5_000 && 10_000 + v < liq;
        if (id == TacVault.Param.OwnerWindow) return v >= 10 minutes && v <= 1 days && v < ad;
        if (id == TacVault.Param.AuctionDuration) return v >= 30 minutes && v <= 3 days && ow < v;
        return v >= vault.MIN_DEBT_BASE() / 10 && v <= vault.MIN_DEBT_BASE() * 100;
    }

    /// Announce, wait, apply: a term moves only at the end of its wait, only inside the rails, and moves nobody's
    /// vault. An announcement that is cancelled, or let lapse, does not apply.
    function govTerm(uint256 sel, uint256 raw, uint256 mode) external {
        TacVault.Param id = TacVault.Param(sel % 7);
        uint256 v = _govValue(id, raw);
        uint256[9] memory snap = _snap();
        uint256 pre = _termNow(id);
        vm.prank(OWNER);
        try vault.queueParam(id, v) {}
        catch {
            _hit("govTerm_refused");
            return;
        }
        if (_termNow(id) != pre) _fail(40, uint256(id), pre);
        vm.prank(OWNER);
        try vault.executeParam(id) {
            _fail(41, uint256(id), v);
        } catch {}
        uint256 m = mode % 3;
        if (m == 0) {
            vm.prank(OWNER);
            vault.cancelParam(id);
            skip(vault.PARAM_DELAY());
            if (!fixedFeed) feed.set(feed.answer());
            vm.prank(OWNER);
            try vault.executeParam(id) {
                _fail(42, uint256(id), v);
            } catch {}
            _hit("govTerm_cancelled");
            return;
        }
        skip(m == 1 ? vault.PARAM_DELAY() : vault.PARAM_DELAY() + vault.QUEUE_EXPIRY() + 1);
        if (!fixedFeed) feed.set(feed.answer());
        vm.prank(OWNER);
        try vault.executeParam(id) {
            if (m != 1) _fail(43, uint256(id), v);
            if (_termNow(id) != v) _fail(44, uint256(id), v);
            if (!_railsOk(id, v, pre)) _fail(45, uint256(id), v);
            if (id == TacVault.Param.MinDebt) {
                for (uint256 i; i < 3; ++i) {
                    (, uint256 d,) = _vault(users[i]);
                    exemptDebt[users[i]] = d != 0 && d < v ? d : 0;
                }
            }
            _hit("govTerm_applied");
        } catch {
            if (_termNow(id) != pre) _fail(46, uint256(id), pre);
            _hit(m == 1 ? "govTerm_not_applied" : "govTerm_lapsed");
        }
        uint256[9] memory post = _snap();
        for (uint256 i; i < 9; ++i) {
            if (post[i] != snap[i]) _fail(47, i, snap[i]);
        }
    }

    function govLowerDepth(uint256 raw) external {
        uint256 cur = vault.DEPTH_BPS();
        vm.prank(OWNER);
        try vault.lowerDepthBps(cur + raw % 5) {
            _fail(48, cur, raw);
        } catch {}
        if (cur == 0) return;
        uint256 to = raw % cur;
        vm.prank(OWNER);
        vault.lowerDepthBps(to);
        if (vault.DEPTH_BPS() != to) _fail(49, to, cur);
        _hit("govLowerDepth");
    }

    function govRedemptionFee(uint256 raw) external {
        uint256 bps = raw % 300;
        vm.prank(OWNER);
        try vault.setRedemptionFee(bps) {
            if (bps > vault.MAX_REDEMPTION_FEE_BPS() || vault.REDEMPTION_FEE_BPS() != bps) _fail(50, bps, 0);
            _hit("govFee_ok");
        } catch {
            if (bps <= vault.MAX_REDEMPTION_FEE_BPS()) _fail(51, bps, 0);
            _hit("govFee_refused");
        }
    }

    /// The oracle is replaced by one with the same state: only after its wait, and only if it prices every view.
    function govOracle(uint256 mode) external {
        TacVaultCampaignOracle n = new TacVaultCampaignOracle();
        n.copyFrom(oracle);
        address old = address(vault.ORACLE());
        vm.prank(OWNER);
        try vault.queueOracle(address(n)) {}
        catch {
            _hit("govOracle_refused");
            return;
        }
        if (address(vault.ORACLE()) != old) _fail(52, 0, 0);
        vm.prank(OWNER);
        try vault.executeOracle() {
            _fail(53, 0, 0);
        } catch {}
        if (mode % 3 == 0) {
            vm.prank(OWNER);
            vault.cancelOracle();
            _hit("govOracle_cancelled");
            return;
        }
        skip(vault.ORACLE_DELAY());
        if (!fixedFeed) feed.set(feed.answer());
        vm.prank(OWNER);
        try vault.executeOracle() {
            if (address(vault.ORACLE()) != address(n)) _fail(54, 0, 0);
            oracle = n; // the price moves that follow go to the oracle in place
            _hit("govOracle_applied");
        } catch {
            if (address(vault.ORACLE()) != old) _fail(55, 0, 0);
            vm.prank(OWNER);
            vault.cancelOracle();
            _hit("govOracle_not_applied");
        }
    }

    // ───────────── borrower actions ─────────────

    function deposit(uint256 who, uint256 amt) external {
        address u = _u(who);
        amt = bound(amt, 1, 2_000_000e18);
        uint256[9] memory pre = _snap();
        (uint256 c0,, uint256 s0) = _vault(u);
        uint256 bal0 = tac.balanceOf(u);
        vm.prank(u);
        try vault.deposit(amt) {
            _hit("deposit_ok");
            (uint256 c1,, uint256 s1) = _vault(u);
            if (c1 != c0 + amt || tac.balanceOf(u) != bal0 - amt) _fail(10, c1, c0);
            if (s0 != 0) _staleAuction(u, s1, 11);
            if (s0 != 0 && s1 == 0) _hit("deposit_endedAuction");
        } catch (bytes memory err) {
            _why("deposit", err);
            if (bal0 >= amt) _fail(12, amt, 0);
        }
        _noHarm(pre, u, 13);
    }

    function depositFor(uint256 who, uint256 forWho, uint256 amt) external {
        address payer = who % 4 == 3 ? outsider : _u(who);
        address u = _u(forWho);
        amt = bound(amt, 1, 200_000e18);
        uint256[9] memory pre = _snap();
        (uint256 c0,, uint256 s0) = _vault(u);
        vm.prank(payer);
        try vault.depositFor(u, amt) {
            _hit("depositFor_ok");
            (uint256 c1,, uint256 s1) = _vault(u);
            if (c1 != c0 + amt) _fail(14, c1, c0);
            if (s0 != 0) _staleAuction(u, s1, 15);
        } catch {
            _hit("depositFor_revert");
        }
        _noHarm(pre, address(0xdead00), 16);
    }

    // After a deposit or a repay on an auctioned vault that has recovered, the auction is over.
    function _staleAuction(address u, uint256 s1, uint256 code) internal {
        if (s1 == 0) return;
        (bool ok, bool rec) = _recOk(u);
        (, uint256 d,) = _vault(u);
        if (d == 0 || (ok && rec)) _fail(code, d, ok ? 1 : 0);
    }

    function borrow(uint256 who, uint256 frac, uint256 mode) external {
        address u = _u(who);
        (uint256 c0, uint256 d0, uint256 s0) = _vault(u);
        uint256 amt = _borrowRoom(u) * bound(frac, 3_000, 10_500) / BPS;
        uint256 minD = vault.MIN_DEBT();
        if (mode % 8 == 0) amt = minD;
        else if (mode % 8 == 1) amt = minD - 1;
        else if (amt == 0) amt = minD;
        uint256 feeBps = vault.borrowFeeBps();
        uint256 maxFee = mode % 5 == 0 ? (feeBps > 0 ? feeBps - 1 : 0) : 500;
        uint256 tot0 = vault.totalDebt();
        uint256 bal0 = synth.balanceOf(u);
        uint256 feeBal0 = synth.balanceOf(FEE_TO);
        vm.prank(u);
        try vault.borrow(amt, maxFee) {
            _hit("borrow_ok");
            if (s0 != 0) _fail(20, s0, 0);
            if (feeBps > maxFee) _fail(21, feeBps, maxFee);
            uint256 fee = amt * feeBps / BPS;
            (uint256 c1, uint256 d1,) = _vault(u);
            if (c1 != c0 || d1 != d0 + amt + fee) _fail(22, d1, d0);
            if (vault.totalDebt() != tot0 + amt + fee) _fail(23, vault.totalDebt(), tot0);
            if (synth.balanceOf(u) != bal0 + amt) _fail(24, 0, 0);
            if (synth.balanceOf(FEE_TO) != feeBal0 + fee) _fail(25, 0, 0);
            if (vault.totalDebt() > vault.debtCeiling()) _fail(26, vault.totalDebt(), vault.debtCeiling());
            if (vault.totalDebt() > vault.depthCeiling()) _fail(27, vault.totalDebt(), vault.depthCeiling());
            if (d1 < minD) _fail(28, d1, 0);
            if (d1 * vault.MINT_RATIO_BPS() > vault.valueOf(c1, true) * BPS) _fail(29, d1, c1);
        } catch (bytes memory err) {
            _why("borrow", err);
            // everything in order: no auction, a price, room under the ceilings, the fee accepted
            (bool lok,) = _liqOk();
            bool depthOk;
            try vault.depthCeiling() returns (uint256 dc) {
                depthOk = tot0 + amt + amt * feeBps / BPS <= dc;
            } catch {}
            uint256 total = tot0 + amt + amt * feeBps / BPS;
            if (
                s0 == 0 && lok && _borrowViewOk() && depthOk && total <= vault.debtCeiling() && feeBps <= maxFee
                    && d0 + amt + amt * feeBps / BPS >= minD && amt != 0
                    && (d0 + amt + amt * feeBps / BPS) * vault.MINT_RATIO_BPS() <= vault.valueOf(c0, true) * BPS
            ) _fail(30, amt, d0);
        }
    }

    function _borrowViewOk() internal view returns (bool ok) {
        try vault.valueOf(0, true) returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    function repay(uint256 payerSel, uint256 forWho, uint256 amtSel, uint256 mode) external {
        address payer = payerSel % 4 == 3 ? outsider : _u(payerSel);
        address u = _u(forWho);
        uint256[9] memory pre = _snap();
        (uint256 c0, uint256 d0, uint256 s0) = _vault(u);
        uint256 minD = vault.MIN_DEBT();
        uint256 amt;
        uint256 k = mode % 6;
        if (k == 0) amt = type(uint256).max;
        else if (k == 1) amt = d0;
        else if (k == 2) amt = d0 > minD ? d0 - minD : 1;
        else if (k == 3) amt = d0 > minD ? d0 - minD + 1 : 1;
        else if (k == 4) amt = bound(amtSel, 1, d0 + 1);
        else amt = d0 / 3 + 1;
        uint256 paid0 = FixedPointMathLib.min(amt, d0);
        bool shouldWork =
            d0 != 0 && paid0 != 0 && (d0 == paid0 || d0 - paid0 >= minD) && synth.balanceOf(payer) >= paid0;
        uint256 tot0 = vault.totalDebt();
        vm.prank(payer);
        try vault.repay(u, amt) returns (uint256 paid) {
            _hit("repay_ok");
            if (!shouldWork || paid != paid0) _fail(40, paid, paid0);
            (uint256 c1, uint256 d1, uint256 s1) = _vault(u);
            if (d1 != d0 - paid || c1 != c0 || vault.totalDebt() != tot0 - paid) _fail(41, d1, d0);
            if (d1 != 0 && d1 < minD) _fail(42, d1, 0);
            if (s0 != 0) _staleAuction(u, s1, 43);
            if (s0 != 0 && s1 == 0) _hit("repay_endedAuction");
            if (paid0 < d0) _hit("repay_partial");
        } catch (bytes memory err) {
            _why("repay", err);
            // repaying never needs a price: an in-bounds repay from a funded payer must work
            if (shouldWork) _fail(44, paid0, d0);
        }
        _noHarm(pre, address(0xdead00), 45);
    }

    function withdraw(uint256 who, uint256 amtSel, uint256 mode) external {
        address u = _u(who);
        uint256[9] memory pre = _snap();
        (uint256 c0, uint256 d0, uint256 s0) = _vault(u);
        uint256 amt = mode % 3 == 0 ? type(uint256).max : mode % 3 == 1 ? c0 / 3 + 1 : bound(amtSel, 1, c0 + 1);
        uint256 w = FixedPointMathLib.min(amt, c0);
        uint256 bal0 = tac.balanceOf(u);
        vm.prank(u);
        try vault.withdraw(amt) {
            _hit("withdraw_ok");
            (uint256 c1, uint256 d1,) = _vault(u);
            if (s0 != 0 || w == 0) _fail(50, s0, w);
            if (c1 != c0 - w || d1 != d0 || tac.balanceOf(u) != bal0 + w) _fail(51, c1, c0);
            if (d1 != 0 && d1 * vault.MINT_RATIO_BPS() > vault.valueOf(c1, true) * BPS) _fail(52, d1, c1);
        } catch (bytes memory err) {
            _why("withdraw", err);
            // no debt and no auction: withdrawing needs no price
            if (d0 == 0 && s0 == 0 && w != 0) _fail(53, c0, 0);
        }
        _noHarm(pre, u, 54);
    }

    // ───────────── signatures ─────────────

    function borrowFor(uint256 who, uint256 toSel, uint256 frac, uint256 mode) external {
        address u = _u(who);
        (uint256 c0, uint256 d0,) = _vault(u);
        uint256 amt = _borrowRoom(u) * bound(frac, 3_000, 9_500) / BPS;
        if (amt < vault.MIN_DEBT()) amt = vault.MIN_DEBT();
        address to = toSel % 4 == 0 ? address(vault) : toSel % 4 == 1 ? outsider : toSel % 4 == 2 ? u : _u(toSel / 4);
        uint256 minColl = mode % 3 == 0 ? c0 + 1 : c0;
        uint256 deadline = mode % 7 == 0 ? block.timestamp - 1 : block.timestamp + 1 hours;
        bool badSigner = mode % 11 == 0;
        uint256 maxFee = mode % 13 == 0 ? 0 : 500;
        bool shouldAuthorize = mode % 3 != 0 && mode % 7 != 0 && !badSigner;
        uint256 nonce = vault.nonces(u);
        bytes memory sig;
        {
            bytes32 sh = keccak256(abi.encode(vault.BORROW(), u, amt, maxFee, minColl, to, nonce, deadline));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(badSigner ? keys[(who + 1) % 3] : keys[who % 3], vault.digest(sh));
            sig = abi.encodePacked(r, s, v);
        }
        uint256 sup0 = synth.totalSupply();
        uint256 toBal0 = synth.balanceOf(to);
        vm.prank(outsider);
        try vault.borrowFor(u, amt, maxFee, minColl, to, deadline, sig) {
            _hit("borrowFor_ok");
            if (!shouldAuthorize) _fail(60, mode, 0);
            if (vault.nonces(u) != nonce + 1) _fail(61, nonce, 0);
            if (synth.balanceOf(to) < toBal0 + amt) _fail(62, 0, 0);
            if (to == address(vault)) ghostReserve += amt;
            (, uint256 d1,) = _vault(u);
            if (d1 < d0 + amt) _fail(63, d1, d0);
            if (synth.totalSupply() != sup0 + (d1 - d0)) _fail(64, 0, 0);
            // the same signature, again, from anyone
            vm.prank(outsider);
            try vault.borrowFor(u, amt, maxFee, minColl, to, deadline, sig) {
                _fail(65, 0, 0);
            } catch {}
            vm.prank(u);
            try vault.borrowFor(u, amt, maxFee, minColl, to, deadline, sig) {
                _fail(66, 0, 0);
            } catch {}
        } catch (bytes memory err) {
            _why("borrowFor", err);
            if (vault.nonces(u) != nonce) _fail(67, 0, 0);
        }
    }

    function withdrawFor(uint256 who, uint256 toSel, uint256 amtSel, uint256 mode) external {
        address u = _u(who);
        (uint256 c0,, uint256 s0) = _vault(u);
        address to = toSel % 3 == 0 ? outsider : toSel % 3 == 1 ? u : _u(toSel / 3);
        uint256 amt = mode % 4 == 0 ? type(uint256).max : bound(amtSel, 1, c0 + 1);
        uint256 deadline = mode % 7 == 0 ? block.timestamp - 1 : block.timestamp + 1 hours;
        bool badSigner = mode % 11 == 0;
        uint256 nonce = vault.nonces(u);
        bytes memory sig;
        {
            bytes32 sh = keccak256(abi.encode(vault.WITHDRAW(), u, amt, to, nonce, deadline));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(badSigner ? keys[(who + 2) % 3] : keys[who % 3], vault.digest(sh));
            sig = abi.encodePacked(r, s, v);
        }
        uint256 bal0 = tac.balanceOf(to);
        vm.prank(outsider);
        try vault.withdrawFor(u, amt, to, deadline, sig) {
            _hit("withdrawFor_ok");
            if (badSigner || mode % 7 == 0 || s0 != 0) _fail(70, mode, s0);
            if (tac.balanceOf(to) != bal0 + FixedPointMathLib.min(amt, c0)) _fail(71, 0, 0);
            vm.prank(outsider);
            try vault.withdrawFor(u, amt, to, deadline, sig) {
                _fail(72, 0, 0);
            } catch {}
        } catch (bytes memory err) {
            _why("withdrawFor", err);
            if (vault.nonces(u) != nonce) _fail(73, 0, 0);
        }
    }

    function useNonce(uint256 who) external {
        address u = _u(who);
        uint256 n = vault.nonces(u);
        vm.prank(u);
        vault.useNonce();
        if (vault.nonces(u) != n + 1) _fail(74, 0, 0);
        _hit("useNonce");
    }

    function multicallOpen(uint256 who, uint256 depAmt, uint256 frac) external {
        address u = _u(who);
        uint256 dep = bound(depAmt, 1_000e18, 300_000e18);
        (uint256 c0,,) = _vault(u);
        uint256 amt;
        try vault.valueOf(c0 + dep, true) returns (uint256 val) {
            (, uint256 d0,) = _vault(u);
            uint256 cap = val * BPS / vault.MINT_RATIO_BPS();
            amt = (cap > d0 ? cap - d0 : 0) * bound(frac, 3_000, 9_500) / BPS;
        } catch {}
        if (amt < vault.MIN_DEBT()) amt = vault.MIN_DEBT();
        bytes[] memory data = new bytes[](2);
        data[0] = abi.encodeCall(vault.deposit, (dep));
        data[1] = abi.encodeCall(vault.borrow, (amt, 500));
        vm.prank(u);
        try vault.multicall(data) {
            _hit("multicallOpen_ok");
        } catch {
            _hit("multicallOpen_revert");
        }
    }

    // ───────────── liquidation ─────────────

    function liquidate(uint256 who) external {
        address u = _u(who);
        uint256[9] memory pre = _snap();
        (uint256 c0, uint256 d0, uint256 s0) = _vault(u);
        (bool lok, uint256 pl) = _liqOk();
        bool expected =
            s0 == 0 && d0 != 0 && lok && FixedPointMathLib.fullMulDiv(c0, pl, WAD) * BPS < d0 * vault.LIQ_RATIO_BPS();
        vm.prank(outsider);
        try vault.liquidate(u) {
            _hit("liquidate_ok");
            (,, uint256 s1) = _vault(u);
            if (!expected || s1 != block.timestamp) _fail(80, 0, 0);
            // never against a vault that is healthy at the honest price
            if (
                consistent
                    && FixedPointMathLib.fullMulDiv(c0, oracle.cur() * _answer() / 1e8, WAD) * BPS
                        >= d0 * vault.LIQ_RATIO_BPS()
            ) {
                _fail(81, c0, d0);
            }
        } catch (bytes memory err) {
            _why("liquidate", err);
            if (expected) _fail(82, c0, d0);
        }
        _noHarm(pre, address(0xdead00), 83);
    }

    function cancel(uint256 who) external {
        address u = _u(who);
        (, uint256 d0, uint256 s0) = _vault(u);
        (bool rok, bool rec) = _recOk(u);
        bool expected = s0 != 0 && rok && rec;
        vm.prank(outsider);
        try vault.cancel(u) {
            _hit("cancel_ok");
            (,, uint256 s1) = _vault(u);
            if (!expected || s1 != 0) _fail(84, d0, 0);
        } catch (bytes memory err) {
            _why("cancel", err);
            if (expected) _fail(85, d0, 0);
        }
    }

    function bid(uint256 victimSel, uint256 bidderSel, uint256 fracSel, uint256 minSel) external {
        address u = _u(victimSel);
        address bidder = bidderSel % 3 == 0 ? u : bidderSel % 3 == 1 ? outsider : _u(bidderSel / 3 + 1);
        _bid(u, bidder, fracSel, minSel);
    }

    function _bid(address u, address bidder, uint256 fracSel, uint256 minSel) internal {
        uint256[9] memory pre = _snap();
        (uint256 c0, uint256 d0, uint256 s0) = _vault(u);
        uint256 minD = vault.MIN_DEBT();
        uint256 amt;
        {
            uint256 k = fracSel % 9;
            if (k == 0) amt = 1;
            else if (k == 1) amt = d0 / 1000 + 1;
            else if (k == 2) amt = d0 / 4;
            else if (k == 3) amt = d0 / 2;
            else if (k == 4) amt = d0 > minD ? d0 - minD : 1;
            else if (k == 5) amt = d0 > minD ? d0 - minD + 1 : 1;
            else if (k == 6) amt = d0;
            else if (k == 7) amt = type(uint256).max;
            else amt = synth.balanceOf(bidder);
        }
        uint256 amtEff = FixedPointMathLib.min(amt, d0);
        bool dustOk = amtEff != 0 && (d0 - amtEff == 0 || d0 - amtEff >= minD);
        (bool recOk, bool rec) = _recOk(u);
        (bool offOk, uint256 po) = _offerOk();
        uint256 offerTac = vault.onOffer(u);
        uint256 minTac = minSel % 5 == 0 ? c0 + 1 : minSel % 5 == 1 && d0 != 0 ? offerTac * amtEff / d0 : 0;
        bool inWindow = s0 != 0 && block.timestamp < s0 + vault.OWNER_WINDOW();
        bool shouldWork = s0 != 0 && dustOk && synth.balanceOf(bidder) >= amtEff
            && (bidder == u || (recOk && !rec && offOk && !inWindow)) && !(minSel % 5 == 0);
        if (bidder != u && inWindow) _hit("bid_attemptInOwnerWindow");
        uint256 bTac0 = tac.balanceOf(bidder);
        uint256 bSyn0 = synth.balanceOf(bidder);
        uint256 tot0 = vault.totalDebt();
        vm.prank(bidder);
        try vault.bid(u, amt, minTac) returns (uint256 taken) {
            _hit(bidder == u ? "bid_ok_owner" : "bid_ok_outsider");
            if (!shouldWork) _fail(90, s0, 0);
            // the outsider only ever bids with a price for the offer, after the owner's window
            if (bidder != u && (!offOk || inWindow)) _fail(91, offOk ? 1 : 0, inWindow ? 1 : 0);
            (uint256 c1, uint256 d1, uint256 s1) = _vault(u);
            if (taken != offerTac * amtEff / d0 || c1 != c0 - taken || d1 != d0 - amtEff) _fail(92, taken, offerTac);
            // the bid ends the auction when it leaves no debt or the vault recovered (and keeps it otherwise)
            (bool rok2, bool rec2) = _recOk(u);
            if (d1 == 0 || (rok2 && rec2) ? s1 != 0 : s1 != s0) _fail(93, d1, s1);
            if (d1 != 0 && s1 == 0) _hit("bid_endedAuctionWithDebtLeft");
            if (c1 * d0 < c0 * d1) _fail(94, c1, d1);
            if (synth.balanceOf(bidder) != bSyn0 - amtEff || tac.balanceOf(bidder) != bTac0 + taken) _fail(95, 0, 0);
            if (vault.totalDebt() != tot0 - amtEff) _fail(96, 0, 0);
            if (d1 != 0 && d1 < minD) _fail(97, d1, 0);
            if (offOk) {
                uint256 elapsed = FixedPointMathLib.min(block.timestamp - s0, vault.AUCTION_DURATION());
                uint256 bonus = vault.LIQ_BONUS_BPS() * elapsed / vault.AUCTION_DURATION();
                // the bidder never takes more than the repaid debt plus the bonus earned, at the offer view
                if (FixedPointMathLib.fullMulDiv(taken, po, WAD) > amtEff * (BPS + bonus) / BPS) {
                    _fail(98, taken, amtEff);
                }
            }
            if (bidder != u && consistent && oracle.spreadBps() == 0 && _feedOk()) {
                // a non-owner bid only on a vault that is under water at the one honest price
                if (_honest(c0) * BPS >= d0 * vault.LIQ_RATIO_BPS()) _fail(99, c0, d0);
            }
            if (d1 < d0 && d1 != 0) _hit("bid_partial");
            if (d1 == 0) _hit("bid_full");
            if (taken == c0 && d1 == 0) _hit("bid_tookAllCollateral");
        } catch (bytes memory err) {
            _why("bid", err);
            // the owner always can; an outsider can whenever a price exists and the vault has not recovered
            if (shouldWork) _fail(100, s0, d0);
        }
        _noHarm(pre, bidder, 101);
    }

    function donateSynth(uint256 who, uint256 frac) external {
        address u = _u(who);
        uint256 bal = synth.balanceOf(u);
        uint256 amt = bal * bound(frac, 1, 10_000) / BPS;
        if (amt == 0) return;
        vm.prank(u);
        synth.transfer(address(vault), amt);
        ghostReserve += amt;
        _hit("donateSynth");
    }

    function donateTac(uint256 who, uint256 amt) external {
        address u = _u(who);
        amt = bound(amt, 1, 50_000e18);
        vm.prank(u);
        tac.transfer(address(vault), amt);
        donatedTac += amt;
        _hit("donateTac");
    }

    function giveSynth(uint256 who, uint256 frac) external {
        address u = _u(who);
        uint256 amt = synth.balanceOf(u) * bound(frac, 1, 10_000) / BPS;
        vm.prank(u);
        synth.transfer(outsider, amt);
        _hit("giveSynth");
    }

    function harvestFees(uint256 frac) external {
        uint256 amt = synth.balanceOf(FEE_TO) * bound(frac, 1, 10_000) / BPS;
        vm.prank(FEE_TO);
        synth.transfer(outsider, amt);
        _hit("harvestFees");
    }

    function absorb(uint256 who) external {
        _absorb(_u(who));
    }

    function _absorb(address u) internal {
        uint256[9] memory pre = _snap();
        (uint256 c0, uint256 d0, uint256 s0) = _vault(u);
        uint256 reserve = synth.balanceOf(address(vault));
        (bool lok, uint256 pl) = _liqOk();
        uint256 minD = vault.MIN_DEBT();
        uint256 amount;
        if (d0 != 0) amount = reserve < d0 ? FixedPointMathLib.min(reserve, d0 >= minD ? d0 - minD : 0) : d0;
        bool expected = s0 != 0 && block.timestamp - s0 >= vault.AUCTION_DURATION() && lok && d0 != 0
            && FixedPointMathLib.fullMulDiv(c0, pl, WAD) < d0 && amount != 0;
        uint256 sink0 = tac.balanceOf(SINK);
        uint256 tot0 = vault.totalDebt();
        vm.prank(address(0xA85));
        try vault.absorb(u) {
            (uint256 c1, uint256 d1, uint256 s1) = _vault(u);
            if (!expected) _fail(110, s0, 0);
            if (d0 - d1 != amount) _fail(111, d0 - d1, amount);
            uint256 tacOut = c0 - c1;
            if (tacOut != c0 * amount / d0 || tac.balanceOf(SINK) != sink0 + tacOut) _fail(112, tacOut, 0);
            if (synth.balanceOf(address(vault)) != reserve - amount) _fail(113, 0, 0);
            (bool rok3, bool rec3) = _recOk(u);
            if (d1 == 0 || (rok3 && rec3) ? s1 != 0 : s1 != s0) _fail(114, d1, s1);
            if (c1 * d0 < c0 * d1) _fail(115, c1, d1);
            if (vault.totalDebt() != tot0 - amount) _fail(116, 0, 0);
            if (d1 != 0 && d1 < minD) _fail(117, d1, 0);
            ghostReserve -= amount;
            _hit(d1 == 0 ? "absorb_full" : "absorb_partial");
        } catch (bytes memory err) {
            _why("absorb", err);
            if (expected) _fail(118, c0, d0);
        }
        _noHarm(pre, address(0xdead00), 119);
    }

    // ───────────── redemption ─────────────

    function redeem(uint256 redeemerSel, uint256 victimSel, uint256 fracSel) external {
        address redeemer = redeemerSel % 3 == 0 ? outsider : _u(redeemerSel);
        address u = _u(victimSel);
        uint256[9] memory pre = _snap();
        (uint256 c0, uint256 d0, uint256 s0) = _vault(u);
        uint256 minD = vault.MIN_DEBT();
        uint256 amount;
        {
            uint256 k = fracSel % 7;
            if (k == 0) amount = 1;
            else if (k == 1) amount = d0 / 10 + 1;
            else if (k == 2) amount = d0 / 2;
            else if (k == 3) amount = d0 > minD ? d0 - minD : 1;
            else if (k == 4) amount = d0;
            else if (k == 5) amount = d0 + 1;
            else amount = minD;
        }
        uint256 L = vault.LIQ_RATIO_BPS();
        uint256 F = vault.REDEMPTION_FEE_BPS();
        (bool lok, uint256 pl) = _liqOk();
        uint256 ratio = lok && d0 != 0 ? FixedPointMathLib.fullMulDiv(c0, pl, WAD) * BPS / d0 : 0;
        (bool offOk, uint256 po) = _offerOk();
        // the redemption price is the offer view (the liquidation view or the newest recorded interval)
        uint256 pr = po;
        bool inBand = lok && offOk && s0 == 0 && ratio >= L && ratio < 2 * L;
        bool dustOk = amount != 0 && amount <= d0 && (d0 - amount == 0 || d0 - amount >= minD);
        uint256 tacExp;
        if (inBand && dustOk && pr != 0) {
            uint256 fee = F + F * 3 * (ratio - L) / L;
            tacExp = FixedPointMathLib.fullMulDiv(amount * (BPS - fee) / BPS, WAD, pr);
        }
        bool expected = inBand && dustOk && pr != 0 && tacExp <= c0 && synth.balanceOf(redeemer) >= amount && _feedOk();
        uint256 rTac0 = tac.balanceOf(redeemer);
        vm.prank(redeemer);
        try vault.redeem(u, amount, 0) returns (uint256 tacOut) {
            _hit("redeem_ok");
            if (!expected || tacOut != tacExp) _fail(120, tacOut, tacExp);
            (uint256 c1, uint256 d1,) = _vault(u);
            if (c1 != c0 - tacOut || d1 != d0 - amount) _fail(121, c1, d1);
            if (tac.balanceOf(redeemer) != rTac0 + tacOut) _fail(122, 0, 0);
            // a redemption never lowers the vault's collateral per debt (so never its ratio, at any price)
            if (d1 != 0 && c1 * d0 < c0 * d1) _fail(123, c1, d1);
            // and never takes more than the debt it repays, less the base fee, at the liquidation view
            if (FixedPointMathLib.fullMulDiv(tacOut, pl, WAD) > amount * (BPS - F) / BPS) _fail(124, tacOut, amount);
            if (
                consistent && oracle.spreadBps() == 0
                    && FixedPointMathLib.fullMulDiv(tacOut, oracle.cur() * _answer() / 1e8, WAD)
                        > amount * (BPS - F) / BPS
            ) {
                _fail(125, tacOut, amount);
            }
            if (d1 != 0 && d1 < minD) _fail(126, d1, 0);
            if (d1 == 0) _hit("redeem_full");
        } catch (bytes memory err) {
            _why("redeem", err);
            if (expected) _fail(127, c0, d0);
        }
        _noHarm(pre, address(0xdead00), 128);
    }

    // ───────────── scenarios (to reach deep states) ─────────────

    /// Crashes the price far enough to put the victim under the liquidation line, opens its auction.
    function scenarioCrashAndLiquidate(uint256 who, uint256 depth_) external {
        address u = _u(who);
        (uint256 c, uint256 d,) = _vault(u);
        if (d == 0 || c == 0) return;
        // price at which the vault sits at 'depth_' percent of the liquidation ratio (50%..99%)
        uint256 pct = bound(depth_, 20, 99);
        uint256 target = vault.LIQ_RATIO_BPS() * pct / 100;
        uint256 pSyn = d * target / BPS * WAD / c; // SYNTH per TAC
        uint256 ethPerTac = pSyn * 1e8 / _answer();
        if (ethPerTac == 0) ethPerTac = 1;
        oracle.setAll(ethPerTac, 0);
        consistent = true;
        _hit("scenario_crash");
        vm.prank(outsider);
        try vault.liquidate(u) {
            _hit("scenario_liquidated");
        } catch {}
    }

    function scenarioRebound(uint256 p) external {
        oracle.setAll(bound(p, 8e13, 1.5e14), 0);
        consistent = true;
        _hit("scenario_rebound");
    }

    /// Donates a share of a vault's debt to the reserve, waits out the auction and absorbs.
    function scenarioDonateAndAbsorb(uint256 who, uint256 frac) external {
        address u = _u(who);
        (, uint256 d, uint256 s) = _vault(u);
        if (d == 0 || s == 0) return;
        uint256 want = d * bound(frac, 500, 12_000) / BPS;
        address donor = outsider;
        uint256 have = synth.balanceOf(donor);
        uint256 amt = FixedPointMathLib.min(want, have);
        if (amt != 0) {
            vm.prank(donor);
            synth.transfer(address(vault), amt);
            ghostReserve += amt;
        }
        skip(vault.AUCTION_DURATION());
        if (!fixedFeed) feed.set(feed.answer());
        _hit("scenario_donateAbsorb");
        _absorb(u);
    }

    function scenarioPartialBids(uint256 who, uint256 f1, uint256 f2) external {
        address u = _u(who);
        (,, uint256 s) = _vault(u);
        if (s == 0) return;
        skip(bound(f1, 0, vault.AUCTION_DURATION()));
        if (!fixedFeed) feed.set(feed.answer());
        _bid(u, outsider, 2 + f1 % 3, 0); // a quarter, a half or all but the minimum
        _bid(u, outsider, 1 + f2 % 3, 0);
        _bid(u, u, f2 % 2 == 0 ? 3 : 7, 0);
        _hit("scenario_partialBids");
    }
}

/// One vault on the campaign oracle; the variants below choose the feed (a dollar feed or a fixed 1.0 feed).
abstract contract TacVaultCampaignBase is Test {
    TacVault vault;
    TacSynth synth;
    TestTac tac;
    TacVaultCampaignOracle oracle;
    MockFeed feed;
    TacVaultCampaignHandler handler;
    uint256 mintedTac;

    function _ethMode() internal pure virtual returns (bool) {
        return false;
    }

    function _liqWindow() internal pure virtual returns (uint256) {
        return 6 hours;
    }

    function _tag() internal pure virtual returns (string memory) {
        return "usd";
    }

    function _ownerWindow() internal pure virtual returns (uint256) {
        return 1_200;
    }

    function _deploy(TacVault.Config memory c) internal virtual returns (TacVault) {
        return new TacVault(c);
    }

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        oracle = new TacVaultCampaignOracle();
        oracle.setDepth(2_000e18);
        bool eth = _ethMode();
        address feedAddr;
        if (eth) {
            feedAddr = address(new FixedFeed());
        } else {
            feed = new MockFeed();
            feed.set(4000e8);
            feedAddr = address(feed);
        }
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(oracle), feedAddr, address(0x0123));
        c.mintRatioBps = 35_000;
        c.liqRatioBps = 20_000;
        c.liqBonusBps = 2_500;
        c.auctionDuration = 5_400;
        c.ownerWindow = _ownerWindow();
        c.liqWindow = _liqWindow();
        c.borrowFeeBps = 100;
        c.redemptionFeeBps = 50;
        c.feedMaxStaleness = 3_900;
        c.depthBps = 500;
        c.minDebt = eth ? 0.04e18 : 100e18;
        c.debtCeiling = eth ? 1_000e18 : 2_000_000e18;
        vault = _deploy(c);
        synth = vault.SYNTH();
        handler = new TacVaultCampaignHandler(vault, tac, oracle, feedAddr, eth, _tag());
        handler.seed();

        bytes4[] memory sels = new bytes4[](47);
        uint256 i;
        sels[i++] = TacVaultCampaignHandler.movePrice.selector;
        sels[i++] = TacVaultCampaignHandler.crashPrice.selector;
        sels[i++] = TacVaultCampaignHandler.lagPrice.selector;
        sels[i++] = TacVaultCampaignHandler.setDepth.selector;
        sels[i++] = TacVaultCampaignHandler.setBreaks.selector;
        sels[i++] = TacVaultCampaignHandler.warp.selector;
        sels[i++] = TacVaultCampaignHandler.warpToAuctionEnd.selector;
        sels[i++] = TacVaultCampaignHandler.feedStale.selector;
        sels[i++] = TacVaultCampaignHandler.feedPrice.selector;
        sels[i++] = TacVaultCampaignHandler.setCeiling.selector;
        sels[i++] = TacVaultCampaignHandler.setFee.selector;
        sels[i++] = TacVaultCampaignHandler.ownerAbuse.selector;
        sels[i++] = TacVaultCampaignHandler.deposit.selector;
        sels[i++] = TacVaultCampaignHandler.depositFor.selector;
        sels[i++] = TacVaultCampaignHandler.borrow.selector;
        sels[i++] = TacVaultCampaignHandler.repay.selector;
        sels[i++] = TacVaultCampaignHandler.withdraw.selector;
        sels[i++] = TacVaultCampaignHandler.borrowFor.selector;
        sels[i++] = TacVaultCampaignHandler.withdrawFor.selector;
        sels[i++] = TacVaultCampaignHandler.useNonce.selector;
        sels[i++] = TacVaultCampaignHandler.multicallOpen.selector;
        sels[i++] = TacVaultCampaignHandler.liquidate.selector;
        sels[i++] = TacVaultCampaignHandler.cancel.selector;
        sels[i++] = TacVaultCampaignHandler.bid.selector;
        sels[i++] = TacVaultCampaignHandler.donateSynth.selector;
        sels[i++] = TacVaultCampaignHandler.donateTac.selector;
        sels[i++] = TacVaultCampaignHandler.giveSynth.selector;
        sels[i++] = TacVaultCampaignHandler.harvestFees.selector;
        sels[i++] = TacVaultCampaignHandler.absorb.selector;
        sels[i++] = TacVaultCampaignHandler.redeem.selector;
        sels[i++] = TacVaultCampaignHandler.scenarioCrashAndLiquidate.selector;
        sels[i++] = TacVaultCampaignHandler.scenarioCrashAndLiquidate.selector; // weighted
        sels[i++] = TacVaultCampaignHandler.scenarioRebound.selector;
        sels[i++] = TacVaultCampaignHandler.scenarioDonateAndAbsorb.selector;
        sels[i++] = TacVaultCampaignHandler.scenarioPartialBids.selector;
        sels[i++] = TacVaultCampaignHandler.scenarioPartialBids.selector; // weighted
        sels[i++] = TacVaultCampaignHandler.scenarioDonateAndAbsorb.selector; // weighted
        sels[i++] = TacVaultCampaignHandler.warp.selector; // weighted
        sels[i++] = TacVaultCampaignHandler.warpWindow.selector;
        sels[i++] = TacVaultCampaignHandler.warpWindow.selector; // weighted
        sels[i++] = TacVaultCampaignHandler.warpWindow.selector; // weighted
        sels[i++] = TacVaultCampaignHandler.govTerm.selector;
        sels[i++] = TacVaultCampaignHandler.govTerm.selector; // weighted
        sels[i++] = TacVaultCampaignHandler.govTerm.selector; // weighted
        sels[i++] = TacVaultCampaignHandler.govLowerDepth.selector;
        sels[i++] = TacVaultCampaignHandler.govRedemptionFee.selector;
        sels[i++] = TacVaultCampaignHandler.govOracle.selector;
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

    function invariant_noHandlerViolation() public view {
        assertEq(handler.violation(), 0, "a handler expectation failed (see violationData)");
    }

    /// Whatever the owner did, the terms still fit together as at deployment, and the oracle in place is the one the
    /// handler moves.
    function invariant_termsKeepTheirCrossConstraints() public view {
        uint256 liq = vault.LIQ_RATIO_BPS();
        uint256 mint = vault.MINT_RATIO_BPS();
        assertTrue(liq >= 10_000 && mint > liq && mint <= 100_000, "ratios");
        assertTrue(vault.LIQ_BONUS_BPS() != 0 && 10_000 + vault.LIQ_BONUS_BPS() < liq, "bonus");
        assertTrue(vault.AUCTION_DURATION() != 0 && vault.OWNER_WINDOW() < vault.AUCTION_DURATION(), "times");
        assertTrue(vault.MIN_DEBT() != 0, "minimum debt");
        assertLe(vault.DEPTH_BPS(), vault.MAX_DEPTH_BPS());
        assertLe(vault.REDEMPTION_FEE_BPS(), vault.MAX_REDEMPTION_FEE_BPS());
        assertEq(address(vault.ORACLE()), address(handler.oracle()));
    }

    function invariant_synthSupplyEqualsTotalDebt() public view {
        assertEq(synth.totalSupply(), vault.totalDebt());
    }

    function invariant_totalDebtIsTheSumOfVaultDebts() public view {
        (, uint256 debt) = _sums();
        assertEq(vault.totalDebt(), debt);
    }

    function invariant_heldTacIsCollateralPlusDonations() public view {
        (uint256 coll,) = _sums();
        assertEq(tac.balanceOf(address(vault)), coll + handler.donatedTac());
    }

    function invariant_reserveIsDonationsLessAbsorbed() public view {
        assertEq(synth.balanceOf(address(vault)), handler.ghostReserve());
    }

    function invariant_tacIsConserved() public view {
        uint256 sum = tac.balanceOf(address(vault)) + tac.balanceOf(address(0xdEaD)) + tac.balanceOf(handler.outsider())
            + tac.balanceOf(address(0xFEE));
        for (uint256 i; i < 3; ++i) {
            sum += tac.balanceOf(handler.users(i));
        }
        assertEq(sum, 15_000_000e18 + 5_000_000e18);
        assertEq(tac.totalSupply(), 20_000_000e18);
    }

    function invariant_noDustDebtAndAuctionsAreConsistent() public view {
        uint256 minD = vault.MIN_DEBT();
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            (uint256 c, uint256 d, uint256 s) = vault.vaults(u);
            assertTrue(d == 0 || d >= minD || d == handler.exemptDebt(u), "dust debt");
            assertTrue(d == 0 || c != 0, "debt without collateral");
            if (s != 0) {
                assertTrue(d != 0, "auction without debt");
                assertLe(s, block.timestamp);
            } else {
                assertEq(vault.onOffer(u), 0);
            }
            assertLe(vault.onOffer(u), c);
        }
    }

    /// A vault that has recovered is liquidation-healthy (so cancel and liquidate cannot ping-pong).
    function invariant_recoveredImpliesNotLiquidatable() public view {
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            (, uint256 d,) = vault.vaults(u);
            if (d == 0) continue;
            try vault.recovered(u) returns (bool rec) {
                if (rec) assertTrue(vault.liqHealthyView(u));
            } catch {}
        }
    }

    /// Whatever the oracle and the feed say, every vault can be repaid and emptied, and an owner in an auction can
    /// always bid and keep every TAC.
    function invariant_everyVaultCanBeClosedAndTheOwnerAlwaysRescues() public {
        for (uint256 i; i < 3; ++i) {
            address u = handler.users(i);
            (uint256 c, uint256 d, uint256 s) = vault.vaults(u);
            if (d == 0) continue;
            uint256 snap = vm.snapshotState();
            vm.prank(address(vault));
            synth.mint(u, d);
            uint256 tacBefore = tac.balanceOf(u) + c;
            if (s != 0 && i % 2 == 0) {
                vm.prank(u);
                vault.bid(u, type(uint256).max, 0);
            } else {
                vm.prank(u);
                vault.repay(u, type(uint256).max);
            }
            (uint256 c1, uint256 d1, uint256 s1) = vault.vaults(u);
            assertEq(d1, 0);
            assertEq(s1, 0);
            if (c1 != 0) {
                vm.prank(u);
                vault.withdraw(type(uint256).max);
            }
            assertEq(tac.balanceOf(u), tacBefore, "the owner got every TAC back");
            vm.revertToState(snap);
        }
    }

    // The path counters of the whole campaign (they live in the process environment, which outlives a run's state).
    // With TAC_VAULT_COVERAGE=<n> the run that completes the n-th run reverts with them as its message, so a passing
    // campaign shows nothing and a coverage run shows the counts.
    function afterInvariant() public {
        string memory runsName = string.concat("TVC_RUNS_", _tag());
        uint256 runs = vm.envOr(runsName, uint256(0)) + 1;
        vm.setEnv(runsName, vm.toString(runs));
        if (runs != vm.envOr("TAC_VAULT_COVERAGE", uint256(0))) return;
        string[] memory keys = vm.split(vm.envOr(string.concat("TVC_KEYS_", _tag()), string("")), ",");
        string memory text = string.concat("coverage after ", vm.toString(runs), " runs:");
        for (uint256 i = 1; i < keys.length; ++i) {
            text = string.concat(text, " ", keys[i], "=", vm.toString(vm.envOr(keys[i], uint256(0))));
        }
        revert(text);
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 100
/// forge-config: default.invariant.fail-on-revert = false
contract TacVaultCampaignUsd is TacVaultCampaignBase {}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 100
/// forge-config: default.invariant.fail-on-revert = false
contract TacVaultCampaignEth is TacVaultCampaignBase {
    function _ethMode() internal pure override returns (bool) {
        return true;
    }

    function _tag() internal pure override returns (string memory) {
        return "eth";
    }
}
