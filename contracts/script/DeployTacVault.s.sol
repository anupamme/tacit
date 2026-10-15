// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacVaultZap} from "../src/TacVaultZap.sol";
import {FixedFeed} from "../src/FixedFeed.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter} from "../src/TacitEvmPoolRouter.sol";

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

/// @notice Deploys, on Ethereum mainnet, an oracle over both TAC/ETH venues (the Precision pool and the confidential
///         pool's AMM pool) and two TacVaults that share it: one lending a dollar (through the ETH/USD feed) and one
///         lending ETH (through a FixedFeed). For TAC and each synth it deploys a TacitEvmPool and router (the live
///         contracts and verifier), and a zap per vault. Last, it registers both synths in the confidential pool and
///         creates the TAC/USD, TAC/ETH-synth, ETH/ETH-synth, USD/ETH-synth and USD/cUSD pairs there (the last lets
///         a dollar borrowed against TAC move into cUSD and its pools); anyone may do these first, and an existing
///         entry is used as it is.
///
///         After deploying, run tools/tac-vault-keeper.mjs with ORACLE set to the two venue oracles it prints: it
///         records the past hours of intervals at once and every new one after. Both vaults start with the largest
///         debt ceiling: what they lend is held to DEPTH_BPS of the smaller venue's ETH depth over the last hours
///         (nothing until every interval of that window is recorded), so it grows and shrinks with the pools. The
///         owner may set a lower ceiling and lift it again. The reserve that absorbs bad debt is SYNTH sent to a
///         vault, and only an absorb spends it; keep it in step with the debt, from a dedicated treasury vault that is
///         never meant to close. Run without `--broadcast` to simulate.
///
/// Env:
///   OWNER                 (required) the vaults' owner (the ops multisig)
///   FEE_TO                (default OWNER)   where borrow fees, in SYNTH, go first (the owner may change it)
///   TAC_SINK              (default OWNER)   where absorbed TAC goes first (the owner may change it)
///   USD_NAME / USD_SYMBOL (default "TAC Dollar" / TACD) the dollar synth's ERC-20 name and symbol
///   ETH_NAME / ETH_SYMBOL (default "TAC Ether" / TACE) the ETH synth's ERC-20 name and symbol
///   USD_CEILING           (default no limit) dollar vault debt ceiling set by the owner
///   ETH_CEILING           (default no limit) ETH vault debt ceiling set by the owner
///   USD_MIN_DEBT          (default 100e18)  smallest dollar debt
///   ETH_MIN_DEBT          (default 0.04e18) smallest ETH debt
///   DEPTH_BPS             (default 250)     each vault's total debt at most this share of the pool's ETH depth (both
///                                           vaults read the same depth, so together they lend twice this share)
///   BORROW_FEE_BPS        (default 100)     one-time borrow fee, both vaults
///   MINT_RATIO_BPS        (default 35000), LIQ_RATIO_BPS (default 20000), LIQ_BONUS_BPS (default 2500)
///   ORACLE_SHORT_WINDOW (7200), ORACLE_WINDOW (10800), ORACLE_MAX_WINDOW (21600) seconds, ORACLE_COVERAGE_BPS (6600):
///                         the oracle's windows (the longest is at most 127 intervals of 600 s)
///   LIQ_WINDOW            (default ORACLE_MAX_WINDOW, must equal it), AUCTION_DURATION (default 5400)
///   OWNER_WINDOW          (default 3600)    seconds an auction is open to its owner alone
///   REDEMPTION_FEE_BPS    (default 50)
///   FEED_MAX_STALENESS    (default 3900)
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
        // An interval of 50 blocks (10 minutes); windows of 2 hours, 3 hours (the borrow view's slowest) and 6 hours
        // (the liquidation window, the longest) unless the environment says otherwise; a window needs two thirds of
        // its intervals.
        uint256 shortWindow = vm.envOr("ORACLE_SHORT_WINDOW", uint256(7_200));
        uint256 window = vm.envOr("ORACLE_WINDOW", uint256(10_800));
        uint256 maxWindow = vm.envOr("ORACLE_MAX_WINDOW", uint256(21_600));
        uint256 coverage = vm.envOr("ORACLE_COVERAGE_BPS", uint256(6_600));
        o.precisionOracle = address(new TacBlockOracle(PRECISION, TAC, 50, shortWindow, window, maxWindow, coverage));
        o.ammOracle = address(
            new TacAmmOracle(
                POOL, TAC_ETH_POOL, ETH_ASSET, TAC_ASSET, TAC, POOLS_SLOT, 50, shortWindow, window, maxWindow, coverage
            )
        );
        o.oracle = address(new TacPairOracle(o.precisionOracle, o.ammOracle));
        _checkReserveSlots(o.ammOracle);
        o.usd = new TacVault(_config(o.oracle, ETH_USD, "USD", vm.envOr("USD_MIN_DEBT", uint256(100e18))));
        o.eth = new TacVault(
            _config(o.oracle, address(new FixedFeed()), "ETH", vm.envOr("ETH_MIN_DEBT", uint256(0.04e18)))
        );
        (o.tacPool, o.tacRouter) = _pool(TAC);
        (o.usdPool, o.usdRouter) = _pool(address(o.usd.SYNTH()));
        (o.ethPool, o.ethRouter) = _pool(address(o.eth.SYNTH()));
        o.usdZap = address(new TacVaultZap(address(o.usd), o.usdRouter));
        o.ethZap = address(new TacVaultZap(address(o.eth), o.ethRouter));

        // Last: registration and pairs are permissionless, so an entry made first by anyone is kept.
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
        console2.log(
            "NEXT: run tools/tac-vault-keeper.mjs with ORACLE=<Precision venue>,<AMM venue>; lending opens once it has recorded the window"
        );
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
            liqWindow: vm.envOr("LIQ_WINDOW", vm.envOr("ORACLE_MAX_WINDOW", uint256(21_600))),
            liqBonusBps: vm.envOr("LIQ_BONUS_BPS", uint256(2_500)),
            auctionDuration: vm.envOr("AUCTION_DURATION", uint256(5_400)),
            ownerWindow: vm.envOr("OWNER_WINDOW", uint256(3_600)),
            minDebt: minDebt,
            feedMaxStaleness: vm.envOr("FEED_MAX_STALENESS", uint256(3900)),
            debtCeiling: vm.envOr(usd ? "USD_CEILING" : "ETH_CEILING", type(uint256).max),
            depthBps: vm.envOr("DEPTH_BPS", uint256(250)),
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

    function _pool(address asset) internal returns (address pool, address router) {
        pool = address(new TacitEvmPool(VERIFIER, asset));
        router = address(new TacitEvmPoolRouter(pool, ZROUTER, PERMIT2, POOL, POSEIDON4));
    }

    // The confidential pool's id for an external ERC-20, used when the token is already registered.
    function _register(address token) internal returns (bytes32 id) {
        try IPoolRegistry(POOL).registerWrappedAuto(token, bytes32(0)) returns (bytes32 got) {
            id = got;
        } catch {
            id = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), token));
        }
    }

    function _pair(bytes32 a, bytes32 b) internal {
        try IPoolRegistry(POOL).createPair(a, b, 30, 0, bytes32(0), 0) {} catch {}
    }
}
