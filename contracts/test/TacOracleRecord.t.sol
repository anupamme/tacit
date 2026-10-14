// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TacIntervalOracle} from "../src/TacIntervalOracle.sol";
import {TacOracleFixtures} from "./TacOracleStub.sol";

/// `TacIntervalOracle.record` offline: the header layout check, real mainnet headers, the BLOCKHASH and EIP-2935 reads,
/// the ring edge, interval 0, the RANDAO-chosen sample block, and a reorg. Synthetic chains and real headers come from
/// test/fixtures/trie.
contract TacOracleRecordTest is TacOracleFixtures {
    address constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    // The deployed EIP-2935 contract's runtime code.
    bytes constant HISTORY_CODE =
        hex"3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";

    function _selector(bytes memory err) internal pure returns (bytes4 s) {
        if (err.length >= 4) s = bytes4(err);
    }

    // ───────────────────────── header layout ─────────────────────────

    /// Headers of the mainnet layout (21 fields, up to the reader's 32) record the values their proofs hold. Every
    /// layout that moves stateRoot (3), mixHash (13) or nonce (14) is refused with BadHeader; the shifted layouts here
    /// keep the sample header as it is, so it is the check on the following header that refuses them.
    function test_theHeaderLayoutCheckAcceptsTheMainnetLayoutOnly() public {
        uint256 total = _recCount();
        assertEq(total, 28, "fixture count");
        uint256 recorded;
        uint256 refused;
        for (uint256 i; i < total; ++i) {
            Rec memory r = _rec(i);
            bytes32 s = keccak256(bytes(r.shape));
            uint256 snap = vm.snapshotState();
            _prepare(r);
            bool ok;
            bytes4 sel;
            try oracle.record(r.header, r.next, r.account, r.proofA, r.proofB) returns (uint256, uint256) {
                ok = true;
            } catch (bytes memory err) {
                sel = _selector(err);
            }
            if (s == keccak256("full") || s == keccak256("x32")) {
                assertTrue(ok, string.concat("layout records: ", r.shape));
                (uint256 price, uint256 depth) = oracle.sampleOf(r.interval);
                assertEq(price, _u(r.aVal) % (1 << 100) + 1);
                assertEq(depth, _u(r.bVal) % (1 << 100));
                ++recorded;
            } else if (s == keccak256("x33")) {
                // 33 fields overrun the list reader's 32 slots: Panic(0x32)
                assertFalse(ok);
                assertEq(sel, bytes4(0x4e487b71), "panic selector");
            } else if (s == keccak256("mixList")) {
                // a list in place of mixHash is not bytes
                assertFalse(ok);
                assertTrue(sel != TacIntervalOracle.BadHeader.selector);
            } else {
                assertFalse(ok, string.concat("refused: ", r.shape));
                assertEq(sel, TacIntervalOracle.BadHeader.selector, string.concat("BadHeader for ", r.shape));
                ++refused;
            }
            vm.revertToState(snap);
        }
        assertEq(recorded, 11, "full x9 (six, the two-chain pair, interval 0) and x32 x2");
        assertEq(refused, 14, "min14 x2, short13 x2, insertBefore x3, nonce7, nonce9, mix31, root31, root33, rm7, at13");
    }

    /// 58 real mainnet headers (fetched with `cast block N --raw`, from the Merge to block 26,190,000: 16 fields at the
    /// Merge, 17 after Shanghai, 20 after Cancun, 21 after Prague; extraData of 0 to 31 bytes; empty and non-empty
    /// withdrawals) pass the layout and hash checks; a changed bit does not.
    function test_realMainnetHeadersPassTheLayoutCheck() public {
        string memory json = vm.readFile(string.concat(DIR, "mainnet-headers.json"));
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".headers[", vm.toString(n), "]"))) {
            string memory p = string.concat(".headers[", vm.toString(n), "].");
            uint256 number = vm.parseJsonUint(json, string.concat(p, "number"));
            uint256 fieldsN = vm.parseJsonUint(json, string.concat(p, "fields"));
            bytes memory raw = vm.parseJsonBytes(json, string.concat(p, "raw"));
            assertEq(keccak256(raw), vm.parseJsonBytes32(json, string.concat(p, "hash")), "fixture hash");
            vm.roll(number + 5);
            vm.setBlockhash(number, keccak256(raw));
            assertEq(oracle.headerFields(raw), fieldsN, "a real header refused");
            bytes memory bad = raw;
            bad[bad.length / 2] = bytes1(uint8(bad[bad.length / 2]) ^ 0x01);
            vm.expectRevert(TacIntervalOracle.BadHeader.selector);
            oracle.headerFields(bad);
            ++n;
        }
        assertEq(n, 58);
    }

    // ───────────────────────── a reorg ─────────────────────────

    /// A recorded sample is chain state and `record` reads the executing chain's own ancestors: on a chain that replaces
    /// the blocks (a different RANDAO value, hence a different sample block) the earlier proof no longer verifies, the
    /// interval is unrecorded again, and it records from the new chain's blocks.
    function test_aRecordedSampleGoesWithItsChainOnAReorg() public {
        Rec memory a = _rec(16);
        Rec memory b = _rec(17);
        assertEq(a.interval, b.interval, "same interval");
        assertTrue(a.number != b.number, "different sample block");
        assertEq(a.nextNumber, b.nextNumber, "same following block height");

        vm.roll(a.nextNumber + 1); // the first block that can record the interval
        uint256 snap = vm.snapshotState();

        vm.setBlockhash(a.number, keccak256(a.header));
        vm.setBlockhash(a.nextNumber, keccak256(a.next));
        (uint256 pa,) = oracle.record(a.header, a.next, a.account, a.proofA, a.proofB);
        (uint256 got,) = oracle.sampleOf(a.interval);
        assertEq(got, pa);
        assertTrue(pa != 0);

        vm.revertToState(snap);
        (got,) = oracle.sampleOf(a.interval);
        assertEq(got, 0, "the sample is gone with its block");

        vm.setBlockhash(a.number, keccak256("another chain's block at the first chain's sample height"));
        vm.setBlockhash(b.number, keccak256(b.header));
        vm.setBlockhash(a.nextNumber, keccak256(b.next));
        vm.expectRevert(TacIntervalOracle.BadHeader.selector);
        oracle.record(a.header, a.next, a.account, a.proofA, a.proofB);
        (uint256 pb,) = oracle.record(b.header, b.next, b.account, b.proofA, b.proofB);
        (got,) = oracle.sampleOf(b.interval);
        assertEq(got, pb);
        assertTrue(pb != pa, "the new chain's own sample");
    }

    // ───────────────────────── BLOCKHASH and EIP-2935 ─────────────────────────

    function _recordAt(Rec memory r, uint256 distance, bool withHistory, bool fillHistory)
        internal
        returns (bool ok, bytes4 sel)
    {
        vm.roll(r.number + distance);
        vm.etch(HISTORY, withHistory ? HISTORY_CODE : bytes(""));
        _place(r.number, keccak256(r.header), fillHistory);
        _place(r.nextNumber, keccak256(r.next), fillHistory);
        try oracle.record(r.header, r.next, r.account, r.proofA, r.proofB) {
            return (true, bytes4(0));
        } catch (bytes memory err) {
            return (false, bytes4(err));
        }
    }

    function _place(uint256 n, bytes32 h, bool fillHistory) internal {
        if (block.number - n <= 256) vm.setBlockhash(n, h);
        if (fillHistory) vm.store(HISTORY, bytes32(n % 8191), h);
    }

    /// A header is read through BLOCKHASH up to and including 256 blocks back and through the EIP-2935 contract from 257
    /// to 8,191 blocks back, and is refused beyond; an unwritten history slot and a missing history contract refuse it.
    /// The ring check comes after the header check, so at 8,191 blocks back the revert is BadBlock (the header passed)
    /// and at 8,192 it is BadHeader.
    function test_aHeaderIsReadFromBlockhashThenFromTheHistoryContract() public {
        uint256 snap = vm.snapshotState();
        Rec memory r = _rec(0);
        (bool ok, bytes4 sel) = _recordAt(r, 256, true, true);
        assertTrue(ok, "256 back: BLOCKHASH");
        vm.revertToState(snap);

        (ok, sel) = _recordAt(r, 257, true, true);
        assertTrue(ok, "257 back: history contract");
        vm.revertToState(snap);

        (ok, sel) = _recordAt(r, 6000, true, true);
        assertTrue(ok, "6000 back: history contract");
        vm.revertToState(snap);

        (ok, sel) = _recordAt(r, 8191, true, true);
        assertFalse(ok);
        assertEq(sel, TacIntervalOracle.BadBlock.selector, "8191 back: the interval is too old for the ring");
        vm.revertToState(snap);

        (ok, sel) = _recordAt(r, 8192, true, true);
        assertFalse(ok);
        assertEq(sel, TacIntervalOracle.BadHeader.selector, "8192 back: outside the history window");
        vm.revertToState(snap);

        (ok, sel) = _recordAt(r, 600, true, false);
        assertFalse(ok);
        assertEq(sel, TacIntervalOracle.BadHeader.selector, "unwritten slot");
        vm.revertToState(snap);

        (ok, sel) = _recordAt(r, 600, false, false);
        assertFalse(ok);
        assertEq(sel, TacIntervalOracle.BadHeader.selector, "no history contract");
    }

    /// The oldest interval that records is 127 behind the newest; one more interval and it reverts BadBlock.
    function test_theOldestRecordableIntervalIs127BehindTheNewest() public {
        Rec memory r = _rec(0);
        vm.etch(HISTORY, HISTORY_CODE);
        uint256 bn = (r.interval + 128) * 50 + 1; // the newest interval is interval + 127
        vm.roll(bn);
        vm.store(HISTORY, bytes32(r.number % 8191), keccak256(r.header));
        vm.store(HISTORY, bytes32(r.nextNumber % 8191), keccak256(r.next));
        uint256 snap = vm.snapshotState();
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
        vm.revertToState(snap);
        vm.roll(bn + 50);
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    /// A record costs less than 1.5M gas on the fixtures' proofs (about 770k on mainnet's proofs).
    function test_aRecordStaysUnderTheGasBound() public {
        Rec memory r = _rec(0);
        _prepare(r);
        uint256 g = gasleft();
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
        assertLt(g - gasleft(), 1_500_000);
    }

    // ───────────────────────── intervals and the sample block ─────────────────────────

    /// Interval 0 records once; a second record reverts AlreadyRecorded.
    function test_interval0RecordsOnce() public {
        Rec memory r = _rec(27);
        assertEq(r.interval, 0);
        _prepare(r);
        (uint256 price,) = oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
        (uint256 got,) = oracle.sampleOf(0);
        assertEq(got, price);
        vm.expectRevert(TacIntervalOracle.AlreadyRecorded.selector);
        oracle.record(r.header, r.next, r.account, r.proofA, r.proofB);
    }

    /// The sample block is the one the following block's RANDAO value picks: the right interval and sample header with
    /// another chain's following header (a different mixHash) is refused, and `sampleBlock` stays inside its interval.
    function test_theFollowingBlocksRandaoPicksTheSampleBlock() public {
        Rec memory a = _rec(16);
        Rec memory b = _rec(17);
        vm.roll(a.nextNumber + 3);
        vm.setBlockhash(a.number, keccak256(a.header));
        vm.setBlockhash(a.nextNumber, keccak256(b.next));
        vm.expectRevert(TacIntervalOracle.BadBlock.selector);
        oracle.record(a.header, b.next, a.account, a.proofA, a.proofB);
        for (uint256 i; i < 200; ++i) {
            uint256 k = 520_000 + i;
            uint256 sb = oracle.sampleBlock(k, keccak256(abi.encode(i)));
            assertGe(sb, k * 50);
            assertLt(sb, (k + 1) * 50);
        }
    }
}
