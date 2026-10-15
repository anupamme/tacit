// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TacVaultZap, IZapRouter} from "../src/TacVaultZap.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TestTac, MockOracle, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

// ───────────────────────────── mocks ─────────────────────────────

/// A venue for TacPairOracle whose medians and spot can be set apart (a trade moves the spot in a block; the medians
/// do not move).
contract R2Venue {
    uint256 public constant STEP = 50;
    uint256 public constant SHORT_WINDOW = 10 minutes;
    uint256 public constant WINDOW = 1 hours;
    uint256 public constant MAX_WINDOW = 4 hours;
    uint256 public px;
    uint256 public sp;

    constructor(uint256 p) {
        (px, sp) = (p, p);
    }

    function setSpot(uint256 s) external {
        sp = s;
    }

    function POOL() external view returns (address) {
        return address(this);
    }

    function prices(uint256) external view returns (uint256, uint256) {
        return (px, px);
    }

    function recovery(uint256) external view returns (uint256) {
        return px;
    }

    function depth(uint256) external pure returns (uint256) {
        return 1e30;
    }

    function depthMin(uint256) external pure returns (uint256) {
        return 1e30;
    }

    function latest() external view returns (uint256) {
        return px;
    }

    function spot() external view returns (uint256) {
        return sp;
    }
}

/// A replacement oracle with its own windows and independent low / high answers.
contract R2Oracle {
    uint256 public immutable SHORT_WINDOW;
    uint256 public immutable WINDOW;
    uint256 public immutable MAX_WINDOW;
    uint256 public lo;
    uint256 public hi;

    constructor(uint256 s, uint256 w, uint256 m, uint256 lo_, uint256 hi_) {
        (SHORT_WINDOW, WINDOW, MAX_WINDOW, lo, hi) = (s, w, m, lo_, hi_);
    }

    function prices(uint256) external view returns (uint256, uint256) {
        return (lo, hi);
    }

    function recovery(uint256) external view returns (uint256) {
        return lo;
    }

    function depthMin(uint256) external pure returns (uint256) {
        return 1e30;
    }

    function latest() external view returns (uint256) {
        return lo;
    }

    function spot() external view returns (uint256) {
        return lo;
    }
}

/// The oracle the deploy script builds, as the vault sees it: its default windows (2 h, 6 h, 8 h).
contract R2ScriptWindows {
    uint256 public constant SHORT_WINDOW = 7_200;
    uint256 public constant WINDOW = 21_600;
    uint256 public constant MAX_WINDOW = 28_800;
    uint256 public p = 1e14;

    function prices(uint256) external view returns (uint256, uint256) {
        return (p, p);
    }

    function recovery(uint256) external view returns (uint256) {
        return p;
    }

    function depthMin(uint256) external pure returns (uint256) {
        return 1e30;
    }

    function latest() external view returns (uint256) {
        return p;
    }

    function spot() external view returns (uint256) {
        return p;
    }
}

contract R2AcceptAll {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[11] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

interface IR2Pool {
    function ASSET_FIELD() external view returns (uint256);
    function head() external view returns (bytes32, uint256);
    function ASSET() external view returns (address);
}

interface IR2Router {
    function POOL() external view returns (address);
    function ASSET() external view returns (address);
    function ZROUTER() external view returns (address);
    function PERMIT2() external view returns (address);
    function V1() external view returns (address);
    function POSEIDON4() external view returns (address);
}

// ───────────────────────────── base ─────────────────────────────

contract R2Base is Test {
    uint256 constant P = 1e14; // 0.40 USD per TAC at 4,000 USD per ETH
    address constant OWNER = address(0x0123);

    TestTac tac;
    MockOracle oracle;
    MockFeed feed;
    TacVault vault;
    TacSynth dollar;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        oracle = new MockOracle();
        oracle.set(P);
        feed = new MockFeed();
        feed.set(4000e8);
        vault = new TacVault(VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER));
        dollar = vault.SYNTH();
        _fund(alice);
        _fund(bob);
        _fund(carol);
    }

    function _fund(address u) internal {
        tac.mint(u, 100_000_000e18);
        vm.startPrank(u);
        tac.approve(address(vault), type(uint256).max);
        dollar.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _wait(uint256 t) internal {
        skip(t);
        feed.set(4000e8);
    }

    function _open(address who, uint256 coll, uint256 debt) internal {
        vm.startPrank(who);
        vault.deposit(coll);
        vault.borrow(debt, 500);
        vm.stopPrank();
    }
}

