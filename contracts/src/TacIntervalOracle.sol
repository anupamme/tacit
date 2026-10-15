// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MerkleTrie} from "./lib/trie/MerkleTrie.sol";
import {RLPReader} from "./lib/trie/RLPReader.sol";

/// @title TacIntervalOracle
/// @notice ETH per TAC (1e18-scaled) from one contract's proven storage, as it stood at the end of past blocks.
///         A venue contract supplies how its state becomes a price and a depth (`_read`) and the live price
///         (`spot`); this base keeps the intervals and the medians.
///
///         Blocks are grouped in intervals of STEP. Each interval has one sample block, chosen after the interval
///         by the RANDAO value (`mixHash`) of the block that follows it, so no one knows in advance which block's
///         end will count. Anyone may `record` an interval by proving the venue at the end of its sample block: both
///         headers are checked against their hashes (the BLOCKHASH opcode for the last 256 blocks, the EIP-2935
///         history contract for older ones, up to 8,191 blocks), and the venue's account and two storage slots
///         against the sample header's state root.
///
///         `prices(window)` gives the median of the window's intervals twice: `low` is the lower middle value,
///         counting an interval no one recorded as zero, and `high` the upper middle value, counting it as
///         unbounded. `depth(window)` is the lower middle ETH depth, likewise, and `depthMin(window)` the smallest
///         depth, which needs every interval of the window recorded. An interval counts once the block that follows it
///         is more than GRACE blocks old, so a fresh interval cannot count before anyone could record it. Each
///         reverts unless at least MIN_COVERAGE_BPS of the window's intervals are recorded. Raising `low` or
///         lowering `high` means holding the venue's price through more than half of the window's intervals,
///         however many are recorded. `latest()` is the newest recorded interval's price, `spot()` the venue's
///         price now.
///
///         A reorg cannot leave a sample behind: the ring is chain state, and a `record` is valid only on a chain
///         that contains both headers it proves.
///
///         Immutable, with no owner and no settings. It relies on 12-second slots (BLOCK_SECONDS), the post-merge
///         header layout and Ethereum's Merkle-Patricia state trie; if any of these changes, `record` fails and the
///         oracle expires within MAX_WINDOW, so vaults priced by it must then be wound down and redeployed.
abstract contract TacIntervalOracle {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant BLOCK_SECONDS = 12;
    /// Blocks after an interval ends before it counts.
    uint256 public constant GRACE = 10;
    /// Intervals kept: older ones are overwritten.
    uint256 public constant RING = 128;
    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint256 internal constant MASK = (1 << 104) - 1;

    /// The contract whose account and storage are proven.
    address public immutable POOL;
    uint256 public immutable STEP;
    uint256 public immutable SHORT_WINDOW;
    uint256 public immutable WINDOW;
    uint256 public immutable MAX_WINDOW;
    uint256 public immutable MIN_COVERAGE_BPS;

    // interval % RING => interval << 208 | ETH per TAC << 104 | ETH depth.
    uint256[RING] internal _samples;

    error BadConfig();
    error BadBlock();
    error BadHeader();
    error AlreadyRecorded();
    error BadWindow();
    error TooFewSamples();

    event Recorded(uint256 indexed interval, uint256 blockNumber, uint256 ethPerTac, uint256 ethDepth);

    constructor(
        address pool,
        uint256 step,
        uint256 shortWindow,
        uint256 window,
        uint256 maxWindow,
        uint256 minCoverageBps
    ) {
        if (pool.code.length == 0 || step <= GRACE) revert BadConfig();
        uint256 stepSeconds = step * BLOCK_SECONDS;
        if (shortWindow < stepSeconds || window < shortWindow || maxWindow < window) revert BadConfig();
        if (maxWindow / stepSeconds >= RING || minCoverageBps == 0 || minCoverageBps > BPS) revert BadConfig();
        POOL = pool;
        STEP = step;
        SHORT_WINDOW = shortWindow;
        WINDOW = window;
        MAX_WINDOW = maxWindow;
        MIN_COVERAGE_BPS = minCoverageBps;
    }

    /// The venue's ETH per TAC now.
    function spot() public view virtual returns (uint256);

    /// The two storage slots of POOL that `record` proves, in the order of its two storage proofs.
    function slots() public view virtual returns (bytes32 a, bytes32 b);

    /// ETH per TAC and the ETH depth from the venue's two proven slot values, `a` and `b` as `slots()` orders them.
    function _read(uint256 a, uint256 b) internal view virtual returns (uint256 ethPerTac, uint256 ethDepth);

    /// Records an interval from the RLP headers of its sample block and of the block that follows the interval,
    /// and `eth_getProof` output for POOL at the sample block: its account proof and the proofs of the two
    /// storage slots `slots()` names.
    function record(
        bytes calldata header,
        bytes calldata next,
        bytes[] calldata accountProof,
        bytes[] calldata proofA,
        bytes[] calldata proofB
    ) external returns (uint256 ethPerTac, uint256 ethDepth) {
        RLPReader.RLPItem[] memory fields = _header(header);
        uint256 number = _toUint(RLPReader.readBytes(fields[8]));
        uint256 interval = number / STEP;
        RLPReader.RLPItem[] memory nextFields = _header(next);
        if (_toUint(RLPReader.readBytes(nextFields[8])) != (interval + 1) * STEP) revert BadBlock();
        if (number != sampleBlock(interval, bytes32(RLPReader.readBytes(nextFields[13])))) revert BadBlock();
        if (interval + RING <= _latestInterval(0)) revert BadBlock();
        uint256 slot = interval % RING;
        if (_has(_samples[slot], interval)) revert AlreadyRecorded();

        bytes32 stateRoot = bytes32(RLPReader.readBytes(fields[3]));
        bytes memory account =
            MerkleTrie.get(abi.encodePacked(keccak256(abi.encodePacked(POOL))), accountProof, stateRoot);
        bytes32 storageRoot = bytes32(RLPReader.readBytes(RLPReader.readList(account)[2]));
        (bytes32 slotA, bytes32 slotB) = slots();
        (ethPerTac, ethDepth) = _read(_storage(storageRoot, slotA, proofA), _storage(storageRoot, slotB, proofB));
        if (ethPerTac == 0 || ethPerTac > MASK || ethDepth > MASK) revert BadBlock();
        _samples[slot] = interval << 208 | ethPerTac << 104 | ethDepth;
        emit Recorded(interval, number, ethPerTac, ethDepth);
    }

    // Whether ring entry `s` holds `interval`. An empty entry never does, so interval 0 is not read as recorded.
    function _has(uint256 s, uint256 interval) internal pure returns (bool) {
        return s != 0 && s >> 208 == interval;
    }

    /// The sample block of `interval`, given the `mixHash` of block (interval + 1) · STEP.
    function sampleBlock(uint256 interval, bytes32 mixHash) public view returns (uint256) {
        return interval * STEP + uint256(mixHash) % STEP;
    }

    /// The lower and upper median ETH per TAC over the intervals of the last `window` seconds, an interval not
    /// recorded counting as zero for `low` and as unbounded for `high`.
    function prices(uint256 window) public view returns (uint256 low, uint256 high) {
        (uint256[] memory found, uint256 n, uint256 points) = _collect(window, true);
        _sort(found, n);
        low = found[(points - 1) / 2 - (points - n)];
        high = found[points / 2];
    }

    /// The price that decides whether an auction may end: the lower median, as `prices` gives it. A venue pair
    /// combines these so that both venues have to be held down to block a recovery.
    function recovery(uint256 window) external view returns (uint256 low) {
        (low,) = prices(window);
    }

    /// The lower median ETH depth of the venue (wei) over the last `window` seconds, an interval not recorded
    /// counting as zero.
    function depth(uint256 window) external view returns (uint256) {
        (uint256[] memory found, uint256 n, uint256 points) = _collect(window, false);
        _sort(found, n);
        return found[(points - 1) / 2 - (points - n)];
    }

    /// The smallest ETH depth of the venue (wei) over the last `window` seconds, which needs every interval of the
    /// window recorded: a depth lifted for part of the window, or thin intervals left unrecorded, cannot raise it.
    function depthMin(uint256 window) external view returns (uint256) {
        (uint256[] memory found, uint256 n, uint256 points) = _collect(window, false);
        if (n != points) revert TooFewSamples();
        _sort(found, n);
        return found[0];
    }

    /// The price of the newest recorded interval within MAX_WINDOW, or 0.
    function latest() external view returns (uint256 ethPerTac) {
        uint256 newest = _latestInterval(0);
        uint256 points = MAX_WINDOW / (STEP * BLOCK_SECONDS);
        for (uint256 i; i < points && i <= newest; ++i) {
            uint256 s = _samples[(newest - i) % RING];
            if (_has(s, newest - i)) return s >> 104 & MASK;
        }
        return 0;
    }

    /// The price and depth recorded for `interval`, or zeros.
    function sampleOf(uint256 interval) external view returns (uint256 ethPerTac, uint256 ethDepth) {
        uint256 s = _samples[interval % RING];
        if (_has(s, interval)) (ethPerTac, ethDepth) = (s >> 104 & MASK, s & MASK);
    }

    // The window's recorded prices (or depths), how many, and how many intervals it spans.
    function _collect(uint256 window, bool price)
        internal
        view
        returns (uint256[] memory found, uint256 n, uint256 points)
    {
        if (window < STEP * BLOCK_SECONDS || window > MAX_WINDOW) revert BadWindow();
        points = window / (STEP * BLOCK_SECONDS);
        uint256 newest = _latestInterval(GRACE);
        found = new uint256[](points);
        for (uint256 i; i < points && i <= newest; ++i) {
            uint256 s = _samples[(newest - i) % RING];
            if (_has(s, newest - i)) found[n++] = price ? s >> 104 & MASK : s & MASK;
        }
        // Enough recorded, and the lower and upper middle both fall on a recorded value.
        if (n * BPS < points * MIN_COVERAGE_BPS || (points - 1) / 2 < points - n || points / 2 >= n) {
            revert TooFewSamples();
        }
    }

    // The newest interval whose following block is more than `grace` blocks old.
    function _latestInterval(uint256 grace) internal view returns (uint256) {
        uint256 last = block.number - 1;
        if (last < grace + STEP) revert TooFewSamples();
        return (last - grace) / STEP - 1;
    }

    // Decodes a header whose hash matches the chain's for its number. The fields read here must sit where today's
    // layout puts them: stateRoot (3) and mixHash (13) 32 bytes, nonce (14) 8 bytes. A fork that shifts them is
    // refused, so a builder-chosen field can never be read as the RANDAO value.
    function _header(bytes calldata header) internal view returns (RLPReader.RLPItem[] memory fields) {
        fields = RLPReader.readList(header);
        if (fields.length < 15 || fields[3].length != 33 || fields[13].length != 33 || fields[14].length != 9) {
            revert BadHeader();
        }
        bytes32 hash = _blockHash(_toUint(RLPReader.readBytes(fields[8])));
        if (hash == 0 || keccak256(header) != hash) revert BadHeader();
    }

    function _blockHash(uint256 number) internal view returns (bytes32 hash) {
        if (number >= block.number) return 0;
        if (block.number - number <= 256) return blockhash(number);
        (bool ok, bytes memory out) = HISTORY.staticcall(abi.encode(number));
        if (ok && out.length == 32) hash = abi.decode(out, (bytes32));
    }

    function _storage(bytes32 root, bytes32 slot, bytes[] calldata proof) internal pure returns (uint256) {
        bytes memory leaf = MerkleTrie.get(abi.encodePacked(keccak256(abi.encode(slot))), proof, root);
        return _toUint(RLPReader.readBytes(leaf));
    }

    function _toUint(bytes memory b) internal pure returns (uint256 v) {
        if (b.length > 32) revert BadHeader();
        for (uint256 i; i < b.length; ++i) {
            v = v << 8 | uint8(b[i]);
        }
    }

    // Sorts the first `n` entries in place, ascending.
    function _sort(uint256[] memory a, uint256 n) internal pure {
        for (uint256 i = 1; i < n; ++i) {
            uint256 x = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > x) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = x;
        }
    }
}
