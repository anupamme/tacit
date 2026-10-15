// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";
import {TacVault} from "../src/TacVault.sol";

contract TestTac is ERC20 {
    function name() public pure override returns (string memory) {
        return "TAC";
    }

    function symbol() public pure override returns (string memory) {
        return "TAC";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// The oracle surface the vault reads, with each window's low and high median equal. `set(p)` moves every price;
/// `setPrices` sets the long median (any window but SHORT_WINDOW), the SHORT_WINDOW median and the current price;
/// `setDepth` the pool's ETH depth (deep by default).
contract MockOracle {
    uint256 public constant STEP = 50;
    uint256 public constant SHORT_WINDOW = 10 minutes;
    uint256 public constant WINDOW = 1 hours;
    uint256 public constant MAX_WINDOW = 4 hours;
    uint256 public avg;
    uint256 public short;
    uint256 public current;
    uint256 public ethDepth = 1e30;
    uint256 public lastSample; // the newest recorded interval's price
    bool public broken;

    function set(uint256 p) external {
        (avg, short, current, lastSample) = (p, p, p, p);
    }

    function setLatest(uint256 p) external {
        lastSample = p;
    }

    function setPrices(uint256 avg_, uint256 short_, uint256 current_) external {
        (avg, short, current) = (avg_, short_, current_);
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function setDepth(uint256 d) external {
        ethDepth = d;
    }

    function depth(uint256) external view returns (uint256) {
        if (broken) revert("oracle");
        return ethDepth;
    }

    function depthMin(uint256) external view returns (uint256) {
        if (broken) revert("oracle");
        return ethDepth;
    }

    function prices(uint256 window) external view returns (uint256, uint256) {
        if (broken) revert("oracle");
        uint256 p = window == SHORT_WINDOW ? short : avg;
        return (p, p);
    }

    function spot() external view returns (uint256) {
        if (broken) revert("oracle");
        return current;
    }

    function recovery(uint256 window) external view returns (uint256) {
        if (broken) revert("oracle");
        return window == SHORT_WINDOW ? short : avg;
    }

    function latest() external view returns (uint256) {
        if (broken) revert("oracle");
        return lastSample;
    }

    function POOL() external view returns (address) {
        return address(this);
    }
}

contract MockFeed {
    int256 public answer = 4000e8;
    uint256 public updatedAt;
    uint80 public roundId = 10;
    uint80 public answeredInRound = 10;

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function set(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
    }

    function setRound(uint80 r, uint80 inRound) external {
        roundId = r;
        answeredInRound = inRound;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

library VaultConfig {
    /// The reference parameters the tests use; callers adjust fields as needed.
    function defaults(address tac, address oracle, address feed, address owner)
        internal
        pure
        returns (TacVault.Config memory c)
    {
        c = TacVault.Config({
            tac: tac,
            oracle: oracle,
            ethUsd: feed,
            owner: owner,
            mintRatioBps: 30_000,
            liqRatioBps: 17_500,
            liqBonusBps: 1_000,
            auctionDuration: 2 hours,
            ownerWindow: 20 minutes,
            minDebt: 100e18,
            feedMaxStaleness: 1 hours,
            debtCeiling: 10_000e18,
            depthBps: 1_000,
            redemptionFeeBps: 50,
            borrowFeeBps: 0,
            feeTo: address(0xFEE),
            tacSink: address(0xdEaD),
            name: "Test Dollar",
            symbol: "TD"
        });
    }
}

/// A feed that is always fresh, for local forks where the ETH/USD feed's answer would otherwise go stale.
contract LiveFeed {
    int256 public answer = 2500e8;

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
