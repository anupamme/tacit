// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter} from "../src/TacitEvmPoolRouter.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TacVaultZap} from "../src/TacVaultZap.sol";
import {TestTac, MockOracle, MockFeed, VaultConfig} from "./TacVaultMocks.sol";
import {AcceptAllVerifier} from "./TacVaultShielded.t.sol";

/// The call escrow whose last call completes the dollar pool's deposit box, and the zap's `mintShielded`, when the
/// dollar pool's root has moved since their proofs were built. Offline: the Groth16 verifier is replaced by
/// AcceptAllVerifier, as in TacVaultShielded.t.sol; the pools, routers, zap and vault are the real contracts. A stale
/// proof fails the whole transaction: no debt, no collateral moved, no nullifier spent, no dollars minted.
contract TacEscrowFlowsTest is Test {
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 2_000e18;

    TestTac tac;
    TacVault vault;
    TacSynth dollar;
    TacitEvmPool tacPool;
    TacitEvmPoolRouter tacRouter;
    TacitEvmPool dollarPool;
    TacitEvmPoolRouter dollarRouter;
    TacVaultZap zap;
    uint256 ownerKey = 0xA11CE;
    address owner;
    address alice = address(0xA1);
    address relayer = address(0x7E1A);
    address otherDepositor = address(0xB0B);
    uint256 nfSeq = 1;

    function setUp() public {
        vm.warp(1_800_000_000);
        owner = vm.addr(ownerKey);
        tac = new TestTac();
        MockOracle oracle = new MockOracle();
        oracle.set(1e14);
        MockFeed feed = new MockFeed();
        feed.set(4000e8);
        vault = new TacVault(VaultConfig.defaults(address(tac), address(oracle), address(feed), address(0x0123)));
        dollar = vault.SYNTH();
        address verifier = address(new AcceptAllVerifier());
        tacPool = new TacitEvmPool(verifier, address(tac));
        tacRouter = new TacitEvmPoolRouter(address(tacPool), address(0), address(0), address(0), address(0));
        dollarPool = new TacitEvmPool(verifier, address(dollar));
        dollarRouter = new TacitEvmPoolRouter(address(dollarPool), address(0), address(0), address(0), address(0));
        zap = new TacVaultZap(address(vault), address(dollarRouter));
        tac.mint(alice, 100_000e18);
        vm.startPrank(alice);
        tac.approve(address(tacPool), type(uint256).max);
        _transact(tacPool, _tx(tacPool, address(0), int256(100_000e18), address(0), 0, 11));
        vm.stopPrank();
    }

    function _tx(TacitEvmPool pool, address recipient, int256 extAmount, address rel, uint256 fee, uint256 out0)
        internal
        returns (TacitEvmPoolRouter.Tx memory t)
    {
        (bytes32 root, uint256 size) = pool.head();
        t.recipient = recipient;
        t.extAmount = extAmount;
        t.relayer = rel;
        t.fee = fee;
        t.publicInputs[0] = uint256(root);
        t.publicInputs[1] = uint256(root);
        t.publicInputs[2] = uint256(keccak256(abi.encode(root, out0, uint256(0), nfSeq))) % FIELD;
        t.publicInputs[3] = size;
        int256 pa = (extAmount - int256(fee)) % int256(FIELD);
        if (pa < 0) pa += int256(FIELD);
        t.publicInputs[4] = uint256(pa);
        t.publicInputs[5] = uint256(
            keccak256(
                abi.encode(block.chainid, address(pool), recipient, extAmount, rel, fee, keccak256(""), keccak256(""))
            )
        ) % FIELD;
        t.publicInputs[6] = pool.ASSET_FIELD();
        t.publicInputs[7] = extAmount < 0 ? nfSeq++ : 0;
        t.publicInputs[9] = out0;
    }

    function _transact(TacitEvmPool pool, TacitEvmPoolRouter.Tx memory t) internal {
        pool.transact(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1);
    }

    function _sign(uint256 amount, address to) internal view returns (bytes memory) {
        bytes32 sh = keccak256(
            abi.encode(
                vault.BORROW(), owner, amount, uint256(0), COLL, to, vault.nonces(owner), block.timestamp + 1 hours
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.digest(sh));
        return abi.encodePacked(r, s, v);
    }

    function _box(uint256 leaf) internal view returns (TacitEvmPoolRouter.DepositIntent memory) {
        return TacitEvmPoolRouter.DepositIntent({
            amount: DEBT,
            outLeaf0: leaf,
            outLeaf1: 0,
            memo0Hash: keccak256(""),
            memo1Hash: keccak256(""),
            refund: alice,
            deadline: uint64(block.timestamp + 1 days),
            nonce: leaf
        });
    }

    function _oneTransactionIntent(TacitEvmPoolRouter.DepositIntent memory box, uint256 nonce)
        internal
        returns (TacitEvmPoolRouter.CallIntent memory intent)
    {
        address dollarBox = dollarRouter.depositBoxOf(box);
        TacitEvmPoolRouter.Tx memory deposit = _tx(dollarPool, address(0), int256(DEBT), address(0), 0, box.outLeaf0);
        TacitEvmPoolRouter.Call[] memory calls = new TacitEvmPoolRouter.Call[](3);
        calls[0] = TacitEvmPoolRouter.Call({
            target: address(vault),
            value: 0,
            token: address(tac),
            amount: COLL,
            push: false,
            data: abi.encodeCall(TacVault.depositFor, (owner, COLL))
        });
        calls[1] = TacitEvmPoolRouter.Call({
            target: address(vault),
            value: 0,
            token: address(0),
            amount: 0,
            push: false,
            data: abi.encodeCall(
                TacVault.borrowFor,
                (owner, DEBT, uint256(0), COLL, dollarBox, block.timestamp + 1 hours, _sign(DEBT, dollarBox))
            )
        });
        calls[2] = TacitEvmPoolRouter.Call({
            target: address(dollarRouter),
            value: 0,
            token: address(0),
            amount: 0,
            push: false,
            data: abi.encodeCall(TacitEvmPoolRouter.completeDeposit, (box, deposit))
        });
        intent = TacitEvmPoolRouter.CallIntent({
            calls: calls,
            outTokens: new address[](0),
            minOuts: new uint256[](0),
            to: address(0),
            refund: alice,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: nonce
        });
    }

    // Someone puts a dollar note into the dollar pool: its head moves and every proof built on the old one is stale.
    function _depositIntoDollarPoolFirst() internal {
        tac.mint(otherDepositor, 1_000e18);
        vm.startPrank(otherDepositor);
        tac.approve(address(vault), type(uint256).max);
        vault.deposit(1_000e18);
        vault.borrow(100e18, 0);
        dollar.approve(address(dollarPool), type(uint256).max);
        _transact(dollarPool, _tx(dollarPool, address(0), int256(100e18), address(0), 0, 777));
        vm.stopPrank();
    }

    function _assertNothingMoved(uint256 otherMinted) internal view {
        (uint256 coll, uint256 debt,) = vault.vaults(owner);
        assertEq(coll + debt, 0, "the owner's vault is untouched");
        assertEq(vault.nonces(owner), 0, "the signature's nonce is unspent");
        assertEq(tac.balanceOf(address(tacPool)), 100_000e18, "the shielded TAC is still in the pool");
        assertEq(dollar.totalSupply(), otherMinted, "no dollars minted for the owner (the other depositor's only)");
    }

    /// The one-transaction escrow: when the dollar pool's root moves before it runs, the whole `withdrawAndCall`
    /// reverts. The TAC pool's nullifier is not spent and nothing is borrowed; a fresh proof for a new intent works.
    function test_aStaleDollarPoolRootRevertsTheOneTransactionEscrowAtomically() public {
        TacitEvmPoolRouter.CallIntent memory intent = _oneTransactionIntent(_box(21), 1);
        TacitEvmPoolRouter.Tx memory t = _tx(tacPool, tacRouter.callEscrowOf(intent), -int256(COLL), relayer, 10e18, 12);
        _depositIntoDollarPoolFirst();

        vm.prank(relayer);
        vm.expectRevert(TacitEvmPool.StaleRoot.selector);
        tacRouter.withdrawAndCall(t, intent);
        assertFalse(tacPool.nullified(bytes32(t.publicInputs[7])), "nullifier unspent");
        _assertNothingMoved(100e18);
        assertEq(tac.balanceOf(address(tacRouter.callEscrowOf(intent))), 0, "the escrow holds nothing");

        // Rebuilt on the new heads, with a new nonce, it goes through.
        TacitEvmPoolRouter.CallIntent memory again = _oneTransactionIntent(_box(22), 2);
        TacitEvmPoolRouter.Tx memory t2 = _tx(tacPool, tacRouter.callEscrowOf(again), -int256(COLL), relayer, 10e18, 13);
        vm.prank(relayer);
        tacRouter.withdrawAndCall(t2, again);
        (uint256 coll, uint256 debt,) = vault.vaults(owner);
        assertEq(coll, COLL);
        assertEq(debt, DEBT);
    }

    /// The same for the public zap: a stale deposit proof reverts `mintShielded` whole and the payer keeps its TAC.
    function test_aStaleDollarPoolRootRevertsMintShieldedAtomically() public {
        address payer = address(0xCA11);
        tac.mint(payer, COLL);
        TacitEvmPoolRouter.DepositIntent memory box = _box(41);
        bytes memory sig = _sign(DEBT, dollarRouter.depositBoxOf(box));
        TacitEvmPoolRouter.Tx memory t = _tx(dollarPool, address(0), int256(DEBT), address(0), 0, 41);
        _depositIntoDollarPoolFirst();
        vm.startPrank(payer);
        tac.approve(address(zap), COLL);
        vm.expectRevert(TacitEvmPool.StaleRoot.selector);
        zap.mintShielded(owner, COLL, 0, COLL, block.timestamp + 1 hours, sig, box, t);
        vm.stopPrank();
        assertEq(tac.balanceOf(payer), COLL, "the payer keeps its TAC");
        _assertNothingMoved(100e18);
    }

    /// A deposit box that is funded but never completed returns its dollars to `intent.refund` after the deadline, not
    /// before; the debt stays with the vault owner who signed the box.
    function test_anUncompletedDepositBoxRefundsAfterItsDeadline() public {
        TacitEvmPoolRouter.DepositIntent memory box = _box(51);
        address b = dollarRouter.depositBoxOf(box);
        tac.mint(address(this), COLL);
        tac.approve(address(vault), COLL);
        vault.depositFor(owner, COLL);
        vault.borrowFor(owner, DEBT, 0, COLL, b, block.timestamp + 1 hours, _sign(DEBT, b));
        assertEq(dollar.balanceOf(b), DEBT);
        vm.expectRevert(TacitEvmPoolRouter.NotExpired.selector);
        dollarRouter.reclaimDeposit(box, address(dollar));
        skip(1 days + 1);
        dollarRouter.reclaimDeposit(box, address(dollar));
        assertEq(dollar.balanceOf(alice), DEBT, "refunded to the intent's refund address");
        assertEq(dollar.balanceOf(b), 0);
    }
}
