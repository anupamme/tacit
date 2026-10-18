// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TacVaultRouter} from "../src/TacVaultRouter.sol";
import {TacVaultsDeployment as D} from "./TacVaultsDeployment.sol";

interface ICreateXRouter {
    function deployCreate2(bytes32 salt, bytes memory initCode) external payable returns (address newContract);
}

/// @notice Anyone's deployment of the TacVaultRouter for the two mainnet vaults, with CreateX.deployCreate2 from a salt tied
///         to no sender and to this chain, as the vaults were: the address is CREATE2(CreateX, keccak256(abi.encode(chainId,
///         salt)), keccak256(init code)), so it commits to the init code and to the two vaults it is built for, and nobody
///         can put different code there or take the address on another chain. A salt of the form 20 zero bytes, 0x01, then
///         11 bytes of your choice (`ROUTER_SALT`, to mine an address with leading zero bytes) is the only form accepted; the
///         default is a fixed one. A repeated run finds the router there and only checks it.
///
///         It must be built with the project's settings (solc 0.8.37 from the contract's own pragma, via-IR, optimizer runs
///         1, no metadata hash): the address follows from the compiled bytes.
///
///         forge script script/DeployTacVaultRouter.s.sol --rpc-url $RPC --broadcast --account <any funded account>
contract DeployTacVaultRouter is Script {
    bytes32 internal constant DEFAULT_SALT = 0x0000000000000000000000000000000000000000017461632d726f7574657231;

    function run() external {
        require(block.chainid == 1, "mainnet only");
        require(D.CREATEX.code.length != 0, "CreateX is not on this chain");
        require(D.USD_VAULT.code.length != 0 && D.ETH_VAULT.code.length != 0, "the vaults are not there");
        bytes32 salt = vm.envOr("ROUTER_SALT", DEFAULT_SALT);
        bytes memory initCode = abi.encodePacked(type(TacVaultRouter).creationCode, abi.encode(D.USD_VAULT, D.ETH_VAULT));
        address expected = predict(salt, keccak256(initCode));
        console2.log("router address:", expected);
        console2.log("init code hash:");
        console2.logBytes32(keccak256(initCode));
        if (expected.code.length == 0) {
            vm.startBroadcast();
            address got = ICreateXRouter(D.CREATEX).deployCreate2(salt, initCode);
            vm.stopBroadcast();
            require(got == expected, "landed elsewhere");
            console2.log("deployed:", got);
        } else {
            console2.log("already there");
        }
        TacVaultRouter r = TacVaultRouter(expected);
        require(r.VAULT_A() == D.USD_VAULT && r.VAULT_B() == D.ETH_VAULT && r.TAC() == D.TAC, "router bindings");
        console2.log("Next: set `router` in dapp/vault/deployments.js to %s and run npm run build", expected);
    }

    /// The address CreateX gives `initCodeHash` under `salt` (the chain-bound salt form, as in DeployTacVault).
    function predict(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        require(bytes20(salt) == bytes20(0) && uint8(salt[20]) == 1, "salt form");
        bytes32 guarded = keccak256(abi.encode(block.chainid, salt));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), D.CREATEX, guarded, initCodeHash)))));
    }
}
