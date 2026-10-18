// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";
import {TacVault} from "../src/TacVault.sol";
import {RLPReader} from "../src/lib/trie/RLPReader.sol";

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
    bool public depthBroken; // the pools' depth needs every interval recorded while a price needs only most of them

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

    function setDepthBroken(bool b) external {
        depthBroken = b;
    }

    function depth(uint256) external view returns (uint256) {
        if (broken || depthBroken) revert("oracle");
        return ethDepth;
    }

    function depthMin(uint256) external view returns (uint256) {
        if (broken || depthBroken) revert("oracle");
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

/// A venue oracle as the vault page reads it (STEP, MAX_WINDOW, POOL, slots, sampleOf) that takes a record without checking its proofs: the interval is the one before the
/// block whose header comes second. It lets a test run the page's whole record flow (headers and proofs built from the chain, a batch sent, a vault that prices only after) on a
/// local chain. `fill` marks intervals as recorded.
contract MockVenue {
    uint256 public constant STEP = 50;
    uint256 public constant MAX_WINDOW = 4 hours;
    MockPair internal immutable _pair;
    mapping(uint256 => bool) internal _done;

    error AlreadyRecorded();

    constructor(MockPair pair_) {
        _pair = pair_;
    }

    function POOL() external view returns (address) {
        return address(this);
    }

    function slots() external pure returns (bytes32, bytes32) {
        return (bytes32(0), bytes32(uint256(1)));
    }

    function sampleOf(uint256 k) external view returns (uint256, uint256) {
        return _done[k] ? (1e15, 1e24) : (uint256(0), uint256(0));
    }

    function fill(uint256 from, uint256 to) external {
        for (uint256 k = from; k <= to; ++k) {
            _done[k] = true;
        }
    }

    function record(bytes calldata, bytes calldata next, bytes[] calldata, bytes[] calldata, bytes[] calldata) external returns (uint256, uint256) {
        RLPReader.RLPItem[] memory f = RLPReader.readList(next);
        bytes memory n = RLPReader.readBytes(f[8]);
        uint256 number;
        for (uint256 i; i < n.length; ++i) {
            number = number << 8 | uint8(n[i]);
        }
        uint256 k = number / STEP - 1;
        if (_done[k]) revert AlreadyRecorded();
        _done[k] = true;
        _pair.noted();
        return (1e15, 1e24);
    }
}

/// The oracle the vault reads (a MockOracle) with two venues behind it, the way TacPairOracle has: it prices only once `arm(n)`'s n records have been made.
contract MockPair is MockOracle {
    MockVenue public immutable A;
    MockVenue public immutable B;
    uint256 public needed;
    uint256 public got;

    constructor() {
        A = new MockVenue(this);
        B = new MockVenue(this);
    }

    function arm(uint256 n) external {
        (needed, got, broken) = (n, 0, true);
    }

    /// Like `arm`, but only the depth lapses: the price still reads, as it does on the live oracle while most intervals are recorded.
    function armDepth(uint256 n) external {
        (needed, got, depthBroken) = (n, 0, true);
    }

    function noted() external {
        require(msg.sender == address(A) || msg.sender == address(B), "venue");
        if (++got >= needed) (broken, depthBroken) = (false, false);
    }
}

/// An oracle whose two venues are whatever a test says (a venue with no code, or one that misbehaves).
contract MockEvilPair is MockOracle {
    address public A;
    address public B;

    function setVenues(address a, address b) external {
        (A, B) = (a, b);
    }
}

/// A venue that answers every call by reverting with 100 KB of data.
contract MockBombVenue {
    fallback() external {
        assembly {
            revert(0, 102400)
        }
    }
}
