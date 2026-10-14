// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {MockPrecision} from "./MockPrecision.sol";
import {TestTac} from "./TacVaultMocks.sol";
import {TacSystemBase, TacSystemMockV1} from "./TacSystem.t.sol";

// Random sequences over the whole deployed shape: the pair oracle over two venues, ring writes, live prices, keeper
// outages and restorations, the owner window, the offer floor, partial bids that end auctions, absorb and redeem.
// Checked at every successful call:
//   - an outsider's bid succeeds only after the owner window, with an offer price, on a vault that has not recovered;
//   - no bid takes more TAC than its share of the collateral or than the Dutch schedule at the offer price;
//   - a redemption never lowers the vault's ratio at the liquidation view;
//   - the live price never moves the offer view;
//   - new debt only follows a complete window of depth samples on both venues;
//   - supply equals total debt, the vault holds exactly the collateral it owes, an auction always has debt.
//
// The committed defaults are 64 runs of depth 120 (the `forge-config` lines on the invariants below). For a long
// campaign raise them to 500 runs of depth 250 and run
//   forge test --match-path test/TacSystemInvariant.t.sol --match-test invariant_
/// The handler: every action tolerates failure, and the checks run inside the actions that succeed.
contract TacSystemHandler is Test {
    uint256 constant STEP = 50;
    uint256 constant P0 = 9.35e13;
    uint256 constant ETH_USD = 2500;

    TacVault public vault;
    TestTac public tac;
    TacSynth public synth;
    TacBlockOracle public precision;
    TacAmmOracle public amm;
    MockPrecision public prec;
    TacSystemMockV1 public v1;
    address[3] public users;

    uint256 public spotP = P0;
    uint256 public spotA = P0;
    bool public violated;
    string public why;
    uint256 public nOpen;
    uint256 public nLiquidate;
    uint256 public nBidOwner;
    uint256 public nBidOther;
    uint256 public nAuctionEnded;
    uint256 public nAbsorb;
    uint256 public nRedeem;
    uint256 public nCancel;

    constructor(
        TacVault vault_,
        TestTac tac_,
        TacBlockOracle p_,
        TacAmmOracle a_,
        MockPrecision prec_,
        TacSystemMockV1 v1_,
        address[3] memory users_
    ) {
        vault = vault_;
        tac = tac_;
        synth = vault_.SYNTH();
        precision = p_;
        amm = a_;
        prec = prec_;
        v1 = v1_;
        users = users_;
    }

    function _fail(string memory s) internal {
        violated = true;
        why = s;
    }

    function _newest() internal view returns (uint256) {
        return (block.number - 1 - 10) / STEP - 1;
    }

    function _put(TacIntervalOracle o, uint256 interval, uint256 price) internal {
        vm.store(address(o), bytes32(interval % 128), bytes32(interval << 208 | price << 104 | uint256(1e22)));
    }

    function _setSpots() internal {
        uint256 virtEth = uint256(3e20) * 1e18 / 3.78e21;
        uint256 virtTac = uint256(3e20) * 3.78e18 / 1e18;
        uint256 r1 = 3e22;
        prec.setReserves(uint128(spotP * (virtTac + r1) / 1e18 - virtEth), uint128(r1));
        v1.setReserves(spotA * 2e12 / 1e18, 2e12);
    }

    // ── the market ──

    /// The newest `k` intervals and the live price of the chosen venues move to a price between 0.15x and 2.5x.
    function move(uint256 k, uint256 pSeed, uint256 mode) external {
        k = bound(k, 1, 36);
        uint256 price = P0 * bound(pSeed, 15, 250) / 100;
        mode = mode % 3;
        uint256 newest = _newest();
        for (uint256 i; i < k; ++i) {
            if (mode != 2) _put(precision, newest - i, price);
            if (mode != 1) _put(amm, newest - i, price);
        }
        if (mode != 2) spotP = price;
        if (mode != 1) spotA = price;
        _setSpots();
    }

    /// A keeper outage: blocks and time pass, nothing is recorded.
    function outage(uint256 n) external {
        n = bound(n, 1, 40);
        vm.roll(block.number + n * STEP);
        vm.warp(block.timestamp + n * 600);
    }

    /// The keeper is back: the newest `m` intervals are recorded at today's live prices.
    function restore(uint256 m) external {
        m = bound(m, 1, 36);
        uint256 newest = _newest();
        for (uint256 i; i < m; ++i) {
            _put(precision, newest - i, spotP);
            _put(amm, newest - i, spotA);
        }
    }

    function wait(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 3_000));
        vm.roll(block.number + bound(s, 1, 3_000) / 12);
    }

    // ── users ──

    /// Deposits and borrows a share of what the borrow view allows, so that a fall can reach the liquidation line.
    function open(uint256 a, uint256 coll, uint256 shareSeed) external {
        address u = users[a % 3];
        coll = bound(coll, 20_000e18, 300_000e18);
        vm.startPrank(u);
        try vault.deposit(coll) {} catch {}
        vm.stopPrank();
        (uint256 c, uint256 d,) = vault.vaults(u);
        uint256 room;
        try vault.valueOf(c, true) returns (uint256 v) {
            uint256 max = v * 10_000 / 35_000;
            room = max > d ? (max - d) * 99 / 100 : 0;
        } catch {
            return;
        }
        uint256 amount = room * bound(shareSeed, 85, 100) / 100;
        if (amount < 100e18) return;
        vm.startPrank(u);
        try vault.borrow(amount, 100) {
            ++nOpen;
            // new debt only ever follows a complete window of depth samples on both venues
            try precision.depthMin(21_600) returns (uint256) {}
            catch {
                _fail("borrowed without every interval recorded on the Precision venue");
            }
            try amm.depthMin(21_600) returns (uint256) {}
            catch {
                _fail("borrowed without every interval recorded on the AMM venue");
            }
        } catch {}
        vm.stopPrank();
    }

    /// The live price of both venues jumps anywhere: neither the offer view nor the redemption price may notice.
    function push(uint256 pSeedA, uint256 pSeedB) external {
        uint256 before_;
        try vault.offerPrice() returns (uint256 p) {
            before_ = p;
        } catch {
            return;
        }
        uint256 oldP = spotP;
        uint256 oldA = spotA;
        spotP = P0 * bound(pSeedA, 5, 400) / 100;
        spotA = P0 * bound(pSeedB, 5, 400) / 100;
        _setSpots();
        try vault.offerPrice() returns (uint256 p2) {
            if (p2 != before_) _fail("the live price moved the offer view");
        } catch {
            _fail("the live price broke the offer view");
        }
        spotP = oldP;
        spotA = oldA;
        _setSpots();
    }

    /// A sustained move of both venues to a price between 0.15x and 0.6x, history and live.
    function crash(uint256 pSeed) external {
        uint256 price = P0 * bound(pSeed, 15, 60) / 100;
        uint256 newest = _newest();
        for (uint256 i; i < 36; ++i) {
            _put(precision, newest - i, price);
            _put(amm, newest - i, price);
        }
        spotP = price;
        spotA = price;
        _setSpots();
    }

    function liquidateAll() external {
        for (uint256 i; i < 3; ++i) {
            try vault.liquidate(users[i]) {
                ++nLiquidate;
            } catch {}
        }
    }

    /// The clock moves to one of the moments that matter in an auction.
    function waitFor(uint256 which) external {
        uint256[5] memory t = [uint256(1), 1_199, 1_200, 2_700, 5_400];
        uint256 s = t[which % 5];
        vm.warp(block.timestamp + s);
        vm.roll(block.number + s / 12 + 1);
    }

    function deposit(uint256 a, uint256 amt) external {
        vm.prank(users[a % 3]);
        try vault.deposit(bound(amt, 1e18, 200_000e18)) {} catch {}
    }

    function repay(uint256 a, uint256 b, uint256 amt) external {
        (, uint256 d,) = vault.vaults(users[a % 3]);
        vm.prank(users[b % 3]);
        try vault.repay(users[a % 3], bound(amt, 0, d)) {} catch {}
    }

    function donate(uint256 a, uint256 amt) external {
        address u = users[a % 3];
        uint256 bal = synth.balanceOf(u);
        if (bal == 0) return;
        vm.prank(u);
        synth.transfer(address(vault), bound(amt, 1, bal));
    }

    function liquidate(uint256 a) external {
        vm.prank(users[(a + 1) % 3]);
        try vault.liquidate(users[a % 3]) {
            ++nLiquidate;
        } catch {}
    }

    function cancel(uint256 a) external {
        try vault.cancel(users[a % 3]) {
            ++nCancel;
        } catch {}
    }

    function absorb(uint256 a) external {
        try vault.absorb(users[a % 3]) {
            ++nAbsorb;
        } catch {}
    }

    function bid(uint256 a, uint256 b, uint256 amtSeed) external {
        address owner = users[a % 3];
        address bidder = users[b % 3];
        (uint256 c, uint256 d, uint256 s) = vault.vaults(owner);
        if (s == 0 || d == 0) return;
        uint256 amount = bound(amtSeed, 1, d * 11 / 10);
        uint256 eff = amount > d ? d : amount;
        bool priced = true;
        uint256 offerP;
        try vault.offerPrice() returns (uint256 p) {
            offerP = p;
        } catch {
            priced = false;
        }
        bool recovered_;
        bool recoveredKnown = true;
        try vault.recovered(owner) returns (bool r) {
            recovered_ = r;
        } catch {
            recoveredKnown = false;
        }
        uint256 elapsed = block.timestamp - s;
        uint256 bonus = 2_500 * (elapsed > 5_400 ? 5_400 : elapsed) / 5_400;
        bool other = bidder != owner;

        vm.prank(bidder);
        try vault.bid(owner, amount, 0) returns (uint256 taken) {
            if (other) {
                ++nBidOther;
                if (elapsed < vault.OWNER_WINDOW()) _fail("an outside bid inside the owner window");
                if (!priced) _fail("an outside bid without an offer price");
                if (!recoveredKnown) _fail("an outside bid without a recovery price");
                if (recovered_) _fail("an outside bid on a recovered vault");
            } else {
                ++nBidOwner;
            }
            if (taken > c * eff / d) _fail("bid took more than its share of the collateral");
            if (priced && taken * offerP / 1e18 > eff * (10_000 + bonus) / 10_000 + 3) {
                _fail("bid took more than the schedule");
            }
            if (!priced && taken != c * eff / d) _fail("an unpriced owner bid was not pro rata");
            (, uint256 d1, uint256 s1) = vault.vaults(owner);
            if (d1 == 0 && s1 != 0) _fail("auction left running with no debt");
            if (s1 == 0) ++nAuctionEnded;
        } catch {}
    }

    function redeem(uint256 a, uint256 b, uint256 amtSeed) external {
        address owner = users[a % 3];
        (uint256 c0, uint256 d0, uint256 s0) = vault.vaults(owner);
        if (d0 == 0 || s0 != 0) return;
        uint256 amount = bound(amtSeed, 1, d0);
        uint256 v0;
        try vault.valueOf(c0, false) returns (uint256 v) {
            v0 = v;
        } catch {
            return;
        }
        vm.prank(users[b % 3]);
        try vault.redeem(owner, amount, 0) {
            ++nRedeem;
            (uint256 c1, uint256 d1,) = vault.vaults(owner);
            uint256 v1_ = vault.valueOf(c1, false);
            if (d1 != 0 && v1_ * d0 < v0 * d1) _fail("a redemption lowered the vault's ratio at the liquidation view");
        } catch {}
    }
}

