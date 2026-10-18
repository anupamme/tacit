// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {TacVault} from "../src/TacVault.sol";
import {TestTac, MockPair, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

/// The gas of the router's own work (the records are mock ones, so what is measured is the router and not the oracle) when it is compiled
/// with different settings: the init code is read from test/fixtures/gaslab/router-<ROUTER_CFG>.hex. Not part of the normal run.
contract TacVaultRouterGasLab is Test {
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 2_000e18;
    bytes4 constant RECORD = 0x3113428b;

    TestTac tac;
    MockPair pair;
    TacVault v1;
    TacVault v2;
    address router;
    uint256 key = 0xA11CE;
    address alice;

    function setUp() public {
        vm.warp(1_800_000_000);
        alice = vm.addr(key);
        tac = new TestTac();
        pair = new MockPair();
        pair.set(1e14);
        MockFeed feed = new MockFeed();
        feed.set(4000e8);
        v1 = new TacVault(VaultConfig.defaults(address(tac), address(pair), address(feed), address(0x0123)));
        v2 = new TacVault(VaultConfig.defaults(address(tac), address(pair), address(feed), address(0x0123)));
        tac.mint(alice, 1_000_000e18);
    }

    function _header(uint256 number) internal pure returns (bytes memory) {
        bytes memory n = abi.encodePacked(uint24(number));
        bytes memory body = abi.encodePacked(hex"8080808080808080", uint8(0x83), n, hex"80808080808080");
        return abi.encodePacked(uint8(0xc0 + body.length), body);
    }

    function _records(uint256 first, uint256 intervals) internal view returns (bytes memory) {
        address[] memory venues = new address[](intervals * 2);
        bytes[] memory data = new bytes[](intervals * 2);
        for (uint256 i; i < intervals; ++i) {
            for (uint256 j; j < 2; ++j) {
                venues[i * 2 + j] = j == 0 ? address(pair.A()) : address(pair.B());
                data[i * 2 + j] = abi.encodeWithSelector(
                    RECORD, bytes(""), _header((first + i + 1) * 50), new bytes[](0), new bytes[](0), new bytes[](0)
                );
            }
        }
        return abi.encodeWithSignature("records(address,address[],bytes[])", address(v1), venues, data);
    }

    function _sig(bytes32 typehash, bytes memory fields) internal view returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, v1.digest(keccak256(abi.encodePacked(typehash, fields))));
        return abi.encodePacked(r, s, vv);
    }

    function test_gasLab() public {
        string memory cfg = vm.envOr("ROUTER_CFG", string(""));
        if (bytes(cfg).length == 0) return; // only when asked for (ROUTER_CFG=ir-1, legacy-200, ...)
        bytes memory init = vm.parseBytes(string.concat("0x", vm.readFile(string.concat("test/fixtures/gaslab/router-", cfg, ".hex"))));
        bytes memory code = abi.encodePacked(init, abi.encode(address(v1), address(v2)));
        address r;
        assembly {
            r := create(0, add(code, 32), mload(code))
        }
        require(r != address(0), "deploy");
        router = r;
        console2.log("config", cfg);
        console2.log("  runtime bytes", r.code.length);

        uint256 dl = block.timestamp + 1 hours;
        vm.prank(alice);
        tac.approve(router, type(uint256).max);

        // (A) twelve records, then deposit and borrow
        pair.arm(12);
        bytes[] memory calls = new bytes[](2);
        calls[0] = _records(10, 6);
        calls[1] = abi.encodeWithSignature(
            "borrow(address,uint256,uint256,uint256,uint256,uint256,bytes)", address(v1), COLL, DEBT, 0, COLL, dl,
            _sig(v1.BORROW(), abi.encode(alice, DEBT, uint256(0), COLL, alice, v1.nonces(alice), dl))
        );
        vm.prank(alice);
        uint256 g = gasleft();
        (bool ok,) = router.call(abi.encodeWithSignature("multicall(bytes[])", calls));
        console2.log("  12 records + deposit + borrow", g - gasleft());
        require(ok, "A");

        // (B) a deposit
        vm.prank(alice);
        g = gasleft();
        (ok,) = router.call(abi.encodeWithSignature("deposit(address,uint256)", address(v1), 1_000e18));
        console2.log("  deposit", g - gasleft());
        require(ok, "B");

        // (C) a repayment of part of the debt, more than is owed in the call (the rest comes back)
        vm.startPrank(alice);
        v1.SYNTH().approve(router, type(uint256).max);
        g = gasleft();
        (ok,) = router.call(abi.encodeWithSignature("repay(address,uint256)", address(v1), 1_200e18));
        console2.log("  repay", g - gasleft());
        vm.stopPrank();
        require(ok, "C");

        // (D) one record alone
        pair.arm(2);
        vm.prank(alice);
        g = gasleft();
        (ok,) = router.call(_records(40, 1));
        console2.log("  2 records alone", g - gasleft());
        require(ok, "D");
    }

    /// What it costs to send the same records through Multicall3's aggregate3 and through the router's `records` (mock venues, so the record itself is cheap and what shows is
    /// the way of sending). Not part of the normal run.
    function test_multicall3VersusRouter() public {
        if (bytes(vm.envOr("ROUTER_CFG", string(""))).length == 0) return;
        address m3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
        vm.etch(m3, vm.parseBytes(vm.readFile("test/fixtures/multicall3-runtime.hex")));
        string memory cfg = vm.envString("ROUTER_CFG");
        bytes memory init = vm.parseBytes(string.concat("0x", vm.readFile(string.concat("test/fixtures/gaslab/router-", cfg, ".hex"))));
        bytes memory code = abi.encodePacked(init, abi.encode(address(v1), address(v2)));
        address r;
        assembly {
            r := create(0, add(code, 32), mload(code))
        }
        uint256[2] memory ns = [uint256(2), 12];
        for (uint256 j; j < 2; ++j) {
            uint256 pairs = ns[j] / 2;
            // aggregate3
            bytes memory data0 = abi.encodeWithSelector(RECORD, bytes(""), _header(80 * 50), new bytes[](0), new bytes[](0), new bytes[](0));
            pair.arm(ns[j]);
            bytes memory agg = _aggregate(pairs, 1000 + 100 * j);
            uint256 g = gasleft();
            (bool ok,) = m3.call(agg);
            uint256 viaM3 = g - gasleft();
            require(ok, "m3");
            pair.arm(ns[j]);
            bytes memory viaRouter = _records(2000 + 100 * j, pairs);
            g = gasleft();
            (ok,) = r.call(viaRouter);
            uint256 viaR = g - gasleft();
            require(ok, "router");
            // the same records, called directly one by one
            pair.arm(ns[j]);
            g = gasleft();
            for (uint256 i; i < pairs; ++i) {
                for (uint256 v; v < 2; ++v) {
                    (ok,) = (v == 0 ? address(pair.A()) : address(pair.B())).call(abi.encodeWithSelector(RECORD, bytes(""), _header((3000 + 100 * j + i + 1) * 50), new bytes[](0), new bytes[](0), new bytes[](0)));
                    require(ok, "direct");
                }
            }
            uint256 direct = g - gasleft();
            data0;
            console2.log("records", ns[j]);
            console2.log("  direct calls (no transaction costs)", direct);
            console2.log("  Multicall3 aggregate3", viaM3);
            console2.log("  router records", viaR);
            console2.log("  calldata bytes: aggregate3", agg.length, "router", viaRouter.length);
        }
    }

    function _aggregate(uint256 pairs, uint256 first) internal view returns (bytes memory) {
        bytes memory calls;
        uint256 n = pairs * 2;
        // aggregate3((address,bool,bytes)[]) with allowFailure false
        bytes[] memory items = new bytes[](n);
        for (uint256 i; i < pairs; ++i) {
            for (uint256 v; v < 2; ++v) {
                bytes memory d = abi.encodeWithSelector(RECORD, bytes(""), _header((first + i + 1) * 50), new bytes[](0), new bytes[](0), new bytes[](0));
                items[i * 2 + v] = abi.encode(v == 0 ? address(pair.A()) : address(pair.B()), false, d);
            }
        }
        calls = abi.encodePacked(bytes4(0x82ad56cb), abi.encode(_asStructs(items)));
        return calls;
    }

    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    function _asStructs(bytes[] memory items) internal pure returns (Call3[] memory out) {
        out = new Call3[](items.length);
        for (uint256 i; i < items.length; ++i) {
            (address t, bool a, bytes memory d) = abi.decode(items[i], (address, bool, bytes));
            out[i] = Call3(t, a, d);
        }
    }
}
