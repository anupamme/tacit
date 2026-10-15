// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IZapRouter} from "../src/TacVaultZap.sol";

/// The live TacitEvmPool and TacitEvmPoolRouter, as the vault tests use them. Those two stay on the compiler they
/// were deployed with, and a file cannot import contracts pinned to two compilers, so tests that also build the
/// vaults deploy them from their artifacts (`deployCode("TacitEvmPool.sol:TacitEvmPool", ...)`) and call them
/// through these interfaces. The structs and errors match the router's, field for field (Tx and DepositIntent are
/// the zap's own, so a test passes the same values to both).
interface IEvmPool {
    error StaleRoot();

    function ASSET() external view returns (address);
    function ASSET_FIELD() external view returns (uint256);
    function head() external view returns (bytes32, uint256);
    function nullified(bytes32) external view returns (bool);
    function transact(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[11] calldata publicInputs,
        address recipient,
        int256 extAmount,
        address relayer,
        uint256 fee,
        bytes calldata memo0,
        bytes calldata memo1
    ) external payable;
}

interface IEvmPoolRouter is IZapRouter {
    struct WrapIntent {
        bytes32 assetId;
        uint256 amount;
        uint256 tip;
        address tipTo;
        bytes32 commit;
        address refund;
        uint64 deadline;
        uint256 nonce;
    }

    struct Call {
        address target;
        uint256 value;
        address token;
        uint256 amount;
        bool push;
        bytes data;
    }

    struct CallIntent {
        Call[] calls;
        address[] outTokens;
        uint256[] minOuts;
        address to;
        address refund;
        uint64 deadline;
        uint256 nonce;
    }

    error BadIntent();
    error NotExpired();
    error NothingToReclaim();

    function reclaimDeposit(DepositIntent calldata intent, address token) external;
    function wrapBoxOf(WrapIntent calldata intent) external view returns (address);
    function withdrawToV1(Tx calldata t, WrapIntent calldata intent) external;
    function callEscrowOf(CallIntent calldata intent) external view returns (address);
    function withdrawAndCall(Tx calldata t, CallIntent calldata intent) external;
    function executeCall(CallIntent calldata intent) external;
}
