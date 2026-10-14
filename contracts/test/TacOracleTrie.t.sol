// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TacOracleFixtures} from "./TacOracleStub.sol";

/// The vendored Merkle-Patricia verifier and `record`'s proof handling, offline, against tries built by an independent
/// builder (test/fixtures/trie; the builder reproduces the well-known "doe/dog/dogglesworth" root).
///
/// The mutation loops are fixed-size (12 per proof, 60 per record case); raise the loop bounds for a longer run.
contract TacOracleTrieTest is TacOracleFixtures {
    /// Every honest proof returns exactly the stored value (embedded short nodes, extension nodes, branch values and
    /// single bytes below 0x80 included), every absent key reverts, and every structural change of a proof, longer or
    /// shorter key, or neighbouring key reverts.
    function test_everyHonestProofReturnsItsValueAndNothingElseVerifies() public view {
        uint256[6] memory t;
        for (uint256 c; c < 80; ++c) {
            uint256[6] memory r = this.checkTrie(c);
            for (uint256 j; j < 6; ++j) {
                t[j] += r[j];
            }
        }
        // present, refused or wrong honest proofs, absent keys, absent keys accepted, mutations tried, accepted
        assertEq(t[0], 599, "present keys");
        assertEq(t[1], 0, "honest proofs refused or wrong");
        assertEq(t[2], 239, "absent keys");
        assertEq(t[3], 0, "absent keys accepted");
        assertGt(t[4], 8000, "mutations tried");
        assertEq(t[5], 0, "mutations accepted");
    }

    function checkTrie(uint256 c) external view returns (uint256[6] memory out) {
        uint256 present;
        uint256 absent;
        uint256 honestFail;
        uint256 absentAccepted;
        uint256 mutAccepted;
        uint256 mutTried;
        string memory json = vm.readFile(string.concat(DIR, "trie-", vm.toString(c), ".json"));
        for (uint256 i; i < 40; ++i) {
            string memory p = string.concat(".cases[", vm.toString(i), "].");
            if (!vm.keyExistsJson(json, string.concat(".cases[", vm.toString(i), "]"))) break;
            bytes memory key = vm.parseJsonBytes(json, string.concat(p, "key"));
            bytes32 root = vm.parseJsonBytes32(json, string.concat(p, "root"));
            bytes[] memory proof = vm.parseJsonBytesArray(json, string.concat(p, "proof"));
            if (vm.parseJsonBool(json, string.concat(p, "present"))) {
                bytes memory value = vm.parseJsonBytes(json, string.concat(p, "value"));
                ++present;
                try trie.get(key, proof, root) returns (bytes memory got) {
                    if (keccak256(got) != keccak256(value)) ++honestFail;
                } catch {
                    ++honestFail;
                }
                for (uint256 m; m < 12; ++m) {
                    uint256 seed = uint256(keccak256(abi.encode(c, i, m)));
                    bytes[] memory mp = _mutate(proof, seed % 7, seed >> 8);
                    if (keccak256(abi.encode(mp)) == keccak256(abi.encode(proof))) continue; // a one-node proof
                    ++mutTried;
                    try trie.get(key, mp, root) returns (bytes memory) {
                        ++mutAccepted;
                    } catch {}
                }
                // keys of another length or value with the honest proof
                bytes memory longer = abi.encodePacked(key, bytes1(0));
                bytes memory shorter = new bytes(key.length - 1);
                for (uint256 j; j + 1 < key.length; ++j) {
                    shorter[j] = key[j];
                }
                ++mutTried;
                try trie.get(longer, proof, root) returns (bytes memory) {
                    ++mutAccepted;
                } catch {}
                if (shorter.length > 0) {
                    ++mutTried;
                    try trie.get(shorter, proof, root) returns (bytes memory) {
                        ++mutAccepted;
                    } catch {}
                }
                bytes memory other = abi.encodePacked(key);
                other[other.length - 1] = bytes1(uint8(other[other.length - 1]) ^ 0x01);
                ++mutTried;
                try trie.get(other, proof, root) returns (bytes memory) {
                    ++mutAccepted;
                } catch {}
            } else {
                ++absent;
                try trie.get(key, proof, root) returns (bytes memory) {
                    ++absentAccepted;
                } catch {}
            }
        }
        out = [present, honestFail, absent, absentAccepted, mutTried, mutAccepted];
    }

    /// `record` refuses a changed header, a changed following header, any structural change of the account or slot
    /// proofs, swapped or reused slot proofs, a proof that a slot is absent, another account's proof, and empty
    /// proofs; the honest inputs record.
    function test_aRecordWithAChangedHeaderOrProofReverts() public {
        uint256 accepted;
        for (uint256 i; i < 6; ++i) {
            Rec memory r = _rec(i);
            uint256 snap = vm.snapshotState();
            _prepare(r);
            for (uint256 m; m < 60; ++m) {
                uint256 seed = uint256(keccak256(abi.encode(i, m)));
                uint256 kind = seed % 7;
                uint256 which = (seed >> 8) % 5;
                bool ok;
                if (which == 0) {
                    ok = _tryRecord(
                        _flip(abi.encodePacked(r.header), seed >> 20), r.next, r.account, r.proofA, r.proofB
                    );
                } else if (which == 1) {
                    ok = _tryRecord(
                        r.header, _flip(abi.encodePacked(r.next), seed >> 20), r.account, r.proofA, r.proofB
                    );
                } else if (which == 2) {
                    ok = _tryRecord(r.header, r.next, _mutate(r.account, kind, seed >> 20), r.proofA, r.proofB);
                } else if (which == 3) {
                    ok = _tryRecord(r.header, r.next, r.account, _mutate(r.proofA, kind, seed >> 20), r.proofB);
                } else {
                    ok = _tryRecord(r.header, r.next, r.account, r.proofA, _mutate(r.proofB, kind, seed >> 20));
                }
                if (ok) ++accepted;
            }
            assertEq(accepted, 0, "a changed input recorded");
            bytes[] memory empty = new bytes[](0);
            assertFalse(_tryRecord(r.header, r.next, r.account, r.proofB, r.proofA), "swapped slot proofs");
            assertFalse(_tryRecord(r.header, r.next, r.account, r.proofA, r.proofA), "one proof for both slots");
            assertFalse(_tryRecord(r.header, r.next, r.account, r.absentProof, r.proofB), "absent proof for slot A");
            assertFalse(_tryRecord(r.header, r.next, r.account, r.proofA, r.absentProof), "absent proof for slot B");
            assertFalse(_tryRecord(r.header, r.next, r.otherAccountProof, r.proofA, r.proofB), "another account");
            assertFalse(_tryRecord(r.header, r.next, empty, r.proofA, r.proofB), "empty account proof");
            assertFalse(_tryRecord(r.header, r.next, r.account, empty, r.proofB), "empty slot proof");
            assertTrue(_tryRecord(r.header, r.next, r.account, r.proofA, r.proofB), "the honest inputs record");
            vm.revertToState(snap);
        }
    }
}
