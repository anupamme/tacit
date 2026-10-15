// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {TacIntervalOracle} from "./TacIntervalOracle.sol";

interface IPrecisionPool {
    function reserve0() external view returns (uint128);
    function reserve1() external view returns (uint128);
    function totalSupply() external view returns (uint256);
    function sqrtPLow() external view returns (uint256);
    function sqrtPHigh() external view returns (uint256);
    function tapePair() external view returns (address base, address quote);
}

/// @title TacBlockOracle
/// @notice TacIntervalOracle over the ETH/TAC Precision pool. Proves the packed reserves (slot 0: reserve0 in the
///         low 128 bits, reserve1 in the high) and the LP supply L (solady's total-supply slot). Price and depth are
///         the pool's own, with virtual reserves: ETH = L·1e18/sqrtPHigh + reserve0, TAC = L·sqrtPLow/1e18 +
///         reserve1, price = ETH/TAC, depth = ETH.
contract TacBlockOracle is TacIntervalOracle {
    uint256 internal constant WAD = 1e18;
    bytes32 internal constant RESERVES_SLOT = bytes32(0);
    bytes32 internal constant SUPPLY_SLOT = bytes32(uint256(0x05345cdf77eb68f44c));

    uint256 internal immutable SQRT_P_LOW;
    uint256 internal immutable SQRT_P_HIGH;

    constructor(
        address pool,
        address tac,
        uint256 step,
        uint256 shortWindow,
        uint256 window,
        uint256 maxWindow,
        uint256 minCoverageBps
    ) TacIntervalOracle(pool, step, shortWindow, window, maxWindow, minCoverageBps) {
        (address base, address quote) = IPrecisionPool(pool).tapePair();
        if (base != address(0) || quote != tac) revert BadConfig();
        SQRT_P_LOW = IPrecisionPool(pool).sqrtPLow();
        SQRT_P_HIGH = IPrecisionPool(pool).sqrtPHigh();
        if (SQRT_P_LOW == 0 || SQRT_P_HIGH <= SQRT_P_LOW) revert BadConfig();
    }

    function slots() public pure override returns (bytes32, bytes32) {
        return (RESERVES_SLOT, SUPPLY_SLOT);
    }

    function spot() public view override returns (uint256 ethPerTac) {
        IPrecisionPool p = IPrecisionPool(POOL);
        (ethPerTac,) = _price(p.totalSupply(), p.reserve0(), p.reserve1());
    }

    function _read(uint256 reserves, uint256 supply) internal view override returns (uint256, uint256) {
        return _price(supply, uint128(reserves), reserves >> 128);
    }

    function _price(uint256 supply, uint256 r0, uint256 r1) internal view returns (uint256 ethPerTac, uint256 eth) {
        eth = supply * WAD / SQRT_P_HIGH + r0;
        uint256 tac = supply * SQRT_P_LOW / WAD + r1;
        if (supply == 0 || tac == 0) revert BadBlock();
        ethPerTac = FixedPointMathLib.fullMulDiv(eth, WAD, tac);
    }
}
