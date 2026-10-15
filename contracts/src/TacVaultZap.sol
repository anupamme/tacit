// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";

interface IERC2612Zap {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// The part of TacitEvmPoolRouter the zap uses; the structs match the router's.
interface IZapRouter {
    struct Tx {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[11] publicInputs;
        address recipient;
        int256 extAmount;
        address relayer;
        uint256 fee;
        bytes memo0;
        bytes memo1;
    }

    struct DepositIntent {
        uint256 amount;
        uint256 outLeaf0;
        uint256 outLeaf1;
        bytes32 memo0Hash;
        bytes32 memo1Hash;
        address refund;
        uint64 deadline;
        uint256 nonce;
    }

    function ASSET() external view returns (address);
    function depositBoxOf(DepositIntent calldata intent) external view returns (address);
    function completeDeposit(DepositIntent calldata intent, Tx calldata t) external;
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
/// @notice TAC to SYNTH in one transaction: deposits the caller's TAC into `owner`'s vault and borrows on `owner`'s
///         signature, either to an address (`mint`) or into a deposit box of the SYNTH pool's router, completed in
///         the same call (`mintShielded`). The box address commits to the deposit's amount, notes and memos and is
///         the signed recipient, so a submitter can only fund the owner's notes. Holds nothing between calls.
contract TacVaultZap is Multicallable {
    ITacVaultForZap public immutable VAULT;
    address public immutable TAC;
    IZapRouter public immutable SYNTH_ROUTER;

    error BadConfig();
    error BadRecipient();

    constructor(address vault, address synthRouter) {
        if (vault.code.length == 0 || synthRouter.code.length == 0) revert BadConfig();
        VAULT = ITacVaultForZap(vault);
        TAC = ITacVaultForZap(vault).TAC();
        if (IZapRouter(synthRouter).ASSET() != ITacVaultForZap(vault).SYNTH()) revert BadConfig();
        SYNTH_ROUTER = IZapRouter(synthRouter);
    }

    /// Applies the caller's EIP-2612 permit for TAC to this contract; a failing permit is ignored.
    function permitTac(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC2612Zap(TAC).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    /// Deposits `tacIn` of the caller's TAC (0 for none) into `owner`'s vault and borrows `amount` to `to`. The
    /// signed `minCollateral` ties the signature to the deposit.
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

    /// As `mint`, borrowing `intent.amount` into the intent's deposit box and completing the pool deposit with `t`.
    function mintShielded(
        address owner,
        uint256 tacIn,
        uint256 maxFeeBps,
        uint256 minCollateral,
        uint256 deadline,
        bytes calldata sig,
        IZapRouter.DepositIntent calldata intent,
        IZapRouter.Tx calldata t
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
