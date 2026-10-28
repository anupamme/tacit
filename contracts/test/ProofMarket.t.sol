// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {ProofMarket} from "../src/ProofMarket.sol";

/// A TAC stand-in with ERC-2612 permit (solady's ERC20 carries it).
contract MockTac is ERC20 {
    function name() public pure override returns (string memory) {
        return "TAC";
    }

    function symbol() public pure override returns (string memory) {
        return "TAC";
    }

    function mint(address to, uint256 n) external {
        _mint(to, n);
    }
}

/// Stands in for ConfidentialPool.settle: records the call, can refuse, can pay msg.sender a native-ETH fee leg.
contract MockPool {
    bytes32 public lastPv;
    uint256 public calls;
    bool public refuse;
    uint256 public payToCaller;

    function setRefuse(bool v) external {
        refuse = v;
    }

    function setPay(uint256 n) external {
        payToCaller = n;
    }

    function settle(bytes calldata pv, bytes calldata, bytes[] calldata) external {
        if (refuse) revert("pool refused");
        lastPv = keccak256(pv);
        calls++;
        if (payToCaller != 0) {
            (bool ok,) = msg.sender.call{value: payToCaller}("");
            require(ok);
        }
    }

    receive() external payable {}
}

contract ProofMarketTest is Test {
    MockTac tac;
    MockPool pool;
    ProofMarket mkt;

    uint256 payerKey = 0xA11CE;
    address payer;
    address solverA = address(0xA0);
    address solverB = address(0xB0);

    bytes pv = hex"c0ffee";
    bytes proof = hex"beef";
    bytes[] memos;

    function setUp() public {
        payer = vm.addr(payerKey);
        tac = new MockTac();
        pool = new MockPool();
        vm.deal(address(pool), 5 ether);
        mkt = new ProofMarket(address(pool), address(tac), 60);
        tac.mint(payer, 1000e18);
        vm.warp(1_000_000);
    }

    function _intent(uint256 floor_, uint256 max_, uint64 ramp) internal view returns (ProofMarket.Intent memory i) {
        i = ProofMarket.Intent(payer, keccak256(pv), floor_, max_, uint64(block.timestamp), ramp, uint64(block.timestamp + 1 hours));
    }

    function _sig(ProofMarket.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, mkt.intentHash(i));
        return abi.encodePacked(r, s, v);
    }

    function _permit(ProofMarket.Intent memory i) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                payer,
                address(mkt),
                i.maxFee,
                tac.nonces(payer),
                i.deadline
            )
        );
        (v, r, s) = vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", tac.DOMAIN_SEPARATOR(), structHash)));
    }

    function _fulfill(address who, ProofMarket.Intent memory i) internal {
        (uint8 v, bytes32 r, bytes32 s) = _permit(i);
        bytes memory sig = _sig(i); // read before the prank: a call in between would use it up
        vm.prank(who);
        mkt.fulfill(i, sig, pv, proof, memos, v, r, s);
    }

    function test_fulfillSettlesAndPaysTheProverInOneTx() public {
        ProofMarket.Intent memory i = _intent(2e18, 10e18, 0);
        _fulfill(solverA, i);
        assertEq(pool.calls(), 1);
        assertEq(pool.lastPv(), keccak256(pv));
        assertEq(tac.balanceOf(solverA), 10e18, "ramp 0 = max price");
        assertEq(tac.balanceOf(payer), 990e18);
        assertTrue(mkt.done(i.opId));
    }

    function test_priceRisesFromFloorToMax() public {
        ProofMarket.Intent memory i = _intent(2e18, 10e18, 100);
        assertEq(mkt.priceAt(i, block.timestamp), 2e18);
        assertEq(mkt.priceAt(i, block.timestamp + 50), 6e18);
        assertEq(mkt.priceAt(i, block.timestamp + 100), 10e18);
        assertEq(mkt.priceAt(i, block.timestamp + 5000), 10e18);
        vm.warp(block.timestamp + 25);
        _fulfill(solverA, i);
        assertEq(tac.balanceOf(solverA), 4e18, "paid the price at that moment");
    }

    function test_poolRefusingRevertsAndMovesNoTac() public {
        ProofMarket.Intent memory i = _intent(2e18, 10e18, 0);
        pool.setRefuse(true);
        (uint8 v, bytes32 r, bytes32 s) = _permit(i);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        vm.expectRevert("pool refused");
        mkt.fulfill(i, sig, pv, proof, memos, v, r, s);
        assertEq(tac.balanceOf(payer), 1000e18);
        assertEq(tac.balanceOf(solverA), 0);
        assertFalse(mkt.done(i.opId));
        assertEq(tac.allowance(payer, address(mkt)), 0, "the permit was rolled back with the rest");
    }

    function test_proofForAnotherOpIsRefused() public {
        ProofMarket.Intent memory i = _intent(2e18, 10e18, 0);
        (uint8 v, bytes32 r, bytes32 s) = _permit(i);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.WrongOp.selector);
        mkt.fulfill(i, sig, hex"deadbeef", proof, memos, v, r, s);
    }

    function test_aClaimExcludesEveryoneElseForItsWindow() public {
        ProofMarket.Intent memory i = _intent(2e18, 10e18, 0);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        mkt.claim(i, sig);
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.Claimed.selector);
        mkt.claim(i, sig);
        (uint8 v, bytes32 r, bytes32 s) = _permit(i);
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.Claimed.selector);
        mkt.fulfill(i, sig, pv, proof, memos, v, r, s); // a copied proof cannot take the fee
        _fulfill(solverA, i);
        assertEq(tac.balanceOf(solverA), 10e18);
        assertEq(tac.balanceOf(solverB), 0);
    }

    function test_theClaimedPriceHoldsEvenAsThePriceRises() public {
        ProofMarket.Intent memory i = _intent(2e18, 10e18, 100);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        mkt.claim(i, sig); // at the floor, 2
        vm.warp(block.timestamp + 50);
        _fulfill(solverA, i);
        assertEq(tac.balanceOf(solverA), 2e18, "the claim fixed the price");
    }

    function test_anExpiredClaimOpensTheOpToAnyone() public {
        ProofMarket.Intent memory i = _intent(2e18, 10e18, 100);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        mkt.claim(i, sig);
        vm.warp(block.timestamp + 61);
        _fulfill(solverB, i);
        assertEq(tac.balanceOf(solverB), 2e18 + (8e18 * 61) / 100);
    }

    function test_doubleFulfilIsRefused() public {
        ProofMarket.Intent memory i = _intent(2e18, 10e18, 0);
        _fulfill(solverA, i);
        (uint8 v, bytes32 r, bytes32 s) = _permit(i);
        bytes memory sig = _sig(i);
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.AlreadyDone.selector);
        mkt.fulfill(i, sig, pv, proof, memos, v, r, s);
    }

    function test_cancelAndExpiryAndBadSignature() public {
        ProofMarket.Intent memory i = _intent(2e18, 10e18, 0);
        bytes memory sig = _sig(i);
        vm.prank(payer);
        mkt.cancel(i.opId);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.Cancelled.selector);
        mkt.claim(i, sig);

        ProofMarket.Intent memory j = _intent(2e18, 10e18, 0);
        j.opId = keccak256("other");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, mkt.intentHash(j));
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadSignature.selector);
        mkt.claim(j, abi.encodePacked(r, s, v));

        ProofMarket.Intent memory k = _intent(2e18, 10e18, 0);
        k.opId = keccak256("late");
        bytes memory ks = _sig(k);
        vm.warp(k.deadline + 1);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.Expired.selector);
        mkt.claim(k, ks);
    }

    function test_theSignedMaxIsTheMostEverPulled() public {
        // an intent altered after signing (a higher max) fails its signature
        ProofMarket.Intent memory i = _intent(2e18, 10e18, 0);
        bytes memory sig = _sig(i);
        i.maxFee = 900e18;
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadSignature.selector);
        mkt.claim(i, sig);
    }

    function test_aNativeEthFeeLegGoesToTheProver() public {
        ProofMarket.Intent memory i = _intent(0, 1e18, 0);
        pool.setPay(0.01 ether);
        _fulfill(solverA, i);
        assertEq(solverA.balance, 0.01 ether);
        assertEq(address(mkt).balance, 0);
    }

    function test_worksWithAnAllowanceAndABadPermit() public {
        ProofMarket.Intent memory i = _intent(1e18, 1e18, 0);
        vm.prank(payer);
        tac.approve(address(mkt), 5e18);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        mkt.fulfill(i, sig, pv, proof, memos, 27, bytes32(0), bytes32(0)); // permit fails, allowance stands
        assertEq(tac.balanceOf(solverA), 1e18);
    }

    function test_withoutAnyAllowanceTheWholeCallReverts() public {
        ProofMarket.Intent memory i = _intent(1e18, 1e18, 0);
        bytes memory sig = _sig(i);
        vm.prank(solverA);
        vm.expectRevert();
        mkt.fulfill(i, sig, pv, proof, memos, 27, bytes32(0), bytes32(0));
        assertEq(pool.calls(), 0, "the settle was rolled back with the failed pull");
    }

    function test_constructorChecks() public {
        vm.expectRevert(ProofMarket.BadConfig.selector);
        new ProofMarket(address(0xD00D), address(tac), 60);
        vm.expectRevert(ProofMarket.BadConfig.selector);
        new ProofMarket(address(pool), address(tac), 0);
    }

    // ── the proof tank: one signed package, many ops, never past the cap ──
    uint256 delegateKey = 0xDE1E6A7E;

    function _tank(uint256 cap, uint256 perOp) internal view returns (ProofMarket.Tank memory) {
        return ProofMarket.Tank(payer, vm.addr(delegateKey), cap, perOp, uint64(block.timestamp + 1 days), 1);
    }

    function _tankSig(ProofMarket.Tank memory t) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, mkt.tankHash(t));
        return abi.encodePacked(r, s, v);
    }

    function _delSig(ProofMarket.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(delegateKey, mkt.intentHash(i));
        return abi.encodePacked(r, s, v);
    }

    function _tankPermit(ProofMarket.Tank memory t) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                payer, address(mkt), t.cap, tac.nonces(payer), uint256(t.expiry)
            )
        );
        (v, r, s) = vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", tac.DOMAIN_SEPARATOR(), sh)));
    }

    function _opIntent(bytes memory pv_, uint256 floor_, uint256 max_) internal view returns (ProofMarket.Intent memory i) {
        i = ProofMarket.Intent(payer, keccak256(pv_), floor_, max_, uint64(block.timestamp), 0, uint64(block.timestamp + 1 hours));
    }

    function _tankFulfill(address who, ProofMarket.Tank memory t, bytes memory pv_, uint256 max_) internal {
        ProofMarket.Intent memory i = _opIntent(pv_, 0, max_);
        (uint8 v, bytes32 r, bytes32 s) = _tankPermit(t);
        bytes memory ts = _tankSig(t);
        bytes memory is_ = _delSig(i);
        vm.prank(who);
        mkt.fulfillFromTank(t, ts, i, is_, pv_, proof, memos, v, r, s);
    }

    function test_tankOnePermitFundsManyOps() public {
        ProofMarket.Tank memory t = _tank(1000e18, 50e18);
        _tankFulfill(solverA, t, hex"01", 5e18);
        assertEq(tac.balanceOf(solverA), 5e18);
        assertEq(tac.allowance(payer, address(mkt)), 995e18, "the permit set the allowance; the pull used some");
        _tankFulfill(solverB, t, hex"02", 7e18); // the permit is spent now: this op rides the allowance
        assertEq(tac.balanceOf(solverB), 7e18);
        assertEq(mkt.spent(mkt.tankHash(t)), 12e18);
        assertEq(tac.balanceOf(payer), 988e18);
        assertEq(pool.calls(), 2);
    }

    function test_tankNeverPaysPastItsCap() public {
        ProofMarket.Tank memory t = _tank(10e18, 6e18);
        _tankFulfill(solverA, t, hex"01", 6e18);
        ProofMarket.Intent memory i = _opIntent(hex"02", 0, 6e18);
        (uint8 v, bytes32 r, bytes32 s) = _tankPermit(t);
        bytes memory ts = _tankSig(t);
        bytes memory is_ = _delSig(i);
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.TankSpent.selector); // 6 + 6 > 10
        mkt.fulfillFromTank(t, ts, i, is_, hex"02", proof, memos, v, r, s);
        assertEq(tac.balanceOf(solverB), 0);
        _tankFulfill(solverB, t, hex"03", 4e18); // 6 + 4 = 10: exactly the cap
        assertEq(mkt.spent(mkt.tankHash(t)), 10e18);
        ProofMarket.Intent memory more = _opIntent(hex"04", 0, 1e18); // the cap is reached: even 1 more is refused, whatever the allowance
        (v, r, s) = _tankPermit(t);
        ts = _tankSig(t);
        bytes memory ms = _delSig(more);
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.TankSpent.selector);
        mkt.fulfillFromTank(t, ts, more, ms, hex"04", proof, memos, v, r, s);
    }

    function test_tankPerOpMaxAndSigners() public {
        ProofMarket.Tank memory t = _tank(100e18, 5e18);
        ProofMarket.Intent memory big = _opIntent(hex"01", 0, 6e18);
        bytes memory ts = _tankSig(t);
        bytes memory bs = _delSig(big);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadPrice.selector); // above perOpMax
        mkt.claimFromTank(t, ts, big, bs);

        ProofMarket.Intent memory ok_ = _opIntent(hex"02", 0, 5e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, mkt.intentHash(ok_)); // the payer, not the delegate, signs the op
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadSignature.selector);
        mkt.claimFromTank(t, ts, ok_, abi.encodePacked(r, s, v));

        (v, r, s) = vm.sign(delegateKey, mkt.tankHash(t)); // a tank signed by anyone but the payer
        bytes memory okSig = _delSig(ok_);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.BadSignature.selector);
        mkt.claimFromTank(t, abi.encodePacked(r, s, v), ok_, okSig);
    }

    function test_tankRevokeAndExpiry() public {
        ProofMarket.Tank memory t = _tank(100e18, 50e18);
        ProofMarket.Intent memory i = _opIntent(hex"01", 0, 5e18);
        bytes memory ts = _tankSig(t);
        bytes memory is_ = _delSig(i);
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.NotPayer.selector);
        mkt.revokeTank(t);
        vm.prank(payer);
        mkt.revokeTank(t);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.TankRevoked.selector);
        mkt.claimFromTank(t, ts, i, is_);

        ProofMarket.Tank memory u = _tank(100e18, 50e18);
        u.salt = 2;
        bytes memory us = _tankSig(u);
        vm.warp(block.timestamp + 2 days);
        ProofMarket.Intent memory j = _opIntent(hex"02", 0, 5e18);
        j.deadline = uint64(block.timestamp + 1 hours);
        bytes memory js = _delSig(j);
        vm.prank(solverA);
        vm.expectRevert(ProofMarket.Expired.selector);
        mkt.claimFromTank(u, us, j, js);
    }

    function test_tankClaimExcludesOthers() public {
        ProofMarket.Tank memory t = _tank(100e18, 50e18);
        ProofMarket.Intent memory i = _opIntent(hex"01", 1e18, 5e18);
        bytes memory ts = _tankSig(t);
        bytes memory is_ = _delSig(i);
        vm.prank(solverA);
        mkt.claimFromTank(t, ts, i, is_);
        (uint8 v, bytes32 r, bytes32 s) = _tankPermit(t);
        vm.prank(solverB);
        vm.expectRevert(ProofMarket.Claimed.selector);
        mkt.fulfillFromTank(t, ts, i, is_, hex"01", proof, memos, v, r, s);
    }
}