// ───────────────────────────── review fixes ─────────────────────────────

contract TacVaultReviewFixesTest is R2Base {
    /// The oracle swap compares the new oracle only with the old one's medians, never its spot: with the real
    /// TacPairOracle, pushing one venue's spot down in the block the owner executes in does not let a mis-scaled
    /// (10x low) oracle in.
    function test_aSpotSandwichDoesNotLetAMisScaledOracleIn() public {
        R2Venue a = new R2Venue(P);
        R2Venue b = new R2Venue(P);
        TacPairOracle pair = new TacPairOracle(address(a), address(b));
        TacVault v = new TacVault(VaultConfig.defaults(address(tac), address(pair), address(feed), OWNER));
        R2Oracle slip = new R2Oracle(10 minutes, 1 hours, 4 hours, P / 10, P / 10);
        vm.prank(OWNER);
        v.queueOracle(address(slip));
        _wait(v.ORACLE_DELAY());
        a.setSpot(P * 3 / 10); // the front-run: one venue's spot at 0.3x for the block
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        v.executeOracle();
        assertEq(address(v.ORACLE()), address(pair));
    }

    /// The same on the vault's own MockOracle: a spot moved to 4x does not let a 10x-high oracle in while both
    /// medians say 1x.
    function test_aMovedSpotDoesNotWidenTheCheck() public {
        R2Oracle high = new R2Oracle(30 minutes, 2 hours, 8 hours, P * 10, P * 10);
        vm.prank(OWNER);
        vault.queueOracle(address(high));
        _wait(vault.ORACLE_DELAY());
        oracle.setPrices(P, P, P * 4);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.executeOracle();
    }

    /// A pauser's one-second pause holds the owner back for one second, not twelve hours, and a pause held away
    /// from the market can then be answered.
    function test_aOneSecondPauserPauseHoldsTheOwnerBackOneSecond() public {
        address pauser = address(0xBAD);
        vm.prank(OWNER);
        vault.setPauser(pauser);
        vm.prank(pauser);
        vault.pauseAuctions(1);
        _wait(1); // the pause is over
        vm.prank(OWNER);
        vm.expectRevert(TacVault.PauseCooldown.selector);
        vault.pauseAuctions(6 hours);
        _wait(1);
        vm.prank(OWNER);
        vault.pauseAuctions(6 hours);
        assertTrue(vault.paused());
    }

    /// Renouncing ownership removes the pauser, so nothing is left that can pause.
    function test_noPauserOutlivesARenouncedOwner() public {
        address pauser = address(0xBAD);
        vm.prank(OWNER);
        vault.setPauser(pauser);
        vm.prank(OWNER);
        vault.renounceOwnership();
        assertEq(vault.pauser(), address(0));
        vm.prank(pauser);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.pauseAuctions(12 hours);
    }

    /// A replacement whose low median is above its high median, or whose longest window is under an hour (the
    /// liquidation and depth window), is refused.
    function test_anOracleWithSwappedMediansOrShortWindowsIsRefused() public {
        R2Oracle swapped = new R2Oracle(30 minutes, 2 hours, 8 hours, P * 2, P);
        vm.prank(OWNER);
        vault.queueOracle(address(swapped));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.executeOracle();

        R2Oracle short = new R2Oracle(600, 600, 600, P, P);
        vm.prank(OWNER);
        vault.queueOracle(address(short));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.executeOracle();

        R2Oracle fine = new R2Oracle(30 minutes, 30 minutes, 1 hours, P, P);
        vm.prank(OWNER);
        vault.queueOracle(address(fine));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vault.executeOracle();
        assertEq(vault.LIQ_WINDOW(), 1 hours);
    }

    /// After `lockParams` the depth share can still be lowered at once and never raised again: a `lowerDepthBps(0)`
    /// after the lock ends lending for good (the ceiling is the stop that can be undone).
    function test_lowerDepthAfterLockIsForGood() public {
        vm.startPrank(OWNER);
        vault.lockParams();
        vault.lowerDepthBps(0);
        vm.expectRevert(TacVault.Locked.selector);
        vault.queueParam(TacVault.Param.DepthBps, 25);
        vm.stopPrank();
        assertEq(vault.depthCeiling(), 0);
    }
}

