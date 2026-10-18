// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Runs a list of calls from its own address and reverts with the first failure's reason. The vault page puts this code at the
/// account's address in an eth_call (a state override), so that a batch a smart-account wallet will send as one transaction is tested
/// exactly as it will run: every call comes from the account. It is never deployed.
contract BatchRun {
    function run(address[] calldata to, bytes[] calldata data) external {
        for (uint256 i; i < to.length; ++i) {
            (bool ok, bytes memory ret) = to[i].call(data[i]);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
