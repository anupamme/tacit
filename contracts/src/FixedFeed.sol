// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title FixedFeed
/// @notice A price feed that always answers 1.0 (8 decimals), fresh at every block. A TacVault given it in place of
///         ETH/USD values TAC in ETH, so its SYNTH tracks one ETH.
contract FixedFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 1e8, block.timestamp, block.timestamp, 1);
    }
}
