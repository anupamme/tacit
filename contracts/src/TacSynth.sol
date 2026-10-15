// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "solady/tokens/ERC20.sol";

interface ISynthOwner {
    function owner() external view returns (address);
}

/// @title TacSynth
/// @notice The 18-decimal ERC-20 a TacVault lends against TAC (a dollar or ETH, depending on the vault). The vault
///         that deploys it mints and burns it, always. Its owner (the vault's owner, read live) can name further
///         minters, so another kind of collateral can lend the same token without a new token: an announced minter
///         takes effect MINTER_DELAY later, can be removed at once, and `lockMinters` ends the power to add any for
///         good. No spender is pre-approved.
contract TacSynth is ERC20 {
    uint256 public constant MINTER_DELAY = 3 days;
    uint256 public constant QUEUE_EXPIRY = 14 days;

    address public immutable MINTER;
    string internal _name;
    string internal _symbol;

    /// Minters named after deployment.
    mapping(address => bool) public isMinter;
    address public pendingMinter;
    uint256 public pendingMinterEta;
    bool public mintersLocked;

    error NotMinter();
    error NotOwner();
    error Locked();
    error NothingQueued();
    error TooEarly();
    error Expired();
    error BadMinter();

    event MinterQueued(address indexed minter, uint256 eta);
    event MinterAdded(address indexed minter);
    event MinterRemoved(address indexed minter);
    event MinterCancelled(address indexed minter);
    event MintersLocked();

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

    modifier onlyMinter() {
        if (msg.sender != MINTER && !isMinter[msg.sender]) revert NotMinter();
        _;
    }

    modifier onlyVaultOwner() {
        if (msg.sender != ISynthOwner(MINTER).owner()) revert NotOwner();
        _;
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    /// Burns `amount` from `from`, spending the allowance `from` gave the minter.
    function burnFrom(address from, uint256 amount) external onlyMinter {
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
    }

    // ─────────────── further minters ───────────────

    /// Announces `minter` (a contract) to be allowed to mint and burn MINTER_DELAY from now.
    function queueMinter(address minter) external onlyVaultOwner {
        if (mintersLocked) revert Locked();
        if (minter.code.length == 0 || minter == MINTER || isMinter[minter]) revert BadMinter();
        pendingMinter = minter;
        pendingMinterEta = block.timestamp + MINTER_DELAY;
        emit MinterQueued(minter, pendingMinterEta);
    }

    function executeMinter() external onlyVaultOwner {
        if (mintersLocked) revert Locked();
        address minter = pendingMinter;
        if (minter == address(0)) revert NothingQueued();
        if (block.timestamp < pendingMinterEta) revert TooEarly();
        if (block.timestamp > pendingMinterEta + QUEUE_EXPIRY) revert Expired();
        delete pendingMinter;
        delete pendingMinterEta;
        isMinter[minter] = true;
        emit MinterAdded(minter);
    }

    function cancelMinter() external onlyVaultOwner {
        address minter = pendingMinter;
        if (minter == address(0)) revert NothingQueued();
        delete pendingMinter;
        delete pendingMinterEta;
        emit MinterCancelled(minter);
    }

    /// Takes a further minter's rights away at once (the vault that deployed the token keeps its own).
    function removeMinter(address minter) external onlyVaultOwner {
        if (!isMinter[minter]) revert BadMinter();
        delete isMinter[minter];
        emit MinterRemoved(minter);
    }

    /// Ends the power to add minters (and cancels the one announced), for good.
    function lockMinters() external onlyVaultOwner {
        mintersLocked = true;
        delete pendingMinter;
        delete pendingMinterEta;
        emit MintersLocked();
    }
}
