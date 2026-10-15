// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacOracleStub, TacOracleDepthMinVariants} from "./TacOracleStub.sol";

/// The interval ring, the medians, `depthMin`, `latest` and the pair, against a sort-based reference. A venue stub
/// (TacOracleStub) writes samples straight into the ring; the deploy settings are an interval of 50 blocks, windows of
/// 1 h (6 intervals), 3 h (18) and 6 h (36), and two thirds coverage.
///
/// The fuzz tests run the default number of runs. For a long run:
///   forge test --match-path test/TacOracleReference.t.sol --fuzz-runs 20000
contract TacOracleReferenceTest is Test {
    address constant POOL = 0x0155358241411dB868BA714aE7c83A27087e3D6E;
    uint256 constant HEAD = 26_000_061; // the newest interval that counts is 520,000 (see TacBlockOracle.t.sol)

    function setUp() public {
        vm.etch(POOL, hex"fe");
    }

    function _stub(uint256 coverageBps) internal returns (TacOracleStub) {
        return new TacOracleStub(POOL, 50, 600, 600, 21_600, coverageBps);
    }

    function _deployed() internal returns (TacOracleStub) {
        return new TacOracleStub(POOL, 50, 3600, 10_800, 21_600, 6_600);
    }

    // the newest interval whose following block is more than `grace` blocks old
    function _newest(uint256 grace, uint256 blockNumber) internal pure returns (uint256) {
        return (blockNumber - 1 - grace) / 50 - 1;
    }

    // ───────────────────────── medians against a reference ─────────────────────────

    // the order statistics of the window: missing intervals count as 0 for the lower median and as unbounded for the
    // upper; a missing value at either median position, or too little coverage, means no price
    function _ref(bool[] memory rec, uint256[] memory val, uint256 cov)
        internal
        pure
        returns (bool noPrice, uint256 low, uint256 high)
    {
        uint256 p = rec.length;
        uint256 n;
        uint256[] memory lo = new uint256[](p);
        uint256[] memory hi = new uint256[](p);
        for (uint256 i; i < p; ++i) {
            if (rec[i]) {
                ++n;
                lo[i] = val[i];
                hi[i] = val[i];
            } else {
                lo[i] = 0;
                hi[i] = type(uint256).max;
            }
        }
        _bubble(lo);
        _bubble(hi);
        low = lo[(p - 1) / 2];
        high = hi[p / 2];
        noPrice = n * 10_000 < p * cov || low == 0 || high == type(uint256).max;
    }

    function _bubble(uint256[] memory a) internal pure {
        for (uint256 i; i < a.length; ++i) {
            for (uint256 j; j + 1 < a.length - i; ++j) {
                if (a[j] > a[j + 1]) (a[j], a[j + 1]) = (a[j + 1], a[j]);
            }
        }
    }

    /// `prices`, `depth` and `depthMin` equal the reference for every window length, recorded subset, ties, coverage
    /// setting, chain height (including chains whose window reaches interval 0) and stale ring contents.
    function testFuzz_pricesDepthAndDepthMinMatchAReference(uint256 seed, uint16 covRaw, uint8 pRaw, bool young)
        public
    {
        uint256 cov = uint256(covRaw) % 10_000 + 1;
        uint256 p = uint256(pRaw) % 36 + 1;
        TacOracleStub o = _stub(cov);
        uint256 bn = young ? 61 + seed % 3000 : HEAD;
        vm.roll(bn);
        uint256 newest = _newest(10, bn);
        bool[] memory rec = new bool[](p);
        uint256[] memory val = new uint256[](p);
        uint256[] memory dep = new uint256[](p);
        uint256 mask = uint256(keccak256(abi.encode(seed, "mask")));
        for (uint256 i; i < p; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            // a small value range on odd seeds makes ties
            val[i] = (seed & 1 == 1) ? 1 + r % 5 : 1 + r % 1e18;
            dep[i] = (seed & 2 == 2) ? 1 + (r >> 64) % 5 : 1 + (r >> 64) % 1e18;
            rec[i] = (mask >> i) & 1 == 1 && i <= newest; // an interval before the chain's first does not exist
            if (rec[i]) {
                o.put(newest - i, val[i], dep[i]);
            } else if (i <= newest && newest - i >= 128) {
                o.put(newest - i - 128, 777, 777); // the previous ring cycle's entry in the same slot does not count
            }
        }
        (bool noPrice, uint256 low, uint256 high) = _ref(rec, val, cov);
        uint256 window = p * 600;
        if (noPrice) {
            vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
            o.prices(window);
            vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
            o.depthMin(window);
            return;
        }
        (uint256 l, uint256 h) = o.prices(window);
        assertEq(l, low, "low");
        assertEq(h, high, "high");
        uint256 smallest = type(uint256).max;
        uint256 count;
        for (uint256 i; i < p; ++i) {
            if (rec[i]) {
                ++count;
                if (dep[i] < smallest) smallest = dep[i];
            }
        }
        if (count != p) {
            vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
            o.depthMin(window);
        } else {
            assertEq(o.depthMin(window), smallest, "depthMin");
        }
    }

    /// Lifting `low` above the price the other intervals hold, or pulling `high` below it, takes more than half of ALL
    /// the window's intervals, whichever intervals are recorded.
    function testFuzz_movingAMedianTakesMoreThanHalfOfAllIntervals(uint256 seed, uint8 pRaw, uint8 mRaw) public {
        uint256 p = uint256(pRaw) % 36 + 1;
        uint256 m = uint256(mRaw) % (p + 1); // intervals at the moved value
        uint256 base = 1000;
        TacOracleStub o = _stub(1); // coverage as lax as it gets
        vm.roll(HEAD);
        uint256 newest = _newest(10, HEAD);
        uint256 mask = uint256(keccak256(abi.encode(seed, "m")));
        for (uint256 dir; dir < 2; ++dir) {
            uint256 moved = dir == 0 ? 5000 : 10; // up (for `low`), down (for `high`)
            o.clearRing();
            for (uint256 i; i < p; ++i) {
                bool atMoved = _isMoved(seed, i, p, m);
                bool recorded = atMoved ? (mask >> (i + 64)) & 1 == 1 : (mask >> i) & 1 == 1;
                if (!recorded) continue;
                o.put(newest - i, atMoved ? moved : base, 1e18);
            }
            try o.prices(p * 600) returns (uint256 low, uint256 high) {
                if (dir == 0 && low > base) assertGe(m, p / 2 + 1, "low moved by half or fewer");
                if (dir == 1 && high < base) assertGe(m, p / 2 + 1, "high moved by half or fewer");
            } catch {}
        }
    }

    // m distinct positions of p, by a seeded shuffle
    function _isMoved(uint256 seed, uint256 i, uint256 p, uint256 m) internal pure returns (bool) {
        uint256[] memory idx = new uint256[](p);
        for (uint256 j; j < p; ++j) {
            idx[j] = j;
        }
        for (uint256 j = p; j > 1; --j) {
            uint256 k = uint256(keccak256(abi.encode(seed, j))) % j;
            (idx[j - 1], idx[k]) = (idx[k], idx[j - 1]);
        }
        for (uint256 j; j < m; ++j) {
            if (idx[j] == i) return true;
        }
        return false;
    }

    /// With every interval recorded, p/2 + 1 intervals at another value move `low` (up) and `high` (down), and p/2 do not.
    function test_halfOfTheIntervalsPlusOneMoveTheMedians() public {
        for (uint256 p = 1; p <= 36; ++p) {
            TacOracleStub o = _stub(6_600);
            vm.roll(HEAD);
            uint256 newest = _newest(10, HEAD);
            for (uint256 m = p / 2; m <= p / 2 + 1; ++m) {
                for (uint256 dir; dir < 2; ++dir) {
                    o.clearRing();
                    for (uint256 i; i < p; ++i) {
                        o.put(newest - i, i < m ? (dir == 0 ? 5000 : 10) : 1000, 1e18);
                    }
                    (uint256 low, uint256 high) = o.prices(p * 600);
                    if (dir == 0) assertEq(low > 1000, m == p / 2 + 1, "low");
                    else assertEq(high < 1000, m == p / 2 + 1, "high");
                }
            }
        }
    }

    /// An empty ring slot is not a recorded interval 0: on a chain whose window reaches interval 0, an unrecorded
    /// interval 0 counts as unrecorded.
    function test_anEmptyRingSlotIsNotARecordedInterval0() public {
        TacOracleStub o = _stub(6_600);
        vm.roll(111); // the newest counted interval is 1
        o.put(1, 1000, 1e18);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        o.prices(1200); // intervals 1 and 0: one of two recorded, below 66%
        TacOracleStub lax = _stub(1);
        lax.put(1, 1000, 1e18);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        lax.prices(1200); // the unrecorded interval 0 sits at the lower middle: no price
        (uint256 price, uint256 depth) = o.sampleOf(0);
        assertEq(price + depth, 0);
        assertEq(o.latest(), 1000);
    }

    // ───────────────────────── latest ─────────────────────────

    /// `latest` is the newest recorded interval's price within MAX_WINDOW (36 intervals), without the GRACE wait that
    /// `prices` applies, and 0 when nothing in that range is recorded.
    function test_latestIsTheNewestRecordedPriceWithinTheMaxWindow() public {
        TacOracleStub o = _deployed();
        vm.roll(26_000_055);
        uint256 newestNow = _newest(0, 26_000_055); // 520,000
        assertEq(_newest(10, 26_000_055), newestNow - 1, "the newest interval is within GRACE");
        assertEq(o.latest(), 0);
        o.put(newestNow - 36, 555, 1e18); // one interval beyond the 36
        assertEq(o.latest(), 0, "out of range");
        o.put(newestNow - 35, 444, 1e18);
        assertEq(o.latest(), 444, "the oldest in range");
        o.put(newestNow - 3, 333, 1e18);
        assertEq(o.latest(), 333, "the newest recorded");
        o.put(newestNow, 777, 1e18);
        assertEq(o.latest(), 777, "the newest interval counts at once");
        (uint256 p, uint256 d) = o.sampleOf(newestNow);
        assertEq(p, 777);
        assertEq(d, 1e18);
    }

    // ───────────────────────── depthMin ─────────────────────────

    function _fill(TacOracleStub o, uint256 newest, uint256 n, uint256 oldestLifted, uint256 liftedDepth, uint256 depth)
        internal
    {
        // intervals newest .. newest-(n-1) recorded; the `oldestLifted` oldest of them carry `liftedDepth`
        for (uint256 i; i < n; ++i) {
            o.put(newest - i, 1000, i >= n - oldestLifted ? liftedDepth : depth);
        }
    }

    /// A depth lifted for 24 of 36 intervals lifts the lower median `depth`, not `depthMin`: the 12 other intervals set it.
    function test_depthMinIgnoresADepthLiftedForPartOfTheWindow() public {
        TacOracleStub o = _deployed();
        vm.roll(HEAD);
        _fill(o, _newest(10, HEAD), 36, 24, 100e18, 3e18);
        assertEq(o.depthMin(21_600), 3e18);
    }

    /// `depthMin` needs EVERY interval of its window recorded, which is stricter than the coverage of `prices` and
    /// `depth`; a smaller window needs only its own intervals; windows outside [one interval, MAX_WINDOW] revert.
    function test_depthMinNeedsEveryIntervalOfItsWindow() public {
        TacOracleStub o = _deployed();
        vm.roll(HEAD);
        uint256 newest = _newest(10, HEAD);
        _fill(o, newest, 35, 0, 0, 3e18); // the oldest of the 36 is missing
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        o.depthMin(21_600);
        assertEq(o.depthMin(21_000), 3e18, "a window of 35 intervals needs only those");
        o.put(newest - 35, 1000, 3e18);
        assertEq(o.depthMin(21_600), 3e18);
        assertEq(o.depthMin(10_800), 3e18);
        vm.expectRevert(TacIntervalOracle.BadWindow.selector);
        o.depthMin(21_601);
        vm.expectRevert(TacIntervalOracle.BadWindow.selector);
        o.depthMin(599);
    }

    /// With 12 thin intervals unrecorded `depthMin` reverts instead of reading the thicker rest; recording them gives
    /// the true minimum.
    function test_depthMinRevertsUntilTheThinIntervalsAreRecorded() public {
        TacOracleStub o = _deployed();
        vm.roll(HEAD);
        uint256 newest = _newest(10, HEAD);
        for (uint256 i; i < 24; ++i) {
            o.put(newest - i, 1000, 3e18);
        }
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        o.depthMin(21_600);
        for (uint256 i = 24; i < 36; ++i) {
            o.put(newest - i, 1000, 1e18);
        }
        assertEq(o.depthMin(21_600), 1e18);
    }

    // ───────────────────────── a relaxed depthMin rule is caught ─────────────────────────

    function _call(address o, bytes4 sel, uint256 window) internal view returns (bool ok, uint256 v) {
        (bool success, bytes memory out) = o.staticcall(abi.encodeWithSelector(sel, window));
        if (success && out.length == 32) return (true, abi.decode(out, (uint256)));
        return (false, 0);
    }

    // whether `o.<sel>(window)` behaves as "every interval of the window recorded, otherwise no value"
    function _everyIntervalRule(TacOracleStub o, bytes4 sel) internal returns (bool good) {
        good = true;
        vm.roll(HEAD);
        uint256 newest = _newest(10, HEAD);
        // all 36 recorded: the minimum, wherever it sits
        for (uint256 i; i < 36; ++i) {
            o.put(newest - i, 1000, i == 17 ? 2e18 : 5e18);
        }
        (bool ok, uint256 v) = _call(address(o), sel, 21_600);
        if (!ok || v != 2e18) good = false;
        // any single interval missing (newest, oldest, middle): no value
        for (uint256 j; j < 36; ++j) {
            o.clearRing();
            for (uint256 i; i < 36; ++i) {
                if (i != j) o.put(newest - i, 1000, 5e18);
            }
            (ok,) = _call(address(o), sel, 21_600);
            if (ok) good = false;
        }
        // 24 and 30 of 36 recorded: no value
        for (uint256 cut = 24; cut <= 30; cut += 6) {
            o.clearRing();
            for (uint256 i; i < cut; ++i) {
                o.put(newest - i, 1000, 5e18);
            }
            (ok,) = _call(address(o), sel, 21_600);
            if (ok) good = false;
        }
        // a smaller window needs only its own intervals
        o.clearRing();
        for (uint256 i; i < 6; ++i) {
            o.put(newest - i, 1000, 4e18 + i);
        }
        (ok, v) = _call(address(o), sel, 3_600);
        if (!ok || v != 4e18) good = false;
        (ok, v) = _call(address(o), sel, 600);
        if (!ok || v != 4e18) good = false;
        o.clearRing();
        (ok,) = _call(address(o), sel, 600);
        if (ok) good = false;
        // a window of 35 intervals does not need the 36th
        for (uint256 i; i < 35; ++i) {
            o.put(newest - i, 1000, 6e18);
        }
        (ok, v) = _call(address(o), sel, 21_599);
        if (!ok || v != 6e18) good = false;
    }

    /// The every-interval checks hold for `depthMin` and for the variant that replicates it, and fail for each of the
    /// seven relaxed variants.
    function test_aRelaxedDepthMinRuleIsCaught() public {
        uint256 baseline = vm.snapshotState();
        TacOracleDepthMinVariants same = new TacOracleDepthMinVariants(POOL, 0);
        assertTrue(_everyIntervalRule(same, same.depthMinVariant.selector), "the replica passes");
        vm.revertToState(baseline);
        TacOracleStub real = _deployed();
        assertTrue(_everyIntervalRule(real, real.depthMin.selector), "depthMin passes");
        for (uint256 m = 1; m <= 7; ++m) {
            vm.revertToState(baseline);
            TacOracleDepthMinVariants relaxed = new TacOracleDepthMinVariants(POOL, m);
            assertFalse(_everyIntervalRule(relaxed, relaxed.depthMinVariant.selector), "a relaxed rule passed");
        }
    }

    // ───────────────────────── the pair ─────────────────────────

    /// A pair needs venues of the same STEP over different pools; its `depthMin` is the smaller venue's.
    function test_aPairNeedsTheSameStepOverDifferentPoolsAndTakesTheSmallerDepthMin() public {
        TacOracleStub a = _deployed();
        address pool3 = address(0xB0B3);
        vm.etch(pool3, hex"fe");
        TacOracleStub otherStep = new TacOracleStub(pool3, 25, 3600, 10_800, 21_600, 6_600);
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        new TacPairOracle(address(a), address(otherStep));
        TacOracleStub samePool = _deployed();
        vm.expectRevert(TacPairOracle.BadConfig.selector);
        new TacPairOracle(address(a), address(samePool));
        address pool2 = address(0xB0B2);
        vm.etch(pool2, hex"fe");
        TacOracleStub c = new TacOracleStub(pool2, 50, 3600, 10_800, 21_600, 6_600);
        TacPairOracle pair = new TacPairOracle(address(a), address(c));
        assertEq(pair.STEP(), 50);
        vm.roll(HEAD);
        uint256 newest = _newest(10, HEAD);
        for (uint256 i; i < 36; ++i) {
            a.put(newest - i, 1000, 5e18);
            c.put(newest - i, 1000, i == 7 ? 2e18 : 9e18);
        }
        assertEq(pair.depthMin(21_600), 2e18);
    }

    // ───────────────────────── gas ─────────────────────────

    /// The views over a full window stay cheap (the samples are warm here; a cold window adds 2,100 gas per interval).
    function test_theWindowViewsStayUnderTheGasBounds() public {
        TacOracleStub o = _deployed();
        vm.roll(HEAD);
        uint256 newest = _newest(10, HEAD);
        for (uint256 i; i < 36; ++i) {
            o.put(newest - i, 1000 + i, 1e18);
        }
        uint256 g = gasleft();
        o.prices(21_600);
        assertLt(g - gasleft(), 100_000, "prices over 36 intervals");
        g = gasleft();
        o.depthMin(21_600);
        assertLt(g - gasleft(), 100_000, "depthMin over 36 intervals");
        g = gasleft();
        o.latest();
        assertLt(g - gasleft(), 20_000, "latest");
    }
}
