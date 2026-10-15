// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {TacLaunchFixture} from "./TacLaunchFixture.sol";

/// Gas of the pair oracle's views and of every vault action under the deploy script's windows (36 intervals per venue,
/// all recorded, samples in the order that makes the median's sort slowest). Every path stays far below the block
/// limit; the costliest, `bid` and `redeem`, read the oracle several times and take about 2M gas.
contract TacGasTest is TacLaunchFixture {
    function _gas(string memory what, uint256 used) internal {
        console2.log(what, used);
        assertLt(used, 4_000_000, what);
    }

    function test_everyOracleViewAndVaultActionStaysFarBelowTheBlockGasLimit() public {
        _fill(10_000, 3_000);
        uint256 g;

        g = gasleft();
        pair.prices(21_600);
        g -= gasleft();
        _gas("pair.prices(MAX_WINDOW, 36 intervals per venue)", g);
        g = gasleft();
        pair.prices(10_800);
        g -= gasleft();
        _gas("pair.prices(WINDOW, 18)", g);
        g = gasleft();
        pair.depthMin(21_600);
        g -= gasleft();
        _gas("pair.depthMin(MAX_WINDOW)", g);
        g = gasleft();
        pair.spot();
        g -= gasleft();
        _gas("pair.spot()", g);
        g = gasleft();
        pair.latest();
        g -= gasleft();
        _gas("pair.latest()", g);

        vm.startPrank(alice);
        g = gasleft();
        vault.deposit(100_000e18);
        g -= gasleft();
        _gas("deposit", g);
        g = gasleft();
        vault.borrow(5_000e18, 100);
        g -= gasleft();
        _gas("borrow (first)", g);
        g = gasleft();
        vault.borrow(100e18, 100);
        g -= gasleft();
        _gas("borrow (second)", g);
        g = gasleft();
        vault.withdraw(1_000e18);
        g -= gasleft();
        _gas("withdraw (with debt)", g);
        g = gasleft();
        vault.repay(alice, 100e18);
        g -= gasleft();
        _gas("repay (no auction)", g);
        vm.stopPrank();

        // Bob holds a second vault to redeem against: both vaults sit between 200% and 400% at the lowered price.
        vm.startPrank(bob);
        vault.deposit(100_000e18);
        vault.borrow(5_000e18, 100);
        vm.stopPrank();
        _fill(6_000, 3_000);
        vm.startPrank(alice);
        g = gasleft();
        vault.redeem(bob, 200e18, 0);
        g -= gasleft();
        _gas("redeem", g);
        vm.stopPrank();

        // After a further fall both vaults are below 200%.
        _fill(3_000, 3_000);
        g = gasleft();
        vault.liquidate(bob);
        g -= gasleft();
        _gas("liquidate", g);
        vault.liquidate(alice);

        // Past the owner window another account may bid.
        vm.startPrank(alice);
        skip(1_800);
        _fill(3_000, 3_000);
        g = gasleft();
        vault.bid(bob, 1_000e18, 0);
        g -= gasleft();
        _gas("bid (partial, not the owner)", g);
        vm.stopPrank();

        g = gasleft();
        pair.recovery(21_600);
        g -= gasleft();
        _gas("pair.recovery(MAX_WINDOW)", g);

        // Absorb: the vault holds a reserve, the auction duration has passed and the vault is worth less than its debt.
        skip(5_400);
        _fill(500, 3_000);
        vm.prank(alice);
        synth.transfer(address(vault), 2_000e18);
        g = gasleft();
        vault.absorb(alice);
        g -= gasleft();
        _gas("absorb", g);

        _fill(10_000, 3_000);
        g = gasleft();
        vault.cancel(bob);
        g -= gasleft();
        _gas("cancel (recovered)", g);
    }
}
