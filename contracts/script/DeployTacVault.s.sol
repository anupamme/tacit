// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacVaultZap} from "../src/TacVaultZap.sol";
import {TacVaultsDeployment as D} from "./TacVaultsDeployment.sol";

interface ICreateX2 {
    function deployCreate2(bytes32 salt, bytes memory initCode) external payable returns (address newContract);
}

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

/// @notice Anyone's deployment of the TAC vaults on Ethereum mainnet: two venue oracles and their pair, a dollar vault
///         and an ETH vault, a TacitEvmPool and router for TAC and each synth, and a zap per vault, then both synths'
///         registration in the confidential pool and five pairs there (TAC/dollar, TAC/ETH-synth, ETH/ETH-synth,
///         dollar/ETH-synth, dollar/cUSD).
///
///         Each contract is deployed with CreateX.deployCreate2 from a salt tied to no sender and to this chain, at an
///         address with leading zero bytes fixed in `TacVaultsDeployment.sol` (made by tools/tac-vaults-plan.mjs).
///         The address is CREATE2(CreateX, keccak256(abi.encode(chainId, salt)), keccak256(init code)), so it commits
///         to the init code, constructor arguments and the owner included: nobody can put different code or a
///         different owner at these addresses, nobody can take them on another chain, and the sender has no power
///         over what lands there. The script rebuilds every init code from the compiled
///         contracts and refuses to send one whose hash or address differs from the plan. A step is skipped if its
///         contract is already there, so a partial or repeated run is safe, and the registry steps are checked for
///         their exact terms.
///
///         The contracts must be built with the project's settings (solc 0.8.37 for the vault family and 0.8.36 for
///         the pool and router; via-IR, optimizer runs 1, no metadata hash) or the hashes differ and nothing is sent.
///
///         forge script script/DeployTacVault.s.sol --rpc-url $RPC --broadcast --account <any funded account>
contract DeployTacVault is Script {
    struct Step {
        string name;
        bytes32 salt;
        bytes32 hash;
        address expected;
        bytes initCode;
    }

    uint32 internal constant PAIR_FEE_BPS = 30;

    function run() external {
        vm.startBroadcast();
        deployAll();
        registerAll();
        vm.stopBroadcast();
        verifyAll();
        console2.log("Next: tools/tac-vault-keeper.mjs with ORACLE=%s,%s", D.PRECISION_ORACLE, D.AMM_ORACLE);
    }

    // ─────────────── the contracts ───────────────

    function deployAll() public {
        require(block.chainid == 1, "mainnet only");
        require(D.CREATEX.code.length != 0, "CreateX is not on this chain");
        Step[14] memory s = steps();
        for (uint256 i; i < s.length; ++i) {
            require(
                keccak256(s[i].initCode) == s[i].hash, string.concat(s[i].name, ": init code differs from the plan")
            );
            require(
                predict(s[i].salt, s[i].hash) == s[i].expected, string.concat(s[i].name, ": salt and address differ")
            );
            if (s[i].expected.code.length != 0) {
                console2.log("already there:", s[i].name, s[i].expected);
                continue;
            }
            address got = ICreateX2(D.CREATEX).deployCreate2(s[i].salt, s[i].initCode);
            require(got == s[i].expected, string.concat(s[i].name, ": landed elsewhere"));
            console2.log("deployed:", s[i].name, got);
        }
    }

    /// The address CreateX gives `initCodeHash` under `salt`. A salt that starts with 20 zero bytes and the flag 0x01
    /// is bound to the chain: CreateX hashes it with the chain id, and the result is the CREATE2 salt.
    function predict(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        require(bytes20(salt) == bytes20(0) && uint8(salt[20]) == 1, "salt form");
        bytes32 guarded = keccak256(abi.encode(block.chainid, salt));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), D.CREATEX, guarded, initCodeHash)))));
    }

    /// Every init code, in the order they must land: later ones take earlier addresses as arguments.
    function steps() public view returns (Step[14] memory s) {
        s[0] = _step(
            "PRECISION_ORACLE",
            D.SALT_PRECISION_ORACLE,
            D.HASH_PRECISION_ORACLE,
            D.PRECISION_ORACLE,
            "TacBlockOracle.sol:TacBlockOracle",
            abi.encode(
                D.PRECISION_POOL,
                D.TAC,
                D.ORACLE_STEP,
                D.ORACLE_SHORT_WINDOW,
                D.ORACLE_WINDOW,
                D.ORACLE_MAX_WINDOW,
                D.ORACLE_COVERAGE_BPS
            )
        );
        s[1] = _step(
            "AMM_ORACLE",
            D.SALT_AMM_ORACLE,
            D.HASH_AMM_ORACLE,
            D.AMM_ORACLE,
            "TacAmmOracle.sol:TacAmmOracle",
            abi.encode(
                D.CONFIDENTIAL_POOL,
                D.AMM_POOL_ID,
                D.ETH_ASSET,
                D.TAC_ASSET,
                D.TAC,
                D.POOLS_SLOT,
                D.ORACLE_STEP,
                D.ORACLE_SHORT_WINDOW,
                D.ORACLE_WINDOW,
                D.ORACLE_MAX_WINDOW,
                D.ORACLE_COVERAGE_BPS
            )
        );
        s[2] = _step(
            "PAIR_ORACLE",
            D.SALT_PAIR_ORACLE,
            D.HASH_PAIR_ORACLE,
            D.PAIR_ORACLE,
            "TacPairOracle.sol:TacPairOracle",
            abi.encode(D.PRECISION_ORACLE, D.AMM_ORACLE)
        );
        s[3] = _step("ETH_FEED", D.SALT_ETH_FEED, D.HASH_ETH_FEED, D.ETH_FEED, "FixedFeed.sol:FixedFeed", "");
        s[4] = _step(
            "USD_VAULT",
            D.SALT_USD_VAULT,
            D.HASH_USD_VAULT,
            D.USD_VAULT,
            "TacVault.sol:TacVault",
            abi.encode(_vaultConfig(D.ETH_USD, D.USD_NAME, D.USD_SYMBOL, D.USD_MIN_DEBT))
        );
        s[5] = _step(
            "ETH_VAULT",
            D.SALT_ETH_VAULT,
            D.HASH_ETH_VAULT,
            D.ETH_VAULT,
            "TacVault.sol:TacVault",
            abi.encode(_vaultConfig(D.ETH_FEED, D.ETH_NAME, D.ETH_SYMBOL, D.ETH_MIN_DEBT))
        );
        s[6] = _pool("TAC_POOL", D.SALT_TAC_POOL, D.HASH_TAC_POOL, D.TAC_POOL, D.TAC);
        s[7] = _router("TAC_ROUTER", D.SALT_TAC_ROUTER, D.HASH_TAC_ROUTER, D.TAC_ROUTER, D.TAC_POOL);
        s[8] = _pool("USD_POOL", D.SALT_USD_POOL, D.HASH_USD_POOL, D.USD_POOL, synthOf(D.USD_VAULT));
        s[9] = _router("USD_ROUTER", D.SALT_USD_ROUTER, D.HASH_USD_ROUTER, D.USD_ROUTER, D.USD_POOL);
        s[10] = _pool("ETH_POOL", D.SALT_ETH_POOL, D.HASH_ETH_POOL, D.ETH_POOL, synthOf(D.ETH_VAULT));
        s[11] = _router("ETH_ROUTER", D.SALT_ETH_ROUTER, D.HASH_ETH_ROUTER, D.ETH_ROUTER, D.ETH_POOL);
        s[12] = _step(
            "USD_ZAP",
            D.SALT_USD_ZAP,
            D.HASH_USD_ZAP,
            D.USD_ZAP,
            "TacVaultZap.sol:TacVaultZap",
            abi.encode(D.USD_VAULT, D.USD_ROUTER)
        );
        s[13] = _step(
            "ETH_ZAP",
            D.SALT_ETH_ZAP,
            D.HASH_ETH_ZAP,
            D.ETH_ZAP,
            "TacVaultZap.sol:TacVaultZap",
            abi.encode(D.ETH_VAULT, D.ETH_ROUTER)
        );
    }

    /// A vault's synth is the first contract it creates.
    function synthOf(address vault) public pure returns (address) {
        return vm.computeCreateAddress(vault, 1);
    }

    function _step(
        string memory name,
        bytes32 salt,
        bytes32 hash,
        address expected,
        string memory artifact,
        bytes memory args
    ) internal view returns (Step memory) {
        return Step(name, salt, hash, expected, abi.encodePacked(vm.getCode(artifact), args));
    }

    // The pool and router are the live contracts' source, built with the compiler they were deployed with.
    function _pool(string memory name, bytes32 salt, bytes32 hash, address expected, address asset)
        internal
        view
        returns (Step memory)
    {
        return _step(name, salt, hash, expected, "TacitEvmPool.sol:TacitEvmPool", abi.encode(D.VERIFIER, asset));
    }

    function _router(string memory name, bytes32 salt, bytes32 hash, address expected, address pool)
        internal
        view
        returns (Step memory)
    {
        return _step(
            name,
            salt,
            hash,
            expected,
            "TacitEvmPoolRouter.sol:TacitEvmPoolRouter",
            abi.encode(pool, D.ZROUTER, D.PERMIT2, D.CONFIDENTIAL_POOL, D.POSEIDON4)
        );
    }

    function _vaultConfig(address feed, string memory name, string memory symbol, uint256 minDebt)
        internal
        pure
        returns (TacVault.Config memory c)
    {
        c = TacVault.Config({
            tac: D.TAC,
            oracle: D.PAIR_ORACLE,
            ethUsd: feed,
            owner: D.OWNER,
            mintRatioBps: D.MINT_RATIO_BPS,
            liqRatioBps: D.LIQ_RATIO_BPS,
            liqBonusBps: D.LIQ_BONUS_BPS,
            auctionDuration: D.AUCTION_DURATION,
            ownerWindow: D.OWNER_WINDOW,
            minDebt: minDebt,
            feedMaxStaleness: D.FEED_MAX_STALENESS,
            debtCeiling: D.DEBT_CEILING,
            depthBps: D.DEPTH_BPS,
            redemptionFeeBps: D.REDEMPTION_FEE_BPS,
            borrowFeeBps: D.BORROW_FEE_BPS,
            feeTo: D.FEE_TO,
            tacSink: D.TAC_SINK,
            name: name,
            symbol: symbol
        });
    }

    // ─────────────── the confidential pool ───────────────

    /// Registers both synths and creates the five pairs, each only if it is not already there. Registration and pair
    /// creation are open to anyone and their terms are fixed by the call (a plain token takes no cross-chain link,
    /// and a pair's id includes its fee), so an entry made first is the same entry; what is read back is checked.
    function registerAll() public {
        bytes32 usd = _register(synthOf(D.USD_VAULT));
        bytes32 eth = _register(synthOf(D.ETH_VAULT));
        _pair(D.TAC_ASSET, usd);
        _pair(D.TAC_ASSET, eth);
        _pair(D.ETH_ASSET, eth);
        _pair(usd, eth);
        _pair(usd, D.CUSD_ASSET);
    }

    /// The confidential pool's id for a plain ERC-20.
    function assetIdOf(address token) public view returns (bytes32) {
        return sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), token));
    }

    /// The id of the pair's pool at PAIR_FEE_BPS with no fee skim.
    function poolIdOf(bytes32 a, bytes32 b) public pure returns (bytes32) {
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(lo, hi, uint256(PAIR_FEE_BPS)));
    }

    function _register(address token) internal returns (bytes32 id) {
        IPoolRegistry registry = IPoolRegistry(D.CONFIDENTIAL_POOL);
        id = assetIdOf(token);
        (bool registered,,,,,) = registry.assets(id);
        if (!registered) require(registry.registerWrappedAuto(token, bytes32(0)) == id, "asset id");
        (bool found, address underlying, uint256 scale, bytes32 link, bool poolMinted, uint8 decimals) =
            registry.assets(id);
        require(
            found && underlying == token && link == bytes32(0) && !poolMinted && scale == 1e10 && decimals == 18,
            "synth registration"
        );
    }

    function _pair(bytes32 a, bytes32 b) internal {
        IPoolRegistry registry = IPoolRegistry(D.CONFIDENTIAL_POOL);
        bytes32 id = poolIdOf(a, b);
        (bool init,,,,,,) = registry.pools(id);
        if (!init) require(registry.createPair(a, b, PAIR_FEE_BPS, 0, bytes32(0), 0) == id, "pool id");
        (bool found, bytes32 lo, bytes32 hi,,, uint32 fee,) = registry.pools(id);
        require(found && fee == PAIR_FEE_BPS && lo == (a < b ? a : b) && hi == (a < b ? b : a), "pair terms");
    }

    // ─────────────── what must be true afterwards ───────────────

    function verifyAll() public view {
        Step[14] memory s = steps();
        for (uint256 i; i < s.length; ++i) {
            require(s[i].expected.code.length != 0, string.concat(s[i].name, ": not deployed"));
        }
        TacVault usd = TacVault(D.USD_VAULT);
        TacVault eth = TacVault(D.ETH_VAULT);
        require(usd.owner() == D.OWNER && eth.owner() == D.OWNER, "owner");
        require(usd.TAC() == D.TAC && eth.TAC() == D.TAC, "TAC");
        require(address(usd.ORACLE()) == D.PAIR_ORACLE && address(eth.ORACLE()) == D.PAIR_ORACLE, "oracle");
        require(address(usd.ETH_USD()) == D.ETH_USD && address(eth.ETH_USD()) == D.ETH_FEED, "feed");
        require(address(usd.SYNTH()) == synthOf(D.USD_VAULT) && address(eth.SYNTH()) == synthOf(D.ETH_VAULT), "synth");
        require(usd.DEPTH_BPS() == D.DEPTH_BPS && eth.DEPTH_BPS() == D.DEPTH_BPS, "depth share");
        TacPairOracle pair = TacPairOracle(D.PAIR_ORACLE);
        require(address(pair.A()) == D.PRECISION_ORACLE && address(pair.B()) == D.AMM_ORACLE, "venues");
        require(address(TacVaultZap(D.USD_ZAP).VAULT()) == D.USD_VAULT, "USD zap vault");
        require(address(TacVaultZap(D.ETH_ZAP).VAULT()) == D.ETH_VAULT, "ETH zap vault");
        require(address(TacVaultZap(D.USD_ZAP).SYNTH_ROUTER()) == D.USD_ROUTER, "USD zap router");
        require(address(TacVaultZap(D.ETH_ZAP).SYNTH_ROUTER()) == D.ETH_ROUTER, "ETH zap router");
        _checkVenueSlots();
    }

    // The slots each venue oracle proves hold the live pool's reserves, and the Precision pool's LP supply, today: a
    // wrong slot would record a plausible but wrong price.
    function _checkVenueSlots() internal view {
        (bytes32 slotA, bytes32 slotB) = TacAmmOracle(D.AMM_ORACLE).slots();
        (,,, uint256 reserveA, uint256 reserveB,,) = IPoolRegistry(D.CONFIDENTIAL_POOL).pools(D.AMM_POOL_ID);
        require(
            uint256(vm.load(D.CONFIDENTIAL_POOL, slotA)) == reserveA
                && uint256(vm.load(D.CONFIDENTIAL_POOL, slotB)) == reserveB,
            "AMM reserve slots"
        );
        (bytes32 slotReserves, bytes32 slotSupply) = TacBlockOracle(D.PRECISION_ORACLE).slots();
        IPrecisionReserves p = IPrecisionReserves(D.PRECISION_POOL);
        require(
            uint256(vm.load(D.PRECISION_POOL, slotReserves)) == uint256(p.reserve0()) | uint256(p.reserve1()) << 128,
            "Precision reserve slot"
        );
        require(uint256(vm.load(D.PRECISION_POOL, slotSupply)) == p.totalSupply(), "Precision supply slot");
    }
}
