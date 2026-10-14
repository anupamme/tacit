// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TacVault} from "../src/TacVault.sol";
import {TacLaunchFixture} from "./TacLaunchFixture.sol";

/// What a vault with the largest debt ceiling lends follows its venues' depth: a fixed share (DEPTH_BPS) of the smaller
/// venue's ETH depth over the longest window, rising when every interval of the window is deeper and falling as soon
/// as one is thinner. The venue oracles, their pair and the vault are the deploy script's configuration over mock
/// pools (TacLaunchFixture); ETH is $2,500 and the share is 5%.
///
/// A longer run of the fuzz test: `forge test --match-path test/TacVaultScaling.t.sol --fuzz-runs 5000`.
contract TacVaultScalingTest is TacLaunchFixture {
    uint256 internal constant ETH_USD = 2_500;
    uint256 internal constant SHARE_BPS = 500;
    uint256 internal constant WINDOW_INTERVALS = 36;

    function setUp() public override {
        super.setUp();
        vault.setDebtCeiling(type(uint256).max);
    }

    function _put(address oracle, uint256 base, uint256 interval, uint256 depth) internal {
        vm.store(oracle, bytes32(interval % 128), bytes32(interval << 208 | base << 104 | depth));
    }

    // Both venues record the 40 newest intervals at the pools' prices and the given ETH depths.
    function _fillDepth(uint256 depthA, uint256 depthB) internal {
        uint256 newest = _newest();
        for (uint256 i; i < 40; ++i) {
            _put(address(a), baseA, newest - i, depthA);
            _put(address(b), baseB, newest - i, depthB);
        }
    }

    // The dollars a vault may lend on `depth` wei of ETH.
    function _capacity(uint256 depth) internal pure returns (uint256) {
        return depth * ETH_USD * SHARE_BPS / 10_000;
    }

    // `who` deposits enough TAC to borrow `amount` at the mint ratio with some margin, then borrows it.
    function _borrow(address who, uint256 amount) internal {
        uint256 perTac = vault.valueOf(1e18, true);
        uint256 collateral = amount * 37_000 / 10_000 * 1e18 / perTac + 1e18;
        tac.mint(who, collateral);
        vm.startPrank(who);
        vault.deposit(collateral);
        vault.borrow(amount, 100);
        vm.stopPrank();
    }

    // The largest amount whose fee fits under `room` of total debt.
    function _fits(uint256 room) internal pure returns (uint256) {
        return room * 10_000 / 10_100;
    }

    /// From 3 to 30,000 ETH of depth the capacity is 5% of it, a first borrower can take all of it, and a second
    /// one is turned away.
    function test_theCapacityIsAFixedShareOfDepth() public {
        uint256[5] memory eth = [uint256(3), 30, 300, 3_000, 30_000];
        uint256 snapshot = vm.snapshotState();
        for (uint256 i; i < eth.length; ++i) {
            _fillDepth(eth[i] * 1e18, eth[i] * 1e18);
            uint256 cap = vault.depthCeiling();
            assertEq(cap, _capacity(eth[i] * 1e18));
            emit log_named_decimal_uint(
                string.concat("ETH depth ", vm.toString(eth[i]), ": capacity in dollars"), cap, 18
            );

            _borrow(alice, _fits(cap));
            assertLe(vault.totalDebt(), cap);
            assertGt(vault.totalDebt() + 101e18, cap, "all of the capacity is used");

            tac.mint(bob, 1_000_000_000e18);
            vm.startPrank(bob);
            vault.deposit(1_000_000_000e18);
            vm.expectRevert(TacVault.OverCeiling.selector);
            vault.borrow(100e18, 100);
            vm.stopPrank();
            assertTrue(vm.revertToState(snapshot));
            snapshot = vm.snapshotState();
        }
    }

    /// The smaller venue sets it: deepening the thinner one raises it, deepening the deeper one does not.
    function test_theSmallerVenueSetsTheCapacity() public {
        _fillDepth(10_000e18, 10e18);
        assertEq(vault.depthCeiling(), _capacity(10e18));
        _fillDepth(20_000e18, 10e18);
        assertEq(vault.depthCeiling(), _capacity(10e18));
        _fillDepth(20_000e18, 100e18);
        assertEq(vault.depthCeiling(), _capacity(100e18));
        _fillDepth(5e18, 100e18);
        assertEq(vault.depthCeiling(), _capacity(5e18));
    }

    /// More depth counts once every interval of the window is recorded at it, not before.
    function test_capacityRisesOnceTheWholeWindowIsDeeper() public {
        _fillDepth(30e18, 30e18);
        uint256 before = vault.depthCeiling();
        assertEq(before, _capacity(30e18));
        uint256 newest = _newest();
        for (uint256 k = 1; k <= WINDOW_INTERVALS; ++k) {
            _put(address(a), baseA, newest - (k - 1), 300e18);
            _put(address(b), baseB, newest - (k - 1), 300e18);
            assertEq(vault.depthCeiling(), k < WINDOW_INTERVALS ? before : _capacity(300e18), "step");
        }
    }

    /// Less depth counts as soon as one interval of the window is recorded at it. Open debt stays and can be
    /// repaid and withdrawn; new borrowing waits for the depth to return.
    function test_capacityFallsAtOnceAndOpenDebtStays() public {
        _fillDepth(300e18, 300e18);
        _borrow(alice, _fits(vault.depthCeiling()));
        uint256 debt = vault.totalDebt();

        _put(address(b), baseB, _newest() - (WINDOW_INTERVALS - 1), 3e18);
        assertEq(vault.depthCeiling(), _capacity(3e18));

        tac.mint(bob, 1_000_000e18);
        vm.startPrank(bob);
        vault.deposit(1_000_000e18);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(100e18, 100);
        vm.stopPrank();

        assertEq(vault.totalDebt(), debt, "open debt stays");
        (uint256 collateral, uint256 owed,) = vault.vaults(alice);
        assertGt(owed, 0);
        uint256 fee = synth.balanceOf(address(0xFEE));
        vm.prank(address(0xFEE));
        synth.transfer(alice, fee);
        vm.startPrank(alice);
        synth.approve(address(vault), type(uint256).max);
        vault.repay(alice, type(uint256).max);
        vault.withdraw(collateral);
        vm.stopPrank();
        assertEq(vault.totalDebt(), 0);
    }

    /// The owner's ceiling is a brake that can be released: lowered, it stops new borrowing; raised, borrowing
    /// resumes up to the depth share.
    function test_theOwnerCeilingIsABrake() public {
        _fillDepth(300e18, 300e18);
        vault.setDebtCeiling(0);
        tac.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        vault.deposit(1_000_000e18);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(100e18, 100);
        vm.stopPrank();
        vault.setDebtCeiling(type(uint256).max);
        vm.prank(alice);
        vault.borrow(100e18, 100);
        assertEq(vault.totalDebt(), 101e18);
    }

    /// For any two depths the capacity is 5% of the smaller one.
    function testFuzz_theCapacityIsAShareOfTheSmallerDepth(uint256 depthA, uint256 depthB) public {
        depthA = bound(depthA, 1e17, 1e27);
        depthB = bound(depthB, 1e17, 1e27);
        _fillDepth(depthA, depthB);
        assertEq(vault.depthCeiling(), _capacity(depthA < depthB ? depthA : depthB));
    }
}