// ───────────────────────────── what holds ─────────────────────────────

contract TacVaultLaunchChecksTest is R2Base {
    /// The deploy script's defaults sit inside every governance rail (each can be re-announced as it is), and the
    /// vault accepts them with the oracle windows the script builds.
    function test_deployDefaultsSitInsideTheRails() public {
        R2ScriptWindows o = new R2ScriptWindows();
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(o), address(feed), OWNER);
        c.mintRatioBps = 35_000;
        c.liqRatioBps = 20_000;
        c.liqWindow = 28_800;
        c.liqBonusBps = 4_000;
        c.auctionDuration = 3_600;
        c.ownerWindow = 1_800;
        c.minDebt = 100e18;
        c.feedMaxStaleness = 3_900;
        c.debtCeiling = type(uint256).max;
        c.depthBps = 15;
        c.redemptionFeeBps = 50;
        c.borrowFeeBps = 100;
        TacVault v = new TacVault(c);
        uint256[7] memory now_ = [uint256(15), 35_000, 20_000, 4_000, 1_800, 3_600, 100e18];
        vm.startPrank(OWNER);
        for (uint256 i; i < 7; ++i) {
            v.queueParam(TacVault.Param(i), now_[i]);
        }
        vm.stopPrank();
        // The ETH vault's minimum (0.04 ETH) too.
        c.minDebt = 0.04e18;
        TacVault e = new TacVault(c);
        vm.prank(OWNER);
        e.queueParam(TacVault.Param.MinDebt, 0.04e18);
    }

    /// A vault whose debt is exactly the minimum is absorbed whole or not at all; one just above it is absorbed down
    /// to the minimum and no further.
    function test_absorbAtAndJustAboveTheMinimum() public {
        _open(alice, 15_000e18, 100e18); // exactly MIN_DEBT
        _open(carol, 15_000e18, 150e18);
        _open(bob, 1_000_000e18, 5_000e18);
        vm.prank(bob);
        dollar.transfer(address(vault), 99e18); // a reserve short of alice's debt
        oracle.set(P / 100);
        vault.liquidate(alice);
        vault.liquidate(carol);
        _wait(vault.AUCTION_DURATION());
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.absorb(alice);
        vault.absorb(carol); // 150 -> 100
        (, uint256 d,) = vault.vaults(carol);
        assertEq(d, 100e18);
        assertEq(dollar.balanceOf(address(vault)), 49e18);
        vm.prank(bob);
        dollar.transfer(address(vault), 51e18);
        vault.absorb(alice);
        (uint256 coll, uint256 debt, uint256 start) = vault.vaults(alice);
        assertEq(coll + debt + start, 0);
        assertEq(dollar.totalSupply(), vault.totalDebt());
    }

    /// The zap's IZapRouter is the router's ABI: the selectors are those of the router's own signatures, and a
    /// public-TAC -> shielded-dollar zap runs end to end through a router deployed exactly as the deploy script
    /// deploys it (same artifact names, same constructor tuple, the script's mainnet constants etched with code).
    function test_zapInterfaceMatchesTheRouterAndTheScriptsPoolArgs() public {
        assertEq(
            IZapRouter.completeDeposit.selector,
            bytes4(
                keccak256(
                    "completeDeposit((uint256,uint256,uint256,bytes32,bytes32,address,uint64,uint256),(uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes))"
                )
            )
        );
        assertEq(
            IZapRouter.depositBoxOf.selector,
            bytes4(keccak256("depositBoxOf((uint256,uint256,uint256,bytes32,bytes32,address,uint64,uint256))"))
        );
        assertEq(IZapRouter.ASSET.selector, bytes4(keccak256("ASSET()")));

        // The script's constants.
        address verifier = 0x000000b1c0e84CEc8AdF8278B90c4d6400DfB153;
        address zrouter = 0x000000000000FB114709235f1ccBFfb925F600e4;
        address permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        address v1 = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
        address poseidon4 = 0x555333f3f677Ca3930Bf7c56ffc75144c51D9767;
        vm.etch(verifier, address(new R2AcceptAll()).code);
        vm.etch(zrouter, hex"00");
        vm.etch(permit2, hex"00");
        vm.etch(v1, hex"00");
        vm.etch(poseidon4, hex"00");
        address pool = deployCode("TacitEvmPool.sol:TacitEvmPool", abi.encode(verifier, address(dollar)));
        address router =
            deployCode("TacitEvmPoolRouter.sol:TacitEvmPoolRouter", abi.encode(pool, zrouter, permit2, v1, poseidon4));
        assertEq(IR2Pool(pool).ASSET(), address(dollar));
        assertEq(IR2Router(router).POOL(), pool);
        assertEq(IR2Router(router).ASSET(), address(dollar));
        assertEq(IR2Router(router).ZROUTER(), zrouter);
        assertEq(IR2Router(router).PERMIT2(), permit2);
        assertEq(IR2Router(router).V1(), v1);
        assertEq(IR2Router(router).POSEIDON4(), poseidon4);
        TacVaultZap zap = new TacVaultZap(address(vault), router);

        uint256 key = 0xA11CE5;
        address owner = vm.addr(key);
        IZapRouter.DepositIntent memory intent = IZapRouter.DepositIntent({
            amount: 2_000e18,
            outLeaf0: 21,
            outLeaf1: 0,
            memo0Hash: keccak256(""),
            memo1Hash: keccak256(""),
            refund: alice,
            deadline: uint64(vm.getBlockTimestamp() + 1 days),
            nonce: 21
        });
        address box = IZapRouter(router).depositBoxOf(intent);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 sh = keccak256(
            abi.encode(vault.BORROW(), owner, intent.amount, uint256(0), uint256(15_000e18), box, uint256(0), deadline)
        );
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(key, vault.digest(sh));
        bytes memory sig = abi.encodePacked(sr, ss, sv);
        IZapRouter.Tx memory t = _tx(pool, int256(intent.amount), 21);
        vm.startPrank(alice);
        tac.approve(address(zap), 15_000e18);
        zap.mintShielded(owner, 15_000e18, 0, 15_000e18, deadline, sig, intent, t);
        vm.stopPrank();
        assertEq(dollar.balanceOf(pool), 2_000e18, "the dollars are in the pool");
        (uint256 coll, uint256 debt,) = vault.vaults(owner);
        assertEq(coll, 15_000e18);
        assertEq(debt, 2_000e18);
        assertEq(tac.balanceOf(address(zap)) + dollar.balanceOf(address(zap)), 0);
    }

    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function _tx(address pool, int256 extAmount, uint256 out0) internal view returns (IZapRouter.Tx memory t) {
        (bytes32 root, uint256 size) = IR2Pool(pool).head();
        t.extAmount = extAmount;
        t.publicInputs[0] = uint256(root);
        t.publicInputs[1] = uint256(root);
        t.publicInputs[2] = uint256(keccak256(abi.encode(root, out0, uint256(0), uint256(1)))) % FIELD;
        t.publicInputs[3] = size;
        t.publicInputs[4] = uint256(extAmount);
        t.publicInputs[5] = uint256(
            keccak256(
                abi.encode(
                    block.chainid, pool, address(0), extAmount, address(0), uint256(0), keccak256(""), keccak256("")
                )
            )
        ) % FIELD;
        t.publicInputs[6] = IR2Pool(pool).ASSET_FIELD();
        t.publicInputs[9] = out0;
    }

    /// The synth's minter rights cannot be reached early or kept after a lock: a re-announced minter restarts the
    /// wait, and the owner read live is the only one who can act.
    function test_minterReannouncementRestartsTheWait() public {
        address m = address(new R2AcceptAll());
        vm.prank(OWNER);
        dollar.queueMinter(m);
        _wait(dollar.MINTER_DELAY() - 1);
        vm.prank(OWNER);
        dollar.queueMinter(m); // announced again: the wait starts over
        _wait(1);
        vm.prank(OWNER);
        vm.expectRevert(TacSynth.TooEarly.selector);
        dollar.executeMinter();
    }
}

