// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployTacVault} from "../script/DeployTacVault.s.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacVaultZap} from "../src/TacVaultZap.sol";
import {TacVaultsDeployment as D} from "../script/TacVaultsDeployment.sol";

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
/// chain, a deployment by a stranger, what it leaves, and what others can and cannot do first.
///   FORK_URL=https://eth.drpc.org FORK_BLOCK=26183554 forge test --match-path test/TacDeployFork.t.sol -vv -j 1
contract TacDeployForkTest is Test {
    address constant V1 = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    address constant OPS = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;
    bytes32 constant ETH_ASSET = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    bytes32 constant CUSD_ASSET = 0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d;
    bytes32 constant TAC_ETH_POOL = 0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00;

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

    function _deployAs(address who) internal returns (DeployTacVault script) {
        script = new DeployTacVault();
        vm.startPrank(who);
        script.deployAll();
        script.registerAll();
        vm.stopPrank();
        script.verifyAll();
    }

    /// Anyone can send the deployment: the addresses are the planned ones, each starts with three zero bytes, and
    /// the vaults, oracles, synths and pairs come out as configured, with the owner the ops multisig.
    function test_aStrangerDeploysTheWholeSystemAtTheMinedAddresses() public {
        if (!_fork()) return;
        address stranger = makeAddr("stranger");
        DeployTacVault script = _deployAs(stranger);
        DeployTacVault.Step[14] memory s = script.steps();
        for (uint256 i; i < s.length; ++i) {
            assertGt(s[i].expected.code.length, 0, s[i].name);
            assertEq(uint160(s[i].expected) >> 136, 0, "three leading zero bytes");
        }

        TacVault usd = TacVault(D.USD_VAULT);
        TacVault eth = TacVault(D.ETH_VAULT);
        assertEq(usd.owner(), OPS);
        assertEq(eth.owner(), OPS);
        assertEq(D.OWNER, OPS);
        assertEq(address(usd.ORACLE()), address(eth.ORACLE()));
        assertEq(usd.TAC(), TAC);
        assertEq(usd.MINT_RATIO_BPS(), 35_000);
        assertEq(usd.LIQ_RATIO_BPS(), 20_000);
        assertEq(usd.LIQ_BONUS_BPS(), 4_000);
        assertEq(usd.AUCTION_DURATION(), 3_600);
        assertEq(usd.OWNER_WINDOW(), 1_800);
        assertEq(usd.LIQ_WINDOW(), 28_800);
        assertEq(usd.LIQ_WINDOW(), _oracleMaxWindow(usd), "the liquidation window is the oracle's longest");
        assertEq(usd.DEPTH_BPS(), 15);
        assertEq(eth.DEPTH_BPS(), 15);
        assertEq(usd.REDEMPTION_FEE_BPS(), 50);
        assertEq(usd.borrowFeeBps(), 100);
        assertEq(usd.MIN_DEBT(), 100e18);
        assertEq(eth.MIN_DEBT(), 0.04e18);
        assertEq(usd.debtCeiling(), type(uint256).max);
        assertEq(eth.debtCeiling(), type(uint256).max);
        assertEq(usd.feeTo(), OPS);
        assertEq(usd.tacSink(), OPS);
        assertEq(usd.FEED_MAX_STALENESS(), 3_900);
        assertEq(usd.pauser(), address(0));
        assertFalse(usd.paramsLocked());
        assertEq(usd.SYNTH().symbol(), "TACD");
        assertEq(eth.SYNTH().symbol(), "TACE");
        assertEq(usd.SYNTH().MINTER(), address(usd));
        assertEq(usd.SYNTH().minterCount(), 0);

        TacPairOracle pair = TacPairOracle(address(usd.ORACLE()));
        assertEq(pair.SHORT_WINDOW(), 7_200);
        assertEq(pair.STEP(), 50);
        assertEq(pair.WINDOW(), 21_600);
        assertEq(pair.MAX_WINDOW(), 28_800);
        TacIntervalOracle a = TacIntervalOracle(address(pair.A()));
        TacIntervalOracle b = TacIntervalOracle(address(pair.B()));
        assertEq(a.MIN_COVERAGE_BPS(), 6_600);
        assertEq(a.POOL(), 0x0155358241411dB868BA714aE7c83A27087e3D6E);
        assertEq(b.POOL(), V1);

        // Both synths are registered with the right underlying and scale, and the five pairs exist.
        address[2] memory synths = [address(usd.SYNTH()), address(eth.SYNTH())];
        bytes32[2] memory ids = [script.assetIdOf(synths[0]), script.assetIdOf(synths[1])];
        for (uint256 i; i < 2; ++i) {
            (bool reg, address under, uint256 scale, bytes32 link,, uint8 dec) = IV1c(V1).assets(ids[i]);
            assertTrue(reg);
            assertEq(under, synths[i]);
            assertEq(scale, 1e10);
            assertEq(link, bytes32(0));
            assertEq(dec, 18);
        }
        bytes32[5] memory want = [
            _poolId(TAC_ASSET, ids[0]),
            _poolId(TAC_ASSET, ids[1]),
            _poolId(ETH_ASSET, ids[1]),
            _poolId(ids[0], ids[1]),
            _poolId(ids[0], CUSD_ASSET)
        ];
        for (uint256 i; i < 5; ++i) {
            (bool init,,,,,,) = IV1c(V1).pools(want[i]);
            assertTrue(init, "pair created");
        }

        // The zaps and pools are wired to their vault's synth.
        assertEq(address(TacVaultZap(D.USD_ZAP).VAULT()), D.USD_VAULT);
        assertEq(address(TacVaultZap(D.ETH_ZAP).SYNTH_ROUTER()), D.ETH_ROUTER);

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
    }

    /// A second run, by anyone, changes nothing and does not fail; a partial run picks up where it stopped.
    function test_theDeploymentIsSafeToRepeatAndToResume() public {
        if (!_fork()) return;
        DeployTacVault script = new DeployTacVault();
        // Only the first six land, by one sender.
        DeployTacVault.Step[14] memory s = script.steps();
        for (uint256 i; i < 6; ++i) {
            vm.prank(makeAddr("first"));
            ICreateXTest(D.CREATEX).deployCreate2(s[i].salt, s[i].initCode);
            assertGt(s[i].expected.code.length, 0);
        }
        assertEq(D.TAC_POOL.code.length, 0);
        // Another sender finishes it, then repeats it.
        vm.startPrank(makeAddr("second"));
        script.deployAll();
        script.registerAll();
        script.deployAll();
        script.registerAll();
        vm.stopPrank();
        script.verifyAll();
    }

    /// The point of CREATE2 here: the same salt with different init code, or the right code with a different owner,
    /// lands somewhere else and the planned address stays free for the plan.
    function test_differentCodeCannotTakeAPlannedAddress() public {
        if (!_fork()) return;
        DeployTacVault script = new DeployTacVault();
        DeployTacVault.Step[14] memory s = script.steps();
        address attacker = makeAddr("attacker");
        // A feed with one byte more init code under the feed's own salt.
        bytes memory other = abi.encodePacked(s[3].initCode, hex"00");
        vm.prank(attacker);
        address landed = ICreateXTest(D.CREATEX).deployCreate2(s[3].salt, other);
        assertTrue(landed != s[3].expected, "different code lands elsewhere");
        assertEq(s[3].expected.code.length, 0, "the planned address is untouched");
        // The same vault code with the attacker as owner is another init code, hence another address.
        TacVault.Config memory c = _vaultConfigOf(attacker);
        bytes memory evil = abi.encodePacked(vm.getCode("TacVault.sol:TacVault"), abi.encode(c));
        assertTrue(keccak256(evil) != s[4].hash);
        assertTrue(script.predict(s[4].salt, keccak256(evil)) != s[4].expected);
        // The plan still goes through, and the addresses are the planned ones.
        script.deployAll();
        assertGt(s[3].expected.code.length, 0);
        assertGt(s[4].expected.code.length, 0);
    }

    /// The planned salts are bound to mainnet: the same salt and code give another address on another chain.
    function test_thePlannedSaltsAreBoundToMainnet() public {
        if (!_fork()) return;
        DeployTacVault script = new DeployTacVault();
        DeployTacVault.Step[14] memory s = script.steps();
        for (uint256 i; i < s.length; ++i) {
            assertEq(script.predict(s[i].salt, s[i].hash), s[i].expected);
        }
        vm.chainId(8453);
        for (uint256 i; i < s.length; ++i) {
            assertTrue(script.predict(s[i].salt, s[i].hash) != s[i].expected, s[i].name);
        }
    }

    function _vaultConfigOf(address owner_) internal pure returns (TacVault.Config memory c) {
        c = TacVault.Config({
            tac: D.TAC,
            oracle: D.PAIR_ORACLE,
            ethUsd: D.ETH_USD,
            owner: owner_,
            mintRatioBps: D.MINT_RATIO_BPS,
            liqRatioBps: D.LIQ_RATIO_BPS,
            liqBonusBps: D.LIQ_BONUS_BPS,
            auctionDuration: D.AUCTION_DURATION,
            ownerWindow: D.OWNER_WINDOW,
            minDebt: D.USD_MIN_DEBT,
            feedMaxStaleness: D.FEED_MAX_STALENESS,
            debtCeiling: D.DEBT_CEILING,
            depthBps: D.DEPTH_BPS,
            redemptionFeeBps: D.REDEMPTION_FEE_BPS,
            borrowFeeBps: D.BORROW_FEE_BPS,
            feeTo: D.FEE_TO,
            tacSink: D.TAC_SINK,
            name: D.USD_NAME,
            symbol: D.USD_SYMBOL
        });
    }

    /// Others may register a synth or create a pair before the script gets to it. The id of a plain token is fixed by
    /// the token, no cross-chain link can be attached to it, and a pair's id includes its fee, so what they make is
    /// what the script needs, and what it reads back checks out.
    function test_registeringASynthOrCreatingAPairFirstLeavesTheScriptsAssumptionsIntact() public {
        if (!_fork()) return;
        DeployTacVault script = new DeployTacVault();
        script.deployAll();
        address synth = script.synthOf(D.USD_VAULT);
        address other = makeAddr("other");
        // A cross-chain link cannot be attached to a plain token.
        vm.prank(other);
        vm.expectRevert();
        IV1c(V1).registerWrappedAuto(synth, bytes32(uint256(1)));
        // Registering first yields the id the script expects, and the script then reads back the same entry.
        vm.prank(other);
        bytes32 id = IV1c(V1).registerWrappedAuto(synth, bytes32(0));
        assertEq(id, script.assetIdOf(synth));
        // A pair created first is the same pool, empty, and a pair at another fee is a different one.
        vm.prank(other);
        bytes32 pid = IV1c(V1).createPair(TAC_ASSET, id, 30, 0, bytes32(0), 0);
        assertEq(pid, _poolId(TAC_ASSET, id));
        vm.prank(other);
        bytes32 pid2 = IV1c(V1).createPair(TAC_ASSET, id, 100, 0, bytes32(0), 0);
        assertTrue(pid2 != pid);
        (bool init,,, uint256 ra, uint256 rb,,) = IV1c(V1).pools(pid);
        assertTrue(init);
        assertEq(ra + rb, 0, "an empty pair: the first funder sets the ratio");
        script.registerAll();
        script.verifyAll();
    }
}

interface ICreateXTest {
    function deployCreate2(bytes32 salt, bytes memory initCode) external payable returns (address);
}
