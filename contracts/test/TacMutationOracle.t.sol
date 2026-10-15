// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {SynthOracle, SynthChain, SynthHistory} from "./TacSynthChain.sol";

/// The record path and the medians of the shipped base class, end to end on a synthetic chain, with the launch
/// parameters (50-block intervals, windows 1h/3h/6h, two thirds coverage). The tests choose the prices, the depths and
/// the sample blocks, so they pin the header, block-hash, ring and coverage rules without a network.
contract TacMutationOracleTest is SynthChain {
    SynthOracle oracle;
    uint256 constant K0 = 600_000; // first interval used
    uint256 constant BASE = (K0 + 25) * STEP; // block height the tests start at

    function setUp() public {
        vm.etch(HISTORY, address(new SynthHistory()).code);
        vm.etch(POOL, hex"00");
        oracle = new SynthOracle(POOL, STEP, 3_600, 10_800, 21_600, 6_600);
        vm.roll(BASE);
    }

    function _rec(uint256 interval, uint256 offset, uint256 price, uint256 depth) internal returns (Rec memory r) {
        (bytes32 sa, bytes32 sb) = oracle.slots();
        if (block.number <= (interval + 1) * STEP) vm.roll((interval + 1) * STEP + 20);
        r = _build(interval, offset, price, depth, sa, sb);
        _register(r.header, r.number);
        _register(r.next, (interval + 1) * STEP);
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    function _put(uint256 interval, uint256 price, uint256 depth) internal {
        _rec(interval, interval % STEP, price, depth);
    }

    // ───── the record path ─────

    function test_recordStoresPriceAndDepth() public {
        uint256 k = K0 + 10;
        (uint256 p, uint256 d) = (7e13, 3.5e18);
        _rec(k, 17, p, d);
        (uint256 gp, uint256 gd) = oracle.sampleOf(k);
        assertEq(gp, p);
        assertEq(gd, d);
        (gp, gd) = oracle.sampleOf(k + 1);
        assertEq(gp, 0);
        assertEq(gd, 0);
        // the packed word: interval | price | depth
        assertEq(uint256(vm.load(address(oracle), bytes32(k % 128))), k << 208 | p << 104 | d);
    }

    function test_theSampleBlockIsPickedByTheNextBlocksMixHash() public {
        uint256 k = K0 + 11;
        // a header at the wrong offset (mixHash says 17, header number says offset 18)
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 18, 7e13, 3e18, sa, sb);
        bytes memory next = _headerRlp((k + 1) * STEP, bytes32(0), bytes32(uint256(17)));
        _register(r.header, r.number);
        _register(next, (k + 1) * STEP);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(r.header, next, r.account, r.proofA, r.proofB);
        // a mixHash that is not below STEP picks offset mixHash % STEP
        bytes memory next2 = _headerRlp((k + 1) * STEP, bytes32(0), bytes32(uint256(18 + 50 * 7)));
        _register(next2, (k + 1) * STEP);
        oracle.record(r.header, next2, r.account, r.proofA, r.proofB);
    }

    function test_theNextBlockMustBeTheFirstOfTheFollowingInterval() public {
        uint256 k = K0 + 12;
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 5, 7e13, 3e18, sa, sb);
        _register(r.header, r.number);
        bytes memory late = _headerRlp((k + 1) * STEP + 1, bytes32(0), bytes32(uint256(5)));
        _register(late, (k + 1) * STEP + 1);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(r.header, late, r.account, r.proofA, r.proofB);
        bytes memory early = _headerRlp((k + 1) * STEP - 1, bytes32(0), bytes32(uint256(5)));
        _register(early, (k + 1) * STEP - 1);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(r.header, early, r.account, r.proofA, r.proofB);
    }

    function test_anIntervalIsRecordedOnceEvenWithOtherData() public {
        uint256 k = K0 + 13;
        _rec(k, 3, 7e13, 3e18);
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 3, 9e13, 4e18, sa, sb); // a different (equally valid) state
        _register(r.header, r.number);
        _register(r.next, (k + 1) * STEP);
        vm.expectRevert(TacIntervalOracle.AlreadyRecorded.selector);
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
        (uint256 p,) = oracle.sampleOf(k);
        assertEq(p, 7e13);
    }

    function test_zeroPriceAndOversizedValuesAreRefused() public {
        uint256 mask = (1 << 104) - 1;
        _expectBad(K0 + 14, 0, 3e18); // a zero price is not a price
        _expectBad(K0 + 15, mask + 1, 3e18); // would spill into the interval field
        _expectBad(K0 + 16, 7e13, mask + 1); // would spill into the price field
        // the maxima themselves are accepted
        _rec(K0 + 17, 5, mask, mask);
        (uint256 p, uint256 d) = oracle.sampleOf(K0 + 17);
        assertEq(p, mask);
        assertEq(d, mask);
    }

    function _expectBad(uint256 k, uint256 price, uint256 depth) internal {
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 3, price, depth, sa, sb);
        _register(r.header, r.number);
        _register(r.next, (k + 1) * STEP);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    function test_aZeroDepthIsStoredAsZero() public {
        _rec(K0 + 18, 5, 7e13, 0);
        (uint256 p, uint256 d) = oracle.sampleOf(K0 + 18);
        assertEq(p, 7e13);
        assertEq(d, 0);
    }

    function test_aTamperedHeaderOrProofIsRefused() public {
        uint256 k = K0 + 19;
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 9, 7e13, 3e18, sa, sb);
        _register(r.header, r.number);
        _register(r.next, (k + 1) * STEP);
        bytes memory bad = bytes.concat(r.header);
        bad[40] = bad[40] ^ 0x01; // a coinbase byte: the hash differs from the registered one
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        oracle.record(bad, r.next, r.account, r.proofA, r.proofB);
        bytes memory badNext = bytes.concat(r.next);
        badNext[40] = badNext[40] ^ 0x01;
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        oracle.record(r.header, badNext, r.account, r.proofA, r.proofB);
        // swapped storage proofs: the proof of slot b does not prove slot a
        vm.expectRevert();
        oracle.record(r.header, r.next, r.account, r.proofB, r.proofA);
        // the account proof of another pool
        bytes[] memory other = new bytes[](1);
        other[0] = _leaf(keccak256(abi.encodePacked(address(0xBEEF))), 0, hex"c0");
        vm.expectRevert();
        oracle.record(r.header, r.next, other, r.proofA, r.proofB);
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    function test_aHeaderMustMatchItsOwnNumber() public {
        // a valid, registered header presented for another height: its number field decides, so the next-block check fails
        uint256 k = K0 + 20;
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 9, 7e13, 3e18, sa, sb);
        Rec memory r2 = _build(k + 1, 9, 7e13, 3e18, sa, sb);
        _register(r.header, r.number);
        _register(r.next, (k + 1) * STEP);
        _register(r2.header, r2.number);
        _register(r2.next, (k + 2) * STEP);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(r.header, r2.next, r.account, r.proofA, r.proofB);
    }

    // ───── block-hash sources ─────

    /// A block at exactly 256 behind is read from BLOCKHASH, at 257 from the history contract (which does not hold
    /// the former, and BLOCKHASH does not hold the latter).
    function test_blockhashAt256AndHistoryAt257() public {
        uint256 k = K0 + 30;
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 4, 7e13, 3e18, sa, sb);
        uint256 nextNumber = (k + 1) * STEP;
        // the sample header is far behind: history only
        vm.store(HISTORY, keccak256(abi.encode(r.number, uint256(0))), keccak256(r.header));
        // `next` exactly 256 behind: BLOCKHASH only
        vm.roll(nextNumber + 256);
        vm.setBlockhash(nextNumber, keccak256(r.next));
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);

        uint256 k2 = K0 + 31;
        Rec memory q = _build(k2, 4, 8e13, 3e18, sa, sb);
        uint256 nextNumber2 = (k2 + 1) * STEP;
        vm.store(HISTORY, keccak256(abi.encode(q.number, uint256(0))), keccak256(q.header));
        // `next` 257 behind: history only (BLOCKHASH returns zero there)
        vm.roll(nextNumber2 + 257);
        vm.store(HISTORY, keccak256(abi.encode(nextNumber2, uint256(0))), keccak256(q.next));
        oracle.record(q.header, q.next, q.account, q.proofA, q.proofB);
        (uint256 p,) = oracle.sampleOf(k2);
        assertEq(p, 8e13);
    }

    /// A block hash that is neither in BLOCKHASH's range nor in the history is not a hash at all.
    function test_anUnregisteredHeaderIsRefused() public {
        uint256 k = K0 + 32;
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 4, 7e13, 3e18, sa, sb);
        _register(r.next, (k + 1) * STEP);
        vm.expectRevert(TacIntervalOracle.BadHeader.selector); // zero hash from the history
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    /// The block being executed has no hash yet: `next` at the current height is refused even if a history lies.
    function test_theCurrentBlockCannotBeProven() public {
        uint256 k = K0 + 33;
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 4, 7e13, 3e18, sa, sb);
        vm.roll((k + 1) * STEP); // `next` is the current block
        vm.setBlockhash(r.number, keccak256(r.header));
        vm.store(HISTORY, keccak256(abi.encode((k + 1) * STEP, uint256(0))), keccak256(r.next)); // a history that lies
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
        vm.roll((k + 1) * STEP + 1);
        vm.setBlockhash((k + 1) * STEP, keccak256(r.next));
        vm.setBlockhash(r.number, keccak256(r.header));
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    // ───── the ring ─────

    /// An interval can be recorded until the newest interval is RING ahead of it, and not after.
    function test_theRingWindowBoundary() public {
        uint256 k = K0 + 40;
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 2, 7e13, 3e18, sa, sb);
        vm.store(HISTORY, keccak256(abi.encode(r.number, uint256(0))), keccak256(r.header));
        vm.store(HISTORY, keccak256(abi.encode((k + 1) * STEP, uint256(0))), keccak256(r.next));
        // newest interval (no grace) is (block.number - 1) / STEP - 1
        uint256 firstRefused = (k + 129) * STEP + 1; // newest = k + 128
        vm.roll(firstRefused);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
        vm.roll(firstRefused - 1); // newest = k + 127
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    /// An interval one ring later takes the slot; the older one is replaced, not misread.
    function test_theRingOverwritesAndNeverMisreads() public {
        uint256 k = K0 + 50;
        _put(k, 7e13, 3e18);
        vm.roll((k + 130) * STEP);
        _put(k + 128, 9e13, 4e18);
        (uint256 p, uint256 d) = oracle.sampleOf(k);
        assertEq(p, 0, "the older interval is replaced");
        assertEq(d, 0);
        (p, d) = oracle.sampleOf(k + 128);
        assertEq(p, 9e13);
        assertEq(d, 4e18);
        // the older interval cannot be recorded over the newer one
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, k % STEP, 7e13, 3e18, sa, sb);
        _register(r.header, r.number);
        _register(r.next, (k + 1) * STEP);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    /// A recorded interval newer than the grace edge is stored but not counted until GRACE blocks after it ended.
    function test_aFreshIntervalCountsOnlyAfterTheGrace() public {
        uint256 x = K0 + 390;
        vm.roll((x + 1) * STEP + 5); // interval x is recordable, its blocks ended 5 ago: newest counted is x - 1
        for (uint256 i = 1; i <= 6; ++i) {
            _put(x - i, i <= 2 ? 9e13 : 5e13, 3e18); // x-1, x-2 high; x-3 .. x-6 low
        }
        (uint256 low, uint256 high) = oracle.prices(3_600);
        assertEq(low, 5e13);
        assertEq(high, 5e13);
        _put(x, 9e13, 3e18);
        (low, high) = oracle.prices(3_600);
        assertEq(high, 5e13, "interval x is recorded but still within the grace");
        assertEq(oracle.latest(), 9e13, "latest() has no grace");
        vm.roll((x + 1) * STEP + 10); // still within: the grace is 10 blocks after the interval's last block
        (, high) = oracle.prices(3_600);
        assertEq(high, 5e13);
        vm.roll((x + 1) * STEP + 11); // x counts: x, x-1, x-2 high and x-3, x-4, x-5 low
        (low, high) = oracle.prices(3_600);
        assertEq(low, 5e13);
        assertEq(high, 9e13);
    }

    // ───────────── the header layout guard ─────────────

    // Records interval `k` with the sample header and the next header in the shapes given; true if it was accepted.
    function _tryShapes(uint256 k, Shape memory sampleShape, Shape memory nextShape)
        internal
        returns (bool ok, bytes4 err)
    {
        (bytes32 sa, bytes32 sb) = oracle.slots();
        Rec memory r = _build(k, 9, 7e13, 3e18, sa, sb);
        bytes32 stateRoot = keccak256(r.account[0]);
        bytes memory header = _headerShaped(r.number, stateRoot, bytes32(0), sampleShape);
        bytes memory next = _headerShaped((k + 1) * STEP, bytes32(0), bytes32(uint256(9)), nextShape);
        if (block.number <= (k + 1) * STEP) vm.roll((k + 1) * STEP + 20);
        _register(header, r.number);
        _register(next, (k + 1) * STEP);
        try oracle.record(header, next, r.account, r.proofA, r.proofB) returns (uint256, uint256) {
            return (true, bytes4(0));
        } catch (bytes memory e) {
            return (false, bytes4(e));
        }
    }

    /// 15 fields (ending with the nonce) and more are accepted; 14 or fewer, and any other length of stateRoot, mixHash
    /// or nonce, are refused with BadHeader, in the sample header and in the next one.
    function test_aHeaderOutsideTheMainnetLayoutIsRefused() public {
        Shape memory today = _today();
        uint256 k = K0 + 60;
        (bool ok,) = _tryShapes(k, today, today);
        assertTrue(ok, "today's 16-field layout");
        Shape memory s15 = Shape(15, 32, 32, 8);
        (ok,) = _tryShapes(k + 1, s15, s15);
        assertTrue(ok, "15 fields is the least");
        Shape memory s20 = Shape(20, 32, 32, 8);
        (ok,) = _tryShapes(k + 2, s20, s20);
        assertTrue(ok, "more fields, as the real post-Cancun layout has");

        bytes4 bad = TacIntervalOracle.BadHeader.selector;
        bytes4 err;
        // fewer than 15 fields
        Shape memory few = Shape(14, 32, 32, 8);
        (ok, err) = _tryShapes(k + 3, few, today);
        assertFalse(ok);
        assertEq(err, bad, "14 fields in the sample header");
        (ok, err) = _tryShapes(k + 4, today, few);
        assertFalse(ok);
        assertEq(err, bad, "14 fields in the next header");
        Shape memory ten = Shape(10, 32, 32, 8);
        (ok, err) = _tryShapes(k + 5, ten, today);
        assertFalse(ok);
        assertEq(err, bad, "10 fields: no mixHash slot at all");
        // stateRoot not 32 bytes
        (ok, err) = _tryShapes(k + 6, Shape(16, 31, 32, 8), today);
        assertEq(err, bad, "31-byte stateRoot");
        (ok, err) = _tryShapes(k + 7, Shape(16, 33, 32, 8), today);
        assertEq(err, bad, "33-byte stateRoot");
        // mixHash not 32 bytes (in the next header, whose mixHash picks the sample)
        (ok, err) = _tryShapes(k + 8, today, Shape(16, 32, 31, 8));
        assertEq(err, bad, "31-byte mixHash");
        (ok, err) = _tryShapes(k + 9, today, Shape(16, 32, 33, 8));
        assertEq(err, bad, "33-byte mixHash");
        // and in the sample header too (the guard reads every header it decodes)
        (ok, err) = _tryShapes(k + 10, Shape(16, 32, 33, 8), today);
        assertEq(err, bad, "33-byte mixHash in the sample header");
        (ok, err) = _tryShapes(k + 11, Shape(16, 32, 31, 8), today);
        assertEq(err, bad, "31-byte mixHash in the sample header");
        // nonce not 8 bytes
        (ok, err) = _tryShapes(k + 12, today, Shape(16, 32, 32, 7));
        assertEq(err, bad, "7-byte nonce");
        (ok, err) = _tryShapes(k + 13, today, Shape(16, 32, 32, 9));
        assertEq(err, bad, "9-byte nonce");
        (ok, err) = _tryShapes(k + 14, Shape(16, 32, 32, 0), today);
        assertEq(err, bad, "empty nonce");
        (ok, err) = _tryShapes(k + 15, Shape(16, 32, 32, 9), today);
        assertEq(err, bad, "9-byte nonce in the sample header");
    }

    // ───────────── an empty ring slot is not a record ─────────────

    /// On a chain young enough for interval 0 to be the newest, an empty ring is not "interval 0 recorded at price 0".
    function test_anEmptyRingSlotIsNeverARecordOfIntervalZero() public {
        SynthOracle o = new SynthOracle(POOL, 50, 600, 600, 600, 1); // one interval per window
        vm.roll(61); // newest counted: (60 - 10) / 50 - 1 = 0; newest without grace: 60 / 50 - 1 = 0
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        o.prices(600);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        o.recovery(600);
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        o.depthMin(600);
        assertEq(o.latest(), 0);
        (uint256 p, uint256 d) = o.sampleOf(0);
        assertEq(p, 0);
        assertEq(d, 0);
    }

    /// Interval 0 can be recorded (an empty slot does not read as already recorded) and then counts like any other.
    function test_intervalZeroCanBeRecordedAndThenCounts() public {
        SynthOracle o = new SynthOracle(POOL, 50, 600, 600, 600, 1);
        vm.etch(HISTORY, address(new SynthHistory()).code);
        vm.roll(61);
        (bytes32 sa, bytes32 sb) = o.slots();
        Rec memory r = _build(0, 7, 7e13, 3e18, sa, sb);
        _register(r.header, r.number);
        _register(r.next, STEP);
        o.record(r.header, r.next, r.account, r.proofA, r.proofB);
        (uint256 p, uint256 d) = o.sampleOf(0);
        assertEq(p, 7e13);
        assertEq(d, 3e18);
        (uint256 low, uint256 high) = o.prices(600);
        assertEq(low, 7e13);
        assertEq(high, 7e13);
        assertEq(o.depthMin(600), 3e18);
        assertEq(o.latest(), 7e13);
        vm.expectRevert(TacIntervalOracle.AlreadyRecorded.selector);
        o.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    // ───────────── depthMin ─────────────

    function _putDepth(SynthOracle o, uint256 interval, uint256 price, uint256 depth) internal {
        vm.store(address(o), bytes32(interval % 128), bytes32(interval << 208 | price << 104 | depth));
    }

    /// The smallest depth over the window, and only when EVERY interval of the window is recorded: an interval left
    /// out cannot hide a thin one (the coverage rule of the medians does not apply). The median ignores a minority of
    /// low depths, depthMin does not, and a minority of lifted depths cannot raise it.
    function test_depthMinNeedsEveryIntervalAndFindsTheSmallest() public {
        SynthOracle o = new SynthOracle(POOL, 50, 3_600, 10_800, 21_600, 6_600); // 36 intervals at most
        uint256 head = 26_000_061;
        vm.roll(head);
        uint256 newest = (head - 1 - 10) / 50 - 1;
        for (uint256 i; i < 36; ++i) {
            // newest first: big depths everywhere, the smallest at i = 20 (an older interval), a lifted run at i < 10
            uint256 depth = i < 10 ? 9e18 : 5e18;
            if (i == 20) depth = 1e18;
            _putDepth(o, newest - i, 7e13, depth);
        }
        assertEq(o.depthMin(21_600), 1e18, "the smallest, found though it is not the newest");
        // a shorter window that does not reach the smallest
        assertEq(o.depthMin(10_800), 5e18, "18 intervals: 0..17 only");
        assertEq(o.depthMin(3_600), 9e18, "6 intervals, all of them lifted");
        // a depth lifted for part of the window cannot raise the minimum: lifting the smallest and its neighbours
        for (uint256 i = 18; i < 24; ++i) {
            _putDepth(o, newest - i, 7e13, 8e18);
        }
        assertEq(o.depthMin(21_600), 5e18);
        // one interval unrecorded (35 of 36, which the medians accept at 66% coverage): no minimum
        vm.store(address(o), bytes32((newest - 3) % 128), bytes32(0));
        (uint256 low,) = o.prices(21_600);
        assertEq(low, 7e13, "the medians still answer with 35 of 36");
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        o.depthMin(21_600);
        // the oldest interval of a shorter window missing
        vm.store(address(o), bytes32((newest - 3) % 128), bytes32((newest - 3) << 208 | uint256(7e13) << 104 | 5e18));
        assertEq(o.depthMin(21_600), 5e18);
        vm.store(address(o), bytes32((newest - 35) % 128), bytes32(0));
        vm.expectRevert(TacIntervalOracle.TooFewSamples.selector);
        o.depthMin(21_600);
        assertEq(o.depthMin(10_800), 5e18, "a window that does not reach the missing one still answers");
        vm.expectRevert(TacIntervalOracle.BadWindow.selector);
        o.depthMin(21_601);
        vm.expectRevert(TacIntervalOracle.BadWindow.selector);
        o.depthMin(599);
    }
}
