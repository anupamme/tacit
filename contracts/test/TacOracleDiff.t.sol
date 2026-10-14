// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {MockPrecision} from "./MockPrecision.sol";

/// A brute-force reference for the oracle's medians and depths, run against TacBlockOracle on arbitrary sets of recorded
/// intervals and arbitrary window lengths (interval 50 blocks, windows up to 6h, two thirds coverage), including a head
/// where the 128-slot ring has wrapped and every unrecorded slot still holds an older, much higher interval.
contract TacOracleDiffTest is Test {
    uint256 constant STEP = 50;
    uint256 constant BPS = 10_000;
    uint256 constant COVER = 6_600;
    uint256 constant HEAD = 26_000_061; // newest counted interval: 520,000
    uint256 constant HEAD_WRAP = 26_003_511; // newest counted interval: 520,069 (slot 5, window wraps the ring)
    TacBlockOracle oracle;

    function setUp() public {
        MockPrecision pool = new MockPrecision(address(0xAA), 3.78e18, 3.78e21, 3e20, 3e18, 3e22);
        oracle = new TacBlockOracle(address(pool), address(0xAA), STEP, 1 hours, 3 hours, 6 hours, COVER);
    }

    function _newest(uint256 head) internal view returns (uint256) {
        return (head - 1 - oracle.GRACE()) / STEP - 1;
    }

    function _put(uint256 interval, uint256 price, uint256 depth) internal {
        vm.store(address(oracle), bytes32(interval % 128), bytes32(interval << 208 | price << 104 | depth));
    }

    function _sort(uint256[] memory a) internal pure {
        for (uint256 i = 1; i < a.length; ++i) {
            for (uint256 j = i; j > 0 && a[j - 1] > a[j]; --j) {
                (a[j - 1], a[j]) = (a[j], a[j - 1]);
            }
        }
    }

    // Writes the recorded set, returns per-position price/depth (0 = unrecorded) for a window of `points`.
    function _fill(uint256 head, uint256 points, uint256 mask, uint256 seed, bool stale)
        internal
        returns (uint256[] memory price, uint256[] memory depth)
    {
        uint256 newest = _newest(head);
        if (stale) {
            // every slot of the ring holds the interval 128 older than the one that belongs there, at 1000x the price
            for (uint256 k = newest - 127; k <= newest; ++k) {
                _put(k - 128, 1e18 * 1000, 1e30);
            }
        }
        price = new uint256[](points);
        depth = new uint256[](points);
        for (uint256 i; i < points; ++i) {
            if (mask >> i & 1 == 1) {
                price[i] = 1 + uint256(keccak256(abi.encode(seed, i))) % 40;
                depth[i] = 1 + uint256(keccak256(abi.encode(seed, i, "d"))) % 40;
                _put(newest - i, price[i], depth[i]);
            }
        }
    }

    function _reference(uint256[] memory price, uint256[] memory depth, uint256 points)
        internal
        pure
        returns (bool ok, uint256 low, uint256 high, uint256 med, uint256 dmin, bool full)
    {
        uint256[] memory lo = new uint256[](points);
        uint256[] memory hi = new uint256[](points);
        uint256[] memory dp = new uint256[](points);
        uint256 n;
        dmin = type(uint256).max;
        for (uint256 i; i < points; ++i) {
            if (price[i] != 0) {
                (lo[i], hi[i], dp[i]) = (price[i], price[i], depth[i]);
                if (depth[i] < dmin) dmin = depth[i];
                ++n;
            } else {
                (lo[i], hi[i], dp[i]) = (0, type(uint256).max, 0);
            }
        }
        _sort(lo);
        _sort(hi);
        _sort(dp);
        if (n * BPS < points * COVER) return (false, 0, 0, 0, 0, false);
        low = lo[(points - 1) / 2];
        high = hi[points / 2];
        med = dp[(points - 1) / 2];
        if (low == 0 || high == type(uint256).max) return (false, 0, 0, 0, 0, false);
        return (true, low, high, med, dmin, n == points);
    }

    function _check(uint256 head, uint256 window, uint256 mask, uint256 seed, bool stale) internal {
        vm.roll(head);
        uint256 points = window / (STEP * 12);
        (uint256[] memory price, uint256[] memory depth) = _fill(head, points, mask, seed, stale);
        (bool ok, uint256 low, uint256 high, uint256 med, uint256 dmin, bool full) = _reference(price, depth, points);
        if (ok) {
            (uint256 l, uint256 h) = oracle.prices(window);
            assertEq(l, low, "low");
            assertEq(h, high, "high");
            assertEq(oracle.recovery(window), low, "recovery");
            assertEq(oracle.depth(window), med, "depth");
            if (full) {
                assertEq(oracle.depthMin(window), dmin, "depthMin");
                assertLe(oracle.depthMin(window), oracle.depth(window));
            } else {
                // strict: one unrecorded interval is enough to refuse it
                vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
                oracle.depthMin(window);
            }
            assertLe(l, h);
        } else {
            vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
            oracle.prices(window);
            vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
            oracle.depth(window);
            vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
            oracle.recovery(window);
            vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
            oracle.depthMin(window);
        }
    }

    /// Any window length from one interval up to the maximum, any set of recorded intervals.
    function testFuzz_mediansMatchABruteForceReference(uint256 window, uint256 mask, uint256 seed) public {
        window = bound(window, 600, 6 hours);
        _check(HEAD, window, mask, seed, false);
    }

    /// The same where the window wraps the ring and every other slot holds a stale, far higher entry.
    function testFuzz_mediansMatchTheReferenceWhereTheRingWraps(uint256 window, uint256 mask, uint256 seed) public {
        window = bound(window, 600, 6 hours);
        _check(HEAD_WRAP, window, mask, seed, true);
    }

    /// Windows of 6, 18 and 36 intervals need 4, 12 and 24 recorded.
    function test_theCoverageBoundaryIsTwoThirdsOfEveryWindow() public {
        vm.roll(HEAD);
        uint256 newest = _newest(HEAD);
        uint256[3] memory w = [uint256(1 hours), 3 hours, 6 hours];
        uint256[3] memory need = [uint256(4), 12, 24];
        for (uint256 k; k < 3; ++k) {
            uint256 points = w[k] / 600;
            for (uint256 i; i < need[k] - 1; ++i) {
                _put(newest - i, 7, 9);
            }
            vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
            oracle.prices(w[k]);
            _put(newest - (need[k] - 1), 7, 9);
            (uint256 low, uint256 high) = oracle.prices(w[k]);
            assertEq(low, 7);
            assertEq(high, 7);
            // clear for the next window
            for (uint256 i; i < points; ++i) {
                vm.store(address(oracle), bytes32((newest - i) % 128), bytes32(0));
            }
        }
    }

    /// An interval counts GRACE blocks after the block that follows it; until it is recorded it counts as zero for
    /// `low` and as unbounded for `high`, which moves `low` one rank down and leaves `high`.
    function test_aNewIntervalCountsAfterTheGraceAsUnrecordedUntilItIsRecorded() public {
        uint256 newest = _newest(HEAD);
        vm.roll(HEAD);
        for (uint256 i; i < 36; ++i) {
            _put(newest - i, 100 + i, 50);
        }
        (uint256 low0, uint256 high0) = oracle.prices(6 hours);
        // prices are 100..135 (position 0 = newest = 100). lower median = sorted[17] = 117, upper = sorted[18] = 118
        assertEq(low0, 117);
        assertEq(high0, 118);
        // next interval enters the window at head 26,000,111 and is not recorded yet
        vm.roll(26_000_110);
        (uint256 l1,) = oracle.prices(6 hours);
        assertEq(l1, 117, "not yet counted one block earlier");
        vm.roll(26_000_111);
        (uint256 low1, uint256 high1) = oracle.prices(6 hours);
        // the window now holds 35 recorded intervals and the new, unrecorded one
        assertEq(low1, 116, "lower median falls one rank (the zero sentinel shifts the index)");
        assertEq(high1, 118, "upper median is unchanged by an unrecorded interval at the top");
    }

    /// An empty ring entry is never an interval's record, and `latest()` is 0 on an empty ring.
    function test_anEmptyRingAnswersNothing() public {
        vm.roll(HEAD);
        assertEq(oracle.latest(), 0);
        (uint256 p, uint256 d) = oracle.sampleOf(0);
        assertEq(p, 0);
        assertEq(d, 0);
        (p, d) = oracle.sampleOf(520_000);
        assertEq(p, 0);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        oracle.depthMin(1 hours);
    }

    /// `depthMin` is the thinnest interval of the window, and refuses a window with any interval unrecorded.
    function test_depthMinIsTheThinnestIntervalAndNeedsEveryInterval() public {
        vm.roll(HEAD);
        uint256 newest = _newest(HEAD);
        for (uint256 i; i < 36; ++i) {
            _put(newest - i, 50, 1_000 + i);
        }
        assertEq(oracle.depthMin(6 hours), 1_000);
        _put(newest - 20, 50, 7);
        assertEq(oracle.depthMin(6 hours), 7);
        assertEq(oracle.depthMin(1 hours), 1_000, "the short window does not reach position 20");
        assertEq(oracle.depth(6 hours), 1_016, "the median of the same window moves one rank, not to the thin value");
        vm.store(address(oracle), bytes32((newest - 20) % 128), bytes32(0)); // unrecorded: the window is refused
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        oracle.depthMin(6 hours);
        assertEq(oracle.depth(6 hours), 1_016, "the median still prices with 35 of 36 (the gap counts as zero)");
        assertEq(oracle.depthMin(1 hours), 1_000, "a window that is complete is not affected");
    }
}
