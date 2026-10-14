// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TacSystemBase} from "./TacSystem.t.sol";

/// `bid` and `onOffer` read the offer price inside `try this.offerPrice() ... catch {}`, and `onOffer` answers with the
/// whole collateral when it fails (only the owner may then bid; an outsider reverts NoPrice). A callee given too little
/// gas fails while the caller keeps 1/64 of it (EIP-150). This sweeps the gas limit of an outsider's `bid` across
/// every range, with the pair oracle (36 recorded intervals per venue) and cold accounts, and checks that no gas limit
/// lets a bid through at the unpriced fallback.
contract TacSystemGasTest is TacSystemBase {
    function _auction() internal returns (uint256 debt, uint256 expected) {
        _aliceAndCarol();
        _market(P0 * 36 / 100);
        vault.liquidate(alice);
        skip(2_700); // past the owner window
        (, debt,) = _v(alice);
        expected = vault.onOffer(alice); // with all the gas there is
    }

    function _cool() internal {
        address[9] memory a = [
            address(vault),
            address(pair),
            address(precision),
            address(amm),
            address(synth),
            address(tac),
            address(feed),
            address(prec),
            address(v1)
        ];
        for (uint256 i; i < 9; ++i) {
            vm.cool(a[i]);
        }
    }

    function test_noGasLimitLetsAnOutsiderBidTakeTheUnpricedFallback() public {
        (uint256 debt, uint256 expected) = _auction();
        (uint256 collateral,,) = _v(alice);
        assertLt(expected, collateral, "the offer is below the collateral");

        // the offer price costs under 400k gas cold and the whole bid fits in 600k
        _cool();
        uint256 g = gasleft();
        vault.offerPrice();
        assertLt(g - gasleft(), 400_000);

        uint256 ok;
        uint256 minOk = type(uint256).max;
        for (uint256 limit = 100_000; limit <= 36_000_000; limit += limit < 1_000_000 ? 5_000 : 250_000) {
            uint256 snap = vm.snapshotState();
            _cool();
            vm.prank(carol);
            try vault.bid{gas: limit}(alice, debt, 0) returns (uint256 taken) {
                ++ok;
                if (limit < minOk) minOk = limit;
                assertEq(taken, expected, "a starved offer price never lets a bid through at the fallback");
            } catch {}
            vm.revertToState(snap);
        }
        assertGt(ok, 0);
        assertLt(minOk, 600_000);
    }

    /// The same sweep for the owner's own bid: the unpriced fallback is proportional, never more than the owner's own
    /// share of the collateral.
    function test_anOwnerBidAtAnyGasTakesOnlyItsOwnShare() public {
        (uint256 debt,) = _auction();
        (uint256 collateral,,) = _v(alice);
        // alice needs SYNTH: carol sends it
        vm.prank(carol);
        synth.transfer(alice, 6_060e18);
        uint256 bestTake;
        for (uint256 limit = 100_000; limit <= 4_000_000; limit += 20_000) {
            uint256 snap = vm.snapshotState();
            _cool();
            vm.prank(alice);
            try vault.bid{gas: limit}(alice, debt, 0) returns (uint256 taken) {
                if (taken > bestTake) bestTake = taken;
            } catch {}
            vm.revertToState(snap);
        }
        // whatever alice receives is her own collateral: she repaid her whole debt
        assertLe(bestTake, collateral);
    }
}
