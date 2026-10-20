// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitAmmRoute} from "../src/TacitAmmRoute.sol";

interface IAmmQuoteRoute {
    function quoteSwap(bytes32 assetIn, bytes32 assetOut, uint32 feeBps, uint256 amountIn) external view returns (uint256);
}

interface IWethDeposit {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

interface IBalance {
    function balanceOf(address owner) external view returns (uint256);
}

/// Against the live pool: set FORK_URL to an Ethereum node, else the tests skip.
contract TacitAmmRouteTest is Test {
    address constant AMM = 0x00000000E36C7EC997CC59DCda9E03673B448119;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant CUSD = 0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564;
    bytes32 constant ETH_ID = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant CUSD_ID = 0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d;
    uint32 constant FEE = 30;
    uint256 constant UNIT = 1e10;
    address constant TO = address(0xB0B);

    TacitAmmRoute route;

    function _fork() internal returns (bool) {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) {
            emit log("FORK_URL unset - skipping");
            return false;
        }
        vm.createSelectFork(url);
        // Foundry's default deployment addresses hold real funds on mainnet: a CREATE2 address nobody has used starts empty.
        route = new TacitAmmRoute{salt: keccak256("TacitAmmRoute test")}(AMM, WETH, ETH_ID);
        assertEq(address(route).balance, 0);
        return true;
    }

    function _hand(uint256 wethAmount) internal {
        vm.deal(address(this), wethAmount);
        IWethDeposit(WETH).deposit{value: wethAmount}();
        IWethDeposit(WETH).transfer(address(route), wethAmount);
    }

    function test_swapsTheWethItWasHandedForTheRecipient() public {
        if (!_fork()) return;
        uint256 amount = 1 ether;
        uint256 quoted = IAmmQuoteRoute(AMM).quoteSwap(ETH_ID, CUSD_ID, FEE, amount);
        _hand(amount);
        uint256 out = route.routeFromWETH(CUSD_ID, FEE, quoted, 0, TO);
        assertEq(out, quoted, "pays what the pool quotes");
        assertEq(IBalance(CUSD).balanceOf(TO), quoted, "to the recipient");
        assertEq(IWethDeposit(WETH).balanceOf(address(route)), 0, "no WETH left");
        assertEq(address(route).balance, 0, "no ETH left");
        assertEq(TO.balance, 0, "no change when the amount fills the steps");
    }

    function test_whatDoesNotFillAStepGoesToTheRecipientAsEth() public {
        if (!_fork()) return;
        uint256 dust = 123_456_789;
        _hand(1 ether + dust);
        route.routeFromWETH(CUSD_ID, FEE, 0, 0, TO);
        assertEq(TO.balance, dust, "the remainder");
        assertEq(address(route).balance, 0);
        assertEq(IWethDeposit(WETH).balanceOf(address(route)), 0);
    }

    function test_theRecipientNeedNotAcceptEth() public {
        if (!_fork()) return;
        address rejects = address(new Rejects{salt: keccak256("Rejects test")}());
        uint256 before = rejects.balance;
        _hand(1 ether + 5);
        route.routeFromWETH(CUSD_ID, FEE, 0, 0, rejects);
        assertEq(rejects.balance - before, 5, "forced in");
    }

    function test_wethAloneUnderOneStepIsRefused() public {
        if (!_fork()) return;
        _hand(UNIT - 1);
        vm.expectRevert(TacitAmmRoute.NothingToSwap.selector);
        route.routeFromWETH(CUSD_ID, FEE, 0, 0, TO);
    }

    function test_nothingHeldIsRefused() public {
        if (!_fork()) return;
        vm.expectRevert(TacitAmmRoute.NothingToSwap.selector);
        route.routeFromWETH(CUSD_ID, FEE, 0, 0, TO);
    }

    function test_recipientCannotBeZeroOrTheRoute() public {
        if (!_fork()) return;
        _hand(1 ether);
        vm.expectRevert(TacitAmmRoute.BadRecipient.selector);
        route.routeFromWETH(CUSD_ID, FEE, 0, 0, address(0));
        vm.expectRevert(TacitAmmRoute.BadRecipient.selector);
        route.routeFromWETH(CUSD_ID, FEE, 0, 0, address(route));
    }

    function test_theMinimumAndTheDeadlineAreThePools() public {
        if (!_fork()) return;
        uint256 amount = 1 ether;
        uint256 quoted = IAmmQuoteRoute(AMM).quoteSwap(ETH_ID, CUSD_ID, FEE, amount);
        _hand(amount);
        vm.expectRevert();
        route.routeFromWETH(CUSD_ID, FEE, quoted + 1, 0, TO);
        vm.expectRevert();
        route.routeFromWETH(CUSD_ID, FEE, 0, uint64(block.timestamp - 1), TO);
        // a failed swap leaves the WETH where it was
        assertEq(IWethDeposit(WETH).balanceOf(address(route)), amount);
    }

    function test_onlyWethSendsEth() public {
        if (!_fork()) return;
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(route).call{value: 1 ether}("");
        assertFalse(ok, "a plain send is refused");
    }

    function test_aBadPoolOrAssetIsRefusedAtDeploy() public {
        if (!_fork()) return;
        vm.expectRevert(TacitAmmRoute.BadConfig.selector);
        new TacitAmmRoute(address(0x1234), WETH, ETH_ID);
        vm.expectRevert(TacitAmmRoute.BadConfig.selector);
        new TacitAmmRoute(AMM, address(0x1234), ETH_ID);
        vm.expectRevert(TacitAmmRoute.BadConfig.selector);
        new TacitAmmRoute(AMM, WETH, CUSD_ID); // a pool-minted token, not ETH
        vm.expectRevert(TacitAmmRoute.BadConfig.selector);
        new TacitAmmRoute(AMM, WETH, bytes32(uint256(1))); // not registered
    }
}

contract Rejects {
    receive() external payable {
        revert("no");
    }
}
