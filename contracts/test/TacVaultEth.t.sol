// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {FixedFeed} from "../src/FixedFeed.sol";
import {TestTac, MockOracle, VaultConfig} from "./TacVaultMocks.sol";

/// The same vault with a fixed 1.0 feed: TAC is valued in ETH and the debt token is ETH-pegged.
contract TacVaultEthTest is Test {
    uint256 constant P = 1e14; // 0.0001 ETH per TAC
    TestTac tac;
    MockOracle oracle;
    TacVault vault;
    TacSynth teth;
    address alice = address(0xA11CE);

    function setUp() public {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        oracle = new MockOracle();
        oracle.set(P);
        TacVault.Config memory c =
            VaultConfig.defaults(address(tac), address(oracle), address(new FixedFeed()), address(0x0123));
        c.minDebt = 0.01e18;
        c.debtCeiling = 1e18;
        c.name = "TAC ETH";
        c.symbol = "tacETH";
        vault = new TacVault(c);
        teth = vault.SYNTH();
        tac.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        tac.approve(address(vault), type(uint256).max);
        teth.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function test_valuesTacInEth() public view {
        assertEq(vault.valueOf(30_000e18, true), 3e18, "30,000 TAC at 0.0001 ETH is 3 ETH");
    }

    function test_borrowsEthPeggedDebtAtTheFloor() public {
        vm.startPrank(alice);
        vault.deposit(30_000e18); // 3 ETH of TAC: 1 ETH at 300%
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(1e18 + 1, 0);
        vault.borrow(1e18, 0);
        vm.stopPrank();
        assertEq(teth.balanceOf(alice), 1e18);
        assertEq(teth.symbol(), "tacETH");
    }

    function test_liquidatesOnTacEthAloneWithNoUsdFeed() public {
        vm.startPrank(alice);
        vault.deposit(30_000e18);
        vault.borrow(1e18, 0);
        vm.stopPrank();
        skip(30 days); // a fixed feed never goes stale
        oracle.set(5e13); // TAC halves against ETH: 150%, under 175%
        vault.liquidate(alice);
        (,, uint256 start) = vault.vaults(alice);
        assertGt(start, 0);
    }
}
