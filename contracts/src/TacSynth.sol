// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "solady/tokens/ERC20.sol";

interface ISynthOwner {
    function owner() external view returns (address);
}

/// @title TacSynth
/// @notice The ERC-20 a TacVault lends. The vault that deploys it (MINTER) can always mint and burn. The vault's owner
///         can add further minters after MINTER_DELAY, so other collateral can lend the same token, and remove them at
///         once; `lockMinters` ends adding for good. No allowance is pre-approved, Permit2 included.
contract TacSynth is ERC20 {
    uint256 public constant MINTER_DELAY = 3 days;
    /// How long an announced minter may still be added after its delay.
    uint256 public constant QUEUE_EXPIRY = 14 days;

    address public immutable MINTER;
    string internal _name;
    string internal _symbol;

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

    /// Burns `amount` from `from`, spending `from`'s allowance to the caller unless `from` is the caller.
    function burnFrom(address from, uint256 amount) external onlyMinter {
        if (from != msg.sender) _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
    }

    /// Announces `minter` (a contract), added by `executeMinter` after MINTER_DELAY.
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

    /// Removes a further minter at once; MINTER cannot be removed.
    function removeMinter(address minter) external onlyVaultOwner {
        if (!isMinter[minter]) revert BadMinter();
        delete isMinter[minter];
        emit MinterRemoved(minter);
    }

    /// Ends adding minters for good and drops the announced one.
    function lockMinters() external onlyVaultOwner {
        mintersLocked = true;
        delete pendingMinter;
        delete pendingMinterEta;
        emit MintersLocked();
    }
}
