// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacVaultRouter} from "../src/TacVaultRouter.sol";
import {TestTac, MockPair, MockVenue, MockFeed, MockEvilPair, MockBombVenue, VaultConfig} from "./TacVaultMocks.sol";

/// The router with two real vaults over an oracle that prices only once its venues have been recorded (MockPair, whose venues take
/// a record on a header alone). What it moves, for whom, and what it keeps.
contract TacVaultRouterTest is Test {
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 2_000e18;
    bytes4 constant RECORD = 0x3113428b;

    TestTac tac;
    MockPair pair;
    MockFeed feed;
    TacVault v1;
    TacVault v2;
    TacVaultRouter router;
    uint256 aliceKey = 0xA11CE;
    address alice;
    address bob = address(0xB0B);
    address stranger = address(0xBAD);

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = vm.addr(aliceKey);
        tac = new TestTac();
        pair = new MockPair();
        pair.set(1e14); // 0.40 USD per TAC at 4,000 USD per ETH
        feed = new MockFeed();
        feed.set(4000e8);
        v1 = new TacVault(VaultConfig.defaults(address(tac), address(pair), address(feed), address(0x0123)));
        v2 = new TacVault(VaultConfig.defaults(address(tac), address(pair), address(feed), address(0x0123)));
        router = new TacVaultRouter(address(v1), address(v2));
        tac.mint(alice, 1_000_000e18);
        tac.mint(bob, 1_000_000e18);
    }

    // ───────────── helpers ─────────────

    /// A header as the venue mock reads it: an RLP list of fifteen items of which the ninth is the block number.
    function _header(uint256 number) internal pure returns (bytes memory) {
        bytes memory n = number < 256 ? abi.encodePacked(uint8(number)) : abi.encodePacked(uint24(number));
        bytes memory item = (n.length == 1 && uint8(n[0]) < 0x80) ? n : abi.encodePacked(uint8(0x80 + n.length), n);
        bytes memory body = abi.encodePacked(hex"8080808080808080", item, hex"80808080808080");
        return abi.encodePacked(uint8(0xc0 + body.length), body);
    }

    function _recordData(uint256 k) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            RECORD, bytes(""), _header((k + 1) * 50), new bytes[](0), new bytes[](0), new bytes[](0)
        );
    }

    /// one `records` call for a record of interval k on each venue given
    function _rec(TacVault v, address[] memory venues, uint256 k) internal view returns (bytes memory) {
        bytes[] memory data = new bytes[](venues.length);
        for (uint256 i; i < venues.length; ++i) {
            data[i] = _recordData(k);
        }
        return abi.encodeCall(TacVaultRouter.records, (address(v), venues, data));
    }

    function _both() internal view returns (address[] memory venues) {
        venues = new address[](2);
        venues[0] = address(pair.A());
        venues[1] = address(pair.B());
    }

    function _one(address venue) internal pure returns (address[] memory venues) {
        venues = new address[](1);
        venues[0] = venue;
    }

    function _borrowSig(TacVault v, uint256 key, address who, uint256 amount, address to, uint256 minColl, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(v.BORROW(), who, amount, uint256(0), minColl, to, v.nonces(who), dl));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, v.digest(sh));
        return abi.encodePacked(r, s, vv);
    }

    function _withdrawSig(TacVault v, uint256 key, address who, uint256 amount, address to, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(v.WITHDRAW(), who, amount, to, v.nonces(who), dl));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, v.digest(sh));
        return abi.encodePacked(r, s, vv);
    }

    function _permitSig(uint256 key, address who, address spender, uint256 value, uint256 dl)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        return _permitSigOf(address(tac), key, who, spender, value, dl);
    }

    function _permitSigOf(address token, uint256 key, address who, address spender, uint256 value, uint256 dl)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                who,
                spender,
                value,
                ERC20(token).nonces(who),
                dl
            )
        );
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", ERC20(token).DOMAIN_SEPARATOR(), sh)));
    }

    function _vaultOf(TacVault v, address who) internal view returns (uint256 c, uint256 d) {
        (c, d,) = v.vaults(who);
    }

    /// records on both venues, the permit, and the borrow, as the page sends them
    function _calls(uint256 coll, uint256 amount, uint256 dl) internal view returns (bytes[] memory calls) {
        (uint8 pv, bytes32 pr, bytes32 ps) = _permitSig(aliceKey, alice, address(router), coll, dl);
        calls = new bytes[](3);
        calls[0] = _rec(v1, _both(), 10);
        calls[1] = abi.encodeCall(TacVaultRouter.permitTac, (coll, dl, pv, pr, ps));
        calls[2] = abi.encodeCall(
            TacVaultRouter.borrow,
            (address(v1), coll, amount, 0, coll, dl, _borrowSig(v1, aliceKey, alice, amount, alice, coll, dl))
        );
    }

    function _assertEmpty() internal view {
        assertEq(tac.balanceOf(address(router)), 0, "router holds TAC");
        assertEq(v1.SYNTH().balanceOf(address(router)), 0, "router holds synth");
        assertEq(v2.SYNTH().balanceOf(address(router)), 0, "router holds synth 2");
        assertEq(tac.allowance(address(router), address(v1)), 0, "router left an approval");
        assertEq(tac.allowance(address(router), address(v2)), 0, "router left an approval 2");
        assertEq(address(router).balance, 0, "router holds ETH");
    }

    // ───────────── the one transaction ─────────────

    function test_recordsDepositAndBorrowInOneTransaction() public {
        pair.arm(2); // the vault cannot price until both venues have a record
        uint256 dl = block.timestamp + 1 hours;
        vm.expectRevert(); // alone, the borrow has no price
        vm.prank(alice);
        v1.borrow(DEBT, 0);

        bytes[] memory calls = _calls(COLL, DEBT, dl);
        vm.prank(alice);
        router.multicall(calls);

        assertFalse(pair.broken(), "both records landed");
        (uint256 c, uint256 d) = _vaultOf(v1, alice);
        assertEq(c, COLL);
        assertEq(d, DEBT);
        assertEq(v1.SYNTH().balanceOf(alice), DEBT);
        assertEq(tac.balanceOf(alice), 1_000_000e18 - COLL);
        assertEq(tac.allowance(alice, address(router)), 0, "the permit was used up");
        _assertEmpty();
    }

    function test_borrowOnCollateralAlreadyInTheVault() public {
        vm.startPrank(alice);
        tac.approve(address(v1), COLL);
        v1.deposit(COLL);
        vm.stopPrank();
        pair.arm(1);
        uint256 dl = block.timestamp + 1 hours;
        bytes[] memory calls = new bytes[](2);
        calls[0] = _rec(v1, _one(address(pair.A())), 10);
        calls[1] = abi.encodeCall(
            TacVaultRouter.borrow, (address(v1), 0, DEBT, 0, COLL, dl, _borrowSig(v1, aliceKey, alice, DEBT, alice, COLL, dl))
        );
        vm.prank(alice);
        router.multicall(calls);
        (, uint256 d) = _vaultOf(v1, alice);
        assertEq(d, DEBT);
        assertEq(tac.balanceOf(alice), 1_000_000e18 - COLL);
        _assertEmpty();
    }

    function test_theSecondVaultWorksToo() public {
        uint256 dl = block.timestamp + 1 hours;
        (uint8 pv, bytes32 pr, bytes32 ps) = _permitSig(aliceKey, alice, address(router), COLL, dl);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(TacVaultRouter.permitTac, (COLL, dl, pv, pr, ps));
        calls[1] = abi.encodeCall(
            TacVaultRouter.borrow, (address(v2), COLL, DEBT, 0, COLL, dl, _borrowSig(v2, aliceKey, alice, DEBT, alice, COLL, dl))
        );
        vm.prank(alice);
        router.multicall(calls);
        (uint256 c, uint256 d) = _vaultOf(v2, alice);
        assertEq(c, COLL);
        assertEq(d, DEBT);
        (c, d) = _vaultOf(v1, alice);
        assertEq(c + d, 0, "the other vault is untouched");
        _assertEmpty();
    }

    function test_withdrawAfterRecords() public {
        vm.startPrank(alice);
        tac.approve(address(v1), COLL);
        v1.deposit(COLL);
        v1.borrow(1_000e18, 0);
        vm.stopPrank();
        pair.arm(2); // prices lapse: with a debt, taking TAC out needs them
        uint256 dl = block.timestamp + 1 hours;
        uint256 out = 1_000e18;
        bytes[] memory calls = new bytes[](2);
        calls[0] = _rec(v1, _both(), 10);
        calls[1] = abi.encodeCall(
            TacVaultRouter.withdraw, (address(v1), out, dl, _withdrawSig(v1, aliceKey, alice, out, alice, dl))
        );
        vm.prank(alice);
        router.multicall(calls);
        (uint256 c,) = _vaultOf(v1, alice);
        assertEq(c, COLL - out);
        assertEq(tac.balanceOf(alice), 1_000_000e18 - COLL + out);
        _assertEmpty();
    }

    // ───────────── records ─────────────

    function test_aRecordSomeoneElseJustMadeIsSkipped() public {
        pair.arm(2);
        MockVenue a = pair.A();
        a.record("", _header(11 * 50), new bytes[](0), new bytes[](0), new bytes[](0)); // someone records interval 10 on A
        uint256 dl = block.timestamp + 1 hours;
        bytes[] memory calls = _calls(COLL, DEBT, dl);
        vm.prank(alice);
        router.multicall(calls); // the batch records it again: skipped, the rest goes on
        (, uint256 d) = _vaultOf(v1, alice);
        assertEq(d, DEBT);
        _assertEmpty();
    }

    function test_aBrokenRecordRevertsEverything() public {
        pair.arm(2);
        uint256 dl = block.timestamp + 1 hours;
        bytes[] memory calls = _calls(COLL, DEBT, dl);
        bytes[] memory data = new bytes[](2);
        data[0] = _recordData(10);
        data[1] = abi.encodeWithSelector(RECORD, bytes(""), hex"c0", new bytes[](0), new bytes[](0), new bytes[](0)); // a header that is no header
        calls[0] = abi.encodeCall(TacVaultRouter.records, (address(v1), _both(), data));
        vm.expectRevert();
        vm.prank(alice);
        router.multicall(calls);
        (uint256 c, uint256 d) = _vaultOf(v1, alice);
        assertEq(c + d, 0);
        assertEq(tac.balanceOf(alice), 1_000_000e18);
        assertTrue(pair.broken(), "the first record was undone with the rest");
        (uint256 p,) = pair.A().sampleOf(10);
        assertEq(p, 0);
    }

    function test_recordsOnlyReachTheVenuesOfAKnownVault() public {
        bytes[] memory data = new bytes[](1);
        data[0] = _recordData(10);
        address[] memory a = _one(address(pair.A()));
        vm.expectRevert(TacVaultRouter.BadVault.selector);
        router.records(address(0x1234), a, data);
        vm.expectRevert(TacVaultRouter.BadVenue.selector);
        router.records(address(v1), _one(address(tac)), data); // not a venue
        vm.expectRevert(TacVaultRouter.BadVenue.selector);
        router.records(address(v1), _one(address(pair)), data); // the pair itself is not one either
        bytes[] memory notRecord = new bytes[](1);
        notRecord[0] = abi.encodeWithSignature("fill(uint256,uint256)", 0, 1000);
        vm.expectRevert(TacVaultRouter.BadCall.selector);
        router.records(address(v1), a, notRecord); // not a record
        notRecord[0] = hex"3113";
        vm.expectRevert(TacVaultRouter.BadCall.selector);
        router.records(address(v1), a, notRecord);
        address[] memory both = _both();
        vm.expectRevert(TacVaultRouter.BadCall.selector);
        router.records(address(v1), both, data); // two venues, one record
        (uint256 p,) = pair.A().sampleOf(10);
        assertEq(p, 0, "nothing was recorded by any of it");
    }

    function test_aVenueWithoutCodeAndAHostileVenueAreHandled() public {
        MockEvilPair evil = new MockEvilPair();
        evil.set(1e14);
        TacVault vEvil = new TacVault(VaultConfig.defaults(address(tac), address(evil), address(feed), address(0x0123)));
        TacVaultRouter r2 = new TacVaultRouter(address(vEvil), address(v2));
        bytes[] memory data = new bytes[](1);
        data[0] = _recordData(10);
        // a venue with no code is not accepted as having recorded
        evil.setVenues(address(0xE0A), address(pair.B()));
        vm.expectRevert(TacVaultRouter.BadVenue.selector);
        r2.records(address(vEvil), _one(address(0xE0A)), data);
        // a venue that reverts with 100 KB: the revert is carried, cut to 1 KiB
        MockBombVenue bomb = new MockBombVenue();
        evil.setVenues(address(bomb), address(pair.B()));
        (bool ok, bytes memory ret) = address(r2).call(abi.encodeCall(TacVaultRouter.records, (address(vEvil), _one(address(bomb)), data)));
        assertFalse(ok);
        assertEq(ret.length, 1024);
    }

    // ───────────── whose funds, whose signature ─────────────

    function test_itMovesOnlyTheCallersTac() public {
        // alice has approved the router for everything, as a careless user might
        vm.prank(alice);
        tac.approve(address(router), type(uint256).max);
        uint256 dl = block.timestamp + 1 hours;
        // bob asks the router to deposit 500,000 TAC "for" a borrow signed by alice: bob's TAC would be spent, never alice's, and the signature is not bob's
        bytes memory sig = _borrowSig(v1, aliceKey, alice, DEBT, alice, 500_000e18, dl);
        vm.prank(bob);
        tac.approve(address(router), type(uint256).max);
        vm.expectRevert(TacVault.BadSignature.selector);
        vm.prank(bob);
        router.borrow(address(v1), 500_000e18, DEBT, 0, 500_000e18, dl, sig);
        assertEq(tac.balanceOf(alice), 1_000_000e18);
        assertEq(tac.balanceOf(bob), 1_000_000e18);
        (uint256 c, uint256 d) = _vaultOf(v1, alice);
        assertEq(c + d, 0);
        (c, d) = _vaultOf(v1, bob);
        assertEq(c + d, 0);
    }

    function test_whatIsBorrowedGoesToTheCaller() public {
        // a signature that names someone else as the recipient is not one the router can use: it always asks for the caller
        uint256 dl = block.timestamp + 1 hours;
        (uint8 pv, bytes32 pr, bytes32 ps) = _permitSig(aliceKey, alice, address(router), COLL, dl);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(TacVaultRouter.permitTac, (COLL, dl, pv, pr, ps));
        calls[1] = abi.encodeCall(
            TacVaultRouter.borrow, (address(v1), COLL, DEBT, 0, COLL, dl, _borrowSig(v1, aliceKey, alice, DEBT, stranger, COLL, dl))
        );
        vm.expectRevert(TacVault.BadSignature.selector);
        vm.prank(alice);
        router.multicall(calls);
        assertEq(v1.SYNTH().balanceOf(stranger), 0);
        assertEq(tac.balanceOf(alice), 1_000_000e18);
    }

    function test_aPermitUsedFirstByAStrangerStillWorks() public {
        uint256 dl = block.timestamp + 1 hours;
        (uint8 pv, bytes32 pr, bytes32 ps) = _permitSig(aliceKey, alice, address(router), COLL, dl);
        vm.prank(stranger);
        tac.permit(alice, address(router), COLL, dl, pv, pr, ps); // seen in the mempool and front-run
        bytes[] memory calls = _callsNoRecords(COLL, DEBT, dl);
        vm.prank(alice);
        router.multicall(calls);
        (uint256 c, uint256 d) = _vaultOf(v1, alice);
        assertEq(c, COLL);
        assertEq(d, DEBT);
        _assertEmpty();
    }

    function _callsNoRecords(uint256 coll, uint256 amount, uint256 dl) internal view returns (bytes[] memory calls) {
        (uint8 pv, bytes32 pr, bytes32 ps) = _permitSig(aliceKey, alice, address(router), coll, dl);
        calls = new bytes[](2);
        calls[0] = abi.encodeCall(TacVaultRouter.permitTac, (coll, dl, pv, pr, ps));
        calls[1] = abi.encodeCall(
            TacVaultRouter.borrow,
            (address(v1), coll, amount, 0, coll, dl, _borrowSig(v1, aliceKey, alice, amount, alice, coll, dl))
        );
    }

    function test_withoutAPermitOrApprovalTheDepositFailsWhole() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(
            TacVaultRouter.borrow, (address(v1), COLL, DEBT, 0, COLL, dl, _borrowSig(v1, aliceKey, alice, DEBT, alice, COLL, dl))
        );
        vm.expectRevert();
        vm.prank(alice);
        router.multicall(calls);
        assertEq(tac.balanceOf(alice), 1_000_000e18);
    }

    function test_aVaultItWasNotBuiltForIsRefused() public {
        TacVault other = new TacVault(VaultConfig.defaults(address(tac), address(pair), address(feed), address(0x0123)));
        vm.expectRevert(TacVaultRouter.BadVault.selector);
        router.borrow(address(other), 0, DEBT, 0, 0, block.timestamp + 1, "");
        vm.expectRevert(TacVaultRouter.BadVault.selector);
        router.withdraw(address(other), 1, block.timestamp + 1, "");
    }

    // ───────────── what it keeps ─────────────

    function test_itTakesNoEthAndHasNoWayToReceiveIt() public {
        vm.deal(alice, 1 ether);
        bytes[] memory calls = new bytes[](0);
        vm.prank(alice);
        (bool ok,) = address(router).call{value: 1}(abi.encodeCall(TacVaultRouter.multicall, (calls)));
        assertFalse(ok, "multicall is not payable");
        vm.prank(alice);
        (ok,) = address(router).call{value: 1}("");
        assertFalse(ok, "no receive");
        assertEq(address(router).balance, 0);
    }

    function test_constructorRefusesWhatItCannotServe() public {
        vm.expectRevert(TacVaultRouter.BadConfig.selector);
        new TacVaultRouter(address(v1), address(v1));
        vm.expectRevert(TacVaultRouter.BadConfig.selector);
        new TacVaultRouter(address(v1), address(0xE0A));
        TestTac otherTac = new TestTac();
        TacVault foreign = new TacVault(VaultConfig.defaults(address(otherTac), address(pair), address(feed), address(0x0123)));
        vm.expectRevert(TacVaultRouter.BadConfig.selector);
        new TacVaultRouter(address(v1), address(foreign));
    }

    function test_nothingIsLeftOnTheRouterEvenWhenSomeoneSendsItTac() public {
        // TAC sent to the router stays there (it has no owner to give it back to), and is never part of what it deposits
        vm.prank(bob);
        tac.transfer(address(router), 1_000e18);
        uint256 dl = block.timestamp + 1 hours;
        bytes[] memory calls = _callsNoRecords(COLL, DEBT, dl);
        vm.prank(alice);
        router.multicall(calls);
        assertEq(tac.balanceOf(address(router)), 1_000e18, "the gift is untouched");
        (uint256 c,) = _vaultOf(v1, alice);
        assertEq(c, COLL);
        assertEq(tac.allowance(address(router), address(v1)), 0);
    }

    function testFuzz_borrowMovesExactlyWhatWasSigned(uint256 coll, uint256 amount) public {
        coll = bound(coll, 1_000e18, 900_000e18);
        amount = bound(amount, 100e18, coll / 8 < 9_000e18 ? coll / 8 : 9_000e18);
        uint256 dl = block.timestamp + 1 hours;
        bytes[] memory calls = _callsNoRecords(coll, amount, dl);
        vm.prank(alice);
        router.multicall(calls);
        (uint256 c, uint256 d) = _vaultOf(v1, alice);
        assertEq(c, coll);
        assertEq(d, amount);
        assertEq(v1.SYNTH().balanceOf(alice), amount);
        assertEq(tac.balanceOf(alice), 1_000_000e18 - coll);
        _assertEmpty();
    }

    // ───────────── the other actions: deposit and repay, and an auction that prices let end ─────────────

    function _borrowDirect(address who, uint256 coll, uint256 amount) internal {
        vm.startPrank(who);
        tac.approve(address(v1), coll);
        v1.deposit(coll);
        v1.borrow(amount, 0);
        vm.stopPrank();
    }

    /// alice's vault in an auction at a price a quarter of today's, then the price back and its oracle lapsed (it needs two records)
    function _auctionThenLapse() internal {
        _borrowDirect(alice, COLL, DEBT);
        pair.set(25e12);
        v1.liquidate(alice);
        pair.set(1e14);
        pair.arm(2);
    }

    function test_depositThroughTheRouterWithAPermit() public {
        uint256 dl = block.timestamp + 1 hours;
        (uint8 pv, bytes32 pr, bytes32 ps) = _permitSig(aliceKey, alice, address(router), 1_000e18, dl);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(TacVaultRouter.permitTac, (1_000e18, dl, pv, pr, ps));
        calls[1] = abi.encodeCall(TacVaultRouter.deposit, (address(v1), 1_000e18));
        vm.prank(alice);
        router.multicall(calls);
        (uint256 c,) = _vaultOf(v1, alice);
        assertEq(c, 1_000e18);
        assertEq(tac.balanceOf(alice), 1_000_000e18 - 1_000e18);
        _assertEmpty();
    }

    function test_repayThroughTheRouterGivesBackWhatTheDebtDidNotTake() public {
        _borrowDirect(alice, COLL, DEBT);
        _borrowDirect(bob, COLL, DEBT);
        ERC20 dollar = ERC20(address(v1.SYNTH()));
        vm.prank(bob);
        dollar.transfer(alice, 1_000e18); // alice holds 3,000 and owes 2,000
        uint256 dl = block.timestamp + 1 hours;
        address synth = address(v1.SYNTH());
        (uint8 pv, bytes32 pr, bytes32 ps) = _permitSigOf(synth, aliceKey, alice, address(router), 3_000e18, dl);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(TacVaultRouter.permitSynth, (address(v1), 3_000e18, dl, pv, pr, ps));
        calls[1] = abi.encodeCall(TacVaultRouter.repay, (address(v1), 3_000e18));
        vm.prank(alice);
        router.multicall(calls);
        (, uint256 d) = _vaultOf(v1, alice);
        assertEq(d, 0, "the debt is gone");
        assertEq(v1.SYNTH().balanceOf(alice), 1_000e18, "the 1,000 the debt did not take came back");
        _assertEmpty();
    }

    function test_repayMovesOnlyTheCallersSynth() public {
        _borrowDirect(alice, COLL, DEBT);
        ERC20 dollar = ERC20(address(v1.SYNTH()));
        vm.prank(alice);
        dollar.approve(address(router), type(uint256).max); // a careless allowance
        vm.prank(bob);
        vm.expectRevert(); // bob has no TACD and no allowance: nothing of alice's can be reached
        router.repay(address(v1), 500e18);
        assertEq(v1.SYNTH().balanceOf(alice), DEBT);
        _assertEmpty();
    }

    function test_recordsLetADepositEndAnAuction() public {
        _auctionThenLapse();
        uint256 dl = block.timestamp + 1 hours;
        (uint8 pv, bytes32 pr, bytes32 ps) = _permitSig(aliceKey, alice, address(router), 100e18, dl);
        // without the records the deposit lands but the vault cannot be seen to have recovered: the auction stays
        bytes[] memory plain = new bytes[](2);
        plain[0] = abi.encodeCall(TacVaultRouter.permitTac, (100e18, dl, pv, pr, ps));
        plain[1] = abi.encodeCall(TacVaultRouter.deposit, (address(v1), 100e18));
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        router.multicall(plain);
        (,, uint256 started) = v1.vaults(alice);
        assertGt(started, 0, "no price: the auction is still running");
        vm.revertToState(snap);
        // with them, in the same transaction, it ends
        bytes[] memory calls = new bytes[](3);
        calls[0] = _rec(v1, _both(), 10);
        calls[1] = plain[0];
        calls[2] = plain[1];
        vm.prank(alice);
        router.multicall(calls);
        (,, started) = v1.vaults(alice);
        assertEq(started, 0, "the records let the deposit end the auction");
        _assertEmpty();
    }

    function test_recordsLetARepaymentEndAnAuction() public {
        _auctionThenLapse();
        uint256 dl = block.timestamp + 1 hours;
        address synth = address(v1.SYNTH());
        (uint8 pv, bytes32 pr, bytes32 ps) = _permitSigOf(synth, aliceKey, alice, address(router), 500e18, dl);
        bytes[] memory calls = new bytes[](3);
        calls[0] = _rec(v1, _both(), 10);
        calls[1] = abi.encodeCall(TacVaultRouter.permitSynth, (address(v1), 500e18, dl, pv, pr, ps));
        calls[2] = abi.encodeCall(TacVaultRouter.repay, (address(v1), 500e18));
        vm.prank(alice);
        router.multicall(calls);
        (, uint256 d, uint256 started) = v1.vaults(alice);
        assertEq(d, DEBT - 500e18);
        assertEq(started, 0, "the records let the repayment end the auction");
        _assertEmpty();
    }

    function test_theAuctionEndsWithTheRecordsThroughMulticall3EvenWithoutTheRouter() public {
        _auctionThenLapse();
        // `cancel` is not tied to its caller, so the records and the end of the auction need no router at all: any batcher will do
        bytes[] memory data = new bytes[](2);
        data[0] = _recordData(10);
        data[1] = _recordData(10);
        MockVenue a = pair.A();
        MockVenue b = pair.B();
        vm.expectRevert(); // alone it cannot: there is no price
        v1.cancel(alice);
        a.record("", _header(11 * 50), new bytes[](0), new bytes[](0), new bytes[](0));
        b.record("", _header(11 * 50), new bytes[](0), new bytes[](0), new bytes[](0));
        v1.cancel(alice);
        (,, uint256 started) = v1.vaults(alice);
        assertEq(started, 0);
    }
}
