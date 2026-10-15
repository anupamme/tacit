// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title EthSplitter — receives ETH, forwards it to a short list of wallets by weight
/// @notice Built to be the `tipRecipient` of the wrap tip forwarders, so the tips pay the wallets that do the
///         work (the settle wallet, the attest wallet) instead of piling up in a multisig that then has to refill
///         them by hand. The owner (the ops multisig) can change who is paid and in what proportion at any time.
///
///         Receiving is deliberately bare: `receive()` stores and logs nothing, so a depositor's wrap costs the
///         plain 21,000 gas plus a few hundred, and it can never fail or be griefed by a recipient that reverts.
///         Forwarding is a separate call, `distribute()`, that anyone may make (a keeper, the owner, a curious
///         visitor): it sends the whole balance out by weight in one go. It cannot be steered anywhere the owner
///         has not already chosen, so being permissionless costs nothing.
///
///         Weights are plain numbers, not percentages: 1:1 is half and half, 3:1:1 is 60/20/20. Each recipient
///         gets `balance * weight / total`, rounded down; the last one takes the rounding dust. One slot per
///         recipient (address and weight packed), at most 8, so a distribute is a handful of storage reads and
///         a handful of sends.
///
///         ETH only. A change of the list applies to what is in the contract when it is next distributed, so the
///         owner distributes first (the page does both in one batch) if the balance should go out under the old
///         list. `setShares` does not distribute for the owner, so a recipient that cannot receive ETH can never
///         stop the owner from replacing it.
contract EthSplitter is Ownable, ReentrancyGuardTransient {
    uint256 public constant MAX_RECIPIENTS = 8;

    struct Share {
        address to;
        uint96 weight;
    }

    Share[] private _shares;

    error BadShares();

    event SharesSet(address[] to, uint96[] weight);
    event Distributed(uint256 amount);

    constructor(address owner_, address[] memory to, uint96[] memory weight) {
        _initializeOwner(owner_);
        _set(to, weight);
    }

    receive() external payable {}

    /// Sends the whole balance to the recipients by weight. A no-op on an empty balance. Reverts, leaving the
    /// balance where it was, if any recipient refuses the ETH; the owner replaces it with `setShares`.
    function distribute() external nonReentrant {
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        Share[] memory s = _shares;
        uint256 n = s.length;
        uint256 total;
        for (uint256 i; i < n; ++i) {
            total += s[i].weight;
        }
        uint256 left = bal;
        for (uint256 i; i < n - 1; ++i) {
            uint256 amt = bal * s[i].weight / total;
            left -= amt;
            if (amt != 0) SafeTransferLib.safeTransferETH(s[i].to, amt);
        }
        if (left != 0) SafeTransferLib.safeTransferETH(s[n - 1].to, left);
        emit Distributed(bal);
    }

    /// Replaces the whole list. `to[i]` is paid `weight[i]` parts of the total. Owner only.
    function setShares(address[] calldata to, uint96[] calldata weight) external onlyOwner {
        _set(to, weight);
    }

    function shares() external view returns (address[] memory to, uint96[] memory weight) {
        Share[] memory s = _shares;
        uint256 n = s.length;
        to = new address[](n);
        weight = new uint96[](n);
        for (uint256 i; i < n; ++i) {
            to[i] = s[i].to;
            weight[i] = s[i].weight;
        }
    }

    function _set(address[] memory to, uint96[] memory weight) private {
        uint256 n = to.length;
        if (n == 0 || n > MAX_RECIPIENTS || n != weight.length) revert BadShares();
        delete _shares;
        for (uint256 i; i < n; ++i) {
            if (to[i] == address(0) || to[i] == address(this) || weight[i] == 0) revert BadShares();
            _shares.push(Share(to[i], weight[i]));
        }
        emit SharesSet(to, weight);
    }
}
