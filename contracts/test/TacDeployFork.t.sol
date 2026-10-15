// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {DeployTacVault} from "../script/DeployTacVault.s.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";

interface IV1c {
    function registerWrappedAuto(address underlying, bytes32 link) external returns (bytes32);
    function assets(bytes32) external view returns (bool, address, uint256, bytes32, bool, uint8);
    function createPair(bytes32, bytes32, uint32, uint8, bytes32, uint32) external returns (bytes32);
    function pools(bytes32) external view returns (bool, bytes32, bytes32, uint256, uint256, uint32, uint256);
}

interface IChainlinkC {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// MAINNET FORK tests of script/DeployTacVault.s.sol (skipped without FORK_URL): the script's constants against the
/// chain, its post-conditions when run, and its behaviour when someone else registers a synth or creates a pair first.
///   FORK_URL=https://eth.drpc.org FORK_BLOCK=26183554 forge test --match-path test/TacDeployFork.t.sol -vv -j 1
contract TacDeployForkTest is Test {
    address constant V1 = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    address constant OPS = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;
    bytes32 constant ETH_ASSET = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    bytes32 constant CUSD_ASSET = 0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d;
    bytes32 constant TAC_ETH_POOL = 0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00;
    bytes32 constant ASSET_REGISTERED = keccak256("AssetRegistered(bytes32,address,uint256,string,string,uint8)");

    // Mainnet fork tests: reported as skipped (not passed) when FORK_URL is not set.
    function _fork() internal returns (bool) {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true, "needs FORK_URL");
            return false;
        }
        uint256 blockNumber = vm.envOr("FORK_BLOCK", uint256(0));
        if (blockNumber == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, blockNumber);
        return true;
    }

    function _oracleMaxWindow(TacVault v) internal view returns (uint256) {
        return TacPairOracle(address(v.ORACLE())).MAX_WINDOW();
    }

    function _poolId(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        (bytes32 lo, bytes32 hi) = x < y ? (x, y) : (y, x);
        return keccak256(abi.encode(lo, hi, uint256(30)));
    }

    /// The script's pool id is the confidential pool's id for (ETH, TAC) at 30 bps, and the pool is initialised; the
    /// owner is a contract and the feed is Chainlink's ETH / USD with 8 decimals.
    function test_theScriptsPoolIdAndFeedAreTheLiveOnes() public {
        if (!_fork()) return;
        assertEq(_poolId(ETH_ASSET, TAC_ASSET), TAC_ETH_POOL);
        (bool init, bytes32 a, bytes32 b,,, uint32 fee,) = IV1c(V1).pools(TAC_ETH_POOL);
        assertTrue(init);
        assertEq(a, ETH_ASSET);
        assertEq(b, TAC_ASSET);
        assertEq(fee, 30);
        // The ops multisig is a contract; the feed is Chainlink's ETH/USD (8 decimals).
        assertGt(OPS.code.length, 0, "OWNER is a contract");
        IChainlinkC feed = IChainlinkC(0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419);
        assertEq(feed.decimals(), 8);
        assertEq(keccak256(bytes(feed.description())), keccak256("ETH / USD"));
        // cUSD is registered in the pool under the id the script pairs the dollar synth with.
        (bool cusdRegistered, address cusdToken,,,,) = IV1c(V1).assets(CUSD_ASSET);
        assertTrue(cusdRegistered, "cUSD is registered");
        assertEq(cusdToken, 0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564, "its ERC-20 form is tacUSD");
    }

    /// Runs the deploy script on the fork (nothing leaves the test) and checks what it leaves: the vaults' settings,
    /// the shared pair oracle and its venues, both synths registered and the five pairs initialised, and a vault
    /// that cannot lend before the oracle has recorded anything.
    function test_theDeployScriptLeavesTheVaultsOraclesSynthsAndPairsWired() public {
        if (!_fork()) return;
        vm.setEnv("OWNER", vm.toString(OPS));
        DeployTacVault script = new DeployTacVault();
        vm.recordLogs();
        script.run();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        address[] memory synths = new address[](2);
        bytes32[] memory ids = new bytes32[](2);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == V1 && logs[i].topics[0] == ASSET_REGISTERED) {
                ids[n] = logs[i].topics[1];
                synths[n] = address(uint160(uint256(logs[i].topics[2])));
                ++n;
            }
        }
        assertEq(n, 2, "two synths registered by the script");
        TacVault usd = TacVault(TacSynth(synths[0]).MINTER());
        TacVault eth = TacVault(TacSynth(synths[1]).MINTER());
        assertEq(address(usd.SYNTH()), synths[0]);
        assertEq(address(eth.SYNTH()), synths[1]);

        // Owners, parameters and the shared oracle.
        assertEq(usd.owner(), OPS);
        assertEq(eth.owner(), OPS);
        assertEq(address(usd.ORACLE()), address(eth.ORACLE()));
        assertEq(usd.TAC(), TAC);
        assertEq(usd.MINT_RATIO_BPS(), 35_000);
        assertEq(usd.LIQ_RATIO_BPS(), 20_000);
        assertEq(usd.LIQ_BONUS_BPS(), 2_500);
        assertEq(usd.AUCTION_DURATION(), 5_400);
        assertEq(usd.OWNER_WINDOW(), 3_600);
        assertEq(eth.OWNER_WINDOW(), 3_600);
        assertEq(usd.LIQ_WINDOW(), 21_600);
        assertEq(usd.LIQ_WINDOW(), _oracleMaxWindow(usd), "the liquidation window is the oracle's longest");
        assertEq(usd.DEPTH_BPS(), 250);
        assertEq(eth.DEPTH_BPS(), 250);
        assertEq(usd.REDEMPTION_FEE_BPS(), 50);
        assertEq(usd.borrowFeeBps(), 100);
        assertEq(usd.MIN_DEBT(), 100e18);
        assertEq(eth.MIN_DEBT(), 0.04e18);
        assertEq(usd.debtCeiling(), type(uint256).max);
        assertEq(eth.debtCeiling(), type(uint256).max);
        assertEq(usd.feeTo(), OPS);
        assertEq(usd.tacSink(), OPS);
        assertEq(usd.FEED_MAX_STALENESS(), 3_900);

        TacPairOracle pair = TacPairOracle(address(usd.ORACLE()));
        assertEq(pair.SHORT_WINDOW(), 7_200);
        assertEq(pair.STEP(), 50);
        assertEq(pair.WINDOW(), 10_800);
        assertEq(pair.MAX_WINDOW(), 21_600);
        TacIntervalOracle a = TacIntervalOracle(address(pair.A()));
        TacIntervalOracle b = TacIntervalOracle(address(pair.B()));
        assertEq(a.STEP(), 50);
        assertEq(b.STEP(), 50);
        assertEq(a.MIN_COVERAGE_BPS(), 6_600);
        assertEq(a.POOL(), 0x0155358241411dB868BA714aE7c83A27087e3D6E);
        assertEq(b.POOL(), V1);

        // Both synths are registered with the right underlying and scale, and the five pairs exist.
        for (uint256 i; i < 2; ++i) {
            (bool reg, address under, uint256 scale,,, uint8 dec) = IV1c(V1).assets(ids[i]);
            assertTrue(reg);
            assertEq(under, synths[i]);
            assertEq(scale, 1e10);
            assertEq(dec, 18);
        }
        bytes32 usdId = ids[0];
        bytes32 ethId = ids[1];
        bytes32[5] memory want = [
            _poolId(TAC_ASSET, usdId),
            _poolId(TAC_ASSET, ethId),
            _poolId(ETH_ASSET, ethId),
            _poolId(usdId, ethId),
            _poolId(usdId, CUSD_ASSET)
        ];
        for (uint256 i; i < 5; ++i) {
            (bool init,,,,,,) = IV1c(V1).pools(want[i]);
            assertTrue(init, "pair created");
        }

        // Before the keeper has recorded anything the oracle gives no price and the vaults cannot lend: fail closed.
        vm.expectRevert();
        pair.prices(7_200);
        vm.expectRevert();
        usd.depthCeiling();
        address someone = makeAddr("someone");
        deal(TAC, someone, 100_000e18);
        vm.startPrank(someone);
        (bool ok,) = TAC.call(abi.encodeWithSignature("approve(address,uint256)", address(usd), type(uint256).max));
        assertTrue(ok);
        usd.deposit(100_000e18);
        vm.expectRevert(); // no price yet
        usd.borrow(100e18, 100);
        vm.stopPrank();

        // The zaps are wired to their vault's synth router.
        console2.log("USD vault", address(usd));
        console2.log("ETH vault", address(eth));
    }

    /// Registering a synth or creating a pair before the script changes nothing the script relies on: the asset id
    /// is deterministic (the script's fallback formula is the real one), a link cannot be attached, and a second
    /// registration or pair creation reverts, which the script's try/catch absorbs.
    function test_registeringASynthOrCreatingAPairFirstLeavesTheScriptsAssumptionsIntact() public {
        if (!_fork()) return;
        TacSynth s = new TacSynth("TAC Dollar", "TACD");
        address other = makeAddr("other");
        vm.prank(other);
        bytes32 id = IV1c(V1).registerWrappedAuto(address(s), bytes32(0));
        // The script's fallback id.
        assertEq(id, sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), address(s))));
        // The script's own registration now reverts (and is caught there).
        vm.expectRevert();
        IV1c(V1).registerWrappedAuto(address(s), bytes32(0));
        // A non-zero cross-chain link cannot be attached.
        TacSynth s2 = new TacSynth("TAC Ether", "TACE");
        vm.prank(other);
        vm.expectRevert();
        IV1c(V1).registerWrappedAuto(address(s2), bytes32(uint256(1)));
        // A pair created first is the same pool; the script's createPair reverts and is caught there.
        vm.prank(other);
        bytes32 pid = IV1c(V1).createPair(TAC_ASSET, id, 30, 0, bytes32(0), 0);
        assertEq(pid, _poolId(TAC_ASSET, id));
        vm.expectRevert();
        IV1c(V1).createPair(TAC_ASSET, id, 30, 0, bytes32(0), 0);
        (bool init,,, uint256 ra, uint256 rb,,) = IV1c(V1).pools(pid);
        assertTrue(init);
        assertEq(ra + rb, 0, "an empty pair: the first funder sets the ratio");
    }
}