contract TacSystemInvariantTest is TacSystemBase {
    TacSystemHandler handler;

    function setUp() public override {
        super.setUp();
        _market(P0);
        handler = new TacSystemHandler(vault, tac, precision, amm, prec, v1, [alice, bob, carol]);
        bytes4[] memory sels = new bytes4[](24);
        sels[0] = TacSystemHandler.move.selector;
        sels[1] = TacSystemHandler.outage.selector;
        sels[2] = TacSystemHandler.restore.selector;
        sels[3] = TacSystemHandler.wait.selector;
        sels[4] = TacSystemHandler.open.selector;
        sels[5] = TacSystemHandler.deposit.selector;
        sels[6] = TacSystemHandler.repay.selector;
        sels[7] = TacSystemHandler.donate.selector;
        sels[8] = TacSystemHandler.liquidate.selector;
        sels[9] = TacSystemHandler.cancel.selector;
        sels[10] = TacSystemHandler.absorb.selector;
        sels[11] = TacSystemHandler.bid.selector;
        sels[12] = TacSystemHandler.redeem.selector;
        sels[13] = TacSystemHandler.open.selector;
        sels[14] = TacSystemHandler.crash.selector;
        sels[15] = TacSystemHandler.liquidateAll.selector;
        sels[16] = TacSystemHandler.waitFor.selector;
        sels[17] = TacSystemHandler.bid.selector;
        sels[18] = TacSystemHandler.waitFor.selector;
        sels[19] = TacSystemHandler.liquidateAll.selector;
        sels[20] = TacSystemHandler.bid.selector;
        sels[21] = TacSystemHandler.absorb.selector;
        sels[22] = TacSystemHandler.push.selector;
        sels[23] = TacSystemHandler.push.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_supplyEqualsDebt() public view {
        assertEq(synth.totalSupply(), vault.totalDebt());
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_vaultHoldsExactlyTheCollateral() public view {
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            (uint256 c,,) = vault.vaults(handler.users(i));
            sum += c;
        }
        assertEq(tac.balanceOf(address(vault)), sum);
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_anAuctionAlwaysHasDebt() public view {
        for (uint256 i; i < 3; ++i) {
            (, uint256 d, uint256 s) = vault.vaults(handler.users(i));
            if (s != 0) assertGt(d, 0);
        }
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_everyCheckedPropertyHolds() public view {
        assertFalse(handler.violated(), handler.why());
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 120
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_callCounts() public view {
        console2.log("opens", handler.nOpen());
        console2.log("liquidations", handler.nLiquidate());
        console2.log("bids by owners / by others", handler.nBidOwner(), handler.nBidOther());
        console2.log("auctions ended by bids", handler.nAuctionEnded());
        console2.log("absorbs", handler.nAbsorb());
        console2.log("redeems", handler.nRedeem());
        console2.log("cancels", handler.nCancel());
    }

    /// The handler's checks are live: one scripted run reaches every kind of event the invariants watch.
    function test_theHandlerReachesLiquidationBidsAbsorbAndRedemption() public {
        for (uint256 i; i < 3; ++i) {
            handler.open(i, 100_000e18, 100);
        }
        assertEq(handler.nOpen(), 3);
        handler.redeem(0, 2, 150e18); // a fresh vault is between the lines: redeemable
        assertEq(handler.nRedeem(), 1);
        handler.crash(40); // 0.4x: far under the 200% line
        handler.liquidateAll();
        assertEq(handler.nLiquidate(), 3);
        handler.bid(0, 1, 1_000e18); // inside the owner window: refused
        assertEq(handler.nBidOther(), 0);
        handler.bid(0, 0, 500e18); // the owner may
        assertEq(handler.nBidOwner(), 1);
        handler.waitFor(2); // 1,200 s
        handler.bid(1, 2, 1_500e18); // an outsider's partial bid after the window
        assertEq(handler.nBidOther(), 1);
        handler.donate(2, 1_000e18);
        handler.waitFor(4); // past the auction
        handler.crash(15); // under water at the liquidation view
        handler.absorb(1);
        handler.absorb(2);
        assertFalse(handler.violated(), handler.why());
        assertGt(handler.nAbsorb(), 0);
    }
}
