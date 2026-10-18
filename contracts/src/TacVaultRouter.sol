// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IERC2612Router {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

interface IERC20Router {
    function balanceOf(address owner) external view returns (uint256);
}

/// The part of a TacVault the router uses.
interface IRouterVault {
    function TAC() external view returns (address);
    function SYNTH() external view returns (address);
    function ORACLE() external view returns (address);
    function repay(address owner, uint256 amount) external returns (uint256 paid);
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
    function withdrawFor(address owner, uint256 amount, address to, uint256 deadline, bytes calldata sig) external;
}

/// The part of TacPairOracle the router uses.
interface IRouterPair {
    function A() external view returns (address);
    function B() external view returns (address);
}

/// @title TacVaultRouter
/// @notice A vault borrows against a price its oracle only knows once someone has recorded each interval, and records cost
///         gas for nobody's benefit in particular, so the person who wants to borrow is often the one who has to make them. A
///         vault acts for its caller, so a shared batcher cannot carry the action; this router can, because it acts only for
///         the caller. In one transaction, with `multicall`, the caller records the prices the vault waits for (`records`),
///         moves TAC in with an EIP-2612 permit (`permitTac`) and borrows on a signature (`borrow`), takes TAC out on a
///         signature (`withdraw`), adds TAC (`deposit`), or repays from its SYNTH with a permit (`permitSynth`, `repay`):
///         records first let the last two end an auction the vault has recovered from, which needs a price.
///
///         It acts only for `msg.sender`: the TAC deposited is the caller's and is credited to the caller's vault, and what
///         is borrowed or withdrawn goes to the caller, the `to` that the caller's own signature must name. It is
///         bound at deployment to two vaults and their TAC, and it records only on the venues of such a vault's oracle (with code, and only the oracle's `record`).
///         It holds nothing between calls: TAC sent to it, or ETH, is lost. No owner and no settings.
contract TacVaultRouter {
    address public immutable TAC;
    address public immutable VAULT_A;
    address public immutable VAULT_B;

    /// TacIntervalOracle.record(bytes,bytes,bytes[],bytes[],bytes[]); its AlreadyRecorded() error is 0x103b4afe (see `records`).
    bytes4 internal constant RECORD = 0x3113428b;

    error BadConfig();
    error BadVault();
    error BadVenue();
    error BadCall();

    constructor(address vaultA, address vaultB) {
        if (vaultA == vaultB || vaultA.code.length == 0 || vaultB.code.length == 0) revert BadConfig();
        address tac = IRouterVault(vaultA).TAC();
        if (tac.code.length == 0 || IRouterVault(vaultB).TAC() != tac) revert BadConfig();
        TAC = tac;
        VAULT_A = vaultA;
        VAULT_B = vaultB;
    }

    /// Runs each call on this contract as the caller, one after another; the first to fail reverts them all.
    function multicall(bytes[] calldata data) external {
        for (uint256 i; i < data.length; ++i) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }

    /// Makes price records, each `data[i]` being a call to `record` on `venues[i]`, which must be one of the two venues of the oracle
    /// `vault` reads (and have code). A record someone else has just made is skipped; any other failure reverts them all.
    function records(address vault, address[] calldata venues, bytes[] calldata data) external {
        _vault(vault);
        if (venues.length != data.length) revert BadCall();
        address pair = IRouterVault(vault).ORACLE();
        address a = IRouterPair(pair).A();
        address b = IRouterPair(pair).B();
        for (uint256 i; i < data.length; ++i) {
            address venue = venues[i];
            if ((venue != a && venue != b) || venue.code.length == 0) revert BadVenue();
            bytes calldata d = data[i];
            if (d.length < 4 || bytes4(d[:4]) != RECORD) revert BadCall();
            assembly ("memory-safe") {
                let p := mload(0x40)
                calldatacopy(p, d.offset, d.length)
                if iszero(call(gas(), venue, 0, p, d.length, 0, 0)) {
                    // a reason is short: nothing past 1 KiB is carried, and only AlreadyRecorded() is let through
                    let n := returndatasize()
                    if gt(n, 1024) { n := 1024 }
                    returndatacopy(p, 0, n)
                    if iszero(and(gt(n, 3), eq(shr(224, mload(p)), 0x103b4afe))) { revert(p, n) }
                }
            }
        }
    }

    /// Applies the caller's EIP-2612 permit for TAC to this contract; a failing permit (one already used, say) is ignored.
    function permitTac(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC2612Router(TAC).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    /// Deposits `tacIn` of the caller's TAC (0 for none) into the caller's vault and borrows `amount` to the caller, on
    /// the caller's signature (which names the caller as `to`; its `minCollateral` ties it to the deposit).
    function borrow(
        address vault,
        uint256 tacIn,
        uint256 amount,
        uint256 maxFeeBps,
        uint256 minCollateral,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _vault(vault);
        if (tacIn != 0) _deposit(vault, tacIn);
        IRouterVault(vault).borrowFor(msg.sender, amount, maxFeeBps, minCollateral, msg.sender, deadline, sig);
    }

    /// Adds `tacIn` of the caller's TAC to the caller's vault. With the records before it, a vault that is in an auction and has
    /// recovered is seen to have recovered, and the auction ends in the same transaction.
    function deposit(address vault, uint256 tacIn) external {
        _vault(vault);
        _deposit(vault, tacIn);
    }

    /// Applies the caller's EIP-2612 permit for `vault`'s SYNTH to this contract; a failing permit is ignored.
    function permitSynth(address vault, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        _vault(vault);
        try IERC2612Router(IRouterVault(vault).SYNTH()).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    /// Repays the caller's debt from `amount` of the caller's SYNTH, as `repay` of the vault does (the debt left must be zero or at least
    /// the smallest debt). Whatever the debt did not take goes back to the caller. As with `deposit`, records before it let an auction
    /// the repayment cures end in the same transaction.
    function repay(address vault, uint256 amount) external {
        _vault(vault);
        address synth = IRouterVault(vault).SYNTH();
        uint256 before = IERC20Router(synth).balanceOf(address(this));
        SafeTransferLib.safeTransferFrom(synth, msg.sender, address(this), amount);
        SafeTransferLib.safeApproveWithRetry(synth, vault, amount);
        IRouterVault(vault).repay(msg.sender, amount);
        SafeTransferLib.safeApprove(synth, vault, 0);
        uint256 left = IERC20Router(synth).balanceOf(address(this)) - before;
        if (left != 0) SafeTransferLib.safeTransfer(synth, msg.sender, left);
    }

    /// Withdraws `amount` of the caller's TAC to the caller, on the caller's signature.
    function withdraw(address vault, uint256 amount, uint256 deadline, bytes calldata sig) external {
        _vault(vault);
        IRouterVault(vault).withdrawFor(msg.sender, amount, msg.sender, deadline, sig);
    }

    function _deposit(address vault, uint256 tacIn) internal {
        SafeTransferLib.safeTransferFrom(TAC, msg.sender, address(this), tacIn);
        SafeTransferLib.safeApproveWithRetry(TAC, vault, tacIn);
        IRouterVault(vault).depositFor(msg.sender, tacIn);
    }

    function _vault(address vault) internal view {
        if (vault != VAULT_A && vault != VAULT_B) revert BadVault();
    }
}
