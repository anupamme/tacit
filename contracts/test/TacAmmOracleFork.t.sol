// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacVault} from "../src/TacVault.sol";
import {VaultConfig, LiveFeed} from "./TacVaultMocks.sol";

interface IErc20 {
    function approve(address, uint256) external returns (bool);
}

/// The confidential pool's ETH/TAC AMM pool at the sample blocks of past intervals, proven from real mainnet headers
/// and `eth_getProof` output (test/fixtures/tac-amm-oracle), alone and paired with the Precision pool:
///   FORK_URL=https://eth.drpc.org forge test --match-path test/TacAmmOracleFork.t.sol -vv -j 1
contract TacAmmOracleForkTest is Test {
    address constant V1 = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant PRECISION = 0x0155358241411dB868BA714aE7c83A27087e3D6E;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    bytes32 constant ETH_ASSET = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    bytes32 constant POOL_ID = 0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00;
    uint256 constant MAPPING_SLOT = 74;
    uint256 constant FORK_BLOCK = 26183554;
    uint256 constant LATEST = 1047341;
    uint256 constant STEP = 25;
    uint256 constant COUNT = 14;

    TacAmmOracle amm;

    struct Fixture {
        uint256 number;
        bytes header;
        bytes next;
        bytes[] account;
        bytes[] a;
        bytes[] b;
    }

    function _fork() internal {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true, "needs FORK_URL");
        vm.createSelectFork(url, FORK_BLOCK);
        amm = _deploy(STEP);
    }

    function _deploy(uint256 step) internal returns (TacAmmOracle) {
        return new TacAmmOracle(
            V1, POOL_ID, ETH_ASSET, TAC_ASSET, TAC, MAPPING_SLOT, step, 30 minutes, 1 hours, 1 hours, 6_600
        );
    }

    function _fixture(string memory dir, uint256 interval) internal view returns (Fixture memory f) {
        string memory json = vm.readFile(string.concat("test/fixtures/", dir, "/", vm.toString(interval), ".json"));
        f.number = vm.parseJsonUint(json, ".number");
        f.header = vm.parseJsonBytes(json, ".header");
        f.next = vm.parseJsonBytes(json, ".next");
        f.account = vm.parseJsonBytesArray(json, ".accountProof");
        if (vm.keyExistsJson(json, ".proofA")) {
            f.a = vm.parseJsonBytesArray(json, ".proofA");
            f.b = vm.parseJsonBytesArray(json, ".proofB");
        } else {
            f.a = vm.parseJsonBytesArray(json, ".reservesProof");
            f.b = vm.parseJsonBytesArray(json, ".supplyProof");
        }
    }

    function _record(address oracle, string memory dir, uint256 interval) internal {
        Fixture memory f = _fixture(dir, interval);
        TacAmmOracle(oracle).record(f.header, f.next, f.account, f.a, f.b);
    }

    function _recordAll() internal returns (TacBlockOracle precision) {
        precision = new TacBlockOracle(PRECISION, TAC, STEP, 30 minutes, 1 hours, 1 hours, 6_600);
        for (uint256 i; i < COUNT; ++i) {
            _record(address(amm), "tac-amm-oracle", LATEST - i);
            _record(address(precision), "tac-block-oracle", LATEST - i);
        }
    }

    /// Every interval proves, the newest matches the pool's price now, and both medians do.
    function test_recordsProvenIntervals() public {
        _fork();
        for (uint256 i; i < COUNT; ++i) {
            _record(address(amm), "tac-amm-oracle", LATEST - i);
        }
        (uint256 newest, uint256 depth) = amm.sampleOf(LATEST);
        assertApproxEqRel(newest, amm.spot(), 0.001e18);
        console2.log("ETH per TAC (x1e18), newest sample:", newest);
        console2.log("ETH depth of the pool (milli-ETH):", depth / 1e15);
        (uint256 low, uint256 high) = amm.prices(1 hours);
        assertApproxEqRel(low, amm.spot(), 0.01e18);
        assertApproxEqRel(high, amm.spot(), 0.01e18);
    }

    function test_theSlotsAreTheMappingEntrys() public {
        _fork();
        (bytes32 a, bytes32 b) = amm.slots();
        uint256 base = uint256(keccak256(abi.encode(POOL_ID, MAPPING_SLOT)));
        assertEq(a, bytes32(base + 3));
        assertEq(b, bytes32(base + 4));
        (,,, uint256 reserveA, uint256 reserveB,,) = IPools(V1).pools(POOL_ID);
        assertEq(uint256(vm.load(V1, a)), reserveA);
        assertEq(uint256(vm.load(V1, b)), reserveB);
    }

    function test_aTamperedHeaderIsRefused() public {
        _fork();
        Fixture memory f = _fixture("tac-amm-oracle", LATEST);
        f.header[100] = f.header[100] ^ 0x01;
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        amm.record(f.header, f.next, f.account, f.a, f.b);
    }

    function test_swappedReserveProofsAreRefused() public {
        _fork();
        Fixture memory f = _fixture("tac-amm-oracle", LATEST);
        vm.expectRevert();
        amm.record(f.header, f.next, f.account, f.b, f.a);
    }

    /// A pool, assets or token that are not the ETH/TAC pool are refused.
    function test_theConstructorChecksThePool() public {
        _fork();
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new TacAmmOracle(
            V1, POOL_ID, TAC_ASSET, ETH_ASSET, TAC, MAPPING_SLOT, STEP, 30 minutes, 1 hours, 1 hours, 6_600
        );
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new TacAmmOracle(
            V1, POOL_ID, ETH_ASSET, TAC_ASSET, address(0xBEEF), MAPPING_SLOT, STEP, 30 minutes, 1 hours, 1 hours, 6_600
        );
        vm.expectRevert(TacIntervalOracle.BadConfig.selector);
        new TacAmmOracle(
            V1, bytes32(uint256(1)), ETH_ASSET, TAC_ASSET, TAC, MAPPING_SLOT, STEP, 30 minutes, 1 hours, 1 hours, 6_600
        );
    }

    /// Both venues behind one oracle: the vault borrows on them, and its debt cap is the smaller venue's depth.
    function test_aVaultBorrowsOnTheTwoVenues() public {
        _fork();
        TacBlockOracle precision = _recordAll();
        TacPairOracle pair = new TacPairOracle(address(precision), address(amm));
        (uint256 low, uint256 high) = pair.prices(1 hours);
        assertLe(low, high);

        TacVault.Config memory c = VaultConfig.defaults(TAC, address(pair), address(new LiveFeed()), address(0x0123));
        c.depthBps = 500;
        TacVault vault = new TacVault(c);
        address alice = makeAddr("alice");
        deal(TAC, alice, 100_000e18);
        vm.startPrank(alice);
        IErc20(TAC).approve(address(vault), type(uint256).max);
        vault.deposit(100_000e18);
        uint256 room = vault.depthCeiling();
        vault.borrow(room, 0);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(1e18, 0);
        vm.stopPrank();
        console2.log("5% of the smaller venue's ETH depth, in dollars:", room / 1e18);
        assertGt(room, 200e18);
    }
}

interface IPools {
    function pools(bytes32 poolId)
        external
        view
        returns (bool, bytes32, bytes32, uint256 reserveA, uint256 reserveB, uint32, uint256);
}
