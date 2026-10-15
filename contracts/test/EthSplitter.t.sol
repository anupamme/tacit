// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthSplitter} from "../src/EthSplitter.sol";

/// Stands in for the pool's `wrap` and its native-ETH asset row, just enough for WrapTipForwarder.
/// The forwarder is pinned to solc 0.8.36 and the splitter to 0.8.37, so one file cannot import both: the real
/// forwarder is loaded from its compiled artifact instead.
interface IWrapTipForwarder {
    function wrapWithTip(bytes32 commit, uint256 amount, address tipRecipient) external payable;
}

contract SplitterMockPool {
    function assets(bytes32) external pure returns (bool, address, uint256, bytes32, bool, uint8) {
        return (true, address(0), 1, bytes32(0), false, 18);
    }

    function wrap(bytes32, uint256 amount, bytes32) external payable {
        require(msg.value == amount, "mismatch");
    }
}

contract Refuser {
    receive() external payable {
        revert("no");
    }
}

contract Reenterer {
    EthSplitter public s;

    constructor(EthSplitter s_) {
        s = s_;
    }

    receive() external payable {
        s.distribute();
    }
}

contract EthSplitterTest is Test {
    EthSplitter sp;
    address constant OWNER = address(0xA11CE);
    address constant DEPLOYER = address(0x68);
    address constant SETTLE = address(0x7A);

    event SharesSet(address[] to, uint96[] weight);
    event Distributed(uint256 amount);

    function setUp() public {
        address[] memory to = new address[](2);
        to[0] = DEPLOYER;
        to[1] = SETTLE;
        uint96[] memory w = new uint96[](2);
        w[0] = 70;
        w[1] = 30;
        sp = new EthSplitter(OWNER, to, w);
    }

    function _two(address a, uint96 wa, address b, uint96 wb) internal pure returns (address[] memory to, uint96[] memory w) {
        to = new address[](2);
        w = new uint96[](2);
        (to[0], to[1], w[0], w[1]) = (a, b, wa, wb);
    }

    function test_setup_listsOwnerAndShares() public view {
        assertEq(sp.owner(), OWNER);
        (address[] memory to, uint96[] memory w) = sp.shares();
        assertEq(to.length, 2);
        assertEq(to[0], DEPLOYER);
        assertEq(to[1], SETTLE);
        assertEq(w[0], 70);
        assertEq(w[1], 30);
    }

    function test_receive_acceptsPlainSendsAndStoresNothing() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(sp).call{value: 0.4 ether}("");
        assertTrue(ok);
        assertEq(address(sp).balance, 0.4 ether);
    }

    function test_receive_costsAboutAPlainTransfer() public {
        vm.deal(address(this), 1 ether);
        uint256 g = gasleft();
        (bool ok,) = address(sp).call{value: 1 wei}("");
        g -= gasleft();
        assertTrue(ok);
        // 2,600 cold access + 9,000 value transfer + a few hundred of dispatch, no storage touched.
        assertLt(g, 15_000);
    }

    function test_receive_worksAsTheTipRecipientOfTheWrapForwarder() public {
        SplitterMockPool pool = new SplitterMockPool();
        IWrapTipForwarder fwd = IWrapTipForwarder(deployCode("WrapTipForwarder.sol:WrapTipForwarder", abi.encode(address(pool), bytes32(uint256(1)))));
        vm.deal(address(this), 2 ether);
        fwd.wrapWithTip{value: 1.0003 ether}(bytes32(uint256(7)), 1 ether, address(sp));
        assertEq(address(sp).balance, 0.0003 ether);
        sp.distribute();
        assertEq(DEPLOYER.balance, 0.00021 ether);
        assertEq(SETTLE.balance, 0.00009 ether);
    }

    function test_distribute_splitsByWeight_andAnyoneMayCall() public {
        vm.deal(address(sp), 1 ether);
        vm.expectEmit(false, false, false, true);
        emit Distributed(1 ether);
        vm.prank(address(0xBEEF));
        sp.distribute();
        assertEq(DEPLOYER.balance, 0.7 ether);
        assertEq(SETTLE.balance, 0.3 ether);
        assertEq(address(sp).balance, 0);
    }

    function test_distribute_dustGoesToTheLast() public {
        vm.deal(address(sp), 11 wei);
        sp.distribute();
        assertEq(DEPLOYER.balance, 7); // 11 * 70 / 100 = 7.7 -> 7
        assertEq(SETTLE.balance, 4); // the rest
        assertEq(address(sp).balance, 0);
    }

    function test_distribute_emptyBalanceIsANoOp() public {
        sp.distribute();
        assertEq(DEPLOYER.balance, 0);
    }

    function test_distribute_oneWeiOnTwoRecipients() public {
        vm.deal(address(sp), 1 wei);
        sp.distribute();
        assertEq(DEPLOYER.balance, 0);
        assertEq(SETTLE.balance, 1);
    }

    function test_distribute_gasForTwoRecipients() public {
        // Real wallets already exist; sending value to an account that does not costs another 25,000 gas.
        vm.deal(DEPLOYER, 1 wei);
        vm.deal(SETTLE, 1 wei);
        vm.deal(address(sp), 0.01 ether);
        uint256 g = gasleft();
        sp.distribute();
        g -= gasleft();
        emit log_named_uint("distribute gas, 2 recipients", g);
        assertLt(g, 60_000);
    }

    function test_setShares_ownerOnly() public {
        (address[] memory to, uint96[] memory w) = _two(DEPLOYER, 1, SETTLE, 1);
        vm.expectRevert();
        sp.setShares(to, w);
        vm.prank(OWNER);
        sp.setShares(to, w);
        vm.deal(address(sp), 1 ether);
        sp.distribute();
        assertEq(DEPLOYER.balance, 0.5 ether);
        assertEq(SETTLE.balance, 0.5 ether);
    }

    function test_setShares_emitsAndReplacesTheWholeList() public {
        address[] memory to = new address[](3);
        uint96[] memory w = new uint96[](3);
        (to[0], to[1], to[2]) = (DEPLOYER, SETTLE, OWNER);
        (w[0], w[1], w[2]) = (5, 3, 2);
        vm.expectEmit(false, false, false, true);
        emit SharesSet(to, w);
        vm.prank(OWNER);
        sp.setShares(to, w);
        (address[] memory t2, uint96[] memory w2) = sp.shares();
        assertEq(t2.length, 3);
        assertEq(w2[2], 2);
        vm.deal(address(sp), 10 ether);
        sp.distribute();
        assertEq(DEPLOYER.balance, 5 ether);
        assertEq(SETTLE.balance, 3 ether);
        assertEq(OWNER.balance, 2 ether);
        // back to one recipient: the list is replaced, not appended to.
        address[] memory one = new address[](1);
        uint96[] memory ow = new uint96[](1);
        (one[0], ow[0]) = (OWNER, 1);
        vm.prank(OWNER);
        sp.setShares(one, ow);
        (address[] memory t3,) = sp.shares();
        assertEq(t3.length, 1);
    }

    function test_setShares_validation() public {
        vm.startPrank(OWNER);
        (address[] memory to, uint96[] memory w) = _two(DEPLOYER, 70, SETTLE, 30);
        // empty
        vm.expectRevert(EthSplitter.BadShares.selector);
        sp.setShares(new address[](0), new uint96[](0));
        // length mismatch
        vm.expectRevert(EthSplitter.BadShares.selector);
        sp.setShares(to, new uint96[](1));
        // zero address
        (to, w) = _two(address(0), 1, SETTLE, 1);
        vm.expectRevert(EthSplitter.BadShares.selector);
        sp.setShares(to, w);
        // the splitter itself
        (to, w) = _two(address(sp), 1, SETTLE, 1);
        vm.expectRevert(EthSplitter.BadShares.selector);
        sp.setShares(to, w);
        // zero weight
        (to, w) = _two(DEPLOYER, 0, SETTLE, 1);
        vm.expectRevert(EthSplitter.BadShares.selector);
        sp.setShares(to, w);
        // nine recipients
        address[] memory nine = new address[](9);
        uint96[] memory nw = new uint96[](9);
        for (uint256 i; i < 9; ++i) {
            nine[i] = address(uint160(0x100 + i));
            nw[i] = 1;
        }
        vm.expectRevert(EthSplitter.BadShares.selector);
        sp.setShares(nine, nw);
        // eight is the limit and works
        address[] memory eight = new address[](8);
        uint96[] memory ew = new uint96[](8);
        for (uint256 i; i < 8; ++i) {
            eight[i] = address(uint160(0x100 + i));
            ew[i] = 1;
        }
        sp.setShares(eight, ew);
        vm.stopPrank();
        vm.deal(address(sp), 8 ether);
        sp.distribute();
        assertEq(address(uint160(0x100)).balance, 1 ether);
        assertEq(address(uint160(0x107)).balance, 1 ether);
    }

    function test_constructor_validates() public {
        (address[] memory to, uint96[] memory w) = _two(DEPLOYER, 0, SETTLE, 1);
        vm.expectRevert(EthSplitter.BadShares.selector);
        new EthSplitter(OWNER, to, w);
    }

    function test_aRecipientThatRefusesEthRevertsDistribute_keepsTheFunds_andTheOwnerCanReplaceIt() public {
        Refuser bad = new Refuser();
        vm.prank(OWNER);
        (address[] memory to, uint96[] memory w) = _two(address(bad), 1, SETTLE, 1);
        sp.setShares(to, w);
        vm.deal(address(sp), 1 ether);
        vm.expectRevert();
        sp.distribute();
        assertEq(address(sp).balance, 1 ether);
        // The owner is never blocked by the broken recipient.
        (to, w) = _two(DEPLOYER, 1, SETTLE, 1);
        vm.prank(OWNER);
        sp.setShares(to, w);
        sp.distribute();
        assertEq(DEPLOYER.balance, 0.5 ether);
        assertEq(SETTLE.balance, 0.5 ether);
    }

    function test_reentrancyIsRefused() public {
        Reenterer re = new Reenterer(sp);
        (address[] memory to, uint96[] memory w) = _two(address(re), 1, SETTLE, 1);
        vm.prank(OWNER);
        sp.setShares(to, w);
        vm.deal(address(sp), 1 ether);
        vm.expectRevert();
        sp.distribute();
        assertEq(address(sp).balance, 1 ether);
    }

    function test_ownership_twoStepHandover() public {
        address next = address(0xB0B);
        vm.prank(next);
        sp.requestOwnershipHandover();
        vm.prank(OWNER);
        sp.completeOwnershipHandover(next);
        assertEq(sp.owner(), next);
        (address[] memory to, uint96[] memory w) = _two(DEPLOYER, 1, SETTLE, 1);
        vm.prank(OWNER);
        vm.expectRevert();
        sp.setShares(to, w);
        vm.prank(next);
        sp.setShares(to, w);
    }

    /// Whatever the weights and the balance, every wei that arrived leaves, nobody is paid more than their exact
    /// share, and the shortfall against the exact share is only ever the rounding dust (under the recipient count).
    function testFuzz_distribute_conservesEveryWei(uint96 wa, uint96 wb, uint96 wc, uint128 amount) public {
        wa = uint96(bound(wa, 1, type(uint96).max));
        wb = uint96(bound(wb, 1, type(uint96).max));
        wc = uint96(bound(wc, 1, type(uint96).max));
        amount = uint128(bound(amount, 1, type(uint128).max));
        address a = address(0xA001);
        address b = address(0xA002);
        address c = address(0xA003);
        address[] memory to = new address[](3);
        uint96[] memory w = new uint96[](3);
        (to[0], to[1], to[2], w[0], w[1], w[2]) = (a, b, c, wa, wb, wc);
        vm.prank(OWNER);
        sp.setShares(to, w);
        vm.deal(address(sp), amount);
        sp.distribute();
        assertEq(address(sp).balance, 0);
        assertEq(a.balance + b.balance + c.balance, amount);
        uint256 total = uint256(wa) + wb + wc;
        assertEq(a.balance, uint256(amount) * wa / total);
        assertEq(b.balance, uint256(amount) * wb / total);
        assertLe(c.balance - uint256(amount) * wc / total, 2);
    }

    function testFuzz_setSharesThenDistribute_neverBricks(uint8 n, uint96 seedW, uint64 amount) public {
        n = uint8(bound(n, 1, 8));
        amount = uint64(bound(amount, 1, type(uint64).max));
        address[] memory to = new address[](n);
        uint96[] memory w = new uint96[](n);
        for (uint256 i; i < n; ++i) {
            to[i] = address(uint160(0x5000 + i));
            w[i] = uint96(bound(uint256(keccak256(abi.encode(seedW, i))), 1, 1e12));
        }
        vm.prank(OWNER);
        sp.setShares(to, w);
        vm.deal(address(sp), amount);
        sp.distribute();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            sum += to[i].balance;
        }
        assertEq(sum, amount);
    }
}
