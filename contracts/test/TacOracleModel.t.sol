// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";
import {SynthOracle} from "./TacSynthChain.sol";

// Reference-model test for the interval oracle. Default fuzz runs are modest; for a long campaign run
//   FOUNDRY_FUZZ_RUNS=10000 forge test --match-path test/TacOracleModel.t.sol

/// Differential test: the oracle's prices() / depth() / recovery() / latest() / sampleOf(), against a model written
/// from the definition (rank selection over the window's intervals with unrecorded ones as -inf for the low median and
/// +inf for the high median), over random rings: any density of recorded intervals, repeated values, stale tags left by
/// the ring's wrap, intervals past the grace edge, early chains, random step / windows / coverage.
contract TacOracleModelTest is Test {
    address constant POOL = address(0x000000000000000000000000000000000000c0DE);
    uint256 constant RING = 128;
    uint256 constant GRACE = 10;

    bytes4 constant OK = bytes4(0);

    struct Cfg {
        uint256 step;
        uint256 shortWindow;
        uint256 window;
        uint256 maxWindow;
        uint256 cov;
    }

    address constant POOL2 = address(0x000000000000000000000000000000000000dEaD);

    function setUp() public {
        vm.etch(POOL, hex"00");
        vm.etch(POOL2, hex"00");
    }

    function _rnd(uint256 seed, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i)));
    }

    function _cfg(uint256 seed) internal pure returns (Cfg memory c) {
        c.step = 11 + _rnd(seed, 1) % 190; // 11 .. 200 (> GRACE)
        uint256 unit = c.step * 12;
        c.shortWindow = unit * (1 + _rnd(seed, 2) % 4);
        c.window = c.shortWindow * (1 + _rnd(seed, 3) % 3);
        c.maxWindow = c.window * (1 + _rnd(seed, 4) % 6); // at most 72 intervals, under the ring
        uint256 pick = _rnd(seed, 5) % 5;
        c.cov = pick == 0 ? 1 : pick == 1 ? 10_000 : pick == 2 ? 6_600 : 1 + _rnd(seed, 6) % 10_000;
    }

    /// Fills the ring the way records would, plus noise a wrapped ring leaves behind.
    function _fill(SynthOracle o, uint256 seed, uint256 headInterval) internal {
        uint256 dens = _rnd(seed, 10) % 101;
        uint256 span = 140;
        uint256 lo = headInterval > span ? headInterval - span : 0;
        bool ties = _rnd(seed, 11) % 2 == 0;
        for (uint256 j = lo; j <= headInterval + 3; ++j) {
            uint256 r = _rnd(seed, 1000 + j);
            if (r % 100 < dens) {
                uint256 price = ties ? 1 + (r >> 8) % 6 : 1 + (r >> 8) % 1e15;
                uint256 depth = ties ? (r >> 40) % 4 : (r >> 40) % 1e20;
                vm.store(address(o), bytes32(j % RING), bytes32(j << 208 | price << 104 | depth));
            } else if ((r >> 100) % 8 == 0 && j >= RING) {
                // a stale entry from one ring earlier
                uint256 stale = j - RING;
                vm.store(address(o), bytes32(j % RING), bytes32(stale << 208 | (1 + (r >> 8) % 9) << 104 | 7));
            }
        }
    }

    struct Model {
        bytes4 err;
        uint256 low;
        uint256 high;
        uint256 depthLow;
        uint256 depthMin;
        bytes4 depthMinErr; // set when the window's own guard passes but an interval is missing
    }

    function _recorded(SynthOracle o, uint256 j) internal view returns (bool ok, uint256 price, uint256 depth) {
        uint256 s = uint256(vm.load(address(o), bytes32(j % RING)));
        // an empty entry is not a record of interval 0
        if (s != 0 && s >> 208 == j) return (true, s >> 104 & ((1 << 104) - 1), s & ((1 << 104) - 1));
        return (false, 0, 0);
    }

    // rank-select: the element at sorted position `rank` of the keys, ties broken by position; keys of unrecorded
    // intervals are 0 (before every recorded key, which are value + 1) or max (after).
    function _select(uint256[] memory keys, uint256 rank) internal pure returns (uint256 index) {
        for (uint256 e; e < keys.length; ++e) {
            uint256 r;
            for (uint256 x; x < keys.length; ++x) {
                if (keys[x] < keys[e] || (keys[x] == keys[e] && x < e)) ++r;
            }
            if (r == rank) return e;
        }
        revert("rank not found");
    }

    function _model(SynthOracle o, Cfg memory c, uint256 window) internal view returns (Model memory m) {
        uint256 unit = c.step * 12;
        if (window < unit || window > c.maxWindow) {
            m.err = TacIntervalOracle.BadWindow.selector;
            return m;
        }
        uint256 points = window / unit;
        if (block.number - 1 < GRACE + c.step) {
            m.err = TacIntervalOracle.TooFewSamples.selector;
            return m;
        }
        uint256 newest = (block.number - 1 - GRACE) / c.step - 1;
        uint256[] memory kLow = new uint256[](points);
        uint256[] memory kHigh = new uint256[](points);
        uint256[] memory prices = new uint256[](points);
        uint256[] memory depths = new uint256[](points);
        bool[] memory rec = new bool[](points);
        uint256 n;
        for (uint256 i; i < points; ++i) {
            if (i <= newest) {
                (bool ok, uint256 p, uint256 d) = _recorded(o, newest - i);
                if (ok) {
                    rec[i] = true;
                    prices[i] = p;
                    depths[i] = d;
                    ++n;
                }
            }
            kLow[i] = rec[i] ? prices[i] + 1 : 0;
            kHigh[i] = rec[i] ? prices[i] : type(uint256).max;
        }
        if (n * 10_000 < points * c.cov) {
            m.err = TacIntervalOracle.TooFewSamples.selector;
            return m;
        }
        uint256 lowAt = _select(kLow, (points - 1) / 2);
        uint256 highAt = _select(kHigh, points / 2);
        if (!rec[lowAt] || !rec[highAt]) {
            m.err = TacIntervalOracle.TooFewSamples.selector;
            return m;
        }
        m.low = prices[lowAt];
        m.high = prices[highAt];
        // depth: the same guard (both medians recorded), the lower median of the depths
        uint256[] memory dKey = new uint256[](points);
        for (uint256 i; i < points; ++i) {
            dKey[i] = rec[i] ? depths[i] + 1 : 0;
        }
        m.depthLow = depths[_select(dKey, (points - 1) / 2)];
        // depthMin: the smallest recorded depth under the same coverage and median guard
        uint256[] memory dKeyMax = new uint256[](points);
        for (uint256 i; i < points; ++i) {
            dKeyMax[i] = rec[i] ? depths[i] : type(uint256).max;
        }
        m.depthMin = depths[_select(dKeyMax, 0)];
        m.depthMinErr = n == points ? OK : TacIntervalOracle.TooFewSamples.selector; // every interval, no omission trick
    }

    function _check(SynthOracle o, Cfg memory c, uint256 window) internal {
        Model memory m = _model(o, c, window);
        try o.prices(window) returns (uint256 low, uint256 high) {
            assertEq(m.err, OK, "prices returned where the model reverts");
            assertEq(low, m.low, "low");
            assertEq(high, m.high, "high");
            assertLe(low, high);
        } catch (bytes memory e) {
            assertTrue(m.err != OK, "reverted where the model returns");
            assertEq(bytes4(e), m.err, "prices revert reason");
        }
        try o.depth(window) returns (uint256 d) {
            assertEq(m.err, OK, "depth returned where the model reverts");
            assertEq(d, m.depthLow, "depth");
        } catch (bytes memory e) {
            assertTrue(m.err != OK, "reverted where the model returns");
            assertEq(bytes4(e), m.err, "depth revert reason");
        }
        bytes4 wantMin = m.err != OK ? m.err : m.depthMinErr;
        try o.depthMin(window) returns (uint256 d) {
            assertEq(wantMin, OK, "depthMin returned where the model reverts");
            assertEq(d, m.depthMin, "depthMin");
        } catch (bytes memory e) {
            assertTrue(wantMin != OK, "depthMin reverted where the model returns");
            assertEq(bytes4(e), wantMin, "depthMin revert reason");
        }
        try o.recovery(window) returns (uint256 r) {
            assertEq(m.err, OK, "recovery returned where the model reverts");
            assertEq(r, m.low, "recovery is the low median");
        } catch (bytes memory e) {
            assertTrue(m.err != OK, "reverted where the model returns");
            assertEq(bytes4(e), m.err, "recovery revert reason");
        }
    }

    function _checkLatest(SynthOracle o, Cfg memory c) internal {
        // the model of latest(): newest interval with a full block after it, scanned over MAX_WINDOW's points
        if (block.number - 1 < c.step) {
            try o.latest() returns (uint256) {
                fail("latest returned on an empty chain");
            } catch (bytes memory e) {
                assertEq(bytes4(e), TacIntervalOracle.TooFewSamples.selector);
            }
            return;
        }
        uint256 newest = (block.number - 1) / c.step - 1;
        uint256 points = c.maxWindow / (c.step * 12);
        uint256 want;
        for (uint256 i; i < points && i <= newest; ++i) {
            (bool ok, uint256 p,) = _recorded(o, newest - i);
            if (ok) {
                want = p;
                break;
            }
        }
        assertEq(o.latest(), want, "latest");
    }

    function _deploy(Cfg memory c) internal returns (SynthOracle) {
        return new SynthOracle(POOL, c.step, c.shortWindow, c.window, c.maxWindow, c.cov);
    }

    function _deployOver(address pool, Cfg memory c) internal returns (SynthOracle) {
        return new SynthOracle(pool, c.step, c.shortWindow, c.window, c.maxWindow, c.cov);
    }

    function _head(uint256 seed, Cfg memory c) internal pure returns (uint256 bn, uint256 headInterval) {
        uint256 mode = _rnd(seed, 20) % 4;
        if (mode == 0) {
            bn = 2 + _rnd(seed, 21) % (30 * c.step); // an early chain
        } else {
            bn = 26_000_000 + _rnd(seed, 21) % 1_000_000;
        }
        headInterval = bn / c.step;
    }

    function testFuzz_mediansMatchTheModel(uint256 seed) public {
        Cfg memory c = _cfg(seed);
        (uint256 bn, uint256 headInterval) = _head(seed, c);
        vm.roll(bn);
        SynthOracle o = _deploy(c);
        _fill(o, seed, headInterval);
        uint256 unit = c.step * 12;
        _check(o, c, c.shortWindow);
        _check(o, c, c.window);
        _check(o, c, c.maxWindow);
        _check(o, c, unit);
        _check(o, c, unit + _rnd(seed, 30) % unit); // not a whole number of intervals: rounds down
        _check(o, c, c.maxWindow + 1);
        _check(o, c, unit - 1);
        _checkLatest(o, c);
        // sampleOf agrees with the ring
        uint256 j = headInterval > 5 ? headInterval - _rnd(seed, 31) % 5 : 0;
        (bool ok, uint256 p, uint256 d) = _recorded(o, j);
        (uint256 gp, uint256 gd) = o.sampleOf(j);
        assertEq(gp, ok ? p : 0);
        assertEq(gd, ok ? d : 0);
    }

    /// The same, exhaustively over the launch configuration's window sizes and every count of recorded intervals in
    /// a contiguous run ending at a chosen position (a few thousand ring shapes).
    function test_exhaustiveLaunchShapes() public {
        Cfg memory c = Cfg(50, 3_600, 10_800, 21_600, 6_600);
        vm.roll(26_000_061);
        SynthOracle o = _deploy(c);
        uint256 newest = (block.number - 1 - GRACE) / c.step - 1;
        // gaps: for each stride s in 1..7 and phase f in 0..s-1, intervals with (i % s == f) are missing
        uint256 shapes;
        for (uint256 s = 1; s <= 7; ++s) {
            for (uint256 f; f < s; ++f) {
                for (uint256 tilt; tilt < 3; ++tilt) {
                    for (uint256 i; i < 40; ++i) {
                        uint256 j = newest - i;
                        bool present = (i % s != f) || s == 1;
                        if (tilt == 1 && i < 10) present = false; // the newest ten missing
                        if (tilt == 2 && i >= 20) present = false; // only the newest twenty
                        uint256 price = 1e13 + (i * 7919 + s * 13 + f) % 23 * 1e12;
                        bytes32 word = present ? bytes32(j << 208 | price << 104 | (price % 5) * 1e18) : bytes32(0);
                        vm.store(address(o), bytes32(j % RING), word);
                    }
                    _check(o, c, 3_600);
                    _check(o, c, 10_800);
                    _check(o, c, 21_600);
                    _check(o, c, 600);
                    ++shapes;
                }
            }
        }
        assertEq(shapes, 84);
    }

    /// The newest interval that counts is exactly the newest whose following block is old enough: checked at every
    /// block height of a long range, for four steps, through the public `latest()` (no grace) and one-interval
    /// `prices()` (GRACE blocks).
    function test_theNewestCountedIntervalIsExactlyTheNewestOldEnough() public {
        uint256[4] memory steps = [uint256(11), 25, 50, 200];
        for (uint256 s; s < 4; ++s) {
            uint256 step = steps[s];
            uint256 unit = step * 12;
            SynthOracle o = new SynthOracle(POOL, step, unit, unit, unit, 1);
            // every interval below 40 holds price 1000 + interval
            for (uint256 j; j < 40; ++j) {
                vm.store(address(o), bytes32(j % RING), bytes32(j << 208 | (1000 + j) << 104 | 5));
            }
            for (uint256 bn = 1; bn <= 30 * step; ++bn) {
                vm.roll(bn);
                // latest(): interval j counts when (j + 1) * step < bn, i.e. (j + 1) * step <= bn - 1
                if (bn - 1 >= step) {
                    uint256 want = (bn - 1) / step - 1;
                    assertLe((want + 1) * step, bn - 1);
                    assertGt((want + 2) * step, bn - 1);
                    assertEq(o.latest(), 1000 + want, "latest");
                } else {
                    vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
                    o.latest();
                }
                // prices(): the same with GRACE more blocks
                if (bn - 1 >= GRACE + step) {
                    uint256 want2 = (bn - 1 - GRACE) / step - 1;
                    assertLe((want2 + 1) * step + GRACE, bn - 1);
                    assertGt((want2 + 2) * step + GRACE, bn - 1);
                    (uint256 low, uint256 high) = o.prices(unit);
                    assertEq(low, 1000 + want2, "prices low");
                    assertEq(high, 1000 + want2, "prices high");
                } else {
                    vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
                    o.prices(unit);
                }
            }
        }
    }

    /// The pair against its definition over two independently filled venues: the combined value is the min / max of
    /// the venues' own values, and a venue that reverts takes the pair with it.
    function testFuzz_pairIsTheWorseOfTheVenues(uint256 seed) public {
        Cfg memory c = _cfg(seed);
        (uint256 bn, uint256 headInterval) = _head(seed, c);
        vm.roll(bn);
        SynthOracle a = _deployOver(POOL, c);
        SynthOracle b = _deployOver(POOL2, c);
        _fill(a, seed, headInterval);
        _fill(b, seed ^ 0xB, headInterval);
        a.setSpot(1 + _rnd(seed, 40) % 1e15);
        b.setSpot(1 + _rnd(seed, 41) % 1e15);
        TacPairOracle pair = new TacPairOracle(address(a), address(b));
        uint256[3] memory ws = [c.shortWindow, c.window, c.maxWindow];
        for (uint256 k; k < 3; ++k) {
            uint256 w = ws[k];
            bool okA;
            bool okB;
            uint256 lowA;
            uint256 highA;
            uint256 lowB;
            uint256 highB;
            try a.prices(w) returns (uint256 l, uint256 h) {
                (okA, lowA, highA) = (true, l, h);
            } catch {}
            try b.prices(w) returns (uint256 l, uint256 h) {
                (okB, lowB, highB) = (true, l, h);
            } catch {}
            try pair.prices(w) returns (uint256 l, uint256 h) {
                assertTrue(okA && okB, "pair priced with a venue that has none");
                assertEq(l, lowA < lowB ? lowA : lowB);
                assertEq(h, highA > highB ? highA : highB);
            } catch {
                assertTrue(!(okA && okB), "pair has no price though both venues do");
            }
            try pair.recovery(w) returns (uint256 r) {
                assertTrue(okA && okB);
                assertEq(r, lowA > lowB ? lowA : lowB);
            } catch {
                assertTrue(!(okA && okB));
            }
            uint256 dA;
            uint256 dB;
            bool dOkA;
            bool dOkB;
            try a.depth(w) returns (uint256 d) {
                (dOkA, dA) = (true, d);
            } catch {}
            try b.depth(w) returns (uint256 d) {
                (dOkB, dB) = (true, d);
            } catch {}
            try pair.depth(w) returns (uint256 d) {
                assertTrue(dOkA && dOkB);
                assertEq(d, dA < dB ? dA : dB);
            } catch {
                assertTrue(!(dOkA && dOkB));
            }
        }
        {
            bool mA;
            bool mB;
            uint256 minA;
            uint256 minB;
            try a.depthMin(c.window) returns (uint256 d) {
                (mA, minA) = (true, d);
            } catch {}
            try b.depthMin(c.window) returns (uint256 d) {
                (mB, minB) = (true, d);
            } catch {}
            try pair.depthMin(c.window) returns (uint256 d) {
                assertTrue(mA && mB);
                assertEq(d, minA < minB ? minA : minB);
            } catch {
                assertTrue(!(mA && mB));
            }
        }
        assertEq(pair.spot(), a.spot() < b.spot() ? a.spot() : b.spot());
        if (block.number - 1 >= c.step) {
            uint256 la = a.latest();
            uint256 lb = b.latest();
            assertEq(pair.latest(), la < lb ? la : lb, "the lower of the venues' newest prices");
        }
    }
}
