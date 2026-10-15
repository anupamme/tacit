// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacVault} from "../src/TacVault.sol";
import {VaultConfig, LiveFeed} from "./TacVaultMocks.sol";
import {DeployTacVault} from "../script/DeployTacVault.s.sol";

interface IErc20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// The ETH/TAC Precision pool's price at the sample blocks of past intervals, proven from real mainnet headers and
/// `eth_getProof` output (test/fixtures/tac-block-oracle: 14 intervals of 25 blocks before the fork block):
///   FORK_URL=https://eth.drpc.org forge test --match-path test/TacBlockOracleFork.t.sol -vv -j 1
contract TacBlockOracleForkTest is Test {
    address constant PRECISION = 0x0155358241411dB868BA714aE7c83A27087e3D6E;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    uint256 constant FORK_BLOCK = 26183554;
    uint256 constant LATEST = 1047341; // the newest interval whose following block is before the fork block
    uint256 constant STEP = 25;
    uint256 constant COUNT = 14;

    TacBlockOracle oracle;

    struct Fixture {
        uint256 number;
        bytes header;
        bytes next;
        bytes[] account;
        bytes[] reserves;
        bytes[] supply;
    }

    function _fork() internal {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true, "needs FORK_URL");
        vm.createSelectFork(url, FORK_BLOCK);
        oracle = new TacBlockOracle(PRECISION, TAC, STEP, 30 minutes, 1 hours, 1 hours, 6_600);
    }

    function _fixture(uint256 interval) internal view returns (Fixture memory f) {
        string memory json =
            vm.readFile(string.concat("test/fixtures/tac-block-oracle/", vm.toString(interval), ".json"));
        f.number = vm.parseJsonUint(json, ".number");
        f.header = vm.parseJsonBytes(json, ".header");
        f.next = vm.parseJsonBytes(json, ".next");
        f.account = vm.parseJsonBytesArray(json, ".accountProof");
        f.reserves = vm.parseJsonBytesArray(json, ".reservesProof");
        f.supply = vm.parseJsonBytesArray(json, ".supplyProof");
    }

    function _record(Fixture memory f) internal returns (uint256 price) {
        (price,) = oracle.record(f.header, f.next, f.account, f.reserves, f.supply);
    }

    function _recordAll() internal {
        for (uint256 i; i < COUNT; ++i) {
            _record(_fixture(LATEST - i));
        }
    }

    /// Every interval proves, including those older than 256 blocks (through the block-hash history); the newest
    /// matches the pool's price now, and both medians match it.
    function test_recordsProvenIntervals() public {
        _fork();
        Fixture memory f = _fixture(LATEST);
        uint256 g = gasleft();
        oracle.record(f.header, f.next, f.account, f.reserves, f.supply);
        console2.log("gas to record one interval:", g - gasleft());
        for (uint256 i = 1; i < COUNT; ++i) {
            _record(_fixture(LATEST - i));
        }
        assertGt(FORK_BLOCK - _fixture(LATEST - COUNT + 1).number, 256, "the oldest is beyond BLOCKHASH");
        (uint256 newest, uint256 depth) = oracle.sampleOf(LATEST);
        assertApproxEqRel(newest, oracle.spot(), 0.001e18);
        console2.log("ETH depth of the newest sample (milli-ETH):", depth / 1e15);
        (uint256 low, uint256 high) = oracle.prices(1 hours);
        assertApproxEqRel(low, oracle.spot(), 0.01e18);
        assertApproxEqRel(high, oracle.spot(), 0.01e18);
        assertGt(depth, 2.5e18);
    }

    /// The sample block is the one the following block's RANDAO value picks.
    function test_onlyTheChosenSampleBlockIsAccepted() public {
        _fork();
        Fixture memory f = _fixture(LATEST);
        Fixture memory g = _fixture(LATEST - 1);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(f.header, g.next, f.account, f.reserves, f.supply); // the wrong interval's following block
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(f.next, f.next, f.account, f.reserves, f.supply); // a block that is not the sample
    }

    function test_aTamperedHeaderIsRefused() public {
        _fork();
        Fixture memory f = _fixture(LATEST);
        f.header[100] = f.header[100] ^ 0x01;
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        _record(f);
        f = _fixture(LATEST);
        f.next[100] = f.next[100] ^ 0x01;
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        _record(f);
    }

    /// A proof of the wrong slot does not pass for the reserves.
    function test_swappedStorageProofsAreRefused() public {
        _fork();
        Fixture memory f = _fixture(LATEST);
        (f.reserves, f.supply) = (f.supply, f.reserves);
        vm.expectRevert();
        _record(f);
    }

    function test_anIntervalIsRecordedOnce() public {
        _fork();
        _record(_fixture(LATEST));
        Fixture memory f = _fixture(LATEST);
        vm.expectRevert(TacIntervalOracle.AlreadyRecorded.selector);
        _record(f);
    }

    /// A window with fewer than two thirds of its intervals recorded has no price.
    function test_tooFewIntervalsHaveNoPrice() public {
        _fork();
        for (uint256 i; i < 8; ++i) {
            _record(_fixture(LATEST - i));
        }
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        oracle.prices(1 hours);
        _record(_fixture(LATEST - 8));
        oracle.prices(1 hours);
    }

    /// The deploy script runs end to end.
    function test_theDeployScriptRuns() public {
        _fork();
        new DeployTacVault().run();
    }

    /// A vault borrows against the proven prices, up to the depth cap.
    function test_aVaultBorrowsOnProvenPrices() public {
        _fork();
        _recordAll();
        TacVault.Config memory c = VaultConfig.defaults(TAC, address(oracle), address(new LiveFeed()), address(0x0123));
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
        console2.log("5% of the pool's ETH depth, in dollars:", room / 1e18);
        assertGt(room, 300e18);
    }
}
