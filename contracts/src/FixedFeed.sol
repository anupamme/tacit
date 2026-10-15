// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title FixedFeed
/// @notice A feed that always answers 1.0 (8 decimals), fresh every block. A TacVault using it in place of ETH/USD
///         lends a SYNTH worth one ETH.
contract FixedFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 1e8, block.timestamp, block.timestamp, 1);
    }
}
