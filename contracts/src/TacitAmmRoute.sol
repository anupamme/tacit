// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IRouteWeth {
    function balanceOf(address owner) external view returns (uint256);
    function withdraw(uint256 amount) external;
}

interface IRoutePool {
    function assets(bytes32 assetId)
        external
        view
        returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals);
}

interface IRouteAmm {
    function POOL() external view returns (IRoutePool);

    function swapPublic(
        bytes32 assetIn,
        bytes32 assetOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to
    ) external payable returns (uint256 amountOut);
}

/// @title TacitAmmRoute
/// @notice The last step of a swap that ends in the Tacit pool's public door, for a router that can hand WETH to an
///         executor (zRouter's `snwap` with the executor set to this contract): it unwraps the WETH it was handed and
///         swaps the ETH for `assetOut` through TacitPublicAmm, paid to `to`. The ETH is taken in the pool's steps and
///         what is left over goes to `to`. It holds nothing between calls, has no owner and no settings.
contract TacitAmmRoute {
    IRouteWeth public immutable WETH;
    IRouteAmm public immutable AMM;
    bytes32 public immutable ETH_ID;
    uint256 public immutable UNIT;

    error BadConfig();
    error BadRecipient();
    error NotWeth();
    error NothingToSwap();

    constructor(address amm, address weth, bytes32 ethId) {
        if (amm.code.length == 0 || weth.code.length == 0) revert BadConfig();
        (bool registered, address underlying, uint256 unit,,,) = IRouteAmm(amm).POOL().assets(ethId);
        if (!registered || underlying != address(0) || unit == 0) revert BadConfig();
        WETH = IRouteWeth(weth);
        AMM = IRouteAmm(amm);
        ETH_ID = ethId;
        UNIT = unit;
    }

    /// Unwraps all the WETH held here and swaps it, less what does not fill a step of the pool, for `assetOut`.
    /// The pool enforces `minOut` and `deadline`.
    function routeFromWETH(bytes32 assetOut, uint32 feeBps, uint256 minOut, uint64 deadline, address to)
        external
        returns (uint256 amountOut)
    {
        if (to == address(0) || to == address(this)) revert BadRecipient();
        uint256 weth = WETH.balanceOf(address(this));
        if (weth != 0) WETH.withdraw(weth);
        uint256 eth = address(this).balance;
        eth -= eth % UNIT;
        if (eth == 0) revert NothingToSwap();
        amountOut = AMM.swapPublic{value: eth}(ETH_ID, assetOut, feeBps, eth, minOut, deadline, to);
        uint256 rest = address(this).balance;
        if (rest != 0) SafeTransferLib.forceSafeTransferETH(to, rest);
    }

    receive() external payable {
        if (msg.sender != address(WETH)) revert NotWeth();
    }
}
