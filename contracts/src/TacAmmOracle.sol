// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {TacIntervalOracle} from "./TacIntervalOracle.sol";

interface IConfidentialPoolReserves {
    function pools(bytes32 poolId)
        external
        view
        returns (
            bool init,
            bytes32 assetA,
            bytes32 assetB,
            uint256 reserveA,
            uint256 reserveB,
            uint32 feeBps,
            uint256 totalShares
        );
    function assets(bytes32 assetId)
        external
        view
        returns (
            bool registered,
            address underlying,
            uint256 unitScale,
            bytes32 crossChainLink,
            bool poolMinted,
            uint8 decimals
        );
}

/// @title TacAmmOracle
/// @notice TacIntervalOracle over the confidential pool's ETH/TAC AMM pool. Proves reserveA (ETH) and reserveB
///         (TAC), at offsets 3 and 4 of POOL_ID's entry in the `pools` mapping (slot 74 on the live pool), scaled from
///         value units to wei by each asset's unit scale. Price = ETH reserve / TAC reserve, depth = ETH reserve.
contract TacAmmOracle is TacIntervalOracle {
    uint256 internal constant WAD = 1e18;

    bytes32 public immutable POOL_ID;
    uint256 internal immutable ETH_SCALE;
    uint256 internal immutable TAC_SCALE;
    bytes32 internal immutable SLOT_A;
    bytes32 internal immutable SLOT_B;

    constructor(
        address pool,
        bytes32 poolId,
        bytes32 ethAsset,
        bytes32 tacAsset,
        address tac,
        uint256 mappingSlot,
        uint256 step,
        uint256 shortWindow,
        uint256 window,
        uint256 maxWindow,
        uint256 minCoverageBps
    ) TacIntervalOracle(pool, step, shortWindow, window, maxWindow, minCoverageBps) {
        IConfidentialPoolReserves p = IConfidentialPoolReserves(pool);
        (bool init, bytes32 assetA, bytes32 assetB,,,,) = p.pools(poolId);
        if (!init || assetA != ethAsset || assetB != tacAsset) revert BadConfig();
        (bool ethRegistered, address ethUnderlying, uint256 ethScale,,,) = p.assets(ethAsset);
        (bool tacRegistered, address tacUnderlying, uint256 tacScale,,,) = p.assets(tacAsset);
        if (!ethRegistered || ethUnderlying != address(0) || !tacRegistered || tacUnderlying != tac) {
            revert BadConfig();
        }
        if (ethScale == 0 || tacScale == 0) revert BadConfig();
        POOL_ID = poolId;
        ETH_SCALE = ethScale;
        TAC_SCALE = tacScale;
        uint256 base = uint256(keccak256(abi.encode(poolId, mappingSlot)));
        SLOT_A = bytes32(base + 3);
        SLOT_B = bytes32(base + 4);
    }

    function slots() public view override returns (bytes32, bytes32) {
        return (SLOT_A, SLOT_B);
    }

    function spot() public view override returns (uint256 ethPerTac) {
        (,,, uint256 reserveA, uint256 reserveB,,) = IConfidentialPoolReserves(POOL).pools(POOL_ID);
        (ethPerTac,) = _read(reserveA, reserveB);
    }

    function _read(uint256 reserveA, uint256 reserveB) internal view override returns (uint256 ethPerTac, uint256 eth) {
        if (reserveA == 0 || reserveB == 0) revert BadBlock();
        eth = reserveA * ETH_SCALE;
        ethPerTac = FixedPointMathLib.fullMulDiv(eth, WAD, reserveB * TAC_SCALE);
    }
}
