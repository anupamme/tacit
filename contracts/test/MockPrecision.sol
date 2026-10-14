// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";

/// The ETH/TAC Precision pool's storage layout and price inputs: reserves packed in slot 0, the LP supply in
/// solady's supply slot, and the range bounds. For local chains, where storage proofs of it are real.
contract MockPrecision is ERC20 {
    uint128 public reserve0;
    uint128 public reserve1;
    uint256 public immutable sqrtPLow;
    uint256 public immutable sqrtPHigh;
    address internal immutable TAC;

    constructor(address tac, uint256 lo, uint256 hi, uint256 supply, uint128 r0, uint128 r1) {
        (TAC, sqrtPLow, sqrtPHigh, reserve0, reserve1) = (tac, lo, hi, r0, r1);
        _mint(msg.sender, supply);
    }

    function name() public pure override returns (string memory) {
        return "LP";
    }

    function symbol() public pure override returns (string memory) {
        return "LP";
    }

    function tapePair() external view returns (address, address) {
        return (address(0), TAC);
    }

    function setReserves(uint128 r0, uint128 r1) external {
        (reserve0, reserve1) = (r0, r1);
    }
}
