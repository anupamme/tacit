// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacVaultZap} from "../src/TacVaultZap.sol";
import {FixedFeed} from "../src/FixedFeed.sol";

interface IPrecisionReserves {
    function reserve0() external view returns (uint128);
    function reserve1() external view returns (uint128);
    function totalSupply() external view returns (uint256);
}

interface IPoolRegistry {
    function registerWrappedAuto(address underlying, bytes32 crossChainLink) external returns (bytes32 assetId);
    function createPair(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint8 rcptPrefix,
        bytes32 rcptX,
        uint32 protocolFeeBps
    ) external returns (bytes32 poolId);
    function assets(bytes32 assetId) external view returns (bool, address, uint256, bytes32, bool, uint8);
    function pools(bytes32 poolId)
        external
        view
        returns (bool, bytes32, bytes32, uint256 reserveA, uint256 reserveB, uint32, uint256);
}

/// @notice Mainnet deployment: a TacPairOracle over the two TAC/ETH venues (the Precision pool and the confidential
///         pool's AMM pool), a dollar vault (ETH/USD feed) and an ETH vault (FixedFeed) sharing it, a TacitEvmPool and
///         router for TAC and each synth, and a zap per vault. Then it registers both synths in the confidential pool
///         and creates the TAC/USD, TAC/ETH-synth, ETH/ETH-synth, USD/ETH-synth and USD/cUSD pairs; an entry that
///         already exists is kept. Run without `--broadcast` to simulate.
///
///         Next, run tools/tac-vault-keeper.mjs with ORACLE set to the two venue oracles printed; borrowing opens
///         once every interval of the longest window is recorded.
///
/// Env (defaults in brackets):
///   OWNER (required)                         the vaults' owner, the ops multisig
///   FEE_TO, TAC_SINK [OWNER]                 borrow-fee recipient, absorbed-TAC recipient
///   USD_NAME, USD_SYMBOL [TAC Dollar, TACD]  ETH_NAME, ETH_SYMBOL [TAC Ether, TACE]
///   USD_CEILING, ETH_CEILING [no limit]      USD_MIN_DEBT [100e18], ETH_MIN_DEBT [0.04e18]
///   DEPTH_BPS [15]                           each vault's share of the smaller venue's ETH depth
///   MINT_RATIO_BPS [35000], LIQ_RATIO_BPS [20000], LIQ_BONUS_BPS [4000]
///   AUCTION_DURATION [3600], OWNER_WINDOW [1800] seconds
///   BORROW_FEE_BPS [100], REDEMPTION_FEE_BPS [50], FEED_MAX_STALENESS [3900]
///   ORACLE_SHORT_WINDOW [7200], ORACLE_WINDOW [21600], ORACLE_MAX_WINDOW [28800] seconds, ORACLE_COVERAGE_BPS [6600]
contract DeployTacVault is Script {
    address constant POOL = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    address constant PRECISION = 0x0155358241411dB868BA714aE7c83A27087e3D6E;
    // The confidential pool's ETH/TAC AMM pool, and the slot of its `pools` mapping in the confidential pool.
    bytes32 constant TAC_ETH_POOL = 0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00;
    uint256 constant POOLS_SLOT = 74;
    address constant ETH_USD = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;
    bytes32 constant ETH_ASSET = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    // The confidential pool's id for cUSD (the CollateralEngine's dollar; its ERC-20 form is tacUSD).
    bytes32 constant CUSD_ASSET = 0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d;
    address constant VERIFIER = 0x000000b1c0e84CEc8AdF8278B90c4d6400DfB153;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POSEIDON4 = 0x555333f3f677Ca3930Bf7c56ffc75144c51D9767;

    struct Out {
        address oracle;
        address precisionOracle;
        address ammOracle;
        TacVault usd;
        TacVault eth;
        address tacPool;
        address tacRouter;
        address usdPool;
        address usdRouter;
        address ethPool;
        address ethRouter;
        address usdZap;
        address ethZap;
        bytes32 usdAsset;
        bytes32 ethAsset;
    }

    function run() external {
        require(block.chainid == 1, "mainnet only");
        Out memory o;
        vm.startBroadcast();
        // Intervals of 50 blocks (10 minutes).
        uint256 shortWindow = vm.envOr("ORACLE_SHORT_WINDOW", uint256(7_200));
        uint256 window = vm.envOr("ORACLE_WINDOW", uint256(21_600));
        uint256 maxWindow = vm.envOr("ORACLE_MAX_WINDOW", uint256(28_800));
        uint256 coverage = vm.envOr("ORACLE_COVERAGE_BPS", uint256(6_600));
        o.precisionOracle = address(new TacBlockOracle(PRECISION, TAC, 50, shortWindow, window, maxWindow, coverage));
        o.ammOracle = address(
            new TacAmmOracle(
                POOL, TAC_ETH_POOL, ETH_ASSET, TAC_ASSET, TAC, POOLS_SLOT, 50, shortWindow, window, maxWindow, coverage
            )
        );
        o.oracle = address(new TacPairOracle(o.precisionOracle, o.ammOracle));
        _checkReserveSlots(o.ammOracle);
        _checkPrecisionSlots(o.precisionOracle);
        o.usd = new TacVault(_config(o.oracle, ETH_USD, "USD", vm.envOr("USD_MIN_DEBT", uint256(100e18))));
        o.eth = new TacVault(
            _config(o.oracle, address(new FixedFeed()), "ETH", vm.envOr("ETH_MIN_DEBT", uint256(0.04e18)))
        );
        (o.tacPool, o.tacRouter) = _pool(TAC);
        (o.usdPool, o.usdRouter) = _pool(address(o.usd.SYNTH()));
        (o.ethPool, o.ethRouter) = _pool(address(o.eth.SYNTH()));
        o.usdZap = address(new TacVaultZap(address(o.usd), o.usdRouter));
        o.ethZap = address(new TacVaultZap(address(o.eth), o.ethRouter));

        // Registration and pairs are permissionless; an entry someone made first is kept.
        o.usdAsset = _register(address(o.usd.SYNTH()));
        o.ethAsset = _register(address(o.eth.SYNTH()));
        _pair(TAC_ASSET, o.usdAsset);
        _pair(TAC_ASSET, o.ethAsset);
        _pair(ETH_ASSET, o.ethAsset);
        _pair(o.usdAsset, o.ethAsset);
        _pair(o.usdAsset, CUSD_ASSET);
        vm.stopBroadcast();
        (bool usdRegistered,,,,,) = IPoolRegistry(POOL).assets(o.usdAsset);
        (bool ethRegistered,,,,,) = IPoolRegistry(POOL).assets(o.ethAsset);
        require(usdRegistered && ethRegistered, "synth not registered");

        console2.log("TacPairOracle  :", o.oracle);
        console2.log("Precision venue:", o.precisionOracle);
        console2.log("AMM venue      :", o.ammOracle);
        console2.log("USD vault      :", address(o.usd));
        console2.log("USD synth      :", address(o.usd.SYNTH()));
        console2.log("ETH vault      :", address(o.eth));
        console2.log("ETH synth      :", address(o.eth.SYNTH()));
        console2.log("TAC pool/router:", o.tacPool, o.tacRouter);
        console2.log("USD pool/router:", o.usdPool, o.usdRouter);
        console2.log("ETH pool/router:", o.ethPool, o.ethRouter);
        console2.log("USD zap / ETH zap:", o.usdZap, o.ethZap);
        console2.log("Next: tools/tac-vault-keeper.mjs with ORACLE=<Precision venue>,<AMM venue>");
    }

    function _config(address oracle, address feed, string memory tag, uint256 minDebt)
        internal
        view
        returns (TacVault.Config memory c)
    {
        bool usd = keccak256(bytes(tag)) == keccak256("USD");
        c = TacVault.Config({
            tac: TAC,
            oracle: oracle,
            ethUsd: feed,
            owner: vm.envAddress("OWNER"),
            mintRatioBps: vm.envOr("MINT_RATIO_BPS", uint256(35_000)),
            liqRatioBps: vm.envOr("LIQ_RATIO_BPS", uint256(20_000)),
            liqBonusBps: vm.envOr("LIQ_BONUS_BPS", uint256(4_000)),
            auctionDuration: vm.envOr("AUCTION_DURATION", uint256(3_600)),
            ownerWindow: vm.envOr("OWNER_WINDOW", uint256(1_800)),
            minDebt: minDebt,
            feedMaxStaleness: vm.envOr("FEED_MAX_STALENESS", uint256(3900)),
            debtCeiling: vm.envOr(usd ? "USD_CEILING" : "ETH_CEILING", type(uint256).max),
            depthBps: vm.envOr("DEPTH_BPS", uint256(15)),
            redemptionFeeBps: vm.envOr("REDEMPTION_FEE_BPS", uint256(50)),
            borrowFeeBps: vm.envOr("BORROW_FEE_BPS", uint256(100)),
            feeTo: vm.envOr("FEE_TO", vm.envAddress("OWNER")),
            tacSink: vm.envOr("TAC_SINK", vm.envAddress("OWNER")),
            name: vm.envOr(usd ? "USD_NAME" : "ETH_NAME", string(usd ? "TAC Dollar" : "TAC Ether")),
            symbol: vm.envOr(usd ? "USD_SYMBOL" : "ETH_SYMBOL", string(usd ? "TACD" : "TACE"))
        });
    }

    // The slots the AMM oracle proves hold the pool's reserves today.
    function _checkReserveSlots(address ammOracle) internal view {
        (bytes32 slotA, bytes32 slotB) = TacAmmOracle(ammOracle).slots();
        (,,, uint256 reserveA, uint256 reserveB,,) = IPoolRegistry(POOL).pools(TAC_ETH_POOL);
        require(uint256(vm.load(POOL, slotA)) == reserveA && uint256(vm.load(POOL, slotB)) == reserveB, "reserve slots");
    }

    // The slots the Precision oracle proves hold the pool's packed reserves and the LP supply today.
    function _checkPrecisionSlots(address precisionOracle) internal view {
        (bytes32 slotReserves, bytes32 slotSupply) = TacBlockOracle(precisionOracle).slots();
        IPrecisionReserves p = IPrecisionReserves(PRECISION);
        uint256 packed = uint256(p.reserve0()) | uint256(p.reserve1()) << 128;
        require(uint256(vm.load(PRECISION, slotReserves)) == packed, "precision reserve slot");
        require(uint256(vm.load(PRECISION, slotSupply)) == p.totalSupply(), "precision supply slot");
    }

    function _pool(address asset) internal returns (address pool, address router) {
        // From artifacts: the pool and router keep the compiler (0.8.36) of the live ones.
        pool = deployCode("TacitEvmPool.sol:TacitEvmPool", abi.encode(VERIFIER, asset));
        router = deployCode(
            "TacitEvmPoolRouter.sol:TacitEvmPoolRouter", abi.encode(pool, ZROUTER, PERMIT2, POOL, POSEIDON4)
        );
    }

    // The confidential pool's id for an external ERC-20. If someone registered it first, the entry must be for this
    // token with no cross-chain link.
    function _register(address token) internal returns (bytes32 id) {
        try IPoolRegistry(POOL).registerWrappedAuto(token, bytes32(0)) returns (bytes32 got) {
            id = got;
        } catch {
            id = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), token));
        }
        (bool registered, address underlying,, bytes32 link,,) = IPoolRegistry(POOL).assets(id);
        require(registered && underlying == token && link == bytes32(0), "synth registration");
    }

    function _pair(bytes32 a, bytes32 b) internal {
        try IPoolRegistry(POOL).createPair(a, b, 30, 0, bytes32(0), 0) {} catch {}
    }
}
