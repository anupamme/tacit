// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {MockPrecision} from "./MockPrecision.sol";
import {TestTac, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

/// Stands in for the confidential pool's `pools` / `assets` reads (spot and the constructor).
contract GasV1 {
    bytes32 constant ETH_ASSET = bytes32(uint256(0xE7));
    bytes32 constant TAC_ASSET = bytes32(uint256(0x7AC));
    bytes32 public constant POOL_ID = bytes32(uint256(0x9001));
    address immutable TAC;
    uint256 public rA;
    uint256 public rB;

    constructor(address tac, uint256 a, uint256 b) {
        (TAC, rA, rB) = (tac, a, b);
    }

    function set(uint256 a, uint256 b) external {
        (rA, rB) = (a, b);
    }

    function pools(bytes32 id) external view returns (bool, bytes32, bytes32, uint256, uint256, uint32, uint256) {
        return (id == POOL_ID, ETH_ASSET, TAC_ASSET, rA, rB, 30, 1);
    }

    function assets(bytes32 id) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        if (id == ETH_ASSET) return (true, address(0), 1e10, bytes32(0), false, 18);
        if (id == TAC_ASSET) return (true, TAC, 1e10, bytes32(0), false, 18);
        return (false, address(0), 0, bytes32(0), false, 0);
    }
}

