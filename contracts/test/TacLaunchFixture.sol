// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TestTac, LiveFeed} from "./TacVaultMocks.sol";
import {MockPrecision} from "./MockPrecision.sol";
import {TacMockV1} from "./TacMockV1.sol";

/// The deploy script's configuration, offline: both venue oracles (STEP 50; windows 2h / 3h / 6h; two thirds coverage)
/// over a mock Precision pool and a mock confidential pool, their pair, and a dollar vault with the script's default
/// settings. Ring samples are written straight into the oracles' storage; `_fill` records every interval of the
/// longest window on both venues.
abstract contract TacLaunchFixture is Test {
    uint256 internal constant STEP = 50;
    uint256 internal constant HEAD = 26_000_061;
    bytes32 internal constant ETH_ASSET = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 internal constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    bytes32 internal constant POOL_ID = 0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00;

    TestTac internal tac;
    MockPrecision internal prec;
    TacMockV1 internal v1;
    TacBlockOracle internal a;
    TacAmmOracle internal b;
    TacPairOracle internal pair;
    TacVault internal vault;
    TacSynth internal synth;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint256 internal baseA;
    uint256 internal baseB;

    function setUp() public virtual {
        tac = new TestTac();
        prec = new MockPrecision(address(tac), 3.78e18, 3.78e21, 3e20, 3e18, 3e22);
        v1 = new TacMockV1();
        v1.setAsset(ETH_ASSET, address(0), 1e10);
        v1.setAsset(TAC_ASSET, address(tac), 1e10);
        v1.setPool(POOL_ID, ETH_ASSET, TAC_ASSET, 3e8, 3.2e12);
        a = new TacBlockOracle(address(prec), address(tac), STEP, 7_200, 10_800, 21_600, 6_600);
        b = new TacAmmOracle(
            address(v1), POOL_ID, ETH_ASSET, TAC_ASSET, address(tac), 74, STEP, 7_200, 10_800, 21_600, 6_600
        );
        pair = new TacPairOracle(address(a), address(b));
        baseA = a.spot();
        baseB = b.spot();
        vm.roll(HEAD);
        vm.warp(1_800_000_000);

        TacVault.Config memory c = TacVault.Config({
            tac: address(tac),
            oracle: address(pair),
            ethUsd: address(new LiveFeed()),
            owner: address(this),
            mintRatioBps: 35_000,
            liqRatioBps: 20_000,
            liqBonusBps: 2_500,
            auctionDuration: 5_400,
            ownerWindow: 1_200,
            minDebt: 100e18,
            feedMaxStaleness: 3_900,
            debtCeiling: 1_000_000e18,
            depthBps: 500,
            redemptionFeeBps: 50,
            borrowFeeBps: 100,
            feeTo: address(0xFEE),
            tacSink: address(0xdEaD),
            name: "TAC Dollar",
            symbol: "TACD"
        });
        vault = new TacVault(c);
        synth = vault.SYNTH();
        tac.mint(alice, 10_000_000e18);
        tac.mint(bob, 10_000_000e18);
        vm.prank(alice);
        tac.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        tac.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        synth.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        synth.approve(address(vault), type(uint256).max);
    }

    // The newest interval that counts at HEAD.
    function _newest() internal view returns (uint256) {
        return (HEAD - 1 - a.GRACE()) / STEP - 1;
    }

    // Records 40 intervals on both venues at `factorBps` of the venues' prices; `spreadBps` makes older intervals
    // cheaper (a rising price, newest first, so the median's sort sees descending values, its slowest order). The
    // depth is 1,000 ETH.
    function _fill(uint256 factorBps, uint256 spreadBps) internal {
        uint256 newest = _newest();
        for (uint256 i; i < 40; ++i) {
            uint256 idx = newest - i;
            uint256 f = factorBps * (10_000 - spreadBps * i / 40) / 10_000;
            vm.store(
                address(a), bytes32(idx % 128), bytes32(idx << 208 | (baseA * f / 10_000) << 104 | uint256(1000e18))
            );
            vm.store(
                address(b), bytes32(idx % 128), bytes32(idx << 208 | (baseB * f / 10_000) << 104 | uint256(1000e18))
            );
        }
    }

    // Re-records one venue's 40 intervals at `factorBps` of its price.
    function _fillVenue(bool venueA, uint256 factorBps) internal {
        uint256 newest = _newest();
        address o = venueA ? address(a) : address(b);
        uint256 base = venueA ? baseA : baseB;
        for (uint256 i; i < 40; ++i) {
            uint256 idx = newest - i;
            vm.store(o, bytes32(idx % 128), bytes32(idx << 208 | (base * factorBps / 10_000) << 104 | uint256(1000e18)));
        }
    }

    // Alice deposits 100,000 TAC and borrows 5,000.
    function _open() internal {
        vm.startPrank(alice);
        vault.deposit(100_000e18);
        vault.borrow(5_000e18, 100);
        vm.stopPrank();
    }
}
