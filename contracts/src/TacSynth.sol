// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @title TacSynth
/// @notice The 18-decimal ERC-20 a TacVault lends against TAC (a dollar or ETH, depending on the vault). Only the
///         vault that deploys it mints and burns it. No spender is pre-approved.
contract TacSynth is ERC20 {
    address public immutable MINTER;
    string internal _name;
    string internal _symbol;

    error NotMinter();

    constructor(string memory name_, string memory symbol_) {
        MINTER = msg.sender;
        _name = name_;
        _symbol = symbol_;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function _givePermit2InfiniteAllowance() internal pure override returns (bool) {
        return false;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != MINTER) revert NotMinter();
        _mint(to, amount);
    }

    /// Burns `amount` from `from`, spending the allowance `from` gave the minter.
    function burnFrom(address from, uint256 amount) external {
        if (msg.sender != MINTER) revert NotMinter();
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
    }
}
