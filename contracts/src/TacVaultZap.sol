// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {TacitEvmPoolRouter} from "./TacitEvmPoolRouter.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";

interface IERC2612Zap {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

interface ITacVaultForZap {
    function TAC() external view returns (address);
    function SYNTH() external view returns (address);
    function depositFor(address owner, uint256 amount) external;
    function borrowFor(
        address owner,
        uint256 amount,
        uint256 maxFeeBps,
        uint256 minCollateral,
        address to,
        uint256 deadline,
        bytes calldata sig
    ) external;
}

/// @title TacVaultZap
/// @notice Public TAC to a vault's SYNTH in one transaction. Pulls the caller's TAC, deposits it into `owner`'s
///         vault and borrows with `owner`'s signature (the owner may be the caller or a key that only signs). The
///         SYNTH goes to an address (`mint`) or into a deposit box of the SYNTH pool's router, completed in the same
///         call (`mintShielded`). A deposit box's address fixes the deposit's amount, notes and memos, and the owner
///         signs that address as the recipient, so whoever submits the signature can only fund the owner's notes.
///         Holds nothing between transactions. `multicall` with `permitTac` first needs no prior approval.
contract TacVaultZap is Multicallable {
    ITacVaultForZap public immutable VAULT;
    address public immutable TAC;
    TacitEvmPoolRouter public immutable SYNTH_ROUTER;

    error BadConfig();
    error BadRecipient();

    constructor(address vault, address synthRouter) {
        if (vault.code.length == 0 || synthRouter.code.length == 0) revert BadConfig();
        VAULT = ITacVaultForZap(vault);
        TAC = ITacVaultForZap(vault).TAC();
        if (TacitEvmPoolRouter(payable(synthRouter)).ASSET() != ITacVaultForZap(vault).SYNTH()) revert BadConfig();
        SYNTH_ROUTER = TacitEvmPoolRouter(payable(synthRouter));
    }

    /// Applies the caller's EIP-2612 permit for TAC to this contract; a permit that fails is skipped.
    function permitTac(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC2612Zap(TAC).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    /// Deposits `tacIn` of the caller's TAC (0 for none) into `owner`'s vault and borrows `amount` to `to`. The
    /// signature fixes `minCollateral`, so it cannot be used without the deposit it expects.
    function mint(
        address owner,
        uint256 tacIn,
        uint256 amount,
        uint256 maxFeeBps,
        uint256 minCollateral,
        address to,
        uint256 deadline,
        bytes calldata sig
    ) external {
        if (to == address(this)) revert BadRecipient();
        _deposit(owner, tacIn);
        VAULT.borrowFor(owner, amount, maxFeeBps, minCollateral, to, deadline, sig);
    }

    /// As `mint`, borrowing `intent.amount` into `intent`'s deposit box (the recipient the owner signs) and
    /// depositing it into the pool with `t`, the proof for that intent.
    function mintShielded(
        address owner,
        uint256 tacIn,
        uint256 maxFeeBps,
        uint256 minCollateral,
        uint256 deadline,
        bytes calldata sig,
        TacitEvmPoolRouter.DepositIntent calldata intent,
        TacitEvmPoolRouter.Tx calldata t
    ) external {
        _deposit(owner, tacIn);
        VAULT.borrowFor(
            owner, intent.amount, maxFeeBps, minCollateral, SYNTH_ROUTER.depositBoxOf(intent), deadline, sig
        );
        SYNTH_ROUTER.completeDeposit(intent, t);
    }

    function _deposit(address owner, uint256 tacIn) internal {
        if (tacIn == 0) return;
        SafeTransferLib.safeTransferFrom(TAC, msg.sender, address(this), tacIn);
        SafeTransferLib.safeApproveWithRetry(TAC, address(VAULT), tacIn);
        VAULT.depositFor(owner, tacIn);
    }
}