// ───────────────────────────── a random walk over users, auctions and terms ─────────────────────────────

/// Users borrow, repay, withdraw, are liquidated, bid on, absorbed and redeemed against while the owner changes the
/// terms (minimum debt, ratios, bonus, auction length, owner window, depth, fees) and pauses. After every step:
/// the synth's supply is the vault's total debt, the vaults' debts sum to it, their TAC sums to the vault's balance,
/// no auction runs on a vault without debt, and every successful action leaves the vault it touched with zero debt or
/// at least the minimum then in force.
contract TacVaultLaunchWalk is R2Base {
    address constant LIQ = address(0x11D);
    address[3] users;
    uint256 okBid;
    uint256 okAbsorb;
    uint256 okRedeem;
    uint256 okGov;
    uint256 okRepay;
    uint256 okBorrow;
    uint256 okLiq;
    bytes4 lastBidErr;
    bytes4 lastBorrowErr;
    mapping(bytes4 => uint256) borrowErrs;
    mapping(bytes4 => uint256) bidErrs;

    function setUp() public override {
        super.setUp();
        users = [alice, bob, carol];
        vm.startPrank(OWNER);
        vault.setDebtCeiling(type(uint256).max);
        vault.setBorrowFee(100);
        vm.stopPrank();
        _fund(LIQ);
        _open(LIQ, 100_000_000e18, 60_000e18);
    }

    function _checkTouched(address u) internal view {
        (, uint256 d,) = vault.vaults(u);
        assertTrue(d == 0 || d >= vault.MIN_DEBT(), "an action left debt under the minimum");
    }

    function _invariants() internal view {
        address[4] memory all = [alice, bob, carol, LIQ];
        uint256 sumD;
        uint256 sumC;
        for (uint256 i; i < 4; ++i) {
            (uint256 c, uint256 d, uint256 s) = vault.vaults(all[i]);
            sumD += d;
            sumC += c;
            if (s != 0) assertGt(d, 0, "an auction on a vault without debt");
        }
        assertEq(sumD, vault.totalDebt(), "debts do not sum to totalDebt");
        assertEq(dollar.totalSupply(), vault.totalDebt(), "supply is not totalDebt");
        assertEq(sumC, tac.balanceOf(address(vault)), "collateral does not sum to the vault's TAC");
    }

    function _gov(uint256 r) internal {
        TacVault.Param id = TacVault.Param((r >> 8) % 7);
        uint256 x = r >> 16;
        uint256 v;
        if (id == TacVault.Param.DepthBps) v = 2 * vault.DEPTH_BPS() + 25 - x % 50;
        else if (id == TacVault.Param.MintRatioBps) v = 20_000 + x % 40_000;
        else if (id == TacVault.Param.LiqRatioBps) v = 12_000 + x % 18_001;
        else if (id == TacVault.Param.LiqBonusBps) v = 1 + x % 5_000;
        else if (id == TacVault.Param.OwnerWindow) v = 10 minutes + x % 3 hours;
        else if (id == TacVault.Param.AuctionDuration) v = 30 minutes + x % 6 hours;
        else v = 10e18 + x % 2_000e18;
        vm.prank(OWNER);
        try vault.queueParam(id, v) {
            _wait(2 days);
            vm.prank(OWNER);
            try vault.executeParam(id) {
                ++okGov;
            } catch {}
        } catch {}
    }

    function _step(uint256 r) internal {
        // The liquidator keeps dollars to bid, repay, redeem and donate with (borrowed, so supply stays debt).
        if (dollar.balanceOf(LIQ) < 20_000e18) {
            tac.mint(LIQ, 200_000_000e18);
            vm.startPrank(LIQ);
            vault.deposit(200_000_000e18);
            try vault.borrow(40_000e18, 500) {} catch {}
            vm.stopPrank();
        }
        address u = users[(r >> 4) % 3];
        uint256 op = r % 13;
        uint256 x = r >> 32;
        if (op == 0) {
            vm.prank(u);
            try vault.deposit(1e18 + x % 6_000e18) {} catch {}
        } else if (op == 1) {
            vm.prank(u);
            vault.deposit(1e18 + x % 20_000e18);
            (uint256 c0, uint256 d0,) = vault.vaults(u);
            uint256 room = vault.valueOf(c0, true) * 10_000 / vault.MINT_RATIO_BPS();
            room = room > d0 ? (room - d0) * (50 + (x >> 64) % 49) / 100 : 1;
            vm.prank(u);
            try vault.borrow(room, 500) {
                ++okBorrow;
                _checkTouched(u);
            } catch (bytes memory err) {
                lastBorrowErr = bytes4(err);
                ++borrowErrs[bytes4(err)];
            }
        } else if (op == 2) {
            (, uint256 d,) = vault.vaults(u);
            uint256 amt = x % 2 == 0 ? type(uint256).max : (d == 0 ? 1 : x % d + 1);
            address payer = x % 3 == 0 ? LIQ : u;
            if (payer == u && dollar.balanceOf(u) < (amt > d ? d : amt)) payer = LIQ;
            vm.prank(payer);
            try vault.repay(u, amt) {
                ++okRepay;
                _checkTouched(u);
            } catch {}
        } else if (op == 3) {
            vm.prank(u);
            try vault.withdraw(x % 60_000e18 + 1) {} catch {}
        } else if (op == 4) {
            oracle.set(P * (5 + x % 196) / 100);
        } else if (op == 5) {
            try vault.liquidate(u) {
                ++okLiq;
            } catch {}
        } else if (op == 6) {
            for (uint256 k; k < 3; ++k) {
                (,, uint256 st) = vault.vaults(users[k]);
                if (st != 0) {
                    u = users[k];
                    if (vm.getBlockTimestamp() < st + vault.OWNER_WINDOW()) _wait(vault.OWNER_WINDOW());
                    break;
                }
            }
            (, uint256 d,) = vault.vaults(u);
            uint256 amt = x % 2 == 0 ? type(uint256).max : (d == 0 ? 1 : x % d + 1);
            vm.prank(LIQ);
            try vault.bid(u, amt, 0) {
                ++okBid;
                _checkTouched(u);
            } catch (bytes memory err) {
                lastBidErr = bytes4(err);
                ++bidErrs[bytes4(err)];
            }
        } else if (op == 7) {
            for (uint256 k; k < 3; ++k) {
                (,, uint256 st) = vault.vaults(users[k]);
                if (st != 0) {
                    u = users[k];
                    if (x % 3 != 0) oracle.set(P * (1 + (x >> 40) % 25) / 100);
                    if (vm.getBlockTimestamp() < st + vault.AUCTION_DURATION()) _wait(vault.AUCTION_DURATION());
                    break;
                }
            }
            uint256 give = x % 1_500e18;
            if (x % 2 == 0 && dollar.balanceOf(LIQ) >= give) {
                vm.prank(LIQ);
                dollar.transfer(address(vault), give);
            }
            try vault.absorb(u) {
                ++okAbsorb;
                _checkTouched(u);
            } catch {}
        } else if (op == 8) {
            (, uint256 d,) = vault.vaults(u);
            uint256 amt = x % 2 == 0 ? d : (d == 0 ? 1 : x % d + 1);
            vm.prank(LIQ);
            try vault.redeem(u, amt, 0) {
                ++okRedeem;
                _checkTouched(u);
            } catch {}
        } else if (op == 9) {
            _wait(x % 3 hours + 1);
        } else if (op == 10) {
            if (x % 3 == 0) _gov(r);
            else _wait(x % 40 minutes + 1);
        } else if (op == 11) {
            vm.startPrank(OWNER);
            if (x % 3 == 0) {
                try vault.setRedemptionFee(x % 251) {} catch {}
            } else if (x % 3 == 1) {
                if ((x >> 8) % 4 == 0) try vault.lowerDepthBps(50 + (x >> 16) % 950) {} catch {}
            } else if (x % 5 == 2) {
                try vault.pauseAuctions(1 + (x >> 8) % 3 hours) {} catch {}
            }
            vm.stopPrank();
        } else {
            try vault.cancel(u) {} catch {}
        }
        _invariants();
    }

    function _run(uint256 seed) internal {
        for (uint256 i; i < 150; ++i) {
            _step(uint256(keccak256(abi.encode(seed, i))));
        }
    }

    function test_walkCoverage() public {
        for (uint256 j = 1; j <= 25; ++j) {
            _run(j * 104_729);
        }
        emit log_named_uint("borrow", okBorrow);
        emit log_named_uint("repay", okRepay);
        emit log_named_uint("bid", okBid);
        emit log_named_uint("absorb", okAbsorb);
        emit log_named_uint("redeem", okRedeem);
        emit log_named_uint("governed changes", okGov);
        emit log_named_uint("liquidate", okLiq);
        emit log_named_bytes32("last bid error", bytes32(lastBidErr));
        emit log_named_bytes32("last borrow error", bytes32(lastBorrowErr));
        emit log_named_uint("borrow Undercollateralized", borrowErrs[TacVault.Undercollateralized.selector]);
        emit log_named_uint("borrow OverCeiling", borrowErrs[TacVault.OverCeiling.selector]);
        emit log_named_uint("borrow BadAmount", borrowErrs[TacVault.BadAmount.selector]);
        emit log_named_uint("borrow InAuction", borrowErrs[TacVault.InAuction.selector]);
        emit log_named_uint("borrow StaleFeed", borrowErrs[TacVault.StaleFeed.selector]);
        emit log_named_uint("bid NoAuction", bidErrs[TacVault.NoAuction.selector]);
        emit log_named_uint("bid Healthy", bidErrs[TacVault.Healthy.selector]);
        emit log_named_uint("bid BadAmount", bidErrs[TacVault.BadAmount.selector]);
        emit log_named_uint("bid Paused", bidErrs[TacVault.Paused.selector]);
        emit log_named_uint("bid OwnerWindow", bidErrs[TacVault.OwnerWindow.selector]);
        assertGt(okBid, 5);
        assertGt(okAbsorb, 0);
        assertGt(okRedeem, 0);
        assertGt(okGov, 5);
    }

    function testFuzz_walk(uint256 seed) public {
        _run(seed);
    }
}