/// Gas bounds for the oracle views and every vault entry point, with the real pair oracle over the real two venue
/// contracts (their rings filled to the 36 intervals of the launch MAX_WINDOW, in the order the insertion sort likes
/// least) behind a real vault. Each call is bounded (generously, and every vault call stays under 3M gas). The bounds
/// hold with or without `--isolate`; run with `FOUNDRY_ISOLATE=true forge test --match-path test/TacGasBounds.t.sol -vv`
/// to print transaction-accurate figures.
contract TacGasBoundsTest is Test {
    uint256 constant STEP = 50;
    uint256 constant BN = 26_000_061;
    uint256 constant POINTS = 36;
    uint256 constant CEILING_GAS = 3_000_000;

    TestTac tac;
    MockPrecision precisionPool;
    GasV1 v1;
    TacBlockOracle precision;
    TacAmmOracle amm;
    TacPairOracle pair;
    MockFeed feed;
    TacVault vault;
    TacSynth dollar;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 newest;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(BN);
        tac = new TestTac();
        precisionPool = new MockPrecision(
            address(tac),
            3779257685557097674,
            3779257685557097674402,
            311597728428336321792,
            3012897949528752945,
            31940071679845627500747
        );
        v1 = new GasV1(address(tac), 0xcc7510f, 0x2188a791ef0);
        precision = new TacBlockOracle(address(precisionPool), address(tac), STEP, 3_600, 10_800, 21_600, 6_600);
        amm = new TacAmmOracle(
            address(v1),
            v1.POOL_ID(),
            bytes32(uint256(0xE7)),
            bytes32(uint256(0x7AC)),
            address(tac),
            74,
            STEP,
            3_600,
            10_800,
            21_600,
            6_600
        );
        pair = new TacPairOracle(address(precision), address(amm));
        newest = (BN - 1 - 10) / STEP - 1;
        _setRings(9.3e13, 1e24);
        feed = new MockFeed();
        feed.set(4000e8);
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(pair), address(feed), address(0x0123));
        c.mintRatioBps = 35_000;
        c.liqRatioBps = 20_000;
        c.liqBonusBps = 2_500;
        c.liqWindow = 21_600;
        c.auctionDuration = 5_400;
        c.borrowFeeBps = 100;
        c.redemptionFeeBps = 50;
        c.depthBps = 500;
        c.debtCeiling = type(uint128).max;
        c.feedMaxStaleness = 3_900;
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

    // Every interval of the window recorded, the newest the dearest so the oldest-first scan is a descending array:
    // the worst case for the insertion sort, with all 36 values distinct.
    function _setRings(uint256 price, uint256 depth) internal {
        for (uint256 i; i < POINTS + 4; ++i) {
            uint256 j = newest - i;
            uint256 pA = price + (POINTS + 4 - i) * 1e9;
            uint256 pB = price + (POINTS + 4 - i) * 1e9 + 7;
            vm.store(address(precision), bytes32(j % 128), bytes32(j << 208 | pA << 104 | depth));
            vm.store(address(amm), bytes32(j % 128), bytes32(j << 208 | pB << 104 | depth));
        }
    }

    function _setSpots(uint256 price) internal {
        uint256 supply = 311597728428336321792;
        uint256 tacSide = supply * 3779257685557097674 / 1e18 + 31940071679845627500747;
        uint256 ethSide = price * tacSide / 1e18;
        uint256 virt = supply * 1e18 / 3779257685557097674402;
        precisionPool.setReserves(uint128(ethSide - virt), 31940071679845627500747);
        uint256 rB = uint256(31940071679845627500747) / 1e10;
        v1.set(price * rB / 1e18, rB);
    }

    /// Sets every venue price to `price` (ring and spot) and the feed fresh.
    function _setPrice(uint256 price) internal {
        _setRings(price, 1e24);
        _setSpots(price);
        feed.set(4000e8);
    }

    // The gas of the last external call, counted as its own transaction (run with --isolate).
    string[] internal names;
    uint256[] internal used;

    function _rec(string memory what, uint256 bound) internal {
        uint256 g = vm.lastCallGas().gasTotalUsed;
        assertLt(g, bound, what);
        names.push(what);
        used.push(g);
        console2.log(what, g);
    }

    function _report() internal view {
        uint256 worst;
        for (uint256 i; i < used.length; ++i) {
            if (used[i] > worst) worst = used[i];
        }
        console2.log("WORST (gas):", worst);
        assertLt(worst, CEILING_GAS, "an entry point above 3M gas");
    }

    // ───────── the oracle views ─────────

    function test_oracleViewGas() public {
        precision.prices(21_600);
        _rec("Precision venue prices(36 intervals):", 600_000);
        precision.depth(21_600);
        _rec("Precision venue depth(36 intervals):", 200_000);
        precision.recovery(21_600);
        _rec("Precision venue recovery(36 intervals):", 600_000);
        amm.prices(21_600);
        _rec("AMM venue prices(36 intervals):", 600_000);
        pair.prices(21_600);
        _rec("PAIR prices(MAX_WINDOW, 36 intervals):", 1_200_000);
        pair.prices(10_800);
        _rec("PAIR prices(WINDOW, 18 intervals):", 400_000);
        pair.prices(3_600);
        _rec("PAIR prices(SHORT, 6 intervals):", 100_000);
        pair.depth(10_800);
        _rec("PAIR depth(WINDOW):", 200_000);
        pair.recovery(21_600);
        _rec("PAIR recovery(36 intervals):", 1_200_000);
        pair.spot();
        _rec("PAIR spot():", 60_000);
        pair.latest();
        _rec("PAIR latest():", 40_000);
        precision.spot();
        _rec("Precision venue spot():", 40_000);
        amm.spot();
        _rec("AMM venue spot():", 40_000);
        _report();
    }

    // ───────── vault entry points ─────────

    // 10,000 TAC is 3,720 USD at 0.372: a 1,000 borrow plus its 1% fee is 368% at the borrow view.
    function _open(address who, uint256 coll, uint256 debt) internal {
        vm.startPrank(who);
        vault.deposit(coll);
        vault.borrow(debt, 500);
        vm.stopPrank();
    }

    function test_vaultEntryPointGas() public {
        // alice: a deep vault that holds the SYNTH the others will need
        vm.startPrank(alice);
        vault.deposit(2_000_000e18);
        vault.borrow(300e18, 500);
        _rec("vault.borrow (first):", 1_000_000);
        vault.borrow(3_000e18, 500);
        _rec("vault.borrow (second):", 900_000);
        vault.withdraw(1_000e18);
        _rec("vault.withdraw (with debt):", 600_000);
        vault.repay(alice, 100e18);
        _rec("vault.repay (no auction):", 100_000);
        vm.stopPrank();
        vm.prank(alice);
        dollar.transfer(bob, 100e18);

        // carol-like vault for bob: 10,000 TAC, 1,000 debt
        _open(bob, 10_000e18, 1_000e18);

        // redeem: bob's vault at 80% of the price is 294%, between 200% and 400%
        _setPrice(9.3e13 * 80 / 100);
        vm.prank(alice);
        vault.redeem(bob, 200e18, 0);
        _rec("vault.redeem:", 2_400_000);

        // liquidate: 40% of the price, 184% (810 debt against 1,488 USD)
        _setPrice(9.3e13 * 40 / 100);
        vault.liquidate(bob);
        _rec("vault.liquidate:", 1_400_000);

        // while the auction runs: deposit and repay try to end it (four recovery reads)
        vm.prank(alice);
        vault.depositFor(bob, 1e18);
        _rec("vault.depositFor (auction running, tryEnd):", 1_400_000);
        vm.prank(alice);
        vault.repay(bob, 1e18);
        _rec("vault.repay (auction running, tryEnd):", 1_400_000);
        vault.onOffer(bob);
        _rec("vault.onOffer (view):", 1_400_000);
        vault.recovered(bob);
        _rec("vault.recovered (view):", 1_400_000);

        skip(1_800);
        feed.set(4000e8);
        vm.prank(alice);
        vault.bid(bob, 300e18, 0);
        _rec("vault.bid (partial, non-owner):", 3_000_000);
        // the partial bid took the vault back over its line: the bid itself ended the auction
        (,, uint256 start) = vault.vaults(bob);
        assertEq(start, 0, "a bid that recovers the vault ends the auction");
        // cancel: another vault is liquidated, then the price returns
        address carol = address(0xCA801);
        tac.mint(carol, 100_000e18);
        vm.prank(carol);
        tac.approve(address(vault), type(uint256).max);
        _setPrice(9.3e13);
        _open(carol, 10_000e18, 1_000e18);
        _setPrice(9.3e13 * 40 / 100);
        vault.liquidate(carol);
        _setPrice(9.3e13);
        vault.cancel(carol);
        _rec("vault.cancel:", 1_400_000);
        _report();
    }

    function test_fullBidGas() public {
        vm.startPrank(alice);
        vault.deposit(2_000_000e18);
        vault.borrow(3_000e18, 500);
        vm.stopPrank();
        _open(bob, 10_000e18, 1_000e18);
        _setPrice(9.3e13 * 30 / 100); // 0.1116 USD: 1,116 against 1,010
        vault.liquidate(bob);
        skip(1_800);
        feed.set(4000e8);
        vm.prank(alice);
        vault.bid(bob, type(uint256).max, 0);
        _rec("vault.bid (full, non-owner):", 2_400_000);
        _report();
    }

    function test_absorbGas() public {
        vm.startPrank(alice);
        vault.deposit(2_000_000e18);
        vault.borrow(3_000e18, 500);
        vm.stopPrank();
        _open(bob, 10_000e18, 1_000e18);
        vm.prank(alice);
        dollar.transfer(address(vault), 1_300e18); // the reserve
        _setPrice(9.3e13 * 20 / 100); // 0.0744 USD: 744 USD against 1,010: underwater
        vault.liquidate(bob);
        skip(5_400);
        feed.set(4000e8);
        vault.absorb(bob);
        _rec("vault.absorb (full):", 1_400_000);
        _report();
    }

    function test_theBorrowViewsAtTheWorstCase() public {
        // valueOf / liquidationPrice / offerPrice / depthCeiling are views over the same oracle reads
        vault.valueOf(1e18, true);
        _rec("vault.valueOf(borrow view):", 500_000);
        vault.valueOf(1e18, false);
        _rec("vault.valueOf(liquidation view):", 1_400_000);
        vault.offerPrice();
        _rec("vault.offerPrice():", 1_400_000);
        vault.depthCeiling();
        _rec("vault.depthCeiling():", 400_000);
        _report();
    }
}
